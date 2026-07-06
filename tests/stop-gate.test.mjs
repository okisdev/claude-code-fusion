import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { envFor as companionEnvFor, hasPair, jobRecords, makeSandbox, readInvocations, runCompanion } from "./lib/companion-harness.mjs";
import { dirtyRepo, initCleanRepo } from "./lib/git-fixture.mjs";

function envFor(sandbox, extra = {}) {
  return companionEnvFor(sandbox, extra, { git: true });
}

function enableGate(sandbox) {
  fs.writeFileSync(
    path.join(sandbox.dataDir, "config.json"),
    `${JSON.stringify({ stopGate: true })}\n`
  );
}

function hookInput(sandbox, extra = {}) {
  return JSON.stringify({
    session_id: "claude-session-stop",
    cwd: sandbox.workDir,
    stop_hook_active: false,
    ...extra,
  });
}

function runStopGate(sandbox, { input, env } = {}) {
  return runCompanion(["stop-gate"], {
    cwd: sandbox.workDir,
    env: env ?? envFor(sandbox),
    input: input ?? hookInput(sandbox),
  });
}

test("setup toggles the stop gate and reports its state", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const enabled = runCompanion(["setup", "--enable-stop-gate", "--json"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(enabled.status, 0, enabled.stderr);
  assert.strictEqual(JSON.parse(enabled.stdout).stopGate, true);
  const config = JSON.parse(fs.readFileSync(path.join(sandbox.dataDir, "config.json"), "utf8"));
  assert.strictEqual(config.stopGate, true);
  const rendered = runCompanion(["setup"], { cwd: sandbox.workDir, env });
  assert.strictEqual(rendered.status, 0, rendered.stderr);
  assert.ok(rendered.stdout.includes("stop gate: enabled"));
  const disabled = runCompanion(["setup", "--disable-stop-gate", "--json"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(disabled.status, 0, disabled.stderr);
  assert.strictEqual(JSON.parse(disabled.stdout).stopGate, false);
});

test("stop-gate exits silently without running grok when the gate is off", (t) => {
  const sandbox = makeSandbox(t);
  initCleanRepo(sandbox.workDir);
  dirtyRepo(sandbox.workDir);
  const result = runStopGate(sandbox);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(readInvocations(sandbox.argsFile).length, 0);
});

test("stop-gate exits silently when stop_hook_active is set", (t) => {
  const sandbox = makeSandbox(t);
  initCleanRepo(sandbox.workDir);
  dirtyRepo(sandbox.workDir);
  enableGate(sandbox);
  const result = runStopGate(sandbox, { input: hookInput(sandbox, { stop_hook_active: true }) });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(readInvocations(sandbox.argsFile).length, 0);
});

test("stop-gate exits silently when the cwd is not a git repository", (t) => {
  const sandbox = makeSandbox(t);
  fs.writeFileSync(path.join(sandbox.workDir, "plain.txt"), "not a repo\n");
  enableGate(sandbox);
  const result = runStopGate(sandbox);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(readInvocations(sandbox.argsFile).length, 0);
});

test("stop-gate exits silently when the working tree is clean", (t) => {
  const sandbox = makeSandbox(t);
  initCleanRepo(sandbox.workDir);
  enableGate(sandbox);
  const result = runStopGate(sandbox);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(readInvocations(sandbox.argsFile).length, 0);
});

test("stop-gate allows the stop when grok replies ALLOW", (t) => {
  const sandbox = makeSandbox(t);
  initCleanRepo(sandbox.workDir);
  dirtyRepo(sandbox.workDir);
  enableGate(sandbox);
  const result = runStopGate(sandbox, { env: envFor(sandbox, { FAKE_GROK_MODE: "gate-allow" }) });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, "");
  const invocations = readInvocations(sandbox.argsFile);
  assert.strictEqual(invocations.length, 1);
  assert.ok(hasPair(invocations[0], "--max-turns", "15"));
  assert.ok(hasPair(invocations[0], "--permission-mode", "dontAsk"));
  const brief = fs.readFileSync(
    invocations[0][invocations[0].indexOf("--prompt-file") + 1],
    "utf8"
  );
  assert.ok(brief.includes("export const other = 2;"));
  assert.ok(brief.includes("untracked.txt"));
  const records = jobRecords(sandbox.dataDir);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].status, "done");
  assert.strictEqual(records[0].mode, "consult");
  assert.strictEqual(records[0].claudeSessionId, "claude-session-stop");
  const resultOutput = runCompanion(["result", records[0].id], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(resultOutput.status, 0, resultOutput.stderr);
  assert.ok(resultOutput.stdout.includes("ALLOW"));
});

test("stop-gate blocks the stop with the upstream decision shape when grok replies BLOCK", (t) => {
  const sandbox = makeSandbox(t);
  initCleanRepo(sandbox.workDir);
  dirtyRepo(sandbox.workDir);
  enableGate(sandbox);
  const result = runStopGate(sandbox, { env: envFor(sandbox, { FAKE_GROK_MODE: "gate-block" }) });
  assert.strictEqual(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.strictEqual(payload.decision, "block");
  assert.ok(payload.reason.includes("reason text"));
  const records = jobRecords(sandbox.dataDir);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].status, "done");
});

