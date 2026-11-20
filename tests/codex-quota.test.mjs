import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { codexHome, latestRolloutRateLimits, recoverRolloutObservation } from "../plugins/codex/scripts/lib/codex-rollout.mjs";
import { envFor, makeSandbox, runCompanion } from "./lib/codex-companion-harness.mjs";

const fixture = path.join(import.meta.dirname, "fixtures", "codex-quota.jsonl");
const observedMs = Math.floor((Date.now() - 3_600_000) / 1000) * 1000;
const observedAt = new Date(observedMs).toISOString();
const resetSeconds = observedMs / 1000 + 5 * 24 * 60 * 60;
const primary = { used_percent: 79, window_minutes: 10080, resets_at: resetSeconds };

function currentFixture() {
  return fs.readFileSync(fixture, "utf8")
    .replaceAll("1795564800", String(resetSeconds))
    .replaceAll("2026-11-19T00:00:00Z", new Date(observedMs - 24 * 60 * 60_000).toISOString())
    .replaceAll("2026-11-20T00:00:00Z", observedAt);
}

function rollout(box, limits, { name = "rollout-weekly.jsonl", timestamp = observedAt, mtime = Date.now() } = {}) {
  const file = path.join(box.codexHome, "sessions", "2026", "11", "20", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", rate_limits: limits } })}\n`);
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

function quota(box, extraEnv = {}) {
  const result = runCompanion(["quota", "--json"], { cwd: box.workDir, env: envFor(box, extraEnv) });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(report).sort(), ["available", "engine", "note", "observedAt", "pools"]);
  return report;
}

test("rollout JSONL exposes the last token_count rate_limits and its timestamp", () => {
  const observation = recoverRolloutObservation(null, { file: fixture });
  assert.deepEqual(observation.rateLimits.primary, { used_percent: 79, window_minutes: 10080, resets_at: 1795564800 });
  assert.equal(observation.rateLimits.plan_type, "pro");
  assert.equal(observation.rateLimitsObservedAt, "2026-11-20T00:00:00.000Z");
  assert.equal(observation.cumulativeTokenUsage.totalTokens, 12);
  assert.equal(recoverRolloutObservation(null, { file: fixture, notBeforeMs: Date.parse("2026-11-21") }).rateLimits, null);
});

test("quota reads CODEX_HOME and calculates weekly and secondary pacing at observation time", (t) => {
  const box = makeSandbox(t);
  const observedMs = Math.floor(Date.now() / 1000) * 1000 - 60_000;
  const observedIso = new Date(observedMs).toISOString();
  rollout(box, {
    plan_type: "pro",
    primary: { used_percent: 79, window_minutes: 10080, resets_at: observedMs / 1000 + 5 * 24 * 60 * 60 },
    secondary: { used_percent: 25, window_minutes: 300, resets_at: observedMs / 1000 + 9000 }
  }, { timestamp: observedIso });
  const report = quota(box, { CODEX_BIN: path.join(box.root, "missing-cli") });
  assert.equal(report.engine, "codex");
  assert.equal(report.available, true);
  assert.equal(report.observedAt, observedIso);
  assert.equal(report.note, null);
  assert.equal(report.pools.length, 2);
  assert.deepEqual(report.pools[0], { pool: "codex", costClass: "included", usedPercent: 79, windowMinutes: 10080, resetsAt: new Date(observedMs + 5 * 24 * 60 * 60_000).toISOString(), pacing: 79 / (100 * (1 - 5 / 7)) });
  assert.deepEqual(report.pools[1], { pool: "codex-secondary", costClass: "included", usedPercent: 25, windowMinutes: 300, resetsAt: new Date(observedMs + 9_000_000).toISOString(), pacing: 0.5 });
  assert.equal(codexHome({ CODEX_HOME: ` ${box.codexHome} ` }), box.codexHome);
});

test("quota falls back through newer rollouts without telemetry to the newest usable file", (t) => {
  const box = makeSandbox(t);
  rollout(box, { primary: { ...primary, used_percent: 90 } }, { name: "rollout-older.jsonl", mtime: 1000 });
  const file = rollout(box, {}, { mtime: 2000 });
  fs.writeFileSync(file, currentFixture());
  fs.utimesSync(file, new Date(2000), new Date(2000));
  rollout(box, null, { name: "rollout-latest.jsonl", mtime: 3000 });
  assert.equal(latestRolloutRateLimits(envFor(box)).rateLimits.primary.used_percent, 79);
  const report = quota(box);
  assert.equal(report.pools.length, 1);
  assert.equal(report.pools[0].usedPercent, 79);
});

test("quota caches successes and unavailable results for 60 seconds and refreshes expired caches", (t) => {
  const box = makeSandbox(t);
  const missing = quota(box);
  assert.equal(missing.available, false);
  assert.deepEqual(missing.pools, []);
  assert.match(missing.note, /No rate_limits/);
  rollout(box, { primary, secondary: null });
  assert.deepEqual(quota(box), missing);
  const file = path.join(box.dataDir, "quota.json");
  const cached = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...cached, at: Date.now() - 60_001 }));
  const report = quota(box);
  assert.equal(report.available, true);
  fs.rmSync(path.join(box.codexHome, "sessions"), { recursive: true });
  assert.deepEqual(quota(box), report);
  const success = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...success, at: Date.now() - 60_001 }));
  assert.equal(quota(box).available, false);
});

