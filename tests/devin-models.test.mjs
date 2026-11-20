import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { billingPoolForModel, costClassForPool, createSelectionResolver, createSpeedResolver, findCatalogFamily, pairingForModel, parseModelsJson, readModelCatalog } from "../plugins/devin/scripts/lib/devin-models.mjs";

const listing = {
  families: [
    {
      family_label: "SWE 2", family_uid: "swe-family", slug: "swe-2", aliases: ["cognition-swe"],
      variants: [
        { model_uid: "swe-2-high", label: "SWE High", description: "", cost_summary: "", is_new: false, is_beta: false },
        { model_uid: "swe-2-max", label: "SWE Max", description: "", cost_summary: "", is_new: false, is_beta: false }
      ]
    },
    {
      family_label: "GLM 5.2", family_uid: "glm-family", slug: "glm-5.2", aliases: ["glm"],
      variants: [{ model_uid: "glm-5-2", label: "GLM", description: "", cost_summary: "", is_new: false, is_beta: false }]
    }
  ]
};

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-models-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

test("catalog parsing keeps family identities and selectable variant ids", () => {
  assert.deepEqual(parseModelsJson(JSON.stringify(listing)), { families: [
    { slug: "swe-2", label: "SWE 2", aliases: ["cognition-swe"], variants: [{ uid: "swe-2-high", label: "SWE High" }, { uid: "swe-2-max", label: "SWE Max" }] },
    { slug: "glm-5.2", label: "GLM 5.2", aliases: ["glm"], variants: [{ uid: "glm-5-2", label: "GLM" }] }
  ] });
});

test("catalog parsing retains available cost and context metadata", () => {
  const catalog = parseModelsJson(JSON.stringify({ families: [{ ...listing.families[0], variants: [
    { ...listing.families[0].variants[0], cost_tier: "premium", max_context_tokens: 200000, max_output_tokens: 32000 }
  ] }] }));
  assert.deepEqual(catalog.families[0].variants[0], { uid: "swe-2-high", label: "SWE High", cost_tier: "premium", max_context_tokens: 200000 });
});

test("catalog parsing rejects malformed JSON and invalid family or variant shapes", () => {
  for (const value of ["{", "null", "{}", '{"families":{}}', JSON.stringify({ families: [{ ...listing.families[0], aliases: "swe" }] }), JSON.stringify({ families: [{ ...listing.families[0], family_uid: null }] }), JSON.stringify({ families: [{ ...listing.families[0], variants: [{}] }] })]) {
    assert.throws(() => parseModelsJson(value));
  }
});

test("catalog cache runs the JSON CLI with env, reuses fresh data, and refreshes at one hour", (t) => {
  const dataDir = fixture(t);
  const env = { PATH: "/test/bin" };
  const calls = [];
  const run = (bin, args, options) => {
    calls.push({ bin, args, options });
    return { status: 0, stdout: JSON.stringify(listing) };
  };
  const first = readModelCatalog({ dataDir, bin: "/test/devin", env, now: 1000, run });
  assert.equal(first.source, "cli");
  assert.equal(first.families[0].slug, "swe-2");
  assert.deepEqual(calls[0].args, ["models", "list", "--format", "json"]);
  assert.equal(calls[0].bin, "/test/devin");
  assert.equal(calls[0].options.env, env);
  const cachePath = path.join(dataDir, "models-cache.json");
  assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600);
  const second = readModelCatalog({ dataDir, bin: "/test/devin", now: 3600999, run });
  assert.deepEqual(second, { families: first.families, source: "cache" });
  assert.equal(calls.length, 1);
  const third = readModelCatalog({ dataDir, bin: "/test/devin", now: 3601000, run });
  assert.equal(third.source, "cli");
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(cachePath, "utf8")).fetchedAt, 3601000);
});

test("bad cache refreshes and failed listings never overwrite it", (t) => {
  const dataDir = fixture(t);
  const cachePath = path.join(dataDir, "models-cache.json");
  fs.writeFileSync(cachePath, "broken");
  const first = readModelCatalog({ dataDir, bin: "devin", run: () => ({ status: 0, stdout: JSON.stringify(listing) }) });
  assert.equal(first.source, "cli");
  assert.throws(() => readModelCatalog({ dataDir, bin: "devin", maxAgeMs: 0, run: () => ({ status: 1, stderr: "unavailable" }) }), /unavailable/);
  assert.equal(JSON.parse(fs.readFileSync(cachePath, "utf8")).families[0].slug, "swe-2");
  assert.throws(() => readModelCatalog({ dataDir, bin: "devin", maxAgeMs: 0, run: () => ({ status: 0, stdout: "{}" }) }));
});

test("family lookup accepts slug, alias, and variant uid case insensitively", () => {
  const catalog = parseModelsJson(JSON.stringify(listing));
  for (const name of ["SWE-2", "COGNITION-SWE", "SWE-2-MAX"]) {
    assert.equal(findCatalogFamily(catalog, name), catalog.families[0]);
  }
  assert.equal(findCatalogFamily(catalog, "GLM-5-2"), catalog.families[1]);
  assert.throws(() => findCatalogFamily(catalog, "unknown"), (error) => error.failureKind === "input" && /swe-2, glm-5\.2/.test(error.message));
});

