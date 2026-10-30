import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getProcessIdentity } from "../plugins/devin/scripts/lib/process-identity.mjs";
import {
  claimResumeSessionLease,
  createJobRecord,
  createJobRecordFile,
  DEFAULT_LOCK_TIMEOUT_MS,
  finishSuccessfulJobRecordFile,
  jobFilePath,
  readJobRecordFile,
  resumeSessionLeasePath,
  resolveDataDir,
  resolveLockTimeoutMs,
  runConfigDir,
  sweepDevinRuns,
  DEVIN_SESSION_ID_PATTERN,
  SESSION_ID_ENV,
  updateJobRecordFile,
  updateJobRecordFileWithCurrent,
  writeJobRecordFile
} from "../plugins/devin/scripts/lib/state.mjs";

const stateUrl = new URL("../plugins/devin/scripts/lib/state.mjs", import.meta.url).href;
const identityBin = fs.mkdtempSync(path.join(os.tmpdir(), "devin-identity-"));
if (["darwin", "freebsd", "openbsd"].includes(process.platform)) {
  fs.writeFileSync(path.join(identityBin, "ps"), `#!/bin/sh
pid=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-p" ]; then
    pid="$2"
    shift 2
  else
    shift
  fi
done
printf "process-%s\\n" "$pid"
`);
  fs.writeFileSync(path.join(identityBin, "sysctl"), '#!/bin/sh\nprintf "{ sec = 1, usec = 0 }\\n"\n');
  fs.writeFileSync(path.join(identityBin, "uptime"), '#!/bin/sh\nprintf "2020-01-01 00:00:00\\n"\n');
  for (const command of ["ps", "sysctl", "uptime"]) {
    fs.chmodSync(path.join(identityBin, command), 0o755);
  }
  process.env.PATH = `${identityBin}${path.delimiter}${process.env.PATH}`;
}
test.after(() => fs.rmSync(identityBin, { recursive: true, force: true }));

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devin-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const cwd = path.join(root, "work");
  fs.mkdirSync(cwd);
  return { root, dataDir, cwd };
}

function recordFile(t, id = "a-job") {
  const work = sandbox(t);
  const file = jobFilePath(work.dataDir, work.cwd, id);
  createJobRecordFile(file, createJobRecord({ id, cwd: work.cwd, mode: "consult", briefFile: path.join(work.root, "brief.md") }));
  return { ...work, file };
}

function runChild(source, args, env = process.env) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completion };
}

async function waitForFile(file) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${file}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("Devin record has the contract fields and no Grok usage channels", (t) => {
  const { dataDir, cwd } = sandbox(t);
  const configDir = runConfigDir(dataDir, "job-1");
  const record = createJobRecord({
    id: "job-1", cwd, mode: "write", briefFile: "brief.md", devinVersion: " 3000.11.228 ",
    devinBuildPath: "/usr/local/bin/devin", requestedModel: "swe-2", resolvedModel: "swe-2", resolvedEffort: "max",
    observedModel: "SWE 2", requestedEffort: "high", effortApplied: false, billingPool: "first-party",
    role: "burst", requestId: "request-1", configDir, stopCause: "complete", warnings: ["project hooks"]
  });
  assert.equal(record.engine, "devin");
  assert.equal(record.devinVersion, "3000.11.228");
  assert.equal(record.devinBuildPath, "/usr/local/bin/devin");
  assert.equal(record.devinPid, null);
  assert.equal(record.devinPidIdentity, null);
  assert.equal(record.requestId, "request-1");
  assert.equal(record.stopCause, "complete");
  assert.equal(record.requestedModel, "swe-2");
  assert.equal(record.resolvedModel, "swe-2");
  assert.equal(record.resolvedEffort, "max");
  const file = jobFilePath(dataDir, cwd, record.id);
  createJobRecordFile(file, record);
  assert.equal(readJobRecordFile(file).resolvedEffort, "max");
  assert.equal(record.observedModel, "SWE 2");
  assert.equal(record.requestedEffort, "high");
  assert.equal(record.effortApplied, false);
  assert.equal(record.billingPool, "first-party");
  assert.equal(record.configDir, path.join(dataDir, "runs", "job-1", "config"));
  assert.deepEqual(record.warnings, ["project hooks"]);
  assert.equal(record.usage, null);
  assert.equal(record.usageIsIncomplete, null);
  assert.equal(DEVIN_SESSION_ID_PATTERN.test("artistic-breeze"), true);
  assert.equal(DEVIN_SESSION_ID_PATTERN.test("single"), false);
  assert.equal(DEVIN_SESSION_ID_PATTERN.test("artistic_Breeze"), false);
  for (const key of ["cursorVersion", "cursorBuildPath", "homeDir", "grokVersion", "grokPid", "grokPidIdentity", "modelUsage", "modelUsageIsIncomplete", "memoryEnabled"]) {
    assert.equal(Object.hasOwn(record, key), false, key);
  }
  assert.deepEqual(createJobRecord({ id: "empty", cwd, mode: "consult" }).warnings, []);
});

