import assert from "node:assert";
import { messageTag } from "../plugins/fusion/scripts/lib/user-messages.mjs";

const MONITOR_TAG = messageTag("codex-monitor.job-notification");
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { getProcessIdentity } from "../plugins/codex/scripts/lib/codex-exec.mjs";
import { gitIsolation } from "./lib/git-fixture.mjs";
import { inspectCodexRollout } from "../plugins/fusion/scripts/codex-jobs-monitor.mjs";
import { fusionRepositoryKey, modelAuditSidecarPath, tokenUsageSidecarPath } from "../plugins/fusion/scripts/fusion-stats.mjs";
import { grokJobsObserverStatePath } from "../plugins/fusion/scripts/grok-jobs-observer.mjs";

const repoRoot = path.join(import.meta.dirname, "..");
const monitorScript = path.join(repoRoot, "plugins", "fusion", "scripts", "codex-jobs-monitor.mjs");

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-monitor-test-")));
  const stateRoot = path.join(root, "state");
  const workDir = path.join(root, "work");
  const fusionData = path.join(root, "fusion-data");
  const grokData = path.join(root, "grok-data");
  const sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(fusionData, { recursive: true });
  fs.mkdirSync(grokData, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sandbox = { root, stateRoot, workDir, fusionData, grokData, sessionsDir, children: new Set() };
  t.after(async () => {
    const closing = [...sandbox.children].map((child) => {
      if (child.exitCode != null || child.signalCode != null) {
        return Promise.resolve();
      }
      const closed = once(child, "close").then(() => undefined);
      child.kill("SIGKILL");
      return closed;
    });
    await Promise.all(closing);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });
  return sandbox;
}

function jobsDirFor(sandbox, workspace) {
  return path.join(sandbox.stateRoot, workspace, "jobs");
}

