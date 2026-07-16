import assert from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  companion,
  envFor,
  jobFileFor,
  jobRecords,
  killGroups,
  makeSandbox,
  pidAlive,
  runCompanion,
  stateModulePath,
  waitFor,
} from "./lib/companion-harness.mjs";
import { getProcessIdentity } from "../plugins/grok/scripts/lib/process-identity.mjs";

const {
  createJobRecord,
  generateJobId,
  jobFilePath,
  jobLogPath,
  nowIso,
  writeBrief,
  writeJobRecordFile,
} = await import(stateModulePath);

function replacedIdentity(identity) {
  return { ...identity, startMarker: `${identity.startMarker}-replaced` };
}

test("foreground task renders the text plus grok-session and job lines", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "say hi"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("FAKE-OK"));
  assert.match(result.stdout, /^grok-session: 11111111-1111-7111-8111-111111111111$/m);
  assert.match(result.stdout, /^job: [0-9a-f]{32}$/m);
  assert.match(result.stdout, /^state: done$/m);
});

test("a sandbox downgrade warning fails closed even with a valid result envelope", (t) => {
  const sandbox = makeSandbox(t);
  const sentinel = path.join(sandbox.root, "unsandboxed-sentinel");
  const result = runCompanion(["task", "stay sandboxed"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, {
      FAKE_GROK_MODE: "sandbox-warning",
      FAKE_GROK_SANDBOX_SENTINEL: sentinel,
    }),
  });

  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /sandbox enforcement failed/i);
  const [record] = jobRecords(sandbox.dataDir);
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.failureKind, "sandbox");
  assert.strictEqual(fs.existsSync(sentinel), false);
});

test("resume last rejects another Claude session's finished job", (t) => {
  const sandbox = makeSandbox(t);
  const jobId = generateJobId();
  const briefFile = writeBrief(sandbox.dataDir, sandbox.workDir, jobId, "finished in another session");
  writeJobRecordFile(jobFilePath(sandbox.dataDir, sandbox.workDir, jobId), {
    ...createJobRecord({
      id: jobId,
      pid: null,
      mode: "consult",
      cwd: sandbox.workDir,
      briefFile,
      background: false,
      claudeSessionId: "claude-other",
      jobClass: "task",
      request: {
        model: null,
        effort: null,
        web: false,
        resumeSessionId: null,
        sandboxProfile: "strict",
      },
    }),
    status: "done",
    finishedAt: nowIso(),
    exitCode: 0,
    sessionId: "22222222-2222-7222-8222-222222222222",
    resultText: "finished",
  });

  const result = runCompanion(["task", "--resume-last"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "claude-current" }),
  });

  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /No finished consult grok task with a compatible sandbox and memory mode was found for Claude session claude-current/);
  assert.strictEqual(jobRecords(sandbox.dataDir).length, 1);
});

