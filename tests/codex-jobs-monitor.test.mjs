import assert from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const monitorScript = path.join(repoRoot, "plugins", "fusion", "scripts", "codex-jobs-monitor.mjs");

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-monitor-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const workDir = path.join(root, "work");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  return { root, stateRoot, workDir };
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
    `codex job ${record.id} completed. collect with /codex:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`
  );

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(monitor.lines().length, 1);
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
    `codex job ${record.id} failed (worker process exited with status 1). collect with /codex:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`
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
    `codex job ${record.id} failed. collect with /codex:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`
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
    `codex job ${record.id} cancelled (${"x".repeat(80)}...). collect with /codex:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`
  );
});

test("with a monitor session id set, a matching job emits and a mismatching job stays silent", async (t) => {
  const sandbox = makeSandbox(t);
  const { file: ownFile, record: ownRecord } = seedJob(sandbox, { status: "running", sessionId: "session-own" });
  const { file: otherFile, record: otherRecord } = seedJob(sandbox, {
    status: "running",
    sessionId: "session-other",
  });
  const monitor = startMonitor(sandbox, envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-own" }));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(ownFile, { ...ownRecord, status: "completed", completedAt: new Date().toISOString() });
  writeJobRecordFile(otherFile, { ...otherRecord, status: "completed", completedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `codex job ${ownRecord.id} completed. collect with /codex:result ${ownRecord.id} only if you launched it detached; a job owned by a subagent reports on its own`
  );

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(monitor.lines().length, 1);
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
    `codex job ${record.id} completed. collect with /codex:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`
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
    `codex job ${record.id} completed. collect with /codex:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`
  );
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
    `codex job ${record.id} completed. collect with /codex:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`
  );
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
});
