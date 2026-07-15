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

const ANNOUNCED_LEDGER_VERSION = 2;

function envFor(sandbox, extra = {}) {
  return companionEnvFor(sandbox, { GROK_JOBS_MONITOR_INTERVAL_MS: "200", ...extra });
}

function seedJob(sandbox, fields = {}) {
  const id = fields.id ?? generateJobId();
  const cwd = fields.cwd ?? sandbox.workDir;
  const briefFile = writeBrief(sandbox.dataDir, cwd, id, "seeded job");
  const file = jobFilePath(sandbox.dataDir, cwd, id);
  const record = {
    ...createJobRecord({
      id,
      pid: null,
      mode: "consult",
      cwd,
      briefFile,
      background: true,
    }),
    ...fields,
    id,
    cwd,
    briefFile,
  };
  writeJobRecordFile(file, record);
  return { file, record };
}

function announcedPath(sandbox, sessionId = null) {
  const name = sessionId ? `jobs-monitor-announced.${sessionId}.json` : "jobs-monitor-announced.json";
  return path.join(workspaceStateDir(sandbox.dataDir, sandbox.workDir), name);
}

function announcedKey(cwd, id, status) {
  return JSON.stringify([path.resolve(cwd), id, status]);
}

function announcedLedger(keys = []) {
  return { version: ANNOUNCED_LEDGER_VERSION, keys };
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
  sandbox.registerCleanup(async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
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
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepStrictEqual(monitor.lines(), []);
});

test("a pre-existing uncollected managed job emits its fallback on startup", async (t) => {
  const sandbox = makeSandbox(t);
  const { record } = seedJob(sandbox, {
    status: "done",
    delivery: "managed",
    createdAt: new Date(Date.now() - 1000).toISOString(),
    finishedAt: null,
  });
  const monitor = startMonitor(sandbox, envFor(sandbox, { GROK_JOBS_MONITOR_MANAGED_GRACE_MS: "100" }));

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `grok managed job ${record.id} done without collection by its owning agent. collect with /grok:result ${record.id}`,
  ]);
});

test("a background job transitioning to done emits exactly one correctly shaped line", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running", background: true });
  const monitor = startMonitor(sandbox, envFor(sandbox));
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
  fs.writeFileSync(announcedPath(sandbox), `${JSON.stringify(announcedLedger([announcedKey(sandbox.workDir, corruptId, "done")]))}\n`, "utf8");
  const monitor = startMonitor(sandbox, envFor(sandbox));
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
  assert.strictEqual(announced.version, ANNOUNCED_LEDGER_VERSION);
  assert.ok(announced.keys.includes(announcedKey(sandbox.workDir, corruptId, "done")));
});

test("a malformed terminal record does not mute announcements for healthy records", async (t) => {
  const sandbox = makeSandbox(t);
  const malformedId = "000-malformed-record";
  const malformedFile = path.join(jobsDir(sandbox.dataDir, sandbox.workDir), `${malformedId}.json`);
  fs.mkdirSync(path.dirname(malformedFile), { recursive: true });
  fs.writeFileSync(malformedFile, `${JSON.stringify({ id: malformedId, status: "done", background: true, cwd: { invalid: true } })}\n`, "utf8");
  const { file, record } = seedJob(sandbox, { id: "zzzz-healthy-record", status: "running", background: true });
  fs.writeFileSync(announcedPath(sandbox), `${JSON.stringify(announcedLedger())}\n`, "utf8");
  const monitor = startMonitor(sandbox, envFor(sandbox));
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
  assert.strictEqual(monitor.stderr(), "");
});

test("a foreground job transitioning to done is not announced", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running", background: false });
  const monitor = startMonitor(sandbox, envFor(sandbox));
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

test("a managed background job stays silent during its owner collection grace", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running", background: true, delivery: "managed" });
  const monitor = startMonitor(sandbox, envFor(sandbox));
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

test("an uncollected managed background job is announced after its owner grace", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running", background: true, delivery: "managed" });
  const monitor = startMonitor(sandbox, envFor(sandbox, { GROK_JOBS_MONITOR_MANAGED_GRACE_MS: "100" }));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, {
    ...record,
    status: "done",
    createdAt: new Date(Date.now() - 1000).toISOString(),
    finishedAt: null,
    resultText: "ALLOW",
  });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `grok managed job ${record.id} done without collection by its owning agent. collect with /grok:result ${record.id}`,
  ]);
});

