import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "plugins", "fusion", "scripts", "fleet-posture.mjs");

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-posture-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dataDir: path.join(root, "fusion-data") };
}

function envFor(sandbox, extra = {}) {
  const env = { ...process.env, FUSION_DATA_DIR: sandbox.dataDir, ...extra };
  if (!Object.hasOwn(extra, "FUSION_FLEET_MODE")) {
    delete env.FUSION_FLEET_MODE;
  }
  return env;
}

function run(sandbox, input = JSON.stringify({ session_id: "session-1", prompt: "do work", cwd: sandbox.root }), extraEnv = {}) {
  return spawnSync(process.execPath, [script], {
    input,
    env: envFor(sandbox, extraEnv),
    encoding: "utf8"
  });
}

test("the default posture emits the UserPromptSubmit fleet reminder", (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox);

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /fleet-default active/);
});

test("FUSION_FLEET_MODE=off disables the reminder", (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, undefined, { FUSION_FLEET_MODE: "off" });

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});

test("the fleet mode state file can disable the reminder", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.dataDir, { recursive: true });
  fs.writeFileSync(path.join(sandbox.dataDir, "fleet-mode"), "off\n", "utf8");
  const result = run(sandbox);

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});

test("an enabled environment mode overrides a disabled state file", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.dataDir, { recursive: true });
  fs.writeFileSync(path.join(sandbox.dataDir, "fleet-mode"), "off\n", "utf8");
  const result = run(sandbox, undefined, { FUSION_FLEET_MODE: "on" });

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stderr, "");
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /fleet-default active/);
});

test("malformed hook input is silent", (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, "{not json");

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});
