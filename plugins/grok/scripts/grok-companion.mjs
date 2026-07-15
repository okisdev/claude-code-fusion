#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import {
  buildGrokArgs,
  formatBlockedPermissionCall,
  resolveGrokBin,
  resolveTimeoutMs,
  sandboxProfileForMode,
  recordedProcessGroupsClean,
  runGrok,
  runningJobLiveness,
  terminateProcessGroup,
  terminateRecordedProcessGroups,
  terminateRecordedProcessGroupsSync
} from "./lib/grok-exec.mjs";
import { getProcessIdentity } from "./lib/process-identity.mjs";
import {
  extractFirstJsonObject,
  renderBackgroundLaunch,
  renderCancelReport,
  renderJobDetail,
  renderReviewFallback,
  renderReviewResult,
  renderSetupReport,
  renderStatsReport,
  renderStatusTable,
  renderTaskResult,
  validateReviewOutput
} from "./lib/render.mjs";
import {
  SESSION_ID_ENV,
  briefPath,
  claimResumeSessionLease,
  createJobRecord,
  createJobRecordFile,
  findJobRecordById,
  generateJobId,
  jobFilePath,
  jobLogPath,
  launchRunningJobProcess,
  listAllJobRecords,
  listJobRecords,
  markManagedDeliveryCollectedFile,
  nowIso,
  readJobRecordFile,
  readLogTail,
  resolveDataDir,
  updateJobRecordFile,
  updateJobRecordFileWithCurrent,
  finishSuccessfulJobRecordFile,
  writeBrief,
  appendJobLog
} from "./lib/state.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SELF_PATH), "..");
const REVIEW_PROMPT_FILE = path.join(ROOT_DIR, "prompts", "review.md");
const STOP_GATE_PROMPT_FILE = path.join(ROOT_DIR, "prompts", "stop-gate.md");
const STOP_GATE_OPTION_ENV = "CLAUDE_PLUGIN_OPTION_STOP_GATE";
const STOP_GATE_TIMEOUT_MS = 240000;
const STOP_GATE_MAX_TURNS = 15;
const WAIT_POLL_ENV = "GROK_COMPANION_WAIT_POLL_MS";
const WAIT_TIMEOUT_ENV = "GROK_COMPANION_WAIT_TIMEOUT_MS";
const BACKGROUND_DELIVERY_ENV = "GROK_COMPANION_BACKGROUND_DELIVERY";
const DEFAULT_WAIT_POLL_MS = 2000;
const DEFAULT_WAIT_TIMEOUT_MS = 570000;
const MAX_WAIT_TIMEOUT_MS = 570000;
const CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/grok-companion.mjs task [prompt] [--prompt-file <path>] [--write] [--web] [--background] [--resume <uuid>] [--resume-last] [--model <id>] [--effort <level>] [--max-turns <n>] [--best-of-n <n>] [--cwd <dir>] [--json]",
      "  node scripts/grok-companion.mjs review [--base <ref>] [--focus <text>] [--cwd <dir>] [--background] [--json]",
      "  node scripts/grok-companion.mjs status [job-id] [--cwd <dir>] [--json]",
      "  node scripts/grok-companion.mjs result <job-id> [--cwd <dir>] [--wait] [--wait-timeout-ms <ms>] [--json]",
      "  node scripts/grok-companion.mjs cancel <job-id> [--cwd <dir>] [--json]",
      "  node scripts/grok-companion.mjs stats [--all] [--cwd <dir>] [--json]",
      "  node scripts/grok-companion.mjs setup [--enable-stop-gate] [--disable-stop-gate] [--json]",
      "  node scripts/grok-companion.mjs stop-gate"
    ].join("\n")
  );
}

function output(value, asJson) {
  const text = asJson ? `${JSON.stringify(value, null, 2)}\n` : String(value);
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(process.stdout.fd, buffer, offset, buffer.length - offset);
    if (written <= 0) {
      throw new Error("Unable to write the Grok companion result to stdout.");
    }
    offset += written;
  }
}

function errorWithFailure(message, failureKind) {
  const error = new Error(message);
  error.failureKind = failureKind;
  return error;
}

