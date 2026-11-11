import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { messageTag, tagMessage } from "../plugins/fusion/scripts/lib/user-messages.mjs";
import { claimParentContextAdvisory } from "../plugins/fusion/scripts/lib/lifecycle/dispatch.mjs";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "plugins", "fusion", "scripts", "fleet-posture.mjs");
const LEGACY_CONTEXT = tagMessage("fleet-posture.strict-fleet-reminder", "fleet-default active: a goal that decomposes into three or more independent work packages convenes /fusion:ultra once bootstrap dependencies are resolved; explain narrower execution visibly in the reply.");
const SESSION_LANES_CONTEXT = tagMessage("fleet-posture.session-lanes-reminder", "fusion lanes ready: codex gpt-6.1-sol for spec grade and deep review, gpt-6-sol and gpt-6-luna for quick and volume packages, grok under its four roles on the routing table's lane defaults, cursor under diversity for a model family no other lane carries and under burst for bounded worktree implementation, claude workers for the Claude surface. Independent packages dispatch together in one message; three or more convene /fusion:ultra; a single coherent change stays inline.");
const advisoryText = (tokens) => `The main loop context is ${Math.round(tokens / 1000)}k tokens and every turn replays it. Finish this wave, then prefer /compact or a fresh session before the next goal.`;
const advisoryContext = (tokens) => tagMessage("fleet-posture.context-advisory", advisoryText(tokens));

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-posture-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dataDir: path.join(root, "fusion-data"), stateDir: path.join(root, "inline-guard"), workerStateDir: path.join(root, "workers"), transcript: path.join(root, "transcript.jsonl") };
}

function envFor(sandbox, extra = {}) {
  const env = { ...process.env, FUSION_DATA_DIR: sandbox.dataDir, FUSION_INLINE_GUARD_STATE: sandbox.stateDir, FUSION_WORKER_STATE_DIR: sandbox.workerStateDir, FUSION_MODEL_ROUTING: path.join(sandbox.root, "missing-model-routing.json"), ...extra };
  for (const name of ["FUSION_FLEET_MODE", "FUSION_POSTURE", "FUSION_PARENT_CONTEXT_ADVISORY_TOKENS"]) {
    if (!Object.hasOwn(extra, name)) {
      delete env[name];
    }
  }
  return env;
}

function hookInput(sandbox, sessionId = "session-1") {
  return JSON.stringify({ ...(sessionId === undefined ? {} : { session_id: sessionId }), prompt: "do work", cwd: sandbox.root, transcript_path: sandbox.transcript });
}

