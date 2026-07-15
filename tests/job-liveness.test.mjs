import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { companion, envFor as companionEnvFor, killGroups, makeSandbox, pidAlive, runCompanion, stateModulePath, waitFor } from "./lib/companion-harness.mjs";
import { getProcessIdentity } from "../plugins/grok/scripts/lib/process-identity.mjs";

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

async function spawnOrphanProcess(source) {
  const launcherSource = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(source)}], { detached: true, stdio: "ignore" });
child.unref();
process.stdout.write(String(child.pid));
`;
  const launcher = spawn(process.execPath, ["-e", launcherSource], { stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  launcher.stdout.on("data", (chunk) => {
    output += chunk;
  });
  await once(launcher, "close");
  const pid = Number(output);
  assert.ok(Number.isInteger(pid) && pid > 1, "Expected orphan process pid.");
  return pid;
}

function replacedIdentity(identity) {
  return { ...identity, startMarker: `${identity.startMarker}-replaced` };
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

test("died detection terminates a live grok child before finalizing the record", async (t) => {
  const sandbox = makeSandbox(t);
  const deadPid = await makeDeadPid();
  const grokPid = await spawnOrphanProcess("setInterval(() => {}, 1000)");
  t.after(() => killGroups(grokPid));
  const grokPidIdentity = getProcessIdentity(grokPid);
  assert.ok(grokPidIdentity, "Expected fake grok child process identity.");
  const { file, record } = seedJob(sandbox, { pid: deadPid, grokPid, grokPidIdentity });

  const result = runCompanion(["status", record.id], { cwd: sandbox.workDir, env: envFor(sandbox) });

  assert.strictEqual(result.status, 0, result.stderr);
  await waitFor(() => (pidAlive(grokPid) ? null : true), 3000);
  const updated = readJobRecordFile(file);
  assert.strictEqual(updated.status, "error");
  assert.strictEqual(updated.failureKind, "died");
  assert.strictEqual(updated.pid, null);
  assert.strictEqual(updated.grokPid, null);
});

test("died repair treats a process identity mismatch as PID reuse without signalling it", async (t) => {
  const sandbox = makeSandbox(t);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  assert.ok(child.pid, "Expected child pid.");
  t.after(() => killGroups(child.pid));
  const identity = getProcessIdentity(child.pid);
  assert.ok(identity, "Expected child process identity.");
  const { file, record } = seedJob(sandbox, { pid: child.pid, pidIdentity: replacedIdentity(identity) });

  const result = runCompanion(["status", record.id], { cwd: sandbox.workDir, env: envFor(sandbox) });

  assert.strictEqual(result.status, 0, result.stderr);
  const updated = readJobRecordFile(file);
  assert.strictEqual(updated.status, "error");
  assert.strictEqual(updated.failureKind, "died");
  assert.ok(pidAlive(child.pid), "Expected the reused PID to remain alive.");
});

test("unverifiable legacy cleanup leaves died repair running and cleanup required", async (t) => {
  const sandbox = makeSandbox(t);
  const deadPid = await makeDeadPid();
  const grokChild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  assert.ok(grokChild.pid, "Expected fake grok child pid.");
  await once(grokChild.stdout, "data");
  t.after(() => killGroups(grokChild.pid));
  const { file, record } = seedJob(sandbox, {
    pid: deadPid,
    pidIdentity: null,
    grokPid: grokChild.pid,
    grokPidIdentity: null,
  });

  const result = runCompanion(["status", record.id], { cwd: sandbox.workDir, env: envFor(sandbox) });

  assert.notStrictEqual(result.status, 0);
  const updated = readJobRecordFile(file);
  assert.strictEqual(updated.status, "running");
  assert.strictEqual(updated.cleanupRequired, true);
  assert.strictEqual(updated.failureKind, "died");
  assert.strictEqual(updated.pid, deadPid);
  assert.strictEqual(updated.grokPid, grokChild.pid);
  assert.strictEqual(updated.pidIdentity, null);
  assert.strictEqual(updated.grokPidIdentity, null);
  assert.ok(pidAlive(grokChild.pid), "Expected legacy cleanup not to escalate to SIGKILL.");

  const immediate = runCompanion(["result", record.id], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.notStrictEqual(immediate.status, 0);
  assert.match(immediate.stdout, /^state: running$/m);
  assert.match(immediate.stdout, /^failure: died$/m);
  assert.match(immediate.stdout, /^phase: cleanup-required$/m);

  const startedAt = Date.now();
  const collected = runCompanion(["result", record.id, "--wait", "--wait-timeout-ms", "570000"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  const elapsedMs = Date.now() - startedAt;
  assert.notStrictEqual(collected.status, 0);
  assert.match(collected.stdout, /^state: running$/m);
  assert.match(collected.stdout, /^failure: died$/m);
  assert.match(collected.stdout, /^phase: cleanup-required$/m);
  assert.ok(!collected.stdout.endsWith("state: running\n"));
  assert.ok(elapsedMs < 10000, `Expected cleanup-required collection to return promptly, took ${elapsedMs}ms.`);
});

test("PID 1 is never probed or signalled by process group helpers", () => {
  const moduleUrl = new URL("../plugins/grok/scripts/lib/grok-exec.mjs", import.meta.url).href;
  const source = `
const moduleUrl = process.argv[1];
const grokExec = await import(moduleUrl);
const calls = [];
process.kill = (...args) => {
  calls.push(args);
  return true;
};
const values = [
  grokExec.processGroupAlive(1),
  grokExec.terminateProcessGroupSync(1),
  await grokExec.terminateProcessGroup(1),
  grokExec.terminateRecordedProcessGroupsSync({ background: true, pid: 1, grokPid: null }),
  await grokExec.terminateRecordedProcessGroups({ background: true, pid: 1, grokPid: null })
];
process.stdout.write(JSON.stringify({ calls, values }));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source, moduleUrl], { encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(JSON.parse(result.stdout), { calls: [], values: [false, false, false, true, true] });
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

test("result --wait marks a running record whose driver pid died as died", async (t) => {
  const sandbox = makeSandbox(t);
  const pid = await makeDeadPid();
  const { file, record } = seedJob(sandbox, { pid });
  const result = runCompanion(["result", record.id, "--wait"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { GROK_COMPANION_WAIT_POLL_MS: "10" }),
  });
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
