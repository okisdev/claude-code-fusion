import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BASH_TOOL_TIMEOUT_MS,
  buildReviewArgs,
  buildTaskArgs,
  DEFAULT_TERMINATION_GRACE_MS,
  DEFAULT_TERMINATION_POLL_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TIMEOUT_PATH_MAX_MS,
  DEFAULT_TIMEOUT_PATH_WITH_MARGIN_MS,
  TIMEOUT_PATH_MARGIN_MS,
  getCodexAvailability,
  getCodexVersion,
  getProcessIdentity,
  isProcessAlive,
  normalizeCumulativeUsage,
  processIdentitiesMatch,
  runCodex,
  subtractUsage,
  terminateProcessTree,
  terminateProcessTreeSync
} from "../plugins/codex/scripts/lib/codex-exec.mjs";
import {
  envFor as companionEnvFor,
  jobRecords as companionJobRecords,
  makeSandbox as makeCompanionSandbox,
  runCompanion
} from "./lib/codex-companion-harness.mjs";

const fakeCodex = fileURLToPath(new URL("./fake-codex", import.meta.url));
const codexExecModuleUrl = new URL("../plugins/codex/scripts/lib/codex-exec.mjs", import.meta.url).href;
const LOAD_TOLERANT_WAIT_TIMEOUT_MS = 15000;
const LOAD_TOLERANT_POLL_INTERVAL_MS = 25;
const TIMEOUT_TEST_TIMEOUT_MS = 8000;
const TIMEOUT_TEST_TERMINATION_GRACE_MS = 8000;
const COMPANION_WATCHDOG_TIMEOUT_MS = 30000;
const PATCH_VERIFICATION_FAILURE = "apply_patch verification failed: Failed to find expected lines in target-file";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-codex-exec-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    argsFile: path.join(dir, "args.json"),
    childPidFile: path.join(dir, "child.pid"),
    eventsFile: path.join(dir, "events.jsonl"),
    interruptFile: path.join(dir, "interrupt.signal"),
    logFile: path.join(dir, "stderr.log"),
    readyFile: path.join(dir, "ready.signal"),
    resultFile: path.join(dir, "result.txt"),
    stdinFile: path.join(dir, "stdin.txt"),
    termFile: path.join(dir, "term.signal")
  };
}

async function runFixture(t, mode, options = {}) {
  const files = fixture(t);
  const bin = options.script ? path.join(files.dir, "scripted-codex.mjs") : fakeCodex;
  if (options.script) {
    fs.writeFileSync(bin, options.script, { mode: 0o700 });
  }
  const env = {
    ...process.env,
    CODEX_BIN: bin,
    FAKE_CODEX_ARGS_FILE: files.argsFile,
    FAKE_CODEX_CHILD_PID_FILE: files.childPidFile,
    FAKE_CODEX_INT_FILE: files.interruptFile,
    FAKE_CODEX_MODE: mode,
    FAKE_CODEX_STDIN_FILE: files.stdinFile,
    FAKE_CODEX_TERM_FILE: files.termFile,
    ...(options.waitForReady ? { FAKE_CODEX_READY_FILE: files.readyFile } : {}),
    ...options.env
  };
  const resumeThreadId = options.resumeThreadId;
  const args = options.args ?? buildTaskArgs({
    cwd: files.dir,
    resultFile: files.resultFile,
    resumeThreadId,
    ...options.argOptions
  });
  const outcome = await runCodex({
    args,
    cwd: files.dir,
    env,
    eventsFile: files.eventsFile,
    logFile: files.logFile,
    resultFile: files.resultFile,
    prompt: options.prompt ?? "prompt only on stdin",
    resumeThreadId,
    timeoutMs: options.timeoutMs ?? 10000,
    terminationGraceMs: options.terminationGraceMs ?? 1000,
    terminationPollMs: 25,
    stderrMaxBytes: options.stderrMaxBytes,
    eventsMaxBytes: options.eventsMaxBytes,
    eventLineMaxBytes: options.eventLineMaxBytes,
    promptMaxBytes: options.promptMaxBytes,
    resultMaxBytes: options.resultMaxBytes,
    cumulativeUsageBaseline: options.cumulativeUsageBaseline,
    freshThread: options.freshThread,
    signal: options.signal,
    onSpawnAttempt: options.onSpawnAttempt,
    onSpawn: async (...args) => {
      if (options.waitForReady) {
        await waitForFile(files.readyFile);
      }
      return options.onSpawn?.(...args);
    },
    onCheckpoint: options.onCheckpoint
  });
  return { files, outcome, args };
}

function scriptedCodex(body) {
  return `#!/usr/bin/env node

for await (const _chunk of process.stdin) {}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const usage = { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 };
emit({ type: "thread.started", thread_id: "thread-123" });
emit({ type: "turn.started" });
${body}`;
}

async function waitUntil(predicate, timeoutMs = LOAD_TOLERANT_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for process state.");
    }
    await new Promise((resolve) => setTimeout(resolve, LOAD_TOLERANT_POLL_INTERVAL_MS));
  }
}

async function waitForFile(file) {
  await waitUntil(() => fs.existsSync(file));
  assert.equal(fs.readFileSync(file, "utf8"), "ready");
}

async function waitForProcessExit(pid, ownsProcessGroup = false) {
  await waitUntil(() => !isProcessAlive(pid, null, ownsProcessGroup));
}

