import assert from "node:assert";
import { spawn } from "node:child_process";
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

const {
  createJobRecord,
  generateJobId,
  jobFilePath,
  nowIso,
  writeBrief,
  writeJobRecordFile,
} = await import(stateModulePath);

test("foreground task renders the text plus grok-session and job lines", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "say hi"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("FAKE-OK"));
  assert.match(result.stdout, /^grok-session: 11111111-1111-7111-8111-111111111111$/m);
  assert.match(result.stdout, /^job: [0-9a-f]{8}$/m);
  assert.match(result.stdout, /^state: done$/m);
});

test("foreground task exits nonzero when grok fails", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "doomed"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "error" }),
  });
  assert.notStrictEqual(result.status, 0);
  assert.ok(result.stderr.trim().length > 0, "Expected an error message on stderr.");
});

test("background task creates a job record and result prints the finished output", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "claude-session-test" });
  const result = runCompanion(["task", "background work", "--background"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const record = await waitFor(() => jobRecords(sandbox.dataDir)[0]);
  assert.match(record.id, /^[0-9a-f]{8}$/);
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

test("background task failure ends in an error record", async (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "doomed", "--background"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "error" }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const failed = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current && current.status === "error" ? current : null;
  });
  assert.strictEqual(failed.exitCode, 1);
});

test("cancel kills a hanging worker and its grok process and marks the record cancelled", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "hang" });
  const result = runCompanion(["task", "long running", "--background"], {
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
  assert.strictEqual(cancelled.grokPid, null);
  await waitFor(() => (pidAlive(running.pid) ? null : true));
  await waitFor(() => (pidAlive(running.grokPid) ? null : true));
  const jobFile = jobFileFor(sandbox.dataDir, running.id);
  const snapshot = fs.readFileSync(jobFile, "utf8");
  for (let i = 0; i < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(fs.readFileSync(jobFile, "utf8"), snapshot);
  }
  assert.strictEqual(JSON.parse(snapshot).status, "cancelled");
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
  const final = jobRecords(sandbox.dataDir)[0];
  assert.strictEqual(final.status, "cancelled");
  assert.strictEqual(final.pid, null);
  assert.strictEqual(final.grokPid, null);
});

test("cancel escalates to SIGKILL when grok ignores SIGTERM", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "hang-ignore-term" });
  const result = runCompanion(["task", "stubborn work", "--background"], {
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

test("background timeout marks the record error and result reports the failure", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "hang", GROK_COMPANION_TIMEOUT_MS: "500" });
  const result = runCompanion(["task", "slow work", "--background"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const failed = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current && current.status === "error" ? current : null;
  });
  assert.match(failed.errorTail, /timed out after 500ms/);
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

test("worker success after cancel was requested finishes cancelled, not done", async (t) => {
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
  assert.strictEqual(cancelled.exitCode, 0);
  assert.strictEqual(cancelled.resultText, "FAKE-OK");
  const resultOutput = runCompanion(["result", jobId], { cwd: sandbox.workDir, env });
  assert.strictEqual(resultOutput.status, 0, resultOutput.stderr);
  assert.match(resultOutput.stdout, /^Job [0-9a-f]{8} was cancelled\./m);
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
});
