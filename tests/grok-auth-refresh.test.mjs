import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { envFor, jobRecords, makeSandbox, readInvocations, runCompanion } from "./lib/companion-harness.mjs";
import { runGrok } from "../plugins/grok/scripts/lib/grok-exec.mjs";

function authFile(sandbox, hoursOld = 0) {
  const file = path.join(sandbox.root, "grok-home", "auth.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "fixture");
  const time = new Date(Date.now() - hoursOld * 60 * 60 * 1000);
  fs.utimesSync(file, time, time);
  return file;
}

function modelsCalls(sandbox) {
  return readInvocations(sandbox.argsFile).filter((argv) => argv.includes("models"));
}

function managedCalls(sandbox) {
  return readInvocations(sandbox.argsFile).filter((argv) => argv.includes("--sandbox"));
}

function directOptions(sandbox, env) {
  return {
    prompt: "inspect the repository",
    mode: "consult",
    cwd: sandbox.workDir,
    logFile: path.join(sandbox.root, "grok.log"),
    timeoutMs: 10000,
    env
  };
}

test("direct managed execution records a stale pre-run refresh", async (t) => {
  const sandbox = makeSandbox(t);
  const file = authFile(sandbox, 6);
  const modelsEnvFile = path.join(sandbox.root, "direct-models-env.json");
  const result = await runGrok(directOptions(sandbox, envFor(sandbox, {
    FAKE_GROK_MODELS_TOUCH: file,
    FAKE_GROK_MODELS_ENV_FILE: modelsEnvFile,
    ANTHROPIC_API_KEY: "must-be-scrubbed",
    XAI_API_KEY: "retained-for-auth"
  })));
  assert.equal(result.exitCode, 0);
  assert.equal(result.authRefresh.reason, "stale");
  assert.equal(result.authRefresh.refreshed, true);
  assert.deepEqual(modelsCalls(sandbox), [["--no-auto-update", "models"]]);
  assert.equal(managedCalls(sandbox).length, 1);
  const childEnv = JSON.parse(fs.readFileSync(modelsEnvFile, "utf8"));
  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(childEnv.XAI_API_KEY, "retained-for-auth");
});

test("direct managed execution retries after auth refresh", async (t) => {
  const sandbox = makeSandbox(t);
  const file = authFile(sandbox);
  const result = await runGrok(directOptions(sandbox, envFor(sandbox, {
    FAKE_GROK_MODE: "auth-once",
    FAKE_GROK_MODELS_TOUCH: file
  })));
  assert.equal(result.exitCode, 0);
  assert.equal(result.authRefresh.reason, "auth-failure");
  assert.equal(result.authRefresh.refreshed, true);
  assert.equal(result.authRetry, true);
  assert.equal(modelsCalls(sandbox).length, 1);
  assert.equal(managedCalls(sandbox).length, 2);
});

test("the refresh runs from a private directory, never the task cwd", async (t) => {
  const sandbox = makeSandbox(t);
  const file = authFile(sandbox, 6);
  const cwdFile = path.join(sandbox.root, "models-cwd.txt");
  const result = await runGrok(directOptions(sandbox, envFor(sandbox, {
    FAKE_GROK_MODELS_TOUCH: file,
    FAKE_GROK_MODELS_CWD_FILE: cwdFile
  })));
  assert.equal(result.exitCode, 0);
  assert.equal(result.authRefresh.reason, "stale");
  const refreshCwd = fs.readFileSync(cwdFile, "utf8");
  assert.notEqual(path.resolve(refreshCwd), path.resolve(sandbox.workDir));
  assert.equal(fs.existsSync(refreshCwd), false);
});

test("a write run with a generic auth failure refreshes but is not rerun", async (t) => {
  const sandbox = makeSandbox(t);
  const file = authFile(sandbox);
  const result = await runGrok({ ...directOptions(sandbox, envFor(sandbox, {
    FAKE_GROK_MODE: "auth-once",
    FAKE_GROK_MODELS_TOUCH: file
  })), mode: "write" });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.securityFailureKind, "auth");
  assert.equal(result.authRefresh.reason, "auth-failure");
  assert.equal(result.authRetry, undefined);
  assert.equal(modelsCalls(sandbox).length, 1);
  assert.equal(managedCalls(sandbox).length, 1);
});

test("direct managed execution does not pre-refresh when auth is missing", async (t) => {
  const sandbox = makeSandbox(t);
  const result = await runGrok(directOptions(sandbox, envFor(sandbox)));
  assert.equal(result.exitCode, 0);
  assert.equal(result.authRefresh, undefined);
  assert.equal(modelsCalls(sandbox).length, 0);
});

test("direct auth failure with unchanged mtime keeps auth and login guidance", async (t) => {
  const sandbox = makeSandbox(t);
  authFile(sandbox);
  const result = await runGrok(directOptions(sandbox, envFor(sandbox, { FAKE_GROK_MODE: "auth-error" })));
  assert.equal(result.securityFailureKind, "auth");
  assert.equal(result.authRefresh.refreshed, false);
  assert.equal(result.authRetry, undefined);
  assert.match(result.errorMessage, /run `grok login` once, then rerun/);
  assert.equal(modelsCalls(sandbox).length, 1);
  assert.equal(managedCalls(sandbox).length, 1);
});

