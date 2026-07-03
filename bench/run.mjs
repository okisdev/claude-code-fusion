#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);
const BENCH_DIR = path.dirname(SELF_PATH);
const DEFAULT_TASK_ROOT = path.join(BENCH_DIR, "tasks");
const CONDITIONS = new Set(["A", "B1", "B2"]);
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
  return workDir;
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

function aggregateClaudeTokens(headlessOutput, mainTranscript, subagentTranscripts) {
  const tokens = {
    orchestrator: emptyTokens(),
    subagents: emptyTokens(),
    byModel: {}
  };
  for (const entry of collectUsageEntries(headlessOutput)) {
    addUsage(tokens, "orchestrator", entry);
  }
  let delegationCount = 0;
  const transcriptSets = [
    { file: mainTranscript, subagentFile: false },
    ...subagentTranscripts.map((file) => ({ file, subagentFile: true }))
  ];
  for (const transcript of transcriptSets) {
    const records = readJsonl(transcript.file);
    for (const record of records) {
      const sidechain = transcript.subagentFile || isSidechainRecord(record);
      const role = sidechain ? "subagents" : "orchestrator";
      for (const entry of collectUsageEntries(record)) {
        addUsage(tokens, role, entry);
      }
      if (!sidechain && !transcript.subagentFile) {
        delegationCount += countAgentToolUses(record);
      }
    }
  }
  return { tokens, delegationCount };
}

function oneLine(value) {
  return String(value ?? "Benchmark runner failed.").replace(/\s+/g, " ").trim();
}

async function main() {
  const options = normalizeOptions(parseArgs(process.argv.slice(2)));
  const task = resolveTask(options.taskRoot, options.taskId);
  const brief = fs.readFileSync(task.briefFile, "utf8");
  const workDir = copyFixtures(task.fixturesDir);
  const claudeArgs = ["-p", brief, "--output-format", "json"];
  const claudeEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: options.claudeConfigDir
  };
  const transcriptStartedAtMs = Date.now();
  const wallStart = performance.now();
  const claudeResult = await runProcess(options.claudeBin, claudeArgs, {
    cwd: workDir,
    env: claudeEnv,
    label: "Claude"
  });
  const verifyResult = await runProcess("bash", ["verify.sh", workDir], {
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
  const record = {
    taskId: options.taskId,
    condition: options.condition,
    repetition: options.repetition,
    verifyExit: verifyResult.exitCode,
    wallClockSeconds,
    claudeTokens: tokens,
    peerTokens: options.condition === "B2" ? { grok: null, codex: null } : null,
    delegationCount,
    resumeCount: 0,
    escalationCount: 0,
    excluded: false,
    excludedReason: null
  };
  fs.mkdirSync(options.resultsDir, { recursive: true });
  fs.appendFileSync(path.join(options.resultsDir, "runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${oneLine(error.message)}\n`);
  process.exit(1);
});
