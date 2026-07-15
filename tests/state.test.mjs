import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { envFor, makeSandbox, runCompanion, stateModulePath } from "./lib/companion-harness.mjs";
import { getProcessIdentity } from "../plugins/grok/scripts/lib/process-identity.mjs";

function sha256Hex(value) {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const { createHash } = require('node:crypto'); process.stdout.write(createHash('sha256').update(process.argv[1]).digest('hex'));",
      value,
    ],
    { encoding: "utf8" },
  );
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function expectedSlug(cwd) {
  return `${path.basename(cwd)}-${sha256Hex(cwd).slice(0, 16)}`;
}

function workspaceDirs(dataDir) {
  const stateDir = path.join(dataDir, "state");
  if (!fs.existsSync(stateDir)) return [];
  return fs.readdirSync(stateDir).sort();
}

function jobCount(dataDir, slug) {
  const jobsDir = path.join(dataDir, "state", slug, "jobs");
  if (!fs.existsSync(jobsDir)) return 0;
  return fs.readdirSync(jobsDir).filter((name) => name.endsWith(".json")).length;
}

async function waitForFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${file}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("workspace slug is deterministic for a given cwd and distinct across cwds", (t) => {
  const sandbox = makeSandbox(t);
  const otherDir = path.join(sandbox.root, "other");
  fs.mkdirSync(otherDir);
  const env = envFor(sandbox);
  const first = runCompanion(["task", "first run"], { cwd: sandbox.workDir, env });
  assert.strictEqual(first.status, 0, first.stderr);
  const workSlug = expectedSlug(sandbox.workDir);
  assert.match(workSlug, /^work-[0-9a-f]{16}$/);
  assert.deepStrictEqual(workspaceDirs(sandbox.dataDir), [workSlug]);
  const second = runCompanion(["task", "second run"], { cwd: sandbox.workDir, env });
  assert.strictEqual(second.status, 0, second.stderr);
  assert.deepStrictEqual(workspaceDirs(sandbox.dataDir), [workSlug]);
  assert.strictEqual(jobCount(sandbox.dataDir, workSlug), 2);
  const third = runCompanion(["task", "third run"], { cwd: otherDir, env });
  assert.strictEqual(third.status, 0, third.stderr);
  const otherSlug = expectedSlug(otherDir);
  assert.deepStrictEqual(workspaceDirs(sandbox.dataDir), [otherSlug, workSlug].sort());
  assert.strictEqual(jobCount(sandbox.dataDir, otherSlug), 1);
});

test("relative GROK_COMPANION_DATA overrides are rejected", async () => {
  const stateModule = await import(stateModulePath);
  let error;
  assert.throws(
    () => stateModule.resolveDataDir({ GROK_COMPANION_DATA: "relative/data" }),
    (caught) => {
      error = caught;
      return /GROK_COMPANION_DATA must be an absolute path/.test(caught.message);
    },
  );
  assert.strictEqual(error.failureKind, "input");
});

test("job ids are 128-bit lowercase hexadecimal values", async () => {
  const stateModule = await import(stateModulePath);
  const ids = Array.from({ length: 64 }, () => stateModule.generateJobId());
  assert.ok(ids.every((id) => /^[0-9a-f]{32}$/.test(id)));
  assert.strictEqual(new Set(ids).size, ids.length);
});

test("creating a job record never overwrites an existing record", async (t) => {
  const sandbox = makeSandbox(t);
  const stateModule = await import(stateModulePath);
  const jobId = stateModule.generateJobId();
  const jobFile = stateModule.jobFilePath(sandbox.dataDir, sandbox.workDir, jobId);
  const first = stateModule.createJobRecord({
    id: jobId,
    mode: "consult",
    cwd: sandbox.workDir,
    briefFile: path.join(sandbox.dataDir, "first.md"),
    background: false,
  });
  stateModule.createJobRecordFile(jobFile, first);

  let error;
  assert.throws(
    () => stateModule.createJobRecordFile(jobFile, { ...first, mode: "write" }),
    (caught) => {
      error = caught;
      return /already exists/.test(caught.message);
    },
  );
  assert.strictEqual(error.failureKind, "resource");
  assert.deepStrictEqual(stateModule.readJobRecordFile(jobFile), first);
});

