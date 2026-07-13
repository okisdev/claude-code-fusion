import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { envFor as companionEnvFor, jobsMonitor, makeSandbox, stateModulePath } from "./lib/companion-harness.mjs";

const {
  createJobRecord,
  generateJobId,
  jobFilePath,
  jobsDir,
  workspaceStateDir,
  writeBrief,
  writeJobRecordFile,
} = await import(pathToFileURL(stateModulePath).href);

function envFor(sandbox, extra = {}) {
  return companionEnvFor(sandbox, { GROK_JOBS_MONITOR_INTERVAL_MS: "200", ...extra });
}

function seedJob(sandbox, fields = {}) {
  const id = fields.id ?? generateJobId();
  const briefFile = writeBrief(sandbox.dataDir, sandbox.workDir, id, "seeded job");
  const file = jobFilePath(sandbox.dataDir, sandbox.workDir, id);
  const record = {
    ...createJobRecord({
      id,
      pid: null,
      mode: "consult",
      cwd: sandbox.workDir,
      briefFile,
      background: true,
    }),
    ...fields,
    id,
    cwd: sandbox.workDir,
    briefFile,
  };
  writeJobRecordFile(file, record);
  return { file, record };
}

function announcedPath(sandbox, sessionId = null) {
  const name = sessionId ? `jobs-monitor-announced.${sessionId}.json` : "jobs-monitor-announced.json";
  return path.join(workspaceStateDir(sandbox.dataDir, sandbox.workDir), name);
}

function startMonitor(sandbox, env) {
  const child = spawn(process.execPath, [jobsMonitor], {
    cwd: sandbox.workDir,
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
  seedJob(sandbox, { status: "done", finishedAt: new Date().toISOString() });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepStrictEqual(monitor.lines(), []);
});

test("a background job transitioning to done emits exactly one correctly shaped line", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running", background: true });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepStrictEqual(monitor.lines(), []);

  writeJobRecordFile(file, {
    ...record,
    status: "done",
    finishedAt: new Date().toISOString(),
    resultText: "ALLOW",
  });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `grok job ${record.id} done. collect with /grok:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`
  );

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(monitor.lines().length, 1);
});

test("a corrupt job record does not mute announcements for healthy records", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running", background: true });
  const corruptId = "corrupt-record";
  fs.writeFileSync(path.join(jobsDir(sandbox.dataDir, sandbox.workDir), `${corruptId}.json`), "{not json\n", "utf8");
  fs.writeFileSync(announcedPath(sandbox), `${JSON.stringify([`${corruptId}:done`])}\n`, "utf8");
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, {
    ...record,
    status: "done",
    finishedAt: new Date().toISOString(),
    resultText: "ALLOW",
  });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `grok job ${record.id} done. collect with /grok:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`,
  ]);
  const announced = JSON.parse(fs.readFileSync(announcedPath(sandbox), "utf8"));
  assert.ok(announced.includes(`${corruptId}:done`));
});

test("a foreground job transitioning to done is not announced", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running", background: false });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, {
    ...record,
    status: "done",
    finishedAt: new Date().toISOString(),
    resultText: "ALLOW",
  });

  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepStrictEqual(monitor.lines(), []);
});

test("a foreground job transitioning to error is not announced", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running", background: false });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, {
    ...record,
    status: "error",
    finishedAt: new Date().toISOString(),
    failureKind: "died",
  });

  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepStrictEqual(monitor.lines(), []);
});

test("a job transitioning to error reports the failure kind", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running", background: true });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, {
    ...record,
    status: "error",
    finishedAt: new Date().toISOString(),
    failureKind: "died",
  });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `grok job ${record.id} error (died). collect with /grok:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`
  );
});

test("with a monitor session id set, a matching job emits and a mismatching job stays silent", async (t) => {
  const sandbox = makeSandbox(t);
  const { file: ownFile, record: ownRecord } = seedJob(sandbox, {
    status: "running",
    background: true,
    claudeSessionId: "session-own",
  });
  const { file: otherFile, record: otherRecord } = seedJob(sandbox, {
    status: "running",
    background: true,
    claudeSessionId: "session-other",
  });
  const monitor = startMonitor(sandbox, envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-own" }));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(ownFile, { ...ownRecord, status: "done", finishedAt: new Date().toISOString() });
  writeJobRecordFile(otherFile, { ...otherRecord, status: "done", finishedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `grok job ${ownRecord.id} done. collect with /grok:result ${ownRecord.id} only if you launched it detached; a job owned by a subagent reports on its own`
  );

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(monitor.lines().length, 1);
});

test("with the session id env var unset, a job from a different session still emits", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, {
    status: "running",
    background: true,
    claudeSessionId: "session-other",
  });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `grok job ${record.id} done. collect with /grok:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`
  );
});

