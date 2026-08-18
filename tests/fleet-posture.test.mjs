import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { messageTag, tagMessage } from "../plugins/fusion/scripts/lib/user-messages.mjs";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "plugins", "fusion", "scripts", "fleet-posture.mjs");
const LEGACY_CONTEXT = tagMessage("fleet-posture.strict-fleet-reminder", "fleet-default active: a goal that decomposes into three or more independent work packages convenes /fusion:ultra once bootstrap dependencies are resolved; narrower execution states `fleet-decline: <reason>` visibly in the reply.");
const SESSION_LANES_CONTEXT = tagMessage("fleet-posture.session-lanes-reminder", "fusion lanes ready: codex terra/luna for quick and volume packages, grok under its four roles, claude workers for the Claude surface. Independent packages dispatch together in one message; three or more convene /fusion:ultra; a single coherent change stays inline.");

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-posture-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dataDir: path.join(root, "fusion-data"), stateDir: path.join(root, "inline-guard") };
}

function envFor(sandbox, extra = {}) {
  const env = { ...process.env, FUSION_DATA_DIR: sandbox.dataDir, FUSION_INLINE_GUARD_STATE: sandbox.stateDir, ...extra };
  for (const name of ["FUSION_FLEET_MODE", "FUSION_POSTURE", "FUSION_NARROW_WAVE_THRESHOLD"]) {
    if (!Object.hasOwn(extra, name)) {
      delete env[name];
    }
  }
  return env;
}

function hookInput(sandbox, sessionId = "session-1") {
  return JSON.stringify({ ...(sessionId === undefined ? {} : { session_id: sessionId }), prompt: "do work", cwd: sandbox.root });
}

function statePath(sandbox, sessionId = "session-1") {
  return path.join(sandbox.stateDir, `${sessionId}.json`);
}

function sessionLanesReminderPath(sandbox, sessionId = "session-1") {
  return path.join(sandbox.dataDir, "fleet-posture", "session-lanes-reminders", `${sessionId}.marker`);
}

function writeState(sandbox, state, sessionId = "session-1") {
  fs.mkdirSync(sandbox.stateDir, { recursive: true });
  fs.writeFileSync(statePath(sandbox, sessionId), JSON.stringify(state), "utf8");
}

function judgmentContext(streak) {
  return tagMessage("fleet-posture.narrow-wave-reminder", `${streak} consecutive width one dispatch waves in this session. If the remaining packages are independent, dispatch them together in one message; /fusion:ultra is available when the goal is genuinely wide.`);
}

function run(sandbox, input = hookInput(sandbox), extraEnv = {}) {
  return spawnSync(process.execPath, [script], {
    input,
    env: envFor(sandbox, extraEnv),
    encoding: "utf8"
  });
}

function assertSilent(result) {
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
}

function assertContext(result, additionalContext) {
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stderr, "");
  const slug = additionalContext.includes("fleet-default active")
    ? "fleet-posture.strict-fleet-reminder"
    : additionalContext.includes("fusion lanes ready:")
      ? "fleet-posture.session-lanes-reminder"
      : "fleet-posture.narrow-wave-reminder";
  assert.ok(additionalContext.endsWith(messageTag(slug)));
  assert.deepStrictEqual(JSON.parse(result.stdout), {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext }
  });
}

test("judgment posture emits the session lanes reminder once without guard state", (t) => {
  const sandbox = makeSandbox(t);

  assertContext(run(sandbox), SESSION_LANES_CONTEXT);
  assertSilent(run(sandbox));
  assert.strictEqual(fs.existsSync(statePath(sandbox)), false);
  assert.strictEqual(fs.statSync(sessionLanesReminderPath(sandbox)).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(sessionLanesReminderPath(sandbox))).mode & 0o777, 0o700);
});

test("judgment posture is silent below the narrow wave threshold", (t) => {
  const sandbox = makeSandbox(t);
  assertContext(run(sandbox), SESSION_LANES_CONTEXT);

  for (const streak of [0, 1]) {
    writeState(sandbox, { consecutiveNarrowWaves: streak });
    assertSilent(run(sandbox));
  }
});