test("an invalid managed completion timestamp falls back to the creation timestamp", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running", background: true, delivery: "managed" });
  const monitor = startMonitor(sandbox, envFor(sandbox, { GROK_JOBS_MONITOR_MANAGED_GRACE_MS: "1000" }));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, {
    ...record,
    status: "done",
    createdAt: new Date().toISOString(),
    finishedAt: "invalid",
    resultText: "ALLOW",
  });

  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepStrictEqual(monitor.lines(), []);
});

test("a collected managed background job remains silent after its owner grace", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running", background: true, delivery: "managed" });
  const monitor = startMonitor(sandbox, envFor(sandbox, { GROK_JOBS_MONITOR_MANAGED_GRACE_MS: "0" }));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, {
    ...record,
    status: "done",
    finishedAt: new Date(Date.now() - 1000).toISOString(),
    deliveryCollectedAt: new Date().toISOString(),
    resultText: "ALLOW",
  });

  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepStrictEqual(monitor.lines(), []);
});

test("a foreground job transitioning to error is not announced", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running", background: false });
  const monitor = startMonitor(sandbox, envFor(sandbox));
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

test("a session monitor observes a managed job launched in another workspace", async (t) => {
  const sandbox = makeSandbox(t);
  const otherCwd = path.join(sandbox.root, "other-workspace");
  fs.mkdirSync(otherCwd, { recursive: true });
  const monitor = startMonitor(
    sandbox,
    envFor(sandbox, {
      CLAUDE_CODE_SESSION_ID: "session-own",
      GROK_JOBS_MONITOR_MANAGED_GRACE_MS: "0",
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 300));

  const { record } = seedJob(sandbox, {
    cwd: otherCwd,
    status: "done",
    background: true,
    delivery: "managed",
    claudeSessionId: "session-own",
    finishedAt: new Date().toISOString(),
  });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `grok managed job ${record.id} done without collection by its owning agent. collect with /grok:result ${record.id} --cwd ${JSON.stringify(otherCwd)}`,
  ]);
});