test("a vanished jobs directory mid run does not crash the process and a later tick still emits", async (t) => {
  const sandbox = makeSandbox(t);
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  const dir = jobsDir(sandbox.dataDir, sandbox.workDir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.writeFileSync(dir, "not a directory");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.strictEqual(monitor.child.exitCode, null);
  assert.deepStrictEqual(monitor.lines(), []);

  fs.rmSync(dir, { force: true });
  const { file, record } = seedJob(sandbox, { status: "running", background: true });
  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `grok job ${record.id} done. collect with /grok:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`
  );
});

test("restart with persisted dedup state does not re-announce a background done job", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running", background: true });
  const env = envFor(sandbox);

  const first = startMonitor(sandbox, env);
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });
  await waitUntil(() => (first.lines().length > 0 ? first.lines() : null));
  assert.strictEqual(first.lines().length, 1);
  first.child.kill("SIGTERM");
  await once(first.child, "close");

  assert.ok(fs.existsSync(announcedPath(sandbox)));
  const persisted = JSON.parse(fs.readFileSync(announcedPath(sandbox), "utf8"));
  assert.ok(persisted.includes(`${record.id}:done`));

  // Prove the disk key, not only startup absorption, suppresses re-announce: rewrite
  // the record to running then back to done after restart.
  fs.writeFileSync(file, `${JSON.stringify({ ...record, status: "running", finishedAt: null }, null, 2)}\n`);
  const second = startMonitor(sandbox, env);
  t.after(() => second.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.writeFileSync(
    file,
    `${JSON.stringify({ ...record, status: "done", finishedAt: new Date().toISOString() }, null, 2)}\n`
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepStrictEqual(second.lines(), []);
});

test("restart catch-up announces an unrecorded terminal background job owned by the active session", async (t) => {
  const sandbox = makeSandbox(t);
  const { record } = seedJob(sandbox, {
    status: "done",
    background: true,
    claudeSessionId: "session-own",
    finishedAt: new Date().toISOString()
  });
  fs.writeFileSync(announcedPath(sandbox, "session-own"), "[]\n", "utf8");

  const monitor = startMonitor(sandbox, envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-own" }));
  t.after(() => monitor.child.kill("SIGKILL"));
  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `grok job ${record.id} done. collect with /grok:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`
  ]);
});

test("an unavailable jobs snapshot neither prunes nor persists announcement state", async (t) => {
  const sandbox = makeSandbox(t);
  const { record } = seedJob(sandbox, { status: "running", background: true });
  const stateFile = announcedPath(sandbox);
  fs.writeFileSync(stateFile, `${JSON.stringify([`${record.id}:done`])}\n`, "utf8");
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const before = fs.readFileSync(stateFile, "utf8");

  fs.rmSync(jobsDir(sandbox.dataDir, sandbox.workDir), { recursive: true, force: true });
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.strictEqual(fs.readFileSync(stateFile, "utf8"), before);
  assert.deepStrictEqual(monitor.lines(), []);
});

test("a removed state directory is not recreated while the jobs source is unavailable", async (t) => {
  const sandbox = makeSandbox(t);
  seedJob(sandbox, { status: "running", background: true });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  const stateDir = workspaceStateDir(sandbox.dataDir, sandbox.workDir);
  fs.rmSync(stateDir, { recursive: true, force: true });
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.strictEqual(fs.existsSync(stateDir), false);
  assert.deepStrictEqual(monitor.lines(), []);
});

test("announcement state files older than 30 days are pruned", async (t) => {
  const sandbox = makeSandbox(t);
  seedJob(sandbox, { status: "running", background: true });
  const staleFile = path.join(workspaceStateDir(sandbox.dataDir, sandbox.workDir), "jobs-monitor-announced.stale-session.json");
  fs.writeFileSync(staleFile, "[]\n", "utf8");
  const staleTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  fs.utimesSync(staleFile, staleTime, staleTime);

  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await waitUntil(() => (!fs.existsSync(staleFile) ? true : null));
  assert.strictEqual(fs.existsSync(staleFile), false);
});

test("exits 0 on SIGTERM", async (t) => {
  const sandbox = makeSandbox(t);
  const monitor = startMonitor(sandbox, envFor(sandbox));
  await new Promise((resolve) => setTimeout(resolve, 200));
  monitor.child.kill("SIGTERM");
  const [code] = await once(monitor.child, "close");
  assert.strictEqual(code, 0);
});

test("skips silently when the jobs directory does not exist", async (t) => {
  const sandbox = makeSandbox(t);
  fs.rmSync(sandbox.dataDir, { recursive: true, force: true });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepStrictEqual(monitor.lines(), []);
  assert.strictEqual(monitor.stderr(), "");
  assert.strictEqual(fs.existsSync(sandbox.dataDir), false);
});
