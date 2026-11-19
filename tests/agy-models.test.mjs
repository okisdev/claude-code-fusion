import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSelectionResolver, DEFAULT_MODEL, isGoogleModel, readModelCatalog, resolveModelRequest, usableModels } from "../plugins/agy/scripts/lib/agy-models.mjs";

const configOptions = [
  { id: "model", currentValue: "gemini-4-argon", options: ["gemini-4-neon", "gemini-4-argon", "gemini-pro-orchestrator-test", "claude-opus", "gpt-6"].map((value) => ({ value, name: value })) },
  { id: "thought_level", currentValue: "high", options: ["low", "medium", "high", "xhigh"].map((value) => ({ value })) }
];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-models-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("models are filtered to pinnable Google session values", () => {
  assert.deepEqual(usableModels(configOptions).map((model) => model.id), ["gemini-4-neon", "gemini-4-argon"]);
  for (const value of [null, "claude-opus", "gpt-6", "gemini-pro-orchestrator-preview"]) assert.equal(isGoogleModel(value), false);
});

test("model suffix supplies effort only when none was requested", () => {
  for (const effort of ["low", "medium", "high", "xhigh"]) {
    assert.deepEqual(resolveModelRequest(`gemini-4-neon-${effort}`), { model: DEFAULT_MODEL, effort });
    assert.deepEqual(resolveModelRequest(`gemini-4-neon-${effort}`, "default"), { model: DEFAULT_MODEL, effort: "default" });
    assert.deepEqual(resolveModelRequest(`gemini-4-neon-${effort}`, "low"), { model: DEFAULT_MODEL, effort: "low" });
  }
  assert.deepEqual(resolveModelRequest(), { model: null, effort: "default" });
  assert.deepEqual(resolveModelRequest(undefined, "xhigh"), { model: null, effort: "xhigh" });
  for (const model of ["claude-opus", "gpt-6", "gemini-pro-orchestrator-preview", "adaptive", "auto", "default"]) assert.throws(() => resolveModelRequest(model), (error) => error.failureKind === "input");
  assert.throws(() => resolveModelRequest(DEFAULT_MODEL, "max"), (error) => error.failureKind === "input" && /low, medium, high, xhigh/.test(error.message));
});

test("selection defaults to neon and resume preserves the offered session model", () => {
  assert.deepEqual(createSelectionResolver()({ stage: "model", configOptions }), [{ configId: "model", value: DEFAULT_MODEL }]);
  assert.deepEqual(createSelectionResolver({ preserveModel: true })({ stage: "model", configOptions }), [{ configId: "model", value: "gemini-4-argon" }]);
  assert.deepEqual(createSelectionResolver({ model: DEFAULT_MODEL, preserveModel: true })({ stage: "model", configOptions }), [{ configId: "model", value: DEFAULT_MODEL }]);
  assert.throws(() => createSelectionResolver({ model: "gemini-missing" })({ stage: "model", configOptions }), (error) => error.failureKind === "setup" && /gemini-4-neon, gemini-4-argon/.test(error.message));
  assert.throws(() => createSelectionResolver({ model: "claude-opus" })({ stage: "model", configOptions }), (error) => error.failureKind === "input");
});

test("each supported effort is applied and default acknowledges the current level unchanged", () => {
  for (const effort of ["default", "low", "medium", "high", "xhigh"]) {
    const resolve = createSelectionResolver({ effort });
    assert.deepEqual(resolve({ stage: "effort", configOptions }), [{ configId: "thought_level", value: effort === "default" ? "high" : effort }]);
    assert.equal(resolve.effortApplied, effort !== "default");
  }
  const resolve = createSelectionResolver({ effort: "xhigh" });
  assert.throws(() => resolve({ stage: "effort", configOptions: [{ id: "thought_level", options: [{ value: "low" }] }] }), (error) => error.failureKind === "input" && /Offered values: low/.test(error.message));
});

test("cache discovers models through a successful new session, reuses one hour, and refreshes atomically", async (t) => {
  const dataDir = fixture(t);
  const env = { HOME: dataDir, PATH: process.env.PATH };
  const calls = [];
  const run = async (options) => {
    calls.push(options);
    return { sessionReady: true, configOptions };
  };
  const first = await readModelCatalog({ dataDir, bin: "/test/agy", cwd: dataDir, env, now: 1000, run });
  assert.equal(first.source, "cli");
  assert.equal(first.models.length, 2);
  assert.equal(calls[0].sessionOnly, true);
  assert.equal(calls[0].env, env);
  assert.equal(calls[0].geminiDir, path.join(dataDir, "gemini"));
  assert.deepEqual(await readModelCatalog({ dataDir, bin: "/test/agy", now: 3600999, run }), { models: first.models, source: "cache" });
  assert.equal(calls.length, 1);
  await readModelCatalog({ dataDir, bin: "/test/agy", now: 3601000, run });
  assert.equal(calls.length, 2);
  const cachePath = path.join(dataDir, "models-cache.json");
  assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(cachePath)).fetchedAt, 3601000);
  await assert.rejects(readModelCatalog({ dataDir, bin: "agy", maxAgeMs: 0, run: async () => ({ rpcError: { message: "Authentication required" } }) }), (error) => error.failureKind === "auth");
  assert.equal(JSON.parse(fs.readFileSync(cachePath)).fetchedAt, 3601000);
});

test("invalid, future, and non Google caches refresh and empty offerings fail setup", async (t) => {
  const dataDir = fixture(t);
  const cache = path.join(dataDir, "models-cache.json");
  for (const value of ["broken", JSON.stringify({ fetchedAt: Date.now() + 999999, models: [] }), JSON.stringify({ fetchedAt: Date.now(), models: [{ id: "claude-opus", displayName: "Claude" }] })]) {
    fs.writeFileSync(cache, value);
    assert.equal((await readModelCatalog({ dataDir, bin: "agy", run: async () => ({ sessionReady: true, configOptions }) })).source, "cli");
  }
  await assert.rejects(readModelCatalog({ dataDir, bin: "agy", maxAgeMs: 0, run: async () => ({ sessionReady: true, configOptions: [] }) }), (error) => error.failureKind === "setup");
});