test("a session monitor announces duplicate legacy ids in each workspace with explicit cwd values", async (t) => {
  const sandbox = makeSandbox(t);
  const otherCwd = path.join(sandbox.root, "other-workspace");
  fs.mkdirSync(otherCwd, { recursive: true });
  const id = "duplicate-legacy-id";
  const { file: ownFile, record: ownRecord } = seedJob(sandbox, {
    id,
    status: "running",
    background: true,
    claudeSessionId: "session-own",
  });
  const { file: otherFile, record: otherRecord } = seedJob(sandbox, {
    id,
    cwd: otherCwd,
    status: "running",
    background: true,
    claudeSessionId: "session-own",
  });
  const monitor = startMonitor(sandbox, envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-own" }));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(ownFile, { ...ownRecord, status: "done", finishedAt: new Date().toISOString() });
  writeJobRecordFile(otherFile, { ...otherRecord, status: "done", finishedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length === 2 ? monitor.lines() : null));
  assert.deepStrictEqual(lines.sort(), [
    `grok job ${id} done. collect with /grok:result ${id} --cwd ${JSON.stringify(sandbox.workDir)} only if you launched it detached; a job owned by a subagent reports on its own`,
    `grok job ${id} done. collect with /grok:result ${id} --cwd ${JSON.stringify(otherCwd)} only if you launched it detached; a job owned by a subagent reports on its own`,
  ].sort());
});

test("a partial session snapshot does not prune another workspace announcement", async (t) => {
  const sandbox = makeSandbox(t);
  const otherCwd = path.join(sandbox.root, "other-workspace");
  fs.mkdirSync(otherCwd, { recursive: true });
  seedJob(sandbox, {
    status: "running",
    background: true,
    claudeSessionId: "session-own",
  });
  const { file, record } = seedJob(sandbox, {
    cwd: otherCwd,
    status: "running",
    background: true,
    claudeSessionId: "session-own",
  });
  const monitor = startMonitor(sandbox, envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-own" }));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });
  await waitUntil(() => (monitor.lines().length === 1 ? true : null));

  const dir = jobsDir(sandbox.dataDir, otherCwd);
  const backup = `${dir}.backup`;
  fs.renameSync(dir, backup);
  fs.writeFileSync(dir, "not a directory", "utf8");
  await new Promise((resolve) => setTimeout(resolve, 500));
  fs.rmSync(dir, { force: true });
  fs.renameSync(backup, dir);
  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.strictEqual(monitor.lines().length, 1);
});

test("startup suppression waits for a complete cross workspace snapshot", async (t) => {
  const sandbox = makeSandbox(t);
  const otherCwd = path.join(sandbox.root, "other-workspace");
  fs.mkdirSync(otherCwd, { recursive: true });
  seedJob(sandbox, {
    status: "running",
    background: true,
    claudeSessionId: "session-own",
  });
  seedJob(sandbox, {
    cwd: otherCwd,
    status: "done",
    background: true,
    claudeSessionId: "session-own",
    finishedAt: new Date().toISOString(),
  });
  const dir = jobsDir(sandbox.dataDir, otherCwd);
  const backup = `${dir}.backup`;
  fs.renameSync(dir, backup);
  fs.writeFileSync(dir, "not a directory", "utf8");
  const monitor = startMonitor(sandbox, envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-own" }));
  await new Promise((resolve) => setTimeout(resolve, 500));

  fs.rmSync(dir, { force: true });
  fs.renameSync(backup, dir);
  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.deepStrictEqual(monitor.lines(), []);
});

test("with the session id env var unset, a job from a different session still emits", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, {
    status: "running",
    background: true,
    claudeSessionId: "session-other",
  });
  const monitor = startMonitor(sandbox, envFor(sandbox));
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
  assert.strictEqual(persisted.version, ANNOUNCED_LEDGER_VERSION);
  assert.ok(persisted.keys.includes(announcedKey(sandbox.workDir, record.id, "done")));

  // Prove the disk key, not only startup absorption, suppresses re-announce: rewrite
  // the record to running then back to done after restart.
  fs.writeFileSync(file, `${JSON.stringify({ ...record, status: "running", finishedAt: null }, null, 2)}\n`);
  const second = startMonitor(sandbox, env);
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.writeFileSync(
    file,
    `${JSON.stringify({ ...record, status: "done", finishedAt: new Date().toISOString() }, null, 2)}\n`
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepStrictEqual(second.lines(), []);
});

test("an old announcement ledger version is reset instead of suppressing a namespaced notification", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running", background: true });
  const stateFile = announcedPath(sandbox);
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({ version: 1, keys: [announcedKey(sandbox.workDir, record.id, "done")] })}\n`,
    "utf8",
  );
  const monitor = startMonitor(sandbox, envFor(sandbox));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, { ...record, status: "done", finishedAt: new Date().toISOString() });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `grok job ${record.id} done. collect with /grok:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`,
  ]);
  const persisted = await waitUntil(() => {
    const current = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return current.keys.includes(announcedKey(sandbox.workDir, record.id, "done")) ? current : null;
  });
  assert.strictEqual(persisted.version, ANNOUNCED_LEDGER_VERSION);
});

test("restart catch-up announces an unrecorded terminal background job owned by the active session", async (t) => {
  const sandbox = makeSandbox(t);
  const { record } = seedJob(sandbox, {
    status: "done",
    background: true,
    claudeSessionId: "session-own",
    finishedAt: new Date().toISOString()
  });
  fs.writeFileSync(announcedPath(sandbox, "session-own"), `${JSON.stringify(announcedLedger())}\n`, "utf8");

  const monitor = startMonitor(sandbox, envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-own" }));
  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.deepStrictEqual(lines, [
    `grok job ${record.id} done. collect with /grok:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`
  ]);
});

test("an unavailable jobs snapshot neither prunes nor persists announcement state", async (t) => {
  const sandbox = makeSandbox(t);
  const { record } = seedJob(sandbox, { status: "running", background: true });
  const stateFile = announcedPath(sandbox);
  fs.writeFileSync(stateFile, `${JSON.stringify(announcedLedger([announcedKey(sandbox.workDir, record.id, "done")]))}\n`, "utf8");
  const monitor = startMonitor(sandbox, envFor(sandbox));
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
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepStrictEqual(monitor.lines(), []);
  assert.strictEqual(monitor.stderr(), "");
  assert.strictEqual(fs.existsSync(sandbox.dataDir), false);
});