function oneLineSummary(value, fallback = "Grok companion failed.") {
  const line = String(value ?? "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return line || fallback;
}

function boundedTextTail(value, maxLines = 20) {
  return String(value ?? "")
    .slice(-64 * 1024)
    .trimEnd()
    .split(/\r?\n/)
    .slice(-maxLines)
    .join("\n");
}

function failureOutcomeMessage({ message, detail, jobId, status = "error", failureKind = "error" }) {
  const lines = [String(message ?? "").trim() || "Grok companion failed."];
  const diagnostic = String(detail ?? "").trim();
  if (diagnostic && diagnostic !== lines[0]) {
    lines.push("", diagnostic);
  }
  if (jobId) {
    lines.push("", `job: ${jobId}`);
  }
  lines.push(`state: ${status}`, `failure: ${failureKind}`);
  return lines.join("\n");
}

function resolveCwd(options) {
  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  let stats;
  try {
    stats = fs.statSync(cwd);
  } catch {
    throw errorWithFailure(`Working directory does not exist: ${cwd}.`, "input");
  }
  if (!stats.isDirectory()) {
    throw errorWithFailure(`Working directory is not a directory: ${cwd}.`, "input");
  }
  return cwd;
}

function findRequestedJobRecord(dataDir, jobId, options) {
  if (options.cwd === undefined) {
    return findJobRecordById(dataDir, jobId);
  }
  const cwd = resolveCwd(options);
  const file = jobFilePath(dataDir, cwd, jobId);
  const record = readJobRecordFile(file);
  return record?.id === jobId ? { record, file } : null;
}

function currentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function configFilePath(dataDir) {
  return path.join(dataDir, "config.json");
}

function readConfig(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFilePath(dataDir), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeConfig(dataDir, patch) {
  const next = { ...readConfig(dataDir), ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configFilePath(dataDir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function isStopGateEnabled(dataDir, env = process.env) {
  const raw = env[STOP_GATE_OPTION_ENV];
  if (raw !== undefined) {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  return Boolean(readConfig(dataDir).stopGate);
}

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer for ${flag}.`);
  }
  return parsed;
}

function parseNonnegativeInteger(value, flag) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer for ${flag}.`);
  }
  return parsed;
}

function parseBestOfN(value) {
  const parsed = parsePositiveInteger(value, "--best-of-n");
  if (parsed < 2 || parsed > 10) {
    throw new Error("Expected --best-of-n between 2 and 10.");
  }
  return parsed;
}

function resolveWaitPollMs(env = process.env) {
  const raw = Number(env[WAIT_POLL_ENV]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_WAIT_POLL_MS;
}

function resolveWaitTimeoutMs(options = {}, env = process.env) {
  if (options["wait-timeout-ms"] !== undefined) {
    return Math.min(parseNonnegativeInteger(options["wait-timeout-ms"], "--wait-timeout-ms"), MAX_WAIT_TIMEOUT_MS);
  }
  const value = env[WAIT_TIMEOUT_ENV];
  const raw = Number(value);
  const configured =
    value !== undefined && String(value).trim() && Number.isFinite(raw) && raw >= 0
      ? Math.floor(raw)
      : DEFAULT_WAIT_TIMEOUT_MS;
  return Math.min(configured, MAX_WAIT_TIMEOUT_MS);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readStdinIfPiped() {
  if (isatty(0)) {
    return "";
  }
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  for (;;) {
    let bytes;
    try {
      bytes = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error.code === "EAGAIN") {
        sleepMs(20);
        continue;
      }
      break;
    }
    if (bytes === 0) {
      break;
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytes)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readTaskPrompt(cwd, options, positionals) {
  const positionalPrompt = positionals.join(" ").trim();
  if (positionalPrompt) {
    return positionalPrompt;
  }
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8").trim();
  }
  return readStdinIfPiped().trim();
}

function backgroundDelivery(env = process.env) {
  return env[BACKGROUND_DELIVERY_ENV] === "managed" ? "managed" : "manual";
}

function waitForChildSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function spawnBackgroundWorker(args, jobFile) {
  let child = null;
  let identity = null;
  try {
    const launched = launchRunningJobProcess(
      jobFile,
      () => {
        child = spawn(process.execPath, args, {
          detached: true,
          stdio: "ignore"
        });
        identity = Number.isInteger(child.pid) ? getProcessIdentity(child.pid) : null;
        return { child, pid: child.pid ?? null, identity };
      },
      { processRole: "worker" }
    );
    child = launched.child ?? child;
    identity = launched.identity ?? identity;
    await waitForChildSpawn(child);
    child.unref();
    return child;
  } catch (error) {
    if (Number.isInteger(child?.pid) && child.pid > 1) {
      const cleaned = await terminateProcessGroup(
        child.pid,
        identity ? { identity } : {}
      ).catch(() => false);
      if (!cleaned) {
        const cleanupError = new Error("Verified background worker cleanup did not complete after launch failed.");
        cleanupError.failureKind = error?.failureKind ?? "error";
        cleanupError.cleanupRequired = true;
        cleanupError.processRole = "worker";
        cleanupError.pid = child.pid;
        cleanupError.pidIdentity = identity;
        child.unref();
        throw cleanupError;
      }
    }
    throw error;
  }
}

function inputError(message) {
  const error = new Error(message);
  error.failureKind = "input";
  return error;
}

function resumableJobs(dataDir, cwd, mode) {
  const sandboxProfile = sandboxProfileForMode(mode);
  return listJobRecords(dataDir, cwd).filter(
    (job) =>
      job.status !== "running" &&
      job.sessionId &&
      job.mode === mode &&
      job.request?.sandboxProfile === sandboxProfile
  );
}

export function resolveLastSessionId(dataDir, cwd, claudeSessionId, mode = "consult") {
  const finished = resumableJobs(dataDir, cwd, mode)
    .sort((left, right) =>
      String(right.finishedAt ?? right.createdAt ?? "").localeCompare(
        String(left.finishedAt ?? left.createdAt ?? "")
      )
    );
  if (claudeSessionId) {
    const owned = finished.filter((job) => job.claudeSessionId === claudeSessionId);
    if (owned.length === 0) {
      throw inputError(`No finished ${mode} grok job with a compatible sandbox was found for Claude session ${claudeSessionId} in this workspace.`);
    }
    return owned[0].sessionId;
  }
  if (finished.length === 0) {
    throw inputError(`No finished ${mode} grok job with a compatible sandbox was found for this workspace.`);
  }
  return finished[0].sessionId;
}

export function validateResumeSessionId(dataDir, cwd, sessionId, mode) {
  const jobs = listJobRecords(dataDir, cwd).filter(
    (job) => job.status !== "running" && job.sessionId === sessionId
  );
  if (jobs.some((job) => job.mode === mode && job.request?.sandboxProfile === sandboxProfileForMode(mode))) {
    return sessionId;
  }
  if (jobs.length > 0) {
    throw inputError(`Grok session ${sessionId} cannot resume in ${mode} mode because its recorded sandbox profile is incompatible. Start a fresh task.`);
  }
  throw inputError(`No finished companion job owns Grok session ${sessionId} in this workspace.`);
}

const PERMISSION_FAILURE_MESSAGE =
  "Grok's turn was cancelled by the consult-mode permission gate (a tool call outside the hard read-only tool set). Re-dispatch with --write if repository changes or command execution are acceptable, or rewrite the brief to use file reading and search only.";

function isPermissionCancelled(result) {
  return Boolean(result) && result.exitCode === 0 && !result.timedOut && result.stopReason === "Cancelled";
}

function permissionFailureMessage(result) {
  return PERMISSION_FAILURE_MESSAGE + formatBlockedPermissionCall(result?.blockedPermissionCall ?? null);
}

function grokFailureMessage(result, timeoutMs, failureKind) {
  if (failureKind === "permission") {
    return permissionFailureMessage(result);
  }
  if (result.parseError) {
    return result.parseError;
  }
  if (result.errorMessage) {
    return result.errorMessage;
  }
  return result.timedOut
    ? `Grok timed out after ${timeoutMs}ms and was terminated.`
    : `Grok exited with code ${result.exitCode}.`;
}

const STDERR_FAILURE_KINDS = [
  [
    "quota",
    /quota|insufficient (?:account )?(?:balance|credit|credits|funds)|balance (?:is )?exhausted|exhausted (?:account )?balance|payment required|usage limit|billing|credit limit|http(?:\/\d(?:\.\d)?)?\s+402|status(?: code)?\s*[:=]?\s*402/i
  ],
  ["rate_limited", /rate.?limit|429|too many requests/i],
  ["auth", /auth|unauthori[sz]ed|forbidden|login required/i]
];

function classifyFailure({ spawnError = null, result = null, logTail = "" } = {}) {
  if (spawnError?.failureKind) {
    return spawnError.failureKind;
  }
  if (spawnError?.code === "ENOENT") {
    return "missing_cli";
  }
  if (result?.timedOut) {
    return "timeout";
  }
  if (result?.cancelledByCompanion) {
    return "cancelled";
  }
  if (isPermissionCancelled(result)) {
    return "permission";
  }
  const tail = String(logTail ?? "");
  for (const [kind, pattern] of STDERR_FAILURE_KINDS) {
    if (pattern.test(tail)) {
      return kind;
    }
  }
  return "error";
}

function finishJobRecord(jobFile, patch) {
  const current = readJobRecordFile(jobFile);
  if (current?.status === "done" || current?.status === "error" || current?.status === "cancelled") {
    return current;
  }
  return updateJobRecordFile(jobFile, patch);
}

function deadProcessMessage(deadPids) {
  if (deadPids.length === 0) {
    return "No process id was recorded before the launch grace window elapsed.";
  }
  const label = deadPids.length === 1 ? "pid" : "pids";
  return `Recorded ${label} ${deadPids.join(", ")} exited without recording an outcome.`;
}

function cleanupRequiredPatch(current, failureKind, message) {
  return {
    ...current,
    cleanupRequired: true,
    errorMessage: message,
    errorTail: message,
    failureKind
  };
}

function finishDiedJobRecord(file) {
  const observed = readJobRecordFile(file);
  if (!observed || observed.status !== "running") {
    return observed;
  }
  const observedLiveness = runningJobLiveness(observed);
  if (observedLiveness.alive && !observed.cleanupRequired) {
    return observed;
  }
  const terminated = terminateRecordedProcessGroupsSync(observed);
  return updateJobRecordFileWithCurrent(file, (current) => {
    if (current.status !== "running") {
      return current;
    }
    const liveness = runningJobLiveness(current);
    if (liveness.alive && !current.cleanupRequired) {
      return current;
    }
    if (!terminated || !recordedProcessGroupsClean(current)) {
      return cleanupRequiredPatch(current, current.cancelRequestedAt ? "cancelled" : "died", "The recorded processes exited without a terminal outcome, but verified process cleanup did not complete.");
    }
    const cancelled = current.cancelRequestedAt != null;
    const message = cancelled ? current.errorMessage ?? "The Grok job was cancelled." : deadProcessMessage(liveness.deadPids);
    const status = cancelled ? "cancelled" : "error";
    const failureKind = cancelled ? "cancelled" : "died";
    return {
      ...current,
      status,
      finishedAt: nowIso(),
      resultPayload: retainedResultPayload(
        current,
        failureResultPayload(current, {
          status,
          failureKind,
          message: failureOutcomeMessage({ message, jobId: current.id, status, failureKind })
        })
      ),
      errorMessage: message,
      errorTail: message,
      failureKind,
      cancelRequestedAt: null
    };
  });
}

export function refreshRunningJobRecord({ record, file }) {
  const current = readJobRecordFile(file) ?? record;
  const liveness = runningJobLiveness(current);
  if (liveness.alive) {
    return { record: current, changed: false };
  }
  const next = finishDiedJobRecord(file);
  return { record: next, changed: next?.status !== "running" };
}

function resultFailed(result) {
  return Boolean(result.parseError) || Boolean(result.errorMessage) || result.exitCode !== 0 || result.timedOut || isPermissionCancelled(result);
}

function failureTail(logFile, result) {
  const tail = readLogTail(logFile, 20);
  const stdoutDiagnostic = result?.errorMessage || (result?.parseError ? result.stdoutTail : "");
  if (!stdoutDiagnostic) {
    return tail;
  }
  return [tail, result?.parseError ? "Stdout tail:" : "", stdoutDiagnostic].filter(Boolean).join("\n");
}

const TOKEN_USAGE_FIELDS = {
  inputTokens: ["input_tokens", "inputTokens"],
  cacheReadInputTokens: ["cache_read_input_tokens", "cacheReadInputTokens", "cachedReadTokens", "cacheReadTokens"],
  outputTokens: ["output_tokens", "outputTokens"],
  reasoningTokens: ["reasoning_tokens", "reasoningTokens"],
  totalTokens: ["total_tokens", "totalTokens"]
};
const TOKEN_USAGE_METRICS = Object.keys(TOKEN_USAGE_FIELDS);
const TOKEN_USAGE_ALIASES = new Set(Object.values(TOKEN_USAGE_FIELDS).flat());
const TOKEN_USAGE_OUTPUT_FIELDS = {
  snake: {
    inputTokens: "input_tokens",
    cacheReadInputTokens: "cache_read_input_tokens",
    outputTokens: "output_tokens",
    reasoningTokens: "reasoning_tokens",
    totalTokens: "total_tokens"
  },
  camel: {
    inputTokens: "inputTokens",
    cacheReadInputTokens: "cacheReadInputTokens",
    outputTokens: "outputTokens",
    reasoningTokens: "reasoningTokens",
    totalTokens: "totalTokens"
  }
};

function optionalBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function finiteTokenField(value, names) {
  for (const name of names) {
    const candidate = value?.[name];
    if (Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return null;
}

function tokenUsageObservation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { coverage: "unreported", usage: null };
  }
  const usage = {};
  let observedFields = 0;
  for (const [metric, names] of Object.entries(TOKEN_USAGE_FIELDS)) {
    const field = finiteTokenField(value, names);
    if (field != null) {
      usage[metric] = field;
      observedFields += 1;
    }
  }
  if (observedFields === 0) {
    return { coverage: "unreported", usage: null };
  }
  return {
    coverage: observedFields === TOKEN_USAGE_METRICS.length ? "complete" : "incomplete",
    usage
  };
}

function spendObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

function formattedTokenUsage(usage, style) {
  const formatted = {};
  for (const metric of TOKEN_USAGE_METRICS) {
    if (Object.hasOwn(usage, metric)) {
      formatted[TOKEN_USAGE_OUTPUT_FIELDS[style][metric]] = usage[metric];
    }
  }
  return formatted;
}

function mergeSharedSpendFields(left, right, target) {
  if (!spendObject(left) || !spendObject(right)) {
    return;
  }
  for (const [key, leftValue] of Object.entries(left)) {
    if (TOKEN_USAGE_ALIASES.has(key) || !Object.hasOwn(right, key)) {
      continue;
    }
    const rightValue = right[key];
    if (Number.isFinite(leftValue) && Number.isFinite(rightValue)) {
      target[key] = leftValue + rightValue;
    } else if (Object.is(leftValue, rightValue)) {
      target[key] = leftValue;
    }
  }
}

function mergeTokenUsageValues(left, right, style) {
  const leftObserved = tokenUsageObservation(left);
  const rightObserved = tokenUsageObservation(right);
  const shared = {};
  for (const metric of TOKEN_USAGE_METRICS) {
    if (Object.hasOwn(leftObserved.usage ?? {}, metric) && Object.hasOwn(rightObserved.usage ?? {}, metric)) {
      shared[metric] = leftObserved.usage[metric] + rightObserved.usage[metric];
    }
  }
  const merged = formattedTokenUsage(shared, style);
  mergeSharedSpendFields(left, right, merged);
  return Object.keys(merged).length > 0 ? merged : null;
}

function modelUsageObservation(value) {
  if (!spendObject(value)) {
    return { coverage: "unreported" };
  }
  const entries = Object.values(value);
  return {
    coverage: entries.every((entry) => tokenUsageObservation(entry).coverage === "complete")
      ? "complete"
      : "incomplete"
  };
}

function mergeModelUsageValues(left, right) {
  const leftModels = spendObject(left) ? left : {};
  const rightModels = spendObject(right) ? right : {};
  const merged = {};
  for (const model of new Set([...Object.keys(leftModels), ...Object.keys(rightModels)])) {
    if (Object.hasOwn(leftModels, model) && Object.hasOwn(rightModels, model)) {
      const usage = mergeTokenUsageValues(leftModels[model], rightModels[model], "camel");
      if (usage) {
        merged[model] = usage;
      }
    } else {
      const usage = leftModels[model] ?? rightModels[model];
      if (usage && typeof usage === "object" && !Array.isArray(usage)) {
        merged[model] = { ...usage };
      }
    }
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

function mergedExplicitIncomplete(left, right) {
  if (left === true || right === true) {
    return true;
  }
  if (left === false || right === false) {
    return false;
  }
  return null;
}

function channelIncompleteFlag(explicitIncomplete, observed, exact) {
  if (explicitIncomplete === true) {
    return true;
  }
  if (observed) {
    return !exact;
  }
  return explicitIncomplete;
}

function mergeReviewSpend(first, retry) {
  const explicitIncomplete = mergedExplicitIncomplete(first.usageIsIncomplete, retry.usageIsIncomplete);
  const usageObserved = spendObject(first.usage) || spendObject(retry.usage);
  const usageExact =
    explicitIncomplete !== true &&
    tokenUsageObservation(first.usage).coverage === "complete" &&
    tokenUsageObservation(retry.usage).coverage === "complete";
  const modelUsageObserved = spendObject(first.modelUsage) || spendObject(retry.modelUsage);
  const modelUsageExact =
    explicitIncomplete !== true &&
    modelUsageObservation(first.modelUsage).coverage === "complete" &&
    modelUsageObservation(retry.modelUsage).coverage === "complete";
  return {
    usage: mergeTokenUsageValues(first.usage, retry.usage, "snake"),
    modelUsage: mergeModelUsageValues(first.modelUsage, retry.modelUsage),
    usageIsIncomplete: channelIncompleteFlag(explicitIncomplete, usageObserved, usageExact),
    modelUsageIsIncomplete: channelIncompleteFlag(explicitIncomplete, modelUsageObserved, modelUsageExact)
  };
}

function resultSpendPatch(result) {
  const usageIsIncomplete = optionalBoolean(result?.usageIsIncomplete);
  return {
    usage: result?.usage ?? null,
    modelUsage: result?.modelUsage ?? null,
    usageIsIncomplete,
    modelUsageIsIncomplete: optionalBoolean(result?.modelUsageIsIncomplete) ?? usageIsIncomplete
  };
}

function taskSuccessPayload(record, result) {
  return {
    jobId: record.id,
    status: "done",
    mode: record.mode,
    background: record.background,
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    stopReason: result.stopReason,
    ...resultSpendPatch(result),
    failureKind: null,
    text: result.text
  };
}

function failureResultPayload(record, { status, failureKind, message, result = null }) {
  return {
    jobId: record?.id ?? null,
    status,
    mode: record?.mode ?? null,
    background: Boolean(record?.background),
    exitCode: result?.exitCode ?? null,
    sessionId: result?.sessionId ?? null,
    ...(result ? resultSpendPatch(result) : {}),
    failureKind,
    message
  };
}

function retainedResultPayload(record, payload) {
  return record?.request?.outputJson ? payload : null;
}

function failJob(jobFile, logFile, result, timeoutMs) {
  const tail = failureTail(logFile, result);
  const current = readJobRecordFile(jobFile);
  const failureKind =
    current?.status === "cancelled" || current?.cancelRequestedAt
      ? "cancelled"
      : classifyFailure({ result, logTail: tail });
  const message = grokFailureMessage(result, timeoutMs, failureKind);
  const status = failureKind === "cancelled" ? "cancelled" : "error";
  const renderedMessage = failureOutcomeMessage({ message, detail: tail, jobId: current?.id, status, failureKind });
  finishJobRecord(jobFile, {
    status,
    pid: null,
    grokPid: null,
    finishedAt: nowIso(),
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    resultText: result.text || null,
    resultPayload: retainedResultPayload(
      current,
      failureResultPayload(current, { status, failureKind, message: renderedMessage, result })
    ),
    ...resultSpendPatch(result),
    errorMessage: oneLineSummary(message),
    errorTail: tail || message,
    failureKind,
    cancelRequestedAt: null
  });
  throw new Error(renderedMessage);
}

function describeLaunchFailure(error) {
  if (error?.code === "ENOENT") {
    return `The grok CLI (${resolveGrokBin()}) was not found on PATH. Install and authenticate it, then run /grok:setup to verify.`;
  }
  return error instanceof Error ? error.message : String(error);
}

function launchFailureError(error, jobId) {
  const failureKind = classifyFailure({ spawnError: error });
  const status = error?.cleanupRequired ? "running" : failureKind === "cancelled" ? "cancelled" : "error";
  const wrapped = errorWithFailure(
    failureOutcomeMessage({
      message: describeLaunchFailure(error),
      jobId,
      status,
      failureKind
    }),
    failureKind
  );
  if (error?.cleanupRequired) {
    wrapped.cleanupRequired = true;
    wrapped.processRole = error.processRole ?? null;
    wrapped.pid = error.pid ?? null;
    wrapped.pidIdentity = error.pidIdentity ?? null;
  }
  return wrapped;
}

function appendFailureLog(logFile, message) {
  try {
    appendJobLog(logFile, message);
    return readLogTail(logFile, 20) || message;
  } catch {
    return message;
  }
}

function recordSpawnFailure(jobFile, error, context = {}) {
  const message = describeLaunchFailure(error);
  try {
    const current = readJobRecordFile(jobFile);
    const failureKind = classifyFailure({ spawnError: error });
    if (error?.cleanupRequired || current?.cleanupRequired) {
      const processPatch = error.processRole === "worker"
        ? { pid: error.pid ?? current?.pid ?? null, pidIdentity: error.pidIdentity ?? current?.pidIdentity ?? null }
        : { grokPid: error.pid ?? current?.grokPid ?? null, grokPidIdentity: error.pidIdentity ?? current?.grokPidIdentity ?? null };
      updateJobRecordFile(jobFile, {
        ...context,
        ...processPatch,
        cleanupRequired: true,
        errorMessage: oneLineSummary(message),
        errorTail: message,
        failureKind
      });
      return;
    }
    const status = failureKind === "cancelled" ? "cancelled" : "error";
    finishJobRecord(jobFile, {
      ...context,
      status,
      pid: null,
      grokPid: null,
      finishedAt: nowIso(),
      resultPayload: retainedResultPayload(
        current,
        failureResultPayload(current, { status, failureKind, message })
      ),
      errorMessage: oneLineSummary(message),
      errorTail: message,
      failureKind,
      cancelRequestedAt: null
    });
  } catch {
    return;
  }
}

async function handleTask(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["prompt-file", "resume", "model", "effort", "max-turns", "best-of-n", "cwd"],
    booleanOptions: ["write", "background", "resume-last", "web", "json"]
  });

  const cwd = resolveCwd(options);
  const dataDir = resolveDataDir();
  const claudeSessionId = currentClaudeSessionId();

  const bestOfN = options["best-of-n"] ? parseBestOfN(options["best-of-n"]) : null;
  const maxTurns = options["max-turns"] ? parsePositiveInteger(options["max-turns"], "--max-turns") : null;
  const mode = options.write || bestOfN ? "write" : "consult";

  let resumeSessionId = options.resume ?? null;
  if (resumeSessionId) {
    resumeSessionId = validateResumeSessionId(dataDir, cwd, resumeSessionId, mode);
  }
  if (!resumeSessionId && options["resume-last"]) {
    resumeSessionId = resolveLastSessionId(dataDir, cwd, claudeSessionId, mode);
  }

  let prompt = readTaskPrompt(cwd, options, positionals);
  if (!prompt) {
    if (!resumeSessionId) {
      throw new Error("Provide a prompt, a prompt file, piped stdin, or a session to resume.");
    }
    prompt = CONTINUE_PROMPT;
  }

  const jobId = generateJobId();
  const briefFile = briefPath(dataDir, cwd, jobId);
  const jobFile = jobFilePath(dataDir, cwd, jobId);
  const record = createJobRecord({
    id: jobId,
    pid: options.background ? null : process.pid,
    mode,
    cwd,
    briefFile,
    background: Boolean(options.background),
    delivery: options.background ? backgroundDelivery() : "foreground",
    claudeSessionId,
    request: {
      model: options.model ?? null,
      effort: options.effort ?? null,
      maxTurns,
      bestOfN,
      web: Boolean(options.web),
      sandboxProfile: sandboxProfileForMode(mode),
      resumeSessionId,
      outputJson: Boolean(options.json)
    }
  });
  createJobRecordFile(jobFile, record);
  try {
    writeBrief(dataDir, cwd, jobId, prompt);
    if (resumeSessionId) {
      claimResumeSessionLease(dataDir, cwd, resumeSessionId, jobId);
    }
  } catch (error) {
    recordSpawnFailure(jobFile, error);
    throw launchFailureError(error, jobId);
  }

  if (options.background) {
    try {
      await spawnBackgroundWorker([SELF_PATH, "task-worker", "--job-id", jobId, "--cwd", cwd], jobFile);
    } catch (error) {
      recordSpawnFailure(jobFile, error);
      throw launchFailureError(error, jobId);
    }
    const payload = { jobId, status: "running", mode, background: true, delivery: record.delivery, failureKind: null };
    output(options.json ? payload : renderBackgroundLaunch(jobId, record.delivery), options.json);
    return;
  }

  const logFile = jobLogPath(dataDir, cwd, jobId);
  const timeoutMs = resolveTimeoutMs({ env: process.env });
  let result;
  try {
    result = await runGrok({
      briefFile,
      mode,
      resumeSessionId,
      model: options.model ?? null,
      effort: options.effort ?? null,
      maxTurns,
      bestOfN,
      web: Boolean(options.web),
      cwd,
      logFile,
      timeoutMs,
      launchProcess: (launch) => launchRunningJobProcess(jobFile, launch)
    });
  } catch (error) {
    recordSpawnFailure(jobFile, error);
    throw launchFailureError(error, jobId);
  }

  if (resultFailed(result)) {
    failJob(jobFile, logFile, result, timeoutMs);
  }

  const payload = taskSuccessPayload(record, result);
  const finishedAt = nowIso();
  const final = finishSuccessfulJobRecordFile(jobFile, {
    status: "done",
    pid: null,
    grokPid: null,
    finishedAt,
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    resultText: result.text,
    resultPayload: retainedResultPayload(record, payload),
    ...resultSpendPatch(result),
    failureKind: null
  });

  if (final.status === "cancelled") {
    throw new Error(
      failureOutcomeMessage({
        message: "Job was cancelled.",
        jobId,
        status: "cancelled",
        failureKind: "cancelled"
      })
    );
  }

  output(
    options.json ? payload : renderTaskResult({ text: result.text, sessionId: result.sessionId, jobId }),
    options.json
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseArgs(argv, { valueOptions: ["job-id", "cwd"] });
  const jobId = options["job-id"];
  if (!jobId) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const dataDir = resolveDataDir();
  const found = findRequestedJobRecord(dataDir, jobId, options);
  if (!found) {
    throw new Error(`No job record found for ${jobId}.`);
  }

  const record = found.record;
  if (record.status !== "running") {
    return;
  }
  const logFile = jobLogPath(dataDir, record.cwd, record.id);
  updateJobRecordFile(found.file, { pid: process.pid, pidIdentity: getProcessIdentity(process.pid) });

  const request = record.request ?? {};
  const timeoutMs = resolveTimeoutMs({ background: true, env: process.env });

  try {
    const result = await runGrok({
      briefFile: record.briefFile,
      mode: record.mode,
      resumeSessionId: request.resumeSessionId ?? null,
      model: request.model ?? null,
      effort: request.effort ?? null,
      maxTurns: request.maxTurns ?? null,
      bestOfN: request.bestOfN ?? null,
      web: Boolean(request.web),
      cwd: record.cwd,
      logFile,
      timeoutMs,
      launchProcess: (launch) => launchRunningJobProcess(found.file, launch)
    });

    const finishedAt = nowIso();
    if (!resultFailed(result)) {
      const payload = taskSuccessPayload(record, result);
      finishSuccessfulJobRecordFile(found.file, {
        status: "done",
        pid: null,
        grokPid: null,
        finishedAt,
        exitCode: result.exitCode,
        sessionId: result.sessionId,
        resultText: result.text,
        resultPayload: retainedResultPayload(record, payload),
        ...resultSpendPatch(result),
        failureKind: null
      });
      return;
    }

    const tail = failureTail(logFile, result);
    const current = readJobRecordFile(found.file);
    const failureKind =
      current?.status === "cancelled" || current?.cancelRequestedAt
        ? "cancelled"
        : classifyFailure({ result, logTail: tail });
    const message = grokFailureMessage(result, timeoutMs, failureKind);
    const status = failureKind === "cancelled" ? "cancelled" : "error";
    const renderedMessage = failureOutcomeMessage({ message, detail: tail, jobId: record.id, status, failureKind });
    finishJobRecord(found.file, {
      status,
      pid: null,
      grokPid: null,
      finishedAt,
      exitCode: result.exitCode,
      sessionId: result.sessionId,
      resultText: result.text || null,
      resultPayload: retainedResultPayload(
        record,
        failureResultPayload(record, { status, failureKind, message: renderedMessage, result })
      ),
      ...resultSpendPatch(result),
      errorMessage: oneLineSummary(message),
      errorTail: tail || message,
      failureKind,
      cancelRequestedAt: null
    });
  } catch (error) {
    const message = describeLaunchFailure(error);
    appendFailureLog(logFile, message);
    recordSpawnFailure(found.file, error);
  }
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  }
  return result.stdout ?? "";
}

function ensureGitRepository(cwd) {
  const result = spawnSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error("Not inside a git repository.");
  }
}

function collectReviewTarget(cwd, base) {
  if (base) {
    const range = runGit(["diff", `${base}...HEAD`], cwd);
    const uncommitted = runGit(["diff", "HEAD"], cwd);
    const parts = [range.trim(), uncommitted.trim()].filter(Boolean);
    return { label: `changes since ${base}`, diff: parts.join("\n\n") };
  }

  const tracked = runGit(["diff", "HEAD"], cwd);
  const porcelain = runGit(["status", "--porcelain"], cwd);
  const untracked = porcelain
    .split(/\r?\n/)
    .filter((line) => line.startsWith("??"))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  const parts = [tracked.trim()].filter(Boolean);
  if (untracked.length > 0) {
    parts.push(["Untracked files:", ...untracked.map((file) => `- ${file}`)].join("\n"));
  }
  return { label: "working tree changes", diff: parts.join("\n\n") };
}

function loadReviewTemplate() {
  if (!fs.existsSync(REVIEW_PROMPT_FILE)) {
    throw new Error(`Missing review prompt template at ${REVIEW_PROMPT_FILE}.`);
  }
  return fs.readFileSync(REVIEW_PROMPT_FILE, "utf8");
}

function interpolateTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.hasOwn(values, key) ? values[key] : match
  );
}

function evaluateReviewText(text) {
  const parsed = extractFirstJsonObject(text);
  if (!parsed) {
    return { valid: false, error: "No JSON object found in the reply." };
  }
  const validation = validateReviewOutput(parsed);
  if (!validation.valid) {
    return { valid: false, error: validation.error };
  }
  return { valid: true, value: validation.value };
}

function buildCorrectivePrompt(error) {
  return [
    `Your previous reply was not a single valid JSON review object (${error}).`,
    'Reply with only one JSON object and nothing else: {"verdict": "approve" or "needs-attention", "findings": array of objects with required severity (high, medium, or low), title, body and optional file, line_start, line_end, confidence, recommendation, "next_steps": array of strings}.',
    "No markdown fences, no prose before or after the object."
  ].join(" ");
}

async function runReviewJob(record, jobFile, options = {}) {
  const logFile = jobLogPath(resolveDataDir(), record.cwd, record.id);
  const timeoutMs = resolveTimeoutMs({ background: Boolean(options.background), env: process.env });
  let first;
  try {
    first = await runGrok({
      briefFile: record.briefFile,
      mode: "consult",
      cwd: record.cwd,
      logFile,
      timeoutMs,
      launchProcess: (launch) => launchRunningJobProcess(jobFile, launch)
    });
  } catch (error) {
    recordSpawnFailure(jobFile, error);
    throw launchFailureError(error, record.id);
  }
  if (resultFailed(first)) {
    failJob(jobFile, logFile, first, timeoutMs);
  }

  let review = evaluateReviewText(first.text);
  let sessionId = first.sessionId;
  let finalText = first.text;
  let spend = resultSpendPatch(first);

  if (!review.valid && first.sessionId) {
    const retryBrief = writeBrief(resolveDataDir(), record.cwd, `${record.id}-retry`, buildCorrectivePrompt(review.error));
    let retry;
    try {
      retry = await runGrok({
        briefFile: retryBrief,
        mode: "consult",
        resumeSessionId: first.sessionId,
        cwd: record.cwd,
        logFile,
        timeoutMs,
        launchProcess: (launch) => launchRunningJobProcess(jobFile, launch)
      });
    } catch (error) {
      recordSpawnFailure(jobFile, error, {
        sessionId,
        resultText: first.text || null,
        ...spend
      });
      throw launchFailureError(error, record.id);
    }
    spend = mergeReviewSpend(first, retry);
    if (resultFailed(retry)) {
      failJob(
        jobFile,
        logFile,
        {
          ...retry,
          sessionId: retry.sessionId ?? sessionId,
          ...spend
        },
        timeoutMs
      );
    }
    review = evaluateReviewText(retry.text);
    if (retry.text) {
      finalText = retry.text;
    }
    sessionId = retry.sessionId ?? sessionId;
  }

  const targetLabel = record.request?.reviewTargetLabel ?? "working tree changes";
  const body = review.valid
    ? renderReviewResult(review.value, { targetLabel })
    : renderReviewFallback(finalText, { parseError: review.error });
  const validationMessage = review.valid
    ? null
    : `Grok review output failed validation after one corrective retry: ${review.error}`;

  const payload = {
    jobId: record.id,
    status: review.valid ? "done" : "error",
    mode: "consult",
    background: record.background,
    sessionId,
    valid: review.valid,
    review: review.valid ? review.value : null,
    parseError: review.valid ? null : review.error,
    ...spend,
    failureKind: review.valid ? null : "error",
    rawText: finalText,
    rendered: body
  };

  finishJobRecord(jobFile, {
    status: review.valid ? "done" : "error",
    pid: null,
    grokPid: null,
    finishedAt: nowIso(),
    exitCode: 0,
    sessionId,
    resultText: body,
    resultPayload: retainedResultPayload(record, payload),
    ...spend,
    errorMessage: validationMessage,
    errorTail: review.valid ? null : boundedTextTail(finalText) || validationMessage,
    failureKind: review.valid ? null : "error",
    cancelRequestedAt: null
  });
  return payload;
}

async function handleReview(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["base", "focus", "cwd"],
    booleanOptions: ["background", "json"]
  });

  const cwd = resolveCwd(options);
  const dataDir = resolveDataDir();
  ensureGitRepository(cwd);

  const target = collectReviewTarget(cwd, options.base);
  if (!target.diff.trim()) {
    throw new Error("No changes found to review.");
  }

  const focus = [options.focus ?? "", positionals.join(" ")].join(" ").trim();
  const prompt = interpolateTemplate(loadReviewTemplate(), {
    TARGET_LABEL: target.label,
    USER_FOCUS: focus || "No extra focus provided.",
    DIFF: target.diff
  });

  const jobId = generateJobId();
  const briefFile = briefPath(dataDir, cwd, jobId);
  const jobFile = jobFilePath(dataDir, cwd, jobId);
  const record = createJobRecord({
    id: jobId,
    pid: options.background ? null : process.pid,
    mode: "consult",
    cwd,
    briefFile,
    background: Boolean(options.background),
    delivery: options.background ? backgroundDelivery() : "foreground",
    claudeSessionId: currentClaudeSessionId(),
    request: {
      reviewTargetLabel: target.label,
      sandboxProfile: sandboxProfileForMode("consult"),
      outputJson: Boolean(options.json)
    }
  });
  createJobRecordFile(jobFile, record);
  try {
    writeBrief(dataDir, cwd, jobId, prompt);
  } catch (error) {
    recordSpawnFailure(jobFile, error);
    throw launchFailureError(error, jobId);
  }

  if (options.background) {
    try {
      await spawnBackgroundWorker([SELF_PATH, "review-worker", "--job-id", jobId, "--cwd", cwd], jobFile);
    } catch (error) {
      recordSpawnFailure(jobFile, error);
      throw launchFailureError(error, jobId);
    }
    const payload = { jobId, status: "running", mode: "consult", background: true, delivery: record.delivery, failureKind: null };
    output(options.json ? payload : renderBackgroundLaunch(jobId, record.delivery), options.json);
    return;
  }

  const payload = await runReviewJob(record, jobFile);
  if (!payload.valid) {
    throw new Error(
      failureOutcomeMessage({
        message: `Grok review output failed validation after one corrective retry: ${payload.parseError}`,
        detail: payload.rendered,
        jobId,
        failureKind: "error"
      })
    );
  }
  output(
    options.json
      ? payload
      : renderTaskResult({ text: payload.rendered.trimEnd(), sessionId: payload.sessionId, jobId }),
    options.json
  );
}

