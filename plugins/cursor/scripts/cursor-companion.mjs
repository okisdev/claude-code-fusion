import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";

import { parseArgs, parseRawArgs, rawBooleanOptionRequested } from "./lib/args.mjs";
import { resolveCursorBin, probeCursorVersion, compareCursorVersion, TESTED_CURSOR_INTERVAL, buildCursorArgs, buildCursorChildEnv, runCursor, classifyCursorFailure, reapPrivateHomeHelpers } from "./lib/cursor-exec.mjs";
import { buildPrivateHome, copyChatForResume, projectHookFiles, CURSOR_SESSION_ID_PATTERN } from "./lib/cursor-home.mjs";
import { readModelCatalog, resolveCursorModel } from "./lib/cursor-models.mjs";
import { getProcessIdentity, processIdentityMatches, processIsDirectlyAlive } from "./lib/process-identity.mjs";
import { extractFirstJsonObject, validateReviewOutput, renderReviewResult, renderBackgroundLaunch, renderTaskResult, renderStatusTable, renderJobDetail, renderHistoryReport, renderCancelReport, renderRecordAcceptance, renderSetupReport } from "./lib/render.mjs";
import { SESSION_ID_ENV, resolveDataDir, runHomeDir, generateJobId, nowIso, createJobRecord, createJobRecordFile, updateJobRecordFile, updateJobRecordFileWithCurrent, finishSuccessfulJobRecordFile, launchRunningJobProcess, listJobRecords, listAllJobRecords, findJobRecordById, jobFilePath, jobLogPath, briefPath, readJobRecordFile, writeBrief, appendJobLog, readLogTail, markDeliveryCollectedFile, claimResumeSessionLease } from "./lib/state.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const MAX_RAW_ARGUMENT_BYTES = 4 * 1024 * 1024 + 64 * 1024;
const TRANSPORT_DIRECTORY_PREFIX = "cursor-companion-input-";
const TRANSPORT_TOKEN_PATTERN = /^[a-f0-9]{48}$/;
const TRANSPORT_OWNER_FILE = "owner.json";
const TRANSPORT_OWNER_MAX_BYTES = 4096;
const TRANSPORT_MAX_AGE_MS = 60 * 60 * 1000;
const JOB_ID_PATTERN = /^[a-f0-9]{32}$/;
const ACCEPTANCE_VALUES = new Set(["accepted", "rejected", "unverified"]);
const ACCEPTANCE_SOURCES = new Set(["collector", "main-loop", "stats"]);
const SEMANTIC_FAILURE_KINDS = new Set(["intent_override", "scope_rewrite", "wrong_approach", "style_mismatch", "oversized"]);
let activeArgv = null;
let activeOptions = null;
let activeIngress = "argv";
let activeConfig = null;

function errorWithFailure(message, failureKind = "input") {
  const error = new Error(message);
  error.failureKind = failureKind;
  return error;
}

function output(value, json = false) {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : String(value));
}

function currentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
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

function commandArgs(argv, config, transport = {}) {
  activeConfig = config;
  activeOptions = null;
  try {
    const parsed = transport.ingress === "staged_file" ? parseRawArgs(argv[0] ?? "", config) : { ...parseArgs(argv, config), positionalText: null };
    activeOptions = parsed.options;
    return parsed;
  } catch (error) {
    throw errorWithFailure(error.message, error.failureKind ?? "input");
  }
}

