import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  DEFAULT_MODEL_TABLE_PLACEHOLDER,
  DEFAULT_ROUTING_DEFAULTS,
  MODEL_ROUTING_SCHEMA_VERSION,
  readModelRoutingFile,
  readRoutingDefaults,
  renderModelTableFromContents,
  renderModelTableFromFile,
  validateModelRoutingData
} from "../plugins/fusion/scripts/lib/model-table.mjs";

const ROUTING = {
  schemaVersion: MODEL_ROUTING_SCHEMA_VERSION,
  updatedAt: "2026-07-04T00:00:00.000Z",
  costProfile: "",
  models: [
    { id: "gpt-6-sol", lane: "codex", intelligence: 5, taste: 4, cost: 5 },
    { id: "grok-4.7", lane: "grok", intelligence: 5, taste: 4, cost: 4 }
  ]
};

const isolatedHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-model-table-home-")));
process.env.HOME = isolatedHome;
process.on("exit", () => fs.rmSync(isolatedHome, { recursive: true, force: true }));

function sandbox(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-model-table-test-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRouting(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

test("Billing metadata derives from each engine and the cached Devin catalog", (t) => {
  const dir = sandbox(t);
  const dataDir = path.join(dir, "devin");
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, "models-cache.json"), JSON.stringify({
    fetchedAt: Date.now() - 2 * 60 * 60_000,
    families: [
      { slug: "swe-2", aliases: ["swe"], variants: [{ uid: "swe-2-fast", cost_tier: "free" }, { uid: "swe-2-deep", cost_tier: "free" }] },
      { slug: "mixed", aliases: [], variants: [{ uid: "mixed-free", cost_tier: "free" }, { uid: "mixed-paid", cost_tier: "premium" }] },
      { slug: "muse-wonder", aliases: [], variants: [{ uid: "muse-wonder-xhigh", cost_tier: "premium" }] },
      { slug: "kimi-k3.1-pro", aliases: [], variants: [{ uid: "kimi-k3-1-pro-high", cost_tier: "premium" }] }
    ]
  }));
  const env = { HOME: dir, DEVIN_COMPANION_DATA: dataDir };
  const cases = [
    ["codex", "gpt-6-sol", "codex", "included"],
    ["grok", "grok-4.7", "grok", "included"],
    ["agy", "gemini-4-neon", "agy", "included"],
    ["cursor", "composer-2.5", "first-party", "included"],
    ["cursor", "muse-spark-1.3", "api", "metered"],
    ["devin", "swe-2", "free", "free"],
    ["devin", "swe", "free", "free"],
    ["devin", "swe-2-fast", "free", "free"],
    ["devin", "mixed", "credits", "metered"],
    ["devin", "mixed-free", "free", "free"],
    ["devin", "mixed-paid", "credits", "metered"],
    ["devin", "muse-wonder", "credits", "metered"],
    ["devin", "unknown", null, null],
    ["other", "unknown", null, null],
    ["claude-fast", "sonnet", null, null]
  ];
  const result = validateModelRoutingData({ ...ROUTING, models: cases.map(([lane, id]) => ({ lane, id, family: "cognition", intelligence: 3, taste: 3, cost: 3, pool: "incorrect", costClass: "free" })) }, { env });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.data.models.map(({ lane, id, pool, costClass }) => [lane, id, pool, costClass]), cases);
  const table = renderModelTableFromContents(JSON.stringify(result.data), undefined, { env });
  assert.match(table, /\| composer-2\.5 \| cursor \| cognition \| 3 \| 3 \| 3 \| included \|/);
  assert.match(table, /\| muse-spark-1\.3 \| cursor \| cognition \| 3 \| 3 \| 3 \| metered \|/);
  const defaults = readRoutingDefaults({ ...env, FUSION_MODEL_ROUTING: path.join(dir, "missing.json") });
  assert.deepEqual(defaults.devin.burst, { model: "swe-2", effort: "high", pool: "free", costClass: "free" });
  assert.deepEqual(defaults.devin.diversity, { model: "kimi-k3.1-pro", effort: "high", pool: "credits", costClass: "metered" });
  for (const lane of ["codex", "grok", "agy"]) {
    for (const choice of Object.values(defaults[lane])) {
      assert.equal(choice.pool, lane);
      assert.equal(choice.costClass, "included");
    }
  }
  assert.deepEqual(defaults.cursor.burst, { model: "composer-2.5", effort: "default", pool: "first-party", costClass: "included" });
  assert.deepEqual(defaults.cursor.diversity, { model: "muse-spark-1.3", effort: "xhigh", pool: "api", costClass: "metered" });
});

