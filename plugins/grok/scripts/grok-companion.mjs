#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";

import { parseArgs, parseRawArgs, rawBooleanOptionRequested } from "./lib/args.mjs";
import {
  buildGrokArgs,
  formatBlockedPermissionCall,
  formatDeniedToolDetail,
  normalizeGrokSessionId,
  resolveGrokBin,
  resolveGrokCapabilities,
  resolveTimeoutMs,
  sandboxProfileForMode,
  recordedProcessGroupsClean,
  runGrok,
  runningJobLiveness,
  terminalRecordAttribution,
  terminateProcessGroup,
  terminateRecordedProcessGroups,
  terminateRecordedProcessGroupsSync
} from "./lib/grok-exec.mjs";
import { getProcessIdentity } from "./lib/process-identity.mjs";
import {
  extractFirstJsonObject,
  renderBackgroundLaunch,
  renderCancelReport,
  renderHistoryReport,
  renderJobDetail,
  renderRecordAcceptance,
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
  ensurePrivateDataDir,
  findJobRecordById,
  generateJobId,
  jobFilePath,
  jobLogPath,
  launchRunningJobProcess,
  listAllJobRecords,
  listJobRecords,
  markDeliveryCollectedFile,
  nowIso,
  readJobRecordFile,
  readLogTail,
  resolveDataDir,
  updateJobRecordFile,
  updateJobRecordFileWithCurrent,
  finishSuccessfulJobRecordFile,
  writeBrief,
  writePrivateDataFile,
  appendJobLog
} from "./lib/state.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SELF_PATH), "..");
const REVIEW_PROMPT_FILE = path.join(ROOT_DIR, "prompts", "review.md");
const STOP_GATE_PROMPT_FILE = path.join(ROOT_DIR, "prompts", "stop-gate.md");
let cachedGrokCompanionVersion;

function resolvePluginRoot(env = process.env) {
  if (env.CLAUDE_PLUGIN_ROOT && env.CLAUDE_PLUGIN_ROOT.trim()) {
    return path.resolve(env.CLAUDE_PLUGIN_ROOT.trim());
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function resolveGrokCompanionVersion(env = process.env) {
  if (cachedGrokCompanionVersion !== undefined) {
    return cachedGrokCompanionVersion;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(resolvePluginRoot(env), ".claude-plugin", "plugin.json"), "utf8"));
    cachedGrokCompanionVersion = typeof manifest?.version === "string" ? manifest.version : null;
  } catch {
    cachedGrokCompanionVersion = null;
  }
  return cachedGrokCompanionVersion;
}

const STOP_GATE_OPTION_ENV = "CLAUDE_PLUGIN_OPTION_STOP_GATE";
const CONTINUITY_POLICY_ENV = "GROK_COMPANION_CONTINUITY_POLICY";
const STOP_GATE_TIMEOUT_MS = 240000;
const STOP_GATE_MAX_TURNS = 15;
const WAIT_POLL_ENV = "GROK_COMPANION_WAIT_POLL_MS";
const WAIT_TIMEOUT_ENV = "GROK_COMPANION_WAIT_TIMEOUT_MS";
const BACKGROUND_DELIVERY_ENV = "GROK_COMPANION_BACKGROUND_DELIVERY";
const DEFAULT_WAIT_POLL_MS = 2000;
const DEFAULT_WAIT_TIMEOUT_MS = 570000;
const RECORD_ACCEPTANCE_JOB_ID_PATTERN = /^[a-f0-9]{32}$/;
const RECORD_ACCEPTANCE_VALUES = new Set(["accepted", "rejected", "unverified"]);
const SEMANTIC_FAILURE_KINDS = new Set(["intent_override", "scope_rewrite", "wrong_approach", "style_mismatch"]);
const MAX_WAIT_TIMEOUT_MS = 570000;
const CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
const MAX_RAW_ARGUMENT_BYTES = 4 * 1024 * 1024 + 64 * 1024;
const TRANSPORT_DIRECTORY_PREFIX = "grok-companion-input-";
const TRANSPORT_TOKEN_PATTERN = /^[a-f0-9]{48}$/;
const TRANSPORT_OWNER_FILE = "owner.json";
const TRANSPORT_OWNER_MAX_BYTES = 4096;
const TRANSPORT_MAX_AGE_MS = 60 * 60 * 1000;
const JOB_ID_PATTERN = /^[a-f0-9]{32}$/;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 500;
const CONTINUITY_POLICIES = new Set(["manual", "claude-session"]);
const HISTORY_STATUSES = new Set(["running", "done", "error", "cancelled"]);
const HISTORY_MODES = new Set(["consult", "write"]);
const HISTORY_DELIVERIES = new Set(["foreground", "manual", "managed"]);
const HISTORY_DELIVERY_STATUSES = new Set(["pending", "delivered", "collected"]);
const HISTORY_SEMANTIC_STATUSES = new Set(["unverified", "accepted", "rejected"]);
const HISTORY_FAILURE_KINDS = new Set([
  "quota",
  "auth",
  "missing_cli",
  "setup",
  "rate_limited",
  "timeout",
  "error",
  "permission",
  "cancelled",
  "input",
  "died",
  "resource",
  "sandbox",
  "transport",
  "policy",
  "turn_limit"
]);
const GROK_ROLES = new Set(["burst", "independence", "live-web", "large-context"]);
const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings", "next_steps"],
  properties: {
    verdict: { type: "string", enum: ["approve", "needs-attention"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "body"],
        properties: {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          title: { type: "string", minLength: 1 },
          body: { type: "string", minLength: 1 },
          file: { type: "string" },
          line_start: { type: "integer", minimum: 1 },
          line_end: { type: "integer", minimum: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          recommendation: { type: "string" }
        }
      }
    },
    next_steps: { type: "array", items: { type: "string" } }
  }
};

let activeCommandArgv = null;
let activeCommandConfig = null;
let activeCommandIngress = "argv";
let activeCommandOptions = null;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/grok-companion.mjs task [--prompt-file <path>] [--write] [--web] [--memory] [--background] [--resume <uuid>] [--resume-last] [--fresh] [--model <id>] [--effort <level>] [--max-turns <n>] [--cwd <dir>] [--json] [--] [prompt]",
      "  node scripts/grok-companion.mjs review [--base <ref>] [--focus <text>] [--cwd <dir>] [--background] [--json]",
      "  node scripts/grok-companion.mjs status [job-id] [--cwd <dir>] [--json]",
      "  node scripts/grok-companion.mjs history [--all] [--limit <n>] [--cwd <dir>] [--json]",
      "  node scripts/grok-companion.mjs result <job-id> [--cwd <dir>] [--wait] [--wait-timeout-ms <ms>] [--json]",
      "  node scripts/grok-companion.mjs cancel <job-id> [--cwd <dir>] [--json]",
      "  node scripts/grok-companion.mjs record-acceptance --job-id <32 lowercase hex> --acceptance <accepted|rejected|unverified> [--reason <text>] [--failure-kind <intent_override|scope_rewrite|wrong_approach|style_mismatch>] [--accept-failed-transport]",
      "  node scripts/grok-companion.mjs stats [--all] [--cwd <dir>] [--json]",
      "  node scripts/grok-companion.mjs setup [--continuity <manual|claude-session>] [--enable-stop-gate] [--disable-stop-gate] [--json]",
      "  node scripts/grok-companion.mjs stop-gate"
    ].join("\n")
  );
}

function recordAcceptanceArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--accept-failed-transport") {
      if (options.acceptFailedTransport) {
        throw errorWithFailure("The --accept-failed-transport option may be provided only once.", "input");
      }
      options.acceptFailedTransport = true;
      continue;
    }
    const key = token === "--job-id" ? "jobId" : token === "--acceptance" ? "acceptance" : token === "--reason" ? "reason" : token === "--failure-kind" ? "failureKind" : null;
    if (!key) {
      throw errorWithFailure("The record-acceptance command accepts only --job-id, --acceptance, --reason, --failure-kind, and --accept-failed-transport.", "input");
    }
    if (Object.hasOwn(options, key)) {
      throw errorWithFailure(`${token} may be provided only once.`, "input");
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw errorWithFailure(`${token} requires a value.`, "input");
    }
    options[key] = value;
    index += 1;
  }
  if (!RECORD_ACCEPTANCE_JOB_ID_PATTERN.test(options.jobId ?? "")) {
    throw errorWithFailure("The --job-id option must be a 32 character lowercase hexadecimal job id.", "input");
  }
  if (!RECORD_ACCEPTANCE_VALUES.has(options.acceptance)) {
    throw errorWithFailure("The --acceptance option must be accepted, rejected, or unverified.", "input");
  }
  if (options.failureKind !== undefined && !SEMANTIC_FAILURE_KINDS.has(options.failureKind)) {
    throw errorWithFailure("The --failure-kind option must be intent_override, scope_rewrite, wrong_approach, or style_mismatch.", "input");
  }
  if (options.failureKind !== undefined && options.acceptance !== "rejected") {
    throw errorWithFailure("The --failure-kind option is valid only with --acceptance rejected.", "input");
  }
  if (options.acceptance === "rejected" && !options.reason?.trim()) {
    throw errorWithFailure("A rejected acceptance requires --reason.", "input");
  }
  return options;
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