function positiveDuration(envName, fallback) {
  const value = Number(process.env[envName]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function resolveCwd(options) {
  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  let stats;
  try { stats = fs.statSync(cwd); } catch { throw errorWithFailure(`Working directory does not exist: ${cwd}.`); }
  if (!stats.isDirectory()) throw errorWithFailure(`Working directory is not a directory: ${cwd}.`);
  return cwd;
}

function repositoryTopLevel(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function validateImplicitCwd(options, cwd) {
  if (options.cwd !== undefined) return;
  const root = repositoryTopLevel(cwd);
  if (root && fs.realpathSync(cwd) !== fs.realpathSync(root)) {
    throw errorWithFailure(`Implicit working directory ${cwd} is inside repository ${root} but is not its root. Pass --cwd to confirm the sandbox root.`);
  }
}

function readStdinIfPiped() {
  if (isatty(0)) return "";
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  for (;;) {
    let bytes;
    try { bytes = fs.readSync(0, buffer, 0, buffer.length, null); }
    catch (error) { if (error.code === "EAGAIN") continue; throw error; }
    if (bytes === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytes)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function realUserHome() {
  return process.env.HOME || os.homedir();
}

function selectedModel() {
  const file = path.join(realUserHome(), ".cursor", "cli-config.json");
  try {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    return config.selectedModel?.modelId || config.model?.modelId || null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw errorWithFailure(`Cannot read the selected Cursor model: ${error.message}`);
  }
}

const CURSOR_ROLES = new Set(["diversity", "burst"]);

function taskRole(brief) {
  const lines = brief.split(/\r?\n/).filter((line) => line.trim()).slice(0, 12);
  const lane = lines[0]?.trim().match(/^lane:\s*cursor\s+([a-z][a-z-]*)/i)?.[1]?.toLowerCase();
  if (CURSOR_ROLES.has(lane)) return lane;
  for (const line of lines) {
    const role = line.match(/(?:^|[\s;,|])cursor-role:\s*([^\s;,|]+)/i)?.[1]?.toLowerCase();
    if (role) return CURSOR_ROLES.has(role) ? role : null;
  }
  return null;
}

function terminal(record) {
  return ["done", "error", "cancelled"].includes(record.status);
}

function resumeSource(dataDir, cwd, mode, options) {
  if (options.resume && (options["resume-last"] || options.fresh) || options["resume-last"] && options.fresh) {
    throw errorWithFailure("Use only one of --resume, --resume-last, or --fresh.");
  }
  if (!options.resume && !options["resume-last"]) return null;
  if (options.resume && !CURSOR_SESSION_ID_PATTERN.test(options.resume)) throw errorWithFailure("Invalid Cursor session id.");
  const eligible = listJobRecords(dataDir, cwd).filter((record) => terminal(record) && record.jobClass === "task" && record.mode === mode && CURSOR_SESSION_ID_PATTERN.test(record.sessionId) && record.homeDir);
  if (options.resume) {
    const source = eligible.find((record) => record.sessionId === options.resume);
    if (!source) throw errorWithFailure(`No finished ${mode} Cursor task owns session ${options.resume} in this workspace.`);
    return source;
  }
  const sessionId = currentClaudeSessionId();
  const source = eligible.find((record) => !sessionId || record.claudeSessionId === sessionId);
  if (!source) throw errorWithFailure(`No finished ${mode} Cursor task can be resumed in this workspace.`);
  return source;
}

function taskPayload(record) {
  return {
    jobId: record.id, status: record.status, transportStatus: record.transportStatus,
    semanticStatus: record.semanticStatus, delivery: record.delivery, deliveryStatus: record.deliveryStatus,
    jobClass: record.jobClass, mode: record.mode, background: record.background, exitCode: record.exitCode,
    sessionId: record.sessionId, requestId: record.requestId, resumedFromJobId: record.resumedFromJobId ?? null,
    requestedModel: record.requestedModel,
    resolvedModel: record.resolvedModel, observedModel: record.observedModel,
    requestedEffort: record.requestedEffort, resolvedEffort: record.requestedEffort,
    effortApplied: record.effortApplied, billingPool: record.billingPool, usage: record.usage,
    usageIsIncomplete: record.usageIsIncomplete, warnings: record.warnings,
    failureKind: record.failureKind,
    ...(record.jobClass === "review" ? { valid: record.status === "done", review: record.review ?? null, parseError: record.parseError ?? null } : {}),
    ...(record.status === "done" ? { text: record.resultText } : { message: record.errorMessage })
  };
}

function renderOutcome(record) {
  if (record.status === "done") return renderTaskResult({ text: record.resultText, record });
  if (record.status === "cancelled") return renderTaskResult({ text: `Job ${record.id} was cancelled.`, record });
  const tail = record.errorTail && record.errorTail !== record.errorMessage ? `\n\nLog tail:\n\n\`\`\`text\n${record.errorTail}\n\`\`\`` : "";
  return renderTaskResult({ text: `Job ${record.id} failed.\n\n${record.errorMessage ?? "Cursor returned an error."}${tail}`, record });
}

function finishFailure(file, outcome, kind, warnings) {
  const message = outcome.policyViolation ? `Cursor called forbidden tool ${outcome.policyViolation}.` : outcome.protocolError || outcome.stderrTail?.trim() || outcome.spawnError?.message || `Cursor exited with ${outcome.exitCode ?? outcome.signal ?? "an error"}.`;
  return finishSuccessfulJobRecordFile(file, {
    status: "error", finishedAt: nowIso(), exitCode: outcome.exitCode, sessionId: outcome.sessionId,
    requestId: outcome.requestId, resultText: outcome.resultText, observedModel: outcome.observedModel,
    usage: outcome.usage, usageIsIncomplete: outcome.usage == null, warnings,
    failureKind: kind, errorMessage: message.split(/\r?\n/)[0], errorTail: String(outcome.stderrTail || message).slice(-65536)
  });
}

async function runRecordedJob(record, file) {
  const dataDir = resolveDataDir();
  let outcome;
  let signalExitCode = null;
  try {
    const brief = fs.readFileSync(record.briefFile, "utf8");
    const sourceId = record.request?.resumeSourceJobId;
    const source = sourceId ? readJobRecordFile(jobFilePath(dataDir, record.cwd, sourceId)) : null;
    if (sourceId && (!source || !CURSOR_SESSION_ID_PATTERN.test(source.sessionId) || source.sessionId !== record.request.resumeSessionId)) throw errorWithFailure("The resume source is unavailable.");
    if (source) claimResumeSessionLease(dataDir, record.cwd, source.sessionId, record.id);
    buildPrivateHome({ homeDir: record.homeDir, mode: record.mode, cwd: record.cwd, realHome: realUserHome() });
    if (source && !copyChatForResume({ fromHome: source.homeDir, toHome: record.homeDir, cwd: record.cwd, sessionId: source.sessionId })) {
      throw errorWithFailure(`Cursor chat ${source.sessionId} was not found in the parent private home.`);
    }
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
    const controller = new AbortController();
    const handlers = signals.map((signal) => [signal, () => {
      if (signalExitCode !== null) return;
      signalExitCode = signal === "SIGINT" ? 130 : 143;
      controller.abort();
    }]);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    try {
      outcome = await runCursor({ bin: record.cursorBuildPath, args: buildCursorArgs({ mode: record.mode, variant: record.resolvedModel, cwd: record.cwd, resumeSessionId: source?.sessionId }),
        cwd: record.cwd, env: buildCursorChildEnv({ homeDir: record.homeDir, dataDir }), brief, mode: record.mode, signal: controller.signal,
        timeoutMs: positiveDuration("CURSOR_COMPANION_TIMEOUT_MS", 540000),
        exitGraceMs: positiveDuration("CURSOR_COMPANION_EXIT_GRACE_MS", 15000),
        onInit: (pid) => updateJobRecordFileWithCurrent(file, (current) => current.status === "running" && current.cursorPid === pid ? { ...current, cursorPidIdentity: getProcessIdentity(pid) } : current),
        launchProcess: (launch) => launchRunningJobProcess(file, () => {
          const child = launch();
          return { child, identity: getProcessIdentity(child.pid) };
        }).child });
    } finally {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    }
  } catch (error) {
    outcome = { exitCode: null, stderrTail: error.message, spawnError: error, initSeen: false, resultSeen: false };
  }
  if (signalExitCode !== null) {
    finishSuccessfulJobRecordFile(file, { status: "cancelled", finishedAt: nowIso(), exitCode: outcome.exitCode, failureKind: "cancelled", errorMessage: "The Cursor job was cancelled." });
    process.exit(signalExitCode);
  }
  if (outcome.stderrTail) appendJobLog(jobLogPath(dataDir, record.cwd, record.id), outcome.stderrTail);
  const kind = outcome.spawnError?.failureKind ?? classifyCursorFailure(outcome);
  const warnings = outcome.lateClose ? [...record.warnings, "late_close"] : record.warnings;
  if (kind) return finishFailure(file, outcome, kind, warnings);
  if (record.jobClass === "review") {
    const parsed = extractFirstJsonObject(outcome.resultText);
    const validation = parsed ? validateReviewOutput(parsed) : { valid: false, error: "No JSON object found in the reply." };
    if (!validation.valid) {
      const message = `Cursor review output failed validation: ${validation.error}`;
      return finishSuccessfulJobRecordFile(file, { status: "error", finishedAt: nowIso(), exitCode: outcome.exitCode,
        sessionId: outcome.sessionId, requestId: outcome.requestId, observedModel: outcome.observedModel,
        usage: outcome.usage, usageIsIncomplete: outcome.usage == null, warnings, failureKind: "error",
        errorMessage: message, errorTail: outcome.resultText?.slice(-65536) || message, parseError: validation.error });
    }
    return finishSuccessfulJobRecordFile(file, { status: "done", finishedAt: nowIso(), exitCode: outcome.exitCode,
      sessionId: outcome.sessionId, requestId: outcome.requestId, observedModel: outcome.observedModel,
      usage: outcome.usage, usageIsIncomplete: outcome.usage == null, warnings, failureKind: null,
      review: validation.value, resultText: renderReviewResult(validation.value, { targetLabel: record.request.reviewTargetLabel }) });
  }
  return finishSuccessfulJobRecordFile(file, {
    status: "done", finishedAt: nowIso(), exitCode: outcome.exitCode, sessionId: outcome.sessionId,
    requestId: outcome.requestId, resultText: outcome.resultText, observedModel: outcome.observedModel,
    usage: outcome.usage, usageIsIncomplete: outcome.usage == null, warnings, failureKind: null
  });
}

async function spawnBackgroundWorker(record, file) {
  let child;
  let identity;
  try {
    const launched = launchRunningJobProcess(file, () => {
      child = spawn(process.execPath, [SELF_PATH, `${record.jobClass}-worker`, record.id, "--cwd", record.cwd], {
        detached: true, stdio: "ignore", env: process.env
      });
      identity = getProcessIdentity(child.pid);
      return { child, identity };
    }, { processRole: "worker" });
    child = launched.child;
    const spawned = new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    await spawned;
    child.unref();
  } catch (error) {
    if (Number.isInteger(child?.pid) && child.pid > 1) {
      const cleanup = { pid: child.pid, pidIdentity: identity, background: true };
      const clean = terminateOwned(cleanup) && await waitForCleanup(cleanup);
      if (!clean) {
        updateJobRecordFileWithCurrent(file, (current) => current.status === "running" ? {
          ...current, cleanupRequired: true, failureKind: error.failureKind ?? "error",
          errorMessage: "Verified background worker cleanup did not complete."
        } : current);
        throw error;
      }
    }
    finishSuccessfulJobRecordFile(file, { status: "error", finishedAt: nowIso(), failureKind: error.failureKind ?? "error", errorMessage: error.message });
    throw error;
  }
}

function emitJob(record, json) {
  output(json ? taskPayload(record) : renderOutcome(record), json);
  if (record.status !== "done") process.exitCode = 1;
}

async function handleTask(argv, transport) {
  const { options, positionals, positionalText } = commandArgs(argv, {
    valueOptions: ["model", "effort", "resume", "cwd"],
    booleanOptions: ["write", "resume-last", "fresh", "background", "json"], optionsBeforePositionals: true
  }, transport);
  const cwd = resolveCwd(options);
  validateImplicitCwd(options, cwd);
  const mode = (options.write ?? transport.defaultWrite) ? "write" : "consult";
  const dataDir = resolveDataDir();
  const source = resumeSource(dataDir, cwd, mode, options);
  const brief = (positionalText ?? positionals.join(" ")).trim() || readStdinIfPiped().trim();
  if (!brief) throw errorWithFailure("Provide a brief after -- or on stdin.");
  const bin = resolveCursorBin();
  const probe = probeCursorVersion(bin);
  if (compareCursorVersion(probe.version, TESTED_CURSOR_INTERVAL.floor) < 0) {
    throw errorWithFailure(`Cursor CLI ${probe.version} is below tested floor ${TESTED_CURSOR_INTERVAL.floor}.`, "setup");
  }
  const requestedModel = options.model || selectedModel();
  if (!requestedModel) throw errorWithFailure("Select a Cursor model in ~/.cursor/cli-config.json or pass --model.");
  const catalog = readModelCatalog({ dataDir, bin: probe.buildPath });
  const requestedEffort = options.effort ?? "default";
  const resolved = resolveCursorModel({ catalog, model: requestedModel, effort: requestedEffort });
  const warnings = projectHookFiles(cwd).map((file) => `project hooks run outside the Cursor sandbox: ${file}`);
  const id = generateJobId();
  const homeDir = runHomeDir(dataDir, id);
  const briefFile = briefPath(dataDir, cwd, id);
  const file = jobFilePath(dataDir, cwd, id);
  const background = Boolean(options.background);
  const record = createJobRecord({ id, cursorVersion: probe.version, cursorBuildPath: probe.buildPath, pid: background ? null : process.pid,
    mode, cwd, briefFile, background, claudeSessionId: currentClaudeSessionId(), jobClass: "task",
    role: taskRole(brief), requestedModel, resolvedModel: resolved.variant, requestedEffort, effortApplied: resolved.effortApplied,
    billingPool: resolved.billingPool, homeDir, warnings,
    request: { model: requestedModel, effort: requestedEffort, resumeSessionId: source?.sessionId ?? null,
      resumeSourceJobId: source?.id ?? null, outputJson: Boolean(options.json), ingress: transport.ingress } });
  if (source) record.resumedFromJobId = source.id;
  createJobRecordFile(file, record);
  try {
    writeBrief(dataDir, cwd, id, brief);
  } catch (error) {
    finishSuccessfulJobRecordFile(file, { status: "error", finishedAt: nowIso(), failureKind: error.failureKind ?? "error", errorMessage: error.message });
    throw error;
  }
  if (background) {
    await spawnBackgroundWorker(record, file);
    output(options.json ? taskPayload(record) : renderBackgroundLaunch(id, record.delivery, cwd), options.json);
    return;
  }
  emitJob(await runRecordedJob(record, file), options.json);
}

async function handleWorker(argv, jobClass) {
  const { options, positionals } = parseArgs(argv, { valueOptions: ["cwd"] });
  if (positionals.length !== 1 || !JOB_ID_PATTERN.test(positionals[0]) || !options.cwd) throw errorWithFailure(`Invalid ${jobClass}-worker invocation.`);
  const file = jobFilePath(resolveDataDir(), resolveCwd(options), positionals[0]);
  let record = readJobRecordFile(file);
  const registration = Date.now() + 5000;
  while (record?.status === "running" && record.pid !== process.pid && Date.now() < registration) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    record = readJobRecordFile(file);
  }
  if (!record || record.jobClass !== jobClass || !record.background || record.status !== "running" || record.pid !== process.pid) return;
  try { await runRecordedJob(record, file); }
  catch (error) {
    finishSuccessfulJobRecordFile(file, { status: "error", finishedAt: nowIso(), failureKind: error.failureKind ?? "error", errorMessage: error.message });
  }
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw errorWithFailure(`git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr?.trim() ?? "unknown error"}`);
  return result.stdout ?? "";
}

function collectReviewTarget(cwd, base) {
  if (base) {
    const range = runGit(["diff", `${base}...HEAD`], cwd);
    const uncommitted = runGit(["diff", "HEAD"], cwd);
    return { label: `changes since ${base}`, diff: [range.trim(), uncommitted.trim()].filter(Boolean).join("\n\n") };
  }
  const tracked = runGit(["diff", "HEAD"], cwd);
  const porcelain = runGit(["status", "--porcelain"], cwd);
  const untracked = porcelain.split(/\r?\n/).filter((line) => line.startsWith("??")).map((line) => line.slice(3).trim()).filter(Boolean);
  const parts = [tracked.trim()].filter(Boolean);
  if (untracked.length) parts.push(["Untracked files:", ...untracked.map((file) => `- ${file}`)].join("\n"));
  return { label: "working tree changes", diff: parts.join("\n\n") };
}

async function handleReview(argv, transport) {
  const { options, positionals, positionalText } = commandArgs(argv, {
    valueOptions: ["scope", "base", "focus", "model", "effort", "cwd"],
    booleanOptions: ["background", "json"], optionsBeforePositionals: true
  }, transport);
  if (positionals.length || positionalText?.trim()) throw errorWithFailure("Review accepts no positional arguments. Use --focus.");
  const scope = options.scope ?? "auto";
  if (!["auto", "working-tree", "branch"].includes(scope)) throw errorWithFailure("--scope must be auto, working-tree, or branch.");
  if (scope === "working-tree" && options.base) throw errorWithFailure("--base cannot be combined with --scope working-tree.");
  if (scope === "branch" && !options.base) throw errorWithFailure("--scope branch requires --base <ref>.");
  const cwd = resolveCwd(options);
  validateImplicitCwd(options, cwd);
  const target = collectReviewTarget(cwd, scope === "working-tree" ? null : options.base);
  if (!target.diff.trim()) throw errorWithFailure("No changes found to review.");
  const template = fs.readFileSync(new URL("../prompts/review.md", import.meta.url), "utf8");
  const prompt = template.replace(/\{\{(\w+)\}\}/g, (match, key) => ({
    TARGET_LABEL: target.label, USER_FOCUS: options.focus?.trim() || "No extra focus provided.", DIFF: target.diff
  })[key] ?? match);
  const dataDir = resolveDataDir();
  const probe = probeCursorVersion(resolveCursorBin());
  if (compareCursorVersion(probe.version, TESTED_CURSOR_INTERVAL.floor) < 0) throw errorWithFailure(`Cursor CLI ${probe.version} is below tested floor ${TESTED_CURSOR_INTERVAL.floor}.`, "setup");
  const requestedModel = options.model || selectedModel();
  if (!requestedModel) throw errorWithFailure("Select a Cursor model in ~/.cursor/cli-config.json or pass --model.");
  const catalog = readModelCatalog({ dataDir, bin: probe.buildPath });
  const requestedEffort = options.effort ?? "default";
  const resolved = resolveCursorModel({ catalog, model: requestedModel, effort: requestedEffort });
  const warnings = projectHookFiles(cwd).map((file) => `project hooks run outside the Cursor sandbox: ${file}`);
  const id = generateJobId();
  const background = Boolean(options.background || transport.defaultBackground);
  const briefFile = briefPath(dataDir, cwd, id);
  const file = jobFilePath(dataDir, cwd, id);
  const record = createJobRecord({ id, cursorVersion: probe.version, cursorBuildPath: probe.buildPath, pid: background ? null : process.pid,
    mode: "review", cwd, briefFile, background, claudeSessionId: currentClaudeSessionId(), jobClass: "review",
    requestedModel, resolvedModel: resolved.variant, requestedEffort, effortApplied: resolved.effortApplied,
    billingPool: resolved.billingPool, homeDir: runHomeDir(dataDir, id), warnings,
    request: { model: requestedModel, effort: requestedEffort, reviewTargetLabel: target.label,
      outputJson: Boolean(options.json), ingress: transport.ingress } });
  createJobRecordFile(file, record);
  try { writeBrief(dataDir, cwd, id, prompt); }
  catch (error) {
    finishSuccessfulJobRecordFile(file, { status: "error", finishedAt: nowIso(), failureKind: error.failureKind ?? "error", errorMessage: error.message });
    throw error;
  }
  if (background) {
    await spawnBackgroundWorker(record, file);
    output(options.json ? taskPayload(record) : renderBackgroundLaunch(id, record.delivery, cwd), options.json);
    return;
  }
  emitJob(await runRecordedJob(record, file), options.json);
}
function requestedJob(dataDir, id, options) {
  if (!JOB_ID_PATTERN.test(String(id ?? ""))) throw errorWithFailure("Cursor job ids must be exactly 32 lowercase hexadecimal characters.");
  if (options.cwd === undefined) return findJobRecordById(dataDir, id);
  const file = jobFilePath(dataDir, resolveCwd(options), id);
  const record = readJobRecordFile(file);
  return record?.id === id ? { file, record } : null;
}

function processOwned(pid, identity) {
  return Number.isInteger(pid) && pid > 1 && identity && processIdentityMatches(pid, identity);
}

function cursorGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

function runningAlive(record) {
  if (record.status !== "running") return false;
  if (record.pid) return processOwned(record.pid, record.pidIdentity);
  if (processOwned(record.cursorPid, record.cursorPidIdentity)) return true;
  if (!record.pid && !record.cursorPid) {
    return Date.now() - Date.parse(record.createdAt) < positiveDuration("CURSOR_COMPANION_PIDLESS_RUNNING_GRACE_MS", 15000);
  }
  return false;
}

function terminateOwned(record) {
  const driverOwned = Number.isInteger(record.pid) && record.pid > 1 && record.pid !== process.pid && processIsDirectlyAlive(record.pid) && processOwned(record.pid, record.pidIdentity);
  const targets = [[record.cursorPid, record.cursorPidIdentity, true, driverOwned], [record.pid, record.pidIdentity, record.background, false]];
  if (targets.some(([pid, identity, , covered]) => !covered && Number.isInteger(pid) && pid > 1 && pid !== process.pid && processIsDirectlyAlive(pid) && !processOwned(pid, identity))) return false;
  let safe = true;
  for (const [pid, identity, group] of targets) {
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    if (group ? !cursorGroupAlive(pid) : !processIsDirectlyAlive(pid)) continue;
    if (processIsDirectlyAlive(pid) && !processOwned(pid, identity)) continue;
    try { process.kill(group ? -pid : pid, "SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") safe = false; }
  }
  return safe;
}

async function waitForCleanup(record) {
  const deadline = Date.now() + 12000;
  const alive = () => cursorGroupAlive(record.cursorPid) || (record.pid !== process.pid && processIsDirectlyAlive(record.pid));
  while (Date.now() < deadline) {
    if (!alive()) {
      await reapPrivateHomeHelpers(record.homeDir);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const [pid, group] of [[record.cursorPid, true], [record.pid, record.background]]) {
    if (pid !== process.pid && (group ? cursorGroupAlive(pid) : processIsDirectlyAlive(pid)) && (!processIsDirectlyAlive(pid) || processOwned(pid, pid === record.pid ? record.pidIdentity : record.cursorPidIdentity))) {
      try { process.kill(group ? -pid : pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") return false; }
    }
  }
  const killDeadline = Date.now() + 500;
  while (alive() && Date.now() < killDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
  if (alive()) return false;
  await reapPrivateHomeHelpers(record.homeDir);
  return true;
}

async function refreshRunning(found) {
  const record = readJobRecordFile(found.file) ?? found.record;
  if (record.status !== "running" || runningAlive(record)) return record;
  const safe = terminateOwned(record);
  const clean = safe && await waitForCleanup(record);
  return updateJobRecordFileWithCurrent(found.file, (current) => {
    if (current.status !== "running" || runningAlive(current)) return current;
    if (!clean) {
      return { ...current, cleanupRequired: true, failureKind: current.cancelRequestedAt ? "cancelled" : "died", errorMessage: "Verified process cleanup did not complete." };
    }
    const cancelled = Boolean(current.cancelRequestedAt);
    return { ...current, status: cancelled ? "cancelled" : "error", finishedAt: nowIso(), failureKind: cancelled ? "cancelled" : "died", errorMessage: cancelled ? "The Cursor job was cancelled." : "The Cursor job owner exited without recording an outcome." };
  });
}

async function handleStatus(argv, transport) {
  const { options, positionals } = commandArgs(argv, { valueOptions: ["cwd"], booleanOptions: ["json", "all"] }, transport);
  if (positionals.length > 1) throw errorWithFailure("Status accepts at most one job id.");
  const dataDir = resolveDataDir();
  if (positionals[0]) {
    const found = requestedJob(dataDir, positionals[0], options);
    if (!found) throw errorWithFailure(`No job record found for ${positionals[0]}.`);
    const record = await refreshRunning(found);
    output(options.json ? record : renderJobDetail(record, { logTail: readLogTail(jobLogPath(dataDir, record.cwd, record.id)) }), options.json);
    if (record.cleanupRequired) process.exitCode = 1;
    return;
  }
  const records = options.all ? listAllJobRecords(dataDir) : listJobRecords(dataDir, resolveCwd(options)).map((record) => ({ record, file: jobFilePath(dataDir, record.cwd, record.id) }));
  const jobs = await Promise.all(records.map(refreshRunning));
  output(options.json ? { jobs } : renderStatusTable(jobs, currentClaudeSessionId()), options.json);
  if (jobs.some((job) => job.cleanupRequired)) process.exitCode = 1;
}

function historyEntry(record) {
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : null;
  const mode = ["consult", "write", "review"].includes(record.mode) ? record.mode : "unknown";
  const resumable = terminal(record) && record.jobClass === "task" && CURSOR_SESSION_ID_PATTERN.test(sessionId) && Boolean(record.homeDir) && mode !== "unknown";
  return {
    jobId: record.id, sessionId, cwd: record.cwd, status: record.status, jobClass: record.jobClass, mode,
    background: Boolean(record.background), delivery: record.delivery, deliveryStatus: record.deliveryStatus,
    semanticStatus: record.semanticStatus, cleanupRequired: record.cleanupRequired, failureKind: record.failureKind,
    requestedModel: record.requestedModel, resolvedModel: record.resolvedModel, observedModel: record.observedModel,
    requestedEffort: record.requestedEffort, effortApplied: record.effortApplied, billingPool: record.billingPool,
    cursorVersion: record.cursorVersion, createdAt: record.createdAt, finishedAt: record.finishedAt,
    resumable, resumeMode: resumable ? mode : null,
    ownedByCurrentSession: currentClaudeSessionId() == null ? null : record.claudeSessionId === currentClaudeSessionId()
  };
}

async function handleHistory(argv, transport) {
  const { options, positionals } = commandArgs(argv, { valueOptions: ["limit", "cwd"], booleanOptions: ["all", "json"] }, transport);
  if (positionals.length) throw errorWithFailure("History accepts no positional arguments.");
  const limit = options.limit === undefined ? 50 : Number(options.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw errorWithFailure("History limit must be 1 to 500.");
  const dataDir = resolveDataDir();
  const cwd = options.all ? null : resolveCwd(options);
  const entries = options.all ? listAllJobRecords(dataDir) : listJobRecords(dataDir, cwd).map((record) => ({ record, file: jobFilePath(dataDir, cwd, record.id) }));
  const jobs = (await Promise.all(entries.slice(0, limit).map(refreshRunning))).map(historyEntry);
  const report = { source: "canonical", scope: options.all ? "all" : "workspace", cwd, limit, totalJobs: entries.length, returnedJobs: jobs.length, truncated: entries.length > jobs.length, jobs };
  output(options.json ? report : renderHistoryReport(report), options.json);
}

async function handleResult(argv, transport) {
  const { options, positionals } = commandArgs(argv, { valueOptions: ["cwd", "wait-timeout-ms"], booleanOptions: ["wait", "json"] }, transport);
  if (positionals.length !== 1) throw errorWithFailure("Result requires one job id.");
  const dataDir = resolveDataDir();
  const found = requestedJob(dataDir, positionals[0], options);
  if (!found) throw errorWithFailure(`No job record found for ${positionals[0]}.`);
  const configured = options["wait-timeout-ms"] ?? process.env.CURSOR_COMPANION_WAIT_TIMEOUT_MS;
  const timeout = configured === undefined ? 570000 : Number(configured);
  if (!Number.isSafeInteger(timeout) || timeout < 0) throw errorWithFailure("Wait timeout must be a nonnegative integer.");
  const deadline = Date.now() + Math.min(timeout, 570000);
  let record;
  for (;;) {
    record = await refreshRunning(found);
    if (!options.wait || record.status !== "running" || record.cleanupRequired || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(positiveDuration("CURSOR_COMPANION_WAIT_POLL_MS", 2000), deadline - Date.now())));
  }
  const rendered = options.json ? `${JSON.stringify(record.request?.outputJson && record.status !== "running" ? taskPayload(record) : record, null, 2)}\n` : String(record.status === "running" ? renderJobDetail(record) : renderOutcome(record));
  await new Promise((resolve, reject) => process.stdout.write(rendered, (error) => error ? reject(error) : resolve()));
  if (record.status !== "running" && record.delivery !== "foreground") markDeliveryCollectedFile(found.file);
  if (record.cleanupRequired) process.exitCode = 1;
}

async function handleCancel(argv, transport) {
  const { options, positionals } = commandArgs(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] }, transport);
  if (positionals.length !== 1) throw errorWithFailure("Cancel requires one job id.");
  const found = requestedJob(resolveDataDir(), positionals[0], options);
  if (!found) throw errorWithFailure(`No job record found for ${positionals[0]}.`);
  const record = await cancelJobRecord(found);
  const text = record.status === "cancelled" ? renderCancelReport(record) : record.status !== "running" ? renderTaskResult({ text: `Job ${record.id} is not running (status: ${record.status}).`, record }) : renderJobDetail(record);
  output(options.json ? taskPayload(record) : text, options.json);
  if (record.cleanupRequired) process.exitCode = 1;
}

export async function cancelJobRecord(found) {
  let record = readJobRecordFile(found.file) ?? found.record;
  if (record.status === "running") {
    record = updateJobRecordFile(found.file, { cancelRequestedAt: nowIso() });
    if (record.status === "running") {
      const safe = terminateOwned(record);
      const clean = safe && await waitForCleanup(record);
      record = updateJobRecordFileWithCurrent(found.file, (current) => {
        if (current.status !== "running") return current;
        if (!clean) return { ...current, cleanupRequired: true, failureKind: "cancelled", errorMessage: "Verified process cleanup did not complete." };
        return { ...current, status: "cancelled", finishedAt: nowIso(), failureKind: "cancelled", errorMessage: "The Cursor job was cancelled.", cancelRequestedAt: null };
      });
    }
  }
  return record;
}
function handleModels(argv, transport) {
  const { options, positionals } = commandArgs(argv, { booleanOptions: ["refresh", "json"] }, transport);
  if (positionals.length) throw errorWithFailure("Models accepts only --refresh and --json.");
  const catalog = readModelCatalog({ dataDir: resolveDataDir(), bin: resolveCursorBin(), maxAgeMs: options.refresh ? 0 : 3600000 });
  const report = { engine: "cursor", models: catalog.models.map(({ id, displayName }) => ({ id, displayName })), source: catalog.source };
  output(options.json ? report : report.models.map((model) => `${model.id} - ${model.displayName}`).join("\n") + "\n", options.json);
}

function handleSetup(argv, transport) {
  const { options, positionals } = commandArgs(argv, { booleanOptions: ["json"] }, transport);
  if (positionals.length) throw errorWithFailure("Setup accepts only --json.");
  const bin = resolveCursorBin();
  const dataDir = resolveDataDir();
  const nextSteps = [];
  let probe = null;
  let detail = null;
  try { probe = probeCursorVersion(bin); } catch (error) { detail = error.message; nextSteps.push(error.message); }
  const namedCursorAgent = path.basename(bin) === "cursor-agent";
  const compatibility = !probe ? "unknown" : compareCursorVersion(probe.version, TESTED_CURSOR_INTERVAL.floor) < 0 ? "older than the tested interval" : compareCursorVersion(probe.version, TESTED_CURSOR_INTERVAL.ceiling) >= 0 ? "newer than the tested interval" : "tested";
  let auth = { authenticated: false, detail: "not checked" };
  let catalog = null;
  if (probe) {
    const status = spawnSync(probe.buildPath, ["status"], { encoding: "utf8", timeout: 60000 });
    auth = { authenticated: status.status === 0 && !status.error, detail: String(status.error?.message || status.stdout || status.stderr || "status returned no output").trim() };
    try { catalog = readModelCatalog({ dataDir, bin: probe.buildPath, maxAgeMs: 0 }); }
    catch (error) { nextSteps.push(error.message); }
  }
  const sandboxHelper = probe ? fs.existsSync(path.join(path.dirname(probe.buildPath), "cursorsandbox")) : false;
  let dataWritable = false;
  let dataDetail = null;
  try { fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); fs.accessSync(dataDir, fs.constants.W_OK); dataWritable = true; }
  catch (error) { dataDetail = error.message; nextSteps.push(error.message); }
  let hookFiles = [];
  try { hookFiles = projectHookFiles(process.cwd()); } catch (error) { nextSteps.push(error.message); }
  const report = {
    ready: Boolean(probe && namedCursorAgent && compatibility !== "older than the tested interval" && auth.authenticated && catalog && sandboxHelper && dataWritable),
    cursor: { available: Boolean(probe), bin, buildPath: probe?.buildPath ?? null, version: probe?.version ?? null, namedCursorAgent, detail: detail ?? probe?.version ?? null },
    compatibility, testedInterval: TESTED_CURSOR_INTERVAL, auth, catalogSize: catalog?.models.length ?? 0,
    sandboxHelper: { present: sandboxHelper, path: probe ? path.join(path.dirname(probe.buildPath), "cursorsandbox") : null },
    projectHookFiles: hookFiles, projectHookWarnings: hookFiles.map((file) => `project hooks run outside the Cursor sandbox: ${file}`),
    dataDir: { path: dataDir, writable: dataWritable, detail: dataDetail }, nextSteps
  };
  const setupText = renderSetupReport(report).trimEnd() + `\n- executable name: ${path.basename(bin)}\n- version: ${probe?.version ?? "unknown"}\n- authentication: ${auth.authenticated ? "authenticated" : auth.detail}\n- catalog size: ${report.catalogSize}\n- cursorsandbox helper: ${sandboxHelper ? "present" : "missing"}\n` + report.projectHookWarnings.map((warning) => `warning: ${warning}\n`).join("");
  output(options.json ? report : setupText, options.json);
}

function handleRecordAcceptance(argv) {
  const { options, positionals } = commandArgs(argv, {
    valueOptions: ["job-id", "acceptance", "reason", "failure-kind", "source"],
    booleanOptions: ["accept-failed-transport", "json"]
  });
  if (positionals.length) throw errorWithFailure("Record acceptance accepts no positional arguments.");
  const id = options["job-id"];
  if (!JOB_ID_PATTERN.test(String(id ?? ""))) throw errorWithFailure("The --job-id option must be a 32 character lowercase hexadecimal job id.");
  if (!ACCEPTANCE_VALUES.has(options.acceptance)) throw errorWithFailure("The --acceptance option must be accepted, rejected, or unverified.");
  if (options["failure-kind"] !== undefined && (!SEMANTIC_FAILURE_KINDS.has(options["failure-kind"]) || options.acceptance !== "rejected")) throw errorWithFailure("The --failure-kind option requires rejected acceptance and a known semantic failure kind.");
  if (options.acceptance === "rejected" && !options.reason?.trim()) throw errorWithFailure("A rejected acceptance requires --reason.");
  const source = options.source ?? "stats";
  if (!ACCEPTANCE_SOURCES.has(source)) throw errorWithFailure("The --source option must be collector, main-loop, or stats.");
  const found = findJobRecordById(resolveDataDir(), id);
  if (!found) throw errorWithFailure(`No job record found for ${id}.`);
  const record = updateJobRecordFileWithCurrent(found.file, (current) => {
    if (options.acceptance === "accepted" && current.status !== "done" && !options["accept-failed-transport"]) throw errorWithFailure(`Cursor job ${id} has transport status ${current.status}. Pass --accept-failed-transport to record accepted.`);
    return { ...current, semanticStatus: options.acceptance, semanticFailureKind: options.acceptance === "rejected" ? options["failure-kind"] ?? null : null,
      semanticFailureMessage: options.acceptance === "rejected" ? options.reason : null,
      acceptanceSource: source, acceptanceRecordedAt: nowIso() };
  }, { allowTerminal: true });
  output(options.json ? { id: record.id, semanticStatus: record.semanticStatus, semanticFailureKind: record.semanticFailureKind, acceptanceSource: record.acceptanceSource } : renderRecordAcceptance(record), options.json);
}

function printUsage() {
  output("Usage: cursor-companion.mjs <task|review|status|result|cancel|history|models|setup|record-acceptance|transport-create|transport-discard> [options]\n");
}

async function main() {
  const [command, ...received] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") { printUsage(); return; }
  if (command === "transport-create") {
    if (received.length) throw errorWithFailure("transport-create accepts no arguments.");
    createRawCommandTransport();
    return;
  }
  if (command === "transport-discard") {
    if (received.length !== 2 || received[0] !== "--raw-args-token") throw errorWithFailure("transport-discard requires exactly one raw argument token.");
    consumeRawCommandTransport(received[1]);
    return;
  }
  if (command === "record-acceptance") { activeArgv = received; handleRecordAcceptance(received); return; }
  const transport = resolveCommandTransport(received);
  activeArgv = transport.argv;
  activeIngress = transport.ingress;
  if (transport.defaultBackground && command !== "review" || transport.defaultWrite && command !== "task") throw errorWithFailure("The raw transport default is invalid for this command.");
  switch (command) {
    case "task": await handleTask(transport.argv, transport); break;
    case "review": await handleReview(transport.argv, transport); break;
    case "task-worker": await handleWorker(transport.argv, "task"); break;
    case "review-worker": await handleWorker(transport.argv, "review"); break;
    case "status": await handleStatus(transport.argv, transport); break;
    case "result": await handleResult(transport.argv, transport); break;
    case "cancel": await handleCancel(transport.argv, transport); break;
    case "history": await handleHistory(transport.argv, transport); break;
    case "models": handleModels(transport.argv, transport); break;
    case "setup": handleSetup(transport.argv, transport); break;
    default: throw errorWithFailure(`Unknown subcommand: ${command}.`);
  }
}

function renderTopLevelError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const kind = error.failureKind ?? "error";
  const json = activeOptions?.json === true || (activeIngress === "staged_file" ? rawBooleanOptionRequested(activeArgv?.[0] ?? "", "json", activeConfig ?? {}) : (activeArgv ?? process.argv.slice(3)).includes("--json"));
  return json ? `${JSON.stringify({ status: "error", transportStatus: "error", semanticStatus: "unverified", delivery: "foreground", deliveryStatus: "delivered", resolvedModel: null, resolvedEffort: null, failureKind: kind, message }, null, 2)}\n` : `${message}\nstate: error\nfailure: ${kind}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  main().catch((error) => { process.stderr.write(renderTopLevelError(error)); process.exitCode = 1; });
}
