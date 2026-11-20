import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { messageTag, tagMessage } from "../plugins/fusion/scripts/lib/user-messages.mjs";
import { claimParentContextAdvisory } from "../plugins/fusion/scripts/lib/lifecycle/dispatch.mjs";
import { ENGINES } from "../plugins/fusion/scripts/lib/engines.mjs";

const script = path.join(import.meta.dirname, "..", "plugins", "fusion", "scripts", "fleet-posture.mjs");
const DEEP_REASONER_HINT = tagMessage("fleet-posture.deep-reasoner-hint", "This reads as a design or root-cause question. Consult fusion:deep-reasoner with a scoped brief before deciding.");
const advisoryNotice = (tokens) => tagMessage("fleet-posture.context-advisory", `The main loop context is ${Math.round(tokens / 1000)}k tokens and every turn replays it. /compact or a fresh session before the next goal cuts that cost.`);

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-posture-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dataDir: path.join(root, "fusion-data"), stateDir: path.join(root, "inline-guard"), workerStateDir: path.join(root, "workers"), transcript: path.join(root, "transcript.jsonl") };
}

function envFor(box, extra = {}) {
  return { ...process.env, ...Object.fromEntries(Object.values(ENGINES).map((engine) => [engine.companionEnv, path.join(box.root, `missing-${engine.id}.mjs`)])), FUSION_DATA_DIR: box.dataDir, FUSION_INLINE_GUARD_STATE: box.stateDir, FUSION_WORKER_STATE_DIR: box.workerStateDir, ...extra };
}

function input(box, prompt = "do work", sessionId = "session-1") {
  return JSON.stringify({ session_id: sessionId, prompt, transcript_path: box.transcript });
}

function run(box, prompt = "do work", extraEnv = {}, sessionId = "session-1") {
  return spawnSync(process.execPath, [script], { input: input(box, prompt, sessionId), env: envFor(box, extraEnv), encoding: "utf8" });
}

function assertContext(result, additionalContext = null, systemMessage = null) {
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stderr, "");
  const expected = { ...(additionalContext ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } } : {}), ...(systemMessage ? { systemMessage } : {}) };
  if (Object.keys(expected).length) assert.deepStrictEqual(JSON.parse(result.stdout), expected);
  else assert.strictEqual(result.stdout, "");
}

function writeTranscript(box, tokens) {
  fs.appendFileSync(box.transcript, `${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}\n`);
}

function hintMarkerPath(box, sessionId = "session-1") {
  return path.join(box.dataDir, "fleet-posture", "deep-reasoner-hints", `${sessionId}.marker`);
}

test("ordinary prompts emit no session lanes reminder or marker", (t) => {
  const box = makeSandbox(t);
  assertContext(run(box));
  assertContext(run(box));
  assert.strictEqual(fs.existsSync(path.join(box.dataDir, "fleet-posture", "session-lanes-reminders")), false);
});

test("design questions receive one hint per session", (t) => {
  const box = makeSandbox(t);
  assertContext(run(box, "思考一下为什么这个架构会失败"), DEEP_REASONER_HINT);
  assertContext(run(box, "WHY IS the root cause hard to find?"));
  assertContext(run(box, "How should we redesign the API?", {}, "session-2"), DEEP_REASONER_HINT);
  const marker = hintMarkerPath(box);
  assert.strictEqual(fs.statSync(marker).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(marker)).mode & 0o777, 0o700);
});

test("implementation requests and generated prompts never receive a design hint", (t) => {
  const box = makeSandbox(t);
  const prompts = [
    "分析这个架构然后解决问题直到全部重构修复完成为止",
    "分析并实现解决方案", "思考后改代码", "why is this slow? fix it", "redesign and implement it", "how should we ship it?", "分析后走流程",
    "/why is this slow", "<task-notification><summary>why is this slow</summary></task-notification>",
    JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "why is this slow" }),
    `why is this slow ${"x".repeat(4000)}`
  ];
  for (const prompt of prompts) assertContext(run(box, prompt));
  assertContext(spawnSync(process.execPath, [script], { input: JSON.stringify({ session_id: "session-1", prompt: "why is this slow", isMeta: true }), env: envFor(box), encoding: "utf8" }));
  assertContext(run(box, "why is this slow", {}, ""));
});

test("parent context below threshold adds no advisory", (t) => {
  const box = makeSandbox(t);
  writeTranscript(box, 249999);
  assertContext(run(box));
  assert.strictEqual(fs.existsSync(path.join(box.workerStateDir, "sessions", "session-1.json")), false);
});