function shellSafeTemporaryRoot() {
  const candidates = [os.tmpdir(), process.platform === "win32" ? "C:\\Windows\\Temp" : "/private/tmp", "/tmp"];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate) || !/^[A-Za-z0-9_./:\\-]+$/.test(candidate)) {
      continue;
    }
    try {
      const stats = fs.lstatSync(candidate);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        continue;
      }
      fs.accessSync(candidate, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  throw errorWithFailure("No private shell safe temporary directory is available for raw command transport.", "resource");
}

function transportPaths(token) {
  if (!TRANSPORT_TOKEN_PATTERN.test(token)) {
    throw errorWithFailure("The raw command transport token is invalid.", "input");
  }
  const directory = path.join(shellSafeTemporaryRoot(), `${TRANSPORT_DIRECTORY_PREFIX}${token}`);
  return { directory, file: path.join(directory, "request"), ownerFile: path.join(directory, TRANSPORT_OWNER_FILE) };
}

function validateOwnedPath(stats, label) {
  if (typeof process.getuid === "function" && Number.isInteger(stats.uid) && stats.uid !== process.getuid()) {
    throw errorWithFailure(`${label} is not owned by the current user.`, "permission");
  }
}

function transportSessionHash(sessionId) {
  return typeof sessionId === "string" && sessionId.trim()
    ? createHash("sha256").update(sessionId.trim()).digest("hex")
    : null;
}

function sameFileIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function readTransportOwner(ownerFile) {
  let descriptor;
  try {
    const pathStats = fs.lstatSync(ownerFile);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1 || pathStats.size > TRANSPORT_OWNER_MAX_BYTES) {
      throw errorWithFailure("The raw command transport owner record is invalid.", "permission");
    }
    validateOwnedPath(pathStats, "The raw command transport owner record");
    if (process.platform !== "win32" && (pathStats.mode & 0o077) !== 0) {
      throw errorWithFailure("The raw command transport owner record is not private.", "permission");
    }
    descriptor = fs.openSync(ownerFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const openedStats = fs.fstatSync(descriptor);
    if (!openedStats.isFile() || openedStats.nlink !== 1 || !sameFileIdentity(openedStats, pathStats)) {
      throw errorWithFailure("The raw command transport owner record changed before it could be read.", "permission");
    }
    const buffer = Buffer.alloc(TRANSPORT_OWNER_MAX_BYTES + 1);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > TRANSPORT_OWNER_MAX_BYTES) {
      throw errorWithFailure("The raw command transport owner record is invalid.", "permission");
    }
    const record = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (!Number.isSafeInteger(record?.createdAt) || record.createdAt <= 0 || (record.sessionHash !== null && !/^[a-f0-9]{64}$/.test(record.sessionHash))) {
      throw errorWithFailure("The raw command transport owner record is invalid.", "permission");
    }
    return { identity: pathStats, record };
  } catch (error) {
    if (error?.failureKind) {
      throw error;
    }
    throw errorWithFailure(`Could not read raw command transport owner record: ${error.message}`, "permission");
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function cleanupVerifiedTransport(directory, file, ownerFile, directoryIdentity, fileIdentity, ownerIdentity, options = {}) {
  if (!directoryIdentity || !fileIdentity || !ownerIdentity) {
    return;
  }
  try {
    const currentDirectory = fs.lstatSync(directory);
    if (!currentDirectory.isDirectory() || currentDirectory.isSymbolicLink() || !sameFileIdentity(currentDirectory, directoryIdentity)) {
      return;
    }
    validateOwnedPath(currentDirectory, "The raw command transport directory");
    if (process.platform !== "win32" && (currentDirectory.mode & 0o077) !== 0) {
      return;
    }
    const currentFile = fs.lstatSync(file);
    if (!currentFile.isFile() || currentFile.isSymbolicLink() || currentFile.nlink !== 1 || !sameFileIdentity(currentFile, fileIdentity)) {
      return;
    }
    validateOwnedPath(currentFile, "The raw command transport file");
    if (options.requirePrivateFile && process.platform !== "win32" && (currentFile.mode & 0o077) !== 0) {
      return;
    }
    const currentOwner = fs.lstatSync(ownerFile);
    if (!currentOwner.isFile() || currentOwner.isSymbolicLink() || currentOwner.nlink !== 1 || !sameFileIdentity(currentOwner, ownerIdentity)) {
      return;
    }
    validateOwnedPath(currentOwner, "The raw command transport owner record");
    if (process.platform !== "win32" && (currentOwner.mode & 0o077) !== 0) {
      return;
    }
    fs.unlinkSync(file);
    fs.unlinkSync(ownerFile);
    fs.rmdirSync(directory);
  } catch {}
}

function cleanupRawCommandTransports(options = {}) {
  let root;
  let entries;
  try {
    root = shellSafeTemporaryRoot();
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const sessionHash = options.sessionHash ?? null;
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TRANSPORT_DIRECTORY_PREFIX)) {
      continue;
    }
    const token = entry.name.slice(TRANSPORT_DIRECTORY_PREFIX.length);
    if (!TRANSPORT_TOKEN_PATTERN.test(token)) {
      continue;
    }
    const { directory, file, ownerFile } = transportPaths(token);
    try {
      const directoryIdentity = fs.lstatSync(directory);
      if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink()) {
        continue;
      }
      validateOwnedPath(directoryIdentity, "The raw command transport directory");
      if (process.platform !== "win32" && (directoryIdentity.mode & 0o077) !== 0) {
        continue;
      }
      const { identity: ownerIdentity, record } = readTransportOwner(ownerFile);
      const fileIdentity = fs.lstatSync(file);
      if (!fileIdentity.isFile() || fileIdentity.isSymbolicLink() || fileIdentity.nlink !== 1) {
        continue;
      }
      validateOwnedPath(fileIdentity, "The raw command transport file");
      if (process.platform !== "win32" && (fileIdentity.mode & 0o077) !== 0) {
        continue;
      }
      if (options.expiredOnly) {
        const ageMs = now - record.createdAt;
        if (ageMs < 0 || ageMs <= TRANSPORT_MAX_AGE_MS) {
          continue;
        }
      } else if (!sessionHash || record.sessionHash !== sessionHash) {
        continue;
      }
      cleanupVerifiedTransport(directory, file, ownerFile, directoryIdentity, fileIdentity, ownerIdentity, {
        requirePrivateFile: true
      });
    } catch {}
  }
}

export function cleanupRawCommandTransportsForSession(sessionId) {
  const sessionHash = transportSessionHash(sessionId);
  if (!sessionHash) {
    return;
  }
  cleanupRawCommandTransports({ sessionHash });
}

function createRawCommandTransport() {
  cleanupRawCommandTransports({ expiredOnly: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = randomBytes(24).toString("hex");
    const { directory, file, ownerFile } = transportPaths(token);
    let directoryCreated = false;
    let fileCreated = false;
    let ownerCreated = false;
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      directoryCreated = true;
      fs.chmodSync(directory, 0o700);
      const descriptor = fs.openSync(file, "wx", 0o600);
      fileCreated = true;
      fs.closeSync(descriptor);
      fs.chmodSync(file, 0o600);
      fs.writeFileSync(ownerFile, `${JSON.stringify({ createdAt: Date.now(), sessionHash: transportSessionHash(currentClaudeSessionId()) })}\n`, {
        flag: "wx",
        mode: 0o600
      });
      ownerCreated = true;
      fs.chmodSync(ownerFile, 0o600);
      output({ file, token }, true);
      return;
    } catch (error) {
      if (ownerCreated || directoryCreated) {
        try {
          fs.unlinkSync(ownerFile);
        } catch {}
      }
      if (fileCreated) {
        try {
          fs.unlinkSync(file);
        } catch {}
      }
      if (directoryCreated) {
        try {
          fs.rmdirSync(directory);
        } catch {}
      }
      if (error?.code !== "EEXIST") {
        throw errorWithFailure(`Could not create private raw command transport: ${error.message}`, "permission");
      }
    }
  }
  throw errorWithFailure("Could not allocate a unique raw command transport.", "resource");
}