test("A Devin family default bills the pool of the variant its effort serves", (t) => {
  const dir = sandbox(t);
  const dataDir = path.join(dir, "devin");
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, "models-cache.json"), JSON.stringify({
    fetchedAt: Date.now(),
    families: [
      { slug: "swe-2", aliases: [], variants: [{ uid: "swe-2-high", cost_tier: "Free" }, { uid: "swe-2-high-lightning", cost_tier: "High cost" }] },
      { slug: "muse-wonder", aliases: [], variants: [{ uid: "muse-wonder-xhigh", cost_tier: "High cost" }] }
    ]
  }));
  const env = { HOME: dir, DEVIN_COMPANION_DATA: dataDir };
  const models = [
    { id: "swe-2", lane: "devin", family: "cognition", intelligence: 4, taste: 3, cost: 5 },
    { id: "muse-wonder", lane: "devin", family: "meta", intelligence: 4, taste: 4, cost: 4 }
  ];
  const result = validateModelRoutingData({ ...ROUTING, breadth: "devin", models, defaults: { devin: { burst: { model: "swe-2", effort: "high" }, diversity: { model: "muse-wonder", effort: "xhigh" } } } }, { env });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.data.models.map(({ id, pool, costClass }) => [id, pool, costClass]), [["swe-2", "credits", "metered"], ["muse-wonder", "credits", "metered"]]);
  assert.deepEqual(result.data.defaults.devin.burst, { model: "swe-2", effort: "high", pool: "free", costClass: "free" });
  assert.deepEqual(result.data.defaults.devin.diversity, { model: "muse-wonder", effort: "xhigh", pool: "credits", costClass: "metered" });
});

test("Devin billing resolves the installed companion and canonical cache directory", (t) => {
  const dir = sandbox(t);
  const scripts = path.join(dir, ".claude", "plugins", "cache", "claude-code-fusion", "devin", "999.0.0", "scripts");
  fs.mkdirSync(path.join(scripts, "lib"), { recursive: true });
  fs.writeFileSync(path.join(scripts, "devin-companion.mjs"), "throw new Error('Companion must not execute.');\n");
  for (const name of ["devin-models.mjs", "model-catalog.mjs"]) {
    fs.copyFileSync(path.join(import.meta.dirname, "..", "plugins", "devin", "scripts", "lib", name), path.join(scripts, "lib", name));
  }
  const cacheDir = path.join(dir, ".claude", "plugins", "data", "devin-claude-code-fusion");
  fs.mkdirSync(cacheDir, { recursive: true });
  const cache = path.join(cacheDir, "models-cache.json");
  const data = { ...ROUTING, models: [{ id: "swe-2", lane: "devin", family: "cognition", intelligence: 4, taste: 3, cost: 5 }], defaults: { devin: { burst: { model: "swe-2", effort: "high" } } } };
  for (const contents of [null, "{broken", JSON.stringify({ families: [null], fetchedAt: Date.now() }), JSON.stringify({ families: [{ slug: "swe-2", aliases: [], variants: [{ uid: "swe-2-free", cost_tier: "free" }] }], fetchedAt: Date.now() })]) {
    if (contents !== null) fs.writeFileSync(cache, contents);
    const result = validateModelRoutingData(data, { env: { HOME: dir } });
    assert.equal(result.ok, true, result.reason);
    const known = contents?.includes("swe-2-free");
    assert.equal(result.data.models[0].pool, known ? "free" : null);
    assert.equal(result.data.models[0].costClass, known ? "free" : null);
    assert.equal(result.data.defaults.devin.burst.costClass, known ? "free" : null);
  }
});

test("Reading schema version 1 migrates rows and defaults in memory without writing", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "model-routing.json");
  const original = { ...ROUTING, schemaVersion: 1, costProfile: "subscriptions", defaults: { codex: { quick: { model: "gpt-6-sol", effort: "high" } } } };
  writeRouting(file, original);
  const result = readModelRoutingFile(file, { env: { HOME: dir } });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.data.schemaVersion, MODEL_ROUTING_SCHEMA_VERSION);
  assert.equal(result.data.updatedAt, original.updatedAt);
  assert.equal(result.data.costProfile, original.costProfile);
  assert.deepEqual(result.data.models[0], { ...original.models[0], pool: "codex", costClass: "included" });
  assert.deepEqual(result.data.defaults.codex.quick, { ...original.defaults.codex.quick, pool: "codex", costClass: "included" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), original);
  assert.deepEqual(readModelRoutingFile(file, { env: { HOME: dir } }), result);
  assert.deepEqual(fs.readdirSync(dir), ["model-routing.json"]);
});

