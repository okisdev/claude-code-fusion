import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { hashRulesTemplate } from "../plugins/fusion/scripts/lib/rules-template.mjs";
import { DEFAULT_MODEL_TABLE_PLACEHOLDER, DEFAULT_MODEL_ROUTING_MODELS, resolveModelRoutingPath } from "../plugins/fusion/scripts/lib/model-table.mjs";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "plugins", "fusion", "scripts", "fusion-config.mjs");

const CANONICAL = `# Orchestration policy

canonical rules content

<!-- fusion:model-table:start -->
This machine's capability table, breadth seat, and lane defaults arrive as session context at session start and after compaction; \`/fusion:config\` shows and edits them.
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
  const companions = Object.fromEntries(["codex", "grok", "cursor", "devin", "agy"].map((engine) => {
    const file = path.join(root, `${engine}-companion.mjs`);
    const models = engine === "codex"
      ? ["gpt-5.6-terra", "gpt-5.7-new", "gpt-6-sol", "o3"]
      : engine === "grok"
        ? ["grok-4.7-build-fast", "grok-new"]
        : engine === "cursor"
          ? ["muse-spark-1.3-xhigh", "composer-2.5", "cursor-new"]
          : engine === "devin"
            ? ["muse-wonder-xhigh", "swe-2", "devin-new"]
            : ["gemini-4-neon", "gemini-4-hydrogen", "gemini-4-argon"];
    fs.writeFileSync(file, `if (process.argv.slice(2).join(" ") !== "models --json") process.exit(2);\nprocess.stdout.write(JSON.stringify(${JSON.stringify({ engine, models: models.map((id) => ({ id, displayName: id })), source: "test listing" })}));\n`);
    return [engine, file];
  }));
  return {
    root,
    pluginRoot,
    fusionData: path.join(root, "fusion-data"),
    modelRoutingFile: path.join(root, "model-routing.json"),
    companions,
    rulesFile: path.join(root, "live", "orchestration.md")
  };
}

function run(sandbox, args, overrides = {}) {
  const environment = { ...process.env };
  delete environment.FUSION_POSTURE;
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: {
      ...environment,
      CLAUDE_PLUGIN_ROOT: sandbox.pluginRoot,
      FUSION_DATA_DIR: sandbox.fusionData,
      FUSION_MODEL_ROUTING: sandbox.modelRoutingFile,
      FUSION_RULES_FILE: sandbox.rulesFile,
      FUSION_CODEX_COMPANION: sandbox.companions.codex,
      FUSION_GROK_COMPANION: sandbox.companions.grok,
      FUSION_CURSOR_COMPANION: sandbox.companions.cursor,
      FUSION_DEVIN_COMPANION: sandbox.companions.devin,
      FUSION_AGY_COMPANION: sandbox.companions.agy,
      ...overrides
    }
  });
}

test("model routing follows FUSION_DATA_DIR and preserves explicit and legacy paths", (t) => {
  const box = sandbox(t);
  const redirected = path.join(box.fusionData, "model-routing.json");
  assert.strictEqual(resolveModelRoutingPath({ FUSION_DATA_DIR: ` ${box.fusionData} ` }), redirected);
  assert.strictEqual(resolveModelRoutingPath({ FUSION_DATA_DIR: box.fusionData, FUSION_MODEL_ROUTING: box.modelRoutingFile }), box.modelRoutingFile);
  const legacy = path.join(os.homedir(), ".claude", "plugins", "data", "fusion-claude-code-fusion", "model-routing.json");
  assert.strictEqual(resolveModelRoutingPath({}), legacy);
  assert.strictEqual(resolveModelRoutingPath({ FUSION_DATA_DIR: " " }), legacy);
  const result = run(box, ["set-cost-profile", "shared storage"], { FUSION_MODEL_ROUTING: "" });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(redirected, "utf8")).costProfile, "shared storage");
  assert.strictEqual(fs.statSync(redirected).mode & 0o777, 0o600);
});

test("Rejects a bad score with a usage error", (t) => {
  const box = sandbox(t);
  const result = run(box, ["rescore", "codex", "--intelligence", "6", "--taste", "3", "--cost", "3"]);
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /Expected --intelligence to be an integer from 1 to 5/);
  assert.strictEqual(fs.existsSync(box.modelRoutingFile), false);
});

test("Rescore keeps notes in routing data and prints the table without installing live rules", (t) => {
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
  assert.strictEqual(data.models.length, 4);
  assert.deepStrictEqual(data.models.slice(0, 3), DEFAULT_MODEL_ROUTING_MODELS);
  assert.deepStrictEqual(data.models[3], {
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
  assert.strictEqual(fs.existsSync(box.rulesFile), false);
  assert.match(result.stdout, /^\| codex \| codex \| openai \| 5 \| 4 \| 5 \| primary implementation lane \|$/m);
  assert.match(result.stdout, /Routing changes take effect in new sessions or after \/compact\./);
  const listing = run(box, ["show"]);
  assert.strictEqual(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /^\| Engine \| Lane \| Family \| Intelligence \| Taste \| Cost \| Notes \|$/m);
  assert.match(listing.stdout, /^\| codex \| codex \| openai \| 5 \| 4 \| 5 \| primary implementation lane \|$/m);
});

test("Set-default writes a lane choice and prints the updated defaults without installing live rules", (t) => {
  const box = sandbox(t);
  assert.strictEqual(
    run(box, ["rescore", "gpt-6-sol", "--intelligence", "5", "--taste", "4", "--cost", "4", "--lane", "codex"]).status,
    0
  );
  const result = run(box, ["set-default", "codex", "quick", "gpt-6-sol", "high"]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /Updated codex quick default to gpt-6-sol@high\./);
  const data = JSON.parse(fs.readFileSync(box.modelRoutingFile, "utf8"));
  assert.deepStrictEqual(data.defaults, { codex: { quick: { model: "gpt-6-sol", effort: "high" } } });
  assert.match(result.stdout, /^Lane defaults: codex quick gpt-6-sol@high, volume gpt-6-sol@high/m);
  assert.strictEqual(fs.existsSync(box.rulesFile), false);
  assert.strictEqual(
    run(box, ["rescore", "grok-4.7", "--intelligence", "5", "--taste", "4", "--cost", "4", "--lane", "grok"]).status,
    0
  );
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(box.modelRoutingFile, "utf8")).defaults, data.defaults);
});

test("Set-breadth creates routing data, changes the rendered seat, and preserves scores", (t) => {
  const box = sandbox(t);
  const invalid = run(box, ["set-breadth", "grok"]);
  assert.strictEqual(invalid.status, 1);
  assert.match(invalid.stderr, /Expected set-breadth <cursor\|devin>/);
  assert.strictEqual(fs.existsSync(box.modelRoutingFile), false);
  const selected = run(box, ["set-breadth", "devin"]);
  assert.strictEqual(selected.status, 0, selected.stderr);
  assert.match(selected.stdout, /Updated breadth engine to Devin \(devin\)/);
  const data = JSON.parse(fs.readFileSync(box.modelRoutingFile, "utf8"));
  assert.strictEqual(data.breadth, "devin");
  assert.deepStrictEqual(data.models, DEFAULT_MODEL_ROUTING_MODELS);
  assert.match(selected.stdout, /Breadth engine: Devin \(devin\)/);
  assert.strictEqual(run(box, ["rescore", "muse-wonder", "--intelligence", "5", "--taste", "5", "--cost", "3", "--lane", "devin", "--family", "meta"]).status, 0);
  assert.strictEqual(run(box, ["rescore", "composer-2.5", "--intelligence", "4", "--taste", "4", "--cost", "4", "--lane", "cursor", "--family", "cognition"]).status, 0);
  assert.strictEqual(run(box, ["set-default", "devin", "diversity", "muse-wonder", "xhigh"]).status, 0);
  const listing = run(box, ["show"]);
  assert.strictEqual(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /\| muse-wonder \| devin \| meta \|/);
  assert.doesNotMatch(listing.stdout, /\| composer-2\.5 \| cursor \|/);
  assert.match(listing.stdout, /devin diversity muse-wonder@xhigh/);
  assert.doesNotMatch(listing.stdout, /cursor diversity/);
  const audit = JSON.parse(run(box, ["audit", "--json"]).stdout);
  assert.strictEqual(audit.breadth, "devin");
  assert.strictEqual(audit.engines.devin.listing.available, true);
  assert.deepStrictEqual(audit.engines.devin.defaultsAbsent, []);
  assert.strictEqual(Object.hasOwn(audit.defaults, "cursor"), false);
  assert.deepStrictEqual(audit.engines.cursor.unscored, []);
  const switched = run(box, ["set-breadth", "cursor"]);
  assert.strictEqual(switched.status, 0, switched.stderr);
  assert.match(switched.stdout, /\| composer-2\.5 \| cursor \| cognition \|/);
  assert.doesNotMatch(switched.stdout, /\| muse-wonder \| devin \|/);
  assert.strictEqual(fs.existsSync(box.rulesFile), false);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(box.modelRoutingFile, "utf8")).models.map((row) => row.id), [...DEFAULT_MODEL_ROUTING_MODELS.map((row) => row.id), "muse-wonder", "composer-2.5"]);
});

test("Set-default rejects invalid choices and leaves the routing file unchanged", (t) => {
  const box = sandbox(t);
  assert.strictEqual(
    run(box, ["rescore", "gpt-6-sol", "--intelligence", "5", "--taste", "4", "--cost", "4", "--lane", "codex"]).status,
    0
  );
  const before = fs.readFileSync(box.modelRoutingFile, "utf8");
  for (const [args, reason] of [
    [["grok", "quick", "gpt-6-sol", "high"], /Expected codex role/],
    [["codex", "quick", "gpt-6-sol", "ultra"], /defaults\.codex\.quick\.effort/],
    [["grok", "burst", "gpt-6-sol", "low"], /match a model in the grok lane/],
    [["codex", "quick", "missing", "high"], /match a model in the codex lane/]
  ]) {
    const result = run(box, ["set-default", ...args]);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, reason);
    assert.strictEqual(fs.readFileSync(box.modelRoutingFile, "utf8"), before);
  }
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
  assert.strictEqual(data.data.models[3].id, "grok-fast");
  assert.match(data.table, /^\| grok-fast \| grok \| xai \| 3 \| 3 \| 5 \|  \|$/m);
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

test("Audit reports listing drift, unscored models, and Cursor variants per engine", (t) => {
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
  assert.strictEqual(run(box, ["rescore", "muse-spark-1.3", "--intelligence", "4", "--taste", "5", "--cost", "3", "--lane", "cursor", "--family", "meta"]).status, 0);
  assert.strictEqual(run(box, ["rescore", "composer-2.5", "--intelligence", "4", "--taste", "4", "--cost", "4", "--lane", "cursor", "--family", "cursor"]).status, 0);
  assert.strictEqual(run(box, ["set-default", "codex", "quick", "gpt-5.6-terra", "high"]).status, 0);
  assert.strictEqual(run(box, ["set-default", "cursor", "diversity", "muse-spark-1.3", "xhigh"]).status, 0);
  assert.strictEqual(run(box, ["set-default", "cursor", "burst", "composer-2.5", "default"]).status, 0);
  const routingBeforeAudit = fs.readFileSync(box.modelRoutingFile, "utf8");
  const result = run(box, ["audit", "--json"]);
  assert.strictEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.engines.codex.listing.available, true);
  assert.strictEqual(report.engines.codex.listing.source, "test listing");
  assert.deepStrictEqual(report.engines.codex.configuredButAbsent, ["gpt-5.5-missing"]);
  assert.deepStrictEqual(report.defaults.codex.quick, { model: "gpt-5.6-terra", effort: "high" });
  assert.deepStrictEqual(report.defaults.codex.volume, { model: "gpt-6-sol", effort: "high" });
  assert.deepStrictEqual(report.defaults.grok.burst, { model: "grok-4.7-build-fast", effort: "low" });
  assert.deepStrictEqual(report.engines.codex.defaultsAbsent, [
    { role: "flagship", model: "gpt-6.1-sol" }
  ]);
  assert.deepStrictEqual(report.engines.codex.unscored, ["gpt-5.7-new", "gpt-6-sol", "o3"]);
  assert.deepStrictEqual(report.engines.grok.configuredButAbsent, ["grok-4-missing"]);
  assert.deepStrictEqual(report.engines.grok.unscored, ["grok-4.7-build-fast", "grok-new"]);
  assert.deepStrictEqual(report.engines.cursor.configuredButAbsent, []);
  assert.deepStrictEqual(report.engines.cursor.defaultsAbsent, []);
  assert.deepStrictEqual(report.engines.cursor.unscored, ["cursor-new"]);
  assert.strictEqual(fs.readFileSync(box.modelRoutingFile, "utf8"), routingBeforeAudit);
  const text = run(box, ["audit"]);
  assert.match(text.stdout, /codex defaults: quick gpt-5\.6-terra@high/);
  assert.match(text.stdout, /volume gpt-6-sol@high/);
  assert.match(text.stdout, /Codex defaults absent: flagship gpt-6\.1-sol/);
  assert.match(text.stdout, /Unconfigured gpt-\* newcomers: gpt-5\.7-new/);
  assert.match(text.stdout, /Cursor unscored models \(no routing seat\): cursor-new/);
});

test("Audit reports an unavailable companion and continues with other engines", (t) => {
  const box = sandbox(t);
  const result = run(box, ["audit"], { FUSION_GROK_COMPANION: path.join(box.root, "missing.mjs") });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /Grok listing unavailable: companion missing/);
  assert.match(result.stdout, /Codex model listing: test listing/);
  assert.match(result.stdout, /Cursor model listing: test listing/);
  assert.match(result.stdout, /grok defaults: burst grok-4\.7-build-fast@low/);
});

test("Audit lists catalog models without a configured routing file", (t) => {
  const box = sandbox(t);
  const report = JSON.parse(run(box, ["audit", "--json"]).stdout);
  assert.strictEqual(report.configured, false);
  assert.deepStrictEqual(report.engines.codex.unscored, ["gpt-5.6-terra", "gpt-5.7-new", "gpt-6-sol", "o3"]);
  assert.deepStrictEqual(report.engines.cursor.unscored, ["muse-spark-1.3-xhigh", "composer-2.5", "cursor-new"]);
});

test("Audit isolates invalid JSON and failed companion exits", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(box.companions.codex, "process.stdout.write('{invalid');\n");
  fs.writeFileSync(box.companions.cursor, "process.stderr.write('catalog failed'); process.exit(3);\n");
  const report = JSON.parse(run(box, ["audit", "--json"]).stdout);
  assert.match(report.engines.codex.listing.reason, /invalid JSON/);
  assert.strictEqual(report.engines.grok.listing.available, true);
  assert.strictEqual(report.engines.cursor.listing.reason, "catalog failed");
});

test("Cursor rescore requires family and accepts default effort", (t) => {
  const box = sandbox(t);
  const args = ["rescore", "composer-2.5", "--intelligence", "4", "--taste", "4", "--cost", "4", "--lane", "cursor"];
  const invalid = run(box, args);
  assert.strictEqual(invalid.status, 1);
  assert.match(invalid.stderr, /models\[3\]\.family/);
  assert.strictEqual(run(box, [...args, "--family", "cursor"]).status, 0);
  assert.strictEqual(run(box, ["set-default", "cursor", "burst", "composer-2.5", "default"]).status, 0);
  const listing = run(box, ["show"]);
  assert.strictEqual(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /\| composer-2\.5 \| cursor \| cursor \| 4 \| 4 \| 4 \|/);
});

test("Set-default rejects a model absent from a live listing and names the listing source", (t) => {
  const box = sandbox(t);
  assert.strictEqual(
    run(box, ["rescore", "gpt-5.5-missing", "--intelligence", "4", "--taste", "4", "--cost", "5", "--lane", "codex"]).status,
    0
  );
  const before = fs.readFileSync(box.modelRoutingFile, "utf8");
  const result = run(box, ["set-default", "codex", "quick", "gpt-5.5-missing", "high"]);
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /absent from the Codex model listing \(test listing\)/);
  assert.strictEqual(fs.readFileSync(box.modelRoutingFile, "utf8"), before);
});

test("Set-default warns and proceeds when the engine listing is unavailable", (t) => {
  const box = sandbox(t);
  assert.strictEqual(
    run(box, ["rescore", "gpt-6-sol", "--intelligence", "5", "--taste", "4", "--cost", "4", "--lane", "codex"]).status,
    0
  );
  const result = run(box, ["set-default", "codex", "quick", "gpt-6-sol", "high"], {
    FUSION_CODEX_COMPANION: path.join(box.root, "missing.mjs")
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /Codex model listing unavailable; model availability was not checked/);
  assert.match(result.stdout, /Updated codex quick default to gpt-6-sol@high/);
});

test("Every config mutation prints routing context while leaving missing, shipped, and hand edited rules untouched", (t) => {
  for (const state of ["missing", "shipped", "hand-edited"]) {
    const box = sandbox(t);
    const content = state === "hand-edited" ? CANONICAL.replace("canonical rules content", "hand edited rules content") : CANONICAL;
    if (state !== "missing") {
      fs.mkdirSync(path.dirname(box.rulesFile), { recursive: true });
      fs.writeFileSync(box.rulesFile, content);
    }
    const mtime = state === "missing" ? null : fs.statSync(box.rulesFile).mtimeMs;
    const commands = [
      ["remove", "missing"],
      ["rescore", "gpt-6-sol", "--intelligence", "5", "--taste", "4", "--cost", "5", "--lane", "codex"],
      ["set-default", "codex", "quick", "gpt-6-sol", "high"],
      ["set-breadth", "devin"],
      ["set-cost-profile", "peer subscriptions flat rate"],
      ["remove", "missing"],
      ["rescore", "grok-fast", "--intelligence", "3", "--taste", "3", "--cost", "5", "--lane", "grok"],
      ["remove", "grok-fast"],
      ["reset-defaults", "--yes"]
    ];
    for (const args of commands) {
      const result = run(box, args);
      assert.strictEqual(result.status, 0, `${state}: ${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stdout, /Routing changes take effect in new sessions or after \/compact\./);
      assert.doesNotMatch(result.stdout, /local edits|\/fusion:setup|rules installed|rules updated/);
      if (fs.existsSync(box.modelRoutingFile)) {
        assert.match(result.stdout, /^\| Engine \| Lane \| Family \| Intelligence \| Taste \| Cost \| Notes \|$/m);
      } else {
        assert.ok(result.stdout.includes(DEFAULT_MODEL_TABLE_PLACEHOLDER));
      }
      if (state === "missing") {
        assert.strictEqual(fs.existsSync(path.dirname(box.rulesFile)), false);
      } else {
        assert.strictEqual(fs.readFileSync(box.rulesFile, "utf8"), content);
        assert.strictEqual(fs.statSync(box.rulesFile).mtimeMs, mtime);
      }
    }
  }
});

