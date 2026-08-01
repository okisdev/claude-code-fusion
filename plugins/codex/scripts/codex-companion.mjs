#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";

import { parseArgs, parseRawArgs, parseServiceTier, splitRawArgumentString } from "./lib/args.mjs";
import {
  buildReviewArgs,
  buildTaskArgs,
  getCodexAvailability,
  getProcessIdentity,
  isProcessAlive,
  processIdentitiesMatch,
  processIdentityMatches,
  runCodex,
  terminateProcessTree,
  terminateProcessTreeSync
} from "./lib/codex-exec.mjs";
import {
  renderBackgroundLaunch,
  renderCancelReport,
  renderJobDetail,
  renderRunningResult,
  renderSetupReport,
  renderStatusTable,
  renderTerminalResult
} from "./lib/render.mjs";
import {
  SESSION_ID_ENV,
  TERMINAL_STATUSES,
  appendJobLog,
  canonicalWorkspaceRoot,
  createJobRecord,
  findJobRecordById,
  finishJobRecordFile,
  generateJobId,
  jobEventsPath,
  jobFilePath,
  jobLogPath,
  jobsDir,
  listAllJobRecords,
  listJobRecords,
  latestJobRecordForThread,
  markJobCollectedFile,
  nowIso,
  pruneJobState,
  readJobRecordFile,
  readLogTail,
  resolveDataDir,
  updateJobRecordFile,
  updateJobRecordFileWithCurrent,
  withThreadLock,
  withWorkspaceLock,
  writeBrief,
  writeJobRecordFile
} from "./lib/state.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SELF_PATH), "..");
const ADVERSARIAL_REVIEW_PROMPT_FILE = path.join(ROOT_DIR, "prompts", "adversarial-review.md");
const ADVERSARIAL_REVIEW_SCHEMA_FILE = path.join(ROOT_DIR, "schemas", "adversarial-review-verdict.schema.json");
const COMPANION_MANIFEST_FILE = path.join(ROOT_DIR, ".claude-plugin", "plugin.json");
const FOREGROUND_TIMEOUT_ENV = "CODEX_COMPANION_TIMEOUT_MS";
const BACKGROUND_TIMEOUT_ENV = "CODEX_COMPANION_BACKGROUND_TIMEOUT_MS";
const BACKGROUND_DELIVERY_ENV = "CODEX_COMPANION_BACKGROUND_DELIVERY";
const BACKGROUND_LAUNCH_APPROVAL_TIMEOUT_ENV = "CODEX_COMPANION_LAUNCH_APPROVAL_TIMEOUT_MS";
const PIDLESS_GRACE_ENV = "CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS";
const WAIT_POLL_ENV = "CODEX_COMPANION_WAIT_POLL_MS";
const WAIT_TIMEOUT_ENV = "CODEX_COMPANION_WAIT_TIMEOUT_MS";
const DEFAULT_FOREGROUND_TIMEOUT_MS = 570000;
const DEFAULT_BACKGROUND_TIMEOUT_MS = 1800000;
const DEFAULT_PIDLESS_GRACE_MS = 15000;
const DEFAULT_WAIT_POLL_MS = 2000;
const DEFAULT_WAIT_TIMEOUT_MS = 570000;
const MAX_WAIT_TIMEOUT_MS = 570000;
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const MAX_RAW_ARGUMENT_BYTES = MAX_PROMPT_BYTES + 64 * 1024;
const MAX_OUTPUT_SCHEMA_BYTES = 256 * 1024;
const HEARTBEAT_INTERVAL_MS = 5000;
const BACKGROUND_LAUNCH_APPROVAL_TIMEOUT_MS = 10000;
const BACKGROUND_LAUNCH_POLL_MS = 20;
const BACKGROUND_ABORT_CLAIM_WAIT_MS = 2000;
const BACKGROUND_ABORT_CLEANUP_CONFIRM_MS = 1000;
const BACKGROUND_ABORT_CLEANUP_POLL_MS = 50;
const TESTED_VERSION_MIN = [0, 146, 0];
const TESTED_VERSION_MAX = [0, 147, 0];
const CONTINUE_PROMPT = "Continue from the current Codex thread state. Complete the next highest value step and continue until the task is resolved.";
const TRANSPORT_DIRECTORY_PREFIX = "codex-companion-input-";
const TRANSPORT_TOKEN_PATTERN = /^[a-f0-9]{48}$/;
const TRANSPORT_OWNER_FILE = "owner.json";
const TRANSPORT_OWNER_MAX_BYTES = 4096;
const TRANSPORT_MAX_AGE_MS = 60 * 60 * 1000;
const RECORD_ACCEPTANCE_JOB_ID_PATTERN = /^[a-f0-9]{32}$/;
const RECORD_ACCEPTANCE_VALUES = new Set(["accepted", "rejected", "unverified"]);
const RECORD_ACCEPTANCE_SOURCES = new Set(["collector", "main-loop", "stats"]);
const SEMANTIC_FAILURE_KINDS = new Set(["intent_override", "scope_rewrite", "wrong_approach", "style_mismatch"]);
const SOL_FOREGROUND_WRITE_WARNING = "warning: sol p90 wall clock exceeds the 600s foreground cap. Split the brief or name gpt-5.6-terra.";
let activeCommandArgv = null;
let cachedCompanionVersion = null;
let companionVersionRead = false;

class CompanionError extends Error {
  constructor(message, failureKind = "error") {
    super(message);
    this.failureKind = failureKind;
  }
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs task [--prompt-file <path>] [--output-schema <path>] [--write] [--background] [--resume <thread-id>] [--resume-last] [--fresh] [--model <id>] [--effort <level>] [--service-tier <id|none>] [--web] [--network] [--skip-git-repo-check] [--cwd <dir>] [--json] [--] [prompt]",
      "  node scripts/codex-companion.mjs review [--base <ref>] [--scope <auto|working-tree|branch>] [--focus <text>] [--background] [--model <id>] [--effort <level>] [--service-tier <id|none>] [--cwd <dir>] [--json]",
      "  node scripts/codex-companion.mjs adversarial-review [--base <ref>] [--scope <auto|working-tree|branch>] [--focus <text>] [--background] [--model <id>] [--effort <level>] [--cwd <dir>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--cwd <dir>] [--json]",
      "  node scripts/codex-companion.mjs result <job-id> [--wait] [--wait-timeout-ms <ms>] [--cwd <dir>] [--json]",
      "  node scripts/codex-companion.mjs cancel <job-id> [--cwd <dir>] [--json]",
      "  node scripts/codex-companion.mjs record-acceptance --job-id <32 lowercase hex> --acceptance <accepted|rejected|unverified> [--reason <text>] [--failure-kind <intent_override|scope_rewrite|wrong_approach|style_mismatch>] [--source <collector|main-loop|stats>] [--accept-failed-transport]",
      "  node scripts/codex-companion.mjs history [--json]",
      "  node scripts/codex-companion.mjs setup [--cwd <dir>] [--json]"
    ].join("\n") + "\n"
  );
}

function normalizeArgv(argv) {
  if (argv.length !== 1) {
    return argv;
  }
  return splitRawArgumentString(argv[0]);
}

function commandArgs(rawArgv, config) {
  try {
    if (rawArgv.length === 1) {
      return parseRawArgs(rawArgv[0], config);
    }
    return { ...parseArgs(rawArgv, config), positionalText: null };
  } catch (error) {
    throw new CompanionError(error.message, "input");
  }
}

function serviceTierOption(value) {
  try {
    return parseServiceTier(value);
  } catch (error) {
    throw new CompanionError(error.message, "input");
  }
}

function recordAcceptanceArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--accept-failed-transport") {
      if (options.acceptFailedTransport) {
        throw new CompanionError("The --accept-failed-transport option may be provided only once.", "input");
      }
      options.acceptFailedTransport = true;
      continue;
    }
    const key = token === "--job-id" ? "jobId" : token === "--acceptance" ? "acceptance" : token === "--reason" ? "reason" : token === "--failure-kind" ? "failureKind" : token === "--source" ? "source" : null;
    if (!key) {
      throw new CompanionError("The record-acceptance command accepts only --job-id, --acceptance, --reason, --failure-kind, --source, and --accept-failed-transport.", "input");
    }
    if (Object.hasOwn(options, key)) {
      throw new CompanionError(`${token} may be provided only once.`, "input");
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new CompanionError(`${token} requires a value.`, "input");
    }
    options[key] = value;
    index += 1;
  }
  if (!RECORD_ACCEPTANCE_JOB_ID_PATTERN.test(options.jobId ?? "")) {
    throw new CompanionError("The --job-id option must be a 32 character lowercase hexadecimal job id.", "input");
  }
  if (!RECORD_ACCEPTANCE_VALUES.has(options.acceptance)) {
    throw new CompanionError("The --acceptance option must be accepted, rejected, or unverified.", "input");
  }
  if (options.failureKind !== undefined && !SEMANTIC_FAILURE_KINDS.has(options.failureKind)) {
    throw new CompanionError("The --failure-kind option must be intent_override, scope_rewrite, wrong_approach, or style_mismatch.", "input");
  }
  if (options.failureKind !== undefined && options.acceptance !== "rejected") {
    throw new CompanionError("The --failure-kind option is valid only with --acceptance rejected.", "input");
  }
  if (options.acceptance === "rejected" && !options.reason?.trim()) {
    throw new CompanionError("A rejected acceptance requires --reason.", "input");
  }
  options.source ??= "stats";
  if (!RECORD_ACCEPTANCE_SOURCES.has(options.source)) {
    throw new CompanionError("The --source option must be collector, main-loop, or stats.", "input");
  }
  return options;
}

function output(value, asJson = false) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(String(value));
}