function writeJobRecordFile(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function grokWorkspaceSlug(cwd) {
  const absolute = path.resolve(cwd);
  return `${path.basename(absolute)}-${createHash("sha256").update(absolute).digest("hex").slice(0, 16)}`;
}

function writeGrokJob(sandbox, cwd, id, fields) {
  const jobsDir = path.join(sandbox.grokData, "state", grokWorkspaceSlug(cwd), "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, `${id}.json`), `${JSON.stringify({ id, cwd, ...fields })}\n`);
}

function readJsonLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function seedJob(sandbox, fields = {}, { workspace = "ws", workspaceRoot } = {}) {
  const id = fields.id ?? `task-${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    status: "running",
    workspaceRoot: workspaceRoot ?? sandbox.workDir,
    jobClass: "task",
    kind: "task",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...fields,
    id,
  };
  const file = path.join(jobsDirFor(sandbox, workspace), `${id}.json`);
  writeJobRecordFile(file, record);
  return { file, record };
}

function envFor(sandbox, extra = {}) {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.FUSION_CODEX_COMPANION;
  return {
    ...env,
    FUSION_CODEX_STATE: sandbox.stateRoot,
    FUSION_DATA_DIR: sandbox.fusionData,
    GROK_COMPANION_DATA: sandbox.grokData,
    CODEX_JOBS_MONITOR_SESSIONS_DIR: sandbox.sessionsDir,
    CODEX_JOBS_MONITOR_INTERVAL_MS: "200",
    ...extra,
  };
}

function startMonitor(sandbox, env, { cwd = sandbox.workDir, script = monitorScript } = {}) {
  const child = spawn(process.execPath, [script], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let started = false;
  child.once("spawn", () => {
    started = true;
  });
  sandbox.children.add(child);
  child.once("close", () => sandbox.children.delete(child));
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  return {
    child,
    started: () => started,
    lines: () => stdout.split("\n").filter(Boolean),
    stderr: () => stderr,
  };
}

function createSiblingWorktree(sandbox) {
  const sibling = path.join(sandbox.root, "sibling-worktree");
  execFileSync("git", ["init", "-q"], { cwd: sandbox.workDir, env: { ...process.env, ...gitIsolation(sandbox.root) } });
  execFileSync("git", ["worktree", "add", "--orphan", sibling], { cwd: sandbox.workDir, env: { ...process.env, ...gitIsolation(sandbox.root) } });
  return sibling;
}

async function waitUntil(predicate, { timeoutMs = 5000, pollMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function readAnnouncedState(sandbox, sessionId = null, workspaceRoot = sandbox.workDir) {
  try {
    return JSON.parse(fs.readFileSync(announcedPath(sandbox, sessionId, workspaceRoot), "utf8"));
  } catch {
    return null;
  }
}

async function waitForAnnouncedRecord(sandbox, jobId, sessionId = null, workspaceRoot = sandbox.workDir) {
  return waitUntil(() => {
    const state = readAnnouncedState(sandbox, sessionId, workspaceRoot);
    return state?.records.some((record) => record.jobId === jobId) ? state : null;
  });
}

test("a pre-existing terminal job emits nothing on startup", async (t) => {
  const sandbox = makeSandbox(t);
  const { record } = seedJob(sandbox, { status: "done" });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitForAnnouncedRecord(sandbox, record.id);
  assert.deepStrictEqual(monitor.lines(), []);
});

test("the merged monitor observes a terminal Grok job in its recorded workspace", async (t) => {
  const sandbox = makeSandbox(t);
  const workspaceRoot = path.join(sandbox.root, "grok-workspace");
  const env = envFor(sandbox);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  writeGrokJob(sandbox, workspaceRoot, "grok-terminal", {
    status: "done",
    resolvedModel: "grok-4",
    resolvedEffort: "high",
    usage: { input_tokens: 120, cache_read_input_tokens: 40, output_tokens: 30, reasoning_tokens: 12, total_tokens: 150 }
  });

  const monitor = startMonitor(sandbox, env);
  t.after(() => monitor.child.kill("SIGKILL"));
  const { tokenUsage, modelAudit } = await waitUntil(() => {
    const tokenUsage = readJsonLines(tokenUsageSidecarPath(workspaceRoot, env));
    const modelAudit = readJsonLines(modelAuditSidecarPath(workspaceRoot, env));
    return tokenUsage.length === 1 && modelAudit.length === 1 ? { tokenUsage, modelAudit } : null;
  });
  const repositoryKey = fusionRepositoryKey(workspaceRoot);
  const [{ observedAt: tokenObservedAt, ...tokenObservation }] = tokenUsage;
  const [{ observedAt: modelObservedAt, ...modelObservation }] = modelAudit;

  assert.ok(typeof tokenObservedAt === "string" && tokenObservedAt.length > 0);
  assert.ok(typeof modelObservedAt === "string" && modelObservedAt.length > 0);
  assert.deepStrictEqual(tokenObservation, {
    schemaVersion: 1,
    jobId: "grok-terminal",
    engine: "grok",
    workspaceRoot,
    repositoryKey,
    availability: "available",
    tokenUsage: { inputTokens: 120, cachedInputTokens: 40, outputTokens: 30, reasoningOutputTokens: 12, totalTokens: 150 },
    source: "grok-job-record"
  });
  assert.deepStrictEqual(modelObservation, {
    schemaVersion: 1,
    jobId: "grok-terminal",
    engine: "grok",
    model: "grok-4",
    effort: "high",
    workspaceRoot,
    repositoryKey,
    source: "grok-job-record"
  });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(grokJobsObserverStatePath(env), "utf8")).observedJobIds, ["grok-terminal"]);
});

test("a Grok observation does not suppress a Codex notification on the same tick", async (t) => {
  const sandbox = makeSandbox(t);
  const workspaceRoot = path.join(sandbox.root, "grok-workspace");
  const { file, record } = seedJob(sandbox, { status: "running" });
  const env = envFor(sandbox);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const monitor = startMonitor(sandbox, env);
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox));

  writeGrokJob(sandbox, workspaceRoot, "grok-same-tick", {
    status: "done",
    usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 3, reasoning_tokens: 1, total_tokens: 13 }
  });
  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  await waitUntil(() => readJsonLines(tokenUsageSidecarPath(workspaceRoot, env)).some((observation) => observation.jobId === "grok-same-tick"));
  assert.deepStrictEqual(lines, [
    `codex job ${record.id} done. collect with /codex:result ${record.id}; completion notices do not replace collection. ${MONITOR_TAG}`
  ]);
});

test("a non-directory Grok state root leaves Codex announcements unchanged", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running" });
  fs.writeFileSync(path.join(sandbox.grokData, "state"), "not a directory\n");
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox));

  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `codex job ${record.id} done. collect with /codex:result ${record.id}; completion notices do not replace collection. ${MONITOR_TAG}`
  ]);
  await assertMonitorStaysAlive(monitor);
});

test("a Grok observation produces no stdout", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  writeGrokJob(sandbox, sandbox.workDir, "grok-silent", {
    status: "done",
    usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 3, reasoning_tokens: 1, total_tokens: 13 }
  });
  const monitor = startMonitor(sandbox, env);
  t.after(() => monitor.child.kill("SIGKILL"));

  await waitUntil(() => fs.existsSync(grokJobsObserverStatePath(env)));
  assert.deepStrictEqual(monitor.lines(), []);
});

test("a job transitioning to done emits exactly one correctly shaped line", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running" });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox));
  assert.deepStrictEqual(monitor.lines(), []);

  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `codex job ${record.id} done. collect with /codex:result ${record.id}; completion notices do not replace collection. ${MONITOR_TAG}`
  );

  await waitForAnnouncedRecord(sandbox, record.id);
  assert.strictEqual(monitor.lines().length, 1);
});

test("monitors jobs from a sibling worktree in the same Git repository", async (t) => {
  const sandbox = makeSandbox(t);
  const sibling = createSiblingWorktree(sandbox);
  const { file, record } = seedJob(sandbox, { status: "running" }, { workspaceRoot: sibling });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox));

  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], new RegExp(`^codex job ${record.id} done\\.`));
});

test("a job transitioning to error reports a truncated error message when present", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running" });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox));

  writeJobRecordFile(file, {
    ...record,
    status: "error",
    finishedAt: new Date().toISOString(),
    pid: null,
    errorMessage: "worker process exited with status 1\nfull stack trace follows",
  });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `codex job ${record.id} error (worker process exited with status 1). collect with /codex:result ${record.id}; completion notices do not replace collection. ${MONITOR_TAG}`
  );
});

test("a job transitioning to error with no error message emits no suffix", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running" });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox));

  writeJobRecordFile(file, { ...record, status: "error", finishedAt: new Date().toISOString(), pid: null });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `codex job ${record.id} error. collect with /codex:result ${record.id}; completion notices do not replace collection. ${MONITOR_TAG}`
  );
});

test("a long error message is truncated to a sane length", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running" });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox));

  const longMessage = "x".repeat(200);
  writeJobRecordFile(file, {
    ...record,
    status: "cancelled",
    finishedAt: new Date().toISOString(),
    pid: null,
    errorMessage: longMessage,
  });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `codex job ${record.id} cancelled (${"x".repeat(80)}...). collect with /codex:result ${record.id}; completion notices do not replace collection. ${MONITOR_TAG}`
  );
});

test("session monitors announce their own Claude jobs once and still surface orphans", async (t) => {
  const sandbox = makeSandbox(t);
  const { file: ownFile, record: ownRecord } = seedJob(sandbox, {
    status: "running",
    sessionId: "codex-own",
    claudeSessionId: "session-own"
  });
  const { file: otherFile, record: otherRecord } = seedJob(sandbox, {
    status: "running",
    sessionId: "codex-other",
    claudeSessionId: "session-other"
  });
  const { file: orphanFile, record: orphanRecord } = seedJob(sandbox, { status: "running", sessionId: "codex-orphan" });
  const ownMonitor = startMonitor(sandbox, envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-own" }));
  const otherMonitor = startMonitor(sandbox, envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-other" }));
  t.after(() => ownMonitor.child.kill("SIGKILL"));
  t.after(() => otherMonitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox, "session-own") && readAnnouncedState(sandbox, "session-other"));

  writeJobRecordFile(ownFile, { ...ownRecord, status: "done", finishedAt: new Date().toISOString() });
  writeJobRecordFile(otherFile, { ...otherRecord, status: "done", finishedAt: new Date().toISOString() });
  writeJobRecordFile(orphanFile, { ...orphanRecord, status: "done", finishedAt: new Date().toISOString() });

  await waitUntil(() => (ownMonitor.lines().length === 2 && otherMonitor.lines().length === 2 ? true : null));
  assert.deepStrictEqual(ownMonitor.lines().sort(), [
    `codex job ${orphanRecord.id} done. collect with /codex:result ${orphanRecord.id}; completion notices do not replace collection. ${MONITOR_TAG}`,
    `codex job ${ownRecord.id} done. collect with /codex:result ${ownRecord.id}; completion notices do not replace collection. ${MONITOR_TAG}`
  ].sort());
  assert.deepStrictEqual(otherMonitor.lines().sort(), [
    `codex job ${orphanRecord.id} done. collect with /codex:result ${orphanRecord.id}; completion notices do not replace collection. ${MONITOR_TAG}`,
    `codex job ${otherRecord.id} done. collect with /codex:result ${otherRecord.id}; completion notices do not replace collection. ${MONITOR_TAG}`
  ].sort());

  const { ownLedger, otherLedger } = await waitUntil(() => {
    try {
      const ownLedger = JSON.parse(fs.readFileSync(announcedPath(sandbox, "session-own"), "utf8"));
      const otherLedger = JSON.parse(fs.readFileSync(announcedPath(sandbox, "session-other"), "utf8"));
      return ownLedger.records.length === 2 && otherLedger.records.length === 2 ? { ownLedger, otherLedger } : null;
    } catch {
      return null;
    }
  });
  assert.deepStrictEqual(ownLedger.records.map((record) => record.jobId).sort(), [orphanRecord.id, ownRecord.id].sort());
  assert.deepStrictEqual(otherLedger.records.map((record) => record.jobId).sort(), [orphanRecord.id, otherRecord.id].sort());
  assert.strictEqual(ownLedger.records.find((record) => record.jobId === ownRecord.id).sessionId, "session-own");
  assert.strictEqual(otherLedger.records.find((record) => record.jobId === otherRecord.id).sessionId, "session-other");
  assert.strictEqual(ownLedger.records.find((record) => record.jobId === orphanRecord.id).sessionId, null);
});

test("with the session id env var unset, a job from a different session still emits", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running", sessionId: "session-other" });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox));

  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `codex job ${record.id} done. collect with /codex:result ${record.id}; completion notices do not replace collection. ${MONITOR_TAG}`
  );
});

test("a job in a different workspace stays silent even once terminal", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(
    sandbox,
    { status: "running" },
    { workspace: "other-ws", workspaceRoot: path.join(sandbox.root, "other-work") }
  );
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox));

  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });

  await waitUntil(() => readAnnouncedState(sandbox));
  assert.deepStrictEqual(monitor.lines(), []);
});

test("a monitor started from a subdirectory still matches jobs recorded against the repo root", async (t) => {
  const sandbox = makeSandbox(t);
  execFileSync("git", ["init", "--quiet"], { cwd: sandbox.workDir, env: { ...process.env, ...gitIsolation(sandbox.root) } });
  const subDir = path.join(sandbox.workDir, "nested", "deeper");
  fs.mkdirSync(subDir, { recursive: true });

  const { file, record } = seedJob(sandbox, { status: "running" }, { workspaceRoot: sandbox.workDir });
  const monitor = startMonitor(sandbox, envFor(sandbox), { cwd: subDir });
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox));

  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `codex job ${record.id} done. collect with /codex:result ${record.id}; completion notices do not replace collection. ${MONITOR_TAG}`
  );
});

test("a monitor includes jobs recorded in a worktree beneath the repo root", async (t) => {
  const sandbox = makeSandbox(t);
  const worktreeRoot = path.join(sandbox.workDir, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const { file, record } = seedJob(sandbox, { status: "running" }, { workspace: "worktree-ws", workspaceRoot: worktreeRoot });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox));

  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `codex job ${record.id} done. collect with /codex:result ${record.id}; completion notices do not replace collection. ${MONITOR_TAG}`
  ]);
});

test("a running job whose pid has vanished is terminalized and announced exactly once", async (t) => {
  const sandbox = makeSandbox(t);
  const shortLivedChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 0)"]);
  const pid = shortLivedChild.pid;
  const pidIdentity = getProcessIdentity(pid);
  assert.ok(pidIdentity, "Process identity probing is unavailable for the tracked child.");
  await once(shortLivedChild, "exit");

  const { file, record } = seedJob(sandbox, { createdAt: new Date(Date.now() - 1000).toISOString(), status: "running", pid, pidIdentity });
  const monitor = startMonitor(sandbox, envFor(sandbox, { CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS: "0" }));
  t.after(() => monitor.child.kill("SIGKILL"));

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], new RegExp(`^codex job ${record.id} error \\(Recorded process ${record.pid} exited without recording a terminal outcome\\)`));
  const terminal = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(terminal.status, "error");
  assert.strictEqual(terminal.failureKind, "died");

  await waitForAnnouncedRecord(sandbox, record.id);
  assert.strictEqual(monitor.lines().length, 1);
});

test("a canonical running job whose owner exits is terminalized before announcement", async (t) => {
  const sandbox = makeSandbox(t);
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  t.after(() => worker.kill("SIGKILL"));
  const pidIdentity = getProcessIdentity(worker.pid);
  assert.ok(pidIdentity, "Process identity probing is unavailable for the tracked worker.");
  const { file, record } = seedJob(sandbox, {
    schemaVersion: 1,
    engine: "codex",
    status: "running",
    phase: "executing",
    pid: worker.pid,
    pidIdentity,
    codexPid: null,
    finishedAt: null
  });
  const monitor = startMonitor(sandbox, envFor(sandbox, { CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS: "0" }));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox));
  worker.kill("SIGKILL");
  await once(worker, "close");

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.match(lines[0], new RegExp(`^codex job ${record.id} error \\(Recorded process ${record.pid} exited without recording a terminal outcome\\)`));
  const terminal = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(terminal.status, "error");
  assert.strictEqual(terminal.failureKind, "died");
});

test("a cleanup-required job without a pid is reconciled after the grace window", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, {
    codexPid: null,
    errorMessage: "Unable to verify lock owner process 22850.",
    failureKind: "process",
    phase: "cleanup-required",
    pid: null,
    status: "running"
  });
  const monitor = startMonitor(sandbox, envFor(sandbox, { CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS: "500" }));
  t.after(() => monitor.child.kill("SIGKILL"));

  await waitUntil(() => readAnnouncedState(sandbox));
  assert.deepStrictEqual(monitor.lines(), []);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).status, "running");

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.match(lines[0], new RegExp(`^codex job ${record.id} error \\(No process id was recorded before the launch grace window elapsed\\)`));
  const terminal = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(terminal.status, "error");
  assert.strictEqual(terminal.failureKind, "died");
  assert.strictEqual(terminal.phase, null);
});

test("a cleanup-required job with an unavailable owner identity is left untouched", async (t) => {
  const sandbox = makeSandbox(t);
  const identityProbeBin = path.join(sandbox.root, "identity-probe-bin");
  fs.mkdirSync(identityProbeBin);
  const deniedPs = path.join(identityProbeBin, "ps");
  fs.writeFileSync(deniedPs, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const { file, record } = seedJob(sandbox, {
    createdAt: new Date(Date.now() - 1000).toISOString(),
    errorMessage: "Unable to verify lock owner process.",
    failureKind: "process",
    phase: "cleanup-required",
    pid: process.pid,
    pidIdentity:
      process.platform === "linux"
        ? null
        : { version: 1, platform: process.platform, bootMarker: "recorded", startMarker: "recorded", commandHash: "0".repeat(64) },
    status: "running"
  });
  const monitor = startMonitor(
    sandbox,
    envFor(sandbox, {
      CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS: "0",
      ...(process.platform === "linux" ? {} : { PATH: `${identityProbeBin}${path.delimiter}${process.env.PATH}` })
    })
  );
  t.after(() => monitor.child.kill("SIGKILL"));

  await waitUntil(() => readAnnouncedState(sandbox) && JSON.parse(fs.readFileSync(file, "utf8")).status === "running");
  assert.deepStrictEqual(monitor.lines(), []);
  assert.strictEqual(monitor.stderr(), "");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), record);
});

test("a recycled live pid is terminalized without signaling its replacement and announced once across monitor passes", async (t) => {
  const sandbox = makeSandbox(t);
  const signalFile = path.join(sandbox.root, "replacement-signals");
  const readyFile = path.join(sandbox.root, "replacement-ready");
  const replacement = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import fs from "node:fs";
const [signalFile, readyFile] = process.argv.slice(1);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => fs.appendFileSync(signalFile, signal + "\\n"));
}
fs.writeFileSync(readyFile, "ready");
setInterval(() => {}, 1000);`,
      signalFile,
      readyFile
    ],
    { stdio: "ignore" }
  );
  t.after(() => replacement.kill("SIGKILL"));
  await waitUntil(() => (fs.existsSync(readyFile) ? true : null));
  const identity = getProcessIdentity(replacement.pid);
  assert.ok(identity, "Process identity probing is unavailable for the tracked replacement.");
  const { file, record } = seedJob(sandbox, {
    createdAt: new Date(Date.now() - 1000).toISOString(),
    errorMessage: "Unable to verify lock owner process.",
    failureKind: "process",
    phase: "cleanup-required",
    pid: replacement.pid,
    pidIdentity: {
      ...identity,
      commandHash: identity.commandHash === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64)
    },
    status: "running"
  });
  const monitor = startMonitor(sandbox, envFor(sandbox, { CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS: "0" }));
  t.after(() => monitor.child.kill("SIGKILL"));

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], new RegExp(`^codex job ${record.id} error \\(Recorded process ${replacement.pid} exited without recording a terminal outcome\\)`));
  const terminal = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(terminal.status, "error");
  assert.strictEqual(terminal.failureKind, "died");
  assert.doesNotThrow(() => process.kill(replacement.pid, 0));
  assert.equal(fs.existsSync(signalFile), false);

  await waitForAnnouncedRecord(sandbox, record.id);
  assert.strictEqual(monitor.lines().length, 1);
  const announced = JSON.parse(fs.readFileSync(announcedPath(sandbox), "utf8"));
  assert.strictEqual(announced.records.filter((entry) => entry.jobId === record.id).length, 1);
});

