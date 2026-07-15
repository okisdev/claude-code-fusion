import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const runner = path.join(repoRoot, "bench", "run.mjs");
const fakeClaude = path.join(import.meta.dirname, "fake-claude");
const claudePluginCacheDirEnv = "CLAUDE_PLUGIN_CACHE_DIR";
const conditionPlugins = {
  A: [],
  B1: ["fusion@claude-code-fusion"],
  B2: ["codex@claude-code-fusion", "fusion@claude-code-fusion", "grok@claude-code-fusion"],
  B3: ["fusion@claude-code-fusion"]
};

function configureCondition(sandbox, condition, { model = condition === "B3" ? "sonnet" : null, extraPlugins = [], installedExtra = [], rules = condition !== "A" } = {}) {
  const enabledPlugins = [...conditionPlugins[condition], ...extraPlugins].sort();
  const installedPlugins = [...new Set([...enabledPlugins, ...installedExtra])].sort();
  const settings = { enabledPlugins: Object.fromEntries(enabledPlugins.map((id) => [id, true])) };
  if (model) {
    settings.model = model;
  }
  fs.writeFileSync(path.join(sandbox.claudeConfigDir, "settings.json"), JSON.stringify(settings), "utf8");
  const registryFile = path.join(sandbox.claudeConfigDir, "plugins", "installed_plugins.json");
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.writeFileSync(registryFile, JSON.stringify({ version: 2, plugins: Object.fromEntries(installedPlugins.map((id) => [id, [{}]])) }), "utf8");
  const rulesFile = path.join(sandbox.claudeConfigDir, "rules", "orchestration.md");
  fs.rmSync(rulesFile, { force: true });
  if (rules) {
    fs.mkdirSync(path.dirname(rulesFile), { recursive: true });
    fs.writeFileSync(rulesFile, "benchmark routing rules\n", "utf8");
  }
}

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bench-runner-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const taskRoot = path.join(root, "tasks");
  const taskDir = path.join(taskRoot, "T01-test");
  const fixturesDir = path.join(taskDir, "fixtures");
  const resultsDir = path.join(root, "results");
  const claudeConfigDir = path.join(root, "claude-config");
  fs.mkdirSync(path.join(fixturesDir, "src"), { recursive: true });
  fs.mkdirSync(resultsDir);
  fs.mkdirSync(claudeConfigDir);
  fs.mkdirSync(path.join(claudeConfigDir, "plugins", "fusion"), { recursive: true });
  fs.writeFileSync(path.join(claudeConfigDir, "plugins", "fusion", "enabled"), "1\n", "utf8");
  fs.writeFileSync(path.join(taskDir, "brief.md"), "Edit the marker file.\n", "utf8");
  fs.writeFileSync(
    path.join(taskDir, "verify.sh"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "workdir=\"$1\"",
      "test -f \"$workdir/src/input.txt\"",
      "test -f \"$workdir/marker.txt\"",
      "test ! -e \"$workdir/verify.sh\"",
      "grep -q \"fake claude completed\" \"$workdir/marker.txt\""
    ].join("\n") + "\n",
    "utf8",
  );
  fs.chmodSync(path.join(taskDir, "verify.sh"), 0o755);
  fs.writeFileSync(path.join(fixturesDir, "src", "input.txt"), "fixture\n", "utf8");
  const result = {
    root,
    taskRoot,
    taskId: "T01-test",
    resultsDir,
    claudeConfigDir,
    runsFile: path.join(resultsDir, "runs.jsonl"),
    envFile: path.join(resultsDir, "env.json"),
    fakeRunsFile: path.join(root, "fake-claude.jsonl")
  };
  configureCondition(result, "B2");
  return result;
}