function readBoundedDescriptor(descriptor, limit) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
    if (bytesRead === 0) {
      break;
    }
    total += bytesRead;
    if (total > limit) {
      throw errorWithFailure(`Raw command arguments exceeded the ${limit} byte limit.`, "resource");
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

function consumeRawCommandTransport(token) {
  const { directory, file, ownerFile } = transportPaths(token);
  let descriptor;
  let directoryIdentity = null;
  let fileIdentity = null;
  let ownerIdentity = null;
  try {
    const directoryStats = fs.lstatSync(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw errorWithFailure("The raw command transport directory is invalid.", "permission");
    }
    validateOwnedPath(directoryStats, "The raw command transport directory");
    if (process.platform !== "win32" && (directoryStats.mode & 0o077) !== 0) {
      throw errorWithFailure("The raw command transport directory is not private.", "permission");
    }
    directoryIdentity = directoryStats;
    const owner = readTransportOwner(ownerFile);
    ownerIdentity = owner.identity;
    if (owner.record.sessionHash !== transportSessionHash(currentClaudeSessionId())) {
      throw errorWithFailure("The raw command transport belongs to another Claude session.", "permission");
    }
    const pathStats = fs.lstatSync(file);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1) {
      throw errorWithFailure("The raw command transport must be a regular private file.", "permission");
    }
    validateOwnedPath(pathStats, "The raw command transport file");
    fileIdentity = pathStats;
    const transportAgeMs = Date.now() - owner.record.createdAt;
    if (transportAgeMs < 0 || transportAgeMs > TRANSPORT_MAX_AGE_MS) {
      throw errorWithFailure("The raw command transport has expired.", "input");
    }
    if (process.platform !== "win32" && (pathStats.mode & 0o077) !== 0) {
      throw errorWithFailure("The raw command transport file is not private.", "permission");
    }
    if (pathStats.size > MAX_RAW_ARGUMENT_BYTES) {
      throw errorWithFailure(`Raw command arguments exceeded the ${MAX_RAW_ARGUMENT_BYTES} byte limit.`, "resource");
    }
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const openedStats = fs.fstatSync(descriptor);
    if (!openedStats.isFile() || openedStats.nlink !== 1 || !sameFileIdentity(openedStats, pathStats)) {
      throw errorWithFailure("The raw command transport changed before it could be read.", "permission");
    }
    validateOwnedPath(openedStats, "The raw command transport file");
    if (process.platform !== "win32" && (openedStats.mode & 0o077) !== 0) {
      throw errorWithFailure("The raw command transport file is not private.", "permission");
    }
    const bytes = readBoundedDescriptor(descriptor, MAX_RAW_ARGUMENT_BYTES);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw errorWithFailure("Raw command arguments must be valid UTF-8.", "input");
    }
  } catch (error) {
    if (error?.failureKind) {
      throw error;
    }
    throw errorWithFailure(`Could not read raw command transport: ${error.message}`, error?.code === "ENOENT" ? "input" : "permission");
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    cleanupVerifiedTransport(directory, file, ownerFile, directoryIdentity, fileIdentity, ownerIdentity);
  }
}

function resolveCommandTransport(rawArgv) {
  const defaults = { defaultBackground: false, defaultWrite: false };
  const transportArgv = [...rawArgv];
  while (
    transportArgv[0] === "--transport-default-write" ||
    transportArgv[0] === "--transport-default-background"
  ) {
    const option = transportArgv.shift();
    const key = option === "--transport-default-write"
      ? "defaultWrite"
      : "defaultBackground";
    defaults[key] = true;
  }
  if (transportArgv[0] !== "--raw-args-token") {
    if (
      transportArgv.some((value) => value === "--raw-args-token") ||
      defaults.defaultWrite ||
      defaults.defaultBackground
    ) {
      throw errorWithFailure("Raw command transport options must not be combined with normal arguments.", "input");
    }
    return { argv: rawArgv, defaultBackground: false, defaultWrite: false, ingress: "argv" };
  }
  if (transportArgv.length !== 2) {
    throw errorWithFailure("Raw command transport requires exactly one token.", "input");
  }
  return {
    argv: [consumeRawCommandTransport(transportArgv[1])],
    ...defaults,
    ingress: "staged_file"
  };
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
  if (!JOB_ID_PATTERN.test(String(jobId ?? ""))) {
    throw inputError("Grok job ids must be exactly 32 lowercase hexadecimal characters.");
  }
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
  writePrivateDataFile(dataDir, "config.json", `${JSON.stringify(next, null, 2)}\n`);
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

function continuityPolicy(dataDir, env = process.env) {
  const overridden = String(env[CONTINUITY_POLICY_ENV] ?? "").trim();
  if (CONTINUITY_POLICIES.has(overridden)) {
    return overridden;
  }
  const configured = String(readConfig(dataDir).continuityPolicy ?? "").trim();
  return CONTINUITY_POLICIES.has(configured) ? configured : "manual";
}

function parseContinuityPolicy(value) {
  const normalized = String(value ?? "").trim();
  if (!CONTINUITY_POLICIES.has(normalized)) {
    throw inputError("Expected --continuity to be manual or claude-session.");
  }
  return normalized;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw inputError(`Expected a positive integer for ${flag}.`);
  }
  return parsed;
}

function parseHistoryLimit(value) {
  const normalized = String(value ?? "");
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw inputError("Expected a positive integer for --limit.");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_HISTORY_LIMIT) {
    throw inputError(`Expected --limit between 1 and ${MAX_HISTORY_LIMIT}.`);
  }
  return parsed;
}

function parseNonnegativeInteger(value, flag) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw inputError(`Expected a non-negative integer for ${flag}.`);
  }
  return parsed;
}

