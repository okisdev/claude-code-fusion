import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { envFor, makeSandbox, readInvocations, runCompanion } from "./lib/companion-harness.mjs";

test("models parses the installed Grok bullet listing", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODELS_OUTPUT: "Default model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n" });
  const json = runCompanion(["models", "--json"], { cwd: sandbox.workDir, env });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { engine: "grok", models: [
    { id: "grok-4.6", displayName: null },
    { id: "grok-4.5", displayName: null }
  ], source: "grok models" });
  const plain = runCompanion(["models"], { cwd: sandbox.workDir, env });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, "grok-4.6\ngrok-4.5\n");
  assert.deepEqual(readInvocations(sandbox.argsFile), [["models"], ["models"]]);
});

test("models parses named lines and tables while ignoring headings and diagnostics", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODELS_OUTPUT: "You are logged in with grok.com.\nAvailable models:\ngrok-4.7 - Grok 4.7\ngrok-4.5\n| Model ID | Display Name |\n| --- | --- |\n| grok-4.6 | Grok 4.6 |\nModel ID    Name\ngrok-4.8    Grok 4.8\n2026-10-13T05:56:36Z ERROR Settings fetch failed\n" });
  const result = runCompanion(["models", "--json"], { cwd: sandbox.workDir, env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).models, [
    { id: "grok-4.7", displayName: "Grok 4.7" },
    { id: "grok-4.5", displayName: null },
    { id: "grok-4.6", displayName: "Grok 4.6" },
    { id: "grok-4.8", displayName: "Grok 4.8" }
  ]);
});

test("models uses the scrubbed Grok child environment", (t) => {
  const sandbox = makeSandbox(t);
  const envFile = path.join(sandbox.root, "models-env.json");
  const result = runCompanion(["models"], { cwd: sandbox.workDir, env: envFor(sandbox, {
    FAKE_GROK_MODELS_OUTPUT: "grok-4.6\n",
    FAKE_GROK_MODELS_ENV_FILE: envFile,
    ANTHROPIC_API_KEY: "must-be-scrubbed",
    XAI_API_KEY: "retained-for-auth",
    CLAUDE_PLUGIN_ROOT: "must-be-scrubbed"
  }) });
  assert.equal(result.status, 0, result.stderr);
  const childEnv = JSON.parse(fs.readFileSync(envFile, "utf8"));
  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(childEnv.CLAUDE_PLUGIN_ROOT, undefined);
  assert.equal(childEnv.XAI_API_KEY, "retained-for-auth");
  assert.equal(childEnv.GROK_DISABLE_AUTOUPDATER, "1");
  assert.equal(childEnv.GROK_MEMORY, "0");
});

test("models classifies CLI, auth, setup, and listing failures", (t) => {
  const sandbox = makeSandbox(t);
  const cases = [
    [{ GROK_BIN: path.join(sandbox.root, "missing-grok") }, "missing_cli"],
    [{ FAKE_GROK_MODELS_EXIT_CODE: "1", FAKE_GROK_MODELS_STDERR: "authentication required\n" }, "auth"],
    [{ FAKE_GROK_MODELS_EXIT_CODE: "1", FAKE_GROK_MODELS_STDERR: "You are not logged in\n" }, "auth"],
    [{ FAKE_GROK_MODELS_EXIT_CODE: "2", FAKE_GROK_MODELS_STDERR: "error: unrecognized subcommand 'models'\n" }, "setup"],
    [{ FAKE_GROK_MODELS_EXIT_CODE: "1", FAKE_GROK_MODELS_STDERR: "unexpected failure\n" }, "error"],
    [{ FAKE_GROK_MODELS_OUTPUT: "Available models:\n" }, "error"]
  ];
  for (const [extra, kind] of cases) {
    const result = runCompanion(["models", "--json"], { cwd: sandbox.workDir, env: envFor(sandbox, extra) });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stderr).failureKind, kind);
    assert.equal(result.stdout, "");
  }
});