test("version and availability probe the configured Codex binary", () => {
  const env = { ...process.env, CODEX_BIN: fakeCodex };
  assert.equal(getCodexVersion({ env }), "0.147.0");
  assert.deepEqual(getCodexAvailability({ env }), {
    available: true,
    bin: fakeCodex,
    version: "0.147.0",
    rawVersion: "codex-cli 0.147.0",
    exitCode: 0,
    errorMessage: null
  });
  const unavailable = getCodexAvailability({ bin: path.join(os.tmpdir(), "missing-codex-binary") });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.version, null);
});

test("process identity rejects PID 1 and prevents signaling after an identity mismatch", async () => {
  const identity = getProcessIdentity(process.pid);
  assert.ok(identity);
  assert.equal(isProcessAlive(process.pid, identity), true);
  assert.equal(isProcessAlive(1), false);
  const mismatched = { ...identity, startMarker: `${identity.startMarker}-reused` };
  assert.equal(processIdentitiesMatch(identity, { ...identity }), true);
  assert.equal(processIdentitiesMatch(identity, mismatched), false);
  assert.equal(await terminateProcessTree(process.pid, { identity: mismatched, requireIdentity: true, graceMs: 1 }), false);
  assert.equal(isProcessAlive(process.pid, identity), true);
});

test("process identity is stable across observer time zones", () => {
  const source = `
const [moduleUrl, pid] = process.argv.slice(1);
const { getProcessIdentity } = await import(moduleUrl);
process.stdout.write(JSON.stringify(getProcessIdentity(Number(pid))));
`;
  const observe = (timeZone) => spawnSync(process.execPath, ["--input-type=module", "--eval", source, codexExecModuleUrl, String(process.pid)], {
    encoding: "utf8",
    env: { ...process.env, TZ: timeZone }
  });
  const west = observe("America/Los_Angeles");
  const east = observe("Asia/Singapore");
  assert.equal(west.status, 0, west.stderr);
  assert.equal(east.status, 0, east.stderr);
  assert.deepEqual(JSON.parse(west.stdout), JSON.parse(east.stdout));
});

test("a persisted leader identity cannot authorize signaling a leaderless process group", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups are unavailable on Windows.");
    return;
  }
  const files = fixture(t);
  const leader = spawn(process.execPath, ["-e", `const { spawn } = require("node:child_process"); const fs = require("node:fs"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); fs.writeFileSync(${JSON.stringify(files.childPidFile)}, String(child.pid)); setInterval(() => {}, 1000);`], {
    detached: true,
    stdio: "ignore"
  });
  leader.unref();
  t.after(() => {
    try {
      process.kill(-leader.pid, "SIGKILL");
    } catch {}
  });
  await waitUntil(() => fs.existsSync(files.childPidFile));
  const childPid = Number(fs.readFileSync(files.childPidFile, "utf8"));
  const identity = getProcessIdentity(leader.pid);
  assert.ok(identity);
  process.kill(leader.pid, "SIGKILL");
  await waitForProcessExit(leader.pid, false);
  assert.equal(isProcessAlive(leader.pid, null, false), false);
  assert.equal(isProcessAlive(leader.pid), true);
  assert.equal(isProcessAlive(childPid, null, false), true);
  assert.equal(await terminateProcessTree(leader.pid, { identity, ownsProcessGroup: true, requireIdentity: true, graceMs: 20 }), false);
  assert.equal(isProcessAlive(childPid, null, false), true);
});

test("task arguments enforce safe headless execution and put global flags before resume", () => {
  const args = buildTaskArgs({
    write: true,
    cwd: "/tmp/worktree",
    resultFile: "/tmp/result.txt",
    resumeThreadId: "thread-1",
    model: "gpt-test",
    effort: "high",
    webSearchMode: "live",
    networkAccessEnabled: true
  });
  assert.deepEqual(args, [
    "exec",
    "--strict-config",
    "--json",
    "--sandbox",
    "workspace-write",
    "--config",
    'approval_policy="never"',
    "--disable",
    "multi_agent",
    "--disable",
    "multi_agent_v2",
    "--model",
    "gpt-test",
    "-c",
    "service_tier=priority",
    "--config",
    'model_reasoning_effort="high"',
    "--config",
    'web_search="live"',
    "--config",
    "sandbox_workspace_write.network_access=true",
    "--cd",
    "/tmp/worktree",
    "resume",
    "thread-1"
  ]);
  assert.ok(args.indexOf("--json") < args.indexOf("resume"));
  assert.throws(() => buildTaskArgs({ sandboxMode: "danger-full-access" }), /not supported/);
  assert.throws(() => buildTaskArgs({ approvalPolicy: "on-request" }), /must be never/);
});

test("task arguments leave model and effort unset while pinning networked tools and internal agents off by default", () => {
  assert.deepEqual(buildTaskArgs(), [
    "exec",
    "--strict-config",
    "--json",
    "--sandbox",
    "read-only",
    "--config",
    'approval_policy="never"',
    "--disable",
    "multi_agent",
    "--disable",
    "multi_agent_v2",
    "-c",
    "service_tier=priority",
    "--config",
    'web_search="disabled"'
  ]);
  assert.match(buildTaskArgs({ effort: "ultra" }).join(" "), /model_reasoning_effort="ultra"/);
  assert.match(buildTaskArgs({ effort: "max" }).join(" "), /model_reasoning_effort="max"/);
  assert.ok(buildTaskArgs({ serviceTier: "standard" }).includes("service_tier=standard"));
  assert.ok(!buildTaskArgs({ serviceTier: "none" }).includes("-c"));
  assert.throws(() => buildTaskArgs({ serviceTier: "Priority" }), /Unsupported Codex service tier/);
  assert.match(buildTaskArgs({ write: true }).join(" "), /sandbox_workspace_write\.network_access=false/);
  assert.throws(() => buildTaskArgs({ network: true }), /requires a write task/);
});