function commandArgs(argv, config, transport) {
  activeCommandConfig = config;
  activeCommandOptions = null;
  try {
    const parsed = transport?.ingress === "staged_file" ? parseRawArgs(argv[0] ?? "", config) : { ...parseArgs(argv, config), positionalText: null };
    activeCommandOptions = parsed.options;
    return parsed;
  } catch (error) {
    if (error?.failureKind) {
      throw error;
    }
    throw inputError(error instanceof Error ? error.message : String(error));
  }
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

function readTaskPrompt(cwd, options, positionals, positionalText = null) {
  const positionalPrompt = positionalText ?? positionals.join(" ").trim();
  if (positionalPrompt.trim()) {
    return positionalPrompt;
  }
  if (options["prompt-file"]) {
    const promptFile = path.resolve(cwd, options["prompt-file"]);
    try {
      return fs.readFileSync(promptFile, "utf8").trim();
    } catch (error) {
      const failureKind = error?.code === "EACCES" || error?.code === "EPERM" ? "permission" : "input";
      throw errorWithFailure(`Could not read prompt file ${promptFile}: ${error.message}`, failureKind);
    }
  }
  return readStdinIfPiped().trim();
}

function isFusionRoutedPrompt(prompt) {
  return String(prompt ?? "")
    .split(/\r?\n/)
    .slice(0, 12)
    .some((line) => /^\s*(?:fusion-brief:\s*v1|grok-role:|lane:\s*panel\b)/i.test(line));
}

function grokRoleFromPrompt(prompt) {
  for (const line of String(prompt ?? "").split(/\r?\n/).slice(0, 12)) {
    const match = /\bgrok-role:\s*([^\s;,]+)/i.exec(line);
    if (match) {
      return GROK_ROLES.has(match[1]) ? match[1] : null;
    }
  }
  return null;
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

function ordinaryTaskRequest(request) {
  return (
    request &&
    typeof request === "object" &&
    !Array.isArray(request) &&
    Object.hasOwn(request, "model") &&
    Object.hasOwn(request, "effort") &&
    Object.hasOwn(request, "web") &&
    Object.hasOwn(request, "resumeSessionId")
  );
}

function jobClassForRecord(job) {
  const request = job?.request;
  if (request && typeof request === "object" && !Array.isArray(request) && typeof request.reviewTargetLabel === "string") {
    return "review";
  }
  if (job?.jobClass === "review" || job?.jobClass === "stop_gate") {
    return job.jobClass;
  }
  if ((job?.jobClass === "task" || job?.jobClass == null) && ordinaryTaskRequest(request)) {
    return "task";
  }
  return "unknown";
}

function memoryEnabledForRecord(job) {
  return job?.request?.memory === true;
}

function terminalJob(job) {
  return job?.status === "done" || job?.status === "error" || job?.status === "cancelled";
}

function resumeCompatible(job, mode, memory) {
  return (
    terminalJob(job) &&
    jobClassForRecord(job) === "task" &&
    normalizeGrokSessionId(job.sessionId) &&
    job.mode === mode &&
    job.request?.sandboxProfile === sandboxProfileForMode(mode) &&
    memoryEnabledForRecord(job) === memory
  );
}

function newestFirst(left, right) {
  return (
    String(right.finishedAt ?? right.createdAt ?? "").localeCompare(
      String(left.finishedAt ?? left.createdAt ?? "")
    ) || String(right.id ?? "").localeCompare(String(left.id ?? ""))
  );
}

function sessionMemoryModes(jobs) {
  const memoryModesBySession = new Map();
  for (const job of jobs) {
    const sessionId = normalizeGrokSessionId(job.sessionId);
    if (!sessionId || !terminalJob(job) || jobClassForRecord(job) !== "task") {
      continue;
    }
    const modes = memoryModesBySession.get(sessionId) ?? new Set();
    modes.add(memoryEnabledForRecord(job));
    memoryModesBySession.set(sessionId, modes);
  }
  return memoryModesBySession;
}

function resumableJobs(dataDir, cwd, mode, memory, options = {}) {
  const jobs = listJobRecords(dataDir, cwd);
  const memoryModesBySession = sessionMemoryModes(jobs);
  return jobs
    .filter((job) => resumeCompatible(job, mode, memory))
    .filter((job) => memoryModesBySession.get(normalizeGrokSessionId(job.sessionId))?.size === 1)
    .filter((job) => !options.doneOnly || job.status === "done")
    .sort(newestFirst);
}

function resolveLastSessionJob(dataDir, cwd, claudeSessionId, mode, memory, options = {}) {
  const finished = resumableJobs(dataDir, cwd, mode, memory, options);
  if (claudeSessionId) {
    const owned = finished.filter((job) => job.claudeSessionId === claudeSessionId);
    if (owned.length === 0) {
      if (options.optional) {
        return null;
      }
      throw inputError(`No finished ${mode} grok task with a compatible sandbox and memory mode was found for Claude session ${claudeSessionId} in this workspace.`);
    }
    return owned[0];
  }
  if (finished.length === 0) {
    if (options.optional) {
      return null;
    }
    throw inputError(`No finished ${mode} grok task with a compatible sandbox and memory mode was found for this workspace.`);
  }
  return finished[0];
}

export function resolveLastSessionId(dataDir, cwd, claudeSessionId, mode = "consult", memory = false) {
  return normalizeGrokSessionId(resolveLastSessionJob(dataDir, cwd, claudeSessionId, mode, memory).sessionId);
}

function validateResumeSession(dataDir, cwd, sessionId, mode, memory) {
  const normalizedSessionId = normalizeGrokSessionId(sessionId);
  if (!normalizedSessionId) {
    throw inputError("Grok session ids must be UUIDs returned by the companion.");
  }
  const allSessionJobs = listJobRecords(dataDir, cwd).filter(
    (job) => terminalJob(job) && normalizeGrokSessionId(job.sessionId) === normalizedSessionId
  );
  const taskJobs = allSessionJobs.filter((job) => jobClassForRecord(job) === "task");
  const memoryModes = new Set(taskJobs.map(memoryEnabledForRecord));
  if (memoryModes.size > 1) {
    throw inputError(`Grok session ${normalizedSessionId} has inconsistent recorded memory modes and cannot be resumed safely.`);
  }
  const compatible = taskJobs
    .filter(
      (job) =>
        job.mode === mode &&
        job.request?.sandboxProfile === sandboxProfileForMode(mode)
    )
    .sort(newestFirst);
  if (compatible.length > 0) {
    if (memoryEnabledForRecord(compatible[0]) !== memory) {
      const requiredFlag = memoryEnabledForRecord(compatible[0]) ? " with --memory" : " without --memory";
      throw inputError(`Grok session ${normalizedSessionId} must be resumed${requiredFlag} to preserve its recorded memory boundary.`);
    }
    return compatible[0];
  }
  if (taskJobs.length > 0) {
    throw inputError(`Grok session ${normalizedSessionId} cannot resume in ${mode} mode because its recorded sandbox profile is incompatible. Start a fresh task.`);
  }
  if (allSessionJobs.length > 0) {
    throw inputError(`Grok session ${normalizedSessionId} belongs to a non-task job and cannot be resumed.`);
  }
  throw inputError(`No finished companion task owns Grok session ${normalizedSessionId} in this workspace.`);
}

export function validateResumeSessionId(dataDir, cwd, sessionId, mode, memory = false) {
  return normalizeGrokSessionId(validateResumeSession(dataDir, cwd, sessionId, mode, memory).sessionId);
}

const PERMISSION_FAILURE_MESSAGE =
  "Grok's turn was cancelled by the consult-mode permission gate (a tool call outside the hard read-only tool set). Re-dispatch with --write if repository changes or command execution are acceptable, or rewrite the brief to use file reading and search only.";

function isPermissionCancelled(result) {
  return Boolean(result) && result.exitCode === 0 && !result.timedOut && result.stopReason === "Cancelled";
}

function permissionFailureMessage(result) {
  const blocked = result?.blockedPermissionCall ?? null;
  const hasBlockedTool = Boolean(blocked && typeof blocked.tool === "string" && blocked.tool.trim());
  const deniedToolDetail = formatDeniedToolDetail(result?.deniedToolFromStderr ?? null);
  if (hasBlockedTool) {
    return PERMISSION_FAILURE_MESSAGE + formatBlockedPermissionCall(blocked) + deniedToolDetail;
  }
  if (deniedToolDetail) {
    return PERMISSION_FAILURE_MESSAGE + deniedToolDetail;
  }
  return PERMISSION_FAILURE_MESSAGE + formatBlockedPermissionCall(null);
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
  ["sandbox", /sandbox (?:enforcement failed|could not be applied|initialization failed)/i],
  ["turn_limit", /max turns reached/i],
  ["permission", /operation not permitted|permission denied|\bEACCES\b|\bEPERM\b|os error 1/i],
  ["transport", /prompt transport failed|closed stdin|broken pipe|\bEPIPE\b|valid JSON envelope/i],
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
  if (result?.securityFailureKind) {
    return result.securityFailureKind;
  }
  if (spawnError?.code === "ENOENT") {
    return "missing_cli";
  }
  if (spawnError?.code === "EACCES" || spawnError?.code === "EPERM") {
    return "permission";
  }
  if (result?.timedOut) {
    return "timeout";
  }
  if (result?.cancelledByCompanion) {
    return "cancelled";
  }
  if (result?.turnLimitReached) {
    return "turn_limit";
  }
  if (isPermissionCancelled(result)) {
    return "permission";
  }
  if (result?.promptTransportError || result?.parseError) {
    return "transport";
  }
  const resultEvidence = resultFailed(result)
    ? [result?.errorMessage, boundedTextTail(result?.text), boundedTextTail(result?.stdoutTail)].filter(Boolean).join("\n")
    : "";
  const tail = [String(logTail ?? ""), resultEvidence].filter(Boolean).join("\n");
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
  const terminalAttribution = patch?.status === "error" || patch?.status === "cancelled"
    ? terminalRecordAttribution(current, patch)
    : {};
  return updateJobRecordFile(jobFile, { ...patch, ...terminalAttribution });
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
    ...terminalRecordAttribution(current),
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
      ...terminalRecordAttribution(current),
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
  if (result == null) return false;
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
const MODEL_USAGE_FIELDS = {
  inputTokens: ["inputTokens", "input_tokens"],
  cacheReadInputTokens: ["cacheReadInputTokens", "cachedReadTokens", "cache_read_input_tokens"],
  outputTokens: ["outputTokens", "output_tokens"],
  modelCalls: ["modelCalls", "model_calls"]
};

function optionalBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function finiteTokenField(value, names) {
  const observed = [];
  for (const name of names) {
    if (value && Object.hasOwn(value, name)) {
      observed.push(value[name]);
    }
  }
  if (observed.length === 0 || observed.slice(1).some((candidate) => candidate !== observed[0])) {
    return null;
  }
  return Number.isSafeInteger(observed[0]) && observed[0] >= 0 ? observed[0] : null;
}

function tokenUsageObservation(value, { allowFullInput = false } = {}) {
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
  if (usage.reasoningTokens != null && usage.outputTokens != null && usage.reasoningTokens > usage.outputTokens) {
    return { coverage: "incomplete", usage };
  }
  if (observedFields === TOKEN_USAGE_METRICS.length) {
    const uncachedTotal = BigInt(usage.inputTokens) + BigInt(usage.cacheReadInputTokens) + BigInt(usage.outputTokens);
    const fullInputTotal = BigInt(usage.inputTokens) + BigInt(usage.outputTokens);
    const reportedTotal = BigInt(usage.totalTokens);
    if (reportedTotal !== uncachedTotal && (!allowFullInput || reportedTotal !== fullInputTotal)) {
      return { coverage: "incomplete", usage };
    }
  }
  return {
    coverage: observedFields === TOKEN_USAGE_METRICS.length ? "complete" : "incomplete",
    usage
  };
}

function spendObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

function modelUsageObservation(value) {
  if (!spendObject(value)) {
    return { coverage: "unreported" };
  }
  const entries = Object.values(value);
  return {
    coverage: entries.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        Object.values(MODEL_USAGE_FIELDS).every((names) => finiteTokenField(entry, names) != null)
    )
      ? "complete"
      : "incomplete"
  };
}

function observedChannelIncomplete(explicitIncomplete, coverage) {
  if (explicitIncomplete === true || coverage === "incomplete") {
    return true;
  }
  if (coverage === "complete") {
    return false;
  }
  return explicitIncomplete;
}

function resultSpendPatch(result) {
  const explicitUsageIncomplete = optionalBoolean(result?.usageIsIncomplete);
  const usageIsIncomplete = observedChannelIncomplete(
    explicitUsageIncomplete,
    tokenUsageObservation(result?.usage).coverage
  );
  const modelUsageIsIncomplete = observedChannelIncomplete(
    null,
    modelUsageObservation(result?.modelUsage).coverage
  );
  return {
    requestId: result?.requestId ?? null,
    stopReason: result?.stopReason ?? null,
    numTurns: result?.numTurns ?? null,
    totalCostUsd: result?.totalCostUsd ?? null,
    totalCostUsdTicks: result?.totalCostUsdTicks ?? null,
    costIsPartial: optionalBoolean(result?.costIsPartial),
    resolvedModel: result?.resolvedModel ?? null,
    resolvedEffort: result?.resolvedEffort ?? null,
    usage: result?.usage ?? null,
    modelUsage: result?.modelUsage ?? null,
    usageIsIncomplete,
    modelUsageIsIncomplete,
    structuredOutput: result?.structuredOutput,
    structuredOutputError: result?.structuredOutputError
  };
}

function outcomeFields(record, status) {
  const deliveryStatus = record?.deliveryCollectedAt
    ? "collected"
    : record?.delivery === "foreground" && status !== "running"
      ? "delivered"
      : "pending";
  return {
    transportStatus: status,
    semanticStatus: record?.semanticStatus ?? "unverified",
    delivery: record?.delivery ?? (record?.background ? "manual" : "foreground"),
    deliveryStatus
  };
}

function observableRecord(record) {
  return {
    ...record,
    jobClass: jobClassForRecord(record),
    memoryEnabled: memoryEnabledForRecord(record)
  };
}

function taskSuccessPayload(record, result) {
  return {
    jobId: record.id,
    status: "done",
    ...outcomeFields(record, "done"),
    jobClass: jobClassForRecord(record),
    mode: record.mode,
    background: record.background,
    memoryEnabled: memoryEnabledForRecord(record),
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
    ...outcomeFields(record, status),
    jobClass: jobClassForRecord(record),
    mode: record?.mode ?? null,
    background: Boolean(record?.background),
    memoryEnabled: memoryEnabledForRecord(record),
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
    resultText: result.text ?? null,
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
        ...terminalRecordAttribution(current),
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

async function handleTask(argv, transport = {}) {
  const { options, positionals, positionalText } = commandArgs(argv, {
    valueOptions: ["prompt-file", "resume", "model", "effort", "max-turns", "cwd"],
    booleanOptions: ["write", "background", "resume-last", "fresh", "memory", "web", "json"],
    optionsBeforePositionals: true
  }, transport);

  const cwd = resolveCwd(options);
  const dataDir = resolveDataDir();
  const claudeSessionId = currentClaudeSessionId();

  const maxTurns = options["max-turns"] ? parsePositiveInteger(options["max-turns"], "--max-turns") : null;
  const write = options.write === undefined ? Boolean(transport.defaultWrite) : Boolean(options.write);
  const background = Boolean(options.background);
  const mode = write ? "write" : "consult";
  const memory = Boolean(options.memory);
  const selectedContinuityPolicy = continuityPolicy(dataDir);
  const explicitResume = options.resume != null;
  const resumeLast = Boolean(options["resume-last"]);
  const fresh = Boolean(options.fresh);

  if (explicitResume && resumeLast) {
    throw inputError("Use only one of --resume or --resume-last.");
  }
  if (fresh && (explicitResume || resumeLast)) {
    throw inputError("--fresh cannot be combined with --resume or --resume-last.");
  }
  let prompt = readTaskPrompt(cwd, options, positionals, positionalText);
  const fusionRouted = isFusionRoutedPrompt(prompt);
  if (memory && fusionRouted) {
    throw inputError("--memory is available only for direct ordinary tasks, not Fusion routed briefs.");
  }
  let resumeSource = null;
  let resumeReason = null;
  if (explicitResume) {
    resumeSource = validateResumeSession(dataDir, cwd, options.resume, mode, memory);
    resumeReason = "explicit";
  } else if (resumeLast) {
    resumeSource = resolveLastSessionJob(dataDir, cwd, claudeSessionId, mode, memory);
    resumeReason = "last";
  } else if (
    prompt &&
    !fresh &&
    selectedContinuityPolicy === "claude-session" &&
    claudeSessionId &&
    !fusionRouted
  ) {
    resumeSource = resolveLastSessionJob(dataDir, cwd, claudeSessionId, mode, memory, {
      doneOnly: true,
      optional: true
    });
    resumeReason = resumeSource ? "affinity" : null;
  }
  const resumeSessionId = resumeSource ? normalizeGrokSessionId(resumeSource.sessionId) : null;
  if (!prompt) {
    if (!resumeSessionId) {
      throw new Error("Provide a prompt, a prompt file, piped stdin, or a session to resume.");
    }
    prompt = CONTINUE_PROMPT;
  }
  const role = grokRoleFromPrompt(prompt);

  const jobId = generateJobId();
  const briefFile = briefPath(dataDir, cwd, jobId);
  const jobFile = jobFilePath(dataDir, cwd, jobId);
  const record = {
    ...createJobRecord({
      id: jobId,
      companionVersion: resolveGrokCompanionVersion(),
      pid: background ? null : process.pid,
      mode,
      cwd,
      briefFile,
      background,
      delivery: background ? backgroundDelivery() : "foreground",
      claudeSessionId,
      jobClass: "task",
      role,
      request: {
        model: options.model ?? null,
        effort: options.effort ?? null,
        maxTurns,
        web: Boolean(options.web),
        memory,
        sandboxProfile: sandboxProfileForMode(mode),
        resumeSessionId,
        resumeSourceJobId: resumeSource?.id ?? null,
        resumeReason,
        continuityPolicy: selectedContinuityPolicy,
        role,
        outputJson: Boolean(options.json),
        ingress: transport.ingress ?? "argv"
      }
    }),
    repositoryTopLevel: resolveRepositoryTopLevel(cwd)
  };
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

  if (background) {
    try {
      await spawnBackgroundWorker([SELF_PATH, "task-worker", "--job-id", jobId, "--cwd", cwd], jobFile);
    } catch (error) {
      recordSpawnFailure(jobFile, error);
      throw launchFailureError(error, jobId);
    }
    const payload = {
      jobId,
      status: "running",
      ...outcomeFields(record, "running"),
      jobClass: record.jobClass,
      mode,
      background: true,
      memoryEnabled: memory,
      resolvedModel: null,
      resolvedEffort: null,
      failureKind: null
    };
    output(options.json ? payload : renderBackgroundLaunch(jobId, record.delivery), options.json);
    return;
  }

  const logFile = jobLogPath(dataDir, cwd, jobId);
  const timeoutMs = resolveTimeoutMs({ env: process.env });
  let result;
  try {
    result = await runGrok({
      briefFile,
      prompt,
      mode,
      resumeSessionId,
      model: options.model ?? null,
      effort: options.effort ?? null,
      maxTurns,
      web: Boolean(options.web),
      memory,
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
  const successPatch = {
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
  };
  const final = finishSuccessfulJobRecordFile(jobFile, {
    ...successPatch,
    terminalAttribution: terminalRecordAttribution(record, successPatch)
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
    const prompt = fs.readFileSync(record.briefFile, "utf8");
    const result = await runGrok({
      briefFile: record.briefFile,
      prompt,
      mode: record.mode,
      resumeSessionId: request.resumeSessionId ?? null,
      model: request.model ?? null,
      effort: request.effort ?? null,
      maxTurns: request.maxTurns ?? null,
      web: Boolean(request.web),
      memory: request.memory === true,
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
      resultText: result.text ?? null,
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

function resolveRepositoryTopLevel(cwd) {
  try {
    const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    const value = String(result.stdout ?? "").trim();
    return value || null;
  } catch {
    return null;
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

function evaluateReviewResult(result) {
  if (typeof result?.structuredOutputError === "string" && result.structuredOutputError.trim()) {
    return { valid: false, error: oneLineSummary(result.structuredOutputError) };
  }
  if (result?.structuredOutput !== undefined) {
    const validation = validateReviewOutput(result.structuredOutput);
    return validation.valid
      ? { valid: true, value: validation.value }
      : { valid: false, error: validation.error };
  }
  return evaluateReviewText(result?.text);
}

async function runReviewJob(record, jobFile, options = {}) {
  const logFile = jobLogPath(resolveDataDir(), record.cwd, record.id);
  const timeoutMs = resolveTimeoutMs({ background: Boolean(options.background), env: process.env });
  let first;
  try {
    const prompt = fs.readFileSync(record.briefFile, "utf8");
    first = await runGrok({
      briefFile: record.briefFile,
      prompt,
      mode: "consult",
      jsonSchema: REVIEW_OUTPUT_SCHEMA,
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

  const review = evaluateReviewResult(first);
  const sessionId = first.sessionId;
  const finalText = first.text;
  const spend = resultSpendPatch(first);

  const targetLabel = record.request?.reviewTargetLabel ?? "working tree changes";
  const body = review.valid
    ? renderReviewResult(review.value, { targetLabel })
    : renderReviewFallback(finalText, { parseError: review.error });
  const validationMessage = review.valid
    ? null
    : `Grok review output failed validation: ${review.error}`;

  const payload = {
    jobId: record.id,
    status: review.valid ? "done" : "error",
    ...outcomeFields(record, review.valid ? "done" : "error"),
    jobClass: "review",
    mode: "consult",
    background: record.background,
    memoryEnabled: false,
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

async function handleReview(argv, transport = {}) {
  const { options, positionals, positionalText } = commandArgs(argv, {
    valueOptions: ["base", "focus", "cwd"],
    booleanOptions: ["background", "json"],
    optionsBeforePositionals: true
  }, transport);

  const cwd = resolveCwd(options);
  const dataDir = resolveDataDir();
  const background = transport.defaultBackground ? true : Boolean(options.background);
  ensureGitRepository(cwd);

  const target = collectReviewTarget(cwd, options.base);
  if (!target.diff.trim()) {
    throw new Error("No changes found to review.");
  }

  const focus = [options.focus ?? "", positionalText ?? positionals.join(" ")].join(" ").trim();
  const prompt = interpolateTemplate(loadReviewTemplate(), {
    TARGET_LABEL: target.label,
    USER_FOCUS: focus || "No extra focus provided.",
    DIFF: target.diff
  });

  const jobId = generateJobId();
  const briefFile = briefPath(dataDir, cwd, jobId);
  const jobFile = jobFilePath(dataDir, cwd, jobId);
  const record = {
    ...createJobRecord({
      id: jobId,
      companionVersion: resolveGrokCompanionVersion(),
      pid: background ? null : process.pid,
      mode: "consult",
      cwd,
      briefFile,
      background,
      delivery: background ? backgroundDelivery() : "foreground",
      claudeSessionId: currentClaudeSessionId(),
      jobClass: "review",
      request: {
        reviewTargetLabel: target.label,
        memory: false,
        sandboxProfile: sandboxProfileForMode("consult"),
        outputJson: Boolean(options.json),
        ingress: transport.ingress ?? "argv"
      }
    }),
    repositoryTopLevel: resolveRepositoryTopLevel(cwd)
  };
  createJobRecordFile(jobFile, record);
  try {
    writeBrief(dataDir, cwd, jobId, prompt);
  } catch (error) {
    recordSpawnFailure(jobFile, error);
    throw launchFailureError(error, jobId);
  }

  if (background) {
    try {
      await spawnBackgroundWorker([SELF_PATH, "review-worker", "--job-id", jobId, "--cwd", cwd], jobFile);
    } catch (error) {
      recordSpawnFailure(jobFile, error);
      throw launchFailureError(error, jobId);
    }
    const payload = {
      jobId,
      status: "running",
      ...outcomeFields(record, "running"),
      jobClass: "review",
      mode: "consult",
      background: true,
      memoryEnabled: false,
      resolvedModel: null,
      resolvedEffort: null,
      failureKind: null
    };
    output(options.json ? payload : renderBackgroundLaunch(jobId, record.delivery), options.json);
    return;
  }

  const payload = await runReviewJob(record, jobFile);
  if (!payload.valid) {
    throw new Error(
      failureOutcomeMessage({
        message: `Grok review output failed validation: ${payload.parseError}`,
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

function handleStatus(argv, transport = {}) {
  const { options, positionals } = commandArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  }, transport);

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
    const observed = observableRecord(record);
    output(options.json ? observed : renderJobDetail(observed, { logTail }), options.json);
    if (record.cleanupRequired) {
      process.exitCode = 1;
    }
    return;
  }

  const cwd = resolveCwd(options);
  const jobs = listJobRecords(dataDir, cwd).map((record) =>
    refreshRunningJobRecord({ record, file: jobFilePath(dataDir, cwd, record.id) }).record
  );
  output(options.json ? { jobs: jobs.map(observableRecord) } : renderStatusTable(jobs, currentClaudeSessionId()), options.json);
  if (jobs.some((record) => record.cleanupRequired)) {
    process.exitCode = 1;
  }
}

function historyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function historyTimestamp(value) {
  const normalized = historyString(value);
  return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : null;
}

function historyEnum(value, allowed, fallback = "unknown") {
  return allowed.has(value) ? value : fallback;
}

function historyJob(record, claudeSessionId, mixedMemorySessions) {
  const mode = historyEnum(record?.mode, HISTORY_MODES);
  const sessionId = normalizeGrokSessionId(record?.sessionId);
  const jobClass = jobClassForRecord(record);
  const resumable =
    terminalJob(record) &&
    jobClass === "task" &&
    sessionId != null &&
    mode !== "unknown" &&
    record?.request?.sandboxProfile === sandboxProfileForMode(mode) &&
    !mixedMemorySessions.has(sessionId);
  return {
    jobId: JOB_ID_PATTERN.test(String(record?.id ?? "")) ? record.id : null,
    sessionId,
    cwd: typeof record?.cwd === "string" && path.isAbsolute(record.cwd) ? path.normalize(record.cwd) : null,
    status: historyEnum(record?.status, HISTORY_STATUSES),
    jobClass,
    mode,
    background: record?.background === true,
    delivery: historyEnum(record?.delivery, HISTORY_DELIVERIES),
    deliveryStatus: historyEnum(record?.deliveryStatus, HISTORY_DELIVERY_STATUSES),
    semanticStatus: historyEnum(record?.semanticStatus, HISTORY_SEMANTIC_STATUSES),
    cleanupRequired: record?.cleanupRequired === true,
    failureKind: historyEnum(record?.failureKind, HISTORY_FAILURE_KINDS, null),
    resolvedModel: historyString(record?.resolvedModel),
    resolvedEffort: historyString(record?.resolvedEffort),
    memoryEnabled: memoryEnabledForRecord(record),
    createdAt: historyTimestamp(record?.createdAt),
    finishedAt: historyTimestamp(record?.finishedAt),
    resumable,
    resumeMode: resumable ? mode : null,
    ownedByCurrentSession: claudeSessionId == null ? null : record?.claudeSessionId === claudeSessionId
  };
}

function handleHistory(argv, transport = {}) {
  const { options, positionals } = commandArgs(argv, {
    valueOptions: ["limit", "cwd"],
    booleanOptions: ["all", "json"]
  }, transport);
  if (positionals.length > 0) {
    throw inputError("History accepts only --all, --limit, --cwd, and --json.");
  }

  const dataDir = resolveDataDir();
  const cwd = options.all ? null : resolveCwd(options);
  const limit = options.limit === undefined ? DEFAULT_HISTORY_LIMIT : parseHistoryLimit(options.limit);
  const entries = options.all
    ? listAllJobRecords(dataDir)
    : listJobRecords(dataDir, cwd).map((record) => ({
        record,
        file: jobFilePath(dataDir, cwd, record.id)
      }));
  const totalJobs = entries.length;
  const selected = entries.slice(0, limit);
  const claudeSessionId = currentClaudeSessionId();
  const mixedMemorySessions = new Set(
    [...sessionMemoryModes(entries.map((entry) => entry.record))]
      .filter(([, modes]) => modes.size > 1)
      .map(([sessionId]) => sessionId)
  );
  const jobs = selected.map((entry) =>
    historyJob(refreshRunningJobRecord(entry).record, claudeSessionId, mixedMemorySessions)
  );
  const report = {
    source: "canonical",
    scope: options.all ? "all" : "workspace",
    cwd,
    limit,
    totalJobs,
    returnedJobs: jobs.length,
    truncated: totalJobs > jobs.length,
    jobs
  };
  output(options.json ? report : renderHistoryReport(report), options.json);
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

function jsonResultPayload(record, dataDir, options = {}) {
  const deliveryView = observableRecord(
    options.collecting ? { ...record, deliveryCollectedAt: nowIso() } : record
  );
  if (!record.request?.outputJson || record.status === "running") {
    return deliveryView;
  }
  if (record.resultPayload) {
    return {
      ...record.resultPayload,
      ...outcomeFields(deliveryView, record.status),
      jobClass: deliveryView.jobClass,
      memoryEnabled: deliveryView.memoryEnabled,
      resolvedModel: record.resolvedModel ?? record.resultPayload.resolvedModel ?? null,
      resolvedEffort: record.resolvedEffort ?? record.resultPayload.resolvedEffort ?? null
    };
  }
  if (record.status === "done") {
    return taskSuccessPayload(deliveryView, {
      exitCode: record.exitCode,
      sessionId: record.sessionId,
      stopReason: record.stopReason ?? null,
      resolvedModel: record.resolvedModel ?? null,
      resolvedEffort: record.resolvedEffort ?? null,
      usage: record.usage,
      modelUsage: record.modelUsage,
      usageIsIncomplete: record.usageIsIncomplete,
      modelUsageIsIncomplete: record.modelUsageIsIncomplete,
      text: record.resultText ?? ""
    });
  }
  const failureKind = record.failureKind ?? (record.status === "cancelled" ? "cancelled" : "error");
  return failureResultPayload(deliveryView, {
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

async function handleResult(argv, transport = {}) {
  const { options, positionals } = commandArgs(argv, {
    valueOptions: ["cwd", "wait-timeout-ms"],
    booleanOptions: ["json", "wait"]
  }, transport);

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
  const markCollected = record.status !== "running" && record.delivery !== "foreground";
  if (record.cleanupRequired) {
    process.exitCode = 1;
  }
  if (options.json) {
    output(jsonResultPayload(record, dataDir, { collecting: markCollected }), true);
    if (markCollected) {
      markDeliveryCollectedFile(found.file);
    }
    return;
  }

  if (options.wait && record.status === "running") {
    output(renderRunningWaitResult(record), false);
    return;
  }

  output(renderResultRecord(record, dataDir), false);
  if (markCollected) {
    markDeliveryCollectedFile(found.file);
  }
}

async function handleCancel(argv, transport = {}) {
  const { options, positionals } = commandArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  }, transport);

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
      ...terminalRecordAttribution(current),
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
  const next = {};
  for (const metric of TOKEN_USAGE_METRICS) {
    next[metric] = target[metric] + usage[metric];
    if (!Number.isSafeInteger(next[metric])) {
      return false;
    }
  }
  for (const metric of TOKEN_USAGE_METRICS) {
    target[metric] = next[metric];
  }
  return true;
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
    const observed = tokenUsageObservation(entry, { allowFullInput: true });
    if (observed.coverage === "complete") {
      if (!addTokenUsage(combined, observed.usage)) {
        return { coverage: "incomplete", usage: null };
      }
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
  const direct = tokenUsageObservation(record.usage, {
    allowFullInput: Boolean(record.usage) && !Object.hasOwn(record.usage, "input_tokens") && Object.hasOwn(record.usage, "inputTokens")
  });
  if (direct.coverage === "complete" && !usageIsIncomplete) {
    return direct;
  }
  const byModel = tokenUsageFromModels(record.modelUsage);
  const modelBlocked = usageIsIncomplete || modelUsageIsIncomplete === true;
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
  if (typeof record.resolvedModel === "string" && record.resolvedModel.trim()) {
    return [record.resolvedModel.trim()];
  }
  const requested = record.request?.model;
  return typeof requested === "string" && requested.trim() ? [requested.trim()] : ["unknown"];
}

function resolvedModelForRecord(record) {
  if (typeof record.resolvedModel === "string" && record.resolvedModel.trim()) {
    return record.resolvedModel.trim();
  }
  if (record.modelUsage && typeof record.modelUsage === "object" && !Array.isArray(record.modelUsage)) {
    const names = Object.keys(record.modelUsage).filter((name) => name.trim());
    if (names.length === 1) {
      return names[0];
    }
  }
  return "unknown";
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

const USD_TICKS = 10_000_000_000;

function exactCostTicksForRecord(record) {
  const costIsPartial = record.costIsPartial === true || record.cost_is_partial === true;
  const usageIsIncomplete = record.usageIsIncomplete === true || record.usage_is_incomplete === true;
  const modelUsageIsIncomplete = record.modelUsageIsIncomplete === true;
  const totalCostUsdTicks = record.totalCostUsdTicks ?? record.total_cost_usd_ticks;
  const totalCostUsd = record.totalCostUsd ?? record.total_cost_usd;
  if (
    costIsPartial ||
    usageIsIncomplete ||
    modelUsageIsIncomplete ||
    !Number.isSafeInteger(totalCostUsdTicks) ||
    totalCostUsdTicks <= 0 ||
    !Number.isFinite(totalCostUsd) ||
    totalCostUsd <= 0
  ) {
    return null;
  }
  const derivedUsd = totalCostUsdTicks / USD_TICKS;
  const tolerance = Math.max(1e-12, Math.abs(derivedUsd) * Number.EPSILON * 8);
  return Math.abs(totalCostUsd - derivedUsd) <= tolerance ? totalCostUsdTicks : null;
}

function aggregateJobStats(records, dataDir) {
  const byStatus = {};
  const byMode = {};
  const byFailureKind = {};
  const byModel = {};
  const byResolvedModel = {};
  const byResolvedEffort = {};
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
  const headlessMetrics = {
    turnsReportedJobs: 0,
    totalTurns: 0,
    exactCostJobs: 0,
    partialCostJobs: 0,
    unreportedCostJobs: 0,
    totalCostUsdTicks: 0
  };
  let usageAggregationOverflow = false;
  let turnAggregationOverflow = false;
  let costAggregationOverflow = false;
  const doneDurations = [];
  let earliest = null;
  let latest = null;

  for (const record of records) {
    increment(byStatus, record.status ?? "unknown");
    increment(byMode, record.mode ?? "unknown");
    for (const model of modelNamesForRecord(record)) {
      increment(byModel, model);
    }
    increment(byResolvedModel, resolvedModelForRecord(record));
    increment(byResolvedEffort, typeof record.resolvedEffort === "string" && record.resolvedEffort.trim() ? record.resolvedEffort.trim() : "unknown");
    const recordUsage = tokenUsageForRecord(record);
    if (recordUsage.coverage === "complete") {
      if (!usageAggregationOverflow && !addTokenUsage(usage, recordUsage.usage)) {
        usageAggregationOverflow = true;
      }
      usage.reportedJobs += 1;
      usageCoverage.completeJobs += 1;
    } else if (recordUsage.coverage === "incomplete") {
      usageCoverage.incompleteJobs += 1;
    } else {
      usageCoverage.unreportedJobs += 1;
    }
    const numTurns = record.numTurns ?? record.num_turns;
    if (Number.isSafeInteger(numTurns) && numTurns >= 0) {
      headlessMetrics.turnsReportedJobs += 1;
      const totalTurns = headlessMetrics.totalTurns + numTurns;
      if (Number.isSafeInteger(totalTurns)) {
        headlessMetrics.totalTurns = totalTurns;
      } else {
        turnAggregationOverflow = true;
      }
    }
    const costTicks = exactCostTicksForRecord(record);
    const costIsPartial = record.costIsPartial === true || record.cost_is_partial === true;
    const usageIsIncomplete = record.usageIsIncomplete === true || record.usage_is_incomplete === true;
    const modelUsageIsIncomplete = record.modelUsageIsIncomplete === true;
    const hasAnyCost = record.totalCostUsd != null || record.totalCostUsdTicks != null || record.total_cost_usd != null || record.total_cost_usd_ticks != null;
    if (costTicks != null) {
      headlessMetrics.exactCostJobs += 1;
      const totalCostUsdTicks = headlessMetrics.totalCostUsdTicks + costTicks;
      if (Number.isSafeInteger(totalCostUsdTicks)) {
        headlessMetrics.totalCostUsdTicks = totalCostUsdTicks;
      } else {
        costAggregationOverflow = true;
      }
    } else if (costIsPartial || usageIsIncomplete || modelUsageIsIncomplete || hasAnyCost) {
      headlessMetrics.partialCostJobs += 1;
    } else {
      headlessMetrics.unreportedCostJobs += 1;
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
    byResolvedModel,
    byResolvedEffort,
    usage: usage.reportedJobs > 0 && !usageAggregationOverflow ? usage : null,
    usageCoverage: {
      availability:
        usageAggregationOverflow
          ? "overflow"
          : usageCoverage.completeJobs === 0
          ? "unavailable"
          : usageCoverage.completeJobs === records.length
            ? "available"
            : "partial",
      ...usageCoverage,
      ...(usageAggregationOverflow ? { aggregationOverflow: true } : {})
    },
    headlessMetrics: {
      ...headlessMetrics,
      ...(turnAggregationOverflow ? { totalTurns: null, turnAggregationOverflow: true } : {}),
      ...(costAggregationOverflow
        ? { totalCostUsd: null, totalCostUsdTicks: null, costAggregationOverflow: true }
        : { totalCostUsd: Math.round((headlessMetrics.totalCostUsdTicks / USD_TICKS) * 1e12) / 1e12 })
    },
    meanWallClockSeconds,
    earliestCreatedAt: earliest,
    latestCreatedAt: latest
  };
}

function handleStats(argv, transport = {}) {
  const { options } = commandArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["all", "json"]
  }, transport);

  const dataDir = resolveDataDir();
  const cwd = resolveCwd(options);
  const records = options.all
    ? listAllJobRecords(dataDir).map((entry) => refreshRunningJobRecord(entry).record)
    : listJobRecords(dataDir, cwd).map((record) =>
        refreshRunningJobRecord({ record, file: jobFilePath(dataDir, cwd, record.id) }).record
      );
  const stats = {
    scope: options.all ? "all" : "workspace",
    cwd: options.all ? null : cwd,
    ...aggregateJobStats(records, dataDir)
  };
  output(options.json ? stats : renderStatsReport(stats), options.json);
}

const DOCTOR_PROBE_TIMEOUT_MS = 3000;

function doctorCommandAdvisory(bin, available) {
  if (!available) {
    return { available: false, detail: "grok is unavailable" };
  }
  const probe = spawnSync(bin, ["doctor", "--help"], { encoding: "utf8", timeout: DOCTOR_PROBE_TIMEOUT_MS });
  const supported = !probe.error && probe.status === 0;
  return {
    available: supported,
    detail: supported ? "grok doctor is available" : "grok doctor is not available on this Grok CLI"
  };
}

function handleSetup(argv, transport = {}) {
  const { options } = commandArgs(argv, {
    valueOptions: ["continuity"],
    booleanOptions: ["json", "enable-stop-gate", "disable-stop-gate"]
  }, transport);
  if (options["enable-stop-gate"] && options["disable-stop-gate"]) {
    throw new Error("Use either --enable-stop-gate or --disable-stop-gate, not both.");
  }
  const configuredContinuity =
    options.continuity === undefined ? null : parseContinuityPolicy(options.continuity);

  const bin = resolveGrokBin();
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
  const available = !probe.error && probe.status === 0;
  const detail = available
    ? (probe.stdout || probe.stderr).trim() || "ok"
    : probe.error?.code === "ENOENT"
      ? "not found on PATH"
      : (probe.stderr || probe.stdout || probe.error?.message || `exit ${probe.status}`).trim();

  const capabilityFlags = [
    "--prompt-file",
    "--output-format",
    "--sandbox",
    "--tools",
    "--disallowed-tools",
    "--deny",
    "--max-turns",
    "--no-auto-update",
    "--permission-mode",
    "--allow",
    "--disable-web-search",
    "--always-approve",
    "--json-schema",
    "--no-subagents",
    "--no-wait-for-background"
  ];
  let capabilities = { ready: false, detail: available ? "capability probe did not run" : "grok is unavailable", flags: {} };
  if (available) {
    try {
      const supported = resolveGrokCapabilities(bin, process.env);
      const flags = Object.fromEntries(capabilityFlags.map((flag) => [flag, supported.has(flag)]));
      const critical = capabilityFlags.filter((flag) => flag !== "--no-subagents");
      const missing = critical.filter((flag) => !flags[flag]);
      capabilities = {
        ready: missing.length === 0,
        detail: missing.length === 0 ? "required headless safety capabilities are available" : `missing ${missing.join(", ")}`,
        flags
      };
    } catch (error) {
      capabilities = { ready: false, detail: error instanceof Error ? error.message : String(error), flags: {} };
    }
  }

  const doctorCommand = doctorCommandAdvisory(bin, available);

  const dataDir = resolveDataDir();
  let writable = true;
  let writeDetail = dataDir;
  try {
    ensurePrivateDataDir(dataDir);
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
  if (configuredContinuity) {
    writeConfig(dataDir, { continuityPolicy: configuredContinuity });
  }

  const report = {
    ready: available && capabilities.ready && writable,
    grok: { available, detail, bin },
    capabilities,
    doctorCommand,
    dataDir: { path: dataDir, writable, detail: writeDetail },
    stopGate: Boolean(readConfig(dataDir).stopGate),
    continuityPolicy: continuityPolicy(dataDir)
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
  createJobRecordFile(jobFile, {
    ...createJobRecord({
      id: jobId,
      companionVersion: resolveGrokCompanionVersion(),
      pid: process.pid,
      mode: "consult",
      cwd,
      briefFile,
      background: false,
      claudeSessionId: input.session_id ?? currentClaudeSessionId(),
      jobClass: "stop_gate",
      request: {
        maxTurns: STOP_GATE_MAX_TURNS,
        memory: false,
        sandboxProfile: sandboxProfileForMode("consult")
      }
    }),
    repositoryTopLevel: resolveRepositoryTopLevel(cwd)
  });
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
      prompt,
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

function handleRecordAcceptance(argv) {
  const { acceptance, acceptFailedTransport, failureKind, jobId, reason } = recordAcceptanceArgs(argv);
  const found = findJobRecordById(resolveDataDir(), jobId);
  if (!found) {
    throw errorWithFailure(`No job record found for ${jobId}.`, "input");
  }
  const record = updateJobRecordFileWithCurrent(found.file, (current) => {
    if (acceptance === "accepted" && current.status !== "done" && !acceptFailedTransport) {
      throw errorWithFailure(
        `Grok job ${current.id} has transport status ${current.status}. Pass --accept-failed-transport to record accepted.`,
        "input"
      );
    }
    if (acceptance !== "rejected") {
      return {
        ...current,
        semanticFailureKind: null,
        semanticFailureMessage: null,
        semanticStatus: acceptance
      };
    }
    return {
      ...current,
      semanticFailureKind: failureKind ?? null,
      semanticFailureMessage: reason,
      semanticStatus: acceptance
    };
  }, { allowTerminal: true });
  output(renderRecordAcceptance(record), false);
}

async function main() {
  const [subcommand, ...receivedArgv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }
  if (subcommand === "transport-create") {
    if (receivedArgv.length > 0) {
      throw errorWithFailure("transport-create accepts no arguments.", "input");
    }
    createRawCommandTransport();
    return;
  }
  if (subcommand === "transport-discard") {
    if (receivedArgv.length !== 2 || receivedArgv[0] !== "--raw-args-token") {
      throw errorWithFailure("transport-discard requires exactly one raw argument token.", "input");
    }
    consumeRawCommandTransport(receivedArgv[1]);
    return;
  }
  if (subcommand === "record-acceptance") {
    activeCommandArgv = receivedArgv;
    handleRecordAcceptance(receivedArgv);
    return;
  }
  const transport = resolveCommandTransport(receivedArgv);
  activeCommandArgv = transport.argv;
  activeCommandIngress = transport.ingress;
  if (transport.defaultWrite && subcommand !== "task") {
    throw errorWithFailure("The raw command transport write default is valid only for task.", "input");
  }
  if (transport.defaultBackground && subcommand !== "review") {
    throw errorWithFailure("The raw command transport background default is valid only for review.", "input");
  }
  const argv = transport.argv;

  switch (subcommand) {
    case "task":
      await handleTask(argv, transport);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "review":
      await handleReview(argv, transport);
      break;
    case "review-worker":
      await handleReviewWorker(argv);
      break;
    case "status":
      handleStatus(argv, transport);
      break;
    case "history":
      handleHistory(argv, transport);
      break;
    case "result":
      await handleResult(argv, transport);
      break;
    case "cancel":
      await handleCancel(argv, transport);
      break;
    case "stats":
      handleStats(argv, transport);
      break;
    case "setup":
      handleSetup(argv, transport);
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
  if (activeCommandOptions) {
    return activeCommandOptions.json === true;
  }
  const argv = activeCommandArgv ?? process.argv.slice(3);
  if (activeCommandIngress === "staged_file") {
    return rawBooleanOptionRequested(argv[0] ?? "", "json", activeCommandConfig ?? {});
  }
  return argv.some((token) => token === "--json" || token === "--json=true");
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
    return `${JSON.stringify({ status, transportStatus: status, semanticStatus: "unverified", delivery: "foreground", deliveryStatus: "delivered", resolvedModel: null, resolvedEffort: null, failureKind, message }, null, 2)}\n`;
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
