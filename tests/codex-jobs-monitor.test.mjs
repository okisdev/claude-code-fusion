import assert from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { inspectCodexRollout } from "../plugins/fusion/scripts/codex-jobs-monitor.mjs";
import { fusionRepositoryKey } from "../plugins/fusion/scripts/fusion-stats.mjs";

const repoRoot = path.join(import.meta.dirname, "..");
const monitorScript = path.join(repoRoot, "plugins", "fusion", "scripts", "codex-jobs-monitor.mjs");

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-monitor-test-")));
  const stateRoot = path.join(root, "state");
  const workDir = path.join(root, "work");
  const fusionData = path.join(root, "fusion-data");
  const sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(fusionData, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sandbox = { root, stateRoot, workDir, fusionData, sessionsDir, children: new Set() };
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
  return {
    ...env,
    FUSION_CODEX_STATE: sandbox.stateRoot,
    FUSION_DATA_DIR: sandbox.fusionData,
    CODEX_JOBS_MONITOR_SESSIONS_DIR: sandbox.sessionsDir,
    CODEX_JOBS_MONITOR_INTERVAL_MS: "200",
    ...extra,
  };
}

function startMonitor(sandbox, env, { cwd = sandbox.workDir } = {}) {
  const child = spawn(process.execPath, [monitorScript], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
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
    lines: () => stdout.split("\n").filter(Boolean),
    stderr: () => stderr,
  };
}

function createSiblingWorktree(sandbox) {
  const sibling = path.join(sandbox.root, "sibling-worktree");
  execFileSync("git", ["init", "-q"], { cwd: sandbox.workDir });
  execFileSync("git", ["worktree", "add", "--orphan", sibling], { cwd: sandbox.workDir });
  return sibling;
}

async function waitUntil(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test("a pre-existing terminal job emits nothing on startup", async (t) => {
  const sandbox = makeSandbox(t);
  seedJob(sandbox, { status: "completed" });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepStrictEqual(monitor.lines(), []);
});

test("a job transitioning to completed emits exactly one correctly shaped line", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running" });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepStrictEqual(monitor.lines(), []);

  writeJobRecordFile(file, { ...record, status: "completed", completedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `codex job ${record.id} completed. collect with /codex:result ${record.id}; completion notices do not replace collection.`
  );

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(monitor.lines().length, 1);
});

test("monitors jobs from a sibling worktree in the same Git repository", async (t) => {
  const sandbox = makeSandbox(t);
  const sibling = createSiblingWorktree(sandbox);
  const { file, record } = seedJob(sandbox, { status: "running" }, { workspaceRoot: sibling });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, { ...record, status: "completed", completedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], new RegExp(`^codex job ${record.id} completed\\.`));
});

test("a job transitioning to failed reports a truncated error message when present", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running" });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, {
    ...record,
    status: "failed",
    completedAt: new Date().toISOString(),
    pid: null,
    errorMessage: "worker process exited with status 1\nfull stack trace follows",
  });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `codex job ${record.id} failed (worker process exited with status 1). collect with /codex:result ${record.id}; completion notices do not replace collection.`
  );
});

test("a job transitioning to failed with no error message emits no suffix", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running" });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, { ...record, status: "failed", completedAt: new Date().toISOString(), pid: null });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `codex job ${record.id} failed. collect with /codex:result ${record.id}; completion notices do not replace collection.`
  );
});