test("a terminal worktree copy suppresses a dead alarm for its stale running mirror", async (t) => {
  const sandbox = makeSandbox(t);
  const worktreeRoot = path.join(sandbox.workDir, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const shortLivedChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 0)"]);
  const pid = shortLivedChild.pid;
  const pidIdentity = getProcessIdentity(pid);
  assert.ok(pidIdentity, "Process identity probing is unavailable for the tracked child.");
  await once(shortLivedChild, "exit");
  const id = "mirrored-job";
  seedJob(sandbox, { id, status: "running", pid, pidIdentity }, { workspace: "parent-ws", workspaceRoot: sandbox.workDir });
  seedJob(
    sandbox,
    { id, status: "done", finishedAt: new Date().toISOString(), pid: null },
    { workspace: "worktree-ws", workspaceRoot: worktreeRoot }
  );

  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitForAnnouncedRecord(sandbox, id);

  assert.deepStrictEqual(monitor.lines(), []);
});

test("a running job with a live pid is not reported as dead", async (t) => {
  const sandbox = makeSandbox(t);
  seedJob(sandbox, { status: "running", pid: process.pid });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));

  await waitUntil(() => readAnnouncedState(sandbox));
  assert.deepStrictEqual(monitor.lines(), []);
});

test("a vanished state root mid run does not crash the process and a later tick still emits", async (t) => {
  const sandbox = makeSandbox(t);
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox));

  fs.rmSync(sandbox.stateRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(sandbox.stateRoot), { recursive: true });
  fs.writeFileSync(sandbox.stateRoot, "not a directory");
  await waitUntil(() => !fs.statSync(sandbox.stateRoot).isDirectory());
  assert.strictEqual(monitor.child.exitCode, null);
  assert.deepStrictEqual(monitor.lines(), []);

  fs.rmSync(sandbox.stateRoot, { force: true });
  const { file, record } = seedJob(sandbox, { status: "running" });
  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `codex job ${record.id} done. collect with /codex:result ${record.id}; completion notices do not replace collection. ${MONITOR_TAG}`
  );
});