test("task argv forwards an output schema and native review rejects one", () => {
  const schema = "/tmp/codex-verdict.schema.json";
  const args = buildTaskArgs({ outputSchemaFile: schema });
  assert.deepEqual(args.slice(-2), ["--output-schema", schema]);
  assert.ok(!buildTaskArgs().includes("--output-schema"));
  assert.throws(() => buildReviewArgs({ outputSchemaFile: schema }), /review ignores --output-schema/);
});

test("task and review argv retain local rollout persistence", () => {
  for (const args of [buildTaskArgs(), buildReviewArgs()]) {
    assert.ok(!args.includes("--ephemeral"));
  }
});

test("native review is read-only and maps review targets", () => {
  assert.deepEqual(buildReviewArgs({ base: "main" }), [
    "exec",
    "--strict-config",
    "--json",
    "--sandbox",
    "read-only",
    "--config",
    'approval_policy="never"',
    "--disable",
    "multi_agent",
    "--disable",
    "multi_agent_v2",
    "-c",
    "service_tier=priority",
    "--config",
    'web_search="disabled"',
    "review",
    "--base",
    "main"
  ]);
  assert.deepEqual(buildReviewArgs(), [
    "exec",
    "--strict-config",
    "--json",
    "--sandbox",
    "read-only",
    "--config",
    'approval_policy="never"',
    "--disable",
    "multi_agent",
    "--disable",
    "multi_agent_v2",
    "-c",
    "service_tier=priority",
    "--config",
    'web_search="disabled"',
    "review",
    "--uncommitted"
  ]);
  assert.throws(() => buildReviewArgs({ write: true }), /read-only/);
});

test("companion forwards and records the default service tier without an applied stream observation", (t) => {
  const sandbox = makeCompanionSandbox(t);
  const result = runCompanion(["task", "--json", "inspect the service tier"], {
    cwd: sandbox.workDir,
    env: companionEnvFor(sandbox),
    timeout: COMPANION_WATCHDOG_TIMEOUT_MS
  });
  assert.equal(result.status, 0, result.stderr);
  const argv = JSON.parse(fs.readFileSync(sandbox.argsFile, "utf8"));
  const serviceTierIndex = argv.indexOf("-c");
  assert.equal(argv[serviceTierIndex + 1], "service_tier=priority");
  const record = JSON.parse(result.stdout);
  assert.equal(record.serviceTier, "priority");
  assert.equal(record.appliedServiceTier, null);
  assert.equal(companionJobRecords(sandbox)[0]?.serviceTier, "priority");
});

test("usage normalization and subtraction reject incomplete or decreasing counters", () => {
  const cumulative = normalizeCumulativeUsage({
    input_tokens: 120,
    cached_input_tokens: 40,
    output_tokens: 30,
    reasoning_output_tokens: 10
  });
  assert.deepEqual(cumulative, {
    inputTokens: 120,
    cachedInputTokens: 40,
    outputTokens: 30,
    reasoningOutputTokens: 10,
    totalTokens: 150
  });
  assert.equal(normalizeCumulativeUsage({ input_tokens: 1 }), null);
  assert.equal(normalizeCumulativeUsage({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 3 }), null);
  assert.deepEqual(
    subtractUsage(cumulative, {
      inputTokens: 70,
      cachedInputTokens: 20,
      outputTokens: 10,
      reasoningOutputTokens: 4,
      totalTokens: 80
    }),
    { inputTokens: 50, cachedInputTokens: 20, outputTokens: 20, reasoningOutputTokens: 6, totalTokens: 70 }
  );
  assert.equal(subtractUsage(cumulative, { ...cumulative, outputTokens: 31, totalTokens: 151 }), null);
});

test("completed execution persists raw JSONL, keeps the prompt on stdin, and checkpoints lifecycle", async (t) => {
  const spawned = [];
  const spawnAttempts = [];
  const checkpoints = [];
  const { files, outcome } = await runFixture(t, "completed", {
    prompt: "do not place this prompt in argv",
    onSpawnAttempt: (pid) => spawnAttempts.push(pid),
    onSpawn: (pid) => spawned.push(pid),
    onCheckpoint: (checkpoint) => checkpoints.push(checkpoint)
  });
  assert.equal(outcome.status, "done");
  assert.equal(outcome.failureKind, null);
  assert.equal(outcome.threadId, "thread-123");
  assert.equal(outcome.terminalEvent, "turn.completed");
  assert.equal(outcome.finalResponse, "Codex completed the task.");
  assert.equal(outcome.resultSource, "agent_message");
  assert.deepEqual(outcome.cumulativeTokenUsage, {
    inputTokens: 120,
    cachedInputTokens: 40,
    outputTokens: 30,
    reasoningOutputTokens: 10,
    totalTokens: 150
  });
  assert.deepEqual(outcome.tokenUsage, outcome.cumulativeTokenUsage);
  assert.equal(outcome.tokenUsageAvailability, "available");
  assert.equal(fs.readFileSync(files.stdinFile, "utf8"), "do not place this prompt in argv");
  assert.ok(!JSON.parse(fs.readFileSync(files.argsFile, "utf8")).includes("do not place this prompt in argv"));
  assert.match(fs.readFileSync(files.eventsFile, "utf8"), /"type":"thread.started"/);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawnAttempts, spawned);
  assert.ok(Number.isInteger(spawned[0]));
  assert.ok(outcome.pidIdentity);
  assert.deepEqual(checkpoints.map((entry) => entry.event?.type), ["thread.started", "turn.started", "item.completed", "turn.completed"]);
  await waitForProcessExit(outcome.pid);
  assert.equal(isProcessAlive(outcome.pid), false);
  assert.equal(await terminateProcessTree(outcome.pid, { identity: outcome.pidIdentity, ownsProcessGroup: true, requireIdentity: true }), true);
  assert.equal(terminateProcessTreeSync(outcome.pid, { identity: outcome.pidIdentity, ownsProcessGroup: true, requireIdentity: true }), true);
});