async function handleReviewWorker(argv) {
  const { options } = parseArgs(argv, { valueOptions: ["job-id", "cwd"] });
  const jobId = options["job-id"];
  if (!jobId) {
    throw new Error("Missing required --job-id for review-worker.");
  }

  const dataDir = resolveDataDir();
  const found = findRequestedJobRecord(dataDir, jobId, options);
  if (!found) {
    throw new Error(`No job record found for ${jobId}.`);
  }

  if (found.record.status !== "running") {
    return;
  }

  const record = updateJobRecordFile(found.file, { pid: process.pid, pidIdentity: getProcessIdentity(process.pid) });
  const logFile = jobLogPath(dataDir, record.cwd, record.id);
  try {
    await runReviewJob(record, found.file, { background: true });
  } catch (error) {
    const current = readJobRecordFile(found.file);
    if (current?.status !== "running") {
      return;
    }
    if (error?.cleanupRequired || current.cleanupRequired) {
      recordSpawnFailure(found.file, error);
      return;
    }
    const message = describeLaunchFailure(error);
    const failureKind = classifyFailure({ spawnError: error });
    const errorTail = appendFailureLog(logFile, message);
    finishJobRecord(found.file, {
      status: "error",
      pid: null,
      grokPid: null,
      finishedAt: nowIso(),
      resultPayload: retainedResultPayload(
        record,
        failureResultPayload(record, { status: "error", failureKind, message })
      ),
      errorMessage: oneLineSummary(message),
      errorTail,
      failureKind
    });
  }
}