test("a running resume owner holds the workspace lease until it becomes terminal", async (t) => {
  const sandbox = makeSandbox(t);
  const stateModule = await import(stateModulePath);
  const sessionId = "22222222-2222-7222-8222-222222222222";
  const firstJobId = stateModule.generateJobId();
  const secondJobId = stateModule.generateJobId();
  for (const jobId of [firstJobId, secondJobId]) {
    stateModule.createJobRecordFile(
      stateModule.jobFilePath(sandbox.dataDir, sandbox.workDir, jobId),
      stateModule.createJobRecord({
        id: jobId,
        mode: "consult",
        cwd: sandbox.workDir,
        briefFile: path.join(sandbox.dataDir, `${jobId}.md`),
        background: false,
      }),
    );
  }

  const firstLease = stateModule.claimResumeSessionLease(sandbox.dataDir, sandbox.workDir, sessionId, firstJobId);
  assert.strictEqual(firstLease.ownerJobId, firstJobId);
  let error;
  assert.throws(
    () => stateModule.claimResumeSessionLease(sandbox.dataDir, sandbox.workDir, sessionId, secondJobId),
    (caught) => {
      error = caught;
      return caught.message.includes(firstJobId);
    },
  );
  assert.strictEqual(error.failureKind, "resource");

  stateModule.updateJobRecordFile(stateModule.jobFilePath(sandbox.dataDir, sandbox.workDir, firstJobId), {
    status: "done",
    finishedAt: stateModule.nowIso(),
  });
  const reclaimed = stateModule.claimResumeSessionLease(sandbox.dataDir, sandbox.workDir, sessionId, secondJobId);
  assert.strictEqual(reclaimed.ownerJobId, secondJobId);
  assert.deepStrictEqual(stateModule.readJobRecordFile(stateModule.resumeSessionLeasePath(sandbox.dataDir, sandbox.workDir, sessionId)), reclaimed);
});

test("a dead resume owner is repaired before the workspace lease is reclaimed", async (t) => {
  const sandbox = makeSandbox(t);
  const stateModule = await import(stateModulePath);
  const sessionId = "44444444-4444-7444-8444-444444444444";
  const firstJobId = stateModule.generateJobId();
  const secondJobId = stateModule.generateJobId();
  const firstFile = stateModule.jobFilePath(sandbox.dataDir, sandbox.workDir, firstJobId);
  stateModule.createJobRecordFile(
    firstFile,
    stateModule.createJobRecord({
      id: firstJobId,
      pid: 2147483647,
      mode: "consult",
      cwd: sandbox.workDir,
      briefFile: path.join(sandbox.dataDir, `${firstJobId}.md`),
      background: false,
      createdAt: new Date(Date.now() - 60000).toISOString(),
    }),
  );
  stateModule.createJobRecordFile(
    stateModule.jobFilePath(sandbox.dataDir, sandbox.workDir, secondJobId),
    stateModule.createJobRecord({
      id: secondJobId,
      mode: "consult",
      cwd: sandbox.workDir,
      briefFile: path.join(sandbox.dataDir, `${secondJobId}.md`),
      background: false,
    }),
  );

  stateModule.claimResumeSessionLease(sandbox.dataDir, sandbox.workDir, sessionId, firstJobId);
  const reclaimed = stateModule.claimResumeSessionLease(sandbox.dataDir, sandbox.workDir, sessionId, secondJobId);
  const repaired = stateModule.readJobRecordFile(firstFile);

  assert.strictEqual(reclaimed.ownerJobId, secondJobId);
  assert.strictEqual(repaired.status, "error");
  assert.strictEqual(repaired.failureKind, "died");
  assert.match(repaired.errorMessage, new RegExp(sessionId));
});