test("rollout observation records resolved model and effort without treating request overrides as observations", async (t) => {
  const files = fixture(t);
  const { outcome } = await runFixture(t, "rollout-completed", {
    argOptions: { effort: "requested", model: "requested-model" },
    env: {
      CODEX_HOME: path.join(files.dir, "codex-home"),
      FAKE_CODEX_RESOLVED_EFFORT: "xhigh",
      FAKE_CODEX_RESOLVED_MODEL: "gpt-resolved"
    }
  });
  assert.equal(outcome.status, "done");
  assert.equal(outcome.resolvedModel, "gpt-resolved");
  assert.equal(outcome.resolvedEffort, "xhigh");
  assert.equal(outcome.rolloutRecoveryStatus, "recovered");
});

test("a collaboration tool event fails closed even when Codex emits a completed turn", async (t) => {
  const { outcome } = await runFixture(t, "collab-completed");
  assert.equal(outcome.status, "error");
  assert.equal(outcome.failureKind, "policy");
  assert.equal(outcome.semanticStatus, "rejected");
  assert.match(outcome.collaborationViolation, /disabled spawn_agent tool/);
});

test("a successful leader exit cleans every remaining process in its owned group", async (t) => {
  const { files, outcome } = await runFixture(t, "completed-with-group-child");
  const childPid = Number(fs.readFileSync(files.childPidFile, "utf8"));
  t.after(() => {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {}
  });
  assert.equal(outcome.status, "done");
  assert.equal(outcome.cleanupComplete, true);
  await waitForProcessExit(outcome.pid);
  await waitForProcessExit(childPid);
  assert.equal(isProcessAlive(outcome.pid), false);
  assert.equal(isProcessAlive(childPid, null, false), false);
});

test("signals remain forwarded while natural exit cleanup escalates", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX signal forwarding is unavailable on Windows.");
    return;
  }
  const files = fixture(t);
  const termFile = path.join(files.dir, "group-child.term");
  const readyFile = path.join(files.dir, "group-child.ready");
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "..", "plugins", "codex", "scripts", "lib", "codex-exec.mjs")).href;
  const source = `import { buildTaskArgs, runCodex } from ${JSON.stringify(moduleUrl)}; const args = buildTaskArgs({ cwd: process.env.TEST_CWD }); const outcome = await runCodex({ args, cwd: process.env.TEST_CWD, env: process.env, eventsFile: process.env.TEST_EVENTS, logFile: process.env.TEST_LOG, resultFile: process.env.TEST_RESULT, prompt: "test", timeoutMs: 15000, terminationGraceMs: 5000, terminationPollMs: 25 }); process.stdout.write(JSON.stringify(outcome));`;
  const harness = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: {
      ...process.env,
      CODEX_BIN: fakeCodex,
      FAKE_CODEX_CHILD_PID_FILE: files.childPidFile,
      FAKE_CODEX_GROUP_CHILD_IGNORE_TERM: "true",
      FAKE_CODEX_GROUP_CHILD_READY_FILE: readyFile,
      FAKE_CODEX_GROUP_CHILD_TERM_FILE: termFile,
      FAKE_CODEX_MODE: "completed-with-group-child",
      TEST_CWD: files.dir,
      TEST_EVENTS: files.eventsFile,
      TEST_LOG: files.logFile,
      TEST_RESULT: files.resultFile
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = [];
  const stderr = [];
  harness.stdout.on("data", (chunk) => stdout.push(chunk));
  harness.stderr.on("data", (chunk) => stderr.push(chunk));
  await waitForFile(readyFile);
  await waitUntil(() => fs.existsSync(termFile));
  const childPid = Number(fs.readFileSync(files.childPidFile, "utf8"));
  t.after(() => {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {}
    try {
      harness.kill("SIGKILL");
    } catch {}
  });
  harness.kill("SIGINT");
  const code = await new Promise((resolve, reject) => {
    harness.once("error", reject);
    harness.once("close", resolve);
  });
  assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
  const outcome = JSON.parse(Buffer.concat(stdout).toString("utf8"));
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.cleanupComplete, true);
  await waitForProcessExit(childPid);
  assert.equal(isProcessAlive(childPid, null, false), false);
});

test("a closed stdin fails even when Codex emits a completed lifecycle", async (t) => {
  const { outcome } = await runFixture(t, "completed", {
    env: { FAKE_CODEX_CLOSE_STDIN: "true" },
    prompt: "x".repeat(16 * 1024 * 1024),
    promptMaxBytes: 20 * 1024 * 1024
  });
  assert.equal(outcome.status, "error");
  assert.equal(outcome.failureKind, "process");
  assert.match(outcome.errorMessage, /closed stdin before accepting the complete prompt/i);
});