test("a running resume owns the workspace session lease and a terminal owner can be replaced", async (t) => {
  const sandbox = makeSandbox(t);
  const sessionId = "22222222-2222-7222-8222-222222222222";
  const sourceJobId = generateJobId();
  const sourceBrief = writeBrief(sandbox.dataDir, sandbox.workDir, sourceJobId, "resume source");
  writeJobRecordFile(jobFilePath(sandbox.dataDir, sandbox.workDir, sourceJobId), {
    ...createJobRecord({
      id: sourceJobId,
      pid: null,
      mode: "consult",
      cwd: sandbox.workDir,
      briefFile: sourceBrief,
      background: false,
      jobClass: "task",
      request: {
        model: null,
        effort: null,
        web: false,
        resumeSessionId: null,
        sandboxProfile: "strict",
      },
    }),
    status: "done",
    finishedAt: nowIso(),
    exitCode: 0,
    sessionId,
    resultText: "resume source",
  });

  const hangingEnv = envFor(sandbox, { FAKE_GROK_MODE: "hang" });
  const launch = runCompanion(["task", "--resume", sessionId, "--background", "first resume"], {
    cwd: sandbox.workDir,
    env: hangingEnv,
  });
  assert.strictEqual(launch.status, 0, launch.stderr);
  const running = await waitFor(() =>
    jobRecords(sandbox.dataDir).find(
      (record) => record.request?.resumeSessionId === sessionId && record.status === "running" && record.pid && record.grokPid,
    ),
  );
  t.after(() => {
    killGroups(running.grokPid);
    killGroups(running.pid);
  });

  const blocked = runCompanion(["task", "--resume", sessionId, "second resume"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "hang", GROK_COMPANION_TIMEOUT_MS: "1000" }),
  });
  assert.notStrictEqual(blocked.status, 0);
  assert.match(blocked.stderr, /^failure: resource$/m);
  const rejected = jobRecords(sandbox.dataDir).find(
    (record) => record.id !== running.id && record.request?.resumeSessionId === sessionId && record.failureKind === "resource",
  );
  assert.ok(rejected);
  assert.strictEqual(rejected.status, "error");

  const cancel = runCompanion(["cancel", running.id], { cwd: sandbox.workDir, env: hangingEnv });
  assert.strictEqual(cancel.status, 0, cancel.stderr);
  await waitFor(() => jobRecords(sandbox.dataDir).find((record) => record.id === running.id && record.status === "cancelled"));

  const resumed = runCompanion(["task", "--resume", sessionId, "third resume"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /^state: done$/m);
});

test("foreground task exits nonzero when grok fails", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "doomed"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "error" }),
  });
  assert.notStrictEqual(result.status, 0);
  assert.ok(result.stderr.trim().length > 0, "Expected an error message on stderr.");
  const [record] = jobRecords(sandbox.dataDir);
  assert.ok(record.errorMessage);
  assert.doesNotMatch(record.errorMessage, /\r?\n/);
  assert.match(result.stderr, new RegExp(`job: ${record.id}\\nstate: error\\nfailure: error\\n$`));
});

test("background task creates a job record and result prints the finished output", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "claude-session-test" });
  const result = runCompanion(["task", "--background", "background work"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const record = await waitFor(() => jobRecords(sandbox.dataDir)[0]);
  assert.match(record.id, /^[0-9a-f]{32}$/);
  assert.ok(result.stdout.includes(record.id));
  assert.ok(result.stdout.includes("/grok:status"));
  assert.ok(result.stdout.includes("/grok:result"));
  const done = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current && current.status === "done" ? current : null;
  });
  assert.strictEqual(done.resultText, "FAKE-OK");
  assert.strictEqual(done.sessionId, "11111111-1111-7111-8111-111111111111");
  assert.strictEqual(done.mode, "consult");
  assert.strictEqual(done.background, true);
  assert.strictEqual(done.claudeSessionId, "claude-session-test");
  assert.strictEqual(done.cwd, sandbox.workDir);
  assert.strictEqual(done.exitCode, 0);
  assert.ok(done.finishedAt, "Expected finishedAt to be set.");
  const resultOutput = runCompanion(["result", done.id], { cwd: sandbox.workDir, env });
  assert.strictEqual(resultOutput.status, 0, resultOutput.stderr);
  assert.ok(resultOutput.stdout.includes("FAKE-OK"));
  const detailOutput = runCompanion(["status", done.id], { cwd: sandbox.workDir, env });
  assert.strictEqual(detailOutput.status, 0, detailOutput.stderr);
  assert.match(detailOutput.stdout, /^state: done$/m);
  const statusOutput = runCompanion(["status"], { cwd: sandbox.workDir, env });
  assert.strictEqual(statusOutput.status, 0, statusOutput.stderr);
  assert.ok(statusOutput.stdout.includes(done.id));
  assert.ok(statusOutput.stdout.includes("done"));
});