test("a failed retry remains an auth failure", async (t) => {
  const sandbox = makeSandbox(t);
  const file = authFile(sandbox);
  const result = await runGrok(directOptions(sandbox, envFor(sandbox, {
    FAKE_GROK_MODE: "auth-once-then-error",
    FAKE_GROK_MODELS_TOUCH: file
  })));
  assert.equal(result.securityFailureKind, "auth");
  assert.equal(result.authRefresh.refreshed, true);
  assert.equal(result.authRetry, true);
  assert.match(result.errorMessage, /run `grok login` once, then rerun/);
  assert.equal(managedCalls(sandbox).length, 2);
});

test("stale auth runs one unsandboxed models refresh with the scrubbed child environment", (t) => {
  const sandbox = makeSandbox(t);
  const file = authFile(sandbox, 6);
  const modelsEnvFile = path.join(sandbox.root, "models-env.json");
  const env = envFor(sandbox, {
    GROK_AUTH_PATH: file,
    FAKE_GROK_MODELS_TOUCH: file,
    FAKE_GROK_MODELS_ENV_FILE: modelsEnvFile,
    ANTHROPIC_API_KEY: "must-be-scrubbed",
    XAI_API_KEY: "retained-for-auth",
    GROK_MANAGED_MCPS_ENABLED: "true",
    CLAUDE_CODE_SESSION_ID: "must-be-scrubbed"
  });
  const result = runCompanion(["task", "inspect the repository"], { cwd: sandbox.workDir, env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(modelsCalls(sandbox), [["--no-auto-update", "models"]]);
  assert.equal(managedCalls(sandbox).length, 1);
  const childEnv = JSON.parse(fs.readFileSync(modelsEnvFile, "utf8"));
  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(childEnv.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(childEnv.XAI_API_KEY, "retained-for-auth");
  assert.equal(childEnv.GROK_MANAGED_MCPS_ENABLED, "false");
  const [record] = jobRecords(sandbox.dataDir);
  assert.equal(record.authRefresh.reason, "stale");
  assert.equal(record.authRefresh.refreshed, true);
  assert.match(record.authRefresh.attemptedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(record.authRetry, undefined);
});

test("fresh auth launches without a pre-run refresh", (t) => {
  const sandbox = makeSandbox(t);
  authFile(sandbox);
  const result = runCompanion(["task", "inspect the repository"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(modelsCalls(sandbox).length, 0);
  assert.equal(managedCalls(sandbox).length, 1);
  assert.equal(jobRecords(sandbox.dataDir)[0].authRefresh, undefined);
});

test("auth failure refreshes once and reruns the managed request once", (t) => {
  const sandbox = makeSandbox(t);
  const file = authFile(sandbox);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "auth-once", FAKE_GROK_MODELS_TOUCH: file });
  const result = runCompanion(["task", "inspect the repository"], { cwd: sandbox.workDir, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(modelsCalls(sandbox).length, 1);
  assert.equal(managedCalls(sandbox).length, 2);
  const [record] = jobRecords(sandbox.dataDir);
  assert.equal(record.status, "done");
  assert.equal(record.authRefresh.reason, "auth-failure");
  assert.equal(record.authRefresh.refreshed, true);
  assert.equal(record.authRetry, true);
});

test("auth failure without a refreshed token retains auth and the login remedy", (t) => {
  const sandbox = makeSandbox(t);
  authFile(sandbox);
  const result = runCompanion(["task", "inspect the repository"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "auth-error" })
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^failure: auth$/m);
  assert.match(result.stderr, /The companion ran `grok models` outside the sandbox to refresh the stored token and it did not refresh/);
  assert.equal(modelsCalls(sandbox).length, 1);
  assert.equal(managedCalls(sandbox).length, 1);
  const [record] = jobRecords(sandbox.dataDir);
  assert.equal(record.failureKind, "auth");
  assert.equal(record.authRefresh.reason, "auth-failure");
  assert.equal(record.authRefresh.refreshed, false);
  assert.equal(record.authRetry, undefined);
  assert.match(record.errorMessage, /run `grok login` once, then rerun/);
});

test("setup reports auth age and stale guidance without changing readiness", (t) => {
  const sandbox = makeSandbox(t);
  const file = authFile(sandbox, 6);
  const env = envFor(sandbox, { GROK_AUTH_PATH: file });
  const staleRun = runCompanion(["setup", "--json"], { cwd: sandbox.workDir, env });
  assert.equal(staleRun.status, 0, staleRun.stderr);
  const stale = JSON.parse(staleRun.stdout);
  assert.equal(stale.ready, true);
  assert.equal(stale.auth.file, file);
  assert.ok(stale.auth.ageSeconds >= 5 * 60 * 60);
  assert.equal(stale.auth.stale, true);
  assert.ok(stale.nextSteps.includes("Run `grok models` once outside the sandbox to refresh the stored Grok token."));

  const now = new Date();
  fs.utimesSync(file, now, now);
  const freshRun = runCompanion(["setup", "--json"], { cwd: sandbox.workDir, env });
  assert.equal(freshRun.status, 0, freshRun.stderr);
  const fresh = JSON.parse(freshRun.stdout);
  assert.equal(fresh.ready, true);
  assert.equal(fresh.auth.stale, false);
  assert.ok(fresh.auth.ageSeconds < 60);
  assert.equal(fresh.nextSteps.includes("Run `grok models` once outside the sandbox to refresh the stored Grok token."), false);

  fs.unlinkSync(file);
  const missingRun = runCompanion(["setup", "--json"], { cwd: sandbox.workDir, env });
  assert.equal(missingRun.status, 0, missingRun.stderr);
  const missing = JSON.parse(missingRun.stdout);
  assert.equal(missing.ready, true);
  assert.equal(missing.auth.ageSeconds, null);
  assert.equal(missing.auth.stale, true);
});