test("prompt, incomplete oversized JSONL events, and final responses fail with a resource error", async (t) => {
  await assert.rejects(
    runFixture(t, "completed", { prompt: "x".repeat(65), promptMaxBytes: 64 }),
    (error) => error?.failureKind === "resource"
  );
  const oversizedEvent = await runFixture(t, "oversized-event", {
    eventLineMaxBytes: 128,
    env: { FAKE_CODEX_EVENT_BYTES: "1024" }
  });
  assert.equal(oversizedEvent.outcome.status, "error");
  assert.equal(oversizedEvent.outcome.failureKind, "resource");
  assert.equal(oversizedEvent.outcome.errorMessage, "Codex emitted a JSONL event larger than the 128 byte limit.");
  assert.deepEqual(oversizedEvent.outcome.diagnostics, [
    { type: "warning", message: "Skipped a JSONL event larger than the 128 byte limit." }
  ]);
  const oversizedResult = await runFixture(t, "completed", {
    resultMaxBytes: 64,
    env: { FAKE_CODEX_MESSAGE_BYTES: "1024" }
  });
  assert.equal(oversizedResult.outcome.status, "error");
  assert.equal(oversizedResult.outcome.failureKind, "resource");
});

test("oversized JSONL events are skipped when the lifecycle completes", async (t) => {
  const { outcome } = await runFixture(t, "oversized-midrun-event", {
    eventLineMaxBytes: 128,
    env: { FAKE_CODEX_EVENT_BYTES: "1024" }
  });
  assert.equal(outcome.status, "done");
  assert.equal(outcome.failureKind, null);
  assert.deepEqual(outcome.diagnostics, [
    { type: "warning", message: "Skipped a JSONL event larger than the 128 byte limit." }
  ]);
});

test("final responses come only from the bounded JSONL stream", async (t) => {
  const { args, files, outcome } = await runFixture(t, "fallback");
  assert.equal(outcome.status, "done");
  assert.equal(outcome.finalResponse, "");
  assert.equal(outcome.resultSource, null);
  assert.equal(args.includes("--output-last-message"), false);
  assert.equal(fs.existsSync(files.resultFile), false);
});

test("turn.failed remains the structured failure when the process exits nonzero", async (t) => {
  const { outcome } = await runFixture(t, "failed");
  assert.equal(outcome.status, "error");
  assert.equal(outcome.failureKind, "error");
  assert.equal(outcome.terminalEvent, "turn.failed");
  assert.equal(outcome.errorMessage, "model execution failed");
  assert.equal(outcome.exitCode, 1);
});

test("top-level and item errors are diagnostics and do not override a completed turn", async (t) => {
  const { outcome } = await runFixture(t, "retry-error-completed");
  assert.equal(outcome.status, "done");
  assert.deepEqual(outcome.diagnostics, [
    { type: "error", message: "temporary upstream disconnect" },
    { type: "item.error", message: "configuration warning" }
  ]);
});

test("a pre-turn error item remains a diagnostic and does not fail a completed turn", async (t) => {
  const { outcome } = await runFixture(t, "pre-turn-warning-completed");
  assert.equal(outcome.status, "done");
  assert.equal(outcome.protocolError, null);
  assert.deepEqual(outcome.diagnostics, [
    { type: "item.error", message: "configuration warning before turn" }
  ]);
});

test("unknown valid events remain in the raw ledger and are forward compatible", async (t) => {
  const { files, outcome } = await runFixture(t, "unknown");
  assert.equal(outcome.status, "done");
  assert.equal(outcome.unknownEventCount, 1);
  const raw = fs.readFileSync(files.eventsFile, "utf8");
  assert.match(raw, /"type":"future.event"/);
  assert.match(raw, /"type":"future_item"/);
});

test("raw event ledgers retain a valid bounded prefix without affecting protocol parsing", async (t) => {
  const { files, outcome } = await runFixture(t, "completed", { eventsMaxBytes: 100 });
  assert.equal(outcome.status, "done");
  assert.equal(outcome.eventsTruncated, true);
  const raw = fs.readFileSync(files.eventsFile, "utf8");
  assert.ok(Buffer.byteLength(raw) <= 100);
  for (const line of raw.trim().split("\n").filter(Boolean)) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
});

for (const [mode, pattern] of [
  ["malformed", /malformed JSONL/],
  ["missing-terminal", /without a terminal turn event/],
  ["missing-sequence", /outside the required lifecycle sequence/]
]) {
  test(`${mode} output fails closed as a protocol error`, async (t) => {
    const { outcome } = await runFixture(t, mode);
    assert.equal(outcome.status, "error");
    assert.equal(outcome.failureKind, "protocol");
    assert.match(outcome.errorMessage, pattern);
  });
}

test("a nonzero exit invalidates an otherwise completed turn", async (t) => {
  const { outcome } = await runFixture(t, "nonzero");
  assert.equal(outcome.status, "error");
  assert.equal(outcome.failureKind, "process");
  assert.equal(outcome.terminalEvent, "turn.completed");
  assert.equal(outcome.exitCode, 7);
});

test("three consecutive apply_patch verification failures terminate as patch_thrash", async (t) => {
  const { outcome } = await runFixture(t, "hang", {
    env: { FAKE_CODEX_STDERR: `${PATCH_VERIFICATION_FAILURE}\n`.repeat(3) },
    terminationGraceMs: 100,
    timeoutMs: TIMEOUT_TEST_TIMEOUT_MS
  });
  assert.equal(outcome.status, "error");
  assert.equal(outcome.failureKind, "patch_thrash");
  assert.equal(outcome.timedOut, false);
  assert.match(outcome.errorMessage, /could not land a patch because its context lines did not match the file on disk after 3 consecutive apply_patch verification failures/i);
});