test("Devin paths and environment overrides use Devin names", (t) => {
  const { dataDir } = sandbox(t);
  assert.equal(resolveDataDir({ DEVIN_COMPANION_DATA: dataDir }), dataDir);
  assert.match(resolveDataDir({}), /devin-claude-code-fusion$/);
  assert.throws(() => resolveDataDir({ DEVIN_COMPANION_DATA: "relative" }), /absolute path/);
  assert.equal(resolveLockTimeoutMs({ DEVIN_COMPANION_LOCK_TIMEOUT_MS: "7500" }), 7500);
  assert.equal(resolveLockTimeoutMs({ DEVIN_COMPANION_LOCK_TIMEOUT_MS: "bad" }), DEFAULT_LOCK_TIMEOUT_MS);
  assert.equal(SESSION_ID_ENV, "CLAUDE_CODE_SESSION_ID");
});

test("terminal jobs remove their private config without touching shared session data", (t) => {
  const { dataDir, cwd } = sandbox(t);
  const id = "terminal-config";
  const configDir = runConfigDir(dataDir, id);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), "{}");
  const sharedSession = path.join(dataDir, "home", ".local", "share", "devin", "cli", "sessions.db");
  fs.mkdirSync(path.dirname(sharedSession), { recursive: true });
  fs.writeFileSync(sharedSession, "session");
  const file = jobFilePath(dataDir, cwd, id);
  createJobRecordFile(file, createJobRecord({ id, cwd, mode: "consult", configDir }));
  finishSuccessfulJobRecordFile(file, { status: "done", resultText: "done", stopCause: "complete" });
  assert.equal(fs.existsSync(configDir), false);
  assert.equal(fs.readFileSync(sharedSession, "utf8"), "session");
  assert.equal(readJobRecordFile(file).stopCause, "complete");
});

test("run sweep removes old unrecorded runs at most once per ten minutes", (t) => {
  const { dataDir, cwd } = sandbox(t);
  const now = Date.now();
  const runs = path.join(dataDir, "runs");
  const orphan = path.join(runs, "orphan");
  const running = path.join(runs, "running");
  fs.mkdirSync(orphan, { recursive: true });
  fs.mkdirSync(running);
  fs.utimesSync(orphan, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000));
  const runningFile = jobFilePath(dataDir, cwd, "running");
  createJobRecordFile(runningFile, createJobRecord({ id: "running", cwd, mode: "consult", configDir: runConfigDir(dataDir, "running") }));
  assert.equal(sweepDevinRuns(dataDir, now), true);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(running), true);
  const next = path.join(runs, "next");
  fs.mkdirSync(next);
  fs.utimesSync(next, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000));
  assert.equal(sweepDevinRuns(dataDir, now + 1000), false);
  assert.equal(fs.existsSync(next), true);
  assert.equal(sweepDevinRuns(dataDir, now + 10 * 60 * 1000), true);
  assert.equal(fs.existsSync(next), false);
});

test("terminal transport evidence remains immutable after racing writes", (t) => {
  const { file } = recordFile(t);
  const done = finishSuccessfulJobRecordFile(file, {
    status: "done", resultText: "finished", usage: { inputTokens: 3 }, usageIsIncomplete: true,
    sessionId: "session-1", requestId: "request-1", observedModel: "SWE 2", warnings: ["late_close"]
  });
  assert.equal(done.status, "done");
  assert.equal(done.devinPid, null);
  writeJobRecordFile(file, { ...done, status: "error", failureKind: "timeout", resultText: "replaced" });
  updateJobRecordFile(file, { status: "cancelled", usage: { inputTokens: 100 } });
  const after = finishSuccessfulJobRecordFile(file, { status: "done", resultText: "later" });
  assert.equal(after.status, "done");
  assert.equal(after.resultText, "finished");
  assert.deepEqual(after.usage, { inputTokens: 3 });
  assert.equal(after.usageIsIncomplete, true);
  assert.deepEqual(after.warnings, ["late_close"]);
  assert.equal(after.failureKind, null);
});

test("successful finish respects an already requested cancellation", (t) => {
  const { file } = recordFile(t);
  updateJobRecordFile(file, { cancelRequestedAt: new Date().toISOString() });
  const record = finishSuccessfulJobRecordFile(file, { status: "done", resultText: "partial", requestId: "r1", resolvedEffort: "max", usage: { outputTokens: 2 } });
  assert.equal(record.status, "cancelled");
  assert.equal(record.failureKind, "cancelled");
  assert.equal(record.requestId, "r1");
  assert.equal(record.resolvedEffort, "max");
  assert.deepEqual(record.usage, { outputTokens: 2 });
});

