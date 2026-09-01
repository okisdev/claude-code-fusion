import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { envFor, killGroups, makeSandbox, pidAlive, repoRoot, waitFor } from "./lib/companion-harness.mjs";

const { runGrok, runtimeSocketEndpoints, runtimeSocketSymlinkEndpoints } = await import(path.join(repoRoot, "plugins", "grok", "scripts", "lib", "grok-exec.mjs"));
const {
  createJobRecord,
  createJobRecordFile,
  jobFilePath,
  launchRunningJobProcess,
  readJobRecordFile,
  updateJobRecordFile,
} = await import(path.join(repoRoot, "plugins", "grok", "scripts", "lib", "state.mjs"));

function runOptions(sandbox, fields = {}) {
  const briefFile = path.join(sandbox.root, "brief.md");
  fs.writeFileSync(briefFile, "supervise the child\n", "utf8");
  return {
    briefFile,
    mode: "consult",
    cwd: sandbox.workDir,
    logFile: path.join(sandbox.root, "grok.log"),
    timeoutMs: 5000,
    env: envFor(sandbox, { FAKE_GROK_MODE: "hang" }),
    ...fields,
  };
}

function createRunningJobFile(sandbox, id) {
  const file = jobFilePath(sandbox.dataDir, sandbox.workDir, id);
  createJobRecordFile(file, createJobRecord({
    id,
    pid: process.pid,
    mode: "consult",
    cwd: sandbox.workDir,
    briefFile: path.join(sandbox.root, "brief.md"),
    background: false,
  }));
  return file;
}