test("result --wait on a background task returns the terminal output", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { GROK_COMPANION_WAIT_POLL_MS: "10" });
  const launch = runCompanion(["task", "--background", "background wait work"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(launch.status, 0, launch.stderr);
  const record = await waitFor(() => jobRecords(sandbox.dataDir)[0]);
  assert.ok(launch.stdout.endsWith(`job: ${record.id}\ndelivery: manual\nstate: running\n`));
  assert.ok(launch.stdout.endsWith("state: running\n"));
  const result = runCompanion(["result", record.id, "--wait"], { cwd: sandbox.workDir, env });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("FAKE-OK"));
  assert.match(result.stdout, /^grok-session: 11111111-1111-7111-8111-111111111111$/m);
  assert.match(result.stdout, new RegExp(`^job: ${record.id}$`, "m"));
  assert.match(result.stdout, /^state: done$/m);
});

test("collecting a managed background result records owner delivery", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, {
    GROK_COMPANION_BACKGROUND_DELIVERY: "managed",
    GROK_COMPANION_WAIT_POLL_MS: "10",
  });
  const launch = runCompanion(["task", "--background", "managed background work"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(launch.status, 0, launch.stderr);
  const record = await waitFor(() => jobRecords(sandbox.dataDir)[0]);
  assert.strictEqual(record.delivery, "managed");
  assert.strictEqual(record.deliveryCollectedAt, null);
  assert.ok(launch.stdout.endsWith(`job: ${record.id}\ndelivery: managed\nstate: running\n`));
  assert.ok(launch.stdout.endsWith("state: running\n"));

  const result = runCompanion(["result", record.id, "--wait"], { cwd: sandbox.workDir, env });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /^state: done$/m);
  const collected = jobRecords(sandbox.dataDir)[0];
  assert.ok(collected.deliveryCollectedAt);
});