test("removing an observed workspace state directory does not disable later monitor ticks", async (t) => {
  const sandbox = makeSandbox(t);
  seedJob(sandbox, { status: "running", pid: process.pid }, { workspace: "old-workspace" });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox));

  fs.rmSync(path.join(sandbox.stateRoot, "old-workspace"), { recursive: true, force: true });
  const { file, record } = seedJob(sandbox, { status: "running" }, { workspace: "new-workspace" });
  await waitUntil(() => fs.existsSync(file));
  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `codex job ${record.id} done. collect with /codex:result ${record.id}; completion notices do not replace collection. ${MONITOR_TAG}`
  ]);
});

test("a malformed job record does not suppress a healthy job transition", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running" });
  fs.writeFileSync(path.join(path.dirname(file), "malformed.json"), "{ malformed\n", "utf8");
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox));

  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `codex job ${record.id} done. collect with /codex:result ${record.id}; completion notices do not replace collection. ${MONITOR_TAG}`
  ]);
});

test("a stored repository key keeps a removed sibling worktree in monitor scope", async (t) => {
  const sandbox = makeSandbox(t);
  const sibling = createSiblingWorktree(sandbox);
  const repositoryKey = fusionRepositoryKey(sandbox.workDir);
  const { file, record } = seedJob(
    sandbox,
    { background: true, engine: "codex", finishedAt: null, repositoryKey, schemaVersion: 1, status: "running" },
    { workspace: "sibling-workspace", workspaceRoot: sibling }
  );
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox));

  execFileSync("git", ["worktree", "remove", "--force", sibling], { cwd: sandbox.workDir, env: { ...process.env, ...gitIsolation(sandbox.root) } });
  const finishedAt = new Date().toISOString();
  writeJobRecordFile(file, { ...record, status: "done", finishedAt });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `codex job ${record.id} done. collect with /codex:result ${record.id}; completion notices do not replace collection. ${MONITOR_TAG}`
  ]);
  const terminal = await waitUntil(() => {
    try {
      return JSON.parse(fs.readFileSync(announcedPath(sandbox), "utf8")).records.find((entry) => entry.jobId === record.id) ?? null;
    } catch {
      return null;
    }
  });
  assert.strictEqual(terminal.repositoryKey, repositoryKey);
});