test("a long error message is truncated to a sane length", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running" });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  const longMessage = "x".repeat(200);
  writeJobRecordFile(file, {
    ...record,
    status: "cancelled",
    completedAt: new Date().toISOString(),
    pid: null,
    errorMessage: longMessage,
  });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `codex job ${record.id} cancelled (${"x".repeat(80)}...). collect with /codex:result ${record.id}; completion notices do not replace collection.`
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
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(ownFile, { ...ownRecord, status: "completed", completedAt: new Date().toISOString() });
  writeJobRecordFile(otherFile, { ...otherRecord, status: "completed", completedAt: new Date().toISOString() });
  writeJobRecordFile(orphanFile, { ...orphanRecord, status: "completed", completedAt: new Date().toISOString() });

  await waitUntil(() => (ownMonitor.lines().length === 2 && otherMonitor.lines().length === 2 ? true : null));
  assert.deepStrictEqual(ownMonitor.lines().sort(), [
    `codex job ${orphanRecord.id} completed. collect with /codex:result ${orphanRecord.id}; completion notices do not replace collection.`,
    `codex job ${ownRecord.id} completed. collect with /codex:result ${ownRecord.id}; completion notices do not replace collection.`
  ].sort());
  assert.deepStrictEqual(otherMonitor.lines().sort(), [
    `codex job ${orphanRecord.id} completed. collect with /codex:result ${orphanRecord.id}; completion notices do not replace collection.`,
    `codex job ${otherRecord.id} completed. collect with /codex:result ${otherRecord.id}; completion notices do not replace collection.`
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
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, { ...record, status: "completed", completedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `codex job ${record.id} completed. collect with /codex:result ${record.id}; completion notices do not replace collection.`
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
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, { ...record, status: "completed", completedAt: new Date().toISOString() });

  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepStrictEqual(monitor.lines(), []);
});

test("a monitor started from a subdirectory still matches jobs recorded against the repo root", async (t) => {
  const sandbox = makeSandbox(t);
  execFileSync("git", ["init", "--quiet"], { cwd: sandbox.workDir });
  const subDir = path.join(sandbox.workDir, "nested", "deeper");
  fs.mkdirSync(subDir, { recursive: true });

  const { file, record } = seedJob(sandbox, { status: "running" }, { workspaceRoot: sandbox.workDir });
  const monitor = startMonitor(sandbox, envFor(sandbox), { cwd: subDir });
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, { ...record, status: "completed", completedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `codex job ${record.id} completed. collect with /codex:result ${record.id}; completion notices do not replace collection.`
  );
});

test("a monitor includes jobs recorded in a worktree beneath the repo root", async (t) => {
  const sandbox = makeSandbox(t);
  const worktreeRoot = path.join(sandbox.workDir, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const { file, record } = seedJob(sandbox, { status: "running" }, { workspace: "worktree-ws", workspaceRoot: worktreeRoot });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, { ...record, status: "completed", completedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `codex job ${record.id} completed. collect with /codex:result ${record.id}; completion notices do not replace collection.`
  ]);
});

test("a running job whose pid has vanished is reported as dead exactly once", async (t) => {
  const sandbox = makeSandbox(t);
  const shortLivedChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 0)"]);
  const pid = shortLivedChild.pid;
  await once(shortLivedChild, "exit");

  seedJob(sandbox, { status: "running", pid });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /appears dead \(process gone, status still running\)/);

  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.strictEqual(monitor.lines().length, 1);
});

test("a canonical running job whose owner exits is reported without mutating its record", async (t) => {
  const sandbox = makeSandbox(t);
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  t.after(() => worker.kill("SIGKILL"));
  const { file, record } = seedJob(sandbox, {
    schemaVersion: 1,
    engine: "codex",
    status: "running",
    phase: "executing",
    pid: worker.pid,
    codexPid: null,
    finishedAt: null
  });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  worker.kill("SIGKILL");
  await once(worker, "close");

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [`codex job ${record.id} appears dead (process gone, status still running)`]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), record);
});

test("a terminal worktree copy suppresses a dead alarm for its stale running mirror", async (t) => {
  const sandbox = makeSandbox(t);
  const worktreeRoot = path.join(sandbox.workDir, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const shortLivedChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 0)"]);
  const pid = shortLivedChild.pid;
  await once(shortLivedChild, "exit");
  const id = "mirrored-job";
  seedJob(sandbox, { id, status: "running", pid }, { workspace: "parent-ws", workspaceRoot: sandbox.workDir });
  seedJob(
    sandbox,
    { id, status: "completed", completedAt: new Date().toISOString(), pid: null },
    { workspace: "worktree-ws", workspaceRoot: worktreeRoot }
  );

  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.deepStrictEqual(monitor.lines(), []);
});

test("a running job with a live pid is not reported as dead", async (t) => {
  const sandbox = makeSandbox(t);
  seedJob(sandbox, { status: "running", pid: process.pid });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));

  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepStrictEqual(monitor.lines(), []);
});

