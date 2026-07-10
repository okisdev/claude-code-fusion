import assert from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
  assert.ok(persisted.includes(`${record.id}:completed`));

  writeJobRecordFile(file, { ...record, status: "running", completedAt: null });
  const second = startMonitor(sandbox, env);
  t.after(() => second.child.kill("SIGKILL"));
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
    `codex job ${record.id} completed. collect with /codex:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`
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
      return JSON.parse(fs.readFileSync(stateFile, "utf8")).includes(`${record.id}:dead`) ? true : null;
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