test("managed JSON task collection preserves the terminal task envelope", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, {
    GROK_COMPANION_BACKGROUND_DELIVERY: "managed",
    GROK_COMPANION_WAIT_POLL_MS: "10",
  });
  const launch = runCompanion(["task", "--background", "--json", "managed JSON work"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(launch.status, 0, launch.stderr);
  const receipt = JSON.parse(launch.stdout);
  assert.strictEqual(receipt.status, "running");
  assert.strictEqual(receipt.delivery, "managed");

  const result = runCompanion(["result", receipt.jobId, "--wait", "--json"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepStrictEqual(Object.keys(payload).sort(), [
    "background",
    "costIsPartial",
    "delivery",
    "deliveryStatus",
    "exitCode",
    "failureKind",
    "jobClass",
    "jobId",
    "memoryEnabled",
    "mode",
    "modelUsage",
    "modelUsageIsIncomplete",
    "numTurns",
    "requestId",
    "resolvedEffort",
    "resolvedModel",
    "semanticStatus",
    "sessionId",
    "status",
    "stopReason",
    "text",
    "totalCostUsd",
    "totalCostUsdTicks",
    "transportStatus",
    "usage",
    "usageIsIncomplete",
  ]);
  assert.strictEqual(payload.jobId, receipt.jobId);
  assert.strictEqual(payload.status, "done");
  assert.strictEqual(payload.background, true);
  assert.strictEqual(payload.text, "FAKE-OK");
  const [record] = jobRecords(sandbox.dataDir);
  assert.deepStrictEqual(record.resultPayload, payload);
  assert.ok(record.deliveryCollectedAt);
});

test("legacy stored JSON results receive current derived class and memory fields", (t) => {
  const sandbox = makeSandbox(t);
  const jobId = generateJobId();
  const briefFile = writeBrief(sandbox.dataDir, sandbox.workDir, jobId, "legacy stored result");
  writeJobRecordFile(jobFilePath(sandbox.dataDir, sandbox.workDir, jobId), {
    ...createJobRecord({
      id: jobId,
      pid: null,
      mode: "consult",
      cwd: sandbox.workDir,
      briefFile,
      background: false,
      jobClass: "task",
      request: {
        model: null,
        effort: null,
        web: false,
        memory: false,
        resumeSessionId: null,
        sandboxProfile: "strict",
        outputJson: true,
      },
    }),
    status: "done",
    finishedAt: nowIso(),
    exitCode: 0,
    sessionId: "21212121-2121-7121-8121-212121212121",
    resultText: "legacy result",
    resultPayload: {
      jobId,
      status: "done",
      jobClass: "review",
      memoryEnabled: true,
      text: "legacy result",
    },
  });

  const result = runCompanion(["result", jobId, "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.strictEqual(payload.jobClass, "task");
  assert.strictEqual(payload.memoryEnabled, false);
});

test("managed JSON task failure preserves a typed terminal envelope", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, {
    FAKE_GROK_MODE: "error",
    GROK_COMPANION_BACKGROUND_DELIVERY: "managed",
    GROK_COMPANION_WAIT_POLL_MS: "10",
  });
  const launch = runCompanion(["task", "--background", "--json", "managed JSON failure"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(launch.status, 0, launch.stderr);
  const receipt = JSON.parse(launch.stdout);
  const result = runCompanion(["result", receipt.jobId, "--wait", "--json"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.strictEqual(payload.jobId, receipt.jobId);
  assert.strictEqual(payload.status, "error");
  assert.strictEqual(payload.failureKind, "error");
  assert.match(payload.message, /^state: error$/m);
  assert.match(payload.message, /^failure: error$/m);
  const [record] = jobRecords(sandbox.dataDir);
  assert.deepStrictEqual(record.resultPayload, payload);
  assert.ok(record.deliveryCollectedAt);
});

test("managed JSON cancellation preserves a typed terminal envelope", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, {
    FAKE_GROK_MODE: "hang",
    GROK_COMPANION_BACKGROUND_DELIVERY: "managed",
    GROK_COMPANION_WAIT_POLL_MS: "10",
  });
  const launch = runCompanion(["task", "--background", "--json", "managed JSON cancellation"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(launch.status, 0, launch.stderr);
  const receipt = JSON.parse(launch.stdout);
  const running = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current && current.status === "running" && current.pid && current.grokPid ? current : null;
  });
  t.after(() => {
    killGroups(running.grokPid);
    killGroups(running.pid);
  });

  const cancel = runCompanion(["cancel", receipt.jobId], { cwd: sandbox.workDir, env });
  assert.strictEqual(cancel.status, 0, cancel.stderr);
  const result = runCompanion(["result", receipt.jobId, "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);

  assert.strictEqual(payload.jobId, receipt.jobId);
  assert.strictEqual(payload.status, "cancelled");
  assert.strictEqual(payload.failureKind, "cancelled");
  assert.match(payload.message, /^state: cancelled$/m);
  assert.strictEqual(Object.hasOwn(payload, "request"), false);
  assert.ok(jobRecords(sandbox.dataDir)[0].deliveryCollectedAt);
});

test("managed JSON process death preserves a typed terminal envelope", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, {
    FAKE_GROK_MODE: "hang",
    GROK_COMPANION_BACKGROUND_DELIVERY: "managed",
    GROK_COMPANION_WAIT_POLL_MS: "10",
  });
  const launch = runCompanion(["task", "--background", "--json", "managed JSON process death"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(launch.status, 0, launch.stderr);
  const receipt = JSON.parse(launch.stdout);
  const running = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current && current.status === "running" && current.pid && current.grokPid ? current : null;
  });
  killGroups(running.grokPid);
  killGroups(running.pid);
  await waitFor(() => (!pidAlive(running.pid) && !pidAlive(running.grokPid) ? true : null));

  const result = runCompanion(["result", receipt.jobId, "--wait", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);

  assert.strictEqual(payload.jobId, receipt.jobId);
  assert.strictEqual(payload.status, "error");
  assert.strictEqual(payload.failureKind, "died");
  assert.match(payload.message, /^state: error$/m);
  assert.strictEqual(Object.hasOwn(payload, "request"), false);
  assert.ok(jobRecords(sandbox.dataDir)[0].deliveryCollectedAt);
});

test("result --wait exits zero with a running state when its wait budget elapses", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "hang", GROK_COMPANION_WAIT_POLL_MS: "10" });
  const launch = runCompanion(["task", "--background", "slow background wait"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(launch.status, 0, launch.stderr);
  const running = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current && current.status === "running" && current.pid && current.grokPid ? current : null;
  });
  assert.ok(running.pidIdentity, "Expected the worker process identity to be recorded.");
  assert.ok(running.grokPidIdentity, "Expected the Grok process identity to be recorded.");
  t.after(() => {
    killGroups(running.grokPid);
    killGroups(running.pid);
  });
  const result = runCompanion(["result", running.id, "--wait", "--wait-timeout-ms", "20"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^Job ${running.id}$`, "m"));
  assert.match(result.stdout, /^Status: running$/m);
  assert.ok(result.stdout.endsWith("state: running\n"));
});

test("background task failure ends in an error record", async (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--background", "doomed"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "error" }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const failed = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current && current.status === "error" ? current : null;
  });
  assert.strictEqual(failed.exitCode, 1);
  assert.ok(failed.errorMessage);
  assert.doesNotMatch(failed.errorMessage, /\r?\n/);
  const resultOutput = runCompanion(["result", failed.id], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(resultOutput.status, 0, resultOutput.stderr);
  assert.match(resultOutput.stdout, new RegExp(`job: ${failed.id}\\nstate: error\\nfailure: error\\n$`));
});

test("a background task records its terminal failure when the job log is unwritable", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "delayed-stderr-hang" });
  const launch = runCompanion(["task", "--background", "unwritable log"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(launch.status, 0, launch.stderr);
  const running = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current?.status === "running" && current.pid && current.grokPid ? current : null;
  });
  t.after(() => {
    killGroups(running.grokPid);
    killGroups(running.pid);
  });
  fs.mkdirSync(jobLogPath(sandbox.dataDir, sandbox.workDir, running.id));

  const failed = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current?.status === "error" ? current : null;
  });
  assert.strictEqual(failed.cleanupRequired, false);
  assert.strictEqual(failed.pid, null);
  assert.strictEqual(failed.grokPid, null);
  assert.match(failed.errorMessage, /EISDIR|illegal operation on a directory/i);
});

test("cancel kills a hanging worker and its grok process and marks the record cancelled", async (t) => {
  const sandbox = makeSandbox(t);
  const tempDir = path.join(sandbox.root, "tmp");
  fs.mkdirSync(tempDir);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "hang", TMPDIR: tempDir });
  const result = runCompanion(["task", "--background", "long running"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const running = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current && current.status === "running" && current.pid && current.grokPid ? current : null;
  });
  t.after(() => {
    killGroups(running.grokPid);
    killGroups(running.pid);
  });
  const whileRunning = runCompanion(["result", running.id], { cwd: sandbox.workDir, env });
  assert.match(whileRunning.stdout + whileRunning.stderr, /running/i);
  const cancelOutput = runCompanion(["cancel", running.id], { cwd: sandbox.workDir, env });
  assert.strictEqual(cancelOutput.status, 0, cancelOutput.stderr);
  const cancelled = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current && current.status === "cancelled" ? current : null;
  });
  assert.strictEqual(cancelled.pid, null);
  assert.strictEqual(cancelled.pidIdentity, null);
  assert.strictEqual(cancelled.grokPid, null);
  assert.strictEqual(cancelled.grokPidIdentity, null);
  assert.strictEqual(cancelled.cleanupRequired, false);
  await waitFor(() => (pidAlive(running.pid) ? null : true));
  await waitFor(() => (pidAlive(running.grokPid) ? null : true));
  const jobFile = jobFileFor(sandbox.dataDir, running.id);
  const snapshot = fs.readFileSync(jobFile, "utf8");
  for (let i = 0; i < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(fs.readFileSync(jobFile, "utf8"), snapshot);
  }
  assert.strictEqual(JSON.parse(snapshot).status, "cancelled");
  assert.deepStrictEqual(fs.readdirSync(tempDir).filter((entry) => entry.startsWith("grok-companion-stdout-")), []);
  assert.match(
    cancelOutput.stdout,
    new RegExp(`Check /grok:status for the updated list\\.\\n\\njob: ${running.id}\\nstate: cancelled\\nfailure: cancelled\\n$`),
  );
});

test("cancel kills a foreground grok and the record stays cancelled after the companion exits", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "hang" });
  const child = spawn(process.execPath, [companion, "task", "foreground hang"], {
    cwd: sandbox.workDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  });
  const running = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current && current.status === "running" && current.grokPid ? current : null;
  });
  t.after(() => killGroups(running.grokPid));
  const cancelOutput = runCompanion(["cancel", running.id], { cwd: sandbox.workDir, env });
  assert.strictEqual(cancelOutput.status, 0, cancelOutput.stderr);
  await waitFor(() => (pidAlive(running.grokPid) ? null : true));
  const exitCode = await exited;
  assert.notStrictEqual(exitCode, 0);
  assert.match(stderr, /^state: cancelled$/m);
  assert.match(stderr, /^failure: cancelled$/m);
  assert.match(stderr, new RegExp(`job: ${running.id}\\nstate: cancelled\\nfailure: cancelled\\n$`));
  const final = jobRecords(sandbox.dataDir)[0];
  assert.strictEqual(final.status, "cancelled");
  assert.strictEqual(final.pid, null);
  assert.strictEqual(final.grokPid, null);
});

test("cancel escalates to SIGKILL when grok ignores SIGTERM", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "hang-ignore-term" });
  const result = runCompanion(["task", "--background", "stubborn work"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const running = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current && current.status === "running" && current.pid && current.grokPid ? current : null;
  });
  t.after(() => {
    killGroups(running.grokPid);
    killGroups(running.pid);
  });
  const cancelOutput = runCompanion(["cancel", running.id], { cwd: sandbox.workDir, env });
  assert.strictEqual(cancelOutput.status, 0, cancelOutput.stderr);
  const cancelled = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current && current.status === "cancelled" ? current : null;
  });
  assert.strictEqual(cancelled.failureKind, "cancelled");
  assert.match(cancelOutput.stdout, /^failure: cancelled$/m);
  await waitFor(() => (pidAlive(running.grokPid) ? null : true));
});

test("cancel treats a process identity mismatch as PID reuse without signalling it", (t) => {
  const sandbox = makeSandbox(t);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  assert.ok(child.pid, "Expected child pid.");
  t.after(() => killGroups(child.pid));
  const identity = getProcessIdentity(child.pid);
  assert.ok(identity, "Expected child process identity.");
  const jobId = generateJobId();
  const briefFile = writeBrief(sandbox.dataDir, sandbox.workDir, jobId, "seeded reused pid");
  writeJobRecordFile(jobFilePath(sandbox.dataDir, sandbox.workDir, jobId), createJobRecord({
    id: jobId,
    pid: child.pid,
    pidIdentity: replacedIdentity(identity),
    mode: "consult",
    cwd: sandbox.workDir,
    briefFile,
    background: true,
  }));

  const result = runCompanion(["cancel", jobId], { cwd: sandbox.workDir, env: envFor(sandbox) });

  assert.strictEqual(result.status, 0, result.stderr);
  const [record] = jobRecords(sandbox.dataDir);
  assert.strictEqual(record.status, "cancelled");
  assert.strictEqual(record.failureKind, "cancelled");
  assert.ok(pidAlive(child.pid), "Expected the reused PID to remain alive.");
});

test("cancel keeps a legacy record running when graceful cleanup cannot be verified", async (t) => {
  const sandbox = makeSandbox(t);
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  assert.ok(child.pid, "Expected child pid.");
  await once(child.stdout, "data");
  t.after(() => killGroups(child.pid));
  const jobId = generateJobId();
  const briefFile = writeBrief(sandbox.dataDir, sandbox.workDir, jobId, "seeded legacy pid");
  writeJobRecordFile(jobFilePath(sandbox.dataDir, sandbox.workDir, jobId), createJobRecord({
    id: jobId,
    pid: child.pid,
    pidIdentity: null,
    mode: "consult",
    cwd: sandbox.workDir,
    briefFile,
    background: true,
  }));

  const result = runCompanion(["cancel", jobId], { cwd: sandbox.workDir, env: envFor(sandbox) });

  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /^state: running$/m);
  const [record] = jobRecords(sandbox.dataDir);
  assert.strictEqual(record.status, "running");
  assert.strictEqual(record.cleanupRequired, true);
  assert.strictEqual(record.pid, child.pid);
  assert.strictEqual(record.pidIdentity, null);
  assert.strictEqual(record.failureKind, "cancelled");
  assert.ok(pidAlive(child.pid), "Expected legacy cleanup not to escalate to SIGKILL.");
});

test("background timeout marks the record error and result reports the failure", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "hang", GROK_COMPANION_TIMEOUT_MS: "500" });
  const result = runCompanion(["task", "--background", "slow work"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const failed = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current && current.status === "error" ? current : null;
  });
  assert.match(failed.errorTail, /timed out after 500ms/);
  assert.match(failed.errorMessage, /timed out after 500ms/);
  assert.doesNotMatch(failed.errorMessage, /\r?\n/);
  assert.strictEqual(failed.exitCode, 143);
  const resultOutput = runCompanion(["result", failed.id], { cwd: sandbox.workDir, env });
  assert.strictEqual(resultOutput.status, 0, resultOutput.stderr);
  assert.ok(resultOutput.stdout.includes("failed"));
  assert.ok(resultOutput.stdout.includes("timed out after 500ms"));
});

test("permission-cancelled task ends in an error record, not done", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "doomed"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "permission-cancelled" }),
  });
  assert.notStrictEqual(result.status, 0);
  const record = jobRecords(sandbox.dataDir)[0];
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.failureKind, "permission");
});

test("task worker does not launch Grok after cancellation was requested", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const jobId = generateJobId();
  const briefFile = writeBrief(sandbox.dataDir, sandbox.workDir, jobId, "say hi");
  const jobFile = jobFilePath(sandbox.dataDir, sandbox.workDir, jobId);
  writeJobRecordFile(jobFile, {
    ...createJobRecord({
      id: jobId,
      mode: "consult",
      cwd: sandbox.workDir,
      briefFile,
      background: true,
    }),
    cancelRequestedAt: nowIso(),
  });
  const worker = spawn(process.execPath, [companion, "task-worker", "--job-id", jobId], {
    cwd: sandbox.workDir,
    env,
    stdio: "ignore",
  });
  t.after(() => {
    try {
      worker.kill("SIGKILL");
    } catch {}
  });
  const cancelled = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current && current.status === "cancelled" ? current : null;
  });
  assert.strictEqual(cancelled.failureKind, "cancelled");
  assert.strictEqual(cancelled.exitCode, null);
  assert.strictEqual(cancelled.resultText, null);
  assert.strictEqual(fs.existsSync(sandbox.argsFile), false);
  const resultOutput = runCompanion(["result", jobId], { cwd: sandbox.workDir, env });
  assert.strictEqual(resultOutput.status, 0, resultOutput.stderr);
  assert.match(resultOutput.stdout, /^Job [0-9a-f]{32} was cancelled\./m);
  assert.match(resultOutput.stdout, /^state: cancelled$/m);
  assert.match(resultOutput.stdout, /^failure: cancelled$/m);
});

test("foreground spawn failure records an error instead of leaving the job running", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "unlaunchable"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { GROK_BIN: path.join(sandbox.root, "missing-grok") }),
  });
  assert.notStrictEqual(result.status, 0);
  assert.ok(result.stderr.trim().length > 0, "Expected an error message on stderr.");
  const record = jobRecords(sandbox.dataDir)[0];
  assert.strictEqual(record.status, "error");
  assert.ok(record.errorTail, "Expected an error tail on the failed record.");
  assert.ok(record.errorMessage, "Expected an error summary on the failed record.");
  assert.doesNotMatch(record.errorMessage, /\r?\n/);
  assert.match(result.stderr, new RegExp(`job: ${record.id}\\nstate: error\\nfailure: missing_cli\\n$`));
});

test("background worker failures record a one line error summary", async (t) => {
  const sandbox = makeSandbox(t);
  const launch = runCompanion(["task", "--background", "unlaunchable"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { GROK_BIN: path.join(sandbox.root, "missing-grok") }),
  });
  assert.strictEqual(launch.status, 0, launch.stderr);
  const record = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current?.status === "error" ? current : null;
  });
  assert.strictEqual(record.failureKind, "missing_cli");
  assert.ok(record.errorMessage);
  assert.doesNotMatch(record.errorMessage, /\r?\n/);
  assert.ok(record.errorTail);
});

test("explicit cwd scopes id lookups while omitted cwd keeps global lookup", (t) => {
  const sandbox = makeSandbox(t);
  const otherDir = path.join(sandbox.root, "other-work");
  fs.mkdirSync(otherDir);
  const env = envFor(sandbox);
  const launch = runCompanion(["task", "other workspace job"], { cwd: otherDir, env });
  assert.strictEqual(launch.status, 0, launch.stderr);
  const [record] = jobRecords(sandbox.dataDir);

  for (const command of ["status", "result", "cancel"]) {
    const global = runCompanion([command, record.id], { cwd: sandbox.workDir, env });
    assert.strictEqual(global.status, 0, global.stderr);
    const matching = runCompanion([command, record.id, "--cwd", otherDir], { cwd: sandbox.workDir, env });
    assert.strictEqual(matching.status, 0, matching.stderr);
    const mismatching = runCompanion([command, record.id, "--cwd", sandbox.workDir], {
      cwd: sandbox.workDir,
      env,
    });
    assert.notStrictEqual(mismatching.status, 0);
    assert.match(mismatching.stderr, new RegExp(`No job record found for ${record.id}`));
  }
});

test("global id lookup rejects an ambiguous legacy collision", (t) => {
  const sandbox = makeSandbox(t);
  const otherCwd = path.join(sandbox.root, "other-workspace");
  fs.mkdirSync(otherCwd, { recursive: true });
  const jobId = generateJobId();
  for (const cwd of [sandbox.workDir, otherCwd]) {
    const briefFile = writeBrief(sandbox.dataDir, cwd, jobId, `brief for ${cwd}`);
    writeJobRecordFile(jobFilePath(sandbox.dataDir, cwd, jobId), {
      ...createJobRecord({
        id: jobId,
        pid: null,
        mode: "consult",
        cwd,
        briefFile,
        background: true,
      }),
      status: "done",
      finishedAt: nowIso(),
      resultText: cwd,
    });
  }

  const ambiguous = runCompanion(["status", jobId], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.notStrictEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /exists in multiple workspaces/);
  assert.match(ambiguous.stderr, /^failure: resource$/m);

  const scoped = runCompanion(["status", jobId, "--cwd", otherCwd], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(scoped.status, 0, scoped.stderr);
  assert.match(scoped.stdout, /^state: done$/m);
});

test("job lookups reject identifiers outside the 128-bit lowercase hexadecimal format", (t) => {
  const sandbox = makeSandbox(t);
  for (const command of ["status", "result", "cancel"]) {
    const result = runCompanion([command, "../../attacker", "--json"], {
      cwd: sandbox.workDir,
      env: envFor(sandbox),
    });
    assert.notStrictEqual(result.status, 0);
    const payload = JSON.parse(result.stderr);
    assert.strictEqual(payload.failureKind, "input");
    assert.match(payload.message, /exactly 32 lowercase hexadecimal characters/);
  }
});