test("family lookup refuses unpinned automatic and fusion models", () => {
  const catalog = parseModelsJson(JSON.stringify({ families: [...listing.families, { ...listing.families[0], slug: "fusion-swe", aliases: ["blend"], variants: [{ ...listing.families[0].variants[0], model_uid: "fusion-swe-high" }] }] }));
  for (const name of ["adaptive", "default", "auto", "fusion-swe", "FUSION-SWE-HIGH", "blend"]) {
    assert.throws(() => findCatalogFamily(catalog, name), (error) => error.failureKind === "input");
  }
});

test("family lookup pins fusion pairings for write jobs only", () => {
  const catalog = parseModelsJson(JSON.stringify({ families: [...listing.families, {
    family_label: "Fusion", family_uid: "fusion", slug: "fusion", aliases: [],
    variants: [
      { model_uid: "fusion-gpt-6-sol-sidekick-swe-2-high", label: "GPT-6 Sol + SWE-2 High" },
      { model_uid: "fusion-claude-opus-5-sidekick-swe-2-high", label: "Claude Opus 5 + SWE-2 High" }
    ]
  }] }));
  const family = findCatalogFamily(catalog, "fusion-gpt-6-sol-sidekick-swe-2-high", { write: true });
  assert.equal(family.slug, "fusion");
  assert.equal(findCatalogFamily(catalog, "FUSION-GPT-6-SOL-SIDEKICK-SWE-2-HIGH", { write: true }), family);
  assert.throws(() => findCatalogFamily(catalog, "fusion-gpt-6-sol-sidekick-swe-2-high"), (error) => error.failureKind === "input" && /cannot be pinned/.test(error.message));
  assert.throws(() => findCatalogFamily(catalog, "fusion-gpt-6-sol-sidekick-swe-2-high", { write: false }), (error) => error.failureKind === "input");
  assert.throws(() => findCatalogFamily(catalog, "fusion-claude-opus-5-sidekick-swe-2-high", { write: true }), (error) => error.failureKind === "input" && /cannot be pinned/.test(error.message));
  for (const name of ["fusion", "adaptive", "default", "auto", "fusion-gpt-9-sol-sidekick-swe-2-high", "fusion-gpt-6-sol-sidekick-swe-1-high", "fusion-gpt-6-sol-sidekick-swe-2"]) {
    assert.throws(() => findCatalogFamily(catalog, name, { write: true }), (error) => error.failureKind === "input");
  }
});

test("pairing uids parse into planner and sidekick parts", () => {
  assert.deepEqual(pairingForModel("fusion-gpt-6.1-sol-sidekick-swe-2-flash-high"), { planner: "gpt-6.1-sol", sidekick: "swe-2-flash-high" });
  assert.deepEqual(pairingForModel("FUSION-CLAUDE-FABLE-5.1-SIDEKICK-SWE-2-MAX"), { planner: "claude-fable-5.1", sidekick: "swe-2-max" });
  assert.equal(pairingForModel("swe-2-high"), null);
  assert.equal(pairingForModel("fusion"), null);
  assert.equal(pairingForModel("fusion-gpt-6-sol-sidekick-kimi-k3-high"), null);
});

test("model selection uses a variant offered by the live ACP session", () => {
  const family = parseModelsJson(JSON.stringify(listing)).families[0];
  const resolve = createSelectionResolver({ family });
  const options = [{ id: "model", currentValue: "glm-5-2", options: [
    { value: "glm-5-2", name: "GLM 5.2" }, { value: "swe-2-high", name: "SWE High" }
  ] }];
  assert.deepEqual(resolve({ stage: "model", configOptions: options }), [{ configId: "model", value: "swe-2-high" }]);
  assert.throws(() => resolve({ stage: "model", configOptions: [{ ...options[0], options: options[0].options.slice(0, 1) }] }), (error) => error.failureKind === "setup" && /GLM 5\.2/.test(error.message));
});

test("effort selection sets supported thought level and forces standard speed", () => {
  const family = parseModelsJson(JSON.stringify(listing)).families[0];
  const resolve = createSelectionResolver({ family, effort: "max" });
  const configOptions = [
    { id: "thought_level", currentValue: "high", options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }, { value: "max", name: "Max" }] },
    { id: "speed", currentValue: "fast", options: [{ value: "standard", name: "Standard" }, { value: "fast", name: "Fast" }] }
  ];
  assert.equal(resolve.effortApplied, false);
  assert.deepEqual(resolve({ stage: "effort", configOptions }), [{ configId: "thought_level", value: "max" }, { configId: "speed", value: "standard" }]);
  assert.equal(resolve.effortApplied, true);
  assert.deepEqual(resolve({ stage: "effort", configOptions: [configOptions[0], { ...configOptions[1], currentValue: "standard" }] }), [{ configId: "thought_level", value: "max" }]);
});

