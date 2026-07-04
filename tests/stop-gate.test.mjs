import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const companion = path.join(repoRoot, "plugins", "grok", "scripts", "grok-companion.mjs");
const fakeGrok = path.join(import.meta.dirname, "fake-grok");

const gitIsolation = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-plugin-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const workDir = path.join(root, "work");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workDir);
  return { root, dataDir, workDir, argsFile: path.join(root, "args.jsonl") };
}

function envFor(sandbox, extra = {}) {
  const env = { ...process.env };
  delete env.FAKE_GROK_MODE;
  delete env.FAKE_GROK_ARGS_FILE;
  delete env.GROK_COMPANION_TIMEOUT_MS;
  delete env.CLAUDE_CODE_SESSION_ID;
  return {
    ...env,
    ...gitIsolation,
    GROK_BIN: fakeGrok,
    GROK_COMPANION_DATA: sandbox.dataDir,
    FAKE_GROK_ARGS_FILE: sandbox.argsFile,
    ...extra,
  };
}

function runCompanion(args, options) {
  return spawnSync(process.execPath, [companion, ...args], {
    cwd: options.cwd,
    env: options.env,
    input: options.input ?? "",
    encoding: "utf8",
    timeout: 60000,
  });
}

function readInvocations(argsFile) {
  if (!fs.existsSync(argsFile)) return [];
  return fs
    .readFileSync(argsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function hasPair(argv, flag, value) {
  return argv.some((token, i) => token === flag && argv[i + 1] === value);
}

function jobRecords(dataDir) {
  const stateDir = path.join(dataDir, "state");
  if (!fs.existsSync(stateDir)) return [];
  const records = [];
  for (const workspace of fs.readdirSync(stateDir)) {
    const jobsDir = path.join(stateDir, workspace, "jobs");
    if (!fs.existsSync(jobsDir)) continue;
    for (const name of fs.readdirSync(jobsDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        records.push(JSON.parse(fs.readFileSync(path.join(jobsDir, name), "utf8")));
      } catch {}
    }
  }
  return records;
}

function git(dir, args) {
  const result = spawnSync("git", args, {
    cwd: dir,
    env: { ...process.env, ...gitIsolation },
    encoding: "utf8",
  });
  assert.strictEqual(result.status, 0, result.stderr);
}

function initCleanRepo(dir) {
  git(dir, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "app.mjs"), "export const value = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init fixture"]);
}

function dirtyRepo(dir) {
  fs.appendFileSync(path.join(dir, "app.mjs"), "export const other = 2;\n");
  fs.writeFileSync(path.join(dir, "untracked.txt"), "new file\n");
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