function announcedPath(sandbox, sessionId = null, workspaceRoot = sandbox.workDir) {
  const workspaceKey = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  const sessionPart = sessionId ? `.${sessionId}` : "";
  const name = `codex-jobs-monitor-announced${sessionPart}.${workspaceKey}.json`;
  return path.join(sandbox.stateRoot, name);
}

test("restart with persisted dedup state does not re-announce a done job", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running" });
  const env = envFor(sandbox);

  const first = startMonitor(sandbox, env);
  await waitUntil(() => readAnnouncedState(sandbox));
  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });
  await waitUntil(() => (first.lines().length > 0 ? first.lines() : null));
  assert.strictEqual(first.lines().length, 1);
  first.child.kill("SIGTERM");
  await once(first.child, "close");

  assert.ok(fs.existsSync(announcedPath(sandbox)));
  const persisted = JSON.parse(fs.readFileSync(announcedPath(sandbox), "utf8"));
  assert.strictEqual(persisted.schemaVersion, 3);
  assert.strictEqual(persisted.repositoryKey, createHash("sha256").update(sandbox.workDir).digest("hex").slice(0, 16));
  assert.ok(persisted.keys.includes(`${record.id}:done`));
  assert.strictEqual(persisted.records[0].jobId, record.id);
  assert.strictEqual(persisted.records[0].transportStatus, "done");
  const observedAt = persisted.records[0].observedAt;

  const second = startMonitor(sandbox, env);
  t.after(() => second.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox)?.records[0]?.observedAt === observedAt);
  assert.strictEqual(JSON.parse(fs.readFileSync(announcedPath(sandbox), "utf8")).records[0].observedAt, observedAt);

  writeJobRecordFile(file, { ...record, status: "running", finishedAt: null });
  await waitForAnnouncedRecord(sandbox, record.id);
  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });
  await waitForAnnouncedRecord(sandbox, record.id);
  assert.deepStrictEqual(second.lines(), []);
});

test("workspace-scoped dedup lets identical job ids announce independently and prevents cross-workspace pruning", async (t) => {
  const sandbox = makeSandbox(t);
  const otherWorkDir = path.join(sandbox.root, "other-work");
  fs.mkdirSync(otherWorkDir);
  const sharedId = "shared-job-id";
  const firstJob = seedJob(
    sandbox,
    { id: sharedId, status: "running", sessionId: "shared-session" },
    { workspace: "workspace-a", workspaceRoot: sandbox.workDir }
  );
  const secondJob = seedJob(
    sandbox,
    { id: sharedId, status: "running", sessionId: "shared-session" },
    { workspace: "workspace-b", workspaceRoot: otherWorkDir }
  );
  const env = envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "shared-session" });

  const first = startMonitor(sandbox, env);
  await waitUntil(() => readAnnouncedState(sandbox, "shared-session"));
  writeJobRecordFile(firstJob.file, { ...firstJob.record, status: "done", finishedAt: new Date().toISOString() });
  await waitUntil(() => (first.lines().length > 0 ? first.lines() : null));
  first.child.kill("SIGTERM");
  await once(first.child, "close");

  const firstStateFile = announcedPath(sandbox, "shared-session", sandbox.workDir);
  const firstState = fs.readFileSync(firstStateFile, "utf8");
  const second = startMonitor(sandbox, env, { cwd: otherWorkDir });
  t.after(() => second.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox, "shared-session", otherWorkDir));
  writeJobRecordFile(secondJob.file, { ...secondJob.record, status: "done", finishedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (second.lines().length > 0 ? second.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], new RegExp(`codex job ${sharedId} done`));
  assert.notStrictEqual(firstStateFile, announcedPath(sandbox, "shared-session", otherWorkDir));

  fs.rmSync(secondJob.file);
  await waitUntil(() => fs.readFileSync(firstStateFile, "utf8") === firstState);
  assert.strictEqual(fs.readFileSync(firstStateFile, "utf8"), firstState);
});

test("restart catch-up announces an unrecorded terminal job owned by the active session", async (t) => {
  const sandbox = makeSandbox(t);
  const { record } = seedJob(sandbox, {
    status: "done",
    sessionId: "session-own",
    finishedAt: new Date().toISOString()
  });
  fs.writeFileSync(announcedPath(sandbox, "session-own"), "[]\n", "utf8");

  const monitor = startMonitor(sandbox, envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-own" }));
  t.after(() => monitor.child.kill("SIGKILL"));
  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `codex job ${record.id} done. collect with /codex:result ${record.id}; completion notices do not replace collection. ${MONITOR_TAG}`
  ]);
});

test("an unavailable jobs snapshot neither prunes nor persists announcement state", async (t) => {
  const sandbox = makeSandbox(t);
  const { record } = seedJob(sandbox, { status: "running" });
  const stateFile = announcedPath(sandbox);
  fs.writeFileSync(stateFile, `${JSON.stringify([`${record.id}:done`])}\n`, "utf8");
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox)?.schemaVersion === 3);
  const before = fs.readFileSync(stateFile, "utf8");

  const dir = jobsDirFor(sandbox, "ws");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, "not a directory", "utf8");
  await waitUntil(() => !fs.statSync(dir).isDirectory());

  assert.strictEqual(fs.readFileSync(stateFile, "utf8"), before);
  assert.deepStrictEqual(monitor.lines(), []);
});

test("announcement state files older than 30 days are pruned", async (t) => {
  const sandbox = makeSandbox(t);
  seedJob(sandbox, { status: "running" });
  const staleFile = path.join(sandbox.stateRoot, "codex-jobs-monitor-announced.stale-session.stale-workspace.json");
  fs.writeFileSync(staleFile, "[]\n", "utf8");
  const staleTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  fs.utimesSync(staleFile, staleTime, staleTime);

  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => (!fs.existsSync(staleFile) ? true : null));
  assert.strictEqual(fs.existsSync(staleFile), false);
});