test("successful finish preserves model drift when cancellation was requested", (t) => {
  const { file } = recordFile(t);
  assert.equal(readJobRecordFile(file).status, "running");
  updateJobRecordFile(file, { cancelRequestedAt: new Date().toISOString() });
  const modelDrift = { requested: "swe-2", observed: "SWE 2" };
  const record = finishSuccessfulJobRecordFile(file, { status: "done", modelDrift });
  assert.equal(record.status, "cancelled");
  assert.deepEqual(record.modelDrift, modelDrift);
});

test("a live owner lock times out at the configured ceiling", async (t) => {
  const { file, root } = recordFile(t);
  const ready = path.join(root, "ready");
  const release = path.join(root, "release");
  const holder = runChild(`
import fs from "node:fs";
const [url, file, ready, release] = process.argv.slice(1);
const state = await import(url);
state.updateJobRecordFileWithCurrent(file, (current) => {
  fs.writeFileSync(ready, "ready");
  while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  return current;
});
`, [stateUrl, file, ready, release]);
  t.after(() => holder.child.kill("SIGKILL"));
  await waitForFile(ready);
  const waiter = runChild(`
const [url, file] = process.argv.slice(1);
const state = await import(url);
try {
  state.updateJobRecordFile(file, { revision: 1 });
  process.stdout.write("acquired");
} catch (error) {
  process.stdout.write(error.message);
}
`, [stateUrl, file], { ...process.env, DEVIN_COMPANION_LOCK_TIMEOUT_MS: "3000" });
  const result = await waiter.completion;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Timed out waiting for the job record lock/);
  fs.writeFileSync(release, "release");
  assert.equal((await holder.completion).code, 0);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("replaced owner identity is reclaimed without dropping a successor", (t) => {
  const { file } = recordFile(t);
  const lock = `${file}.lock`;
  const token = "a".repeat(32);
  const ownerDir = `${lock}.owner.${token}`;
  const identity = getProcessIdentity(process.pid);
  assert.ok(identity);
  fs.mkdirSync(ownerDir);
  fs.writeFileSync(path.join(ownerDir, "owner.json"), JSON.stringify({
    version: 1, token, ownerPid: process.pid, ownerIdentity: { ...identity, commandHash: "0".repeat(64) }
  }));
  fs.symlinkSync(path.basename(ownerDir), lock, "dir");
  const next = updateJobRecordFileWithCurrent(file, (current) => ({ ...current, revision: 1 }));
  assert.equal(next.revision, 1);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(ownerDir), false);
  assert.equal(readJobRecordFile(file).revision, 1);
});

test("a resume lease recovers a dead pidless owner", (t) => {
  const { dataDir, cwd } = sandbox(t);
  const first = jobFilePath(dataDir, cwd, "first");
  const second = jobFilePath(dataDir, cwd, "second");
  createJobRecordFile(first, createJobRecord({ id: "first", cwd, mode: "consult", createdAt: "2020-01-01T00:00:00.000Z" }));
  createJobRecordFile(second, createJobRecord({ id: "second", cwd, mode: "consult" }));
  claimResumeSessionLease(dataDir, cwd, "session-1", "first");
  const lease = claimResumeSessionLease(dataDir, cwd, "session-1", "second");
  assert.equal(lease.ownerJobId, "second");
  assert.equal(readJobRecordFile(resumeSessionLeasePath(dataDir, cwd, "session-1")).ownerJobId, "second");
  assert.equal(readJobRecordFile(first).failureKind, "died");
});

test("Devin atomic job writes sync the file before rename and directory after", (t) => {
  const { file } = recordFile(t, "durable-write");
  const originalSync = fs.fsyncSync;
  const originalRename = fs.renameSync;
  const events = [];
  fs.fsyncSync = function(fd) {
    events.push(fs.fstatSync(fd).isDirectory() ? "dir" : "file");
    return originalSync.call(this, fd);
  };
  fs.renameSync = function(from, to) {
    if (to === file) events.push("rename");
    return originalRename.call(this, from, to);
  };
  try { writeJobRecordFile(file, { ...readJobRecordFile(file), revision: 1 }); }
  finally { fs.fsyncSync = originalSync; fs.renameSync = originalRename; }
  const rename = events.indexOf("rename");
  assert.ok(rename > 0, JSON.stringify(events));
  assert.equal(events[rename - 1], "file");
  assert.equal(events[rename + 1], "dir");
});
