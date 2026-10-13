import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { billingPoolForModel, parseModelsListing, readModelCatalog, resolveCursorModel } from "../plugins/cursor/scripts/lib/cursor-models.mjs";

const bin = path.resolve("tests/fake-cursor");

test("model listing parses markers, names, and variants", () => {
  const models = parseModelsListing("Available models\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5 (current)\ngrok-4.7-high - Grok 4.7  High\nTip: choose a model\n");
  assert.deepEqual(models, [
    { id: "auto", displayName: "Auto", current: false, isDefault: true },
    { id: "composer-2.5", displayName: "Composer 2.5", current: true, isDefault: false },
    { id: "grok-4.7-high", displayName: "Grok 4.7  High", current: false, isDefault: false }
  ]);
});

test("catalog uses fresh cache, refreshes stale cache, and protects its file", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-models-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const first = readModelCatalog({ dataDir, bin, now: 1000 });
  assert.equal(first.source, "cli");
  assert.equal(first.models.length, 9);
  assert.equal(fs.statSync(path.join(dataDir, "models-cache.json")).mode & 0o777, 0o600);
  const cached = readModelCatalog({ dataDir, bin, now: 2000, run: () => { throw new Error("must not run"); } });
  assert.equal(cached.source, "cache");
  assert.deepEqual(cached.models, first.models);
  const refreshed = readModelCatalog({ dataDir, bin, now: 3601000 });
  assert.equal(refreshed.source, "cli");
  assert.equal(refreshed.fetchedAt, 3601000);
});

test("catalog failures carry the classified cause", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-model-fail-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  for (const [message, kind] of [
    ["Authentication required", "auth"], ["fetch failed: ENOTFOUND", "network"],
    ["other failure", "error"]
  ]) {
    assert.throws(() => readModelCatalog({ dataDir, bin, run: () => ({ status: 1, stderr: message }) }), (error) => error.failureKind === kind);
  }
  assert.throws(() => readModelCatalog({ dataDir, bin, run: () => ({ status: 0, stdout: "Available models\n" }) }), (error) => error.failureKind === "error");
  assert.throws(() => readModelCatalog({ dataDir, bin: "/missing/cursor-agent" }), (error) => error.failureKind === "missing_cli");
});

test("model resolution follows effort and speed variants", () => {
  const catalog = { models: parseModelsListing("auto - Auto (default)\ncomposer-2.5 - Composer 2.5\ncomposer-2.5-fast - Composer 2.5 Fast\nmuse-spark-1.3-high - Muse High\nmuse-spark-1.3-xhigh - Muse Extra High\ngrok-4.7-high-fast - Grok High Fast\ngemini-3.1-pro - Gemini\ngpt-5.5-extra-high - GPT Extra High") };
  const cases = [
    ["muse-spark-1.3", "high", "muse-spark-1.3-high", true],
    ["muse-spark-1.3", "xhigh", "muse-spark-1.3-xhigh", true],
    ["gpt-5.5", "xhigh", "gpt-5.5-extra-high", true],
    ["grok-4.7-fast", "high", "grok-4.7-high-fast", true],
    ["composer-2.5", "default", "composer-2.5", false],
    ["gemini-3.1-pro", "high", "gemini-3.1-pro", false],
    ["muse-spark-1.3-high", "default", "muse-spark-1.3-high", false],
    ["claude-opus-4-8[effort=high]", "default", "claude-opus-4-8[effort=high]", false]
  ];
  for (const [model, effort, variant, effortApplied] of cases) {
    assert.deepEqual(resolveCursorModel({ catalog, model, effort }), { variant, effortApplied, billingPool: billingPoolForModel(variant) });
  }
  for (const model of ["auto", "default", "muse-spark-1.3-unknown"]) {
    assert.throws(() => resolveCursorModel({ catalog, model, effort: "high" }), (error) => error.failureKind === "input" && /Available variants/.test(error.message));
  }
  assert.equal(billingPoolForModel("composer-2.5-fast"), "first-party");
  assert.equal(billingPoolForModel("gpt-5.5"), "api");
});

test("missing effort fails when variants exist and exact unsuffixed models remain valid", () => {
  const catalog = { models: parseModelsListing("muse - Muse\nmuse-high - Muse High\nmuse-max - Muse Max\nmuse-high-fast - Muse High Fast\natlas-fast - Atlas Fast\natlas-high - Atlas High\ngemini-pro - Gemini Pro") };
  assert.throws(() => resolveCursorModel({ catalog, model: "muse", effort: "low" }), (error) => error.failureKind === "input" && /muse-high, muse-max/.test(error.message));
  assert.throws(() => resolveCursorModel({ catalog, model: "muse-fast", effort: "low" }), (error) => error.failureKind === "input" && /muse-high-fast/.test(error.message));
  assert.throws(() => resolveCursorModel({ catalog, model: "atlas-fast", effort: "medium" }), (error) => error.failureKind === "input" && /atlas-high/.test(error.message));
  assert.deepEqual(resolveCursorModel({ catalog, model: "gemini-pro", effort: "low" }), { variant: "gemini-pro", effortApplied: false, billingPool: "api" });
});