test("malformed dedup state is quarantined and dead running jobs are terminalized silently", async (t) => {
  const sandbox = makeSandbox(t);
  const shortLivedChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 0)"]);
  const pid = shortLivedChild.pid;
  const pidIdentity = getProcessIdentity(pid);
  assert.ok(pidIdentity, "Process identity probing is unavailable for the tracked child.");
  await once(shortLivedChild, "exit");
  const { file, record } = seedJob(sandbox, { createdAt: new Date(Date.now() - 1000).toISOString(), status: "running", pid, pidIdentity });
  const stateFile = announcedPath(sandbox);
  fs.writeFileSync(stateFile, "{ malformed", "utf8");

  const monitor = startMonitor(sandbox, envFor(sandbox, { CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS: "0" }));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => {
    if (!fs.existsSync(stateFile)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf8")).keys.includes(`${record.id}:error`) ? true : null;
    } catch {
      return null;
    }
  });
  await waitUntil(() => JSON.parse(fs.readFileSync(file, "utf8")).status === "error");

  assert.deepStrictEqual(monitor.lines(), []);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).status, "error");
  const quarantinePrefix = `${path.basename(stateFile)}.corrupt.`;
  assert.ok(fs.readdirSync(sandbox.stateRoot).some((entry) => entry.startsWith(quarantinePrefix)));
});

test("exits 0 on SIGTERM", async (t) => {
  const sandbox = makeSandbox(t);
  seedJob(sandbox, { status: "running" });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  await waitUntil(() => readAnnouncedState(sandbox));
  monitor.child.kill("SIGTERM");
  const [code] = await once(monitor.child, "close");
  assert.strictEqual(code, 0);
});

test("skips silently when the state root does not exist", async (t) => {
  const sandbox = makeSandbox(t);
  fs.rmSync(sandbox.stateRoot, { recursive: true, force: true });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => monitor.started());
  assert.deepStrictEqual(monitor.lines(), []);
  assert.strictEqual(monitor.stderr(), "");
  assert.strictEqual(fs.existsSync(sandbox.stateRoot), false);
});

function writeFakePs(sandbox, output) {
  const script = path.join(sandbox.root, "fake-ps");
  const defaultArgs = typeof output === "string" ? output : "node codex-companion.mjs task --model gpt-5.4 --effort high do work";
  fs.writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = process.env.FAKE_PS_LOG;
if (log) fs.appendFileSync(log, JSON.stringify(args) + "\\n");
const pidIndex = args.indexOf("-p");
const pid = pidIndex >= 0 ? args[pidIndex + 1] : "";
const barrier = process.env.FAKE_PS_BARRIER;
if (barrier) {
  fs.appendFileSync(barrier, process.pid + "\\n");
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 3000;
  while (fs.readFileSync(barrier, "utf8").split("\\n").filter(Boolean).length < 2) {
    if (Date.now() >= deadline) process.exit(2);
    Atomics.wait(sleeper, 0, 0, 10);
  }
}
const dead = (process.env.FAKE_PS_DEAD_PIDS || "").split(",").filter(Boolean);
if (dead.includes(String(pid))) process.exit(1);
const mode = process.env.FAKE_PS_MODE || "ok";
if (mode === "dead") process.exit(1);
if (mode === "empty") { process.stdout.write(""); process.exit(0); }
if (mode === "unparseable") { process.stdout.write("node /tmp/worker.js --other flag\\n"); process.exit(0); }
process.stdout.write(${JSON.stringify(defaultArgs)} + "\\n");
process.exit(0);
`,
    "utf8"
  );
  fs.chmodSync(script, 0o755);
  return script;
}

function modelAuditPath(sandbox, workspaceRoot = sandbox.workDir) {
  const workspaceKey = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  return path.join(sandbox.fusionData, "observations", workspaceKey, "model-audit.jsonl");
}

function readModelAuditLines(sandbox, workspaceRoot = sandbox.workDir) {
  const file = modelAuditPath(sandbox, workspaceRoot);
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function envForAudit(sandbox, extra = {}) {
  const fakePs = writeFakePs(sandbox);
  return envFor(sandbox, {
    FUSION_DATA_DIR: sandbox.fusionData,
    CODEX_JOBS_MONITOR_PS_COMMAND: fakePs,
    ...extra
  });
}

function rolloutTokenCount(input, cached, output, reasoning, total) {
  return {
    timestamp: "2026-07-14T00:00:02.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
          total_tokens: total
        }
      }
    }
  };
}

function writeRollout(sandbox, threadId, entries, sessionsDir = sandbox.sessionsDir) {
  const dir = path.join(sessionsDir, "2026", "07", "14");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-07-14T00-00-00-${threadId}.jsonl`);
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return file;
}

function taskEvent(type, turnId, timestamp) {
  return { timestamp, type: "event_msg", payload: { type, turn_id: turnId } };
}

function turnContext(turnId, model, effort) {
  return { timestamp: "2026-07-14T00:00:01.000Z", type: "turn_context", payload: { turn_id: turnId, model, effort } };
}

test("argv capture writes exactly one model-audit observation for a running job", async (t) => {
  const sandbox = makeSandbox(t);
  const { record } = seedJob(sandbox, { status: "running", pid: process.pid });
  const monitor = startMonitor(sandbox, envForAudit(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));

  const lines = await waitUntil(() => {
    const observations = readModelAuditLines(sandbox);
    return observations.length > 0 ? observations : null;
  });

  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].jobId, record.id);
  assert.strictEqual(lines[0].engine, "codex");
  assert.strictEqual(lines[0].model, "gpt-5.4");
  assert.strictEqual(lines[0].effort, "high");
  assert.strictEqual(lines[0].source, "argv");
  assert.ok(typeof lines[0].observedAt === "string" && lines[0].observedAt.length > 0);
  assert.ok(!modelAuditPath(sandbox).includes("codex-openai-codex"));
  assert.ok(modelAuditPath(sandbox).startsWith(sandbox.fusionData));
});

test("a second poll does not duplicate a model-audit observation", async (t) => {
  const sandbox = makeSandbox(t);
  seedJob(sandbox, { status: "running", pid: process.pid });
  const monitor = startMonitor(sandbox, envForAudit(sandbox, { CODEX_JOBS_MONITOR_INTERVAL_MS: "150" }));
  t.after(() => monitor.child.kill("SIGKILL"));

  await waitUntil(() => (readModelAuditLines(sandbox).length > 0 ? true : null));
  await waitUntil(() => readModelAuditLines(sandbox).length === 1);
  assert.strictEqual(readModelAuditLines(sandbox).length, 1);
});

test("concurrent monitor processes append one model-audit observation per job", async (t) => {
  const sandbox = makeSandbox(t);
  const barrier = path.join(sandbox.root, "fake-ps-barrier");
  seedJob(sandbox, { status: "running", pid: process.pid });
  const env = envForAudit(sandbox, { FAKE_PS_BARRIER: barrier, CODEX_JOBS_MONITOR_INTERVAL_MS: "150" });
  const first = startMonitor(sandbox, { ...env, CLAUDE_CODE_SESSION_ID: "session-a" });
  const second = startMonitor(sandbox, { ...env, CLAUDE_CODE_SESSION_ID: "session-b" });
  t.after(() => first.child.kill("SIGKILL"));
  t.after(() => second.child.kill("SIGKILL"));

  await waitUntil(() => (readModelAuditLines(sandbox).length > 0 ? true : null));
  await waitUntil(() => readModelAuditLines(sandbox).length === 1);

  assert.strictEqual(readModelAuditLines(sandbox).length, 1);
  assert.strictEqual(first.stderr(), "");
  assert.strictEqual(second.stderr(), "");
});

