import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ENGINES, ENGINE_IDS, routedEngineIds } from "../plugins/fusion/scripts/lib/engines.mjs";
import { DEFAULT_MODEL_TABLE_PLACEHOLDER } from "../plugins/fusion/scripts/lib/model-table.mjs";
import { pacingLines, quotaResults } from "../plugins/fusion/scripts/lib/quota.mjs";
import { messageTag } from "../plugins/fusion/scripts/lib/user-messages.mjs";
import { companion as codexCompanion, waitFor } from "./lib/codex-companion-harness.mjs";

const scripts = path.join(import.meta.dirname, "..", "plugins", "fusion", "scripts");
const observedAt = "2026-11-20T00:00:00.000Z";
const resetAt = new Date(Date.now() + 5 * 24 * 60 * 60_000).toISOString();
const pool = { pool: "codex", costClass: "included", usedPercent: 79, windowMinutes: 10080, resetsAt: resetAt, pacing: 2.7 };
const report = (pools = [pool], extra = {}) => ({ engine: "codex", available: true, observedAt, pools, note: null, ...extra });
const expectedLine = `Codex pool codex is over pace: 79% used with 29% of its 7 day window elapsed (pacing 2.7), resets ${resetAt.slice(0, 10)}. Prefer free or included pools for quick and volume shapes until it is back on pace.`;

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-quota-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    FUSION_DATA_DIR: path.join(root, "data"),
    FUSION_WORKER_STATE_DIR: path.join(root, "workers"),
    FUSION_MODEL_ROUTING: path.join(root, "model-routing.json"),
    FUSION_RULES_FILE: path.join(root, "rules", "orchestration.md")
  };
  for (const engine of ENGINE_IDS) env[ENGINES[engine].companionEnv] = path.join(root, `missing-${engine}.mjs`);
  return { root, env };
}

function companion(box, engine, source = `process.stdout.write(JSON.stringify(${JSON.stringify(report([], { engine, available: false }))}));`) {
  const file = path.join(box.root, `${engine}.mjs`);
  fs.writeFileSync(file, `if (process.argv[2] === "host-check") { process.stdout.write(JSON.stringify({ blockers: [] })); } else { ${source} }\n`);
  box.env[ENGINES[engine].companionEnv] = file;
  return file;
}