function handleStatus(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const dataDir = resolveDataDir();
  const jobId = positionals[0];
  if (jobId) {
    const found = findRequestedJobRecord(dataDir, jobId, options);
    if (!found) {
      throw new Error(`No job record found for ${jobId}.`);
    }
    const { record } = refreshRunningJobRecord(found);
    const logTail =
      record.status === "error" ? readLogTail(jobLogPath(dataDir, record.cwd, record.id), 20) : "";
    output(options.json ? record : renderJobDetail(record, { logTail }), options.json);
    if (record.cleanupRequired) {
      process.exitCode = 1;
    }
    return;
  }

  const jobs = listJobRecords(dataDir, resolveCwd(options)).map((record) =>
    refreshRunningJobRecord({ record, file: jobFilePath(dataDir, record.cwd, record.id) }).record
  );
  output(options.json ? { jobs } : renderStatusTable(jobs, currentClaudeSessionId()), options.json);
  if (jobs.some((record) => record.cleanupRequired)) {
    process.exitCode = 1;
  }
}

function renderFailedResult(record, dataDir) {
  const tail = readLogTail(jobLogPath(dataDir, record.cwd, record.id), 20) || record.errorTail || "";
  const lines = [`Job ${record.id} failed${record.exitCode != null ? ` with exit code ${record.exitCode}` : ""}.`];
  if (tail) {
    lines.push("", "Log tail:", "", "```text", tail, "```");
  }
  lines.push("", `job: ${record.id}`, "state: error");
  if (record.failureKind) {
    lines.push(`failure: ${record.failureKind}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderRunningWaitResult(record) {
  if (record.cleanupRequired) {
    const lines = [`Job ${record.id}`, "", "Status: cleanup required"];
    if (record.errorMessage) {
      lines.push("", record.errorMessage);
    }
    lines.push("", `job: ${record.id}`, "state: running");
    if (record.failureKind) {
      lines.push(`failure: ${record.failureKind}`);
    }
    lines.push("phase: cleanup-required");
    return `${lines.join("\n")}\n`;
  }
  return [`Job ${record.id}`, "", "Status: running", "", `job: ${record.id}`, "state: running"].join("\n") + "\n";
}

function renderNotRunningReport(record) {
  const lines = [
    `Job ${record.id} is not running (status: ${record.status}).`,
    "",
    `job: ${record.id}`,
    `state: ${record.status}`
  ];
  if (record.failureKind) {
    lines.push(`failure: ${record.failureKind}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderResultRecord(record, dataDir) {
  if (record.status === "running") {
    if (record.cleanupRequired) {
      return renderRunningWaitResult(record);
    }
    return `Job ${record.id} is still running. Check /grok:status ${record.id} for progress.\n`;
  }

  if (record.status === "error") {
    return renderFailedResult(record, dataDir);
  }

  if (record.status === "cancelled") {
    const lines = [`Job ${record.id} was cancelled.`, "", `job: ${record.id}`, "state: cancelled"];
    if (record.failureKind) {
      lines.push(`failure: ${record.failureKind}`);
    }
    return `${lines.join("\n")}\n`;
  }

  return renderTaskResult({ text: record.resultText ?? "", sessionId: record.sessionId, jobId: record.id });
}

function jsonResultPayload(record, dataDir) {
  if (!record.request?.outputJson || record.status === "running") {
    return record;
  }
  if (record.resultPayload) {
    return record.resultPayload;
  }
  if (record.status === "done") {
    return taskSuccessPayload(record, {
      exitCode: record.exitCode,
      sessionId: record.sessionId,
      stopReason: record.stopReason ?? null,
      usage: record.usage,
      modelUsage: record.modelUsage,
      usageIsIncomplete: record.usageIsIncomplete,
      modelUsageIsIncomplete: record.modelUsageIsIncomplete,
      text: record.resultText ?? ""
    });
  }
  const failureKind = record.failureKind ?? (record.status === "cancelled" ? "cancelled" : "error");
  return failureResultPayload(record, {
    status: record.status,
    failureKind,
    message: renderResultRecord(record, dataDir).trimEnd(),
    result: record
  });
}

async function waitForResultRecord(found, options) {
  const timeoutMs = resolveWaitTimeoutMs(options);
  const pollMs = resolveWaitPollMs();
  const deadline = Date.now() + timeoutMs;
  let record = found.record;

  for (;;) {
    const current = readJobRecordFile(found.file) ?? record;
    record = refreshRunningJobRecord({ record: current, file: found.file }).record;
    if (record.status !== "running" || record.cleanupRequired) {
      return record;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return record;
    }
    await delayMs(Math.min(pollMs, remaining));
  }
}

async function handleResult(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "wait-timeout-ms"],
    booleanOptions: ["json", "wait"]
  });

  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("Provide a job id, for example /grok:result <job-id>.");
  }

  const dataDir = resolveDataDir();
  const found = findRequestedJobRecord(dataDir, jobId, options);
  if (!found) {
    throw new Error(`No job record found for ${jobId}.`);
  }

  const record = options.wait ? await waitForResultRecord(found, options) : refreshRunningJobRecord(found).record;
  const markCollected = record.status !== "running" && record.delivery === "managed";
  if (record.cleanupRequired) {
    process.exitCode = 1;
  }
  if (options.json) {
    output(jsonResultPayload(record, dataDir), true);
    if (markCollected) {
      markManagedDeliveryCollectedFile(found.file);
    }
    return;
  }

  if (options.wait && record.status === "running") {
    output(renderRunningWaitResult(record), false);
    return;
  }

  output(renderResultRecord(record, dataDir), false);
  if (markCollected) {
    markManagedDeliveryCollectedFile(found.file);
  }
}

