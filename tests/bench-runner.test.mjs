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
  return {
    root,
    taskRoot,
    taskId: "T01-test",
    resultsDir,
    claudeConfigDir,
    runsFile: path.join(resultsDir, "runs.jsonl"),
    envFile: path.join(resultsDir, "env.json"),
    fakeRunsFile: path.join(root, "fake-claude.jsonl")
  };
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
    detection: "filesystem",
    installedPlugins: ["fusion"],
    routingRulesPresent: false
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
  assert.strictEqual(env.pluginVersions["claude-code-fusion"], marketplace.metadata.version);
  assert.strictEqual(env.pluginVersions.fusion, fusionPlugin.version);
  assert.strictEqual(env.pluginVersions.grok, grokPlugin.version);
  assert.strictEqual(env.pluginVersions.codex, null);
  assert.strictEqual(env.engineCliVersions.claude, null);
  assert.strictEqual(env.engineCliVersions.grok, "grok test 1.2.3");
  assert.strictEqual(env.engineCliVersions.codex, "codex test 4.5.6");
  assert.deepStrictEqual(env.taskTags, {
    [sandbox.taskId]: []
  });
});

test("runner records null codex plugin version when the plugin cache is empty", (t) => {
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
  assert.strictEqual(env.pluginVersions.codex, null);
});

test("runner records the newest installed codex plugin version from the plugin cache", (t) => {
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
  assert.strictEqual(env.pluginVersions.codex, "1.0.10");
});
