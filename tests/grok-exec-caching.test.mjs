import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { resolveGrokCapabilities, runGrok } from "../plugins/grok/scripts/lib/grok-exec.mjs";
import { envFor, fakeGrok, makeSandbox, readInvocations } from "./lib/companion-harness.mjs";

function options(sandbox, env, extra = {}) {
  return {
    prompt: "inspect the repository",
    mode: "consult",
    cwd: sandbox.workDir,
    logFile: path.join(sandbox.root, "grok.log"),
    timeoutMs: 5000,
    env,
    ...extra
  };
}

function authFile(sandbox, hoursOld = 0) {
  const file = path.join(sandbox.root, "grok-home", "auth.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "fixture");
  const time = new Date(Date.now() - hoursOld * 60 * 60 * 1000);
  fs.utimesSync(file, time, time);
  return file;
}

function calls(sandbox, flag) {
  return readInvocations(sandbox.argsFile).filter((argv) => argv.includes(flag));
}

test("missing binary during capability preflight is classified as missing_cli", (t) => {
  const sandbox = makeSandbox(t);
  const bin = path.join(sandbox.root, "missing-grok");
  const env = envFor(sandbox, { GROK_BIN: bin });
  delete env.GROK_COMPANION_CAPABILITIES;
  assert.throws(() => runGrok(options(sandbox, env)), (error) => {
    assert.equal(error.failureKind, "missing_cli");
    assert.equal(error.message, `Unable to locate the Grok CLI binary: ${bin}`);
    return true;
  });
});

test("R1: capability preflight consumes the managed run deadline", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_HELP_DELAY_MS: "500" });
  delete env.GROK_COMPANION_CAPABILITIES;
  const started = Date.now();
  assert.throws(() => runGrok(options(sandbox, env, { timeoutMs: 250 })),
    (error) => error.failureKind === "timeout");
  assert.ok(Date.now() - started < 850);
  assert.equal(calls(sandbox, "--sandbox").length, 0);
});

test("R1: stale OIDC refresh consumes the managed run deadline", (t) => {
  const sandbox = makeSandbox(t);
  authFile(sandbox, 6);
  const env = envFor(sandbox, { FAKE_GROK_MODELS_DELAY_MS: "500" });
  const started = Date.now();
  assert.throws(() => runGrok(options(sandbox, env, { timeoutMs: 250 })),
    (error) => error.failureKind === "timeout");
  assert.ok(Date.now() - started < 850);
  assert.equal(calls(sandbox, "models").length, 1);
  assert.equal(calls(sandbox, "--sandbox").length, 0);
});

test("R1: auth retry uses the remaining deadline", async (t) => {
  const sandbox = makeSandbox(t);
  const file = authFile(sandbox);
  const env = envFor(sandbox, {
    FAKE_GROK_MODE: "auth-once-then-hang",
    FAKE_GROK_MODELS_DELAY_MS: "300",
    FAKE_GROK_MODELS_TOUCH: file
  });
  const started = Date.now();
  let result;
  let failure;
  try {
    result = await runGrok(options(sandbox, env, { timeoutMs: 1000 }));
  } catch (error) {
    failure = error;
  }
  assert.ok(result?.timedOut || failure?.failureKind === "timeout");
  if (result) assert.equal(result.authRetry, true);
  assert.equal(calls(sandbox, "--sandbox").length, 2);
  assert.ok(Date.now() - started < 1600);
});

test("R2: sandbox polling advances past unrelated growth and assembles partial lines", async (t) => {
  const sandbox = makeSandbox(t);
  const eventFile = path.join(sandbox.root, "grok-home", "sessions", "sandbox-events.jsonl");
  const gate = path.join(sandbox.root, "release-sandbox-event");
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  let bytesRead = 0;
  let eventOpens = 0;
  let noisePoll = null;
  let gateOpened = false;
  fs.openSync = function (file) {
    const descriptor = originalOpen.apply(this, arguments);
    if (file === eventFile) {
      eventOpens += 1;
      if (noisePoll !== null && eventOpens >= noisePoll + 5 && !gateOpened) {
        fs.writeFileSync(gate, "release");
        gateOpened = true;
      }
    }
    return descriptor;
  };
  fs.readSync = function (descriptor, buffer, offset, length, position) {
    const read = originalRead.apply(this, arguments);
    if (typeof position === "number") {
      bytesRead += read;
      if (noisePoll === null && length >= 256 * 1024) noisePoll = eventOpens;
    }
    return read;
  };
  try {
    const result = await runGrok(options(sandbox, envFor(sandbox, {
      FAKE_GROK_MODE: "sandbox-event-growing",
      FAKE_GROK_SANDBOX_EVENT_GATE_FILE: gate
    }), { timeoutMs: 20000 }));
    assert.equal(result.exitCode, 0, JSON.stringify({ timedOut: result.timedOut, securityFailureKind: result.securityFailureKind, errorMessage: result.errorMessage }));
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
  }
  assert.equal(gateOpened, true);
  assert.ok(bytesRead < 1024 * 1024, `read ${bytesRead} bytes while polling`);
  const partialGate = path.join(sandbox.root, "release-partial-line");
  const priorSize = fs.statSync(eventFile).size;
  let partialObserved = false;
  fs.readSync = function (descriptor, buffer, offset, length, position) {
    const read = originalRead.apply(this, arguments);
    if (!partialObserved && typeof position === "number" && position >= priorSize && read > 0) {
      fs.writeFileSync(partialGate, "release");
      partialObserved = true;
    }
    return read;
  };
  let partial;
  try {
    partial = await runGrok(options(sandbox, envFor(sandbox, {
      FAKE_GROK_MODE: "sandbox-event-partial",
      FAKE_GROK_SANDBOX_PARTIAL_GATE_FILE: partialGate
    }), { timeoutMs: 20000 }));
  } finally {
    fs.readSync = originalRead;
  }
  assert.equal(partialObserved, true);
  assert.equal(partial.exitCode, 0, JSON.stringify({ timedOut: partial.timedOut, securityFailureKind: partial.securityFailureKind, errorMessage: partial.errorMessage }));
  assert.equal(partial.securityFailureKind, null);
});