function writeFakeVersionBin(dir, name, version) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\nprintf '%s\\n' '${version}'\n`, "utf8");
  fs.chmodSync(file, 0o755);
  return file;
}

function writeCodexPlugin(cacheDir, version) {
  const pluginDir = path.join(cacheDir, "openai-codex", "codex", version, ".claude-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({ name: "codex", version }), "utf8");
}

function envFor(sandbox, extra = {}) {
  const env = { ...process.env };
  delete env.FAKE_CLAUDE_MODE;
  delete env.FAKE_CLAUDE_RUNS_FILE;
  delete env.CLAUDE_BIN;
  delete env[claudePluginCacheDirEnv];
  return {
    ...env,
    FAKE_CLAUDE_RUNS_FILE: sandbox.fakeRunsFile,
    ...extra
  };
}

function runBench(sandbox, options = {}) {
  return spawnSync(
    process.execPath,
    [
      runner,
      "--task",
      sandbox.taskId,
      "--condition",
      options.condition ?? "B2",
      "--repetition",
      String(options.repetition ?? 2),
      "--results",
      sandbox.resultsDir,
      "--claude-config",
      sandbox.claudeConfigDir,
      "--task-root",
      sandbox.taskRoot,
      "--claude-bin",
      fakeClaude
    ],
    {
      cwd: repoRoot,
      env: envFor(sandbox, options.env),
      encoding: "utf8",
      timeout: 60000
    },
  );
}

function readRecords(sandbox) {
  if (!fs.existsSync(sandbox.runsFile)) {
    return [];
  }
  return fs
    .readFileSync(sandbox.runsFile, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("runner appends a valid record with verifier success and split token totals", (t) => {
  const sandbox = makeSandbox(t);
  const result = runBench(sandbox, { condition: "B2", repetition: 3 });
  assert.strictEqual(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout.trim());
  const records = readRecords(sandbox);
  assert.strictEqual(records.length, 1);
  assert.deepStrictEqual(printed, records[0]);
  const record = records[0];
  assert.strictEqual(record.taskId, sandbox.taskId);
  assert.strictEqual(record.condition, "B2");
  assert.strictEqual(record.repetition, 3);
  assert.match(record.runId, /^[0-9a-f-]{36}$/);
  assert.doesNotThrow(() => new Date(record.startedAt).toISOString());
  assert.doesNotThrow(() => new Date(record.finishedAt).toISOString());
  assert.match(record.taskManifestHash, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(record.conditionNotes, {
    detection: "configuration",
    installedPlugins: ["codex@claude-code-fusion", "fusion@claude-code-fusion", "grok@claude-code-fusion"],
    enabledPlugins: ["codex@claude-code-fusion", "fusion@claude-code-fusion", "grok@claude-code-fusion"],
    routingRulesPresent: true,
    mainSessionModel: null
  });
  assert.strictEqual(record.claudeExit, 0);
  assert.strictEqual(record.verifyExit, 0);
  assert.strictEqual(record.verdict, "pass");
  assert.strictEqual(record.infraFailure, null);
  assert.ok(record.wallClockSeconds >= 0);
  assert.deepStrictEqual(record.claudeTokens.orchestrator, {
    input: 130,
    output: 52,
    cacheRead: 13,
    cacheCreation: 6
  });
  assert.deepStrictEqual(record.claudeTokens.subagents, {
    input: 50,
    output: 20,
    cacheRead: 4,
    cacheCreation: 2
  });
  assert.deepStrictEqual(record.claudeTokens.byModel["claude-sonnet-4-5"], {
    input: 130,
    output: 52,
    cacheRead: 13,
    cacheCreation: 6
  });
  assert.deepStrictEqual(record.claudeTokens.byModel["claude-haiku-4-5"], {
    input: 50,
    output: 20,
    cacheRead: 4,
    cacheCreation: 2
  });
  assert.strictEqual(record.claudeTokens.byModel["claude-opus-4-1"], undefined);
  assert.deepStrictEqual(record.peerTokens, { grok: null, codex: null });
  assert.strictEqual(record.delegationCount, 1);
  assert.strictEqual(record.resumeCount, 0);
  assert.strictEqual(record.escalationCount, 0);
  assert.strictEqual(record.excluded, false);
  assert.strictEqual(record.excludedReason, null);
  const fakeRun = JSON.parse(fs.readFileSync(sandbox.fakeRunsFile, "utf8").trim());
  assert.strictEqual(fakeRun.sawVerify, false);
  assert.deepStrictEqual(fakeRun.args, ["-p", "Edit the marker file.\n", "--output-format", "json"]);
  assert.strictEqual(fs.existsSync(fakeRun.cwd), false);
});

test("runner accepts condition B3 with null peer tokens", (t) => {
  const sandbox = makeSandbox(t);
  configureCondition(sandbox, "B3");
  const result = runBench(sandbox, { condition: "B3", repetition: 1 });
  assert.strictEqual(result.status, 0, result.stderr);
  const records = readRecords(sandbox);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].condition, "B3");
  assert.strictEqual(records[0].repetition, 1);
  assert.strictEqual(records[0].peerTokens, null);
  assert.strictEqual(records[0].conditionNotes.mainSessionModel, "sonnet");
});

test("runner refuses condition B3 without a sonnet settings pin", (t) => {
  const sandbox = makeSandbox(t);
  configureCondition(sandbox, "B3", { model: null });
  const result = runBench(sandbox, { condition: "B3", repetition: 1 });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /Invalid B3 configuration/);
  assert.match(result.stderr, /settings\.json/);
  assert.match(result.stderr, /\{"model": "sonnet"\}/);
  assert.deepStrictEqual(readRecords(sandbox), []);
  assert.strictEqual(fs.existsSync(sandbox.envFile), false);
  assert.strictEqual(fs.existsSync(sandbox.fakeRunsFile), false);
});

test("runner writes an infra failure record when the transcript is missing", (t) => {
  const sandbox = makeSandbox(t);
  const result = runBench(sandbox, { env: { FAKE_CLAUDE_MODE: "no-transcript" } });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /Claude transcript cannot be located/);
  const records = readRecords(sandbox);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].verdict, "infra_failure");
  assert.strictEqual(records[0].infraFailure.kind, "missing_transcript");
  assert.strictEqual(records[0].claudeExit, 0);
  assert.strictEqual(records[0].verifyExit, 0);
  assert.deepStrictEqual(records[0].claudeTokens.orchestrator, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0
  });
});

test("runner records verifier failure when the Claude session exits nonzero with a transcript", (t) => {
  const sandbox = makeSandbox(t);
  configureCondition(sandbox, "A");
  const result = runBench(sandbox, {
    condition: "A",
    repetition: 1,
    env: { FAKE_CLAUDE_MODE: "fail" }
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const records = readRecords(sandbox);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].condition, "A");
  assert.strictEqual(records[0].repetition, 1);
  assert.strictEqual(records[0].claudeExit, 1);
  assert.notStrictEqual(records[0].verifyExit, 0);
  assert.strictEqual(records[0].verdict, "fail");
  assert.strictEqual(records[0].peerTokens, null);
});

test("runner rejects stale routing rules in condition A", (t) => {
  const sandbox = makeSandbox(t);
  configureCondition(sandbox, "A", { rules: true });
  const result = runBench(sandbox, { condition: "A" });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /expected routingRulesPresent=false/);
});

test("runner rejects the legacy Codex plugin in condition B1", (t) => {
  const sandbox = makeSandbox(t);
  configureCondition(sandbox, "B1", { extraPlugins: ["codex@openai-codex"] });
  const result = runBench(sandbox, { condition: "B1" });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /codex@openai-codex/);
});

test("runner rejects condition B2 when the hosted Codex plugin is missing", (t) => {
  const sandbox = makeSandbox(t);
  configureCondition(sandbox, "B1", { extraPlugins: ["grok@claude-code-fusion"] });
  const result = runBench(sandbox, { condition: "B2" });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /Invalid B2 configuration/);
});

test("runner rejects condition B2 when old and new Codex plugins are both enabled", (t) => {
  const sandbox = makeSandbox(t);
  configureCondition(sandbox, "B2", { extraPlugins: ["codex@openai-codex"] });
  const result = runBench(sandbox, { condition: "B2" });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /codex@openai-codex/);
});

test("runner rejects a disabled legacy Codex installation in condition B2", (t) => {
  const sandbox = makeSandbox(t);
  configureCondition(sandbox, "B2", { installedExtra: ["codex@openai-codex"] });
  const result = runBench(sandbox, { condition: "B2" });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /codex@openai-codex/);
});

test("runner rejects a peer plugin in condition B3", (t) => {
  const sandbox = makeSandbox(t);
  configureCondition(sandbox, "B3", { extraPlugins: ["grok@claude-code-fusion"] });
  const result = runBench(sandbox, { condition: "B3" });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /grok@claude-code-fusion/);
});

test("runner writes env.json with manifest and cheap version capture", (t) => {
  const sandbox = makeSandbox(t);
  const binDir = path.join(sandbox.root, "bin");
  writeFakeVersionBin(binDir, "grok", "grok test 1.2.3");
  writeFakeVersionBin(binDir, "codex", "codex test 4.5.6");

  const result = runBench(sandbox, {
    env: {
      [claudePluginCacheDirEnv]: path.join(sandbox.root, "empty-plugin-cache"),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
    }
  });
  assert.strictEqual(result.status, 0, result.stderr);

  const env = JSON.parse(fs.readFileSync(sandbox.envFile, "utf8"));
  assert.match(env.date, /^\d{4}-\d{2}-\d{2}T/);
  assert.strictEqual(env.nodeVersion, process.version);
  assert.strictEqual(env.os.platform, process.platform);
  assert.strictEqual(typeof env.os.release, "string");
  assert.match(env.taskManifestHash, /^[0-9a-f]{64}$/);
  assert.strictEqual(env.manifestHash, env.taskManifestHash);
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"),
  );
  const fusionPlugin = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "plugins", "fusion", ".claude-plugin", "plugin.json"), "utf8"),
  );
  const grokPlugin = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "plugins", "grok", ".claude-plugin", "plugin.json"), "utf8"),
  );
  const codexPlugin = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "plugins", "codex", ".claude-plugin", "plugin.json"), "utf8"),
  );
  assert.strictEqual(env.pluginVersions["claude-code-fusion"], marketplace.version ?? marketplace.metadata?.version);
  assert.strictEqual(env.pluginVersions.fusion, fusionPlugin.version);
  assert.strictEqual(env.pluginVersions.grok, grokPlugin.version);
  assert.strictEqual(env.pluginVersions.codex, codexPlugin.version);
  assert.strictEqual(env.engineCliVersions.claude, null);
  assert.strictEqual(env.engineCliVersions.grok, "grok test 1.2.3");
  assert.strictEqual(env.engineCliVersions.codex, "codex test 4.5.6");
  assert.deepStrictEqual(env.taskTags, {
    [sandbox.taskId]: []
  });
});

test("runner records peerDefaults from seeded home configs", (t) => {
  const sandbox = makeSandbox(t);
  const home = sandbox.root;
  fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".grok", "config.toml"),
    [
      "[cli]",
      'installer = "internal"',
      "[models]",
      'default = "grok-4-flagship"',
      'default_reasoning_effort = "high"',
      'api_key = "should-not-leak"'
    ].join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(home, ".codex", "config.toml"),
    [
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "xhigh"',
      'api_key = "should-not-leak"',
      "approval_policy = \"never\""
    ].join("\n") + "\n",
    "utf8",
  );

  const result = runBench(sandbox, {
    env: {
      HOME: home,
      [claudePluginCacheDirEnv]: path.join(sandbox.root, "empty-plugin-cache")
    }
  });
  assert.strictEqual(result.status, 0, result.stderr);

  const records = readRecords(sandbox);
  assert.strictEqual(records.length, 1);
  assert.deepStrictEqual(records[0].peerDefaults, {
    grok: { model: "grok-4-flagship", effort: "high" },
    codex: { model: "gpt-5.6-sol", effort: "xhigh" }
  });
  const env = JSON.parse(fs.readFileSync(sandbox.envFile, "utf8"));
  assert.deepStrictEqual(env.peerDefaults, records[0].peerDefaults);
  assert.doesNotMatch(JSON.stringify(records[0]), /should-not-leak/);
  assert.doesNotMatch(JSON.stringify(env), /should-not-leak/);
});

test("runner records null peerDefaults when peer configs are missing", (t) => {
  const sandbox = makeSandbox(t);
  const result = runBench(sandbox, {
    env: {
      HOME: sandbox.root,
      [claudePluginCacheDirEnv]: path.join(sandbox.root, "empty-plugin-cache")
    }
  });
  assert.strictEqual(result.status, 0, result.stderr);

  const records = readRecords(sandbox);
  assert.strictEqual(records.length, 1);
  assert.deepStrictEqual(records[0].peerDefaults, {
    grok: { model: null, effort: null },
    codex: { model: null, effort: null }
  });
  const env = JSON.parse(fs.readFileSync(sandbox.envFile, "utf8"));
  assert.deepStrictEqual(env.peerDefaults, {
    grok: { model: null, effort: null },
    codex: { model: null, effort: null }
  });
});

test("runner scopes grok peerDefaults keys to the [models] table", (t) => {
  const sandbox = makeSandbox(t);
  const home = sandbox.root;
  fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".grok", "config.toml"),
    [
      "[cli]",
      'default = "should-not-win"',
      'default_reasoning_effort = "should-not-win"',
      "[models]",
      'default = "grok-from-models"',
      'default_reasoning_effort = "high"'
    ].join("\n") + "\n",
    "utf8",
  );

  const result = runBench(sandbox, {
    env: {
      HOME: home,
      [claudePluginCacheDirEnv]: path.join(sandbox.root, "empty-plugin-cache")
    }
  });
  assert.strictEqual(result.status, 0, result.stderr);

  const records = readRecords(sandbox);
  assert.strictEqual(records.length, 1);
  assert.deepStrictEqual(records[0].peerDefaults.grok, {
    model: "grok-from-models",
    effort: "high"
  });
});

test("runner captures grok effort alone when [models] default is absent", (t) => {
  const sandbox = makeSandbox(t);
  const home = sandbox.root;
  fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".grok", "config.toml"),
    [
      "[models]",
      'default_reasoning_effort = "medium"'
    ].join("\n") + "\n",
    "utf8",
  );

  const result = runBench(sandbox, {
    env: {
      HOME: home,
      [claudePluginCacheDirEnv]: path.join(sandbox.root, "empty-plugin-cache")
    }
  });
  assert.strictEqual(result.status, 0, result.stderr);

  const records = readRecords(sandbox);
  assert.strictEqual(records.length, 1);
  assert.deepStrictEqual(records[0].peerDefaults.grok, {
    model: null,
    effort: "medium"
  });
});

test("runner records the hosted Codex plugin version without a plugin cache", (t) => {
  const sandbox = makeSandbox(t);
  const emptyPluginCache = path.join(sandbox.root, "empty-plugin-cache");
  fs.mkdirSync(emptyPluginCache);

  const result = runBench(sandbox, {
    env: {
      [claudePluginCacheDirEnv]: emptyPluginCache
    }
  });
  assert.strictEqual(result.status, 0, result.stderr);

  const env = JSON.parse(fs.readFileSync(sandbox.envFile, "utf8"));
  const codexPlugin = JSON.parse(fs.readFileSync(path.join(repoRoot, "plugins", "codex", ".claude-plugin", "plugin.json"), "utf8"));
  assert.strictEqual(env.pluginVersions.codex, codexPlugin.version);
});

test("runner ignores stale external Codex plugin cache entries", (t) => {
  const sandbox = makeSandbox(t);
  const pluginCache = path.join(sandbox.root, "plugin-cache");
  writeCodexPlugin(pluginCache, "1.0.9");
  writeCodexPlugin(pluginCache, "1.0.10");

  const result = runBench(sandbox, {
    env: {
      [claudePluginCacheDirEnv]: pluginCache
    }
  });
  assert.strictEqual(result.status, 0, result.stderr);

  const env = JSON.parse(fs.readFileSync(sandbox.envFile, "utf8"));
  const codexPlugin = JSON.parse(fs.readFileSync(path.join(repoRoot, "plugins", "codex", ".claude-plugin", "plugin.json"), "utf8"));
  assert.strictEqual(env.pluginVersions.codex, codexPlugin.version);
});