function writeTranscript(sandbox, tokens) {
  fs.appendFileSync(sandbox.transcript, `${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}\n`);
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

test("parent context below threshold adds no advisory", (t) => {
  const sandbox = makeSandbox(t);
  writeTranscript(sandbox, 249999);
  assertContext(run(sandbox), SESSION_LANES_CONTEXT);
  assertSilent(run(sandbox));
  assert.strictEqual(fs.existsSync(path.join(sandbox.workerStateDir, "sessions", "session-1.json")), false);
});

test("parent context advisory sends once at each threshold across prompts", (t) => {
  const sandbox = makeSandbox(t);
  assertContext(run(sandbox), SESSION_LANES_CONTEXT);
  writeTranscript(sandbox, 250000);
  assertContext(run(sandbox), advisoryContext(250000));
  assertSilent(run(sandbox));
  writeTranscript(sandbox, 800000);
  assertContext(run(sandbox), advisoryContext(800000));
  assertSilent(run(sandbox));
});

test("first prompt combines the session reminder and parent context advisory", (t) => {
  const sandbox = makeSandbox(t);
  writeTranscript(sandbox, 250000);
  assertContext(run(sandbox), `${SESSION_LANES_CONTEXT}\n\n${advisoryContext(250000)}`);
  assertSilent(run(sandbox));
});

test("a dispatch claim suppresses the prompt advisory", (t) => {
  const sandbox = makeSandbox(t);
  assertContext(run(sandbox), SESSION_LANES_CONTEXT);
  writeTranscript(sandbox, 250000);
  assert.strictEqual(claimParentContextAdvisory("session-1", 250000, envFor(sandbox)), advisoryText(250000));
  assertSilent(run(sandbox));
});

test("an unreadable transcript leaves other prompt output intact", (t) => {
  const sandbox = makeSandbox(t);
  assert.strictEqual(fs.existsSync(sandbox.transcript), false);
  assertContext(run(sandbox), SESSION_LANES_CONTEXT);
  assertSilent(run(sandbox));
});

test("an advisory claim failure leaves other prompt output intact", (t) => {
  const sandbox = makeSandbox(t);
  writeTranscript(sandbox, 250000);
  fs.writeFileSync(sandbox.workerStateDir, "blocked");
  assertContext(run(sandbox), SESSION_LANES_CONTEXT);
});

test("a fleet reminder claim failure leaves the context advisory intact", (t) => {
  const sandbox = makeSandbox(t);
  writeTranscript(sandbox, 250000);
  fs.writeFileSync(sandbox.dataDir, "blocked");
  assertContext(run(sandbox), advisoryContext(250000));
});

test("the narrow wave reminder and marker are gone", (t) => {
  const sandbox = makeSandbox(t);
  writeState(sandbox, { consecutiveNarrowWaves: 2 });
  const original = fs.readFileSync(statePath(sandbox), "utf8");
  assertContext(run(sandbox), SESSION_LANES_CONTEXT);
  assertSilent(run(sandbox));
  assert.throws(() => messageTag("fleet-posture.narrow-wave-reminder"), RangeError);
  assert.strictEqual(fs.existsSync(path.join(sandbox.dataDir, "fleet-posture", "narrow-wave-reminders")), false);
  assert.strictEqual(fs.readFileSync(statePath(sandbox), "utf8"), original);
});

test("a new session claim cleans old markers and legacy reminders once", (t) => {
  const sandbox = makeSandbox(t);
  const markerDirectory = path.dirname(sessionLanesReminderPath(sandbox));
  const oldMarker = path.join(markerDirectory, "old-session.marker");
  const recentMarker = path.join(markerDirectory, "recent-session.marker");
  const legacyDirectory = path.join(sandbox.dataDir, "fleet-posture", "narrow-wave-reminders");
  fs.mkdirSync(markerDirectory, { recursive: true });
  fs.writeFileSync(oldMarker, "\n", "utf8");
  fs.utimesSync(oldMarker, new Date(Date.now() - 49 * 60 * 60 * 1000), new Date(Date.now() - 49 * 60 * 60 * 1000));
  fs.writeFileSync(recentMarker, "\n", "utf8");
  fs.mkdirSync(legacyDirectory, { recursive: true });
  fs.writeFileSync(path.join(legacyDirectory, "session-1.marker"), "\n", "utf8");

  assertContext(run(sandbox), SESSION_LANES_CONTEXT);
  assert.strictEqual(fs.existsSync(oldMarker), false);
  assert.strictEqual(fs.existsSync(recentMarker), true);
  assert.strictEqual(fs.existsSync(legacyDirectory), false);

  const secondOldMarker = path.join(markerDirectory, "second-old-session.marker");
  fs.writeFileSync(secondOldMarker, "\n", "utf8");
  fs.utimesSync(secondOldMarker, new Date(Date.now() - 49 * 60 * 60 * 1000), new Date(Date.now() - 49 * 60 * 60 * 1000));
  fs.mkdirSync(legacyDirectory, { recursive: true });
  fs.writeFileSync(path.join(legacyDirectory, "session-1.marker"), "\n", "utf8");

  assertSilent(run(sandbox));
  assert.strictEqual(fs.existsSync(secondOldMarker), true);
  assert.strictEqual(fs.existsSync(legacyDirectory), true);
});

test("session lanes reminder renders the routing table's codex defaults", (t) => {
  const sandbox = makeSandbox(t);
  const routingFile = path.join(sandbox.root, "model-routing.json");
  const models = ["quick-choice", "volume-choice", "flagship-choice"].map((id) => ({ id, lane: "codex", intelligence: 5, taste: 4, cost: 3 }));
  fs.writeFileSync(routingFile, JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-07-04T00:00:00.000Z",
    costProfile: "",
    models,
    defaults: { codex: { quick: { model: "quick-choice", effort: "high" }, volume: { model: "volume-choice", effort: "low" }, flagship: { model: "flagship-choice", effort: "max" } } }
  }), "utf8");
  assertContext(run(sandbox, hookInput(sandbox), { FUSION_MODEL_ROUTING: routingFile }), tagMessage("fleet-posture.session-lanes-reminder", "fusion lanes ready: codex flagship-choice for spec grade and deep review, quick-choice and volume-choice for quick and volume packages, grok under its four roles on the routing table's lane defaults, cursor under diversity for a model family no other lane carries and under burst for bounded worktree implementation, claude workers for the Claude surface. Independent packages dispatch together in one message; three or more convene /fusion:ultra; a single coherent change stays inline."));
});