test("Antigravity seeds Google scores and config rejects Google breadth diversity defaults", (t) => {
  const box = sandbox(t);
  for (const [role, effort] of [["independence", "high"], ["large-context", "high"], ["burst", "medium"]]) {
    const result = run(box, ["set-default", "agy", role, "gemini-4-neon", effort]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /gemini-4-neon \| agy \| google \| 5 \| 4 \| 4/);
    assert.match(result.stdout, /gemini-4-hydrogen \| agy \| google \| 4 \| 3 \| 5/);
    assert.match(result.stdout, /gemini-4-argon \| agy \| google \| 4 \| 3 \| 4/);
  }
  const audit = JSON.parse(run(box, ["audit", "--json"]).stdout);
  assert.strictEqual(audit.engines.agy.listing.available, true);
  assert.deepStrictEqual(audit.engines.agy.defaultsAbsent, []);
  for (const lane of ["cursor", "devin"]) {
    assert.strictEqual(run(box, ["rescore", `gemini-${lane}`, "--lane", lane, "--family", "google", "--intelligence", "5", "--taste", "4", "--cost", "4"]).status, 0);
    const before = fs.readFileSync(box.modelRoutingFile, "utf8");
    const refused = run(box, ["set-default", lane, "diversity", `gemini-${lane}`, "high"]);
    assert.strictEqual(refused.status, 1);
    assert.match(refused.stderr, /google family served by Antigravity/);
    assert.strictEqual(fs.readFileSync(box.modelRoutingFile, "utf8"), before);
  }
});