test("a completed file_change resets the apply_patch verification failure counter", async (t) => {
  const { outcome } = await runFixture(t, "scripted", {
    script: scriptedCodex(`process.stderr.write(${JSON.stringify(`${PATCH_VERIFICATION_FAILURE}\n`.repeat(2))});
await delay(100);
emit({ type: "item.completed", item: { id: "patch_1", type: "file_change" } });
await delay(100);
process.stderr.write(${JSON.stringify(`${PATCH_VERIFICATION_FAILURE}\n`.repeat(2))});
await delay(100);
emit({ type: "turn.completed", usage });`),
    timeoutMs: TIMEOUT_TEST_TIMEOUT_MS
  });
  assert.equal(outcome.status, "done");
  assert.equal(outcome.failureKind, null);
  assert.equal(outcome.timedOut, false);
});

test("a split apply_patch verification failure is counted once", async (t) => {
  const splitAt = PATCH_VERIFICATION_FAILURE.indexOf("verification");
  const { outcome } = await runFixture(t, "scripted", {
    script: scriptedCodex(`process.stderr.write(${JSON.stringify(PATCH_VERIFICATION_FAILURE.slice(0, splitAt))});
await delay(100);
process.stderr.write(${JSON.stringify(`${PATCH_VERIFICATION_FAILURE.slice(splitAt)}\n`)});
await delay(100);
process.stderr.write(${JSON.stringify(`${PATCH_VERIFICATION_FAILURE}\n`)});
await delay(100);
emit({ type: "item.completed", item: { id: "patch_1", type: "file_change" } });
await delay(100);
process.stderr.write(${JSON.stringify(`${PATCH_VERIFICATION_FAILURE}\n`.repeat(2))});
await delay(100);
emit({ type: "turn.completed", usage });`),
    timeoutMs: TIMEOUT_TEST_TIMEOUT_MS
  });
  assert.equal(outcome.status, "done");
  assert.equal(outcome.failureKind, null);
  assert.equal(outcome.timedOut, false);
});

test("three UnknownProcessId errors terminate as exec_lost", async (t) => {
  const { outcome } = await runFixture(t, "hang", {
    env: { FAKE_CODEX_STDERR: "exec_command failed for tool: UnknownProcessId { process_id: 1 }\n".repeat(3) },
    terminationGraceMs: 100,
    timeoutMs: TIMEOUT_TEST_TIMEOUT_MS
  });
  assert.equal(outcome.status, "error");
  assert.equal(outcome.failureKind, "exec_lost");
  assert.equal(outcome.timedOut, false);
  assert.match(outcome.errorMessage, /sandbox lost the spawned process after 3 UnknownProcessId errors/i);
});

test("timeout terminates the process group", async (t) => {
  const { outcome } = await runFixture(t, "hang", {
    timeoutMs: TIMEOUT_TEST_TIMEOUT_MS,
    terminationGraceMs: TIMEOUT_TEST_TERMINATION_GRACE_MS,
    waitForReady: true
  });
  assert.equal(outcome.status, "error");
  assert.equal(outcome.failureKind, "timeout");
  assert.equal(outcome.timedOut, true);
  await waitForProcessExit(outcome.pid);
  assert.equal(isProcessAlive(outcome.pid), false);
});

test("rollout recovery completes before the timeout verdict overrides late checkpoint errors", async (t) => {
  const files = fixture(t);
  let checkpointEnteredAt = null;
  let releaseCheckpoint;
  let enterCheckpoint;
  const checkpointEntered = new Promise((resolve) => {
    enterCheckpoint = resolve;
  });
  const execution = runFixture(t, "rollout-timeout", {
    env: { CODEX_HOME: path.join(files.dir, "codex-home") },
    timeoutMs: TIMEOUT_TEST_TIMEOUT_MS,
    terminationGraceMs: TIMEOUT_TEST_TERMINATION_GRACE_MS,
    onCheckpoint: async ({ event }) => {
      if (event?.type !== "thread.started" || checkpointEnteredAt != null) {
        return;
      }
      checkpointEnteredAt = Date.now();
      enterCheckpoint();
      await new Promise((resolve) => {
        releaseCheckpoint = resolve;
      });
      throw new Error("checkpoint failure after timeout");
    }
  });
  await checkpointEntered;
  await waitUntil(() => Date.now() >= checkpointEnteredAt + TIMEOUT_TEST_TIMEOUT_MS + LOAD_TOLERANT_POLL_INTERVAL_MS);
  releaseCheckpoint();
  const { outcome } = await execution;

  assert.ok(["error", "running"].includes(outcome.status));
  assert.equal(outcome.failureKind, "timeout");
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.partialResultText, "Recovered partial Codex output.");
  assert.equal(outcome.resultSource, "rollout_partial");
  assert.equal(outcome.tokenUsageAvailability, "partial");
  assert.equal(outcome.usageIsIncomplete, true);
  assert.deepEqual(outcome.cumulativeTokenUsage, {
    inputTokens: 120,
    cachedInputTokens: 40,
    outputTokens: 30,
    reasoningOutputTokens: 10,
    totalTokens: 150
  });
});