test("the session lanes reminder names the selected breadth engine", (t) => {
  const sandbox = makeSandbox(t);
  const routingFile = path.join(sandbox.root, "breadth-routing.json");
  const models = [{ id: "quick-choice", lane: "codex", intelligence: 5, taste: 4, cost: 3, notes: "" }];
  fs.writeFileSync(routingFile, JSON.stringify({ schemaVersion: 1, updatedAt: "2026-07-04T00:00:00.000Z", costProfile: "", breadth: "devin", models }), "utf8");
  const context = JSON.parse(run(sandbox, hookInput(sandbox), { FUSION_MODEL_ROUTING: routingFile }).stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /devin under diversity for a model family no other lane carries and under burst for bounded worktree implementation/);
  assert.doesNotMatch(context, /cursor under diversity/);
});

test("strict posture emits the legacy reminder without guard state", (t) => {
  const sandbox = makeSandbox(t);

  assertContext(run(sandbox, hookInput(sandbox), { FUSION_POSTURE: "strict" }), LEGACY_CONTEXT);
  assert.strictEqual(fs.existsSync(statePath(sandbox)), false);
  assert.strictEqual(fs.existsSync(sessionLanesReminderPath(sandbox)), false);
});

test("strict posture also emits the parent context advisory", (t) => {
  const sandbox = makeSandbox(t);
  writeTranscript(sandbox, 250000);
  assertContext(run(sandbox, hookInput(sandbox), { FUSION_POSTURE: "strict" }), `${LEGACY_CONTEXT}\n\n${advisoryContext(250000)}`);
  assertContext(run(sandbox, hookInput(sandbox), { FUSION_POSTURE: "strict" }), LEGACY_CONTEXT);
});

test("FUSION_FLEET_MODE=off suppresses only fleet reminders", (t) => {
  const sandbox = makeSandbox(t);
  writeTranscript(sandbox, 250000);

  assertContext(run(sandbox, hookInput(sandbox), { FUSION_FLEET_MODE: "off" }), advisoryContext(250000));
  assertSilent(run(sandbox, hookInput(sandbox), { FUSION_FLEET_MODE: "off", FUSION_POSTURE: "strict" }));
  assert.strictEqual(fs.existsSync(sessionLanesReminderPath(sandbox)), false);
  const strictSandbox = makeSandbox(t);
  writeTranscript(strictSandbox, 250000);
  assertContext(run(strictSandbox, hookInput(strictSandbox), { FUSION_FLEET_MODE: "off", FUSION_POSTURE: "strict" }), advisoryContext(250000));
});

test("the fleet mode state file suppresses reminders but keeps the context advisory", (t) => {
  const sandbox = makeSandbox(t);
  writeTranscript(sandbox, 250000);
  fs.mkdirSync(sandbox.dataDir, { recursive: true });
  fs.writeFileSync(path.join(sandbox.dataDir, "fleet-mode"), "off\n", "utf8");

  assertContext(run(sandbox), advisoryContext(250000));
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
});

test("malformed hook input is silent", (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, "{not json");

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});
