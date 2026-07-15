import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { getProcessIdentity, processIdentityMatches } from "../plugins/grok/scripts/lib/process-identity.mjs";
import {
  createJobRecord,
  jobFilePath,
  readJobRecordFile,
  updateJobRecordFile,
  writeJobRecordFile
} from "../plugins/grok/scripts/lib/state.mjs";
import { makeSandbox, stateModulePath } from "./lib/companion-harness.mjs";

const processIdentityModuleUrl = new URL("../plugins/grok/scripts/lib/process-identity.mjs", import.meta.url).href;

const heldLockChild = `
import fs from "node:fs";
const [stateUrl, jobFile, readyFile, releaseFile] = process.argv.slice(1);
const state = await import(stateUrl);
state.updateJobRecordFileWithCurrent(jobFile, (current) => {
  fs.writeFileSync(readyFile, "ready");
  while (!fs.existsSync(releaseFile)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return current;
});
`;

const incrementChild = `
import fs from "node:fs";
const [stateUrl, jobFile, guardFile] = process.argv.slice(1);
const state = await import(stateUrl);
state.updateJobRecordFileWithCurrent(jobFile, (current) => {
  const descriptor = fs.openSync(guardFile, "wx");
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    return { ...current, revision: (current.revision ?? 0) + 1 };
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(guardFile, { force: true });
  }
});
`;

function makeRecord(sandbox, id) {
  const file = jobFilePath(sandbox.dataDir, sandbox.workDir, id);
  writeJobRecordFile(file, createJobRecord({ id, cwd: sandbox.workDir, mode: "consult", briefFile: path.join(sandbox.dataDir, `${id}.md`), background: false }));
  return file;
}

function runChild(source, args) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
  return { child, completion };
}

async function waitForPath(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${file}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function lockPaths(jobFile) {
  const lockDir = `${jobFile}.lock`;
  const ownerDir = path.resolve(path.dirname(lockDir), fs.readlinkSync(lockDir));
  const owner = JSON.parse(fs.readFileSync(path.join(ownerDir, "owner.json"), "utf8"));
  return { lockDir, ownerDir, owner };
}

test("process identity is stable across observer time zones", () => {
  const source = `
const [moduleUrl, pid] = process.argv.slice(1);
const { getProcessIdentity } = await import(moduleUrl);
process.stdout.write(JSON.stringify(getProcessIdentity(Number(pid))));
`;
  const observe = (timeZone) => spawnSync(process.execPath, ["--input-type=module", "--eval", source, processIdentityModuleUrl, String(process.pid)], {
    encoding: "utf8",
    env: { ...process.env, TZ: timeZone }
  });
  const west = observe("America/Los_Angeles");
  const east = observe("Asia/Singapore");
  assert.equal(west.status, 0, west.stderr);
  assert.equal(east.status, 0, east.stderr);
  assert.deepEqual(JSON.parse(west.stdout), JSON.parse(east.stdout));
});

test("concurrent reapers serialize after a lock owner is killed", async (t) => {
  const sandbox = makeSandbox(t);
  const jobFile = makeRecord(sandbox, "concurrent-reapers");
  const readyFile = path.join(sandbox.root, "holder-ready");
  const releaseFile = path.join(sandbox.root, "holder-release");
  const holder = runChild(heldLockChild, [stateModulePath, jobFile, readyFile, releaseFile]);
  t.after(() => holder.child.kill("SIGKILL"));
  await waitForPath(readyFile);
  holder.child.kill("SIGKILL");
  const holderResult = await holder.completion;
  assert.equal(holderResult.signal, "SIGKILL", holderResult.stderr);

  const guardFile = path.join(sandbox.root, "record.guard");
  const updaters = Array.from({ length: 4 }, () => runChild(incrementChild, [stateModulePath, jobFile, guardFile]));
  t.after(() => {
    for (const updater of updaters) {
      updater.child.kill("SIGKILL");
    }
  });
  const results = await Promise.all(updaters.map((updater) => updater.completion));
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
  }
  assert.equal(readJobRecordFile(jobFile).revision, 4);
  assert.equal(fs.existsSync(`${jobFile}.lock`), false);
  assert.equal(fs.existsSync(guardFile), false);
});

test("a dead reaper claim is succeeded without wedging recovery", async (t) => {
  const sandbox = makeSandbox(t);
  const jobFile = makeRecord(sandbox, "dead-reaper");
  const readyFile = path.join(sandbox.root, "dead-reaper-ready");
  const releaseFile = path.join(sandbox.root, "dead-reaper-release");
  const holder = runChild(heldLockChild, [stateModulePath, jobFile, readyFile, releaseFile]);
  t.after(() => holder.child.kill("SIGKILL"));
  await waitForPath(readyFile);
  const { lockDir, ownerDir, owner } = lockPaths(jobFile);
  assert.equal(processIdentityMatches(owner.ownerPid, owner.ownerIdentity), true);
  holder.child.kill("SIGKILL");
  await holder.completion;

  const claimSlot = path.join(ownerDir, ".reap");
  const claimToken = "c".repeat(32);
  const claimOwnerDir = `${claimSlot}.owner.${claimToken}`;
  fs.mkdirSync(claimOwnerDir);
  fs.writeFileSync(path.join(claimOwnerDir, "owner.json"), `${JSON.stringify({ version: 1, token: claimToken, ownerPid: owner.ownerPid, ownerIdentity: owner.ownerIdentity })}\n`);
  fs.symlinkSync(path.basename(claimOwnerDir), claimSlot, "dir");

  assert.equal(updateJobRecordFile(jobFile, { revision: 1 }).revision, 1);
  assert.equal(fs.existsSync(lockDir), false);
  assert.equal(fs.existsSync(ownerDir), false);
});

