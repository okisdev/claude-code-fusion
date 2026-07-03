import assert from "node:assert";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "plugins", "fusion", "scripts", "rules-sync.mjs");

const CANONICAL = "# Orchestration policy\n\ncanonical rules content\n";
const OLD_VERSION = "# Orchestration policy\n\nold rules content\n";
const UNKNOWN_VERSION = "# Orchestration policy\n\nhand edited by the user\n";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-rules-sync-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginRoot = path.join(root, "plugin");
  fs.mkdirSync(path.join(pluginRoot, "rules"), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "rules", "orchestration.md"), CANONICAL, "utf8");
  fs.writeFileSync(
    path.join(pluginRoot, "rules-manifest.json"),
    `${JSON.stringify({ hashes: [sha256(CANONICAL), sha256(OLD_VERSION)] }, null, 2)}\n`,
    "utf8"
  );
  const rulesFile = path.join(root, "live", "orchestration.md");
  return { root, pluginRoot, rulesFile };
}

function run(sandbox) {
  return spawnSync(process.execPath, [script], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: sandbox.pluginRoot,
      FUSION_RULES_FILE: sandbox.rulesFile,
    },
    encoding: "utf8",
  });
}

test("missing live file installs the canonical rules and prints the installed line", (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(
    result.stdout,
    "fusion: routing rules installed (run /fusion:setup for the optional permission check)\n"
  );
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), CANONICAL);
});

test("live file matching the canonical content prints nothing and is left untouched", (t) => {
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

test("live file matching a manifest hash gets overwritten and prints the updated line", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, OLD_VERSION, "utf8");
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "fusion: routing rules updated to the current plugin version\n");
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), CANONICAL);
});

test("live file with unknown content is left untouched and prints the local edits line", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, UNKNOWN_VERSION, "utf8");
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(
    result.stdout,
    "fusion: local edits detected in ~/.claude/rules/orchestration.md, run /fusion:setup to reconcile with the plugin's newer rules\n"
  );
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), UNKNOWN_VERSION);
});

test("the shipped rules-manifest.json contains the current rules file's hash", () => {
  const rulesPath = path.join(repoRoot, "plugins", "fusion", "rules", "orchestration.md");
  const manifestPath = path.join(repoRoot, "plugins", "fusion", "rules-manifest.json");
  const currentHash = sha256(fs.readFileSync(rulesPath, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.ok(
    manifest.hashes.includes(currentHash),
    "plugins/fusion/rules-manifest.json is stale, run node plugins/fusion/scripts/generate-rules-manifest.mjs"
  );
});