function resolveCwd(options = {}) {
  const cwd = path.resolve(process.cwd(), options.cwd ?? ".");
  let stats;
  try {
    stats = fs.statSync(cwd);
  } catch {
    throw new CompanionError(`Working directory does not exist: ${cwd}.`, "input");
  }
  if (!stats.isDirectory()) {
    throw new CompanionError(`Working directory is not a directory: ${cwd}.`, "input");
  }
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

function rejectImplicitSubdirectoryCwd(cwd, options) {
  if (options.cwd != null) {
    return;
  }
  const toplevel = canonicalWorkspaceRoot(cwd);
  if (toplevel !== cwd) {
    throw new CompanionError(`Implicit working directory ${cwd} is inside repository ${toplevel} but is not its root. Pass --cwd ${toplevel} to target the repository root, or pass --cwd ${cwd} to confirm this subdirectory as the sandbox root.`, "input");
  }
}

function resolveOutputSchemaFile(cwd, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CompanionError("--output-schema requires a non-empty path.", "input");
  }
  const file = path.resolve(cwd, value);
  let stats;
  try {
    stats = fs.statSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new CompanionError(`Output schema file does not exist: ${file}.`, "input");
    }
    throw new CompanionError(`Could not read output schema file ${file}: ${error.message}`, "input");
  }
  if (!stats.isFile()) {
    throw new CompanionError(`Output schema path is not a regular file: ${file}.`, "input");
  }
  if (stats.size > MAX_OUTPUT_SCHEMA_BYTES) {
    throw new CompanionError(`Output schema file exceeds the ${MAX_OUTPUT_SCHEMA_BYTES / 1024} KiB limit: ${file}.`, "input");
  }
  let source;
  try {
    source = fs.readFileSync(file);
  } catch (error) {
    throw new CompanionError(`Could not read output schema file ${file}: ${error.message}`, "input");
  }
  if (source.byteLength > MAX_OUTPUT_SCHEMA_BYTES) {
    throw new CompanionError(`Output schema file exceeds the ${MAX_OUTPUT_SCHEMA_BYTES / 1024} KiB limit: ${file}.`, "input");
  }
  try {
    JSON.parse(source.toString("utf8"));
  } catch {
    throw new CompanionError(`Output schema file must contain valid JSON: ${file}.`, "input");
  }
  return file;
}

function nonnegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new CompanionError(`${label} must be a nonnegative integer.`, "input");
  }
  return number;
}

function positiveEnvMs(name, fallback, env = process.env) {
  const value = env[name];
  if (value == null || !String(value).trim()) {
    return fallback;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function nonnegativeEnvMs(name, fallback, env = process.env) {
  const value = env[name];
  if (value == null || !String(value).trim()) {
    return fallback;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function resolveExecutionTimeout(background, env = process.env) {
  return positiveEnvMs(background ? BACKGROUND_TIMEOUT_ENV : FOREGROUND_TIMEOUT_ENV, background ? DEFAULT_BACKGROUND_TIMEOUT_MS : DEFAULT_FOREGROUND_TIMEOUT_MS, env);
}

function companionVersion() {
  if (companionVersionRead) {
    return cachedCompanionVersion;
  }
  companionVersionRead = true;
  try {
    const manifest = JSON.parse(fs.readFileSync(COMPANION_MANIFEST_FILE, "utf8"));
    cachedCompanionVersion = typeof manifest.version === "string" && manifest.version.trim() ? manifest.version.trim() : null;
  } catch {}
  return cachedCompanionVersion;
}

function backgroundDelivery(env = process.env) {
  return env[BACKGROUND_DELIVERY_ENV] === "managed" ? "managed" : "manual";
}

function resolvePidlessGrace(env = process.env) {
  return nonnegativeEnvMs(PIDLESS_GRACE_ENV, DEFAULT_PIDLESS_GRACE_MS, env);
}

function resolveWaitPoll(env = process.env) {
  return positiveEnvMs(WAIT_POLL_ENV, DEFAULT_WAIT_POLL_MS, env);
}

function resolveWaitTimeout(options, env = process.env) {
  if (options["wait-timeout-ms"] != null) {
    return Math.min(nonnegativeInteger(options["wait-timeout-ms"], "--wait-timeout-ms"), MAX_WAIT_TIMEOUT_MS);
  }
  const value = env[WAIT_TIMEOUT_ENV];
  if (value != null && String(value).trim()) {
    const number = Number(value);
    if (Number.isSafeInteger(number) && number >= 0) {
      return Math.min(number, MAX_WAIT_TIMEOUT_MS);
    }
  }
  return DEFAULT_WAIT_TIMEOUT_MS;
}

function readStdinIfPiped() {
  if (isatty(0)) {
    return "";
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_PROMPT_BYTES + 1 - total));
      const bytesRead = fs.readSync(0, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
      if (total > MAX_PROMPT_BYTES) {
        throw new CompanionError(`Codex prompt exceeded the ${MAX_PROMPT_BYTES} byte limit.`, "resource");
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch (error) {
    if (error instanceof CompanionError) {
      throw error;
    }
    return "";
  }
}

function readPromptFile(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const buffer = Buffer.alloc(MAX_PROMPT_BYTES + 1);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_PROMPT_BYTES) {
      throw new CompanionError(`Codex prompt exceeded the ${MAX_PROMPT_BYTES} byte limit.`, "resource");
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function boundedPrompt(value) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text) > MAX_PROMPT_BYTES) {
    throw new CompanionError(`Codex prompt exceeded the ${MAX_PROMPT_BYTES} byte limit.`, "resource");
  }
  return text;
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
  throw new CompanionError("No private shell safe temporary directory is available for raw command transport.", "resource");
}

function transportPaths(token) {
  if (!TRANSPORT_TOKEN_PATTERN.test(token)) {
    throw new CompanionError("The raw command transport token is invalid.", "input");
  }
  const directory = path.join(shellSafeTemporaryRoot(), `${TRANSPORT_DIRECTORY_PREFIX}${token}`);
  return { directory, file: path.join(directory, "request"), ownerFile: path.join(directory, TRANSPORT_OWNER_FILE) };
}

function validateOwnedPath(stats, label) {
  if (typeof process.getuid === "function" && Number.isInteger(stats.uid) && stats.uid !== process.getuid()) {
    throw new CompanionError(`${label} is not owned by the current user.`, "permission");
  }
}

function createRawCommandTransport() {
  pruneRawCommandTransports();
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
        throw new CompanionError(`Could not create private raw command transport: ${error.message}`, "permission");
      }
    }
  }
  throw new CompanionError("Could not allocate a unique raw command transport.", "resource");
}

function sameFileIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function transportSessionHash(sessionId) {
  return typeof sessionId === "string" && sessionId.trim() ? createHash("sha256").update(sessionId.trim()).digest("hex") : null;
}

function readTransportOwner(ownerFile) {
  let descriptor;
  try {
    const pathStats = fs.lstatSync(ownerFile);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1 || pathStats.size > TRANSPORT_OWNER_MAX_BYTES) {
      throw new CompanionError("The raw command transport owner record is invalid.", "permission");
    }
    validateOwnedPath(pathStats, "The raw command transport owner record");
    if (process.platform !== "win32" && (pathStats.mode & 0o077) !== 0) {
      throw new CompanionError("The raw command transport owner record is not private.", "permission");
    }
    descriptor = fs.openSync(ownerFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const openedStats = fs.fstatSync(descriptor);
    if (!openedStats.isFile() || openedStats.nlink !== 1 || !sameFileIdentity(openedStats, pathStats)) {
      throw new CompanionError("The raw command transport owner record changed before it could be read.", "permission");
    }
    const buffer = Buffer.alloc(TRANSPORT_OWNER_MAX_BYTES + 1);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > TRANSPORT_OWNER_MAX_BYTES) {
      throw new CompanionError("The raw command transport owner record is invalid.", "permission");
    }
    const record = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (!Number.isSafeInteger(record?.createdAt) || record.createdAt <= 0 || (record.sessionHash !== null && !/^[a-f0-9]{64}$/.test(record.sessionHash))) {
      throw new CompanionError("The raw command transport owner record is invalid.", "permission");
    }
    return { identity: pathStats, record };
  } catch (error) {
    if (error instanceof CompanionError) {
      throw error;
    }
    throw new CompanionError(`Could not read raw command transport owner record: ${error.message}`, "permission");
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function cleanupVerifiedTransport(directory, file, ownerFile, directoryIdentity, fileIdentity, ownerIdentity) {
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

function pruneRawCommandTransports(options = {}) {
  let root;
  let entries;
  try {
    root = shellSafeTemporaryRoot();
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const sessionHash = transportSessionHash(options.sessionId);
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
      if (sessionHash ? record.sessionHash !== sessionHash : now - record.createdAt < TRANSPORT_MAX_AGE_MS) {
        continue;
      }
      cleanupVerifiedTransport(directory, file, ownerFile, directoryIdentity, fileIdentity, ownerIdentity);
    } catch {}
  }
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
      throw new CompanionError(`Raw command arguments exceeded the ${limit} byte limit.`, "resource");
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

function consumeRawCommandStdin() {
  if (isatty(0)) {
    throw new CompanionError("Raw command stdin requires a piped request.", "input");
  }
  const bytes = readBoundedDescriptor(0, MAX_RAW_ARGUMENT_BYTES);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CompanionError("Raw command arguments must be valid UTF-8.", "input");
  }
}

function consumeRawCommandTransport(token, { allowUnwritten = false } = {}) {
  const { directory, file, ownerFile } = transportPaths(token);
  let descriptor;
  let directoryIdentity = null;
  let fileIdentity = null;
  let ownerIdentity = null;
  try {
    const directoryStats = fs.lstatSync(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new CompanionError("The raw command transport directory is invalid.", "permission");
    }
    validateOwnedPath(directoryStats, "The raw command transport directory");
    if (process.platform !== "win32" && (directoryStats.mode & 0o077) !== 0) {
      throw new CompanionError("The raw command transport directory is not private.", "permission");
    }
    directoryIdentity = directoryStats;
    const owner = readTransportOwner(ownerFile);
    ownerIdentity = owner.identity;
    const pathStats = fs.lstatSync(file);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1) {
      throw new CompanionError("The raw command transport must be a regular private file.", "permission");
    }
    validateOwnedPath(pathStats, "The raw command transport file");
    fileIdentity = pathStats;
    if (owner.record.sessionHash !== transportSessionHash(currentClaudeSessionId())) {
      throw new CompanionError("The raw command transport belongs to another Claude session.", "permission");
    }
    const transportAgeMs = Date.now() - owner.record.createdAt;
    if (transportAgeMs < 0 || transportAgeMs > TRANSPORT_MAX_AGE_MS) {
      throw new CompanionError("The raw command transport has expired.", "input");
    }
    if (process.platform !== "win32" && (pathStats.mode & 0o077) !== 0) {
      throw new CompanionError("The raw command transport file is not private.", "permission");
    }
    if (pathStats.size > MAX_RAW_ARGUMENT_BYTES) {
      throw new CompanionError(`Raw command arguments exceeded the ${MAX_RAW_ARGUMENT_BYTES} byte limit.`, "resource");
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    descriptor = fs.openSync(file, flags);
    const openedStats = fs.fstatSync(descriptor);
    if (!openedStats.isFile() || openedStats.nlink !== 1 || openedStats.dev !== pathStats.dev || openedStats.ino !== pathStats.ino) {
      throw new CompanionError("The raw command transport changed before it could be read.", "permission");
    }
    validateOwnedPath(openedStats, "The raw command transport file");
    if (process.platform !== "win32" && (openedStats.mode & 0o077) !== 0) {
      throw new CompanionError("The raw command transport file is not private.", "permission");
    }
    const bytes = readBoundedDescriptor(descriptor, MAX_RAW_ARGUMENT_BYTES);
    if (bytes.length === 0) {
      if (allowUnwritten) {
        return "";
      }
      throw new CompanionError("The raw command transport is unwritten.", "input");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new CompanionError("Raw command arguments must be valid UTF-8.", "input");
    }
  } catch (error) {
    if (error instanceof CompanionError) {
      throw error;
    }
    throw new CompanionError(`Could not read raw command transport: ${error.message}`, error?.code === "ENOENT" ? "input" : "permission");
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    cleanupVerifiedTransport(directory, file, ownerFile, directoryIdentity, fileIdentity, ownerIdentity);
  }
}

function resolveCommandTransport(rawArgv) {
  const defaultWrite = rawArgv[0] === "--transport-default-write";
  const transportArgv = defaultWrite ? rawArgv.slice(1) : rawArgv;
  if (transportArgv[0] === "--request-stdin") {
    if (transportArgv.length !== 1) {
      throw new CompanionError("Raw command stdin must not be combined with normal arguments.", "input");
    }
    return { argv: [consumeRawCommandStdin()], defaultWrite, ingress: "stdin" };
  }
  if (transportArgv[0] !== "--raw-args-token") {
    if (transportArgv.some((value) => value === "--raw-args-token" || value === "--request-stdin") || defaultWrite) {
      throw new CompanionError("Raw command transport options must not be combined with normal arguments.", "input");
    }
    return { argv: rawArgv, defaultWrite: false, ingress: "argv" };
  }
  if (transportArgv.length !== 2) {
    throw new CompanionError("Raw command transport requires exactly one token.", "input");
  }
  return { argv: [consumeRawCommandTransport(transportArgv[1])], defaultWrite, ingress: "staged_file" };
}

function readTaskPrompt(cwd, options, positionals, positionalText) {
  const positional = positionalText ?? positionals.join(" ").trim();
  const hasPositional = Boolean(positional.trim());
  if (hasPositional && options["prompt-file"]) {
    throw new CompanionError("Use prompt text or --prompt-file, not both.", "input");
  }
  if (hasPositional) {
    return boundedPrompt(positional);
  }
  if (options["prompt-file"]) {
    const file = path.resolve(cwd, options["prompt-file"]);
    try {
      return readPromptFile(file);
    } catch (error) {
      if (error instanceof CompanionError) {
        throw error;
      }
      throw new CompanionError(`Could not read prompt file ${file}: ${error.message}`, "input");
    }
  }
  return readStdinIfPiped();
}

export function parseTaskHeader(prompt) {
  const line = String(prompt ?? "").split(/\r?\n/).find((candidate) => candidate.trim());
  if (!line || !line.includes("|")) {
    return { headerModel: null, headerEffort: null };
  }
  let headerModel = null;
  let headerEffort = null;
  for (const segment of line.split("|")) {
    const model = segment.match(/^\s*model\s*:\s*(\S+)\s*$/i);
    if (model && !headerModel) {
      headerModel = model[1];
      continue;
    }
    const effort = segment.match(/^\s*effort\s*:\s*(\S+)\s*$/i);
    if (effort && !headerEffort) {
      headerEffort = effort[1];
    }
  }
  return { headerModel, headerEffort };
}

function taskModelDrift(record, prompt, resolvedModel) {
  if (record.jobClass !== "task" || record.request?.model != null || typeof resolvedModel !== "string" || !resolvedModel.trim()) {
    return null;
  }
  const { headerModel, headerEffort } = parseTaskHeader(prompt);
  if (!headerModel || headerModel === resolvedModel) {
    return null;
  }
  return { headerModel, headerEffort, resolvedModel };
}

function currentClaudeSessionId() {
  const value = process.env[SESSION_ID_ENV];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function oneLine(value, fallback) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? fallback;
}

function boundedTail(value, maxLines = 20) {
  return String(value ?? "")
    .slice(-64 * 1024)
    .trimEnd()
    .split(/\r?\n/)
    .slice(-maxLines)
    .join("\n");
}

function redactDiagnostic(value) {
  return String(value ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@")
    .replace(/\b(api[_-]?key|access[_-]?token|authorization|password|passwd|secret|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,})\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9+/_=-]{64,}\b/g, "[redacted]");
}