async function handleCancel(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("Provide a job id, for example /grok:cancel <job-id>.");
  }

  const dataDir = resolveDataDir();
  const found = findRequestedJobRecord(dataDir, jobId, options);
  if (!found) {
    throw new Error(`No job record found for ${jobId}.`);
  }

  const record = readJobRecordFile(found.file) ?? found.record;
  if (record.status !== "running") {
    output(options.json ? record : renderNotRunningReport(record), options.json);
    return;
  }
  const requested = updateJobRecordFile(found.file, { cancelRequestedAt: nowIso() });
  if (requested.status !== "running") {
    output(
      options.json ? requested : renderNotRunningReport(requested),
      options.json
    );
    return;
  }

  const terminated = await terminateRecordedProcessGroups(requested);
  const cleanupMessage = "Cancellation was requested, but verified process cleanup did not complete. The process identifiers were retained for retry.";
  const next = updateJobRecordFileWithCurrent(found.file, (current) => {
    if (current.status !== "running") {
      return current;
    }
    if (!terminated || !recordedProcessGroupsClean(current)) {
      return cleanupRequiredPatch(current, "cancelled", cleanupMessage);
    }
    return {
      ...current,
      status: "cancelled",
      finishedAt: nowIso(),
      resultPayload: retainedResultPayload(
        current,
        failureResultPayload(current, {
          status: "cancelled",
          failureKind: "cancelled",
          message: failureOutcomeMessage({
            message: "The Grok job was cancelled.",
            jobId: current.id,
            status: "cancelled",
            failureKind: "cancelled"
          })
        })
      ),
      failureKind: "cancelled",
      cancelRequestedAt: null
    };
  });
  if (next.status === "running" && next.cleanupRequired) {
    throw errorWithFailure(failureOutcomeMessage({ message: cleanupMessage, jobId: next.id, status: "running", failureKind: "cancelled" }), "cancelled");
  }
  if (next.status !== "cancelled") {
    output(options.json ? next : renderNotRunningReport(next), options.json);
    return;
  }
  output(options.json ? next : renderCancelReport(next), options.json);
}