test("live family ids select their ACP variants and model specific effort values", () => {
  const cases = [
    ["kimi-k3", "kimi-k3-high", "high", ["low", "high", "max"]],
    ["glm-5.2", "glm-5-2", "none", ["none", "high", "max"]],
    ["muse-wonder", "muse-wonder-1-0-high", "xhigh", ["minimal", "low", "medium", "high", "xhigh", "max"]],
    ["gemini-3.8-flash", "gemini-3-8-flash-medium", "default", []]
  ];
  for (const [slug, uid, effort, levels] of cases) {
    const family = { slug, variants: [{ uid }] };
    const resolve = createSelectionResolver({ family, effort });
    assert.deepEqual(resolve({ stage: "model", configOptions: [{ id: "model", options: [{ value: uid, name: slug }] }] }), [{ configId: "model", value: uid }]);
    const configOptions = levels.length ? [{ id: "thought_level", options: levels.map((value) => ({ value, name: value })) }] : [];
    assert.deepEqual(resolve({ stage: "effort", configOptions }), effort === "default" ? [] : [{ configId: "thought_level", value: effort }]);
    assert.equal(resolve.effortApplied, effort !== "default");
  }
});

test("default effort leaves thought level untouched but still normalizes speed", () => {
  const family = parseModelsJson(JSON.stringify(listing)).families[0];
  const resolve = createSelectionResolver({ family });
  assert.deepEqual(resolve({ stage: "effort", configOptions: [{ id: "speed", currentValue: "fast", options: [{ value: "standard", name: "Standard" }] }] }), [{ configId: "speed", value: "standard" }]);
  assert.equal(resolve.effortApplied, false);
  assert.deepEqual(resolve({ stage: "effort", configOptions: [] }), []);
});

test("unsupported effort lists available values as input failure", () => {
  const family = parseModelsJson(JSON.stringify(listing)).families[0];
  const resolve = createSelectionResolver({ family, effort: "xhigh" });
  const options = [{ id: "thought_level", options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }] }];
  assert.throws(() => resolve({ stage: "effort", configOptions: options }), (error) => error.failureKind === "input" && /medium, high/.test(error.message));
  assert.throws(() => resolve({ stage: "effort", configOptions: [] }), (error) => error.failureKind === "input" && /none/.test(error.message));
  assert.equal(resolve.effortApplied, false);
});

test("billing pool follows the cost tier of the resolved variant", () => {
  const catalog = parseModelsJson(JSON.stringify({ families: [
    { ...listing.families[0], variants: [
      { ...listing.families[0].variants[0], cost_tier: "free" },
      { ...listing.families[0].variants[1], cost_tier: "free" }
    ] },
    { ...listing.families[1], variants: [{ ...listing.families[1].variants[0], cost_tier: "premium" }] },
    { family_label: "Fusion", family_uid: "fusion", slug: "fusion", aliases: [], variants: [
      { model_uid: "fusion-gpt-6-sol-sidekick-swe-2-high", label: "GPT-6 Sol + SWE-2 High", cost_tier: "free" }
    ] }
  ] }));
  assert.equal(billingPoolForModel(catalog, "swe-2"), "free");
  assert.equal(billingPoolForModel(catalog, "swe-2-high"), "free");
  assert.equal(billingPoolForModel(catalog, "glm"), "credits");
  assert.equal(billingPoolForModel(catalog, "glm-5-2"), "credits");
  assert.equal(billingPoolForModel(catalog, "fusion-gpt-6-sol-sidekick-swe-2-high"), "free");
  assert.equal(billingPoolForModel(catalog, "unknown"), "credits");
});

test("cost class maps pools and legacy record pool names", () => {
  assert.equal(costClassForPool("free"), "free");
  assert.equal(costClassForPool("credits"), "included");
  assert.equal(costClassForPool("first-party"), "free");
  assert.equal(costClassForPool("api"), "metered");
});

test("mixed family and alias pools follow the selected variant", () => {
  const family = { slug: "swe-2", aliases: ["swe"], variants: [
    { uid: "swe-2-high", cost_tier: "free" },
    { uid: "swe-2-max", cost_tier: "premium" }
  ] };
  const catalog = { families: [family] };
  for (const name of ["swe-2", "swe", "SWE"]) assert.equal(billingPoolForModel(catalog, name), "free");
  for (const uid of ["swe-2-high", "swe-2-max"]) {
    const resolver = createSelectionResolver({ family });
    const [selection] = resolver({ stage: "model", configOptions: [{ id: "model", options: [{ value: uid }] }] });
    assert.equal(billingPoolForModel(catalog, selection.value), uid === "swe-2-high" ? "free" : "credits");
  }
});

test("the speed resolver pins standard speed when no model is requested", () => {
  const resolver = createSpeedResolver();
  assert.deepEqual(resolver({ stage: "model", configOptions: [] }), []);
  assert.deepEqual(resolver({ stage: "effort", configOptions: [{ id: "speed", currentValue: "fast", options: [{ value: "standard" }, { value: "fast" }] }] }), [{ configId: "speed", value: "standard" }]);
  assert.deepEqual(resolver({ stage: "effort", configOptions: [{ id: "speed", currentValue: "standard", options: [] }] }), []);
  assert.equal(resolver.effortApplied, false);
});
