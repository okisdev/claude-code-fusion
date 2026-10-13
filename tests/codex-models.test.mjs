import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { envFor, makeSandbox, runCompanion } from "./lib/codex-companion-harness.mjs";

test("models reads the Codex cache with slug precedence, names, and stable unique ids", (t) => {
  const sandbox = makeSandbox(t);
  const file = path.join(sandbox.root, "models_cache.json");
  fs.writeFileSync(file, JSON.stringify({ models: [
    { slug: "gpt-6-sol", id: "ignored", display_name: "GPT-6 Sol" },
    { id: "gpt-6-terra", name: "GPT-6 Terra" },
    "gpt-6-astra",
    { slug: "gpt-6-sol" },
    { slug: "  " },
    null
  ] }));
  const env = envFor(sandbox, { FUSION_CODEX_MODELS_CACHE: file });
  const json = runCompanion(["models", "--json"], { cwd: sandbox.workDir, env });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), {
    engine: "codex",
    models: [
      { id: "gpt-6-sol", displayName: "GPT-6 Sol" },
      { id: "gpt-6-terra", displayName: "GPT-6 Terra" },
      { id: "gpt-6-astra", displayName: null }
    ],
    source: file
  });
  const text = runCompanion(["models"], { cwd: sandbox.workDir, env });
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout, "gpt-6-sol\ngpt-6-terra\ngpt-6-astra\n");
});

test("models uses the default home cache when no override is set", (t) => {
  const sandbox = makeSandbox(t);
  const file = path.join(sandbox.homeDir, ".codex", "models_cache.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ models: [{ id: "default-model", displayName: "Default Model" }] }));
  const result = runCompanion(["models", "--json"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).source, file);
  assert.deepEqual(JSON.parse(result.stdout).models, [{ id: "default-model", displayName: "Default Model" }]);
});

test("models reports missing and malformed caches as typed input failures", (t) => {
  const sandbox = makeSandbox(t);
  const file = path.join(sandbox.root, "missing-cache.json");
  for (const contents of [null, "{not-json", JSON.stringify({ models: {} })]) {
    if (contents !== null) fs.writeFileSync(file, contents);
    const env = envFor(sandbox, { FUSION_CODEX_MODELS_CACHE: file });
    const result = runCompanion(["models", "--json"], { cwd: sandbox.workDir, env });
    assert.equal(result.status, 1);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.failureKind, "input");
    assert.match(failure.message, /Could not read Codex models cache/);
    assert.ok(failure.message.includes(file));
    assert.equal(result.stdout, "");
  }
  const directory = path.join(sandbox.root, "unreadable-cache");
  fs.mkdirSync(directory);
  const unreadable = runCompanion(["models"], { cwd: sandbox.workDir, env: envFor(sandbox, { FUSION_CODEX_MODELS_CACHE: directory }) });
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.stderr, /failure: input/);
  assert.ok(unreadable.stderr.includes(directory));
});

test("models rejects other arguments without reading the cache", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["models", "--wrong", "--json"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).failureKind, "input");
});
