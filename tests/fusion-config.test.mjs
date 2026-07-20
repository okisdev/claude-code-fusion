import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { hashRulesTemplate } from "../plugins/fusion/scripts/lib/rules-template.mjs";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "plugins", "fusion", "scripts", "fusion-config.mjs");

const CANONICAL = `# Orchestration policy

canonical rules content

<!-- fusion:model-table:start -->
Engine capability table: run /fusion:config to score your configured engines (intelligence, taste, cost, 1 to 5) and regenerate this block. Until scored, route by the qualitative lane descriptions in this document.
<!-- fusion:model-table:end -->
`;

function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-config-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginRoot = path.join(root, "plugin");
  fs.mkdirSync(path.join(pluginRoot, "rules"), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "rules", "orchestration.md"), CANONICAL, "utf8");
  fs.writeFileSync(
    path.join(pluginRoot, "rules-manifest.json"),
    `${JSON.stringify({ format: 2, hashes: [hashRulesTemplate(CANONICAL)] }, null, 2)}\n`,
    "utf8"
  );
  return {
    root,
    pluginRoot,
    modelRoutingFile: path.join(root, "model-routing.json"),
    codexModelsCacheFile: path.join(root, "models_cache.json"),
    rulesFile: path.join(root, "live", "orchestration.md")
  };
}

function run(sandbox, args, overrides = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: sandbox.pluginRoot,
      FUSION_MODEL_ROUTING: sandbox.modelRoutingFile,
      FUSION_RULES_FILE: sandbox.rulesFile,
      FUSION_CODEX_MODELS_CACHE: sandbox.codexModelsCacheFile,
      ...overrides
    }
  });
}

test("Rejects a bad score with a usage error", (t) => {
  const box = sandbox(t);
  const result = run(box, ["rescore", "codex", "--intelligence", "6", "--taste", "3", "--cost", "3"]);
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Expected --intelligence to be an integer from 1 to 5/);
  assert.strictEqual(fs.existsSync(box.modelRoutingFile), false);
});

test("Rescore writes the data file and refreshes the live rules", (t) => {
  const box = sandbox(t);
  const result = run(box, [
    "rescore",
    "codex",
    "--intelligence",
    "5",
    "--taste",
    "4",
    "--cost",
    "5",
    "--lane",
    "codex",
    "--notes",
    "primary implementation lane"
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  const data = JSON.parse(fs.readFileSync(box.modelRoutingFile, "utf8"));
  assert.strictEqual(data.schemaVersion, 1);
  assert.strictEqual(data.models.length, 1);
  assert.deepStrictEqual(data.models[0], {
    id: "codex",
    lane: "codex",
    intelligence: 5,
    taste: 4,
    cost: 5,
    notes: "primary implementation lane"
  });
  if (process.platform !== "win32") {
    assert.strictEqual(fs.statSync(path.dirname(box.modelRoutingFile)).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(box.modelRoutingFile).mode & 0o777, 0o600);
  }
  const live = fs.readFileSync(box.rulesFile, "utf8");
  assert.match(live, /^\| codex \| codex \| 5 \| 4 \| 5 \| primary implementation lane \|$/m);
});

test("Show json parses after a score is configured", (t) => {
  const box = sandbox(t);
  assert.strictEqual(
    run(box, ["rescore", "grok-fast", "--intelligence", "3", "--taste", "3", "--cost", "5", "--lane", "grok"]).status,
    0
  );
  const result = run(box, ["show", "--json"]);
  assert.strictEqual(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.strictEqual(data.filePath, box.modelRoutingFile);
  assert.strictEqual(data.configured, true);
  assert.strictEqual(data.valid, true);
  assert.strictEqual(data.data.models[0].id, "grok-fast");
  assert.match(data.table, /^\| grok-fast \| grok \| 3 \| 3 \| 5 \|  \|$/m);
});

test("Show reports an invalid model routing file explicitly", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(box.modelRoutingFile, "{ not json", "utf8");
  const text = run(box, ["show"]);
  assert.strictEqual(text.status, 0, text.stderr);
  assert.match(text.stdout, /Invalid model routing file:/);
  assert.doesNotMatch(text.stdout, /Not configured/);
  const json = run(box, ["show", "--json"]);
  assert.strictEqual(json.status, 0, json.stderr);
  const data = JSON.parse(json.stdout);
  assert.strictEqual(data.configured, true);
  assert.strictEqual(data.valid, false);
  assert.strictEqual(typeof data.error, "string");
  assert.ok(data.error.length > 0);
  assert.strictEqual(data.table, null);
});

test("Audit reports configured Codex listing drift and gpt newcomers", (t) => {
  const box = sandbox(t);
  assert.strictEqual(
    run(box, ["rescore", "gpt-5.6-terra", "--intelligence", "5", "--taste", "4", "--cost", "4", "--lane", "codex"]).status,
    0
  );
  assert.strictEqual(
    run(box, ["rescore", "gpt-5.5-missing", "--intelligence", "4", "--taste", "4", "--cost", "5", "--lane", "codex"]).status,
    0
  );
  assert.strictEqual(
    run(box, ["rescore", "grok-4-missing", "--intelligence", "4", "--taste", "4", "--cost", "5", "--lane", "grok"]).status,
    0
  );
  fs.writeFileSync(
    box.codexModelsCacheFile,
    `${JSON.stringify({ models: [{ slug: "gpt-5.6-terra" }, { slug: "gpt-5.7-new" }, { slug: "o3" }] })}\n`,
    "utf8"
  );
  const routingBeforeAudit = fs.readFileSync(box.modelRoutingFile, "utf8");
  const result = run(box, ["audit", "--json"]);
  assert.strictEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.listing.available, true);
  assert.strictEqual(report.listing.path, box.codexModelsCacheFile);
  assert.strictEqual(report.listing.mtime, fs.statSync(box.codexModelsCacheFile).mtime.toISOString());
  assert.deepStrictEqual(report.configuredButAbsent, ["gpt-5.5-missing"]);
  assert.deepStrictEqual(report.unconfiguredGptModels, ["gpt-5.7-new"]);
  assert.strictEqual(fs.readFileSync(box.modelRoutingFile, "utf8"), routingBeforeAudit);
});

test("Audit reports an unavailable Codex model listing without failing", (t) => {
  const box = sandbox(t);
  const result = run(box, ["audit"]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /Codex model listing: listing unavailable/);
});