function hook(box, name, args = []) {
  const result = spawnSync(process.execPath, [path.join(scripts, `${name}.mjs`), ...args], {
    env: box.env,
    input: JSON.stringify({ session_id: "quota-session", prompt: "do work" }),
    encoding: "utf8",
    timeout: 15_000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

test("pacing lines use strict pace and inclusive usage thresholds for every pool", () => {
  assert.deepEqual(pacingLines([report()]), [expectedLine]);
  assert.deepEqual(pacingLines([report([{ ...pool, usedPercent: 84.999, pacing: 1.15 }])]), []);
  assert.equal(pacingLines([report([{ ...pool, usedPercent: 84, pacing: 1.150001 }])]).length, 1);
  const lines = pacingLines([report([{ ...pool, usedPercent: 85, pacing: 1 }, { ...pool, pool: "secondary", usedPercent: 86, pacing: null, windowMinutes: null, resetsAt: null }])]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /near capacity: 85% used/);
  assert.match(lines[1], /pool secondary is near capacity: 86% used\./);
  assert.doesNotMatch(lines.join(""), /null|NaN|Infinity|[\u2013\u2014]/);
  const exhausted = pacingLines([report([{ ...pool, usedPercent: 90, pacing: 3.1 }])])[0];
  assert.match(exhausted, /is near exhaustion: 90% used/);
  assert.match(exhausted, /route flagship packages too to free or included pools/);
  assert.match(pacingLines([report([{ ...pool, usedPercent: 89.9, pacing: 3.1 }])])[0], /is over pace: 89\.9% used.*quick and volume shapes/);
});

test("pacing lines preserve unknown fields and describe short windows", () => {
  for (const [windowMinutes, label] of [[300, "5 hour"], [90, "90 minute"]]) {
    assert.match(pacingLines([report([{ ...pool, windowMinutes }])])[0], new RegExp(`${label} window`));
  }
  assert.match(pacingLines([report([{ ...pool, usedPercent: null }])])[0], /usage percentage unknown/);
  assert.deepEqual(pacingLines([report([{ ...pool, usedPercent: null, pacing: null }])]), []);
  assert.deepEqual(pacingLines([report([], { available: false }), null, {}, report([{ ...pool, pacing: "2.7" }]), report([{ ...pool, pool: "bad\ncontext" }])]), []);
});

test("pacing lines skip expired pools and omit elapsed percentages beyond the window", () => {
  const expired = { ...pool, resetsAt: new Date(Date.now() - 60_000).toISOString() };
  assert.deepEqual(pacingLines([report([expired])]), []);
  const line = pacingLines([report([{ ...pool, usedPercent: 85, pacing: 0.5 }])])[0];
  assert.match(line, /near capacity: 85% used \(pacing 0\.5\)/);
  assert.doesNotMatch(line, /elapsed/);
});

test("quota reader calls exactly the routed engine companions with quota --json", (t) => {
  const box = sandbox(t);
  for (const engine of ENGINE_IDS) {
    companion(box, engine, `import("node:assert/strict").then(({ default: assert }) => { assert.deepEqual(process.argv.slice(2), ["quota", "--json"]); process.stdout.write(JSON.stringify(${JSON.stringify(report([], { engine, available: false }))})); });`);
  }
  assert.deepEqual(quotaResults(box.env).map((result) => result.engine), routedEngineIds());
  fs.writeFileSync(box.env.FUSION_MODEL_ROUTING, JSON.stringify({ schemaVersion: 1, updatedAt: observedAt, costProfile: "included", breadth: "devin", models: [] }));
  assert.deepEqual(quotaResults(box.env).map((result) => result.engine), routedEngineIds("devin"));
});

test("quota cache is shared across processes, keyed by engine set, and refreshes after expiry or corruption", (t) => {
  const box = sandbox(t);
  const calls = path.join(box.root, "calls");
  for (const engine of ["codex", "grok"]) {
    companion(box, engine, `const fs = await import("node:fs"); fs.appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(`${engine}\n`)}); process.stdout.write(JSON.stringify(${JSON.stringify(report([], { engine }))}));`);
  }
  assert.deepEqual(quotaResults(box.env, { engines: ["codex"] }).map((result) => result.engine), ["codex"]);
  const script = `import { quotaResults } from ${JSON.stringify(new URL("../plugins/fusion/scripts/lib/quota.mjs", import.meta.url).href)}; process.stdout.write(JSON.stringify(quotaResults(process.env, { engines: ["codex"] })));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: box.env, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout).map((result) => result.engine), ["codex"]);
  assert.equal(fs.readFileSync(calls, "utf8"), "codex\n");
  assert.deepEqual(quotaResults(box.env, { engines: ["grok", "codex"] }).map((result) => result.engine), ["codex", "grok"]);
  assert.deepEqual(quotaResults(box.env, { engines: ["codex", "grok"] }).map((result) => result.engine), ["codex", "grok"]);
  assert.equal(fs.readFileSync(calls, "utf8"), "codex\ncodex\ngrok\n");
  const file = path.join(box.env.FUSION_DATA_DIR, "quota-codex.json");
  const cached = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...cached, fetchedAt: Date.now() - 60_001 }));
  quotaResults(box.env, { engines: ["codex"] });
  fs.writeFileSync(file, "{broken");
  assert.doesNotThrow(() => quotaResults(box.env, { engines: ["codex"] }));
  assert.equal(fs.readFileSync(calls, "utf8"), "codex\ncodex\ngrok\ncodex\ncodex\n");
});

test("the aggregate cache picks up a live refresh on the next quota read", (t) => {
  const box = sandbox(t);
  const file = path.join(box.root, "report.json");
  companion(box, "codex", `process.stdout.write((await import("node:fs")).readFileSync(${JSON.stringify(file)}));`);
  companion(box, "grok");
  const grok = report([], { engine: "grok", available: false });
  const stale = report([{ ...pool, usedPercent: 100 }], { refreshing: true });
  fs.writeFileSync(file, JSON.stringify(stale));
  assert.deepEqual(quotaResults(box.env), [stale, grok]);
  fs.writeFileSync(file, JSON.stringify(report()));
  assert.deepEqual(quotaResults(box.env), [report(), grok]);
  const cacheFile = path.join(box.env.FUSION_DATA_DIR, `quota-${routedEngineIds().sort().join("-")}.json`);
  const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  fs.writeFileSync(cacheFile, JSON.stringify({ ...cached, results: [stale, grok] }));
  assert.deepEqual(quotaResults(box.env), [report(), grok]);
  fs.unlinkSync(file);
  assert.deepEqual(quotaResults(box.env), [report(), grok]);
});

test("a failed Codex refresh lets subsequent hooks reuse the aggregate", async (t) => {
  const box = sandbox(t);
  Object.assign(box.env, {
    FUSION_CODEX_COMPANION: codexCompanion,
    CODEX_COMPANION_DATA: path.join(box.root, "codex-data"),
    CODEX_BIN: path.join(box.root, "missing-cli"),
    CODEX_HOME: box.root
  });
  fs.writeFileSync(path.join(box.root, "auth.json"), "{}");
  const calls = path.join(box.root, "calls");
  companion(box, "grok", `const fs = await import("node:fs"); fs.appendFileSync(${JSON.stringify(calls)}, "call\\n"); process.stdout.write(JSON.stringify(${JSON.stringify(report([], { engine: "grok" }))}));`);
  assert.equal(quotaResults(box.env)[0].refreshing, true);
  await waitFor(() => !fs.existsSync(path.join(box.env.CODEX_COMPANION_DATA, "quota-live.refreshing")));
  const results = quotaResults(box.env);
  assert.equal(results[0].engine, "codex");
  assert.equal(results[0].refreshing, undefined);
  assert.deepEqual(quotaResults(box.env), results);
  assert.equal(fs.readFileSync(calls, "utf8"), "call\ncall\n");
});

test("quota reader uses installed companion resolution and rejects invalid overrides", (t) => {
  const box = sandbox(t);
  const file = path.join(box.root, ".claude", "plugins", "cache", "claude-code-fusion", "codex", "999.0.0", "scripts", ENGINES.codex.companionFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `process.stdout.write(JSON.stringify(${JSON.stringify(report())}));`);
  delete box.env.FUSION_CODEX_COMPANION;
  assert.deepEqual(quotaResults(box.env), [report()]);
  box.env.FUSION_CODEX_COMPANION = "relative.mjs";
  assert.deepEqual(quotaResults(box.env), []);
});

test("quota reader ignores unavailable commands, malformed contracts, wrong identities, and nonzero exits", (t) => {
  const box = sandbox(t);
  for (const source of [
    'process.stderr.write("Unknown subcommand: quota."); process.exitCode = 1;',
    'process.stdout.write("{not json");',
    'process.stdout.write("null");',
    `process.stdout.write(JSON.stringify(${JSON.stringify(report([], { engine: "grok" }))}));`,
    `process.stdout.write(JSON.stringify(${JSON.stringify(report([{ ...pool, pacing: "2.7" }]))}));`,
    `process.stdout.write(JSON.stringify(${JSON.stringify(report())})); process.exitCode = 1;`
  ]) {
    companion(box, "codex", source);
    assert.deepEqual(quotaResults(box.env), []);
  }
});

test("quota reader times out a hung companion even if it ignores SIGTERM", (t) => {
  const box = sandbox(t);
  companion(box, "codex", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
  const started = Date.now();
  assert.deepEqual(quotaResults(box.env, { timeoutMs: 100 }), []);
  assert.ok(Date.now() - started < 2000);
});

test("session start, compaction, and fleet posture include the same quota lines", (t) => {
  const box = sandbox(t);
  const calls = path.join(box.root, "calls");
  companion(box, "codex", `const fs = await import("node:fs"); fs.appendFileSync(${JSON.stringify(calls)}, "call\\n"); process.stdout.write(JSON.stringify(${JSON.stringify(report())}));`);
  for (const args of [[], ["--compact"]]) {
    const output = hook(box, "session-start", args);
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    assert.ok(output.hookSpecificOutput.additionalContext.includes(`${expectedLine}\n`));
    assert.ok(output.hookSpecificOutput.additionalContext.includes(DEFAULT_MODEL_TABLE_PLACEHOLDER));
  }
  const posture = hook(box, "fleet-posture");
  assert.equal(posture.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(posture.hookSpecificOutput.additionalContext, expectedLine);
  assert.equal(fs.readFileSync(calls, "utf8"), "call\n");
});

test("session start and compaction warn when a newer fusion plugin is installed", (t) => {
  const box = sandbox(t);
  const tag = messageTag("session.plugin-stale");
  const context = (args) => hook(box, "session-start", args).hookSpecificOutput.additionalContext;
  for (const args of [[], ["--compact"]]) {
    assert.ok(!context(args).includes(tag));
  }
  const cached = path.join(box.root, ".claude", "plugins", "cache", "claude-code-fusion", "fusion", "99.0.0", "scripts", "session-start.mjs");
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, "export {};\n");
  for (const args of [[], ["--compact"]]) {
    assert.ok(context(args).includes(`while 99.0.0 is installed, so its hooks and rules predate the update. Restart the session to load 99.0.0. ${tag}\n`));
  }
});

test("quota failures leave session start and fleet posture functional", (t) => {
  const box = sandbox(t);
  for (const source of ['throw new Error("quota unavailable");', 'process.stdout.write("bad json");', 'setInterval(() => {}, 1000);']) {
    companion(box, "codex", source);
    const output = hook(box, "session-start");
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    assert.ok(output.hookSpecificOutput.additionalContext.endsWith(DEFAULT_MODEL_TABLE_PLACEHOLDER));
    assert.equal(hook(box, "fleet-posture"), null);
  }
});
