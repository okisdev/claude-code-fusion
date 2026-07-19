import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createJobRecord,
  jobEventsPath,
  jobFilePath,
  jobLogPath,
  readJobRecordFile,
  resolveDataDir,
  writeBrief,
  writeJobRecordFile
} from "../plugins/codex/scripts/lib/state.mjs";
import { spawnBackgroundWorker } from "../plugins/codex/scripts/codex-companion.mjs";
import { getProcessIdentity } from "../plugins/codex/scripts/lib/codex-exec.mjs";
import {
  envFor,
  makeSandbox,
  runCompanion,
  spawnCompanion,
  waitFor
} from "./lib/codex-companion-harness.mjs";

function childResult(child) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
}

function createBackgroundJob(sandbox, env, id) {
  const dataDir = resolveDataDir(env);
  const briefFile = writeBrief(dataDir, sandbox.workDir, id, "wait indefinitely");
  const record = createJobRecord({
    id,
    background: true,
    briefFile,
    cwd: sandbox.workDir,
    eventsFile: jobEventsPath(dataDir, sandbox.workDir, id),
    logFile: jobLogPath(dataDir, sandbox.workDir, id),
    phase: "queued",
    request: { transport: "task", write: false, web: false, network: false }
  });
  const file = jobFilePath(dataDir, sandbox.workDir, id);
  writeJobRecordFile(file, record);
  return { file, record };
}

function cancelWithLockRetry(args, options) {
  const deadline = Date.now() + 12000;
  let result = runCompanion(args, options);
  while (
    result.status !== 0 &&
    /Timed out waiting for the job record lock/.test(result.stderr) &&
    Date.now() < deadline
  ) {
    result = runCompanion(args, options);
  }
  return result;
}

test("a parent identity probe failure adopts the worker claimed identity before cleanup", async (t) => {
  const sandbox = makeSandbox(t);
  const readyFile = path.join(sandbox.root, "claimed-worker-codex-ready");
  const env = envFor(sandbox, { FAKE_CODEX_MODE: "hang", FAKE_CODEX_READY_FILE: readyFile });
  const { file, record } = createBackgroundJob(sandbox, env, "claimed-worker-race");
  const outcome = await spawnBackgroundWorker(
    { file, record },
    {
      env,
      identityReader: () => null,
      beforeIdentityProbe: async (pid) => waitFor(() => {
        const current = readJobRecordFile(file);
        return current?.pid === pid && current.pidIdentity ? current : null;
      }, { timeout: 8000 })
    }
  );
  assert.notEqual(outcome.phase, "cleanup-required", JSON.stringify(outcome));
  assert.ok(outcome.status === "error" || outcome.status === "cancelled");
  assert.equal(outcome.pid, null);
  assert.equal(outcome.codexPid, null);
  assert.equal(fs.existsSync(readyFile), false);
});

test("a parent identity probe failure before worker claim prevents Codex from spawning", async (t) => {
  const sandbox = makeSandbox(t);
  const readyFile = path.join(sandbox.root, "unclaimed-worker-codex-ready");
  const env = envFor(sandbox, { FAKE_CODEX_MODE: "hang", FAKE_CODEX_READY_FILE: readyFile });
  const { file, record } = createBackgroundJob(sandbox, env, "unclaimed-worker-race");
  const outcome = await spawnBackgroundWorker({ file, record }, { env, identityReader: () => null });
  assert.notEqual(outcome.phase, "cleanup-required");
  assert.ok(outcome.status === "error" || outcome.status === "cancelled");
  assert.equal(outcome.pid, null);
  assert.equal(outcome.codexPid, null);
  assert.equal(fs.existsSync(readyFile), false);
});