function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function addTokenUsage(target, usage) {
  for (const metric of TOKEN_USAGE_METRICS) {
    target[metric] += usage[metric];
  }
}

function tokenUsageFromModels(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { coverage: "unreported", usage: null };
  }
  const entries = Object.values(value);
  if (entries.length === 0) {
    return { coverage: "unreported", usage: null };
  }
  const combined = {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  };
  let completeEntries = 0;
  let incompleteEntry = false;
  for (const entry of entries) {
    const observed = tokenUsageObservation(entry);
    if (observed.coverage === "complete") {
      addTokenUsage(combined, observed.usage);
      completeEntries += 1;
    } else if (observed.coverage === "incomplete") {
      incompleteEntry = true;
    }
  }
  if (completeEntries === entries.length) {
    return { coverage: "complete", usage: combined };
  }
  if (completeEntries > 0 || incompleteEntry) {
    return { coverage: "incomplete", usage: null };
  }
  return { coverage: "unreported", usage: null };
}

function tokenUsageForRecord(record) {
  const usageIsIncomplete = record.usageIsIncomplete === true || record.usage_is_incomplete === true;
  const modelUsageIsIncomplete = optionalBoolean(record.modelUsageIsIncomplete);
  const direct = tokenUsageObservation(record.usage);
  if (direct.coverage === "complete" && !usageIsIncomplete) {
    return direct;
  }
  const byModel = tokenUsageFromModels(record.modelUsage);
  const modelBlocked = modelUsageIsIncomplete === true || (usageIsIncomplete && modelUsageIsIncomplete == null);
  if (byModel.coverage === "complete" && !modelBlocked) {
    return byModel;
  }
  return usageIsIncomplete || modelUsageIsIncomplete === true || direct.coverage === "incomplete" || byModel.coverage === "incomplete"
    ? { coverage: "incomplete", usage: null }
    : { coverage: "unreported", usage: null };
}

