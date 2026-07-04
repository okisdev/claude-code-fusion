#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { buildManifest } from "./manifest.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const BENCH_DIR = path.dirname(SELF_PATH);
const REPO_ROOT = path.dirname(BENCH_DIR);
const DEFAULT_TASK_ROOT = path.join(BENCH_DIR, "tasks");
const CONDITIONS = new Set(["A", "B1", "B2"]);
const CLI_VERSION_TIMEOUT_MS = 2000;
const PLUGIN_VERSION_FILES = [
  { name: "fusion", file: path.join(REPO_ROOT, "plugins", "fusion", ".claude-plugin", "plugin.json") },
  { name: "grok", file: path.join(REPO_ROOT, "plugins", "grok", ".claude-plugin", "plugin.json") },
  { name: "codex", file: path.join(REPO_ROOT, "plugins", "codex", ".claude-plugin", "plugin.json") }
];
const TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "input",
  "output",
  "cacheRead",
  "cacheCreation",
  "prompt_tokens",
  "completion_tokens"
];

function emptyTokens() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

function required(options, key) {
  const value = options[key];
  if (!value) {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
}

function normalizeOptions(raw) {
  const taskId = required(raw, "task");
  const condition = required(raw, "condition");
  if (!CONDITIONS.has(condition)) {
    throw new Error(`Invalid condition: ${condition}`);
  }
  const repetition = Number(required(raw, "repetition"));
  if (!Number.isInteger(repetition) || repetition < 1) {
    throw new Error(`Invalid repetition: ${raw.repetition}`);
  }
  return {
    taskId,
    condition,
    repetition,
    resultsDir: path.resolve(required(raw, "results")),
    claudeConfigDir: path.resolve(required(raw, "claude-config")),
    taskRoot: path.resolve(raw["task-root"] ?? DEFAULT_TASK_ROOT),
    claudeBin: raw["claude-bin"] ?? process.env.CLAUDE_BIN ?? "claude"
  };
}

function resolveTask(taskRoot, taskId) {
  const taskDir = path.resolve(taskRoot, taskId);
  const relative = path.relative(taskRoot, taskDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Task escapes task root: ${taskId}`);
  }
  if (!fs.existsSync(taskDir) || !fs.statSync(taskDir).isDirectory()) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const briefFile = path.join(taskDir, "brief.md");
  const verifyFile = path.join(taskDir, "verify.sh");
  const fixturesDir = path.join(taskDir, "fixtures");
  if (!fs.existsSync(briefFile) || !fs.statSync(briefFile).isFile()) {
    throw new Error(`Task brief not found: ${taskId}`);
  }
  if (!fs.existsSync(verifyFile) || !fs.statSync(verifyFile).isFile()) {
    throw new Error(`Task verifier not found: ${taskId}`);
  }
  if (!fs.existsSync(fixturesDir) || !fs.statSync(fixturesDir).isDirectory()) {
    throw new Error(`Task fixtures not found: ${taskId}`);
  }
  return { taskDir, briefFile, fixturesDir };
}

function copyFixtures(fixturesDir) {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-bench-")));
  const workDir = path.join(tempRoot, "work");
  fs.cpSync(fixturesDir, workDir, { recursive: true });
  return { tempRoot, workDir };
}

function cleanupTempRoot(tempRoot) {
  if (!tempRoot) {
    return;
  }
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
  }
}

function signalExitCode(signal) {
  if (signal === "SIGINT") {
    return 130;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  return 1;
}

function runProcess(bin, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error.code === "ENOENT") {
        reject(new Error(`${options.label} binary not found: ${bin}`));
        return;
      }
      reject(new Error(`${options.label} failed to start: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        stdout,
        stderr,
        exitCode: code ?? signalExitCode(signal),
        signal
      });
    });
  });
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function collectPluginVersions() {
  const versions = {};
  const marketplace = readJsonFile(path.join(REPO_ROOT, ".claude-plugin", "marketplace.json"));
  versions["claude-code-fusion"] = typeof marketplace?.metadata?.version === "string" ? marketplace.metadata.version : null;
  for (const source of PLUGIN_VERSION_FILES) {
    const plugin = readJsonFile(source.file);
    versions[source.name] = typeof plugin?.version === "string" ? plugin.version : null;
  }
  return versions;
}

function hasPathSeparator(bin) {
  return bin.includes("/") || (path.sep === "\\" && bin.includes("\\"));
}