test("a worker whose launcher exits before approval never starts Codex", async (t) => {
  const sandbox = makeSandbox(t);
  const readyFile = path.join(sandbox.root, "unapproved-codex-ready");
  const env = envFor(sandbox, {
    CODEX_COMPANION_LAUNCH_APPROVAL_TIMEOUT_MS: "50",
    FAKE_CODEX_MODE: "hang",
    FAKE_CODEX_READY_FILE: readyFile
  });
  const { file } = createBackgroundJob(sandbox, env, "approval-timeout");
  const result = await childResult(spawnCompanion(["worker", "--job-id", "approval-timeout", "--cwd", sandbox.workDir], { cwd: sandbox.workDir, env }));
  assert.equal(result.code, 1, result.stderr);
  const completed = readJobRecordFile(file);
  assert.equal(completed.status, "error");
  assert.equal(completed.failureKind, "timeout");
  assert.equal(completed.pid, null);
  assert.equal(completed.codexPid, null);
  assert.equal(fs.existsSync(readyFile), false);
});

test("a failure after durable launch approval leaves the worker in control", async (t) => {
  const sandbox = makeSandbox(t);
  const readyFile = path.join(sandbox.root, "approved-worker-codex-ready");
  const env = envFor(sandbox, { FAKE_CODEX_MODE: "hang", FAKE_CODEX_READY_FILE: readyFile });
  const { file, record } = createBackgroundJob(sandbox, env, "approved-worker-handoff");
  const outcome = await spawnBackgroundWorker(
    { file, record },
    {
      env,
      afterLaunchApproval: async () => {
        await waitFor(() => readJobRecordFile(file)?.codexPidIdentity && fs.existsSync(readyFile), { timeout: 8000 });
        throw new Error("receipt rendering failed");
      }
    }
  );
  assert.equal(outcome.status, "running");
  assert.ok(outcome.launchApprovedAt);
  assert.equal(outcome.launchAbortRequestedAt, null);
  assert.ok(readJobRecordFile(file)?.codexPidIdentity);
  const cancelled = cancelWithLockRetry(["cancel", "approved-worker-handoff", "--cwd", sandbox.workDir], { cwd: sandbox.workDir, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const completed = readJobRecordFile(file);
  assert.equal(completed.status, "cancelled");
  assert.equal(completed.pid, null);
  assert.equal(completed.codexPid, null);
});

test("a lock release failure after durable approval cannot abort the verified worker", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_CODEX_MODE: "hang" });
  const { file, record } = createBackgroundJob(sandbox, env, "durable-approval-release-failure");
  const originalRmSync = fs.rmSync;
  let injected = false;
  fs.rmSync = function rmSyncWithReleaseFailure(target, ...args) {
    if (!injected && typeof target === "string" && target.startsWith(`${file}.lock.owner.`) && readJobRecordFile(file)?.launchApprovedAt) {
      injected = true;
      const error = new Error("injected lock release failure");
      error.code = "EIO";
      throw error;
    }
    return originalRmSync.call(this, target, ...args);
  };
  let outcome;
  let identityReads = 0;
  try {
    outcome = await spawnBackgroundWorker(
      { file, record },
      {
        env,
        identityReader: (pid) => {
          identityReads += 1;
          return identityReads === 1 ? getProcessIdentity(pid) : null;
        }
      }
    );
  } finally {
    fs.rmSync = originalRmSync;
  }
  assert.equal(injected, true);
  assert.equal(identityReads, 2);
  assert.equal(outcome.status, "running");
  assert.ok(outcome.launchApprovedAt);
  assert.equal(outcome.launchAbortRequestedAt, null);
  await waitFor(() => readJobRecordFile(file)?.codexPidIdentity, { timeout: 8000 });
  const cancelled = cancelWithLockRetry(["cancel", "durable-approval-release-failure", "--cwd", sandbox.workDir], { cwd: sandbox.workDir, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const completed = readJobRecordFile(file);
  assert.equal(completed.status, "cancelled");
  assert.equal(completed.pid, null);
  assert.equal(completed.codexPid, null);
});
