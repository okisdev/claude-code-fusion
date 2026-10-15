import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  DEFAULT_MODEL_TABLE_PLACEHOLDER,
  DEFAULT_ROUTING_DEFAULTS,
  readRoutingDefaults,
  renderModelTableFromContents,
  renderModelTableFromFile,
  validateModelRoutingData
} from "../plugins/fusion/scripts/lib/model-table.mjs";

const ROUTING = {
  schemaVersion: 1,
  updatedAt: "2026-07-04T00:00:00.000Z",
  costProfile: "",
  models: [
    { id: "gpt-6-sol", lane: "codex", intelligence: 5, taste: 4, cost: 5 },
    { id: "grok-4.7", lane: "grok", intelligence: 5, taste: 4, cost: 4 }
  ]
};

function sandbox(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-model-table-test-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRouting(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

test("Rules table renders scores without Notes and points to config", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "model-routing.json");
  writeRouting(file, {
    schemaVersion: 1,
    updatedAt: "2026-07-04T00:00:00.000Z",
    costProfile: "peer subscriptions flat rate",
    models: [
      { id: "codex", lane: "codex", intelligence: 5, taste: 4, cost: 5, notes: "primary implementation lane" },
      { id: "grok-fast", lane: "grok", intelligence: 3, taste: 3, cost: 5 }
    ]
  });

  const table = renderModelTableFromFile(file);
  assert.strictEqual(renderModelTableFromContents(fs.readFileSync(file, "utf8")), table);
  assert.match(table, /^Cost profile: peer subscriptions flat rate$/m);
  assert.match(table, /^\| Engine \| Lane \| Family \| Intelligence \| Taste \| Cost \|$/m);
  assert.match(table, /^\|---\|---\|---\|---:\|---:\|---:\|$/m);
  assert.match(table, /^\| codex \| codex \| openai \| 5 \| 4 \| 5 \|$/m);
  assert.doesNotMatch(table, /primary implementation lane|\| Notes \|/);
  assert.match(table, /^Lane defaults: codex quick gpt-6-sol@xhigh, volume gpt-6-luna@xhigh, flagship gpt-6-astra@xhigh; grok burst grok-4\.7-build-fast@low, independence grok-4\.7-build-fast@high, live-web grok-4\.7-build-fast@high, large-context grok-4\.6@medium; cursor diversity muse-spark-1\.3@xhigh, burst composer-2\.5@default\.$/m);
  assert.match(table, /\| grok-fast \| grok \| xai \| 3 \| 3 \| 5 \|\nModel notes \(benchmarks, prices, latency\) live in model-routing\.json; `\/fusion:config` shows them\.\n\nLane defaults: [^\n]+\n\nScores feed/);
  assert.match(
    table,
    /^Scores feed the routing priorities above: intelligence proxies correctness and safety, taste is user facing quality, cost applies only as the final tie breaker\.$/m
  );
  assert.match(table, /^Scores are user-assigned via \/fusion:config; re-score when the model lineup changes\.$/m);
});

test("Routing defaults merge file choices over the seed and preserve only supported fields", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "model-routing.json");
  writeRouting(file, {
    ...ROUTING,
    defaults: {
      codex: { quick: { model: " gpt-6-sol ", effort: "high", ignored: true } },
      grok: { independence: { model: "grok-4.7", effort: "max" } }
    }
  });
  const validated = validateModelRoutingData(JSON.parse(fs.readFileSync(file, "utf8")));
  assert.strictEqual(validated.ok, true);
  assert.deepStrictEqual(validated.data.defaults, {
    codex: { quick: { model: "gpt-6-sol", effort: "high" } },
    grok: { independence: { model: "grok-4.7", effort: "max" } }
  });
  assert.deepStrictEqual(readRoutingDefaults({ FUSION_MODEL_ROUTING: file }), {
    codex: { ...DEFAULT_ROUTING_DEFAULTS.codex, quick: { model: "gpt-6-sol", effort: "high" } },
    grok: { ...DEFAULT_ROUTING_DEFAULTS.grok, independence: { model: "grok-4.7", effort: "max" } },
    cursor: DEFAULT_ROUTING_DEFAULTS.cursor
  });
  assert.match(renderModelTableFromFile(file), /Lane defaults: codex quick gpt-6-sol@high, volume gpt-6-luna@xhigh, flagship gpt-6-astra@xhigh; grok burst grok-4\.7-build-fast@low, independence grok-4\.7@max/);
});

test("Cursor requires a valid family and declared families survive sanitization", () => {
  const row = { id: "muse-spark-1.3", lane: "cursor", intelligence: 4, taste: 5, cost: 3 };
  for (const family of [undefined, "OpenAI", "two words", "", "-x", 5]) {
    const result = validateModelRoutingData({ ...ROUTING, models: [...ROUTING.models, { ...row, ...(family === undefined ? {} : { family }) }] });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /models\[2\]\.family/);
  }
  const valid = validateModelRoutingData({ ...ROUTING, models: [...ROUTING.models, { ...row, family: "anthropic", ignored: true }] });
  assert.strictEqual(valid.ok, true);
  assert.strictEqual(valid.data.models[2].family, "anthropic");
  assert.strictEqual(Object.hasOwn(valid.data.models[0], "family"), false);
  assert.strictEqual(Object.hasOwn(valid.data.models[2], "ignored"), false);
});