function commandOnPath(bin) {
  if (hasPathSeparator(bin)) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathValue = process.env.PATH ?? "";
  return pathValue.split(path.delimiter).some((entry) => {
    if (!entry) {
      return false;
    }
    try {
      fs.accessSync(path.join(entry, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function cliVersion(bin) {
  if (!commandOnPath(bin)) {
    return null;
  }
  const result = spawnSync(bin, ["--version"], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: "utf8",
    timeout: CLI_VERSION_TIMEOUT_MS
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return text ? text.split(/\r?\n/)[0].trim() : null;
}

function collectEngineCliVersions(options) {
  return {
    claude: cliVersion(options.claudeBin),
    grok: cliVersion("grok"),
    codex: cliVersion("codex")
  };
}

function scanConfigNames(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const names = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > 4) {
      continue;
    }
    const entries = fs.readdirSync(current.dir, { withFileTypes: true });
    for (const entry of entries) {
      names.push(entry.name);
      if (entry.isDirectory()) {
        stack.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  }
  return names;
}

function detectConditionNotes(claudeConfigDir) {
  const names = scanConfigNames(claudeConfigDir).map((name) => name.toLowerCase());
  const installedPlugins = ["claude-code-fusion", "fusion", "grok", "codex"].filter((plugin) => names.some((name) => name.includes(plugin)));
  return {
    detection: "filesystem",
    installedPlugins,
    routingRulesPresent: fs.existsSync(path.join(claudeConfigDir, "rules", "orchestration.md"))
  };
}

function taskTags(manifest) {
  return Object.fromEntries(manifest.tasks.map((task) => [task.id, Array.isArray(task.tags) ? task.tags : []]));
}

function writeEnv(options, manifest) {
  const env = {
    date: new Date().toISOString(),
    nodeVersion: process.version,
    os: {
      platform: os.platform(),
      release: os.release()
    },
    pluginVersions: collectPluginVersions(),
    engineCliVersions: collectEngineCliVersions(options),
    taskManifestHash: manifest.manifestHash,
    manifestHash: manifest.manifestHash,
    taskTags: taskTags(manifest)
  };
  fs.mkdirSync(options.resultsDir, { recursive: true });
  fs.writeFileSync(path.join(options.resultsDir, "env.json"), `${JSON.stringify(env, null, 2)}\n`, "utf8");
  return env;
}

function tryParseObject(text) {
  if (!text || !text.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseHeadlessOutput(stdout) {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const whole = tryParseObject(trimmed);
  if (whole) {
    return whole;
  }
  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = tryParseObject(lines[index].trim());
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function findSessionId(value, seen = new Set()) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);
  for (const key of ["session_id", "sessionId", "sessionID"]) {
    if (typeof value[key] === "string" && value[key]) {
      return value[key];
    }
  }
  for (const nested of Object.values(value)) {
    const sessionId = findSessionId(nested, seen);
    if (sessionId) {
      return sessionId;
    }
  }
  return null;
}

function listJsonlFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  }
  return files.sort();
}

function locateTranscript(claudeConfigDir, sessionId) {
  const projectsDir = path.join(claudeConfigDir, "projects");
  const files = listJsonlFiles(projectsDir);
  if (sessionId) {
    const exact = files.filter((file) => path.basename(file) === `${sessionId}.jsonl`);
    if (exact.length === 1) {
      return { mainTranscript: exact[0], files };
    }
    if (exact.length > 1) {
      throw new Error(`Claude transcript is ambiguous for session ${sessionId}`);
    }
  }
  if (files.length === 1) {
    return { mainTranscript: files[0], files };
  }
  throw new Error(`Claude transcript cannot be located for session ${sessionId ?? "unknown"}`);
}

function readJsonl(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`Invalid transcript JSON in ${file}`);
    }
  }
  return records;
}

function numberFrom(value, keys) {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return 0;
}

function looksLikeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return TOKEN_FIELDS.some((field) => typeof value[field] === "number" && Number.isFinite(value[field]));
}

function tokensFromUsage(usage) {
  return {
    input: numberFrom(usage, ["input_tokens", "input", "prompt_tokens"]),
    output: numberFrom(usage, ["output_tokens", "output", "completion_tokens"]),
    cacheRead: numberFrom(usage, ["cache_read_input_tokens", "cacheRead"]),
    cacheCreation: numberFrom(usage, ["cache_creation_input_tokens", "cacheCreation"])
  };
}

function addTokenCounts(target, counts) {
  target.input += counts.input;
  target.output += counts.output;
  target.cacheRead += counts.cacheRead;
  target.cacheCreation += counts.cacheCreation;
}

function hasTokens(counts) {
  return counts.input !== 0 || counts.output !== 0 || counts.cacheRead !== 0 || counts.cacheCreation !== 0;
}

function collectUsageEntries(value, context = {}, entries = [], seen = new Set()) {
  if (!value || typeof value !== "object") {
    return entries;
  }
  if (seen.has(value)) {
    return entries;
  }
  seen.add(value);
  const model = typeof value.model === "string" && value.model ? value.model : context.model;
  if (looksLikeUsage(value)) {
    entries.push({ usage: value, model });
    return entries;
  }
  if (looksLikeUsage(value.usage)) {
    const usageModel = typeof value.usage.model === "string" && value.usage.model ? value.usage.model : model;
    entries.push({ usage: value.usage, model: usageModel });
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === "usage") {
      continue;
    }
    collectUsageEntries(nested, { model }, entries, seen);
  }
  return entries;
}

function addUsage(tokens, role, entry) {
  const counts = tokensFromUsage(entry.usage);
  if (!hasTokens(counts)) {
    return;
  }
  addTokenCounts(tokens[role], counts);
  const model = entry.model || "unknown";
  tokens.byModel[model] ??= emptyTokens();
  addTokenCounts(tokens.byModel[model], counts);
}

function isSidechainRecord(record) {
  return record?.isSidechain === true || record?.is_sidechain === true || record?.message?.isSidechain === true;
}

function countAgentToolUses(value, seen = new Set()) {
  if (!value || typeof value !== "object") {
    return 0;
  }
  if (seen.has(value)) {
    return 0;
  }
  seen.add(value);
  let count = value.type === "tool_use" && value.name === "Agent" ? 1 : 0;
  for (const nested of Object.values(value)) {
    count += countAgentToolUses(nested, seen);
  }
  return count;
}

function recentSubagentTranscripts(files, mainTranscript, startedAtMs) {
  return files.filter((file) => {
    if (file === mainTranscript) {
      return false;
    }
    return fs.statSync(file).mtimeMs >= startedAtMs - 1000;
  });
}

function recordSourceId(record) {
  return record?.message?.id ?? record?.uuid ?? null;
}

function aggregateClaudeTokens(headlessOutput, mainTranscript, subagentTranscripts) {
  const tokens = {
    orchestrator: emptyTokens(),
    subagents: emptyTokens(),
    byModel: {}
  };
  let delegationCount = 0;
  let transcriptUsageRecordCount = 0;
  const seenSourceIds = new Set();
  const transcriptSets = [
    { file: mainTranscript, subagentFile: false },
    ...subagentTranscripts.map((file) => ({ file, subagentFile: true }))
  ];
  for (const transcript of transcriptSets) {
    const records = readJsonl(transcript.file);
    for (const record of records) {
      const sidechain = transcript.subagentFile || isSidechainRecord(record);
      const role = sidechain ? "subagents" : "orchestrator";
      if (!sidechain && !transcript.subagentFile) {
        delegationCount += countAgentToolUses(record);
      }
      const entries = collectUsageEntries(record);
      if (entries.length === 0) {
        continue;
      }
      const sourceId = recordSourceId(record);
      if (sourceId !== null) {
        if (seenSourceIds.has(sourceId)) {
          continue;
        }
        seenSourceIds.add(sourceId);
      }
      for (const entry of entries) {
        addUsage(tokens, role, entry);
        transcriptUsageRecordCount += 1;
      }
    }
  }
  if (transcriptUsageRecordCount === 0) {
    for (const entry of collectUsageEntries(headlessOutput)) {
      addUsage(tokens, "orchestrator", entry);
    }
  }
  return { tokens, delegationCount };
}

function oneLine(value) {
  return String(value ?? "Benchmark runner failed.").replace(/\s+/g, " ").trim();
}

function peerTokensFor(condition) {
  return condition === "B2" ? { grok: null, codex: null } : null;
}

function verdictFromVerify(verifyExit) {
  return verifyExit === 0 ? "pass" : "fail";
}

function classifyInfraFailure(error) {
  const message = oneLine(error?.message);
  if (/ambiguous/i.test(message) && /transcript/i.test(message)) {
    return "ambiguous_transcript";
  }
  if (/transcript/i.test(message)) {
    return "missing_transcript";
  }
  if (/Claude binary not found|Claude failed to start/.test(message)) {
    return "claude_start_failure";
  }
  if (/Verifier binary not found|Verifier failed to start/.test(message)) {
    return "verifier_start_failure";
  }
  if (/Task .*not found|Task .*escapes|Task .*fixtures|Task .*brief|Task .*verifier/.test(message)) {
    return "task_setup_failure";
  }
  return "runner_failure";
}

function buildRecord(options, context) {
  return {
    runId: context.runId,
    taskId: options.taskId,
    condition: options.condition,
    repetition: options.repetition,
    startedAt: context.startedAt,
    finishedAt: new Date().toISOString(),
    taskManifestHash: context.taskManifestHash,
    conditionNotes: context.conditionNotes,
    claudeExit: context.claudeExit,
    verifyExit: context.verifyExit,
    wallClockSeconds: context.wallClockSeconds,
    verdict: context.verdict,
    infraFailure: context.infraFailure,
    claudeTokens: context.claudeTokens,
    peerTokens: peerTokensFor(options.condition),
    delegationCount: context.delegationCount,
    resumeCount: 0,
    escalationCount: 0,
    excluded: false,
    excludedReason: null
  };
}

function appendRecord(resultsDir, record) {
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.appendFileSync(path.join(resultsDir, "runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function infraRecord(options, context, error) {
  return buildRecord(options, {
    ...context,
    verdict: "infra_failure",
    infraFailure: {
      kind: classifyInfraFailure(error),
      message: oneLine(error?.message)
    },
    claudeTokens: context.claudeTokens ?? {
      orchestrator: emptyTokens(),
      subagents: emptyTokens(),
      byModel: {}
    },
    delegationCount: context.delegationCount ?? 0
  });
}

async function executeAttempt(options, context) {
  const task = resolveTask(options.taskRoot, options.taskId);
  const brief = fs.readFileSync(task.briefFile, "utf8");
  const { tempRoot, workDir } = copyFixtures(task.fixturesDir);
  const claudeArgs = ["-p", brief, "--output-format", "json"];
  const claudeEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: options.claudeConfigDir
  };
  const transcriptStartedAtMs = Date.now();
  const wallStart = performance.now();
  let claudeResult = null;
  let verifyResult = null;
  try {
    claudeResult = await runProcess(options.claudeBin, claudeArgs, {
      cwd: workDir,
      env: claudeEnv,
      label: "Claude"
    });
    verifyResult = await runProcess("bash", ["verify.sh", workDir], {
      cwd: task.taskDir,
      env: process.env,
      label: "Verifier"
    });
    const wallClockSeconds = (performance.now() - wallStart) / 1000;
    const headlessOutput = parseHeadlessOutput(claudeResult.stdout);
    const sessionId = findSessionId(headlessOutput);
    const { mainTranscript, files } = locateTranscript(options.claudeConfigDir, sessionId);
    const subagentTranscripts = recentSubagentTranscripts(files, mainTranscript, transcriptStartedAtMs);
    const { tokens, delegationCount } = aggregateClaudeTokens(headlessOutput, mainTranscript, subagentTranscripts);
    return buildRecord(options, {
      ...context,
      claudeExit: claudeResult.exitCode,
      verifyExit: verifyResult.exitCode,
      wallClockSeconds,
      verdict: verdictFromVerify(verifyResult.exitCode),
      infraFailure: null,
      claudeTokens: tokens,
      delegationCount
    });
  } catch (error) {
    const wallClockSeconds = (performance.now() - wallStart) / 1000;
    return infraRecord(
      options,
      {
        ...context,
        claudeExit: claudeResult?.exitCode ?? null,
        verifyExit: verifyResult?.exitCode ?? null,
        wallClockSeconds
      },
      error
    );
  } finally {
    cleanupTempRoot(tempRoot);
  }
}

async function main() {
  let options;
  try {
    options = normalizeOptions(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${oneLine(error.message)}\n`);
    process.exitCode = 1;
    return;
  }

  const manifest = buildManifest(options.taskRoot);
  writeEnv(options, manifest);
  const context = {
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    taskManifestHash: manifest.manifestHash,
    conditionNotes: detectConditionNotes(options.claudeConfigDir),
    claudeExit: null,
    verifyExit: null,
    wallClockSeconds: 0,
    claudeTokens: null,
    delegationCount: 0
  };
  const record = await executeAttempt(options, context);
  appendRecord(options.resultsDir, record);
  if (record.verdict === "infra_failure") {
    process.stderr.write(`${record.infraFailure.message}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${oneLine(error.message)}\n`);
  process.exit(1);
});