function modelNamesForRecord(record) {
  if (record.modelUsage && typeof record.modelUsage === "object" && !Array.isArray(record.modelUsage)) {
    const names = Object.keys(record.modelUsage).filter((name) => name.trim());
    if (names.length > 0) {
      return names;
    }
  }
  const requested = record.request?.model;
  return typeof requested === "string" && requested.trim() ? [requested.trim()] : ["unknown"];
}

function historicalFailureKind(record, dataDir) {
  const stored = typeof record.failureKind === "string" ? record.failureKind.trim() : "";
  if (stored && stored !== "error") {
    return stored;
  }
  const recordSummary = [record.errorMessage, record.errorTail]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");
  const recordClassification = classifyFailure({ logTail: recordSummary });
  if (recordClassification !== "error") {
    return recordClassification;
  }
  const logTail = record?.cwd && record?.id ? readLogTail(jobLogPath(dataDir, record.cwd, record.id), Number.MAX_SAFE_INTEGER) : "";
  const classified = classifyFailure({ logTail });
  return classified === "error" ? stored || "error" : classified;
}

function aggregateJobStats(records, dataDir) {
  const byStatus = {};
  const byMode = {};
  const byFailureKind = {};
  const byModel = {};
  const usage = {
    reportedJobs: 0,
    inputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  };
  const usageCoverage = {
    completeJobs: 0,
    incompleteJobs: 0,
    unreportedJobs: 0
  };
  const doneDurations = [];
  let earliest = null;
  let latest = null;

  for (const record of records) {
    increment(byStatus, record.status ?? "unknown");
    increment(byMode, record.mode ?? "unknown");
    for (const model of modelNamesForRecord(record)) {
      increment(byModel, model);
    }
    const recordUsage = tokenUsageForRecord(record);
    if (recordUsage.coverage === "complete") {
      addTokenUsage(usage, recordUsage.usage);
      usage.reportedJobs += 1;
      usageCoverage.completeJobs += 1;
    } else if (recordUsage.coverage === "incomplete") {
      usageCoverage.incompleteJobs += 1;
    } else {
      usageCoverage.unreportedJobs += 1;
    }
    if (record.status === "error" || record.status === "cancelled") {
      increment(byFailureKind, record.status === "cancelled" ? record.failureKind ?? "cancelled" : historicalFailureKind(record, dataDir));
    }
    const created = Date.parse(record.createdAt ?? "");
    if (Number.isFinite(created)) {
      if (earliest == null || record.createdAt < earliest) {
        earliest = record.createdAt;
      }
      if (latest == null || record.createdAt > latest) {
        latest = record.createdAt;
      }
    }
    if (record.status === "done") {
      const finished = Date.parse(record.finishedAt ?? "");
      if (Number.isFinite(created) && Number.isFinite(finished) && finished >= created) {
        doneDurations.push((finished - created) / 1000);
      }
    }
  }

  const meanWallClockSeconds =
    doneDurations.length > 0
      ? Math.round((doneDurations.reduce((sum, value) => sum + value, 0) / doneDurations.length) * 1000) / 1000
      : null;

  return {
    totalJobs: records.length,
    byStatus,
    byMode,
    byFailureKind,
    byModel,
    usage: usage.reportedJobs > 0 ? usage : null,
    usageCoverage: {
      availability:
        usageCoverage.completeJobs === 0
          ? "unavailable"
          : usageCoverage.completeJobs === records.length
            ? "available"
            : "partial",
      ...usageCoverage
    },
    meanWallClockSeconds,
    earliestCreatedAt: earliest,
    latestCreatedAt: latest
  };
}