test("default timeout timing leaves the Bash tool margin after every escalation wait", () => {
  const interruptGraceMs = Math.ceil(DEFAULT_TERMINATION_GRACE_MS / 2);
  const terminateGraceMs = DEFAULT_TERMINATION_GRACE_MS - interruptGraceMs;
  const killConfirmationMs = DEFAULT_TERMINATION_GRACE_MS;
  const pollOvershootMs = DEFAULT_TERMINATION_POLL_MS * 3;
  const forcedCloseMs = 50;
  const escalationMs = interruptGraceMs + terminateGraceMs + killConfirmationMs + pollOvershootMs + forcedCloseMs;

  assert.equal(DEFAULT_TIMEOUT_PATH_MAX_MS, DEFAULT_TIMEOUT_MS + escalationMs);
  assert.equal(DEFAULT_TIMEOUT_PATH_WITH_MARGIN_MS, DEFAULT_TIMEOUT_PATH_MAX_MS + TIMEOUT_PATH_MARGIN_MS);
  assert.ok(DEFAULT_TIMEOUT_PATH_WITH_MARGIN_MS <= BASH_TOOL_TIMEOUT_MS);
});

test("foreground timeout reaps an uncooperative child and persists a terminal timeout record within the Bash budget", (t) => {
  const sandbox = makeCompanionSandbox(t);
  const interruptFile = path.join(sandbox.root, "interrupt.signal");
  const readyFile = path.join(sandbox.root, "ready.signal");
  const termFile = path.join(sandbox.root, "term.signal");
  const timeoutMs = TIMEOUT_TEST_TIMEOUT_MS;
  const startedAt = Date.now();
  const result = runCompanion(["task", "--json", "wait for the timeout"], {
    cwd: sandbox.workDir,
    env: companionEnvFor(sandbox, {
      CODEX_COMPANION_TIMEOUT_MS: String(timeoutMs),
      FAKE_CODEX_INT_FILE: interruptFile,
      FAKE_CODEX_MODE: "ignore-term",
      FAKE_CODEX_READY_FILE: readyFile,
      FAKE_CODEX_TERM_FILE: termFile
    }),
    timeout: COMPANION_WATCHDOG_TIMEOUT_MS
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.status, 1, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.status, "error");
  assert.equal(record.failureKind, "timeout");
  assert.ok(record.finishedAt);
  assert.ok(Date.parse(record.finishedAt) - startedAt < BASH_TOOL_TIMEOUT_MS);
  assert.equal(record.pid, null);
  assert.equal(record.codexPid, null);
  assert.equal(companionJobRecords(sandbox)[0]?.status, "error");
  assert.equal(fs.readFileSync(readyFile, "utf8"), "ready");
  assert.equal(fs.readFileSync(interruptFile, "utf8"), "received");
  assert.equal(fs.readFileSync(termFile, "utf8"), "received");
  assert.ok(elapsedMs < BASH_TOOL_TIMEOUT_MS);
});

test("timeout recovers partial output, cumulative usage, and resolved runtime fields from the local rollout", async (t) => {
  const files = fixture(t);
  const { outcome } = await runFixture(t, "rollout-timeout", {
    env: { CODEX_HOME: path.join(files.dir, "codex-home") },
    timeoutMs: TIMEOUT_TEST_TIMEOUT_MS,
    terminationGraceMs: TIMEOUT_TEST_TERMINATION_GRACE_MS
  });
  assert.equal(outcome.status, "error");
  assert.equal(outcome.failureKind, "timeout");
  assert.equal(outcome.rolloutRecoveryStatus, "recovered");
  assert.equal(outcome.partialResultText, "Recovered partial Codex output.");
  assert.equal(outcome.resultSource, "rollout_partial");
  assert.equal(outcome.resolvedModel, "gpt-resolved");
  assert.equal(outcome.resolvedEffort, "xhigh");
  assert.equal(outcome.tokenUsageAvailability, "partial");
  assert.equal(outcome.usageIsIncomplete, true);
  assert.deepEqual(outcome.cumulativeTokenUsage, {
    inputTokens: 120,
    cachedInputTokens: 40,
    outputTokens: 30,
    reasoningOutputTokens: 10,
    totalTokens: 150
  });
});

test("timeout stops after INT when Codex gracefully reaps its group child", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX signal behavior is unavailable on Windows.");
    return;
  }
  const { files, outcome } = await runFixture(t, "interrupt-cleanup", {
    timeoutMs: TIMEOUT_TEST_TIMEOUT_MS,
    terminationGraceMs: TIMEOUT_TEST_TERMINATION_GRACE_MS,
    waitForReady: true
  });
  const childPid = Number(fs.readFileSync(files.childPidFile, "utf8"));
  t.after(() => {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {}
  });
  assert.equal(outcome.status, "error");
  assert.equal(outcome.failureKind, "timeout");
  assert.equal(outcome.signal, null);
  assert.equal(outcome.cleanupComplete, true);
  assert.equal(fs.readFileSync(files.interruptFile, "utf8"), "received");
  assert.equal(fs.existsSync(files.termFile), false);
  await waitForProcessExit(childPid);
  assert.equal(isProcessAlive(childPid, null, false), false);
});

