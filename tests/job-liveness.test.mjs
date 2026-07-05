import assert from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { companion, envFor as companionEnvFor, makeSandbox, runCompanion, stateModulePath } from "./lib/companion-harness.mjs";

const { refreshRunningJobRecord } = await import(pathToFileURL(companion).href);
const {
  createJobRecord,
  generateJobId,
  jobFilePath,
  readJobRecordFile,
  writeBrief,
  writeJobRecordFile,
} = await import(stateModulePath);

function envFor(sandbox, extra = {}) {
  return companionEnvFor(sandbox, extra, { clearEnv: ["GROK_COMPANION_PIDLESS_RUNNING_GRACE_MS"] });
}

async function makeDeadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.ok(child.pid, "Expected child pid.");
  const pid = child.pid;
  await once(child, "close");
  return pid;
}

function seedJob(sandbox, fields = {}) {
  const id = fields.id ?? generateJobId();
  const briefFile = writeBrief(sandbox.dataDir, sandbox.workDir, id, "seeded job");
  const file = jobFilePath(sandbox.dataDir, sandbox.workDir, id);
  const record = {
    ...createJobRecord({
      id,
      pid: Object.hasOwn(fields, "pid") ? fields.pid : process.pid,
      mode: fields.mode ?? "consult",
      cwd: sandbox.workDir,
      briefFile,
      background: fields.background ?? true,
    }),
    ...fields,
    id,
    cwd: sandbox.workDir,
    briefFile,
  };
  writeJobRecordFile(file, record);
  return { file, record };
}

test("status marks a running record whose driver pid died as died", async (t) => {
  const sandbox = makeSandbox(t);
  const pid = await makeDeadPid();
  const { file, record } = seedJob(sandbox, { pid });
  const result = runCompanion(["status", record.id], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /^state: error$/m);
  assert.match(result.stdout, /^failure: died$/m);
  const updated = readJobRecordFile(file);
  assert.strictEqual(updated.status, "error");
  assert.strictEqual(updated.failureKind, "died");
  assert.strictEqual(updated.pid, null);
  assert.strictEqual(updated.grokPid, null);
  assert.match(updated.errorMessage, new RegExp(`pid ${pid}`));
  assert.match(updated.errorMessage, /exited without recording an outcome/);
  assert.match(updated.errorTail, /exited without recording an outcome/);
});

test("status checks grokPid when the driver pid is absent", async (t) => {
  const deadSandbox = makeSandbox(t);
  const deadPid = await makeDeadPid();
  const { file: deadFile, record: deadRecord } = seedJob(deadSandbox, { pid: null, grokPid: deadPid });
  const deadResult = runCompanion(["status", deadRecord.id], { cwd: deadSandbox.workDir, env: envFor(deadSandbox) });
  assert.strictEqual(deadResult.status, 0, deadResult.stderr);
  assert.match(deadResult.stdout, /^state: error$/m);
  assert.match(deadResult.stdout, /^failure: died$/m);
  const deadUpdated = readJobRecordFile(deadFile);
  assert.strictEqual(deadUpdated.status, "error");
  assert.strictEqual(deadUpdated.failureKind, "died");
  assert.match(deadUpdated.errorMessage, new RegExp(`pid ${deadPid}`));

  const aliveSandbox = makeSandbox(t);
  const { file: aliveFile, record: aliveRecord } = seedJob(aliveSandbox, { pid: null, grokPid: process.pid });
  const before = fs.readFileSync(aliveFile, "utf8");
  const aliveResult = runCompanion(["status", aliveRecord.id], { cwd: aliveSandbox.workDir, env: envFor(aliveSandbox) });
  assert.strictEqual(aliveResult.status, 0, aliveResult.stderr);
  assert.match(aliveResult.stdout, /^state: running$/m);
  assert.strictEqual(fs.readFileSync(aliveFile, "utf8"), before);
});

test("result marks a running record whose driver pid died as died", async (t) => {
  const sandbox = makeSandbox(t);
  const pid = await makeDeadPid();
  const { file, record } = seedJob(sandbox, { pid });
  const result = runCompanion(["result", record.id], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /^state: error$/m);
  assert.match(result.stdout, /^failure: died$/m);
  assert.match(result.stdout, /exited without recording an outcome/);
  const updated = readJobRecordFile(file);
  assert.strictEqual(updated.status, "error");
  assert.strictEqual(updated.failureKind, "died");
  assert.match(updated.errorMessage, new RegExp(`pid ${pid}`));
});

test("status and result leave a running record alone when its driver process is alive", (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { pid: process.pid });
  const before = fs.readFileSync(file, "utf8");
  const status = runCompanion(["status", record.id], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(status.status, 0, status.stderr);
  assert.match(status.stdout, /^state: running$/m);
  const result = runCompanion(["result", record.id], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /still running/);
  assert.strictEqual(fs.readFileSync(file, "utf8"), before);
});

test("status leaves a fresh pidless running record alone", (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { pid: null, grokPid: null });
  const before = fs.readFileSync(file, "utf8");
  const result = runCompanion(["status", record.id], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { GROK_COMPANION_PIDLESS_RUNNING_GRACE_MS: "60000" }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /^state: running$/m);
  assert.strictEqual(fs.readFileSync(file, "utf8"), before);
});

test("status marks an old pidless running record as died", (t) => {
  const sandbox = makeSandbox(t);
  const createdAt = new Date(Date.now() - 5000).toISOString();
  const { file, record } = seedJob(sandbox, { pid: null, grokPid: null, createdAt });
  const result = runCompanion(["status", record.id], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { GROK_COMPANION_PIDLESS_RUNNING_GRACE_MS: "10" }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /^state: error$/m);
  assert.match(result.stdout, /^failure: died$/m);
  const updated = readJobRecordFile(file);
  assert.strictEqual(updated.status, "error");
  assert.strictEqual(updated.failureKind, "died");
  assert.strictEqual(updated.pid, null);
  assert.strictEqual(updated.grokPid, null);
  assert.match(updated.errorMessage, /No process id was recorded/);
});

test("refresh preserves a done record written after a stale outer read", async (t) => {
  const sandbox = makeSandbox(t);
  const pid = await makeDeadPid();
  const { file } = seedJob(sandbox, { pid });
  const stale = readJobRecordFile(file);
  const done = {
    ...stale,
    status: "done",
    pid: null,
    grokPid: null,
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    sessionId: "11111111-1111-7111-8111-111111111111",
    resultText: "finished",
    failureKind: null,
    cancelRequestedAt: null,
  };
  writeJobRecordFile(file, done);
  const refreshed = refreshRunningJobRecord({ record: stale, file });
  assert.strictEqual(refreshed.changed, false);
  assert.deepStrictEqual(refreshed.record, done);
  assert.deepStrictEqual(readJobRecordFile(file), done);
});

test("terminal records are not rewritten by the liveness pass", async (t) => {
  const sandbox = makeSandbox(t);
  const pid = await makeDeadPid();
  const { file, record } = seedJob(sandbox, {
    pid,
    status: "error",
    failureKind: "error",
    errorMessage: "Original failure.",
    errorTail: "Original failure.",
  });
  const before = fs.readFileSync(file, "utf8");
  const status = runCompanion(["status", record.id], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(status.status, 0, status.stderr);
  assert.match(status.stdout, /^state: error$/m);
  assert.match(status.stdout, /^failure: error$/m);
  const result = runCompanion(["result", record.id], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /^state: error$/m);
  assert.match(result.stdout, /^failure: error$/m);
  assert.strictEqual(fs.readFileSync(file, "utf8"), before);
});