test("Rendering uses declared and effective model families", () => {
  const rows = [
    { id: "codex-model", lane: "codex" },
    { id: "grok-model", lane: "grok" },
    { id: "claude-model", lane: "claude-fast" },
    { id: "cursor-model", lane: "cursor", family: "anthropic" },
    { id: "other-model", lane: "other" },
    { id: "override", lane: "codex", family: "custom-family" }
  ].map((row) => ({ ...row, intelligence: 3, taste: 3, cost: 3 }));
  const validated = validateModelRoutingData({ ...ROUTING, models: rows });
  assert.strictEqual(validated.ok, true);
  const table = renderModelTableFromContents(JSON.stringify(validated.data));
  for (const [id, lane, family] of [["codex-model", "codex", "openai"], ["grok-model", "grok", "xai"], ["claude-model", "claude-fast", "anthropic"], ["cursor-model", "cursor", "anthropic"], ["other-model", "other", ""], ["override", "codex", "custom-family"]]) {
    assert.ok(table.includes(`| ${id} | ${lane} | ${family} | 3 | 3 | 3 |`));
  }
});

test("Routing default validation rejects malformed lanes, roles, choices, efforts, and row mismatches", () => {
  const invalidDefaults = [
    [null, /Expected defaults to be an object/],
    [{ other: {} }, /Expected defaults lane/],
    [{ codex: [] }, /Expected defaults\.codex to be an object/],
    [{ codex: { burst: { model: "gpt-6-sol", effort: "low" } } }, /Expected defaults\.codex role/],
    [{ codex: { quick: null } }, /Expected defaults\.codex\.quick to be an object/],
    [{ codex: { quick: { model: " ", effort: "low" } } }, /Expected defaults\.codex\.quick\.model to be a non-empty string/],
    [{ codex: { quick: { model: "gpt-6-sol", effort: "ultra" } } }, /Expected defaults\.codex\.quick\.effort/],
    [{ grok: { burst: { model: "gpt-6-sol", effort: "low" } } }, /match a model in the grok lane/],
    [{ codex: { quick: { model: "gpt-6-astra", effort: "low" } } }, /match a model in the codex lane/]
  ];
  for (const [defaults, reason] of invalidDefaults) {
    const result = validateModelRoutingData({ ...ROUTING, defaults });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, reason);
  }
});

test("Missing and invalid routing files return seed defaults, with one warning for invalid data", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "model-routing.json");
  const warnings = [];
  const env = { FUSION_MODEL_ROUTING: file };
  assert.deepStrictEqual(readRoutingDefaults(env, { warn: (message) => warnings.push(message) }), DEFAULT_ROUTING_DEFAULTS);
  assert.deepStrictEqual(warnings, []);
  writeRouting(file, { ...ROUTING, defaults: { codex: { quick: { model: "missing", effort: "high" } } } });
  assert.deepStrictEqual(readRoutingDefaults(env, { warn: (message) => warnings.push(message) }), DEFAULT_ROUTING_DEFAULTS);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], new RegExp(`^fusion: model routing file invalid at ${file}:`));
});

test("Missing model routing file renders the fallback placeholder", (t) => {
  const dir = sandbox(t);
  assert.strictEqual(renderModelTableFromFile(path.join(dir, "missing.json")), DEFAULT_MODEL_TABLE_PLACEHOLDER);
});

test("Invalid model routing file renders the supplied fallback and warns", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "model-routing.json");
  fs.writeFileSync(file, "{ not json", "utf8");
  const warnings = [];
  assert.strictEqual(renderModelTableFromFile(file, "existing scored region", { warn: (message) => warnings.push(message) }), "existing scored region");
  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].startsWith(`fusion: model routing file invalid at ${file}:`));
});

test("Model routing validation rejects duplicate lane and id pairs", () => {
  const duplicate = validateModelRoutingData({
    ...ROUTING,
    models: [
      ...ROUTING.models,
      { id: "gpt-6-sol", lane: "codex", intelligence: 3, taste: 3, cost: 3 }
    ]
  });
  assert.strictEqual(duplicate.ok, false);
  assert.match(duplicate.reason, /Duplicate model routing row for lane codex and id gpt-6-sol/);
  const distinctLanes = validateModelRoutingData({
    ...ROUTING,
    models: [
      ...ROUTING.models,
      { id: "gpt-6-sol", lane: "other", intelligence: 3, taste: 3, cost: 3 }
    ]
  });
  assert.strictEqual(distinctLanes.ok, true);
});