test("quota retains telemetry before a large trailing event and ignores partial JSONL", (t) => {
  const box = makeSandbox(t);
  const file = rollout(box, { primary });
  fs.appendFileSync(file, `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(300_000) }] } })}\n{"type":"event_msg","payload":`);
  assert.equal(quota(box).pools[0].usedPercent, 79);
});

test("quota ignores corrupt, future, and different home caches and tolerates cache write failure", (t) => {
  const box = makeSandbox(t);
  rollout(box, { primary });
  quota(box);
  const file = path.join(box.dataDir, "quota.json");
  const cached = JSON.parse(fs.readFileSync(file, "utf8"));
  rollout(box, { primary: { ...primary, used_percent: 80 } });
  for (const text of ["{", JSON.stringify({ ...cached, at: Date.now() + 60_000 }), JSON.stringify({ ...cached, home: "/other" })]) {
    fs.writeFileSync(file, text);
    assert.equal(quota(box).pools[0].usedPercent, 80);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).home, box.codexHome);
  }
  const blocked = path.join(box.root, "blocked");
  fs.writeFileSync(blocked, "file");
  assert.equal(quota(box, { CODEX_COMPANION_DATA: blocked }).available, true);
});

test("quota returns unavailable for unreadable session roots and missing windows", (t) => {
  const box = makeSandbox(t);
  fs.writeFileSync(path.join(box.codexHome, "sessions"), "file");
  assert.equal(quota(box).available, false);
  fs.rmSync(path.join(box.codexHome, "sessions"));
  rollout(box, {});
  fs.rmSync(path.join(box.dataDir, "quota.json"));
  const report = quota(box);
  assert.equal(report.available, false);
  assert.match(report.note, /no quota windows/);
});

test("quota preserves unknowns and never emits invalid pacing at window boundaries", (t) => {
  const box = makeSandbox(t);
  const observedSeconds = Date.parse(observedAt) / 1000;
  for (const [window, timestamp, expected] of [
    [{}, observedAt, { usedPercent: null, windowMinutes: null, resetsAt: null }],
    [{ ...primary, used_percent: null }, observedAt, { usedPercent: null }],
    [{ ...primary, window_minutes: 0 }, observedAt, { windowMinutes: null }],
    [{ ...primary, resets_at: "1795564800" }, observedAt, { resetsAt: null }],
    [{ ...primary, resets_at: 1e300 }, observedAt, { resetsAt: null }],
    [{ ...primary, resets_at: observedSeconds + 10080 * 60 }, observedAt, {}],
    [{ ...primary, resets_at: observedSeconds + 10080 * 60 + 1 }, observedAt, {}],
    [{ ...primary, resets_at: observedSeconds - 1 }, observedAt, { usedPercent: null }],
    [primary, "unknown", {}]
  ]) {
    rollout(box, { primary: window }, { timestamp });
    fs.rmSync(path.join(box.dataDir, "quota.json"), { force: true });
    const pool = quota(box).pools[0];
    assert.equal(pool.pacing, null);
    for (const [key, value] of Object.entries(expected)) assert.equal(pool[key], value);
  }
});

test("latestRolloutRateLimits scans only the eight newest rollout files", (t) => {
  const box = makeSandbox(t);
  for (let index = 1; index <= 9; index += 1) {
    rollout(box, null, { name: `rollout-empty-${index}.jsonl`, mtime: index * 1000 });
  }
  rollout(box, { primary }, { name: "rollout-telemetry.jsonl", mtime: 500 });
  assert.equal(latestRolloutRateLimits(envFor(box)), null);
  fs.rmSync(path.join(box.codexHome, "sessions", "2026", "11", "20", "rollout-telemetry.jsonl"));
  rollout(box, { primary: { ...primary, used_percent: 42 } }, { name: "rollout-telemetry.jsonl", mtime: 2500 });
  assert.equal(latestRolloutRateLimits(envFor(box)).rateLimits.primary.used_percent, 42);
});