test("a job whose record already carries request.model is not probed", async (t) => {
  const sandbox = makeSandbox(t);
  const fakePsLog = path.join(sandbox.root, "fake-ps.log");
  seedJob(sandbox, {
    status: "running",
    pid: process.pid,
    request: { model: "already-set", effort: "medium" }
  });
  const monitor = startMonitor(
    sandbox,
    envForAudit(sandbox, {
      FAKE_PS_LOG: fakePsLog,
      CODEX_JOBS_MONITOR_INTERVAL_MS: "150"
    })
  );
  t.after(() => monitor.child.kill("SIGKILL"));

  await waitUntil(() => readAnnouncedState(sandbox));
  assert.deepStrictEqual(readModelAuditLines(sandbox), []);
  assert.strictEqual(fs.existsSync(fakePsLog), false);
});

test("dead pid and unparseable argv are skipped without error for model audit", async (t) => {
  const sandbox = makeSandbox(t);
  const shortLivedChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 0)"]);
  const deadPid = shortLivedChild.pid;
  const deadPidIdentity = getProcessIdentity(deadPid);
  assert.ok(deadPidIdentity, "Process identity probing is unavailable for the tracked child.");
  await once(shortLivedChild, "exit");

  seedJob(sandbox, { id: "dead-job", status: "running", pid: deadPid, pidIdentity: deadPidIdentity });
  seedJob(sandbox, { id: "bad-argv-job", status: "running", pid: process.pid });

  const monitor = startMonitor(
    sandbox,
    envForAudit(sandbox, {
      FAKE_PS_MODE: "unparseable",
      FAKE_PS_DEAD_PIDS: String(deadPid),
      CODEX_JOBS_MONITOR_INTERVAL_MS: "150"
    })
  );
  t.after(() => monitor.child.kill("SIGKILL"));

  await waitUntil(() => readAnnouncedState(sandbox));
  assert.deepStrictEqual(readModelAuditLines(sandbox), []);
  assert.strictEqual(monitor.stderr(), "");
  assert.strictEqual(monitor.child.exitCode, null);
});

test("rollout inspection recovers exact turn model and first-turn token usage", (t) => {
  const sandbox = makeSandbox(t);
  const threadId = "thread-first";
  const turnId = "turn-first";
  writeRollout(sandbox, threadId, [
    taskEvent("task_started", turnId, "2026-07-14T00:00:00.000Z"),
    turnContext(turnId, "actual-model", "xhigh"),
    rolloutTokenCount(120, 70, 30, 11, 150),
    taskEvent("task_complete", turnId, "2026-07-14T00:00:03.000Z")
  ]);

  const inspected = inspectCodexRollout({ turnId, result: { threadId } }, envFor(sandbox));
  assert.strictEqual(inspected.availability, "available");
  assert.strictEqual(inspected.model, "actual-model");
  assert.strictEqual(inspected.effort, "xhigh");
  assert.deepStrictEqual(inspected.tokenUsage, { inputTokens: 120, cachedInputTokens: 70, outputTokens: 30, reasoningOutputTokens: 11, totalTokens: 150 });
});

test("rollout inspection uses CODEX_HOME sessions when no monitor override is set", (t) => {
  const sandbox = makeSandbox(t);
  const codexHome = path.join(sandbox.root, "codex-home");
  const sessionsDir = path.join(codexHome, "sessions");
  const threadId = "thread-codex-home";
  const turnId = "turn-codex-home";
  writeRollout(sandbox, threadId, [
    taskEvent("task_started", turnId, "2026-07-14T00:00:00.000Z"),
    turnContext(turnId, "home-model", "high"),
    rolloutTokenCount(80, 30, 20, 5, 100),
    taskEvent("task_complete", turnId, "2026-07-14T00:00:03.000Z")
  ], sessionsDir);

  const inspected = inspectCodexRollout(
    { turnId, result: { threadId } },
    envFor(sandbox, { CODEX_HOME: codexHome, CODEX_JOBS_MONITOR_SESSIONS_DIR: "" })
  );
  assert.strictEqual(inspected.availability, "available");
  assert.strictEqual(inspected.model, "home-model");
  assert.strictEqual(inspected.effort, "high");
  assert.deepStrictEqual(inspected.tokenUsage, { inputTokens: 80, cachedInputTokens: 30, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 100 });
});

test("rollout inspection computes a resumed turn delta from the previous cumulative count", (t) => {
  const sandbox = makeSandbox(t);
  const threadId = "thread-resume";
  const previousTurn = "turn-previous";
  const targetTurn = "turn-target";
  writeRollout(sandbox, threadId, [
    taskEvent("task_started", previousTurn, "2026-07-14T00:00:00.000Z"),
    rolloutTokenCount(100, 60, 20, 8, 120),
    taskEvent("task_complete", previousTurn, "2026-07-14T00:00:01.000Z"),
    taskEvent("task_started", targetTurn, "2026-07-14T00:01:00.000Z"),
    turnContext(targetTurn, "resume-model", "high"),
    rolloutTokenCount(175, 105, 45, 19, 220),
    taskEvent("task_complete", targetTurn, "2026-07-14T00:01:03.000Z")
  ]);

  const inspected = inspectCodexRollout({ turnId: targetTurn, result: { threadId } }, envFor(sandbox));
  assert.strictEqual(inspected.availability, "available");
  assert.deepStrictEqual(inspected.tokenUsage, { inputTokens: 75, cachedInputTokens: 45, outputTokens: 25, reasoningOutputTokens: 11, totalTokens: 100 });
});

test("rollout inspection refuses to treat a cumulative resume total as per-job usage without a baseline", (t) => {
  const sandbox = makeSandbox(t);
  const threadId = "thread-missing-baseline";
  const previousTurn = "turn-previous";
  const targetTurn = "turn-target";
  writeRollout(sandbox, threadId, [
    taskEvent("task_started", previousTurn, "2026-07-14T00:00:00.000Z"),
    taskEvent("task_complete", previousTurn, "2026-07-14T00:00:01.000Z"),
    taskEvent("task_started", targetTurn, "2026-07-14T00:01:00.000Z"),
    rolloutTokenCount(175, 105, 45, 19, 220),
    taskEvent("task_complete", targetTurn, "2026-07-14T00:01:03.000Z")
  ]);

  const inspected = inspectCodexRollout({ turnId: targetTurn, result: { threadId } }, envFor(sandbox));
  assert.strictEqual(inspected.availability, "unavailable");
  assert.strictEqual(inspected.reason, "resume_baseline_not_found");
  assert.strictEqual(inspected.tokenUsage, null);
});

