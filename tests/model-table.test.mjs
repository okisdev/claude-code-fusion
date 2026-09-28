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

test("Renders configured model scores", (t) => {
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
  assert.match(table, /^\| Engine \| Lane \| Intelligence \| Taste \| Cost \| Notes \|$/m);
  assert.match(table, /^\| codex \| codex \| 5 \| 4 \| 5 \| primary implementation lane \|$/m);
  assert.match(table, /^Lane defaults: codex quick gpt-6-sol@xhigh, volume gpt-6-luna@xhigh, flagship gpt-6-astra@xhigh; grok burst grok-4\.7-build-fast@low, independence grok-4\.7-build-fast@high, live-web grok-4\.7-build-fast@high, large-context grok-4\.6@medium\.$/m);
  assert.match(table, /\| grok-fast \| grok \| 3 \| 3 \| 5 \|  \|\n\nLane defaults: [^\n]+\n\nScores feed/);
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
    grok: { ...DEFAULT_ROUTING_DEFAULTS.grok, independence: { model: "grok-4.7", effort: "max" } }
  });
  assert.match(renderModelTableFromFile(file), /Lane defaults: codex quick gpt-6-sol@high, volume gpt-6-luna@xhigh, flagship gpt-6-astra@xhigh; grok burst grok-4\.7-build-fast@low, independence grok-4\.7@max/);
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
