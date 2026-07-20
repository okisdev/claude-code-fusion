import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createJobRecord,
  DEFAULT_LOCK_TIMEOUT_MS,
  jobFilePath,
  readJobRecordFile,
  resolveLockTimeoutMs
} from "../plugins/grok/scripts/lib/state.mjs";
import { makeSandbox, stateModulePath } from "./lib/companion-harness.mjs";

const processIdentityModuleUrl = new URL("../plugins/grok/scripts/lib/process-identity.mjs", import.meta.url).href;

const processIdentityBin = fs.mkdtempSync(path.join(os.tmpdir(), "grok-state-lock-identity-"));
fs.writeFileSync(
  path.join(processIdentityBin, "ps"),
  `#!/bin/sh
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
`
);
fs.writeFileSync(path.join(processIdentityBin, "sysctl"), '#!/bin/sh\nprintf "{ sec = 1, usec = 0 }\\n"\n');
fs.chmodSync(path.join(processIdentityBin, "ps"), 0o755);
fs.chmodSync(path.join(processIdentityBin, "sysctl"), 0o755);
test.after(() => {
  fs.rmSync(processIdentityBin, { recursive: true, force: true });
});

const heldLockChild = `
import fs from "node:fs";
const [stateUrl, jobFile, readyFile, releaseFile] = process.argv.slice(1);
const state = await import(stateUrl);
state.updateJobRecordFileWithCurrent(jobFile, (current) => {
  fs.writeFileSync(readyFile, "ready");
  while (!fs.existsSync(releaseFile)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return current;
});
`;

const lockTimeoutChild = `
import fs from "node:fs";
const [stateUrl, jobFile, readyFile] = process.argv.slice(1);
const state = await import(stateUrl);
fs.writeFileSync(readyFile, "ready\\n");
const startedAt = Date.now();
try {
  state.updateJobRecordFileWithCurrent(jobFile, (current) => current);
  process.stdout.write(JSON.stringify({ elapsedMs: Date.now() - startedAt, message: null }));
} catch (error) {
  process.stdout.write(JSON.stringify({ elapsedMs: Date.now() - startedAt, message: error.message }));
}
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(createJobRecord({ id, cwd: sandbox.workDir, mode: "consult", briefFile: path.join(sandbox.dataDir, `${id}.md`), background: false }))}\n`);
  return file;
}

function childEnv(extra = {}) {
  return {
    ...process.env,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    GROK_COMPANION_LOCK_TIMEOUT_MS: "10000",
    ...extra,
    PATH: [processIdentityBin, extra.PATH ?? process.env.PATH].filter(Boolean).join(path.delimiter),
  };
}

function runChild(source, args, env = childEnv()) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
  return { child, completion };
}

function runChildSync(source, args, extraEnv = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source, ...args], {
    encoding: "utf8",
    env: childEnv(extraEnv),
  });
}