test("stop-gate allows when BLOCK appears after a preamble", (t) => {
  const sandbox = makeSandbox(t);
  initCleanRepo(sandbox.workDir);
  dirtyRepo(sandbox.workDir);
  enableGate(sandbox);
  const result = runStopGate(sandbox, { env: envFor(sandbox, { FAKE_GROK_MODE: "gate-block-preamble" }) });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, "");
  const records = jobRecords(sandbox.dataDir);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].status, "done");
});

test("stop-gate uses the first non-empty line for BLOCK decisions", (t) => {
  const sandbox = makeSandbox(t);
  initCleanRepo(sandbox.workDir);
  dirtyRepo(sandbox.workDir);
  enableGate(sandbox);
  const result = runStopGate(sandbox, { env: envFor(sandbox, { FAKE_GROK_MODE: "gate-block-leading-blank" }) });
  assert.strictEqual(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.strictEqual(payload.decision, "block");
  assert.ok(payload.reason.includes("leading blank reason text"));
});

test("stop-gate runs when the userConfig env var is true even if the legacy flag is off", (t) => {
  const sandbox = makeSandbox(t);
  initCleanRepo(sandbox.workDir);
  dirtyRepo(sandbox.workDir);
  const result = runStopGate(sandbox, {
    env: envFor(sandbox, { FAKE_GROK_MODE: "gate-allow", CLAUDE_PLUGIN_OPTION_STOP_GATE: "TRUE" }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const invocations = readInvocations(sandbox.argsFile);
  assert.strictEqual(invocations.length, 1);
});

test("stop-gate skips when the userConfig env var is false even if the legacy flag is on", (t) => {
  const sandbox = makeSandbox(t);
  initCleanRepo(sandbox.workDir);
  dirtyRepo(sandbox.workDir);
  enableGate(sandbox);
  const result = runStopGate(sandbox, {
    env: envFor(sandbox, { FAKE_GROK_MODE: "gate-allow", CLAUDE_PLUGIN_OPTION_STOP_GATE: "0" }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(readInvocations(sandbox.argsFile).length, 0);
});

test("stop-gate falls back to the legacy flag when the userConfig env var is garbage", (t) => {
  const sandbox = makeSandbox(t);
  initCleanRepo(sandbox.workDir);
  dirtyRepo(sandbox.workDir);
  enableGate(sandbox);
  const result = runStopGate(sandbox, {
    env: envFor(sandbox, { FAKE_GROK_MODE: "gate-allow", CLAUDE_PLUGIN_OPTION_STOP_GATE: "maybe" }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(readInvocations(sandbox.argsFile).length, 1);
});

test("stop-gate preserves current behavior when the userConfig env var is unset", (t) => {
  const sandbox = makeSandbox(t);
  initCleanRepo(sandbox.workDir);
  dirtyRepo(sandbox.workDir);
  const offResult = runStopGate(sandbox, { env: envFor(sandbox, { FAKE_GROK_MODE: "gate-allow" }) });
  assert.strictEqual(offResult.status, 0, offResult.stderr);
  assert.strictEqual(readInvocations(sandbox.argsFile).length, 0);
  enableGate(sandbox);
  const onResult = runStopGate(sandbox, { env: envFor(sandbox, { FAKE_GROK_MODE: "gate-allow" }) });
  assert.strictEqual(onResult.status, 0, onResult.stderr);
  assert.strictEqual(readInvocations(sandbox.argsFile).length, 1);
});

test("stop-gate exits silently when grok fails", (t) => {
  const sandbox = makeSandbox(t);
  initCleanRepo(sandbox.workDir);
  dirtyRepo(sandbox.workDir);
  enableGate(sandbox);
  const result = runStopGate(sandbox, { env: envFor(sandbox, { FAKE_GROK_MODE: "error" }) });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, "");
  const records = jobRecords(sandbox.dataDir);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].status, "error");
});