function availabilityFailure(probe) {
  const missing = probe.exitCode == null && /ENOENT|not found|no such file/i.test(probe.errorMessage ?? "");
  return new CompanionError(probe.errorMessage || "The Codex CLI is unavailable.", missing ? "missing_cli" : "error");
}

function preflightCodex(cwd) {
  const probe = getCodexAvailability({ cwd, env: process.env });
  if (!probe.available) {
    throw availabilityFailure(probe);
  }
  const version = parseVersion(probe.version);
  if (version && compareVersion(version, TESTED_VERSION_MIN) < 0) {
    throw new CompanionError(`Codex CLI version ${probe.version} is unsupported. Upgrade the Codex CLI to version ${TESTED_VERSION_MIN.join(".")} or later.`, "setup");
  }
  return probe;
}

function parseVersion(value) {
  const match = String(value ?? "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersion(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

function testedVersionInterval() {
  return `${TESTED_VERSION_MIN.join(".")} to before ${TESTED_VERSION_MAX.join(".")}`;
}

function supportedVersion(value) {
  const parsed = parseVersion(value);
  return Boolean(parsed) && compareVersion(parsed, TESTED_VERSION_MIN) >= 0 && compareVersion(parsed, TESTED_VERSION_MAX) < 0;
}

function findRequestedJob(dataDir, jobId, options) {
  if (options.cwd == null) {
    return findJobRecordById(dataDir, jobId);
  }
  const cwd = resolveCwd(options);
  const file = jobFilePath(dataDir, cwd, jobId);
  const record = readJobRecordFile(file);
  return record?.id === jobId ? { record, file } : null;
}

function terminalRecord(record) {
  return TERMINAL_STATUSES.has(record?.status);
}

function elapsedSince(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? Date.now() - timestamp : Number.POSITIVE_INFINITY;
}

function deadOwnerMessage(record) {
  const pids = [record.pid, record.codexPid].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (pids.length === 0) {
    return "No process id was recorded before the launch grace window elapsed.";
  }
  return `Recorded process ${pids.join(", ")} exited without recording a terminal outcome.`;
}

function recordedProcessState(record, prefix) {
  const codex = prefix === "codex";
  const pid = record[codex ? "codexPid" : "pid"];
  const identity = record[codex ? "codexPidIdentity" : "pidIdentity"];
  const identitySettled = codex ? Boolean(record.codexPidIdentitySettled) : true;
  const ownsProcessGroup = Boolean(record[codex ? "codexPidOwnsProcessGroup" : "pidOwnsProcessGroup"]);
  if (!Number.isInteger(pid) || pid <= 1) {
    return { identity, ownsProcessGroup, pid, state: "absent" };
  }
  const currentIdentity = getProcessIdentity(pid);
  if (currentIdentity) {
    if (!identity) {
      return { identity, ownsProcessGroup, pid, state: "unverified" };
    }
    if (processIdentitiesMatch(currentIdentity, identity)) {
      return { identity, ownsProcessGroup, pid, state: "owned" };
    }
    return { identity, ownsProcessGroup, pid, state: identitySettled ? "replaced" : "unverified" };
  }
  if (isProcessAlive(pid, null, ownsProcessGroup)) {
    return { identity, ownsProcessGroup, pid, state: "unverified" };
  }
  return { identity, ownsProcessGroup, pid, state: "absent" };
}

function cleanupComplete(record) {
  return [recordedProcessState(record, "owner"), recordedProcessState(record, "codex")].every(({ state }) => state === "absent" || state === "replaced");
}

export function runningRecordNeedsReconciliation(record, env = process.env) {
  if (record?.status !== "running") {
    return false;
  }
  const owner = recordedProcessState(record, "owner");
  return (owner.state === "absent" || owner.state === "replaced") && elapsedSince(record.createdAt) > resolvePidlessGrace(env);
}

function codexSpawnCheckpointPending(record) {
  return Boolean(record?.background && record.startedAt && !record.codexPidIdentitySettled);
}

const SPAWN_CHECKPOINT_SETTLE_TIMEOUT_MS = 1000;
const SPAWN_CHECKPOINT_SETTLE_POLL_MS = 25;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function awaitCodexSpawnCheckpointSettledSync(file, record) {
  const deadline = Date.now() + SPAWN_CHECKPOINT_SETTLE_TIMEOUT_MS;
  let current = record;
  while (codexSpawnCheckpointPending(current) && current.status === "running" && Date.now() < deadline) {
    sleepSync(SPAWN_CHECKPOINT_SETTLE_POLL_MS);
    current = readJobRecordFile(file) ?? current;
  }
  return current;
}

async function awaitCodexSpawnCheckpointSettled(file, record) {
  const deadline = Date.now() + SPAWN_CHECKPOINT_SETTLE_TIMEOUT_MS;
  let current = record;
  while (codexSpawnCheckpointPending(current) && current.status === "running" && Date.now() < deadline) {
    await delay(SPAWN_CHECKPOINT_SETTLE_POLL_MS);
    current = readJobRecordFile(file) ?? current;
  }
  return current;
}

function signalRecorded(record, prefix) {
  const target = recordedProcessState(record, prefix);
  if (target.state !== "owned" || !target.identity) {
    return false;
  }
  try {
    process.kill(process.platform !== "win32" && target.ownsProcessGroup ? -target.pid : target.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function cleanupRequired(file, failureKind, message) {
  return updateJobRecordFile(file, {
    errorMessage: message,
    errorTail: message,
    failureKind,
    phase: "cleanup-required"
  });
}

function terminateRecordedSync(record, prefix, graceMs = 250) {
  const target = recordedProcessState(record, prefix);
  if (target.state === "absent" || target.state === "replaced") {
    return true;
  }
  if (target.state !== "owned" || !target.identity) {
    return false;
  }
  return terminateProcessTreeSync(target.pid, {
    graceMs,
    identity: target.identity,
    ownsProcessGroup: target.ownsProcessGroup,
    requireIdentity: true
  });
}

async function terminateRecorded(record, prefix, graceMs = 250) {
  const target = recordedProcessState(record, prefix);
  if (target.state === "absent" || target.state === "replaced") {
    return true;
  }
  if (target.state !== "owned" || !target.identity) {
    return false;
  }
  return terminateProcessTree(target.pid, {
    graceMs,
    identity: target.identity,
    ownsProcessGroup: target.ownsProcessGroup,
    requireIdentity: true
  });
}

function currentProcessIdentity() {
  const identity = getProcessIdentity(process.pid);
  if (!identity) {
    throw new CompanionError("The companion process identity could not be verified.", "process");
  }
  return identity;
}

function isSolForegroundWriteTask(record) {
  return (
    record.jobClass === "task" &&
    record.delivery === "foreground" &&
    record.mode === "write" &&
    typeof record.resolvedModel === "string" &&
    record.resolvedModel.toLowerCase().includes("sol")
  );
}

function shellArgument(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function timeoutResumeCommand(record, threadId) {
  return `${shellArgument(process.execPath)} ${shellArgument(SELF_PATH)} task --resume ${shellArgument(threadId)} --cwd ${shellArgument(record.cwd)}`;
}

function appendResumeFooter(text, footer) {
  const value = typeof text === "string" ? text.trimEnd() : "";
  return value.split("\n").includes(footer) ? value : value ? `${value}\n\n${footer}` : footer;
}

function timeoutResumePatch(record, patch) {
  const failureKind = patch.failureKind ?? record.failureKind;
  const threadId = patch.threadId ?? record.threadId ?? record.request?.resumeThreadId;
  if (failureKind !== "timeout" || typeof threadId !== "string" || !threadId.trim()) {
    return patch;
  }
  const resumeCommand = timeoutResumeCommand(record, threadId);
  const footer = `Resume Codex job ${record.id}: ${resumeCommand}`;
  const resultText = Object.hasOwn(patch, "resultText") ? patch.resultText : record.resultText;
  const partialResultText = Object.hasOwn(patch, "partialResultText") ? patch.partialResultText : record.partialResultText;
  if (typeof resultText === "string" && resultText.trim()) {
    return { ...patch, resumable: true, resumeCommand, resultText: appendResumeFooter(resultText, footer) };
  }
  return { ...patch, resumable: true, resumeCommand, partialResultText: appendResumeFooter(partialResultText, footer) };
}

function finishJob(file, patch, env = process.env) {
  const existing = readJobRecordFile(file);
  const record = finishJobRecordFile(file, existing ? timeoutResumePatch(existing, patch) : patch);
  pruneJobState(resolveDataDir(env), { claudeSessionId: record.claudeSessionId, protectedJobFiles: [file], resumeWorkspaceJobFiles: [file] });
  return record;
}

function collectRenderedJob(file, record) {
  if (!TERMINAL_STATUSES.has(record.status)) {
    return record;
  }
  let collected = record;
  try {
    collected = markJobCollectedFile(file);
  } catch {}
  pruneJobState(resolveDataDir(), { claudeSessionId: collected.claudeSessionId, resumeWorkspaceJobFiles: [file] });
  return collected;
}

export function repairRunningRecordSync({ record, file }, env = process.env) {
  let current = readJobRecordFile(file) ?? record;
  if (current.status !== "running") {
    return current;
  }
  current = awaitCodexSpawnCheckpointSettledSync(file, current);
  const deadline = Date.parse(current.deadlineAt ?? "");
  if (Number.isFinite(deadline) && Date.now() > deadline) {
    if (codexSpawnCheckpointPending(current)) {
      signalRecorded(current, "owner");
      return cleanupRequired(file, "timeout", "Codex exceeded its recorded execution deadline while its process identity checkpoint was incomplete. Graceful cleanup was requested without forcing the companion to exit.");
    }
    terminateRecordedSync(current, "codex");
    terminateRecordedSync(current, "owner");
    const refreshed = readJobRecordFile(file) ?? current;
    if (!cleanupComplete(refreshed)) {
      return cleanupRequired(file, "timeout", "Codex exceeded its recorded execution deadline, but verified process cleanup did not complete.");
    }
    return finishJob(file, {
      status: "error",
      failureKind: "timeout",
      errorMessage: "Codex exceeded its recorded execution deadline.",
      errorTail: "Codex exceeded its recorded execution deadline."
    });
  }
  const owner = recordedProcessState(current, "owner");
  if (owner.state === "owned") {
    return current;
  }
  if (elapsedSince(current.createdAt) <= resolvePidlessGrace(env)) {
    return current;
  }
  if (owner.state === "unverified") {
    return cleanupRequired(file, "process", "The recorded companion process is live but its identity cannot be verified. No signal was sent.");
  }
  if (codexSpawnCheckpointPending(current)) {
    return cleanupRequired(file, "process", "The companion exited while the Codex process identity checkpoint was incomplete. No terminal state was recorded.");
  }
  terminateRecordedSync(current, "owner");
  terminateRecordedSync(current, "codex");
  const refreshed = readJobRecordFile(file) ?? current;
  if (!cleanupComplete(refreshed)) {
    return cleanupRequired(file, "died", "The companion exited without a terminal outcome, but verified process cleanup did not complete.");
  }
  const message = deadOwnerMessage(current);
  return finishJob(file, {
    status: "error",
    failureKind: "died",
    errorMessage: message,
    errorTail: message
  });
}

export async function refreshRunningJobRecord(found, env = process.env) {
  let current = readJobRecordFile(found.file) ?? found.record;
  if (current.status !== "running") {
    return current;
  }
  current = await awaitCodexSpawnCheckpointSettled(found.file, current);
  const deadline = Date.parse(current.deadlineAt ?? "");
  if (Number.isFinite(deadline) && Date.now() > deadline) {
    if (codexSpawnCheckpointPending(current)) {
      signalRecorded(current, "owner");
      return cleanupRequired(found.file, "timeout", "Codex exceeded its recorded execution deadline while its process identity checkpoint was incomplete. Graceful cleanup was requested without forcing the companion to exit.");
    }
    await Promise.all([terminateRecorded(current, "codex"), terminateRecorded(current, "owner")]);
    const refreshed = readJobRecordFile(found.file) ?? current;
    if (!cleanupComplete(refreshed)) {
      return cleanupRequired(found.file, "timeout", "Codex exceeded its recorded execution deadline, but verified process cleanup did not complete.");
    }
    return finishJob(found.file, {
      status: "error",
      failureKind: "timeout",
      errorMessage: "Codex exceeded its recorded execution deadline.",
      errorTail: "Codex exceeded its recorded execution deadline."
    });
  }
  const owner = recordedProcessState(current, "owner");
  if (owner.state === "owned") {
    return current;
  }
  if (elapsedSince(current.createdAt) <= resolvePidlessGrace(env)) {
    return current;
  }
  if (owner.state === "unverified") {
    return cleanupRequired(found.file, "process", "The recorded companion process is live but its identity cannot be verified. No signal was sent.");
  }
  if (codexSpawnCheckpointPending(current)) {
    return cleanupRequired(found.file, "process", "The companion exited while the Codex process identity checkpoint was incomplete. No terminal state was recorded.");
  }
  await Promise.all([terminateRecorded(current, "owner"), terminateRecorded(current, "codex")]);
  const refreshed = readJobRecordFile(found.file) ?? current;
  if (!cleanupComplete(refreshed)) {
    return cleanupRequired(found.file, "died", "The companion exited without a terminal outcome, but verified process cleanup did not complete.");
  }
  const message = deadOwnerMessage(current);
  return finishJob(found.file, {
    status: "error",
    failureKind: "died",
    errorMessage: message,
    errorTail: message
  });
}

function latestResumeRecord(dataDir, cwd, claudeSessionId) {
  let candidates = listJobRecords(dataDir, cwd).filter(
    (record) => terminalRecord(record) && record.jobClass === "task" && typeof record.threadId === "string" && record.threadId.trim()
  );
  if (claudeSessionId) {
    candidates = candidates.filter((record) => record.claudeSessionId === claudeSessionId);
  }
  if (candidates.length === 0) {
    throw new CompanionError("No eligible finished Codex task thread was found for this workspace and Claude session.", "input");
  }
  return candidates[0];
}

function resolveResume(dataDir, cwd, options) {
  if (options.resume && options["resume-last"]) {
    throw new CompanionError("Use either --resume or --resume-last, not both.", "input");
  }
  if (options.fresh && (options.resume || options["resume-last"])) {
    throw new CompanionError("--fresh cannot be combined with --resume or --resume-last.", "input");
  }
  if (options.fresh) {
    return { threadId: null, baseline: null, sourceJobId: null };
  }
  let threadId = options.resume ?? null;
  let sourceJobId = null;
  if (options["resume-last"]) {
    const candidate = latestResumeRecord(dataDir, cwd, currentClaudeSessionId());
    threadId = candidate.threadId;
    sourceJobId = candidate.id;
  }
  return {
    threadId,
    sourceJobId
  };
}

function inheritedRouting(record, options, defaultServiceTier) {
  const source = record?.request && typeof record.request === "object" && !Array.isArray(record.request) ? record.request : {};
  const explicitModel = Object.hasOwn(options, "model");
  const explicitEffort = Object.hasOwn(options, "effort");
  const explicitServiceTier = Object.hasOwn(options, "service-tier");
  let model = explicitModel ? options.model : null;
  let effort = explicitEffort ? options.effort : null;
  let serviceTier = defaultServiceTier;
  let inherited = false;

  const sourceModel = typeof source.model === "string" && source.model.trim() ? source.model : record?.resolvedModel;
  if (!explicitModel && typeof sourceModel === "string" && sourceModel.trim()) {
    model = sourceModel;
    inherited = true;
  }
  const sourceEffort = typeof source.effort === "string" && source.effort.trim() ? source.effort : record?.resolvedEffort;
  if (!explicitEffort && typeof sourceEffort === "string" && sourceEffort.trim()) {
    effort = sourceEffort;
    inherited = true;
  }
  const hasSourceServiceTier = Object.hasOwn(source, "serviceTier") || typeof record?.serviceTier === "string" || typeof record?.appliedServiceTier === "string";
  const sourceServiceTier = Object.hasOwn(source, "serviceTier")
    ? source.serviceTier
    : typeof record?.serviceTier === "string"
      ? record.serviceTier
      : record?.appliedServiceTier;
  if (!explicitServiceTier && hasSourceServiceTier) {
    serviceTier = sourceServiceTier === null ? null : serviceTierOption(sourceServiceTier);
    inherited = true;
  }
  return { effort, inherited, model, serviceTier };
}

function createReservedJob({ background, brief, codexVersion, companionVersion, cwd, dataDir, jobClass, mode, request, timeoutMs }) {
  brief = boundedPrompt(brief);
  const ownerIdentity = background ? null : currentProcessIdentity();
  const reserveWorkspace = (reservedRequest) => withWorkspaceLock(dataDir, cwd, () => {
    const records = listJobRecords(dataDir, cwd).map((record) => {
      const file = jobFilePath(dataDir, cwd, record.id);
      return repairRunningRecordSync({ record, file });
    });
    const running = records.find((record) => record.status === "running");
    if (running) {
      throw new CompanionError(`Codex job ${running.id} is already running in this workspace.`, "input");
    }
    const id = generateJobId();
    const briefFile = writeBrief(dataDir, cwd, id, brief);
    const record = createJobRecord({
      id,
      background,
      briefFile,
      claudeSessionId: currentClaudeSessionId(),
      codexVersion,
      companionVersion,
      cwd,
      delivery: background ? backgroundDelivery() : "foreground",
      eventsFile: jobEventsPath(dataDir, cwd, id),
      jobClass,
      kind: jobClass,
      logFile: jobLogPath(dataDir, cwd, id),
      mode,
      phase: background ? "queued" : "starting",
      pid: background ? null : process.pid,
      pidIdentity: ownerIdentity,
      pidOwnsProcessGroup: false,
      request: reservedRequest,
      timeoutMs,
      workspaceRoot: canonicalWorkspaceRoot(cwd)
    });
    const file = jobFilePath(dataDir, cwd, id);
    writeJobRecordFile(file, record);
    return { record, file };
  });
  const threadId = request.resumeThreadId;
  if (!threadId) {
    return reserveWorkspace(request);
  }
  return withThreadLock(dataDir, threadId, () => {
    const entries = listAllJobRecords(dataDir);
    for (const entry of entries) {
      if (entry.record.status === "running" && (entry.record.threadId === threadId || entry.record.request?.resumeThreadId === threadId)) {
        entry.record = repairRunningRecordSync(entry);
      }
    }
    const running = entries.find(
      ({ record }) => record.status === "running" && (record.threadId === threadId || record.request?.resumeThreadId === threadId)
    );
    if (running) {
      const current = repairRunningRecordSync({ file: running.file, record: readJobRecordFile(running.file) ?? running.record });
      if (current.status === "running") {
        throw new CompanionError(`Codex thread ${threadId} is already running in job ${current.id}.`, "input");
      }
    }
    return reserveWorkspace(request);
  });
}

function executionArgs(record) {
  const request = record.request ?? {};
  const common = {
    cwd: record.cwd,
    effort: request.effort,
    model: request.model,
    serviceTier: Object.hasOwn(request, "serviceTier") ? request.serviceTier : "priority",
    network: Boolean(request.network),
    skipGitRepoCheck: Boolean(request.skipGitRepoCheck),
    web: Boolean(request.web)
  };
  if (request.transport === "native-review") {
    return buildReviewArgs({
      ...common,
      base: request.base ?? undefined,
      uncommitted: request.uncommitted === true
    });
  }
  return buildTaskArgs({
    ...common,
    outputSchemaFile: request.outputSchemaFile ?? undefined,
    resumeThreadId: request.resumeThreadId ?? undefined,
    write: request.write === true
  });
}

function validateExecutionRequest(cwd, request) {
  try {
    executionArgs({ cwd, request });
  } catch (error) {
    throw new CompanionError(error.message, "input");
  }
}

function failureKindForError(error) {
  if (error?.failureKind) {
    return error.failureKind;
  }
  if (error?.code === "ENOENT") {
    return "missing_cli";
  }
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return "permission";
  }
  return "error";
}

function semanticOutcome(outcome) {
  if (outcome.collaborationViolation) {
    return {
      semanticFailureKind: "policy",
      semanticFailureMessage: redactDiagnostic(outcome.collaborationViolation),
      semanticStatus: "rejected"
    };
  }
  return { semanticFailureKind: null, semanticFailureMessage: null, semanticStatus: "unverified" };
}

function structuredOutputOutcome(request, outcome) {
  if (!request.outputSchemaFile || outcome.resultSource !== "agent_message" || typeof outcome.finalResponse !== "string") {
    return {};
  }
  try {
    return { structuredOutput: JSON.parse(outcome.finalResponse), structuredOutputError: null };
  } catch (error) {
    return {
      structuredOutput: null,
      structuredOutputError: `Codex final response is not valid JSON: ${oneLine(error.message, "JSON parsing failed.")}`
    };
  }
}

function finishExecutionFailure(file, record, error, env = process.env) {
  const rawMessage = oneLine(error?.message ?? error, "Codex companion execution failed.");
  appendJobLog(record.logFile, rawMessage);
  const message = redactDiagnostic(rawMessage);
  return finishJob(file, {
    status: "error",
    failureKind: failureKindForError(error),
    errorMessage: message,
    errorTail: redactDiagnostic(readLogTail(record.logFile, 20) || message)
  }, env);
}

async function executeRecord(found) {
  let record = readJobRecordFile(found.file) ?? found.record;
  if (record.status !== "running") {
    return record;
  }
  if (record.background && (!record.launchApprovedAt || record.launchAbortRequestedAt)) {
    return finishExecutionFailure(found.file, record, new CompanionError("The background worker did not receive launch approval.", "process"));
  }
  let ownerIdentity;
  try {
    ownerIdentity = currentProcessIdentity();
  } catch (error) {
    return finishExecutionFailure(found.file, record, error);
  }
  const timeoutMs = resolveExecutionTimeout(record.background);
  const startedAt = record.startedAt ?? nowIso();
  const serviceTier = Object.hasOwn(record.request ?? {}, "serviceTier") ? record.request.serviceTier : "priority";
  record = updateJobRecordFile(found.file, {
    deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
    heartbeatAt: nowIso(),
    phase: record.background ? "codex-spawning" : "executing",
    serviceTier,
    timeoutMs,
    pid: process.pid,
    pidIdentity: ownerIdentity,
    pidOwnsProcessGroup: record.background && process.platform !== "win32",
    startedAt
  });
  let checkpointedThreadId = record.threadId;
  const cancellation = new AbortController();
  const heartbeat = setInterval(() => {
    try {
      const current = updateJobRecordFile(found.file, { heartbeatAt: nowIso() });
      if (current.cancelRequestedAt) {
        cancellation.abort();
      }
    } catch {}
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  try {
    const prompt = record.request?.transport === "native-review" ? "" : readPromptFile(record.briefFile);
    const args = executionArgs(record);
    const outcome = await runCodex({
      args,
      cwd: record.cwd,
      env: process.env,
      eventsFile: record.eventsFile,
      freshThread: !record.request?.resumeThreadId,
      logFile: record.logFile,
      onCheckpoint: (checkpoint) => {
        const patch = {};
        if (checkpoint.threadId && checkpoint.threadId !== checkpointedThreadId) {
          checkpointedThreadId = checkpoint.threadId;
          patch.threadId = checkpoint.threadId;
        }
        if (checkpoint.appliedServiceTier) {
          patch.appliedServiceTier = checkpoint.appliedServiceTier;
        }
        if (Object.keys(patch).length > 0) {
          updateJobRecordFile(found.file, { heartbeatAt: nowIso(), ...patch });
        }
      },
      onSpawnAttempt: (pid) => {
        updateJobRecordFile(found.file, {
          codexPid: pid,
          codexPidIdentity: null,
          codexPidIdentitySettled: false,
          codexPidOwnsProcessGroup: process.platform !== "win32",
          heartbeatAt: nowIso(),
          phase: "codex-spawning"
        });
      },
      onSpawn: (pid, identity) => {
        updateJobRecordFile(found.file, {
          codexPid: pid,
          codexPidIdentity: identity,
          codexPidIdentitySettled: false,
          codexPidOwnsProcessGroup: process.platform !== "win32",
          heartbeatAt: nowIso(),
          phase: "executing"
        });
      },
      onIdentitySettled: (pid, identity) => {
        updateJobRecordFile(found.file, {
          codexPid: pid,
          codexPidIdentity: identity,
          codexPidIdentitySettled: true,
          codexPidOwnsProcessGroup: process.platform !== "win32"
        });
      },
      prompt,
      resumeThreadId: record.request?.resumeThreadId ?? undefined,
      signal: cancellation.signal,
      timeoutMs
    });
    if (!outcome.cleanupComplete) {
      const message = outcome.errorMessage || "Codex process cleanup did not complete. The verified process identifiers were retained for retry.";
      appendJobLog(record.logFile, message);
      return cleanupRequired(found.file, outcome.failureKind ?? "process", message);
    }
    const errorTail = redactDiagnostic(readLogTail(record.logFile, 20) || boundedTail(outcome.stderrTail));
    const semantic = semanticOutcome(outcome);
    const structured = structuredOutputOutcome(record.request ?? {}, outcome);
    const resolvedModel = outcome.resolvedModel ?? record.resolvedModel;
    const modelDrift = taskModelDrift(record, prompt, resolvedModel);
    const completedRecord = { ...record, resolvedModel };
    const diagnostics = outcome.diagnostics.map((diagnostic) => ({ ...diagnostic, message: redactDiagnostic(diagnostic.message) }));
    if (isSolForegroundWriteTask(completedRecord)) {
      diagnostics.push({ type: "warning", message: SOL_FOREGROUND_WRITE_WARNING });
    }
    return finishJob(found.file, {
      cumulativeTokenUsage: outcome.cumulativeTokenUsage,
      diagnostics,
      errorMessage: outcome.errorMessage ? redactDiagnostic(outcome.errorMessage) : null,
      errorTail: outcome.status === "done" ? null : errorTail || outcome.errorMessage,
      eventsTruncated: outcome.eventsTruncated,
      exitCode: outcome.exitCode,
      failureKind: outcome.failureKind,
      protocolError: outcome.protocolError ? redactDiagnostic(outcome.protocolError) : null,
      partialResultText: outcome.partialResultText ? redactDiagnostic(outcome.partialResultText) : null,
      appliedServiceTier: outcome.appliedServiceTier ?? record.appliedServiceTier,
      resolvedEffort: outcome.resolvedEffort ?? record.resolvedEffort,
      resolvedModel,
      ...(modelDrift ? { modelDrift } : {}),
      rolloutRecoveryStatus: outcome.rolloutRecoveryStatus,
      result: {
        eventCount: outcome.eventCount,
        signal: outcome.signal,
        terminalEvent: outcome.terminalEvent,
        timedOut: outcome.timedOut
      },
      resultSource: outcome.resultSource,
      resultText: outcome.status === "done" ? outcome.finalResponse || null : null,
      semanticFailureKind: semantic.semanticFailureKind,
      semanticFailureMessage: semantic.semanticFailureMessage,
      semanticStatus: semantic.semanticStatus,
      status: outcome.status,
      ...structured,
      threadId: outcome.threadId,
      tokenUsage: outcome.tokenUsage,
      tokenUsageAvailability: outcome.tokenUsageAvailability,
      tokenUsageUnavailableReason: outcome.tokenUsageUnavailableReason,
      usageIsIncomplete: outcome.usageIsIncomplete,
      unknownEventCount: outcome.unknownEventCount
    });
  } catch (error) {
    return finishExecutionFailure(found.file, record, error);
  } finally {
    clearInterval(heartbeat);
  }
}

function renderRecord(record, asJson, runningReceipt = false) {
  if (asJson) {
    output(record, true);
    return;
  }
  if (record.status === "running") {
    output(runningReceipt ? renderBackgroundLaunch(record) : renderRunningResult(record));
    return;
  }
  output(renderTerminalResult(record));
}

export async function spawnBackgroundWorker(found, options = {}) {
  let child;
  let identity = null;
  let approvalCommitted = false;
  try {
    child = spawn(process.execPath, [SELF_PATH, "worker", "--job-id", found.record.id, "--cwd", found.record.cwd], {
      cwd: found.record.cwd,
      detached: true,
      env: options.env ?? process.env,
      stdio: "ignore",
      windowsHide: true
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await options.beforeIdentityProbe?.(child.pid);
    identity = (options.identityReader ?? getProcessIdentity)(child.pid);
    if (!identity) {
      throw new CompanionError("The background worker process identity could not be verified.", "process");
    }
    const approved = updateJobRecordFileWithCurrent(found.file, (current) => {
      if (current.launchAbortRequestedAt || current.cancelRequestedAt) {
        throw new CompanionError("The background worker launch was cancelled before approval.", "cancelled");
      }
      if (current.pid && current.pid !== child.pid) {
        throw new CompanionError(`Codex job ${current.id} was claimed by another worker.`, "process");
      }
      if (current.pidIdentity && !processIdentityMatches(child.pid, current.pidIdentity)) {
        throw new CompanionError("The background worker claim no longer matches the spawned process.", "process");
      }
      return {
        launchApprovedAt: current.launchApprovedAt ?? nowIso(),
        phase: "launch-approved",
        pid: child.pid,
        pidIdentity: identity,
        pidOwnsProcessGroup: process.platform !== "win32"
      };
    });
    if (approved.status !== "running" || !approved.launchApprovedAt || approved.launchAbortRequestedAt) {
      throw new CompanionError("The background worker launch could not be approved.", "process");
    }
    approvalCommitted = true;
    await options.afterLaunchApproval?.(approved);
    child.unref();
    return approved;
  } catch (error) {
    const env = options.env ?? process.env;
    let current = readJobRecordFile(found.file) ?? found.record;
    if (terminalRecord(current)) {
      return current;
    }
    let currentIdentity = null;
    if (child?.pid && identity) {
      try {
        currentIdentity = (options.identityReader ?? getProcessIdentity)(child.pid);
      } catch {}
    }
    const durableApproval = Boolean(
      child?.pid &&
        identity &&
        current.launchApprovedAt &&
        !current.launchAbortRequestedAt &&
        current.pid === child.pid &&
        current.pidIdentity &&
        processIdentitiesMatch(identity, current.pidIdentity) &&
        (!currentIdentity || processIdentitiesMatch(currentIdentity, current.pidIdentity))
    );
    if (approvalCommitted || durableApproval) {
      child.unref();
      return current;
    }
    if (!identity && child?.pid && current.pid === child.pid && current.pidIdentity && processIdentityMatches(child.pid, current.pidIdentity)) {
      identity = current.pidIdentity;
    }
    try {
      current = updateJobRecordFileWithCurrent(found.file, (record) => ({
        errorMessage: `Background worker launch failed: ${oneLine(error?.message ?? error, "unknown failure")}`,
        errorTail: `Background worker launch failed: ${oneLine(error?.message ?? error, "unknown failure")}`,
        failureKind: failureKindForError(error),
        launchAbortRequestedAt: record.launchAbortRequestedAt ?? nowIso(),
        phase: "launch-aborted",
        pid: record.pid ?? child?.pid ?? null,
        pidIdentity: record.pid === child?.pid && record.pidIdentity ? record.pidIdentity : identity,
        pidOwnsProcessGroup: record.pidOwnsProcessGroup || Boolean(child?.pid && process.platform !== "win32")
      }));
    } catch {}
    const claimDeadline = Date.now() + BACKGROUND_ABORT_CLAIM_WAIT_MS;
    while (child?.pid && !identity && Date.now() < claimDeadline && isProcessAlive(child.pid, null, process.platform !== "win32")) {
      current = readJobRecordFile(found.file) ?? current;
      if (terminalRecord(current)) {
        return current;
      }
      if (current.pid === child.pid && current.pidIdentity && processIdentityMatches(child.pid, current.pidIdentity)) {
        identity = current.pidIdentity;
        break;
      }
      await delay(BACKGROUND_LAUNCH_POLL_MS);
    }
    current = readJobRecordFile(found.file) ?? current;
    if (terminalRecord(current)) {
      return current;
    }
    await terminateRecorded(current, "codex", 500);
    current = readJobRecordFile(found.file) ?? current;
    if (terminalRecord(current)) {
      return current;
    }
    let workerCleanupComplete = !child?.pid || !isProcessAlive(child.pid, null, process.platform !== "win32");
    if (!workerCleanupComplete && identity) {
      workerCleanupComplete = await terminateProcessTree(child.pid, {
        allowOrphanedGroup: true,
        graceMs: 500,
        identity,
        ownsProcessGroup: process.platform !== "win32",
        requireIdentity: true
      });
    } else if (!workerCleanupComplete) {
      workerCleanupComplete = await terminateRecorded(current, "owner", 500);
    }
    current = readJobRecordFile(found.file) ?? current;
    if (terminalRecord(current)) {
      return current;
    }
    const cleanupDeadline = Date.now() + BACKGROUND_ABORT_CLEANUP_CONFIRM_MS;
    while (Date.now() < cleanupDeadline) {
      workerCleanupComplete = workerCleanupComplete || !child?.pid || !isProcessAlive(child.pid, null, process.platform !== "win32");
      if (workerCleanupComplete && cleanupComplete(current)) {
        break;
      }
      await delay(BACKGROUND_ABORT_CLEANUP_POLL_MS);
      current = readJobRecordFile(found.file) ?? current;
      if (terminalRecord(current)) {
        return current;
      }
    }
    if (!workerCleanupComplete || !cleanupComplete(current)) {
      const message = `Background worker launch failed and verified cleanup did not complete: ${oneLine(error?.message ?? error, "unknown failure")}`;
      updateJobRecordFileWithCurrent(found.file, (current) => ({
        errorMessage: message,
        errorTail: message,
        failureKind: failureKindForError(error),
        phase: "cleanup-required",
        pid: current.pid ?? child?.pid ?? null,
        pidIdentity: current.pid === child?.pid && current.pidIdentity ? current.pidIdentity : identity,
        pidOwnsProcessGroup: current.pidOwnsProcessGroup || Boolean(child?.pid && process.platform !== "win32")
      }));
      return cleanupRequired(found.file, failureKindForError(error), message);
    }
    return finishExecutionFailure(found.file, current, error, env);
  }
}

async function dispatchJob(found, asJson) {
  if (found.record.background) {
    const launched = await spawnBackgroundWorker(found);
    const launchFailed = launched.status === "error" || launched.status === "cancelled" || launched.phase === "cleanup-required";
    renderRecord(launched, asJson, !launchFailed);
    collectRenderedJob(found.file, launched);
    if (launchFailed) {
      process.exitCode = 1;
    }
    return;
  }
  const completed = await executeRecord(found);
  if (isSolForegroundWriteTask(completed)) {
    process.stderr.write(`${SOL_FOREGROUND_WRITE_WARNING}\n`);
  }
  renderRecord(completed, asJson);
  collectRenderedJob(found.file, completed);
  if (completed.status !== "done") {
    process.exitCode = 1;
  }
}

async function handleTask(rawArgv, transport = {}) {
  const { options, positionals, positionalText } = commandArgs(rawArgv, {
    booleanOptions: ["background", "fresh", "json", "network", "resume-last", "skip-git-repo-check", "web", "write"],
    optionsBeforePositionals: true,
    valueOptions: ["cwd", "effort", "model", "output-schema", "prompt-file", "resume", "service-tier"]
  });
  const serviceTier = serviceTierOption(options["service-tier"]);
  const cwd = resolveCwd(options);
  rejectImplicitSubdirectoryCwd(cwd, options);
  const dataDir = resolveDataDir();
  const resume = resolveResume(dataDir, cwd, options);
  const routing = resume.threadId ? inheritedRouting(latestJobRecordForThread(dataDir, resume.threadId), options, serviceTier) : inheritedRouting(null, options, serviceTier);
  const write = options.write ?? Boolean(transport.defaultWrite);
  const outputSchemaFile = options["output-schema"] ? resolveOutputSchemaFile(cwd, options["output-schema"]) : null;
  let prompt = readTaskPrompt(cwd, options, positionals, positionalText);
  if (!prompt.trim() && resume.threadId) {
    prompt = CONTINUE_PROMPT;
  }
  if (!prompt.trim()) {
    throw new CompanionError("Provide a Codex task prompt or --prompt-file.", "input");
  }
  if (options.network && !write) {
    throw new CompanionError("--network requires --write because network access applies to the workspace-write sandbox.", "input");
  }
  const probe = preflightCodex(cwd);
  const request = {
    effort: routing.effort,
    fresh: Boolean(options.fresh),
    ingress: transport.ingress ?? "argv",
    model: routing.model,
    network: Boolean(options.network),
    outputSchemaFile,
    resumeSourceJobId: resume.sourceJobId,
    resumeThreadId: resume.threadId,
    skipGitRepoCheck: Boolean(options["skip-git-repo-check"]),
    serviceTier: routing.serviceTier,
    transport: "task",
    web: Boolean(options.web),
    write: Boolean(write),
    ...(routing.inherited ? { inheritedFromThread: true } : {})
  };
  validateExecutionRequest(cwd, request);
  const found = createReservedJob({
    background: Boolean(options.background),
    brief: prompt,
    codexVersion: probe.version,
    companionVersion: companionVersion(),
    cwd,
    dataDir,
    jobClass: "task",
    mode: write ? "write" : "consult",
    request,
    timeoutMs: resolveExecutionTimeout(Boolean(options.background))
  });
  await dispatchJob(found, Boolean(options.json));
}

function reviewTarget(options) {
  const scope = options.scope ?? "auto";
  if (!["auto", "working-tree", "branch"].includes(scope)) {
    throw new CompanionError("--scope must be auto, working-tree, or branch.", "input");
  }
  if (scope === "working-tree" && options.base) {
    throw new CompanionError("--base cannot be combined with --scope working-tree.", "input");
  }
  if (scope === "branch" && !options.base) {
    throw new CompanionError("--scope branch requires --base <ref>.", "input");
  }
  const base = scope === "working-tree" ? null : options.base ?? null;
  return {
    base,
    description: base ? `the current branch compared with ${base}` : "the current working tree changes",
    uncommitted: !base
  };
}

function focusedReviewPrompt(target, focus) {
  return [
    "Perform a read only software review of the repository.",
    `Review target: ${target.description}.`,
    `User focus: ${focus}`,
    "Inspect the relevant Git state and source directly. Report only material, actionable findings with file paths and line numbers. Do not modify files. If no substantive finding is defensible, say so explicitly."
  ].join("\n\n");
}

function adversarialReviewPrompt(target, focus) {
  let template;
  try {
    template = fs.readFileSync(ADVERSARIAL_REVIEW_PROMPT_FILE, "utf8");
  } catch (error) {
    throw new CompanionError(`Could not read the adversarial review prompt: ${error.message}`, "input");
  }
  return template.replaceAll("{{TARGET}}", target.description).replaceAll("{{FOCUS}}", focus || "No additional focus was supplied.");
}

async function handleReview(rawArgv, adversarial = false, transport = {}) {
  const { options, positionals, positionalText } = commandArgs(rawArgv, {
    booleanOptions: ["background", "json"],
    valueOptions: ["base", "cwd", "effort", "focus", "model", "output-schema", "scope", "service-tier"]
  });
  if (options["output-schema"] != null) {
    throw new CompanionError("Codex review ignores --output-schema on tested CLI versions.", "input");
  }
  if (positionals.length > 0 && !options.focus) {
    throw new CompanionError("Review accepts flags only. Pass custom review instructions with --focus.", "input");
  }
  const cwd = resolveCwd(options);
  rejectImplicitSubdirectoryCwd(cwd, options);
  const serviceTier = serviceTierOption(options["service-tier"]);
  const probe = preflightCodex(cwd);
  const target = reviewTarget(options);
  const positionalFocus = positionalText ?? positionals.join(" ");
  const focus = [options.focus, positionalFocus].filter(Boolean).join(" ").trim();
  const usePromptTransport = adversarial || Boolean(focus);
  const brief = adversarial
    ? adversarialReviewPrompt(target, focus)
    : focus
      ? focusedReviewPrompt(target, focus)
      : "";
  const outputSchemaFile = adversarial ? resolveOutputSchemaFile(cwd, ADVERSARIAL_REVIEW_SCHEMA_FILE) : null;
  const request = {
    base: target.base,
    effort: options.effort ?? null,
    focus: focus || null,
    ingress: transport.ingress ?? "argv",
    model: options.model ?? null,
    network: false,
    outputSchemaFile,
    serviceTier,
    transport: usePromptTransport ? (adversarial ? "adversarial-review" : "focused-review") : "native-review",
    uncommitted: target.uncommitted,
    web: false,
    write: false
  };
  validateExecutionRequest(cwd, request);
  const dataDir = resolveDataDir();
  const found = createReservedJob({
    background: Boolean(options.background),
    brief,
    codexVersion: probe.version,
    companionVersion: companionVersion(),
    cwd,
    dataDir,
    jobClass: adversarial ? "adversarial-review" : "review",
    mode: "consult",
    request,
    timeoutMs: resolveExecutionTimeout(Boolean(options.background))
  });
  await dispatchJob(found, Boolean(options.json));
}

async function waitForBackgroundLaunchApproval(file, record) {
  const deadline = Date.now() + positiveEnvMs(BACKGROUND_LAUNCH_APPROVAL_TIMEOUT_ENV, BACKGROUND_LAUNCH_APPROVAL_TIMEOUT_MS);
  let current = record;
  for (;;) {
    current = readJobRecordFile(file) ?? current;
    if (current.status !== "running" || current.launchAbortRequestedAt || current.cancelRequestedAt || current.phase === "cleanup-required") {
      return current;
    }
    if (current.pid !== process.pid || !current.pidIdentity) {
      return finishExecutionFailure(file, current, new CompanionError("The background worker lost its launch claim.", "process"));
    }
    if (current.launchApprovedAt && current.phase === "launch-approved") {
      return current;
    }
    if (Date.now() >= deadline) {
      const message = "The background worker launch approval timed out.";
      let committed = false;
      const completed = updateJobRecordFileWithCurrent(file, (latest) => {
        if (latest.launchApprovedAt || latest.launchAbortRequestedAt || latest.cancelRequestedAt) {
          return null;
        }
        committed = true;
        return {
          status: "error",
          failureKind: "timeout",
          errorMessage: message,
          errorTail: message
        };
      });
      if (committed) {
        appendJobLog(record.logFile, message);
        pruneJobState(resolveDataDir(), { claudeSessionId: completed.claudeSessionId, protectedJobFiles: [file], resumeWorkspaceJobFiles: [file] });
      }
      return completed;
    }
    await delay(BACKGROUND_LAUNCH_POLL_MS);
  }
}

async function handleWorker(rawArgv) {
  const { options, positionals } = commandArgs(rawArgv, {
    valueOptions: ["cwd", "job-id"]
  });
  if (positionals.length > 0 || !options["job-id"] || !options.cwd) {
    throw new CompanionError("worker requires --job-id and --cwd.", "input");
  }
  const cwd = resolveCwd(options);
  const dataDir = resolveDataDir();
  const file = jobFilePath(dataDir, cwd, options["job-id"]);
  const record = readJobRecordFile(file);
  if (!record) {
    throw new CompanionError(`No job record found for ${options["job-id"]}.`, "input");
  }
  if (!record.background) {
    throw new CompanionError("worker can execute only a background job.", "input");
  }
  const ownerIdentity = currentProcessIdentity();
  const claimed = updateJobRecordFileWithCurrent(file, (current) => {
    if (current.pid && current.pid !== process.pid) {
      const owner = recordedProcessState(current, "owner");
      if (owner.state === "owned" || owner.state === "unverified") {
        throw new CompanionError(`Codex job ${current.id} already has a live worker.`, "input");
      }
    }
    if (current.startedAt && current.pid !== process.pid) {
      throw new CompanionError(`Codex job ${current.id} has already started.`, "input");
    }
    return {
      phase: current.launchAbortRequestedAt || current.cancelRequestedAt || current.phase === "cleanup-required" ? current.phase : current.launchApprovedAt ? "launch-approved" : "awaiting-launch-approval",
      pid: process.pid,
      pidIdentity: ownerIdentity,
      pidOwnsProcessGroup: process.platform !== "win32"
    };
  });
  if (claimed.status !== "running") {
    return;
  }
  const approved = await waitForBackgroundLaunchApproval(file, claimed);
  if (approved.status !== "running" || approved.launchAbortRequestedAt || approved.cancelRequestedAt || approved.phase === "cleanup-required") {
    process.exitCode = 1;
    return;
  }
  const completed = await executeRecord({ record: approved, file });
  if (completed.status !== "done") {
    process.exitCode = 1;
  }
}

async function handleStatus(rawArgv) {
  const { options, positionals } = commandArgs(rawArgv, {
    booleanOptions: ["all", "json"],
    valueOptions: ["cwd"]
  });
  if (positionals.length > 1) {
    throw new CompanionError("status accepts at most one job id.", "input");
  }
  const dataDir = resolveDataDir();
  if (positionals[0]) {
    const found = findRequestedJob(dataDir, positionals[0], options);
    if (!found) {
      throw new CompanionError(`No job record found for ${positionals[0]}.`, "input");
    }
    const record = await refreshRunningJobRecord(found);
    output(options.json ? record : renderJobDetail(record), Boolean(options.json));
    return;
  }
  if (options.all && options.cwd) {
    throw new CompanionError("--all cannot be combined with --cwd.", "input");
  }
  const cwd = options.all ? null : resolveCwd(options);
  const entries = options.all
    ? listAllJobRecords(dataDir)
    : listJobRecords(dataDir, cwd).map((record) => ({ record, file: jobFilePath(dataDir, cwd, record.id) }));
  const records = [];
  for (const entry of entries) {
    records.push(await refreshRunningJobRecord(entry));
  }
  output(options.json ? { jobs: records } : renderStatusTable(records), Boolean(options.json));
}

async function handleHistory(rawArgv) {
  const { options, positionals } = commandArgs(rawArgv, {
    booleanOptions: ["json"]
  });
  if (positionals.length > 0) {
    throw new CompanionError("history accepts only --json.", "input");
  }
  const records = [];
  for (const entry of listAllJobRecords(resolveDataDir())) {
    records.push(await refreshRunningJobRecord(entry));
  }
  output(
    options.json
      ? { jobs: records, sidebarVisibility: "not_guaranteed_for_exec_sessions", source: "canonical" }
      : renderStatusTable(records),
    Boolean(options.json)
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForResult(found, options) {
  const deadline = Date.now() + resolveWaitTimeout(options);
  const pollMs = resolveWaitPoll();
  let record = found.record;
  for (;;) {
    record = await refreshRunningJobRecord({ record, file: found.file });
    if (record.status !== "running") {
      return record;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return record;
    }
    await delay(Math.min(pollMs, remaining));
    record = readJobRecordFile(found.file) ?? record;
  }
}

async function handleResult(rawArgv) {
  const { options, positionals } = commandArgs(rawArgv, {
    booleanOptions: ["json", "wait"],
    valueOptions: ["cwd", "wait-timeout-ms"]
  });
  if (positionals.length !== 1) {
    throw new CompanionError("Provide exactly one Codex job id.", "input");
  }
  const dataDir = resolveDataDir();
  const found = findRequestedJob(dataDir, positionals[0], options);
  if (!found) {
    throw new CompanionError(`No job record found for ${positionals[0]}.`, "input");
  }
  const record = options.wait ? await waitForResult(found, options) : await refreshRunningJobRecord(found);
  renderRecord(record, Boolean(options.json));
  collectRenderedJob(found.file, record);
  if (record.status === "error" || record.status === "cancelled" || record.phase === "cleanup-required") {
    process.exitCode = 1;
  }
}

async function cancelFoundJob(found) {
  let record = await refreshRunningJobRecord(found);
  if (record.status !== "running") {
    return record;
  }
  const spawnCheckpointPending = codexSpawnCheckpointPending(record);
  record = updateJobRecordFileWithCurrent(found.file, (current) => ({
    cancelRequestedAt: nowIso(),
    phase: "cancelling"
  }));
  if (record.status !== "running") {
    return record;
  }
  if (spawnCheckpointPending) {
    signalRecorded(record, "owner");
    return cleanupRequired(found.file, "cancelled", "Cancellation was requested while the Codex process identity checkpoint was incomplete. Graceful cleanup was requested without forcing the companion to exit.");
  }
  await Promise.all([terminateRecorded(record, "codex", 500), terminateRecorded(record, "owner", 500)]);
  const refreshed = readJobRecordFile(found.file) ?? record;
  if (!cleanupComplete(refreshed)) {
    return cleanupRequired(found.file, "cancelled", "Cancellation was requested, but verified process cleanup did not complete. The process identifiers were retained for retry.");
  }
  return finishJob(found.file, {
    status: "cancelled",
    failureKind: "cancelled",
    errorMessage: "Codex job was cancelled."
  });
}

async function handleCancel(rawArgv) {
  const { options, positionals } = commandArgs(rawArgv, {
    booleanOptions: ["json"],
    valueOptions: ["cwd"]
  });
  if (positionals.length !== 1) {
    throw new CompanionError("Provide exactly one Codex job id.", "input");
  }
  const dataDir = resolveDataDir();
  const found = findRequestedJob(dataDir, positionals[0], options);
  if (!found) {
    throw new CompanionError(`No job record found for ${positionals[0]}.`, "input");
  }
  const record = await cancelFoundJob(found);
  const rendered = record.status === "cancelled" ? renderCancelReport(record) : record.status === "running" ? renderRunningResult(record) : renderTerminalResult(record);
  output(options.json ? record : rendered, Boolean(options.json));
  if (record.status === "running") {
    process.exitCode = 1;
  }
}

async function handleRecordAcceptance(argv) {
  const { acceptance, acceptFailedTransport, failureKind, jobId, reason, source } = recordAcceptanceArgs(argv);
  const found = findJobRecordById(resolveDataDir(), jobId);
  if (!found) {
    throw new CompanionError(`No job record found for ${jobId}.`, "input");
  }
  const record = updateJobRecordFileWithCurrent(found.file, (current) => {
    if (acceptance === "accepted" && current.status !== "done" && !acceptFailedTransport) {
      throw new CompanionError(`Codex job ${current.id} has transport status ${current.status}. Pass --accept-failed-transport to record accepted.`, "input");
    }
    if (acceptance !== "rejected") {
      return {
        acceptanceRecordedAt: nowIso(),
        acceptanceSource: source,
        semanticFailureKind: null,
        semanticFailureMessage: null,
        semanticStatus: acceptance
      };
    }
    return {
      acceptanceRecordedAt: nowIso(),
      acceptanceSource: source,
      semanticFailureKind: failureKind ?? null,
      semanticFailureMessage: reason,
      semanticStatus: acceptance
    };
  }, { allowTerminal: true });
  output(`Recorded verdict for Codex job ${record.id}: ${record.semanticStatus}.\n`);
}

function readHookInput() {
  if (isatty(0)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function handleSessionEnd() {
  const input = readHookInput();
  const sessionId = input.session_id ?? currentClaudeSessionId();
  pruneRawCommandTransports({ sessionId });
  if (!sessionId) {
    return;
  }
  const owned = listAllJobRecords(resolveDataDir()).filter(
    (found) => found.record.status === "running" && found.record.claudeSessionId === sessionId
  );
  const marked = owned.map((found) => {
    try {
      const record = updateJobRecordFileWithCurrent(found.file, (current) => ({
        cancelRequestedAt: current.cancelRequestedAt ?? nowIso(),
        phase: "cancelling"
      }));
      return { ...found, record };
    } catch {
      return found;
    }
  });
  await Promise.all(
    marked.map(async (found) => {
      try {
        await cancelFoundJob(found);
      } catch {}
    })
  );
}

async function handleResumeCandidate(rawArgv) {
  const { options, positionals } = commandArgs(rawArgv, {
    booleanOptions: ["json"],
    valueOptions: ["cwd"]
  });
  if (positionals.length > 0) {
    throw new CompanionError("task-resume-candidate accepts flags only.", "input");
  }
  const cwd = resolveCwd(options);
  const record = latestResumeRecord(resolveDataDir(), cwd, currentClaudeSessionId());
  if (options.json) {
    output({ jobId: record.id, threadId: record.threadId }, true);
    return;
  }
  output(`codex-session: ${record.threadId}\njob: ${record.id}\nstate: ${record.status}\n`);
}

function authenticationStatus(bin, cwd, env = process.env) {
  const result = spawnSync(bin, ["login", "status"], {
    cwd,
    encoding: "utf8",
    env,
    timeout: 5000,
    windowsHide: true
  });
  if (!result.error && typeof result.status === "number" && result.status !== 0 && typeof env.CODEX_API_KEY === "string" && env.CODEX_API_KEY.trim()) {
    return {
      authenticated: true,
      detail: "authenticated via CODEX_API_KEY environment variable (login status reports logged out)"
    };
  }
  return {
    authenticated: !result.error && result.status === 0,
    detail: String(result.stdout || result.stderr || result.error?.message || "").trim() || null
  };
}

function handleSetup(rawArgv) {
  const { options, positionals } = commandArgs(rawArgv, {
    booleanOptions: ["json"],
    valueOptions: ["cwd"]
  });
  if (positionals.length > 0) {
    throw new CompanionError("setup accepts flags only.", "input");
  }
  const cwd = resolveCwd(options);
  const codex = getCodexAvailability({ cwd, env: process.env });
  const auth = codex.available ? authenticationStatus(codex.bin, cwd, process.env) : { authenticated: false, detail: null };
  const compatible = codex.available && supportedVersion(codex.version);
  const installedVersion = parseVersion(codex.version);
  const newerThanTested = Boolean(installedVersion) && compareVersion(installedVersion, TESTED_VERSION_MAX) >= 0;
  const testedInterval = testedVersionInterval();
  const dataDir = resolveDataDir();
  let writable = true;
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    fs.accessSync(dataDir, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  const nextSteps = [];
  if (!codex.available) {
    nextSteps.push("Install the official OpenAI Codex CLI, then run /codex:setup again.");
  } else if (!auth.authenticated) {
    nextSteps.push("Run codex login, then run /codex:setup again.");
  }
  if (codex.available && !compatible) {
    nextSteps.push(newerThanTested ? `Codex CLI version ${codex.version} is newer than the tested interval (${testedInterval}). A verification pass is advised.` : `Use a Codex CLI version in the tested interval (${testedInterval}).`);
  }
  if (!writable) {
    nextSteps.push(`Make the adapter data directory writable: ${dataDir}.`);
  }
  const report = {
    authenticated: auth.authenticated,
    authenticationDetail: auth.detail ? redactDiagnostic(boundedTail(auth.detail, 5)) : null,
    codex: {
      ...codex,
      bin: redactDiagnostic(codex.bin),
      errorMessage: codex.errorMessage ? redactDiagnostic(boundedTail(codex.errorMessage, 5)) : null,
      rawVersion: codex.rawVersion ? redactDiagnostic(boundedTail(codex.rawVersion, 5)) : null
    },
    compatibility: compatible ? "tested" : codex.available ? newerThanTested ? `newer than the tested interval (${testedInterval})` : `outside the tested interval (${testedInterval})` : "unknown",
    dataDir,
    nextSteps,
    ready: codex.available && auth.authenticated && compatible && writable,
    writable
  };
  output(options.json ? report : renderSetupReport(report), Boolean(options.json));
  if (!report.ready) {
    process.exitCode = 1;
  }
}

async function main() {
  const [subcommand, ...receivedArgv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }
  if (subcommand === "transport-create") {
    if (receivedArgv.length > 0) {
      throw new CompanionError("transport-create accepts no arguments.", "input");
    }
    createRawCommandTransport();
    return;
  }
  if (subcommand === "transport-discard") {
    if (receivedArgv.length !== 2 || receivedArgv[0] !== "--raw-args-token") {
      throw new CompanionError("transport-discard requires exactly one raw argument token.", "input");
    }
    consumeRawCommandTransport(receivedArgv[1], { allowUnwritten: true });
    return;
  }
  if (subcommand === "record-acceptance") {
    activeCommandArgv = receivedArgv;
    await handleRecordAcceptance(receivedArgv);
    return;
  }
  const transport = resolveCommandTransport(receivedArgv);
  if (transport.defaultWrite && subcommand !== "task") {
    throw new CompanionError("The raw command transport write default is valid only for task.", "input");
  }
  const rawArgv = transport.argv;
  activeCommandArgv = rawArgv;
  switch (subcommand) {
    case "task":
      await handleTask(rawArgv, transport);
      break;
    case "worker":
      await handleWorker(rawArgv);
      break;
    case "review":
      await handleReview(rawArgv, false, transport);
      break;
    case "adversarial-review":
      await handleReview(rawArgv, true, transport);
      break;
    case "status":
      await handleStatus(rawArgv);
      break;
    case "history":
      await handleHistory(rawArgv);
      break;
    case "result":
      await handleResult(rawArgv);
      break;
    case "cancel":
      await handleCancel(rawArgv);
      break;
    case "setup":
      handleSetup(rawArgv);
      break;
    case "task-resume-candidate":
      await handleResumeCandidate(rawArgv);
      break;
    case "session-end":
      await handleSessionEnd();
      break;
    default:
      throw new CompanionError(`Unknown subcommand: ${subcommand}.`, "input");
  }
}

function wantsJsonError() {
  const raw = activeCommandArgv ?? process.argv.slice(3);
  try {
    return normalizeArgv(raw).some((token) => token === "--json" || token === "--json=true");
  } catch {
    return raw.some((token) => token.includes("--json"));
  }
}

function renderTopLevelError(error) {
  const message = redactDiagnostic(oneLine(error?.message ?? error, "Codex companion failed."));
  const failureKind = failureKindForError(error);
  if (wantsJsonError()) {
    return `${JSON.stringify({ status: "error", failureKind, message }, null, 2)}\n`;
  }
  return `${message}\nstate: error\nfailure: ${failureKind}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  main().catch((error) => {
    if (process.argv[2] !== "session-end") {
      process.stderr.write(renderTopLevelError(error));
      process.exitCode = 1;
    }
  });
}