test("timeout escalates from INT through TERM to KILL when Codex ignores INT and TERM", async (t) => {
  const interruptFile = path.join(os.tmpdir(), `fusion-codex-int-${process.pid}-${Date.now()}`);
  const termFile = path.join(os.tmpdir(), `fusion-codex-term-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(interruptFile, { force: true }));
  t.after(() => fs.rmSync(termFile, { force: true }));
  const { outcome } = await runFixture(t, "ignore-term", {
    timeoutMs: TIMEOUT_TEST_TIMEOUT_MS,
    terminationGraceMs: TIMEOUT_TEST_TERMINATION_GRACE_MS,
    env: { FAKE_CODEX_INT_FILE: interruptFile, FAKE_CODEX_TERM_FILE: termFile },
    waitForReady: true
  });
  assert.equal(outcome.status, "error");
  assert.equal(outcome.failureKind, "timeout");
  assert.equal(outcome.signal, "SIGKILL");
  assert.equal(fs.readFileSync(interruptFile, "utf8"), "received");
  assert.equal(fs.readFileSync(termFile, "utf8"), "received");
  await waitForProcessExit(outcome.pid);
  assert.equal(isProcessAlive(outcome.pid), false);
});

test("incomplete timeout cleanup remains nonterminal with process evidence", async (t) => {
  const startedAt = Date.now();
  const { outcome } = await runFixture(t, "inherited-pipe", {
    timeoutMs: 50,
    terminationGraceMs: 50,
    waitForReady: true
  });
  assert.equal(outcome.status, "running");
  assert.equal(outcome.failureKind, "timeout");
  assert.equal(outcome.cleanupComplete, false);
  assert.ok(Number.isInteger(outcome.pid));
  assert.ok(outcome.pidIdentity);
  assert.ok(Date.now() - startedAt < LOAD_TOLERANT_WAIT_TIMEOUT_MS);
});

test("stderr is kept separate from JSONL and bounded to the configured tail", async (t) => {
  const stderr = `${"a".repeat(400)}important-tail`;
  const { files, outcome } = await runFixture(t, "completed", {
    stderrMaxBytes: 64,
    env: { FAKE_CODEX_STDERR: stderr }
  });
  assert.equal(outcome.status, "done");
  assert.ok(Buffer.byteLength(outcome.stderrTail) <= 64);
  assert.ok(outcome.stderrTail.endsWith("important-tail"));
  assert.equal(fs.readFileSync(files.logFile, "utf8"), outcome.stderrTail);
  assert.doesNotMatch(fs.readFileSync(files.eventsFile, "utf8"), /important-tail/);
});

test("renderable diagnostics redact credential shapes while the private log retains the raw tail", async (t) => {
  const secret = "sk-test-secret-value-1234567890";
  const { files, outcome } = await runFixture(t, "completed", {
    env: { FAKE_CODEX_STDERR: `authentication failed for ${secret}` }
  });
  assert.equal(outcome.status, "done");
  assert.doesNotMatch(outcome.stderrTail, new RegExp(secret));
  assert.match(outcome.stderrTail, /\[redacted\]/);
  assert.match(fs.readFileSync(files.logFile, "utf8"), new RegExp(secret));
});

test("resumed cumulative usage is unavailable without provable thread continuity", async (t) => {
  const { outcome } = await runFixture(t, "completed", { resumeThreadId: "thread-123" });
  assert.deepEqual(outcome.cumulativeTokenUsage, {
    inputTokens: 120,
    cachedInputTokens: 40,
    outputTokens: 30,
    reasoningOutputTokens: 10,
    totalTokens: 150
  });
  assert.equal(outcome.tokenUsage, null);
  assert.equal(outcome.tokenUsageAvailability, "unavailable");
  assert.equal(outcome.tokenUsageUnavailableReason, "resume_continuity_unverifiable");
});

test("resume fails closed when Codex starts a different thread", async (t) => {
  const baseline = {
    inputTokens: 70,
    cachedInputTokens: 20,
    outputTokens: 10,
    reasoningOutputTokens: 4,
    totalTokens: 80
  };
  const { outcome } = await runFixture(t, "completed", {
    resumeThreadId: "requested-thread",
    cumulativeUsageBaseline: baseline,
    env: { FAKE_CODEX_THREAD_ID: "unexpected-thread" }
  });
  assert.equal(outcome.status, "error");
  assert.equal(outcome.failureKind, "protocol");
  assert.match(outcome.errorMessage, /unexpected-thread instead of the requested thread requested-thread/);
  assert.equal(outcome.tokenUsage, null);
  assert.equal(outcome.tokenUsageAvailability, "unavailable");
  assert.equal(outcome.tokenUsageUnavailableReason, "resume_thread_mismatch");
});

test("upstream all-zero usage is kept unavailable instead of becoming a fabricated exact total", async (t) => {
  const zeroUsage = JSON.stringify({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
  const { outcome } = await runFixture(t, "completed", { env: { FAKE_CODEX_USAGE: zeroUsage } });
  assert.equal(outcome.status, "done");
  assert.equal(outcome.cumulativeTokenUsage, null);
  assert.equal(outcome.tokenUsage, null);
  assert.equal(outcome.tokenUsageAvailability, "unavailable");
  assert.equal(outcome.tokenUsageUnavailableReason, "upstream_zero_usage");
});

test("a stored baseline cannot make resumed usage exact across out of band turns", async (t) => {
  const baseline = {
    inputTokens: 70,
    cachedInputTokens: 20,
    outputTokens: 10,
    reasoningOutputTokens: 4,
    totalTokens: 80
  };
  const { outcome } = await runFixture(t, "completed", {
    resumeThreadId: "thread-123",
    cumulativeUsageBaseline: baseline
  });
  assert.equal(outcome.tokenUsageAvailability, "unavailable");
  assert.equal(outcome.tokenUsageUnavailableReason, "resume_continuity_unverifiable");
  assert.equal(outcome.tokenUsage, null);
});