test("Routing reads derive billing metadata from the current Devin cache without writing", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "model-routing.json");
  const env = { HOME: dir, DEVIN_COMPANION_DATA: dir };
  const stored = { ...ROUTING, models: [{ id: "swe-2", lane: "devin", family: "cognition", intelligence: 4, taste: 3, cost: 5 }], defaults: { devin: { burst: { model: "swe-2", effort: "high" } } } };
  writeRouting(file, stored);
  assert.equal(readModelRoutingFile(file, { env }).data.defaults.devin.burst.costClass, null);
  for (const tier of ["free", "premium"]) {
    fs.writeFileSync(path.join(dir, "models-cache.json"), JSON.stringify({ fetchedAt: Date.now(), families: [{ slug: "swe-2", aliases: [], variants: [{ uid: "swe-2-model", cost_tier: tier }] }] }));
    const result = readModelRoutingFile(file, { env });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.data.models[0].costClass, tier === "free" ? "free" : "metered");
    assert.equal(result.data.defaults.devin.burst.costClass, result.data.models[0].costClass);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), stored);
  }
});

test("Session context table renders scores without Notes and points to config", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "model-routing.json");
  writeRouting(file, {
    schemaVersion: MODEL_ROUTING_SCHEMA_VERSION,
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
  assert.match(table, /^\| Engine \| Lane \| Family \| Intelligence \| Taste \| Cost \| Cost class \|$/m);
  assert.match(table, /^\|---\|---\|---\|---:\|---:\|---:\|---\|$/m);
  assert.match(table, /^\| codex \| codex \| openai \| 5 \| 4 \| 5 \| included \|$/m);
  assert.doesNotMatch(table, /primary implementation lane|\| Notes \|/);
  assert.match(table, /^Lane defaults: codex quick gpt-6-sol@xhigh, volume gpt-6-sol@high, flagship gpt-6\.1-sol@xhigh; grok burst grok-4\.7-build-fast@low, independence grok-4\.7-build-fast@low, live-web grok-4\.7-build-fast@high, large-context grok-4\.6@medium; cursor diversity muse-spark-1\.3@xhigh \(metered\), burst composer-2\.5@default; agy independence gemini-4-neon@high, large-context gemini-4-neon@high, burst gemini-4-neon@medium\.$/m);
  assert.match(table, /\| grok-fast \| grok \| xai \| 3 \| 3 \| 5 \| included \|\nBreadth engine: Cursor \(cursor\); its briefs go to cursor:cursor-rescue with `cursor-role: diversity` or `cursor-role: burst`, and Devin holds no routing seat\.\nBreadth diversity excludes the claude family and the google family served by Antigravity \(agy\); route google consults to agy:agy-rescue\.\nModel notes \(benchmarks, prices, latency\) live in model-routing\.json; `\/fusion:config` shows them\.\n\nLane defaults: [^\n]+\n\nScores feed/);
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
      grok: { independence: { model: "grok-4.7", effort: "max", pool: "grok", costClass: "included" } }
    }
  });
  const validated = validateModelRoutingData(JSON.parse(fs.readFileSync(file, "utf8")));
  assert.strictEqual(validated.ok, true);
  assert.deepStrictEqual(validated.data.defaults, {
    codex: { quick: { model: "gpt-6-sol", effort: "high", pool: "codex", costClass: "included" } },
    grok: { independence: { model: "grok-4.7", effort: "max", pool: "grok", costClass: "included" } }
  });
  assert.deepStrictEqual(readRoutingDefaults({ FUSION_MODEL_ROUTING: file }), {
    breadth: "cursor",
    codex: { ...DEFAULT_ROUTING_DEFAULTS.codex, quick: { model: "gpt-6-sol", effort: "high", pool: "codex", costClass: "included" } },
    grok: { ...DEFAULT_ROUTING_DEFAULTS.grok, independence: { model: "grok-4.7", effort: "max", pool: "grok", costClass: "included" } },
    cursor: DEFAULT_ROUTING_DEFAULTS.cursor,
    devin: DEFAULT_ROUTING_DEFAULTS.devin,
    agy: DEFAULT_ROUTING_DEFAULTS.agy
  });
  assert.match(renderModelTableFromFile(file), /Lane defaults: codex quick gpt-6-sol@high, volume gpt-6-sol@high, flagship gpt-6\.1-sol@xhigh; grok burst grok-4\.7-build-fast@low, independence grok-4\.7@max/);
});