function childIdentityMatches(pid, identity) {
  const source = `
const [moduleUrl, pid, identity] = process.argv.slice(1);
const { processIdentityMatches } = await import(moduleUrl);
process.stdout.write(JSON.stringify(processIdentityMatches(Number(pid), JSON.parse(identity))));
`;
  const result = runChildSync(source, [processIdentityModuleUrl, String(pid), JSON.stringify(identity)]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function childProcessIdentity(pid) {
  const source = `
const [moduleUrl, pid] = process.argv.slice(1);
const { getProcessIdentity } = await import(moduleUrl);
process.stdout.write(JSON.stringify(getProcessIdentity(Number(pid))));
`;
  const result = runChildSync(source, [processIdentityModuleUrl, String(pid)]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function updateRecordInChild(jobFile, patch, extraEnv = {}) {
  const source = `
const [stateUrl, jobFile, patch] = process.argv.slice(1);
const state = await import(stateUrl);
try {
  process.stdout.write(JSON.stringify({ record: state.updateJobRecordFile(jobFile, JSON.parse(patch)) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ message: error.message }));
}
`;
  const result = runChildSync(source, [stateModulePath, jobFile, JSON.stringify(patch)], extraEnv);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function updateRecordWithCleanupFailureInChild(jobFile) {
  const source = `
import fs from "node:fs";
import path from "node:path";
const [stateUrl, jobFile] = process.argv.slice(1);
const state = await import(stateUrl);
const originalRmSync = fs.rmSync;
let failedOwnerDir = null;
fs.rmSync = function rmSyncWithFailure(target, ...args) {
  const isOwnerDir = typeof target === "string" && path.dirname(target) === path.dirname(jobFile) && path.basename(target).startsWith(path.basename(jobFile) + ".lock.owner.") && !path.basename(target).includes(".prepare.");
  if (typeof target === "string" && (target === failedOwnerDir || (!failedOwnerDir && isOwnerDir && !fs.existsSync(jobFile + ".lock")))) {
    failedOwnerDir ??= target;
    const error = new Error("injected cleanup failure");
    error.code = "EIO";
    throw error;
  }
  return originalRmSync.call(this, target, ...args);
};
try {
  process.stdout.write(JSON.stringify({ record: state.updateJobRecordFile(jobFile, { revision: 1 }), failedOwnerDir }));
} finally {
  fs.rmSync = originalRmSync;
}
`;
  const result = runChildSync(source, [stateModulePath, jobFile]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function waitForPath(file, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${file}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForCompletion(completion, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      completion,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Lock waiter exceeded ${timeoutMs}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
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
    env: childEnv({ TZ: timeZone })
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
  t.after(() => {
    try {
      holder.child.kill("SIGKILL");
    } catch {}
  });
  await waitForPath(readyFile);
  await waitFor(() => fs.existsSync(`${jobFile}.lock`), `lock for ${jobFile}`);
  const { owner } = lockPaths(jobFile);
  assert.equal(owner.ownerPid, holder.child.pid);

  holder.child.kill("SIGKILL");
  const holderResult = await holder.completion;
  assert.equal(holderResult.signal, "SIGKILL", holderResult.stderr);
  await waitFor(
    () => !childIdentityMatches(owner.ownerPid, owner.ownerIdentity),
    `dead owner identity for pid ${owner.ownerPid}`
  );

  const guardFile = path.join(sandbox.root, "record.guard");
  const updaters = Array.from({ length: 4 }, () => runChild(incrementChild, [stateModulePath, jobFile, guardFile]));
  t.after(() => {
    for (const updater of updaters) {
      try {
        updater.child.kill("SIGKILL");
      } catch {}
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
  assert.equal(childIdentityMatches(owner.ownerPid, owner.ownerIdentity), true);
  holder.child.kill("SIGKILL");
  await holder.completion;

  const claimSlot = path.join(ownerDir, ".reap");
  const claimToken = "c".repeat(32);
  const claimOwnerDir = `${claimSlot}.owner.${claimToken}`;
  fs.mkdirSync(claimOwnerDir);
  fs.writeFileSync(path.join(claimOwnerDir, "owner.json"), `${JSON.stringify({ version: 1, token: claimToken, ownerPid: owner.ownerPid, ownerIdentity: owner.ownerIdentity })}\n`);
  fs.symlinkSync(path.basename(claimOwnerDir), claimSlot, "dir");

  assert.equal(updateRecordInChild(jobFile, { revision: 1 }).record.revision, 1);
  assert.equal(fs.existsSync(lockDir), false);
  assert.equal(fs.existsSync(ownerDir), false);
});

test("a reused live PID cannot retain a replaced owner identity", (t) => {
  const sandbox = makeSandbox(t);
  const jobFile = makeRecord(sandbox, "replaced-owner");
  const source = `
import fs from "node:fs";
import path from "node:path";
const [stateUrl, identityUrl, jobFile] = process.argv.slice(1);
const state = await import(stateUrl);
const { getProcessIdentity, processIdentityMatches } = await import(identityUrl);
const lockDir = jobFile + ".lock";
const token = "a".repeat(32);
const ownerDir = lockDir + ".owner." + token;
const ownerIdentity = getProcessIdentity(process.pid);
const replacedIdentity = { ...ownerIdentity, commandHash: "0".repeat(64) };
fs.mkdirSync(ownerDir);
fs.writeFileSync(path.join(ownerDir, "owner.json"), JSON.stringify({ version: 1, token, ownerPid: process.pid, ownerIdentity: replacedIdentity }) + "\\n");
fs.symlinkSync(path.basename(ownerDir), lockDir, "dir");
const record = state.updateJobRecordFile(jobFile, { revision: 1 });
process.stdout.write(JSON.stringify({ matches: processIdentityMatches(process.pid, replacedIdentity), record, lockExists: fs.existsSync(lockDir), ownerExists: fs.existsSync(ownerDir) }));
`;
  const result = runChildSync(source, [stateModulePath, processIdentityModuleUrl, jobFile]);
  assert.equal(result.status, 0, result.stderr);
  const outcome = JSON.parse(result.stdout);
  assert.equal(outcome.matches, false);
  assert.equal(outcome.record.revision, 1);
  assert.equal(outcome.lockExists, false);
  assert.equal(outcome.ownerExists, false);
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
  const successor = { version: 1, token, ownerPid: process.pid, ownerIdentity: childProcessIdentity(process.pid) };
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

  const result = updateRecordInChild(corruptJob, { revision: 1 }, { GROK_COMPANION_LOCK_TIMEOUT_MS: "100" });
  assert.match(result.message, /Timed out waiting for the job record lock/);
  assert.equal(fs.lstatSync(corruptLock).isSymbolicLink(), true);
  assert.equal(fs.existsSync(corruptOwner), true);
});

test("a held job record lock times out a second acquirer within the configured ceiling", async (t) => {
  const sandbox = makeSandbox(t);
  const jobFile = makeRecord(sandbox, "contended-lock");
  const readyFile = path.join(sandbox.root, "contention-ready");
  const releaseFile = path.join(sandbox.root, "contention-release");
  const waiterReadyFile = path.join(sandbox.root, "contention-waiter-ready");
  const timeoutMs = 150;
  const holder = runChild(heldLockChild, [stateModulePath, jobFile, readyFile, releaseFile]);
  t.after(() => holder.child.kill("SIGKILL"));

  await waitForPath(readyFile);
  const waiter = runChild(lockTimeoutChild, [stateModulePath, jobFile, waiterReadyFile], childEnv({
    GROK_COMPANION_LOCK_TIMEOUT_MS: String(timeoutMs)
  }));
  await waitForPath(waiterReadyFile);
  const result = await waitForCompletion(waiter.completion, timeoutMs + 500);
  assert.equal(result.code, 0, result.stderr);
  const outcome = JSON.parse(result.stdout);
  assert.match(outcome.message, /Timed out waiting for the job record lock at/);
  assert.ok(outcome.elapsedMs >= timeoutMs, `Expected the waiter to wait for at least ${timeoutMs}ms, took ${outcome.elapsedMs}ms.`);
  assert.ok(outcome.elapsedMs <= timeoutMs + 500, `Expected the waiter to finish near ${timeoutMs}ms, took ${outcome.elapsedMs}ms.`);

  fs.writeFileSync(releaseFile, "release\n");
  const holderResult = await holder.completion;
  assert.equal(holderResult.code, 0, holderResult.stderr);
});

test("GROK_COMPANION_LOCK_TIMEOUT_MS overrides the default lock timeout", () => {
  assert.equal(resolveLockTimeoutMs({ GROK_COMPANION_LOCK_TIMEOUT_MS: "1" }), 1);
  assert.equal(resolveLockTimeoutMs({ GROK_COMPANION_LOCK_TIMEOUT_MS: "7500" }), 7500);
});

test("an invalid GROK_COMPANION_LOCK_TIMEOUT_MS falls back to the default", () => {
  assert.equal(resolveLockTimeoutMs({}), DEFAULT_LOCK_TIMEOUT_MS);
  assert.equal(resolveLockTimeoutMs({ GROK_COMPANION_LOCK_TIMEOUT_MS: "invalid" }), DEFAULT_LOCK_TIMEOUT_MS);
  assert.equal(resolveLockTimeoutMs({ GROK_COMPANION_LOCK_TIMEOUT_MS: "0" }), DEFAULT_LOCK_TIMEOUT_MS);
  assert.equal(resolveLockTimeoutMs({ GROK_COMPANION_LOCK_TIMEOUT_MS: "-5" }), DEFAULT_LOCK_TIMEOUT_MS);
  assert.equal(resolveLockTimeoutMs({ GROK_COMPANION_LOCK_TIMEOUT_MS: "1.5" }), DEFAULT_LOCK_TIMEOUT_MS);
});

test("release cleanup failures do not lose a completed update and stale owners are scavenged", (t) => {
  const sandbox = makeSandbox(t);
  const jobFile = makeRecord(sandbox, "release-cleanup");
  const outcome = updateRecordWithCleanupFailureInChild(jobFile);
  const { failedOwnerDir, record: updated } = outcome;
  assert.equal(updated.revision, 1);
  assert.ok(failedOwnerDir);
  assert.equal(fs.existsSync(`${jobFile}.lock`), false);
  assert.equal(fs.existsSync(failedOwnerDir), true, failedOwnerDir);

  const staleTime = new Date(Date.now() - 11000);
  fs.utimesSync(failedOwnerDir, staleTime, staleTime);
  assert.equal(updateRecordInChild(jobFile, { revision: 2 }).record.revision, 2);
  assert.equal(fs.existsSync(failedOwnerDir), false);
});
