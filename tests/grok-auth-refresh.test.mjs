import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { grokPaths, resolveLockTimeoutMs } from "../plugins/grok/scripts/lib/state.mjs";
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
    FAKE_GROK_MODELS_VALIDATE_STORE: "1",
    FAKE_GROK_LOGIN_FILE: file,
    FAKE_GROK_MODELS_ENV_FILE: modelsEnvFile,
    ANTHROPIC_API_KEY: "must-be-scrubbed",
    XAI_API_KEY: "retained-for-auth",
    GROK_TURN_SUMMARY: "true",
    GROK_FILE_ACCELERATION: "true",
    GROK_FILE_ACCELERATION_ROUTES: "inherited-routes",
    GROK_SANDBOX_MODE: "inherited-mode",
    GROK_ARTIFACTS_BIND_REMOUNT: "inherited-remount",
    GROK_CURSOR_WORKER_API_BASE: "https://worker.example.test",
    GROK_CURSOR_WORKER_COMMAND: "inherited-worker"
  })));
  assert.equal(result.exitCode, 0);
  assert.equal(result.authRefresh.reason, "stale");
  assert.equal(result.authRefresh.refreshed, true);
  assert.deepEqual(modelsCalls(sandbox), [["--no-auto-update", "models"]]);
  assert.equal(managedCalls(sandbox).length, 1);
  const childEnv = JSON.parse(fs.readFileSync(modelsEnvFile, "utf8"));
  assert.equal(childEnv.GROK_HOME, grokPaths(envFor(sandbox)).home);
  assert.equal(childEnv.GROK_AUTH_PATH, file);
  assert.equal(fs.readFileSync(file, "utf8"), "refreshed fixture");
  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(childEnv.XAI_API_KEY, "retained-for-auth");
  assert.equal(childEnv.GROK_TURN_SUMMARY, "false");
  assert.equal(childEnv.GROK_FILE_ACCELERATION, "false");
  for (const key of ["GROK_FILE_ACCELERATION_ROUTES", "GROK_SANDBOX_MODE", "GROK_ARTIFACTS_BIND_REMOUNT", "GROK_CURSOR_WORKER_API_BASE", "GROK_CURSOR_WORKER_COMMAND"]) {
    assert.equal(childEnv[key], undefined, key);
  }
});

test("direct managed execution retries after auth refresh", async (t) => {
  const sandbox = makeSandbox(t);
  const file = authFile(sandbox);
  const result = await runGrok(directOptions(sandbox, envFor(sandbox, {
    FAKE_GROK_MODE: "auth-once",
    FAKE_GROK_MODELS_VALIDATE_STORE: "1",
    FAKE_GROK_LOGIN_FILE: file
  })));
  assert.equal(result.exitCode, 0);
  assert.equal(result.authRefresh.reason, "auth-failure");
  assert.equal(result.authRefresh.refreshed, true);
  assert.equal(result.authRetry, true);
  assert.equal(fs.readFileSync(file, "utf8"), "refreshed fixture");
  assert.equal(modelsCalls(sandbox).length, 1);
  assert.equal(managedCalls(sandbox).length, 2);
});