test("Routing file flagship choice overrides the shipped default", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "model-routing.json");
  writeRouting(file, {
    ...ROUTING,
    models: [...ROUTING.models, { id: "gpt-6-astra", lane: "codex", intelligence: 5, taste: 4, cost: 2 }],
    defaults: { codex: { flagship: { model: "gpt-6-astra", effort: "xhigh", pool: "codex", costClass: "included" } } }
  });
  assert.deepStrictEqual(DEFAULT_ROUTING_DEFAULTS.codex.flagship, { model: "gpt-6.1-sol", effort: "xhigh", pool: "codex", costClass: "included" });
  assert.deepStrictEqual(readRoutingDefaults({ FUSION_MODEL_ROUTING: file }).codex.flagship, { model: "gpt-6-astra", effort: "xhigh", pool: "codex", costClass: "included" });
  assert.match(renderModelTableFromFile(file), /flagship gpt-6-astra@xhigh/);
});

test("Engines without a fixed family require a valid family and preserve it", () => {
  for (const lane of ["cursor", "devin"]) {
    const row = { id: "muse-spark-1.3", lane, intelligence: 4, taste: 5, cost: 3 };
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
  }
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

test("Breadth selection validates, survives file reads, and renders one seat", (t) => {
  const rows = [
    { id: "muse-spark-1.3", lane: "cursor", family: "anthropic", intelligence: 4, taste: 5, cost: 3 },
    { id: "muse-wonder", lane: "devin", family: "anthropic", intelligence: 5, taste: 5, cost: 3 }
  ];
  for (const breadth of [null, "", "codex", "DEVIN", 1]) {
    const result = validateModelRoutingData({ ...ROUTING, breadth });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /Expected breadth to be one of cursor, devin/);
  }
  for (const breadth of ["cursor", "devin"]) {
    const data = validateModelRoutingData({ ...ROUTING, breadth, models: [...ROUTING.models, ...rows] });
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.data.breadth, breadth);
    const file = path.join(sandbox(t), `${breadth}.json`);
    writeRouting(file, data.data);
    assert.strictEqual(readRoutingDefaults({ FUSION_MODEL_ROUTING: file }).breadth, breadth);
    const table = renderModelTableFromFile(file);
    const other = breadth === "cursor" ? "devin" : "cursor";
    const shown = breadth === "cursor" ? "muse-spark-1.3" : "muse-wonder";
    const hidden = breadth === "cursor" ? "muse-wonder" : "muse-spark-1.3";
    assert.match(table, new RegExp(`\\| ${shown.replaceAll(".", "\\.")} \\| ${breadth} \\|`));
    assert.doesNotMatch(table, new RegExp(`\\| ${hidden.replaceAll(".", "\\.")} \\| ${other} \\|`));
    assert.match(table, new RegExp(`; ${breadth} diversity [^\\n]+\\.$`, "m"));
    assert.doesNotMatch(table, new RegExp(`; ${other} diversity `));
    assert.ok(table.includes(`Breadth engine: ${breadth === "cursor" ? "Cursor" : "Devin"} (${breadth}); its briefs go to ${breadth}:${breadth}-rescue with ` + `\`${breadth}-role: diversity\` or \`${breadth}-role: burst\`, and ${breadth === "cursor" ? "Devin" : "Cursor"} holds no routing seat.`));
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
  assert.deepStrictEqual(readRoutingDefaults(env, { warn: (message) => warnings.push(message) }), { breadth: "cursor", ...DEFAULT_ROUTING_DEFAULTS });
  assert.deepStrictEqual(warnings, []);
  writeRouting(file, { ...ROUTING, defaults: { codex: { quick: { model: "missing", effort: "high" } } } });
  assert.deepStrictEqual(readRoutingDefaults(env, { warn: (message) => warnings.push(message) }), { breadth: "cursor", ...DEFAULT_ROUTING_DEFAULTS });
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

test("Breadth diversity excludes Google and Claude families for both breadth engines", () => {
  for (const lane of ["cursor", "devin"]) {
    for (const family of ["google", "anthropic", "claude", "meta", "moonshot"]) {
      const row = { id: "family-model", lane, family, intelligence: 4, taste: 3, cost: 4 };
      const data = { ...ROUTING, models: [...ROUTING.models, row], defaults: { [lane]: { diversity: { model: row.id, effort: "high" } } } };
      const result = validateModelRoutingData(data);
      if (["google", "anthropic", "claude"].includes(family)) {
        assert.strictEqual(result.ok, false);
        assert.match(result.reason, /family eligible for breadth diversity/);
        assert.match(result.reason, /google family served by Antigravity/);
      } else {
        assert.strictEqual(result.ok, true, result.reason);
      }
      assert.strictEqual(validateModelRoutingData({ ...data, defaults: undefined }).ok, true);
    }
    const table = renderModelTableFromContents(JSON.stringify({ ...ROUTING, breadth: lane }));
    assert.match(table, /Breadth diversity excludes the claude family and the google family served by Antigravity \(agy\)/);
    assert.match(table, /agy independence gemini-4-neon@high, large-context gemini-4-neon@high, burst gemini-4-neon@medium/);
  }
});