test("a live descendant process group prevents resume lease repair", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups are required.");
    return;
  }
  const sandbox = makeSandbox(t);
  const leader = spawn("/bin/sh", ["-c", "sleep 30 &"], {
    detached: true,
    stdio: "ignore",
  });
  const leaderPid = leader.pid;
  await once(leader, "close");
  const groupAlive = () => {
    try {
      process.kill(-leaderPid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.strictEqual(groupAlive(), true);
  t.after(() => {
    try {
      process.kill(-leaderPid, "SIGKILL");
    } catch {}
  });

  const stateModule = await import(stateModulePath);
  const sessionId = "55555555-5555-7555-8555-555555555555";
  const firstJobId = stateModule.generateJobId();
  const secondJobId = stateModule.generateJobId();
  const firstFile = stateModule.jobFilePath(sandbox.dataDir, sandbox.workDir, firstJobId);
  stateModule.createJobRecordFile(
    firstFile,
    stateModule.createJobRecord({
      id: firstJobId,
      pid: leaderPid,
      pidIdentity: null,
      mode: "write",
      cwd: sandbox.workDir,
      briefFile: path.join(sandbox.dataDir, `${firstJobId}.md`),
      background: true,
      createdAt: new Date(Date.now() - 60000).toISOString(),
    }),
  );
  stateModule.createJobRecordFile(
    stateModule.jobFilePath(sandbox.dataDir, sandbox.workDir, secondJobId),
    stateModule.createJobRecord({
      id: secondJobId,
      mode: "write",
      cwd: sandbox.workDir,
      briefFile: path.join(sandbox.dataDir, `${secondJobId}.md`),
      background: false,
    }),
  );

  stateModule.claimResumeSessionLease(sandbox.dataDir, sandbox.workDir, sessionId, firstJobId);
  assert.throws(
    () => stateModule.claimResumeSessionLease(sandbox.dataDir, sandbox.workDir, sessionId, secondJobId),
    (error) => error.failureKind === "resource" && error.message.includes(firstJobId),
  );
  assert.strictEqual(stateModule.readJobRecordFile(firstFile).status, "running");
  assert.strictEqual(groupAlive(), true);
});

test("a live resume owner blocks lease repair when its identity probe is unavailable", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process paths are required.");
    return;
  }
  const sandbox = makeSandbox(t);
  const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  const identity = getProcessIdentity(child.pid);
  if (!identity) {
    child.kill("SIGKILL");
    await once(child, "close");
    t.skip("Process identity probing is unavailable.");
    return;
  }
  t.after(() => {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {}
  });

  const stateModule = await import(stateModulePath);
  const sessionId = "66666666-6666-7666-8666-666666666666";
  const firstJobId = stateModule.generateJobId();
  const secondJobId = stateModule.generateJobId();
  const firstFile = stateModule.jobFilePath(sandbox.dataDir, sandbox.workDir, firstJobId);
  stateModule.createJobRecordFile(
    firstFile,
    {
      ...stateModule.createJobRecord({
        id: firstJobId,
        mode: "write",
        cwd: sandbox.workDir,
        briefFile: path.join(sandbox.dataDir, `${firstJobId}.md`),
        background: true,
        createdAt: new Date(Date.now() - 60000).toISOString(),
      }),
      grokPid: child.pid,
      grokPidIdentity: identity,
    },
  );
  stateModule.createJobRecordFile(
    stateModule.jobFilePath(sandbox.dataDir, sandbox.workDir, secondJobId),
    stateModule.createJobRecord({
      id: secondJobId,
      mode: "write",
      cwd: sandbox.workDir,
      briefFile: path.join(sandbox.dataDir, `${secondJobId}.md`),
      background: false,
    }),
  );

  stateModule.claimResumeSessionLease(sandbox.dataDir, sandbox.workDir, sessionId, firstJobId);
  const probePath = path.join(sandbox.root, "probe-path");
  fs.mkdirSync(probePath);
  fs.writeFileSync(
    path.join(probePath, "ps"),
    `#!/bin/sh
pid=""
format=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-p" ]; then
    shift
    pid="$1"
  fi
  case "$1" in
    lstart=|command=) format="$1" ;;
  esac
  shift
done
if [ "$pid" = "${child.pid}" ]; then
  exit 1
fi
if [ "$format" = "lstart=" ]; then
  printf '%s\\n' 'Thu Jan  1 00:00:00 1970'
else
  printf 'process %s\\n' "$pid"
fi
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(probePath, "sysctl"),
    "#!/bin/sh\nprintf '%s\\n' 'kern.boottime: { sec = 1, usec = 0 } Sun Jan  1 00:00:01 1970'\n",
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = probePath;
    assert.strictEqual(getProcessIdentity(child.pid), null);
    assert.throws(
      () => stateModule.claimResumeSessionLease(sandbox.dataDir, sandbox.workDir, sessionId, secondJobId),
      (error) => error.failureKind === "resource" && error.message.includes(firstJobId),
    );
    assert.strictEqual(stateModule.readJobRecordFile(firstFile).status, "running");
  } finally {
    process.env.PATH = previousPath;
  }

  const closed = once(child, "close");
  child.kill("SIGKILL");
  await closed;
  const reclaimed = stateModule.claimResumeSessionLease(sandbox.dataDir, sandbox.workDir, sessionId, secondJobId);
  const repaired = stateModule.readJobRecordFile(firstFile);
  assert.strictEqual(reclaimed.ownerJobId, secondJobId);
  assert.strictEqual(repaired.status, "error");
  assert.strictEqual(repaired.failureKind, "died");
});

test("a resume lease fails closed when its owner record disappears", async (t) => {
  const sandbox = makeSandbox(t);
  const stateModule = await import(stateModulePath);
  const sessionId = "33333333-3333-7333-8333-333333333333";
  const firstJobId = stateModule.generateJobId();
  const secondJobId = stateModule.generateJobId();
  for (const jobId of [firstJobId, secondJobId]) {
    stateModule.createJobRecordFile(
      stateModule.jobFilePath(sandbox.dataDir, sandbox.workDir, jobId),
      stateModule.createJobRecord({
        id: jobId,
        mode: "consult",
        cwd: sandbox.workDir,
        briefFile: path.join(sandbox.dataDir, `${jobId}.md`),
        background: false,
      }),
    );
  }
  stateModule.claimResumeSessionLease(sandbox.dataDir, sandbox.workDir, sessionId, firstJobId);
  fs.rmSync(stateModule.jobFilePath(sandbox.dataDir, sandbox.workDir, firstJobId));

  let error;
  assert.throws(
    () => stateModule.claimResumeSessionLease(sandbox.dataDir, sandbox.workDir, sessionId, secondJobId),
    (caught) => {
      error = caught;
      return /invalid owner record/.test(caught.message);
    },
  );
  assert.strictEqual(error.failureKind, "resource");
});

test("state module exports a slug function implementing the pinned formula", async () => {
  const stateModule = await import(stateModulePath);
  const sample = "/opt/projects/sample-app";
  const expected = expectedSlug(sample);
  const mutatingName = (name) =>
    ["write", "update", "append"].some((prefix) => name.startsWith(prefix));
  const exportedFunctions = [];
  for (const [name, value] of Object.entries(stateModule)) {
    if (mutatingName(name)) continue;
    if (typeof value === "function") exportedFunctions.push(value);
    else if (value && typeof value === "object") {
      for (const [innerName, inner] of Object.entries(value)) {
        if (mutatingName(innerName)) continue;
        if (typeof inner === "function") exportedFunctions.push(inner);
      }
    }
  }
  const slugFn = exportedFunctions.find((candidate) => {
    try {
      return candidate(sample) === expected;
    } catch {
      return false;
    }
  });
  assert.ok(slugFn, "No export of state.mjs computes the pinned workspace slug.");
  assert.strictEqual(slugFn(sample), slugFn(sample));
  assert.strictEqual(slugFn("/opt/projects/other-app"), expectedSlug("/opt/projects/other-app"));
  assert.notStrictEqual(slugFn("/opt/projects/other-app"), slugFn(sample));
});

test("terminal job records do not regress to another terminal state", async (t) => {
  const sandbox = makeSandbox(t);
  const stateModule = await import(stateModulePath);
  const jobFile = stateModule.jobFilePath(sandbox.dataDir, sandbox.workDir, "terminal");
  const record = stateModule.createJobRecord({
    id: "terminal",
    pid: 123,
    mode: "consult",
    cwd: sandbox.workDir,
    briefFile: path.join(sandbox.dataDir, "brief.md"),
    background: false,
  });
  stateModule.writeJobRecordFile(jobFile, {
    ...record,
    status: "cancelled",
    pid: null,
    grokPid: null,
    finishedAt: stateModule.nowIso(),
    failureKind: "cancelled",
  });
  const updated = stateModule.updateJobRecordFile(jobFile, {
    status: "done",
    exitCode: 0,
    resultText: "late success",
    failureKind: null,
  });
  assert.strictEqual(updated.status, "cancelled");
  assert.strictEqual(updated.failureKind, "cancelled");
  assert.strictEqual(stateModule.readJobRecordFile(jobFile).status, "cancelled");
  const pidPatch = stateModule.updateJobRecordFile(jobFile, { pid: 999 });
  assert.strictEqual(pidPatch.pid, null);
});

test("managed collection records delivery without changing the terminal outcome", async (t) => {
  const sandbox = makeSandbox(t);
  const stateModule = await import(stateModulePath);
  const jobFile = stateModule.jobFilePath(sandbox.dataDir, sandbox.workDir, "managed-terminal");
  const record = stateModule.createJobRecord({
    id: "managed-terminal",
    pid: null,
    mode: "consult",
    cwd: sandbox.workDir,
    briefFile: path.join(sandbox.dataDir, "brief.md"),
    background: true,
    delivery: "managed",
  });
  stateModule.writeJobRecordFile(jobFile, {
    ...record,
    status: "done",
    finishedAt: stateModule.nowIso(),
    exitCode: 0,
    resultText: "terminal result",
  });

  const first = stateModule.markManagedDeliveryCollectedFile(jobFile, "2026-07-15T00:00:00.000Z");
  const second = stateModule.markManagedDeliveryCollectedFile(jobFile, "2026-07-15T00:01:00.000Z");
  assert.strictEqual(first.status, "done");
  assert.strictEqual(first.resultText, "terminal result");
  assert.strictEqual(first.deliveryCollectedAt, "2026-07-15T00:00:00.000Z");
  assert.strictEqual(second.deliveryCollectedAt, first.deliveryCollectedAt);
});

test("an abandoned record lock older than ten seconds is reaped", async (t) => {
  const sandbox = makeSandbox(t);
  const stateModule = await import(stateModulePath);
  const jobFile = stateModule.jobFilePath(sandbox.dataDir, sandbox.workDir, "stale-lock");
  const record = stateModule.createJobRecord({
    id: "stale-lock",
    pid: process.pid,
    mode: "consult",
    cwd: sandbox.workDir,
    briefFile: path.join(sandbox.dataDir, "brief.md"),
    background: false,
  });
  stateModule.writeJobRecordFile(jobFile, record);
  const lockDir = `${jobFile}.lock`;
  fs.mkdirSync(lockDir);
  const staleTime = new Date(Date.now() - 11000);
  fs.utimesSync(lockDir, staleTime, staleTime);

  const updated = stateModule.updateJobRecordFile(jobFile, { grokPid: 12345 });

  assert.strictEqual(updated.grokPid, 12345);
  assert.strictEqual(fs.existsSync(lockDir), false);
  assert.strictEqual(stateModule.readJobRecordFile(jobFile).grokPid, 12345);
});

test("a record lock owned by a killed process is reclaimed without an age delay", async (t) => {
  const sandbox = makeSandbox(t);
  const stateModule = await import(stateModulePath);
  const jobFile = stateModule.jobFilePath(sandbox.dataDir, sandbox.workDir, "killed-lock-owner");
  const record = stateModule.createJobRecord({
    id: "killed-lock-owner",
    pid: process.pid,
    mode: "consult",
    cwd: sandbox.workDir,
    briefFile: path.join(sandbox.dataDir, "brief.md"),
    background: false,
  });
  stateModule.writeJobRecordFile(jobFile, record);
  const readyFile = path.join(sandbox.root, "lock-ready");
  const source = `
import fs from "node:fs";
const [stateUrl, jobFile, readyFile] = process.argv.slice(1);
const state = await import(stateUrl);
state.updateJobRecordFileWithCurrent(jobFile, (current) => {
  fs.writeFileSync(readyFile, "ready");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  return current;
});
`;
  const holder = spawn(process.execPath, ["--input-type=module", "--eval", source, stateModulePath, jobFile, readyFile], { stdio: "ignore" });
  t.after(() => {
    try {
      holder.kill("SIGKILL");
    } catch {}
  });
  await waitForFile(readyFile);
  holder.kill("SIGKILL");
  await once(holder, "close");

  const startedAt = Date.now();
  const updated = stateModule.updateJobRecordFile(jobFile, { grokPid: 54321 });

  assert.ok(Date.now() - startedAt < 1000);
  assert.strictEqual(updated.grokPid, 54321);
  assert.strictEqual(fs.existsSync(`${jobFile}.lock`), false);
});