test("judgment posture emits the observed narrow wave streak", (t) => {
  const sandbox = makeSandbox(t);
  writeState(sandbox, { consecutiveNarrowWaves: 2 });
  const original = fs.readFileSync(statePath(sandbox), "utf8");

  assertContext(run(sandbox), SESSION_LANES_CONTEXT);
  assertContext(run(sandbox), judgmentContext(2));
  assert.strictEqual(fs.readFileSync(statePath(sandbox), "utf8"), original);
});

test("judgment posture honors a valid narrow wave threshold and falls back for malformed values", (t) => {
  const sandbox = makeSandbox(t);
  assertContext(run(sandbox), SESSION_LANES_CONTEXT);
  writeState(sandbox, { consecutiveNarrowWaves: 2 });

  assertSilent(run(sandbox, hookInput(sandbox), { FUSION_NARROW_WAVE_THRESHOLD: "3" }));
  writeState(sandbox, { consecutiveNarrowWaves: 3 });
  assertContext(run(sandbox, hookInput(sandbox), { FUSION_NARROW_WAVE_THRESHOLD: "3" }), judgmentContext(3));
  writeState(sandbox, { consecutiveNarrowWaves: 2 });
  assertContext(run(sandbox, hookInput(sandbox), { FUSION_NARROW_WAVE_THRESHOLD: "invalid" }), judgmentContext(2));
});

test("strict posture emits the legacy reminder without guard state", (t) => {
  const sandbox = makeSandbox(t);

  assertContext(run(sandbox, hookInput(sandbox), { FUSION_POSTURE: "strict" }), LEGACY_CONTEXT);
  assert.strictEqual(fs.existsSync(statePath(sandbox)), false);
  assert.strictEqual(fs.existsSync(sessionLanesReminderPath(sandbox)), false);
});

test("FUSION_FLEET_MODE=off suppresses both postures", (t) => {
  const sandbox = makeSandbox(t);
  writeState(sandbox, { consecutiveNarrowWaves: 2 });

  assertSilent(run(sandbox, hookInput(sandbox), { FUSION_FLEET_MODE: "off" }));
  assertSilent(run(sandbox, hookInput(sandbox), { FUSION_FLEET_MODE: "off", FUSION_POSTURE: "strict" }));
  assert.strictEqual(fs.existsSync(sessionLanesReminderPath(sandbox)), false);
});

test("the fleet mode state file suppresses both postures", (t) => {
  const sandbox = makeSandbox(t);
  writeState(sandbox, { consecutiveNarrowWaves: 2 });
  fs.mkdirSync(sandbox.dataDir, { recursive: true });
  fs.writeFileSync(path.join(sandbox.dataDir, "fleet-mode"), "off\n", "utf8");

  assertSilent(run(sandbox));
  assertSilent(run(sandbox, hookInput(sandbox), { FUSION_POSTURE: "strict" }));
  assert.strictEqual(fs.existsSync(sessionLanesReminderPath(sandbox)), false);
});

test("an enabled environment mode overrides a disabled state file", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.dataDir, { recursive: true });
  fs.writeFileSync(path.join(sandbox.dataDir, "fleet-mode"), "off\n", "utf8");

  assertContext(run(sandbox, hookInput(sandbox), { FUSION_FLEET_MODE: "on", FUSION_POSTURE: "strict" }), LEGACY_CONTEXT);
});

test("invalid guard state is silent after the session lanes reminder", (t) => {
  const sandbox = makeSandbox(t);

  fs.mkdirSync(sandbox.stateDir, { recursive: true });
  fs.writeFileSync(statePath(sandbox), "{not json", "utf8");
  assertContext(run(sandbox), SESSION_LANES_CONTEXT);
  assertSilent(run(sandbox));
  assertSilent(run(sandbox, hookInput(sandbox, undefined)));
  writeState(sandbox, { consecutiveNarrowWaves: "2" });
  assertSilent(run(sandbox));
});

test("malformed hook input is silent", (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, "{not json");

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});