test("the refresh runs from a private directory, never the task cwd", async (t) => {
  const sandbox = makeSandbox(t);
  authFile(sandbox, 6);
  const cwdFile = path.join(sandbox.root, "models-cwd.txt");
  const result = await runGrok(directOptions(sandbox, envFor(sandbox, {
    FAKE_GROK_MODELS_TOUCH: "1",
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
  authFile(sandbox);
  const result = await runGrok({ ...directOptions(sandbox, envFor(sandbox, {
    FAKE_GROK_MODE: "auth-once",
    FAKE_GROK_MODELS_TOUCH: "1"
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

test("strict launches replace the private login on rotation and remove it on logout", async (t) => {
  const sandbox = makeSandbox(t);
  const source = authFile(sandbox);
  const options = directOptions(sandbox, envFor(sandbox, { FAKE_GROK_LOGIN_FILE: source }));
  const home = grokPaths(envFor(sandbox)).home;
  const copy = path.join(home, "auth.json");
  const lock = path.join(home, "managed_config.lock");
  fs.mkdirSync(home, { recursive: true });
  fs.symlinkSync(source, copy);
  fs.writeFileSync(lock, "old", { mode: 0o600 });
  fs.chmodSync(source, 0o640);
  const original = fs.statSync(source);
  const first = await runGrok(options);
  assert.equal(first.exitCode, 0, first.stderrTail);
  assert.equal(fs.statSync(source).mode, original.mode);
  assert.equal(fs.statSync(source).mtimeMs, original.mtimeMs);
  assert.equal(fs.lstatSync(copy).isFile(), true);
  const oldCopy = fs.openSync(copy, "r");
  try {
    fs.writeFileSync(source, "rotated fixture");
    fs.unlinkSync(lock);
    const second = await runGrok(options);
    assert.equal(second.exitCode, 0, second.stderrTail);
    assert.equal(fs.readFileSync(oldCopy, "utf8"), "fixture");
    assert.equal(fs.readFileSync(copy, "utf8"), "rotated fixture");
  } finally {
    fs.closeSync(oldCopy);
  }
  fs.unlinkSync(source);
  const loggedOut = await runGrok(options);
  assert.notEqual(loggedOut.exitCode, 0);
  assert.match(loggedOut.stderrTail, /Not signed in/);
  assert.equal(fs.existsSync(copy), false);
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
  authFile(sandbox);
  const result = await runGrok(directOptions(sandbox, envFor(sandbox, {
    FAKE_GROK_MODE: "auth-once-then-error",
    FAKE_GROK_MODELS_TOUCH: "1"
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
    FAKE_GROK_MODELS_VALIDATE_STORE: "1",
    FAKE_GROK_MODELS_ENV_FILE: modelsEnvFile,
    ANTHROPIC_API_KEY: "must-be-scrubbed",
    XAI_API_KEY: "retained-for-auth",
    GROK_MANAGED_MCPS_ENABLED: "true",
    GROK_TURN_SUMMARY: "true",
    GROK_FILE_ACCELERATION: "true",
    GROK_FILE_ACCELERATION_ROUTES: "inherited-routes",
    GROK_SANDBOX_MODE: "inherited-mode",
    GROK_ARTIFACTS_BIND_REMOUNT: "inherited-remount",
    GROK_CURSOR_WORKER_API_BASE: "https://worker.example.test",
    GROK_CURSOR_WORKER_COMMAND: "inherited-worker",
    CLAUDE_CODE_SESSION_ID: "must-be-scrubbed"
  });
  const result = runCompanion(["task", "inspect the repository"], { cwd: sandbox.workDir, env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(modelsCalls(sandbox), [["--no-auto-update", "models"]]);
  assert.equal(managedCalls(sandbox).length, 1);
  const childEnv = JSON.parse(fs.readFileSync(modelsEnvFile, "utf8"));
  assert.equal(childEnv.GROK_HOME, grokPaths(envFor(sandbox)).home);
  assert.equal(childEnv.GROK_AUTH_PATH, file);
  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(childEnv.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(childEnv.XAI_API_KEY, "retained-for-auth");
  assert.equal(childEnv.GROK_MANAGED_MCPS_ENABLED, "false");
  assert.equal(childEnv.GROK_TURN_SUMMARY, "false");
  assert.equal(childEnv.GROK_FILE_ACCELERATION, "false");
  for (const key of ["GROK_FILE_ACCELERATION_ROUTES", "GROK_SANDBOX_MODE", "GROK_ARTIFACTS_BIND_REMOUNT", "GROK_CURSOR_WORKER_API_BASE", "GROK_CURSOR_WORKER_COMMAND"]) {
    assert.equal(childEnv[key], undefined, key);
  }
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
  authFile(sandbox);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "auth-once", FAKE_GROK_MODELS_TOUCH: "1" });
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

test("strict runs copy the resolved credential override and never publish private changes", async (t) => {
  const sandbox = makeSandbox(t);
  const fallback = authFile(sandbox);
  const source = path.join(sandbox.root, "selected-login");
  const alias = path.join(sandbox.root, "login-link");
  fs.writeFileSync(source, "selected", { mode: 0o640 });
  fs.symlinkSync(source, alias);
  const before = fs.statSync(source);
  const env = envFor(sandbox, { GROK_AUTH_PATH: alias, FAKE_GROK_LOGIN_FILE: source });
  const { home } = grokPaths(env);
  const copy = path.join(home, "auth.json");

  const first = await runGrok(directOptions(sandbox, env));
  assert.equal(first.exitCode, 0, first.stderrTail);
  assert.equal(fs.lstatSync(copy).isFile(), true);
  assert.equal(fs.statSync(copy).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(copy, "utf8"), "selected");
  assert.notEqual(fs.statSync(copy).ino, before.ino);

  delete env.FAKE_GROK_LOGIN_FILE;
  const rotated = await runGrok(directOptions(sandbox, { ...env, FAKE_GROK_ROTATE_ON: "--sandbox" }));
  assert.equal(rotated.exitCode, 0, rotated.stderrTail);
  assert.equal(fs.readFileSync(copy, "utf8"), "selected rotated");
  assert.equal(fs.readFileSync(source, "utf8"), "selected");
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  const after = fs.statSync(source);
  assert.deepEqual([after.ino, after.mode, after.ctimeMs], [before.ino, before.mode, before.ctimeMs]);
  const next = await runGrok(directOptions(sandbox, { ...env, FAKE_GROK_LOGIN_FILE: source }));
  assert.equal(next.exitCode, 0, next.stderrTail);
  assert.equal(fs.readFileSync(copy, "utf8"), "selected");
  assert.equal(fs.readFileSync(fallback, "utf8"), "fixture");
});

test("setup and failed models calls let Grok rotate the resolved source directly", (t) => {
  const sandbox = makeSandbox(t);
  const fallback = authFile(sandbox);
  const source = path.join(sandbox.root, "profile-login");
  const alias = path.join(sandbox.root, "alias");
  fs.writeFileSync(source, "selected");
  fs.symlinkSync(source, alias);
  const log = path.join(sandbox.root, "probes");
  const env = envFor(sandbox, { GROK_AUTH_PATH: alias, FAKE_GROK_HOME_LOG: log, FAKE_GROK_ROTATE_ON: "--help" });
  delete env.GROK_COMPANION_CAPABILITIES;
  const setup = runCompanion(["setup", "--json"], { cwd: sandbox.workDir, env });
  assert.equal(setup.status, 0, setup.stderr);
  const { home } = grokPaths(env);
  assert.equal(JSON.parse(setup.stdout).privateHome.path, home);
  const models = runCompanion(["models"], { cwd: sandbox.workDir, env: { ...env, FAKE_GROK_ROTATE_ON: "models", FAKE_GROK_MODELS_EXIT_CODE: "1" } });
  assert.equal(models.status, 1);
  const probes = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse).filter(({ args }) => !args.includes("--version"));
  assert.deepEqual(probes.map(({ args }) => args), [["--help"], ["doctor", "--help"], ["models"]]);
  for (const probe of probes) {
    assert.equal(probe.GROK_HOME, home);
    assert.equal(probe.GROK_AUTH_PATH, source);
  }
  assert.equal(fs.readFileSync(source, "utf8"), "selected rotated rotated rotated");
  assert.equal(fs.readFileSync(fallback, "utf8"), "fixture");
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(home, "auth.json")), false);
});

test("credential staging that consumes the deadline prevents strict spawn", async (t) => {
  const sandbox = makeSandbox(t);
  authFile(sandbox);
  const env = envFor(sandbox);
  const copy = path.join(grokPaths(env).home, "auth.json");
  const rename = fs.renameSync;
  const expiresAt = Date.now() + 10000;
  t.mock.method(fs, "renameSync", (from, to) => {
    rename(from, to);
    if (to === copy) t.mock.method(Date, "now", () => expiresAt + 1);
  });
  await assert.rejects(runGrok({ ...directOptions(sandbox, env), managedDeadline: expiresAt }), { failureKind: "timeout" });
  assert.deepEqual(managedCalls(sandbox), []);
});

test("a delayed launch callback checks the deadline again under the job lock", async (t) => {
  const sandbox = makeSandbox(t);
  const expiresAt = Date.now() + 1500;
  await assert.rejects(runGrok({
    ...directOptions(sandbox, envFor(sandbox)),
    managedDeadline: expiresAt,
    launchProcess(launch) {
      assert.ok(resolveLockTimeoutMs() <= 1500);
      t.mock.method(Date, "now", () => expiresAt + 1);
      return launch();
    }
  }), { failureKind: "timeout" });
  assert.deepEqual(managedCalls(sandbox), []);
});

test("strict launch rejects a nonregular credential source before spawning", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { GROK_AUTH_PATH: sandbox.root });
  await assert.rejects(runGrok(directOptions(sandbox, env)), { failureKind: "setup", message: /regular auth file/ });
  assert.deepEqual(managedCalls(sandbox), []);
});