function handleStats(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["all", "json"]
  });

  const dataDir = resolveDataDir();
  const cwd = resolveCwd(options);
  const records = options.all
    ? listAllJobRecords(dataDir).map((entry) => refreshRunningJobRecord(entry).record)
    : listJobRecords(dataDir, cwd).map((record) =>
        refreshRunningJobRecord({ record, file: jobFilePath(dataDir, record.cwd, record.id) }).record
      );
  const stats = {
    scope: options.all ? "all" : "workspace",
    cwd: options.all ? null : cwd,
    ...aggregateJobStats(records, dataDir)
  };
  output(options.json ? stats : renderStatsReport(stats), options.json);
}

function handleSetup(argv) {
  const { options } = parseArgs(argv, {
    booleanOptions: ["json", "enable-stop-gate", "disable-stop-gate"]
  });
  if (options["enable-stop-gate"] && options["disable-stop-gate"]) {
    throw new Error("Use either --enable-stop-gate or --disable-stop-gate, not both.");
  }

  const bin = resolveGrokBin();
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
  const available = !probe.error && probe.status === 0;
  const detail = available
    ? (probe.stdout || probe.stderr).trim() || "ok"
    : probe.error?.code === "ENOENT"
      ? "not found on PATH"
      : (probe.stderr || probe.stdout || probe.error?.message || `exit ${probe.status}`).trim();

  const dataDir = resolveDataDir();
  let writable = true;
  let writeDetail = dataDir;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);
  } catch (error) {
    writable = false;
    writeDetail = error instanceof Error ? error.message : String(error);
  }

  if (options["enable-stop-gate"]) {
    writeConfig(dataDir, { stopGate: true });
  } else if (options["disable-stop-gate"]) {
    writeConfig(dataDir, { stopGate: false });
  }

  const report = {
    ready: available && writable,
    grok: { available, detail, bin },
    dataDir: { path: dataDir, writable, detail: writeDetail },
    stopGate: Boolean(readConfig(dataDir).stopGate)
  };
  output(options.json ? report : renderSetupReport(report), options.json);
}

function parseStopGateInput() {
  const raw = readStdinIfPiped().trim();
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function emitStopGateBlock(reason) {
  const payload = {
    decision: "block",
    reason: `Grok stop-time review found issues that still need fixes before ending the session: ${reason}`
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function handleStopGate() {
  const input = parseStopGateInput();
  if (!input) {
    return;
  }

  const dataDir = resolveDataDir();
  if (!isStopGateEnabled(dataDir) || input.stop_hook_active) {
    return;
  }

  const cwd = input.cwd ? path.resolve(String(input.cwd)) : process.cwd();
  const probe = spawnSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    return;
  }

  let target;
  try {
    target = collectReviewTarget(cwd, null);
  } catch {
    return;
  }
  if (!target.diff.trim()) {
    return;
  }

  if (!fs.existsSync(STOP_GATE_PROMPT_FILE)) {
    return;
  }
  const prompt = interpolateTemplate(fs.readFileSync(STOP_GATE_PROMPT_FILE, "utf8"), {
    DIFF: target.diff
  });

  const jobId = generateJobId();
  const briefFile = briefPath(dataDir, cwd, jobId);
  const jobFile = jobFilePath(dataDir, cwd, jobId);
  createJobRecordFile(
    jobFile,
    createJobRecord({
      id: jobId,
      pid: process.pid,
      mode: "consult",
      cwd,
      briefFile,
      background: false,
      claudeSessionId: input.session_id ?? currentClaudeSessionId(),
      request: { maxTurns: STOP_GATE_MAX_TURNS, sandboxProfile: sandboxProfileForMode("consult") }
    })
  );
  try {
    writeBrief(dataDir, cwd, jobId, prompt);
  } catch (error) {
    recordSpawnFailure(jobFile, error);
    return;
  }

  const logFile = jobLogPath(dataDir, cwd, jobId);
  let result;
  try {
    result = await runGrok({
      briefFile,
      mode: "consult",
      maxTurns: STOP_GATE_MAX_TURNS,
      cwd,
      logFile,
      timeoutMs: STOP_GATE_TIMEOUT_MS,
      launchProcess: (launch) => launchRunningJobProcess(jobFile, launch)
    });
  } catch (error) {
    recordSpawnFailure(jobFile, error);
    return;
  }

  if (resultFailed(result)) {
    const tail = failureTail(logFile, result);
    const failureKind = classifyFailure({ result, logTail: tail });
    const message = grokFailureMessage(result, STOP_GATE_TIMEOUT_MS, failureKind);
    finishJobRecord(jobFile, {
      status: "error",
      pid: null,
      grokPid: null,
      finishedAt: nowIso(),
      exitCode: result.exitCode,
      sessionId: result.sessionId,
      resultText: result.text || null,
      ...resultSpendPatch(result),
      errorMessage: oneLineSummary(message),
      errorTail: tail || message,
      failureKind
    });
    return;
  }

  finishJobRecord(jobFile, {
    status: "done",
    pid: null,
    grokPid: null,
    finishedAt: nowIso(),
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    resultText: result.text,
    ...resultSpendPatch(result),
    failureKind: null,
    cancelRequestedAt: null
  });

  const text = String(result.text ?? "").trim();
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (firstLine?.startsWith("BLOCK:")) {
    emitStopGateBlock(firstLine.slice("BLOCK:".length).trim() || text);
  }
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "review-worker":
      await handleReviewWorker(argv);
      break;
    case "status":
      handleStatus(argv);
      break;
    case "result":
      await handleResult(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "stats":
      handleStats(argv);
      break;
    case "setup":
      handleSetup(argv);
      break;
    case "stop-gate":
      try {
        await handleStopGate();
      } catch {
        return;
      }
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}.`);
  }
}

function wantsJsonError() {
  return process.argv.slice(3).some((token) => token === "--json" || token === "--json=true");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorFailureKind(error, message) {
  if (error?.failureKind) {
    return error.failureKind;
  }
  const match = String(message ?? "").match(/^failure: ([a-z_]+)$/m);
  return match ? match[1] : "error";
}

function errorStatus(message) {
  const match = String(message ?? "").match(/^state: (done|error|cancelled|running)$/m);
  return match ? match[1] : "error";
}

function renderTopLevelError(error) {
  const message = errorMessage(error).trimEnd();
  const failureKind = errorFailureKind(error, message);
  const status = errorStatus(message);
  if (wantsJsonError()) {
    return `${JSON.stringify({ status, failureKind, message }, null, 2)}\n`;
  }
  const lines = [message || "Grok companion failed."];
  if (!/^state: /m.test(message)) {
    lines.push("state: error");
  }
  if (!/^failure: /m.test(message)) {
    lines.push(`failure: ${failureKind}`);
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  main().catch((error) => {
    process.stderr.write(renderTopLevelError(error));
    process.exitCode = 1;
  });
}
