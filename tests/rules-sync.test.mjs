import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { hashRulesTemplate, renderRulesContent } from "../plugins/fusion/scripts/lib/rules-template.mjs";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "plugins", "fusion", "scripts", "rules-sync.mjs");

const CANONICAL = `# Orchestration policy

canonical rules content

<!-- fusion:model-table:start -->
Engine capability table: run /fusion:config to score your configured engines (intelligence, taste, cost, 1 to 5) and regenerate this block. Until scored, route by the qualitative lane descriptions in this document.
<!-- fusion:model-table:end -->

canonical routing footer
`;
const OLD_VERSION = "# Orchestration policy\n\nold rules content\n";
const UNKNOWN_VERSION = "# Orchestration policy\n\nhand edited by the user\n";

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-rules-sync-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginRoot = path.join(root, "plugin");
  fs.mkdirSync(path.join(pluginRoot, "rules"), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "rules", "orchestration.md"), CANONICAL, "utf8");
  fs.writeFileSync(
    path.join(pluginRoot, "rules-manifest.json"),
    `${JSON.stringify({ format: 2, hashes: [hashRulesTemplate(CANONICAL), hashRulesTemplate(OLD_VERSION)] }, null, 2)}\n`,
    "utf8"
  );
  const rulesFile = path.join(root, "live", "orchestration.md");
  const modelRoutingFile = path.join(root, "model-routing.json");
  return { root, pluginRoot, rulesFile, modelRoutingFile };
}

function run(sandbox) {
  return spawnSync(process.execPath, [script], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: sandbox.pluginRoot,
      FUSION_RULES_FILE: sandbox.rulesFile,
      FUSION_MODEL_ROUTING: sandbox.modelRoutingFile
    },
    encoding: "utf8"
  });
}

function writeModelRouting(file) {
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        updatedAt: "2026-07-04T00:00:00.000Z",
        costProfile: "peer subscriptions flat rate",
        models: [
          { id: "codex", lane: "codex", intelligence: 5, taste: 4, cost: 5, notes: "primary implementation lane" }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

test("Missing live file installs the canonical rules and prints the installed line", (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(
    result.stdout,
    "fusion: routing rules installed (run /fusion:setup for the optional permission check)\n"
  );
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), CANONICAL);
});

test("Live file matching the rendered canonical content prints nothing and is left untouched", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, CANONICAL, "utf8");
  const before = fs.statSync(sandbox.rulesFile).mtimeMs;
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), CANONICAL);
  assert.strictEqual(fs.statSync(sandbox.rulesFile).mtimeMs, before);
});

test("Live file matching a manifest hash gets overwritten and prints the updated line", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, OLD_VERSION, "utf8");
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "fusion: routing rules updated to the current plugin version\n");
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), CANONICAL);
});

test("Live file with unknown content is left untouched and prints the local edits line", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, UNKNOWN_VERSION, "utf8");
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(
    result.stdout,
    `fusion: local edits detected in ${sandbox.rulesFile}, run /fusion:setup to reconcile with the plugin's newer rules\n`
  );
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), UNKNOWN_VERSION);
});

test("Rendered model scores do not look like local edits", (t) => {
  const sandbox = makeSandbox(t);
  writeModelRouting(sandbox.modelRoutingFile);
  const rendered = renderRulesContent(CANONICAL, { routingPath: sandbox.modelRoutingFile });
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, rendered, "utf8");
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), rendered);
});

test("Invalid model routing leaves the existing live table intact and warns", (t) => {
  const sandbox = makeSandbox(t);
  writeModelRouting(sandbox.modelRoutingFile);
  const rendered = renderRulesContent(CANONICAL, { routingPath: sandbox.modelRoutingFile });
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, rendered, "utf8");
  fs.writeFileSync(sandbox.modelRoutingFile, "{ not json", "utf8");
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.match(result.stderr, new RegExp(`^fusion: model routing file invalid at ${sandbox.modelRoutingFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`));
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), rendered);
});

test("Missing model routing replaces a scored live table with the placeholder", (t) => {
  const sandbox = makeSandbox(t);
  writeModelRouting(sandbox.modelRoutingFile);
  const rendered = renderRulesContent(CANONICAL, { routingPath: sandbox.modelRoutingFile });
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, rendered, "utf8");
  fs.rmSync(sandbox.modelRoutingFile, { force: true });
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), CANONICAL);
});

test("Hand edited template content still looks like local edits", (t) => {
  const sandbox = makeSandbox(t);
  const handEdited = CANONICAL.replace("canonical routing footer", "hand edited routing footer");
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, handEdited, "utf8");
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(
    result.stdout,
    `fusion: local edits detected in ${sandbox.rulesFile}, run /fusion:setup to reconcile with the plugin's newer rules\n`
  );
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), handEdited);
});

test("Rules sync logs unexpected failures without blocking the session", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.rulesFile, { recursive: true });
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.match(result.stderr, /^fusion: rules sync failed: /);
});

test("Doctor and setup describe template hash comparison for live rules", () => {
  const doctor = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "commands", "doctor.md"), "utf8");
  const setup = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "commands", "setup.md"), "utf8");
  assert.match(doctor, /hashRulesTemplate/);
  assert.match(doctor, /A scored live model table is expected to differ from the shipped placeholder/);
  assert.match(setup, /hashRulesTemplate/);
  assert.match(setup, /do not compare raw bytes/);
  assert.match(setup, /A live scored model table is expected to differ from the shipped placeholder/);
  assert.doesNotMatch(setup, /is identical/);
  assert.doesNotMatch(setup, /write the canonical content/);
});

test("The shipped rules manifest contains the current rules file template hash", () => {
  const rulesPath = path.join(repoRoot, "plugins", "fusion", "rules", "orchestration.md");
  const manifestPath = path.join(repoRoot, "plugins", "fusion", "rules-manifest.json");
  const currentHash = hashRulesTemplate(fs.readFileSync(rulesPath, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.strictEqual(manifest.format, 2);
  assert.ok(
    manifest.hashes.includes(currentHash),
    "plugins/fusion/rules-manifest.json is stale, run node plugins/fusion/scripts/generate-rules-manifest.mjs"
  );
});