test("latestRolloutRateLimits reads only the last two megabytes of each rollout file", (t) => {
  const box = makeSandbox(t);
  const directory = path.join(box.codexHome, "sessions", "2026", "11", "20");
  fs.mkdirSync(directory, { recursive: true });
  const padding = `${JSON.stringify({ timestamp: observedAt, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(3 * 1024 * 1024) }] } })}\n`;
  const tokenCount = `${JSON.stringify({ timestamp: observedAt, type: "event_msg", payload: { type: "token_count", rate_limits: { primary } } })}\n`;
  const early = path.join(directory, "rollout-early.jsonl");
  fs.writeFileSync(early, tokenCount + padding);
  fs.utimesSync(early, new Date(2000), new Date(2000));
  assert.equal(latestRolloutRateLimits(envFor(box)), null);
  const late = path.join(directory, "rollout-late.jsonl");
  fs.writeFileSync(late, padding + tokenCount);
  fs.utimesSync(late, new Date(1000), new Date(1000));
  assert.equal(latestRolloutRateLimits(envFor(box)).rateLimits.primary.used_percent, 79);
});

test("quota reports null resetsAt for resets_at that is not a positive number", (t) => {
  const box = makeSandbox(t);
  for (const resetsAt of [0, -42, null, undefined]) {
    const window = { ...primary, resets_at: resetsAt };
    if (resetsAt === undefined) {
      delete window.resets_at;
    }
    rollout(box, { primary: window });
    fs.rmSync(path.join(box.dataDir, "quota.json"), { force: true });
    const pool = quota(box).pools[0];
    assert.equal(pool.resetsAt, null);
    assert.equal(pool.usedPercent, 79);
    assert.equal(pool.pacing, null);
  }
});

test("quota nulls usedPercent and pacing for pools whose reset passed or whose observation aged out", (t) => {
  const box = makeSandbox(t);
  const nowMs = Math.floor(Date.now() / 1000) * 1000;
  rollout(box, { primary: { used_percent: 60, window_minutes: 10080, resets_at: nowMs / 1000 - 60 } }, { timestamp: new Date(nowMs).toISOString() });
  let pool = quota(box).pools[0];
  assert.equal(pool.usedPercent, null);
  assert.equal(pool.pacing, null);
  assert.equal(pool.windowMinutes, 10080);
  assert.equal(pool.resetsAt, new Date(nowMs - 60_000).toISOString());
  fs.rmSync(path.join(box.dataDir, "quota.json"), { force: true });
  rollout(box, { primary: { used_percent: 60, window_minutes: 5, resets_at: nowMs / 1000 + 3600 } }, { timestamp: new Date(nowMs - 10 * 60_000).toISOString() });
  pool = quota(box).pools[0];
  assert.equal(pool.usedPercent, null);
  assert.equal(pool.pacing, null);
  assert.equal(pool.windowMinutes, 5);
  assert.equal(pool.resetsAt, new Date(nowMs + 3_600_000).toISOString());
});

test("quota treats an elapsed fraction of exactly one as unknown pacing", (t) => {
  const box = makeSandbox(t);
  const observedSeconds = Math.ceil(Date.now() / 1000) + 3600;
  rollout(box, { primary: { used_percent: 40, window_minutes: 60, resets_at: observedSeconds } }, { timestamp: new Date(observedSeconds * 1000).toISOString() });
  const pool = quota(box).pools[0];
  assert.equal(pool.usedPercent, 40);
  assert.equal(pool.pacing, null);
  assert.equal(pool.resetsAt, new Date(observedSeconds * 1000).toISOString());
});

test("quota derives costClass from rate_limits plan_type", (t) => {
  const box = makeSandbox(t);
  for (const [planType, expected] of [
    ["plus", "included"],
    ["pro", "included"],
    ["team", "included"],
    ["business", "included"],
    ["enterprise", "included"],
    ["edu", "included"],
    ["api", "metered"],
    ["usage", "metered"],
    ["free", null],
    [null, null],
    [42, null]
  ]) {
    rollout(box, { plan_type: planType, primary });
    fs.rmSync(path.join(box.dataDir, "quota.json"), { force: true });
    assert.equal(quota(box).pools[0].costClass, expected);
  }
});

test("quota ignores cached reports whose pools have invalid fields", (t) => {
  const box = makeSandbox(t);
  rollout(box, { primary });
  const report = quota(box);
  assert.equal(report.pools[0].usedPercent, 79);
  const file = path.join(box.dataDir, "quota.json");
  const cached = JSON.parse(fs.readFileSync(file, "utf8"));
  const missingPacing = { ...report.pools[0] };
  delete missingPacing.pacing;
  for (const pool of [
    { ...report.pools[0], usedPercent: "79" },
    { ...report.pools[0], pacing: "fast" },
    { ...report.pools[0], costClass: "bogus" },
    { ...report.pools[0], resetsAt: 12345 },
    { ...report.pools[0], windowMinutes: -1 },
    { ...report.pools[0], pool: 42 },
    missingPacing
  ]) {
    fs.writeFileSync(file, JSON.stringify({ ...cached, at: Date.now(), report: { ...cached.report, pools: [pool] } }));
    assert.deepEqual(quota(box).pools, report.pools);
  }
});