test("R2: 512 KiB limit counts total newly scanned bytes", async (t) => {
  const sandbox = makeSandbox(t);
  const result = await runGrok(options(sandbox, envFor(sandbox, {
    FAKE_GROK_MODE: "sandbox-event-growing",
    FAKE_GROK_SANDBOX_NOISE_BYTES: String(600 * 1024)
  })));
  assert.equal(result.securityFailureKind, "sandbox");
  assert.match(result.errorMessage, /startup verification limit/);
});

test("R3: disk cache survives module reload and invalidates on each binary key field", async (t) => {
  const sandbox = makeSandbox(t);
  const binary = path.join(sandbox.root, "fake-grok");
  fs.copyFileSync(fakeGrok, binary);
  fs.chmodSync(binary, 0o755);
  const env = envFor(sandbox, { GROK_BIN: binary });
  delete env.GROK_COMPANION_CAPABILITIES;
  const probe = (environment = env, bin = binary) => resolveGrokCapabilities(bin, environment, Date.now() + 5000);
  assert.ok(probe().has("--sandbox"));
  assert.equal(calls(sandbox, "--help").length, 1);
  const freshModule = await import(`../plugins/grok/scripts/lib/grok-exec.mjs?cache-test=${Date.now()}`);
  assert.ok(freshModule.resolveGrokCapabilities(binary, env, Date.now() + 5000).has("--sandbox"));
  assert.equal(calls(sandbox, "--help").length, 1);
  assert.equal(calls(sandbox, "--version").length, 2);

  probe({ ...env, FAKE_GROK_VERSION_OUTPUT: "grok 1.0.42 (different)" });
  assert.equal(calls(sandbox, "--help").length, 2);
  const updated = new Date(Date.now() + 5000);
  fs.utimesSync(binary, updated, updated);
  probe();
  assert.equal(calls(sandbox, "--help").length, 3);
  fs.appendFileSync(binary, "\n// changed size\n");
  probe();
  assert.equal(calls(sandbox, "--help").length, 4);
  const otherBinary = path.join(sandbox.root, "other-grok");
  fs.copyFileSync(binary, otherBinary);
  fs.chmodSync(otherBinary, 0o755);
  probe(env, otherBinary);
  assert.equal(calls(sandbox, "--help").length, 5);
  const cache = JSON.parse(fs.readFileSync(path.join(sandbox.dataDir, "capabilities.json"), "utf8"));
  assert.equal(cache.key.path, fs.realpathSync(otherBinary));
  assert.ok(cache.flags.includes("--sandbox"));
});

test("R3: cached capabilities do not bypass live socket and auth checks", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  delete env.GROK_COMPANION_CAPABILITIES;
  const first = await runGrok(options(sandbox, env));
  assert.equal(first.exitCode, 0);
  const socket = path.join(sandbox.root, "new.sock");
  fs.symlinkSync(path.join(sandbox.root, "missing-target"), socket);
  assert.throws(() => runGrok(options(sandbox, {
    ...env, GROK_COMPANION_RUNTIME_SOCKET_CANDIDATES: socket
  })), (error) => error.failureKind === "sandbox");
  assert.equal(calls(sandbox, "--sandbox").length, 1);
  fs.unlinkSync(socket);
  authFile(sandbox, 6);
  const refreshed = await runGrok(options(sandbox, env));
  assert.equal(refreshed.exitCode, 0);
  assert.equal(calls(sandbox, "models").length, 1);
  assert.equal(calls(sandbox, "--help").length, 1);
});
