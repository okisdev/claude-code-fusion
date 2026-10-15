import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  recordedProcessGroupsClean,
  runGrok,
  terminateRecordedProcessGroups,
  terminateRecordedProcessGroupsSync
} from "../plugins/grok/scripts/lib/grok-exec.mjs";
import { getProcessIdentity, validProcessIdentity } from "../plugins/grok/scripts/lib/process-identity.mjs";
import { createJobRecord, generateJobId, jobFilePath, readJobRecordFile, writeJobRecordFile } from "../plugins/grok/scripts/lib/state.mjs";
import { envFor, killGroups, makeSandbox, pidAlive, readInvocations, runCompanion, waitFor } from "./lib/companion-harness.mjs";

function options(sandbox, env, extra = {}) {
  return {
    prompt: "inspect the repository",
    mode: "consult",
    cwd: sandbox.workDir,
    logFile: path.join(sandbox.root, "grok.log"),
    timeoutMs: 10000,
    env,
    ...extra
  };
}

function staleAuth(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "fixture");
  const old = new Date(Date.now() - 6 * 60 * 60 * 1000);
  fs.utimesSync(file, old, old);
}

function modelsCalls(sandbox) {
  return readInvocations(sandbox.argsFile).filter((args) => args.includes("models"));
}

test("initial identity misses are retried before publishing the child", async (t) => {
  const sandbox = makeSandbox(t);
  const captures = [];
  let published = null;
  const fallbackIdentity = {
    version: 1, platform: process.platform, bootMarker: "test-boot",
    startMarker: "test-start", commandHash: "test-command"
  };
  t.after(() => killGroups(published?.pid));
  const result = await runGrok(options(sandbox, envFor(sandbox), {
    captureProcessIdentity: (pid) => {
      captures.push(pid);
      return captures.length <= 2 ? null : getProcessIdentity(pid) ?? fallbackIdentity;
    },
    onSpawn: (pid, identity) => { published = { pid, identity }; }
  }));
  assert.equal(result.exitCode, 0);
  assert.ok(captures.length >= 3);
  assert.equal(validProcessIdentity(published?.identity), true);
  assert.ok(captures.every((pid) => pid === published.pid));
});

test("persisted PID without identity is left for diagnostic cleanup", async (t) => {
  const sandbox = makeSandbox(t);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: "ignore"
  });
  assert.ok(child.pid > 1);
  t.after(() => killGroups(child.pid));
  await waitFor(() => pidAlive(child.pid));

  const signals = [];
  const kill = (pid, signal) => {
    if (signal === 0) return process.kill(pid, 0);
    signals.push([pid, signal]);
  };
  const record = { background: true, pid: null, grokPid: child.pid, grokPidIdentity: null };
  assert.equal(terminateRecordedProcessGroupsSync(record, { kill, graceMs: 0 }), false);
  assert.equal(await terminateRecordedProcessGroups(record, { kill, graceMs: 0 }), false);
  assert.deepEqual(signals, []);
  assert.equal(recordedProcessGroupsClean(record), false);
  assert.equal(pidAlive(child.pid), true);

  if (!getProcessIdentity(process.pid)) return;

  const deadDriver = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(deadDriver.pid > 1);
  const id = generateJobId();
  const file = jobFilePath(sandbox.dataDir, sandbox.workDir, id);
  writeJobRecordFile(file, {
    ...createJobRecord({ id, pid: deadDriver.pid, mode: "consult", cwd: sandbox.workDir, background: true }),
    pidIdentity: null,
    grokPid: child.pid,
    grokPidIdentity: null
  });
  const status = runCompanion(["status", id], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.notEqual(status.status, 0);
  assert.match(status.stdout, /^failure: died$/m, status.stderr);
  const updated = readJobRecordFile(file);
  assert.equal(updated.cleanupRequired, true);
  assert.match(updated.errorMessage, /verified process cleanup did not complete/i);
  assert.equal(pidAlive(child.pid), true);
});

for (const authSetting of ["GROK_HOME", "GROK_AUTH_PATH"]) {
  test(`models refresh resolves relative ${authSetting} against the run cwd`, async (t) => {
    const sandbox = makeSandbox(t);
    const relative = authSetting === "GROK_HOME" ? "relative-grok-home" : "relative-auth/auth.json";
    const auth = authSetting === "GROK_HOME"
      ? path.join(sandbox.workDir, relative, "auth.json")
      : path.join(sandbox.workDir, relative);
    staleAuth(auth);
    const env = envFor(sandbox, {
      [authSetting]: relative,
      FAKE_GROK_MODELS_VALIDATE_STORE: "1"
    });
    const result = await runGrok(options(sandbox, env));
    assert.equal(result.exitCode, 0);
    assert.equal(result.authRefresh.reason, "stale");
    assert.equal(result.authRefresh.refreshed, true);
    assert.equal(modelsCalls(sandbox).length, 1);
  });
}

test("failed stale refresh persists a 30 minute cooldown while auth failures still refresh", async (t) => {
  const sandbox = makeSandbox(t);
  const auth = path.join(sandbox.root, "grok-home", "auth.json");
  staleAuth(auth);
  const env = envFor(sandbox);
  const first = await runGrok(options(sandbox, env));
  assert.equal(first.exitCode, 0);
  assert.equal(first.authRefresh.refreshed, false);
  assert.equal(modelsCalls(sandbox).length, 1);
  const attemptFile = path.join(sandbox.dataDir, "auth-refresh-attempt.json");
  const attempt = JSON.parse(fs.readFileSync(attemptFile, "utf8"));
  assert.equal(attempt.file, auth);
  assert.equal(attempt.reason, "stale");
  assert.equal(attempt.refreshed, false);
  assert.equal(attempt.outcome, "failed");
  assert.ok(Date.parse(attempt.attemptedAt) > 0);

  const second = await runGrok(options(sandbox, env));
  assert.equal(second.exitCode, 0);
  assert.equal(second.authRefresh, undefined);
  assert.equal(modelsCalls(sandbox).length, 1);

  const failure = await runGrok(options(sandbox, envFor(sandbox, { FAKE_GROK_MODE: "auth-error" })));
  assert.equal(failure.securityFailureKind, "auth");
  assert.equal(failure.authRefresh.reason, "auth-failure");
  assert.equal(modelsCalls(sandbox).length, 2);

  fs.writeFileSync(attemptFile, `${JSON.stringify({ ...attempt, attemptedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() })}\n`);
  const expired = await runGrok(options(sandbox, env));
  assert.equal(expired.exitCode, 0);
  assert.equal(expired.authRefresh.reason, "stale");
  assert.equal(modelsCalls(sandbox).length, 3);
});

test("stale refresh that exhausts deadline records a failed attempt", (t) => {
  const sandbox = makeSandbox(t);
  const auth = path.join(sandbox.root, "grok-home", "auth.json");
  staleAuth(auth);
  const env = envFor(sandbox, { FAKE_GROK_MODELS_DELAY_MS: "500" });
  assert.throws(() => runGrok(options(sandbox, env, { timeoutMs: 250 })),
    (error) => error.failureKind === "timeout");
  assert.equal(modelsCalls(sandbox).length, 1);
  const attempt = JSON.parse(fs.readFileSync(path.join(sandbox.dataDir, "auth-refresh-attempt.json"), "utf8"));
  assert.equal(attempt.file, auth);
  assert.equal(attempt.reason, "stale");
  assert.equal(attempt.refreshed, false);
  assert.equal(attempt.outcome, "failed");
});