test("a reused live PID cannot retain a replaced owner identity", (t) => {
  const sandbox = makeSandbox(t);
  const jobFile = makeRecord(sandbox, "replaced-owner");
  const lockDir = `${jobFile}.lock`;
  const token = "a".repeat(32);
  const ownerDir = `${lockDir}.owner.${token}`;
  const ownerIdentity = getProcessIdentity(process.pid);
  const replacedIdentity = { ...ownerIdentity, commandHash: "0".repeat(64) };
  fs.mkdirSync(ownerDir);
  fs.writeFileSync(path.join(ownerDir, "owner.json"), `${JSON.stringify({ version: 1, token, ownerPid: process.pid, ownerIdentity: replacedIdentity })}\n`);
  fs.symlinkSync(path.basename(ownerDir), lockDir, "dir");

  assert.equal(processIdentityMatches(process.pid, replacedIdentity), false);
  assert.equal(updateJobRecordFile(jobFile, { revision: 1 }).revision, 1);
  assert.equal(fs.existsSync(lockDir), false);
  assert.equal(fs.existsSync(ownerDir), false);
});

test("an old holder cannot release a successor lock with another token", async (t) => {
  const sandbox = makeSandbox(t);
  const jobFile = makeRecord(sandbox, "successor-owner");
  const readyFile = path.join(sandbox.root, "successor-ready");
  const releaseFile = path.join(sandbox.root, "successor-release");
  const holder = runChild(heldLockChild, [stateModulePath, jobFile, readyFile, releaseFile]);
  t.after(() => holder.child.kill("SIGKILL"));
  await waitForPath(readyFile);
  const old = lockPaths(jobFile);
  fs.unlinkSync(old.lockDir);

  const token = "b".repeat(32);
  const ownerDir = `${old.lockDir}.owner.${token}`;
  const successor = { version: 1, token, ownerPid: process.pid, ownerIdentity: getProcessIdentity(process.pid) };
  fs.mkdirSync(ownerDir);
  fs.writeFileSync(path.join(ownerDir, "owner.json"), `${JSON.stringify(successor)}\n`);
  fs.symlinkSync(path.basename(ownerDir), old.lockDir, "dir");
  fs.writeFileSync(releaseFile, "release");

  const result = await holder.completion;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(old.lockDir, "owner.json"), "utf8")), successor);
  fs.unlinkSync(old.lockDir);
  fs.rmSync(ownerDir, { recursive: true, force: true });
  fs.rmSync(old.ownerDir, { recursive: true, force: true });
});

test("an unreadable linked lock fails closed without being unlinked", (t) => {
  const sandbox = makeSandbox(t);
  const corruptJob = makeRecord(sandbox, "corrupt-lock");
  const corruptLock = `${corruptJob}.lock`;
  const corruptOwner = `${corruptLock}.owner.${"d".repeat(32)}`;
  fs.mkdirSync(corruptOwner);
  fs.writeFileSync(path.join(corruptOwner, "owner.json"), "{broken\n");
  fs.symlinkSync(path.basename(corruptOwner), corruptLock, "dir");
  const staleTime = new Date(Date.now() - 11000);
  fs.utimesSync(corruptOwner, staleTime, staleTime);
  fs.lutimesSync(corruptLock, staleTime, staleTime);

  assert.throws(() => updateJobRecordFile(corruptJob, { revision: 1 }), /Timed out waiting for the job record lock/);
  assert.equal(fs.lstatSync(corruptLock).isSymbolicLink(), true);
  assert.equal(fs.existsSync(corruptOwner), true);
});

test("release cleanup failures do not lose a completed update and stale owners are scavenged", (t) => {
  const sandbox = makeSandbox(t);
  const jobFile = makeRecord(sandbox, "release-cleanup");
  const originalRmSync = fs.rmSync;
  let failedOwnerDir = null;
  fs.rmSync = function rmSyncWithFailure(target, ...args) {
    const isOwnerDir = typeof target === "string" && path.dirname(target) === path.dirname(jobFile) && path.basename(target).startsWith(`${path.basename(jobFile)}.lock.owner.`) && !path.basename(target).includes(".prepare.");
    if (typeof target === "string" && (target === failedOwnerDir || (!failedOwnerDir && isOwnerDir && !fs.existsSync(`${jobFile}.lock`)))) {
      failedOwnerDir ??= target;
      const error = new Error("injected cleanup failure");
      error.code = "EIO";
      throw error;
    }
    return originalRmSync.call(this, target, ...args);
  };
  let updated;
  try {
    updated = updateJobRecordFile(jobFile, { revision: 1 });
  } finally {
    fs.rmSync = originalRmSync;
  }
  assert.equal(updated.revision, 1);
  assert.ok(failedOwnerDir);
  assert.equal(fs.existsSync(`${jobFile}.lock`), false);
  assert.equal(fs.existsSync(failedOwnerDir), true, failedOwnerDir);

  const staleTime = new Date(Date.now() - 11000);
  fs.utimesSync(failedOwnerDir, staleTime, staleTime);
  assert.equal(updateJobRecordFile(jobFile, { revision: 2 }).revision, 2);
  assert.equal(fs.existsSync(failedOwnerDir), false);
});