test("a vanished state root mid run does not crash the process and a later tick still emits", async (t) => {
  const sandbox = makeSandbox(t);
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  fs.rmSync(sandbox.stateRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(sandbox.stateRoot), { recursive: true });
  fs.writeFileSync(sandbox.stateRoot, "not a directory");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.strictEqual(monitor.child.exitCode, null);
  assert.deepStrictEqual(monitor.lines(), []);

  fs.rmSync(sandbox.stateRoot, { force: true });
  const { file, record } = seedJob(sandbox, { status: "running" });
  writeJobRecordFile(file, { ...record, status: "completed", completedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `codex job ${record.id} completed. collect with /codex:result ${record.id}; completion notices do not replace collection.`
  );
});

test("removing an observed workspace state directory does not disable later monitor ticks", async (t) => {
  const sandbox = makeSandbox(t);
  seedJob(sandbox, { status: "running", pid: process.pid }, { workspace: "old-workspace" });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  fs.rmSync(path.join(sandbox.stateRoot, "old-workspace"), { recursive: true, force: true });
  const { file, record } = seedJob(sandbox, { status: "running" }, { workspace: "new-workspace" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeJobRecordFile(file, { ...record, status: "completed", completedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `codex job ${record.id} completed. collect with /codex:result ${record.id}; completion notices do not replace collection.`
  ]);
});

test("a malformed job record does not suppress a healthy job transition", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running" });
  fs.writeFileSync(path.join(path.dirname(file), "malformed.json"), "{ malformed\n", "utf8");
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, { ...record, status: "completed", completedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `codex job ${record.id} completed. collect with /codex:result ${record.id}; completion notices do not replace collection.`
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
  await new Promise((resolve) => setTimeout(resolve, 300));

  execFileSync("git", ["worktree", "remove", "--force", sibling], { cwd: sandbox.workDir });
  const finishedAt = new Date().toISOString();
  writeJobRecordFile(file, { ...record, status: "done", finishedAt });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `codex job ${record.id} done. collect with /codex:result ${record.id}; completion notices do not replace collection.`
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

test("restart with persisted dedup state does not re-announce a completed job", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running" });
  const env = envFor(sandbox);

  const first = startMonitor(sandbox, env);
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeJobRecordFile(file, { ...record, status: "completed", completedAt: new Date().toISOString() });
  await waitUntil(() => (first.lines().length > 0 ? first.lines() : null));
  assert.strictEqual(first.lines().length, 1);
  first.child.kill("SIGTERM");
  await once(first.child, "close");

  assert.ok(fs.existsSync(announcedPath(sandbox)));
  const persisted = JSON.parse(fs.readFileSync(announcedPath(sandbox), "utf8"));
  assert.strictEqual(persisted.schemaVersion, 3);
  assert.strictEqual(persisted.repositoryKey, createHash("sha256").update(sandbox.workDir).digest("hex").slice(0, 16));
  assert.ok(persisted.keys.includes(`${record.id}:completed`));
  assert.strictEqual(persisted.records[0].jobId, record.id);
  assert.strictEqual(persisted.records[0].transportStatus, "completed");
  const observedAt = persisted.records[0].observedAt;

  const second = startMonitor(sandbox, env);
  t.after(() => second.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.strictEqual(JSON.parse(fs.readFileSync(announcedPath(sandbox), "utf8")).records[0].observedAt, observedAt);

  writeJobRecordFile(file, { ...record, status: "running", completedAt: null });
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeJobRecordFile(file, { ...record, status: "completed", completedAt: new Date().toISOString() });
  await new Promise((resolve) => setTimeout(resolve, 600));
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
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeJobRecordFile(firstJob.file, { ...firstJob.record, status: "completed", completedAt: new Date().toISOString() });
  await waitUntil(() => (first.lines().length > 0 ? first.lines() : null));
  first.child.kill("SIGTERM");
  await once(first.child, "close");

  const firstStateFile = announcedPath(sandbox, "shared-session", sandbox.workDir);
  const firstState = fs.readFileSync(firstStateFile, "utf8");
  const second = startMonitor(sandbox, env, { cwd: otherWorkDir });
  t.after(() => second.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeJobRecordFile(secondJob.file, { ...secondJob.record, status: "completed", completedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (second.lines().length > 0 ? second.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], new RegExp(`codex job ${sharedId} completed`));
  assert.notStrictEqual(firstStateFile, announcedPath(sandbox, "shared-session", otherWorkDir));

  fs.rmSync(secondJob.file);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.strictEqual(fs.readFileSync(firstStateFile, "utf8"), firstState);
});

test("restart catch-up announces an unrecorded terminal job owned by the active session", async (t) => {
  const sandbox = makeSandbox(t);
  const { record } = seedJob(sandbox, {
    status: "completed",
    sessionId: "session-own",
    completedAt: new Date().toISOString()
  });
  fs.writeFileSync(announcedPath(sandbox, "session-own"), "[]\n", "utf8");

  const monitor = startMonitor(sandbox, envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-own" }));
  t.after(() => monitor.child.kill("SIGKILL"));
  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `codex job ${record.id} completed. collect with /codex:result ${record.id}; completion notices do not replace collection.`
  ]);
});

test("an unavailable jobs snapshot neither prunes nor persists announcement state", async (t) => {
  const sandbox = makeSandbox(t);
  const { record } = seedJob(sandbox, { status: "running" });
  const stateFile = announcedPath(sandbox);
  fs.writeFileSync(stateFile, `${JSON.stringify([`${record.id}:completed`])}\n`, "utf8");
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const before = fs.readFileSync(stateFile, "utf8");

  const dir = jobsDirFor(sandbox, "ws");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, "not a directory", "utf8");
  await new Promise((resolve) => setTimeout(resolve, 500));

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

test("malformed dedup state is quarantined and dead running jobs are reconstructed silently", async (t) => {
  const sandbox = makeSandbox(t);
  const shortLivedChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 0)"]);
  const pid = shortLivedChild.pid;
  await once(shortLivedChild, "exit");
  const { record } = seedJob(sandbox, { status: "running", pid });
  const stateFile = announcedPath(sandbox);
  fs.writeFileSync(stateFile, "{ malformed", "utf8");

  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => {
    if (!fs.existsSync(stateFile)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf8")).keys.includes(`${record.id}:dead`) ? true : null;
    } catch {
      return null;
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.deepStrictEqual(monitor.lines(), []);
  const quarantinePrefix = `${path.basename(stateFile)}.corrupt.`;
  assert.ok(fs.readdirSync(sandbox.stateRoot).some((entry) => entry.startsWith(quarantinePrefix)));
});

test("exits 0 on SIGTERM", async (t) => {
  const sandbox = makeSandbox(t);
  const monitor = startMonitor(sandbox, envFor(sandbox));
  await new Promise((resolve) => setTimeout(resolve, 200));
  monitor.child.kill("SIGTERM");
  const [code] = await once(monitor.child, "close");
  assert.strictEqual(code, 0);
});

test("skips silently when the state root does not exist", async (t) => {
  const sandbox = makeSandbox(t);
  fs.rmSync(sandbox.stateRoot, { recursive: true, force: true });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 500));
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
  await new Promise((resolve) => setTimeout(resolve, 500));
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
  await new Promise((resolve) => setTimeout(resolve, 500));

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

  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepStrictEqual(readModelAuditLines(sandbox), []);
  assert.strictEqual(fs.existsSync(fakePsLog), false);
});

test("dead pid and unparseable argv are skipped without error for model audit", async (t) => {
  const sandbox = makeSandbox(t);
  const shortLivedChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 0)"]);
  const deadPid = shortLivedChild.pid;
  await once(shortLivedChild, "exit");

  seedJob(sandbox, { id: "dead-job", status: "running", pid: deadPid });
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

  await new Promise((resolve) => setTimeout(resolve, 500));
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
    request: { model: "requested-model", effort: "low" },
    resolvedModel: "actual-model",
    resolvedEffort: "xhigh"
  });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));
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
    `codex job ${record.id} done. collect with /codex:result ${record.id}; completion notices do not replace collection.`
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
  await new Promise((resolve) => setTimeout(resolve, 500));
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
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });

  await waitUntil(() => {
    try {
      return JSON.parse(fs.readFileSync(announcedPath(sandbox), "utf8")).records.some((entry) => entry.jobId === record.id);
    } catch {
      return false;
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepStrictEqual(monitor.lines(), []);
});

test("legacy terminal transition persists a structured ledger and exact rollout sidecars", async (t) => {
  const sandbox = makeSandbox(t);
  const threadId = "thread-monitor";
  const turnId = "turn-monitor";
  writeRollout(sandbox, threadId, [
    taskEvent("task_started", turnId, "2026-07-14T00:00:00.000Z"),
    turnContext(turnId, "actual-model", "xhigh"),
    rolloutTokenCount(90, 40, 20, 6, 110),
    taskEvent("task_complete", turnId, "2026-07-14T00:00:03.000Z")
  ]);
  const { file, record } = seedJob(sandbox, {
    status: "running",
    turnId,
    result: { threadId },
    request: { model: "requested-model", effort: "low" }
  });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeJobRecordFile(file, { ...record, status: "completed", completedAt: new Date().toISOString() });
  await waitUntil(() => (monitor.lines().length > 0 ? true : null));

  const { state, terminal } = await waitUntil(() => {
    try {
      const state = JSON.parse(fs.readFileSync(announcedPath(sandbox), "utf8"));
      const terminal = state.records.find((entry) => entry.jobId === record.id);
      return terminal ? { state, terminal } : null;
    } catch {
      return null;
    }
  });
  assert.strictEqual(state.schemaVersion, 3);
  assert.strictEqual(terminal.repositoryKey, state.repositoryKey);
  assert.strictEqual(terminal.transportStatus, "completed");
  assert.strictEqual(terminal.model, "actual-model");
  assert.strictEqual(terminal.modelSource, "rollout-turn-context");
  assert.strictEqual(terminal.effort, "xhigh");
  assert.strictEqual(terminal.effortSource, "rollout-turn-context");
  assert.deepStrictEqual(terminal.tokenUsage, { inputTokens: 90, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 6, totalTokens: 110 });

  const modelAudit = readModelAuditLines(sandbox);
  assert.strictEqual(modelAudit.at(-1).source, "rollout-turn-context");
  assert.strictEqual(modelAudit.at(-1).model, "actual-model");
  assert.strictEqual(modelAudit.at(-1).workspaceRoot, sandbox.workDir);
  assert.strictEqual(modelAudit.at(-1).repositoryKey, state.repositoryKey);
  const tokenPath = path.join(sandbox.fusionData, "observations", createHash("sha256").update(sandbox.workDir).digest("hex").slice(0, 16), "token-usage.jsonl");
  const tokenAudit = fs.readFileSync(tokenPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.strictEqual(tokenAudit.at(-1).availability, "available");
  assert.strictEqual(tokenAudit.at(-1).source, "rollout-turn-delta");
  assert.strictEqual(tokenAudit.at(-1).workspaceRoot, sandbox.workDir);
  assert.strictEqual(tokenAudit.at(-1).repositoryKey, state.repositoryKey);

  fs.rmSync(file);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const retained = JSON.parse(fs.readFileSync(announcedPath(sandbox), "utf8"));
  assert.ok(retained.records.some((entry) => entry.jobId === record.id));
});

test("legacy announcement arrays migrate to the structured terminal ledger", async (t) => {
  const sandbox = makeSandbox(t);
  const file = announcedPath(sandbox);
  fs.writeFileSync(file, `${JSON.stringify(["legacy-completed:completed", "legacy-dead:dead"])}\n`);
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));

  const migrated = await waitUntil(() => {
    try {
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      return state?.schemaVersion === 3 ? state : null;
    } catch {
      return null;
    }
  });
  assert.ok(migrated.keys.includes("legacy-completed:completed"));
  assert.ok(migrated.records.some((entry) => entry.jobId === "legacy-completed" && entry.tokenUsageAvailability === "unavailable"));
  assert.strictEqual(migrated.records.some((entry) => entry.jobId === "legacy-dead"), false);
});