test("managed runs reject runtime-socket symlinks before spawn", (t) => {
  const sandbox = makeSandbox(t);
  const missingEndpoint = path.join(sandbox.root, "missing.sock");
  const regularEndpoint = path.join(sandbox.root, "regular.sock");
  const symlinkEndpoint = path.join(sandbox.root, "symlink.sock");
  fs.writeFileSync(regularEndpoint, "socket fixture\n", "utf8");
  fs.symlinkSync(regularEndpoint, symlinkEndpoint);

  assert.deepEqual(runtimeSocketSymlinkEndpoints([missingEndpoint, regularEndpoint]), []);
  const env = envFor(sandbox, {
    FAKE_GROK_MODE: "hang",
    GROK_COMPANION_RUNTIME_SOCKET_CANDIDATES: [missingEndpoint, regularEndpoint, symlinkEndpoint].join(":")
  });
  assert.deepEqual(runtimeSocketEndpoints({ env }), [missingEndpoint, regularEndpoint, symlinkEndpoint]);

  let launchCalled = false;
  assert.throws(
    () => runGrok(runOptions(sandbox, {
      env,
      launchProcess: () => {
        launchCalled = true;
      }
    })),
    (error) => {
      assert.equal(error.failureKind, "sandbox");
      assert.match(error.message, new RegExp(symlinkEndpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(error.message, /runtime-socket deny policy, 1\.0\.4 through 1\.0\.13/);
      assert.match(error.message, /Do not downgrade the sandbox/);
      return true;
    }
  );
  assert.equal(launchCalled, false);
  assert.equal(fs.existsSync(sandbox.argsFile), false);
});

test("the production launch gate prevents spawning after cancellation wins", async (t) => {
  const sandbox = makeSandbox(t);
  const jobFile = createRunningJobFile(sandbox, "cancelled-before-launch");
  updateJobRecordFile(jobFile, { cancelRequestedAt: new Date().toISOString() });
  let launchCalled = false;

  await assert.rejects(
    runGrok(runOptions(sandbox, {
      launchProcess: (launch) => launchRunningJobProcess(jobFile, () => {
        launchCalled = true;
        return launch();
      }),
    })),
    /cancellation was already requested/,
  );

  assert.equal(launchCalled, false);
  assert.equal(fs.existsSync(sandbox.argsFile), false);
});

test("the worker launch gate prevents spawning after cancellation wins", (t) => {
  const sandbox = makeSandbox(t);
  const jobFile = createRunningJobFile(sandbox, "cancelled-before-worker-launch");
  updateJobRecordFile(jobFile, { cancelRequestedAt: new Date().toISOString() });
  let launchCalled = false;

  assert.throws(
    () => launchRunningJobProcess(
      jobFile,
      () => {
        launchCalled = true;
        return { pid: process.pid, identity: null };
      },
      { processRole: "worker" },
    ),
    (error) => {
      assert.match(error.message, /cancellation was already requested/);
      assert.equal(error.processRole, "worker");
      return true;
    },
  );

  assert.equal(launchCalled, false);
  assert.equal(readJobRecordFile(jobFile).pid, process.pid);
});

test("the launch gate preserves cleanup ownership when cleanup is already required", (t) => {
  const sandbox = makeSandbox(t);
  const jobFile = createRunningJobFile(sandbox, "cleanup-before-launch");
  const identity = readJobRecordFile(jobFile).pidIdentity;
  updateJobRecordFile(jobFile, { cleanupRequired: true });
  let launchCalled = false;

  assert.throws(
    () => launchRunningJobProcess(
      jobFile,
      () => {
        launchCalled = true;
        return { pid: process.pid, identity };
      },
      { processRole: "worker" },
    ),
    (error) => {
      assert.match(error.message, /process cleanup is still required/);
      assert.equal(error.cleanupRequired, true);
      assert.equal(error.processRole, "worker");
      assert.equal(error.pid, process.pid);
      assert.deepEqual(error.pidIdentity, identity);
      return true;
    },
  );

  assert.equal(launchCalled, false);
});

test("the worker launch gate publishes worker ownership while holding the record lock", (t) => {
  const sandbox = makeSandbox(t);
  const jobFile = createRunningJobFile(sandbox, "atomic-worker-publication");
  const identity = readJobRecordFile(jobFile).pidIdentity;
  updateJobRecordFile(jobFile, { pid: null, pidIdentity: null });
  let lockHeld = false;

  const launched = launchRunningJobProcess(
    jobFile,
    () => {
      lockHeld = fs.lstatSync(`${jobFile}.lock`).isSymbolicLink();
      return { pid: process.pid, identity };
    },
    { processRole: "worker" },
  );
  const published = readJobRecordFile(jobFile);

  assert.equal(lockHeld, true);
  assert.equal(launched.record.pid, process.pid);
  assert.deepEqual(published.pidIdentity, identity);
  assert.equal(published.grokPid, null);
});

test("the production launch gate publishes the PID before returning control", async (t) => {
  const sandbox = makeSandbox(t);
  const jobFile = createRunningJobFile(sandbox, "atomic-pid-publication");
  let pid = null;
  t.after(() => killGroups(pid));

  const running = runGrok(runOptions(sandbox, {
    launchProcess: (launch) => launchRunningJobProcess(jobFile, launch),
  }));
  const published = readJobRecordFile(jobFile);
  pid = published.grokPid;

  assert.ok(pid > 1);
  assert.ok(published.grokPidIdentity);
  killGroups(pid);
  await running;
  await waitFor(() => (pidAlive(pid) ? null : true));
});

test("a production PID publication error still terminates the launched process", async (t) => {
  const sandbox = makeSandbox(t);
  const jobFile = createRunningJobFile(sandbox, "atomic-publication-failure");
  const jobsDirectory = path.dirname(jobFile);
  const displacedDirectory = `${jobsDirectory}.displaced`;
  let pid = null;
  let displaced = false;
  t.after(() => killGroups(pid));

  try {
    await assert.rejects(
      runGrok(runOptions(sandbox, {
        launchProcess: (launch) => launchRunningJobProcess(jobFile, () => {
          const launched = launch();
          pid = launched.pid;
          fs.renameSync(jobsDirectory, displacedDirectory);
          fs.writeFileSync(jobsDirectory, "block state publication\n", "utf8");
          displaced = true;
          return launched;
        }),
      })),
    );
  } finally {
    if (displaced) {
      fs.rmSync(jobsDirectory, { force: true });
      fs.renameSync(displacedDirectory, jobsDirectory);
    }
  }

  assert.ok(pid > 1);
  await waitFor(() => (pidAlive(pid) ? null : true));
});

test("an onSpawn persistence error terminates the detached Grok process before rejection", async (t) => {
  const sandbox = makeSandbox(t);
  let pid = null;
  t.after(() => killGroups(pid));

  await assert.rejects(
    runGrok(runOptions(sandbox, {
      onSpawn: (spawnedPid) => {
        pid = spawnedPid;
        throw new Error("simulated state write failure");
      },
    })),
    /simulated state write failure/,
  );

  assert.ok(pid > 1);
  await waitFor(() => (pidAlive(pid) ? null : true));
});

test("a terminal publication race terminates the detached Grok process", async (t) => {
  const sandbox = makeSandbox(t);
  let pid = null;
  t.after(() => killGroups(pid));

  await assert.rejects(
    runGrok(runOptions(sandbox, {
      onSpawn: (spawnedPid) => {
        pid = spawnedPid;
        return { id: "cancelled-job", status: "cancelled", failureKind: "cancelled" };
      },
    })),
    /already cancelled/,
  );

  assert.ok(pid > 1);
  await waitFor(() => (pidAlive(pid) ? null : true));
});

test("a log persistence error terminates the detached Grok process before rejection", async (t) => {
  const sandbox = makeSandbox(t);
  const logFile = path.join(sandbox.root, "log-directory");
  fs.mkdirSync(logFile);
  let pid = null;
  t.after(() => killGroups(pid));

  await assert.rejects(
    runGrok(runOptions(sandbox, {
      env: envFor(sandbox, { FAKE_GROK_MODE: "stderr-hang" }),
      logFile,
      onSpawn: (spawnedPid) => {
        pid = spawnedPid;
      },
    })),
  );

  assert.ok(pid > 1);
  await waitFor(() => (pidAlive(pid) ? null : true));
});

test("a fresh child without captured identity still escalates sandbox failure cleanup", async (t) => {
  const sandbox = makeSandbox(t);
  let pid = null;
  t.after(() => killGroups(pid));

  const result = await runGrok(runOptions(sandbox, {
    env: envFor(sandbox, { FAKE_GROK_MODE: "sandbox-warning-ignore-term" }),
    captureProcessIdentity: () => null,
    onSpawn: (spawnedPid) => {
      pid = spawnedPid;
    },
  }));

  assert.ok(pid > 1);
  assert.match(result.errorMessage, /sandbox enforcement failed/i);
  assert.equal(result.exitCode, 137);
  await waitFor(() => (pidAlive(pid) ? null : true));
});