test("canonical terminal records use direct model and token evidence without rollout inspection", async (t) => {
  const sandbox = makeSandbox(t);
  const threadId = "thread-direct";
  const turnId = "turn-direct";
  writeRollout(sandbox, threadId, [
    taskEvent("task_started", turnId, "2026-07-14T00:00:00.000Z"),
    turnContext(turnId, "wrong-rollout-model", "low"),
    rolloutTokenCount(900, 400, 200, 60, 1100),
    taskEvent("task_complete", turnId, "2026-07-14T00:00:03.000Z")
  ]);
  const usage = { inputTokens: 90, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 6, totalTokens: 110 };
  const { file, record } = seedJob(sandbox, {
    background: true,
    status: "running",
    threadId,
    turnId,
    timeoutMs: 60000,
    failureKind: "timeout",
    request: { model: "requested-model", effort: "low" },
    resolvedModel: "actual-model",
    resolvedEffort: "xhigh"
  });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox));
  const finishedAt = new Date().toISOString();
  writeJobRecordFile(file, {
    ...record,
    status: "done",
    finishedAt,
    tokenUsage: usage,
    cumulativeTokenUsage: usage,
    tokenUsageAvailability: "available"
  });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `codex job ${record.id} done. collect with /codex:result ${record.id}; completion notices do not replace collection. ${MONITOR_TAG}`
  ]);
  const terminal = await waitUntil(() => {
    try {
      return JSON.parse(fs.readFileSync(announcedPath(sandbox), "utf8")).records.find((entry) => entry.jobId === record.id) ?? null;
    } catch {
      return null;
    }
  });
  assert.strictEqual(terminal.transportStatus, "done");
  assert.strictEqual(terminal.finishedAt, finishedAt);
  assert.strictEqual(terminal.timeoutMs, 60000);
  assert.strictEqual(terminal.failureKind, "timeout");
  assert.strictEqual(terminal.model, "actual-model");
  assert.strictEqual(terminal.modelSource, "job-record");
  assert.strictEqual(terminal.effort, "xhigh");
  assert.strictEqual(terminal.effortSource, "job-record");
  assert.deepStrictEqual(terminal.tokenUsage, usage);
  const modelAudit = readModelAuditLines(sandbox);
  assert.strictEqual(modelAudit.length, 1);
  assert.strictEqual(modelAudit[0].jobId, record.id);
  assert.strictEqual(modelAudit[0].model, "actual-model");
  assert.strictEqual(modelAudit[0].effort, "xhigh");
  assert.strictEqual(modelAudit[0].source, "job-record");
  await waitUntil(() => readModelAuditLines(sandbox).length === 1);
  assert.strictEqual(readModelAuditLines(sandbox).length, 1);

  const tokenPath = path.join(sandbox.fusionData, "observations", createHash("sha256").update(sandbox.workDir).digest("hex").slice(0, 16), "token-usage.jsonl");
  const tokenAudit = fs.readFileSync(tokenPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.strictEqual(tokenAudit.at(-1).source, "job-record");
  assert.deepStrictEqual(tokenAudit.at(-1).tokenUsage, usage);
});

test("canonical foreground jobs are retained for stats without emitting completion notices", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, {
    schemaVersion: 1,
    engine: "codex",
    background: false,
    status: "running",
    finishedAt: null
  });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => readAnnouncedState(sandbox));
  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });

  await waitUntil(() => {
    try {
      return JSON.parse(fs.readFileSync(announcedPath(sandbox), "utf8")).records.some((entry) => entry.jobId === record.id);
    } catch {
      return false;
    }
  });
  await waitForAnnouncedRecord(sandbox, record.id);
  assert.deepStrictEqual(monitor.lines(), []);
});

const REPAIR_UNAVAILABLE_LINE =
  `codex jobs monitor: companion repair unavailable; running in announce-only mode ${MONITOR_TAG}`;

function installCacheShapedMonitor(sandbox, { version = "0.0.28", includeCodex = true } = {}) {
  const cacheRoot = path.join(sandbox.root, "cache", "claude-code-fusion");
  const fusionScriptsSrc = path.join(repoRoot, "plugins", "fusion", "scripts");
  const fusionScriptsDst = path.join(cacheRoot, "fusion", version, "scripts");
  fs.cpSync(fusionScriptsSrc, fusionScriptsDst, { recursive: true });
  if (includeCodex) {
    const codexScriptsSrc = path.join(repoRoot, "plugins", "codex", "scripts");
    const codexScriptsDst = path.join(cacheRoot, "codex", version, "scripts");
    fs.cpSync(codexScriptsSrc, codexScriptsDst, { recursive: true });
  }
  return path.join(fusionScriptsDst, "codex-jobs-monitor.mjs");
}

async function assertMonitorStaysAlive(monitor, { windowMs = 400 } = {}) {
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  assert.strictEqual(monitor.child.exitCode, null, `monitor exited early: ${monitor.stderr() || monitor.lines().join("\n")}`);
  assert.strictEqual(monitor.child.signalCode, null);
}

test("installed cache layout resolves companion repair and stays alive", async (t) => {
  const sandbox = makeSandbox(t);
  const script = installCacheShapedMonitor(sandbox, { version: "0.0.28", includeCodex: true });
  seedJob(sandbox, { status: "running" });
  const monitor = startMonitor(sandbox, envFor(sandbox), { script });
  t.after(() => monitor.child.kill("SIGKILL"));

  await waitUntil(() => (monitor.started() ? true : null));
  await assertMonitorStaysAlive(monitor);
  assert.ok(
    !monitor.lines().includes(REPAIR_UNAVAILABLE_LINE),
    `expected repair to resolve; lines=${JSON.stringify(monitor.lines())} stderr=${monitor.stderr()}`
  );
});

test("installed cache layout without codex companion starts in announce-only mode", async (t) => {
  const sandbox = makeSandbox(t);
  const script = installCacheShapedMonitor(sandbox, { version: "0.0.28", includeCodex: false });
  seedJob(sandbox, { status: "running" });
  const monitor = startMonitor(sandbox, envFor(sandbox), { script });
  t.after(() => monitor.child.kill("SIGKILL"));

  await waitUntil(() => (monitor.lines().includes(REPAIR_UNAVAILABLE_LINE) ? true : null));
  await assertMonitorStaysAlive(monitor);
  assert.strictEqual(monitor.child.exitCode, null);
  assert.ok(monitor.lines().includes(REPAIR_UNAVAILABLE_LINE));
});