test("parent context advisory sends once at each threshold across prompts", (t) => {
  const box = makeSandbox(t);
  writeTranscript(box, 250000);
  assertContext(run(box), null, advisoryNotice(250000));
  assertContext(run(box));
  writeTranscript(box, 800000);
  assertContext(run(box), null, advisoryNotice(800000));
  assertContext(run(box));
});

test("a first reading past both thresholds shows one notice", (t) => {
  const box = makeSandbox(t);
  writeTranscript(box, 800000);
  assertContext(run(box), null, advisoryNotice(800000));
  assertContext(run(box));
});

test("a design hint and context advisory can appear together", (t) => {
  const box = makeSandbox(t);
  writeTranscript(box, 250000);
  assertContext(run(box, "why is this slow?"), DEEP_REASONER_HINT, advisoryNotice(250000));
  assertContext(run(box, "why is this slow?"));
});

test("dispatch claim suppresses a prompt advisory", (t) => {
  const box = makeSandbox(t);
  writeTranscript(box, 250000);
  assert.strictEqual(claimParentContextAdvisory("session-1", 250000, envFor(box)), advisoryNotice(250000));
  assertContext(run(box));
});

test("an unreadable transcript leaves other prompt output intact", (t) => {
  const box = makeSandbox(t);
  assert.strictEqual(fs.existsSync(box.transcript), false);
  assertContext(run(box, "why is this slow?"), DEEP_REASONER_HINT);
});

test("an advisory claim failure leaves other prompt output intact", (t) => {
  const box = makeSandbox(t);
  writeTranscript(box, 250000);
  fs.writeFileSync(box.workerStateDir, "blocked");
  assertContext(run(box, "why is this slow?"), DEEP_REASONER_HINT);
});

test("a new session claim cleans old markers and legacy reminders once", (t) => {
  const box = makeSandbox(t);
  const markerDirectory = path.dirname(hintMarkerPath(box));
  const oldMarker = path.join(markerDirectory, "old-session.marker");
  const recentMarker = path.join(markerDirectory, "recent-session.marker");
  const legacyDirectories = ["session-lanes-reminders", "narrow-wave-reminders"].map((name) => path.join(box.dataDir, "fleet-posture", name));
  fs.mkdirSync(markerDirectory, { recursive: true });
  fs.writeFileSync(oldMarker, "\n");
  fs.utimesSync(oldMarker, new Date(Date.now() - 49 * 60 * 60 * 1000), new Date(Date.now() - 49 * 60 * 60 * 1000));
  fs.writeFileSync(recentMarker, "\n");
  for (const directory of legacyDirectories) {
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "session-1.marker"), "\n");
  }

  assertContext(run(box, "why is this slow?"), DEEP_REASONER_HINT);
  assert.strictEqual(fs.existsSync(oldMarker), false);
  assert.strictEqual(fs.existsSync(recentMarker), true);
  for (const directory of legacyDirectories) assert.strictEqual(fs.existsSync(directory), false);

  const secondOldMarker = path.join(markerDirectory, "second-old-session.marker");
  fs.writeFileSync(secondOldMarker, "\n");
  fs.utimesSync(secondOldMarker, new Date(Date.now() - 49 * 60 * 60 * 1000), new Date(Date.now() - 49 * 60 * 60 * 1000));
  for (const directory of legacyDirectories) {
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "session-1.marker"), "\n");
  }

  assertContext(run(box, "why is this slow?"));
  assert.strictEqual(fs.existsSync(secondOldMarker), true);
  for (const directory of legacyDirectories) assert.strictEqual(fs.existsSync(directory), true);
});

test("the narrow wave reminder and marker are gone", (t) => {
  const box = makeSandbox(t);
  const statePath = path.join(box.stateDir, "session-1.json");
  fs.mkdirSync(box.stateDir);
  fs.writeFileSync(statePath, JSON.stringify({ consecutiveNarrowWaves: 2 }));
  const original = fs.readFileSync(statePath, "utf8");
  assertContext(run(box, "why is this slow?"), DEEP_REASONER_HINT);
  assertContext(run(box));
  assert.throws(() => messageTag("fleet-posture.narrow-wave-reminder"), RangeError);
  assert.strictEqual(fs.existsSync(path.join(box.dataDir, "fleet-posture", "narrow-wave-reminders")), false);
  assert.strictEqual(fs.readFileSync(statePath, "utf8"), original);
});

test("malformed hook input is silent", (t) => {
  const box = makeSandbox(t);
  assertContext(spawnSync(process.execPath, [script], { input: "{not json", env: envFor(box), encoding: "utf8" }));
});
