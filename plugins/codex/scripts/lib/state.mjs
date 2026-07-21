import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { getProcessIdentity, processIdentityMatches } from "./codex-exec.mjs";

const DATA_DIR_ENV = "CODEX_COMPANION_DATA";
const JOB_SCHEMA_VERSION = 1;
const JOB_LOG_MAX_BYTES = 1024 * 1024;
const JOB_EVENTS_MAX_BYTES = 8 * 1024 * 1024;
const JOB_RECORD_SCAN_MAX_BYTES = 16 * 1024 * 1024;
const LOG_TAIL_MAX_BYTES = 64 * 1024;
const LOCK_TIMEOUT_ENV = "CODEX_COMPANION_LOCK_TIMEOUT_MS";
const LOCK_RETRY_MS = 20;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const STATE_MAX_BYTES_ENV = "CODEX_COMPANION_HISTORY_MAX_BYTES";
const STATE_MAX_RECORDS_ENV = "CODEX_COMPANION_HISTORY_MAX_RECORDS";
const JOB_STATUSES = new Set(["running", "done", "error", "cancelled"]);
const DELIVERY_MODES = new Set(["foreground", "manual", "managed"]);
const SEMANTIC_STATUSES = new Set(["accepted", "rejected", "unverified"]);
const ACCEPTANCE_SOURCES = new Set(["collector", "main-loop", "stats"]);
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORKSPACE_SLUG_PATTERN = /^.+-[a-f0-9]{16}$/;

export const DEFAULT_JOB_HISTORY_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_JOB_HISTORY_MAX_RECORDS = 256;
export const DEFAULT_LOCK_TIMEOUT_MS = 5000;
export const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);
export const SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";

export function resolveLockTimeoutMs(env = process.env) {
  const raw = env[LOCK_TIMEOUT_ENV];
  if (raw === undefined || raw === null || (typeof raw === "string" && !String(raw).trim())) {
    return DEFAULT_LOCK_TIMEOUT_MS;
  }
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LOCK_TIMEOUT_MS;
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} is required.`);
  }
  return path.resolve(value.trim());
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function gitValue(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const value = String(result.stdout ?? "").trim();
  return value || null;
}

function validateIdentifier(value, label) {
  if (typeof value !== "string" || !JOB_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  fs.chmodSync(dir, PRIVATE_DIR_MODE);
}

function fsyncDirectory(dir) {
  let descriptor;
  try {
    descriptor = fs.openSync(dir, "r");
    fs.fsyncSync(descriptor);
  } catch {
    return;
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function atomicWriteFile(file, content) {
  const dir = path.dirname(file);
  const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const deadline = Date.now() + resolveLockTimeoutMs();
  let descriptor;
  try {
    while (descriptor === undefined) {
      try {
        ensurePrivateDir(dir);
        descriptor = fs.openSync(temp, "wx", PRIVATE_FILE_MODE);
      } catch (error) {
        if (error?.code !== "ENOENT" || Date.now() >= deadline) {
          throw error;
        }
        sleepMs(LOCK_RETRY_MS);
      }
    }
    fs.writeFileSync(descriptor, content, "utf8");
    fs.chmodSync(temp, PRIVATE_FILE_MODE);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temp, file);
    fsyncDirectory(dir);
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function validLockIdentity(identity) {
  return Boolean(
    identity &&
      typeof identity === "object" &&
      !Array.isArray(identity) &&
      identity.version === 1 &&
      typeof identity.platform === "string" &&
      identity.platform.length > 0 &&
      typeof identity.bootMarker === "string" &&
      identity.bootMarker.length > 0 &&
      typeof identity.startMarker === "string" &&
      identity.startMarker.length > 0 &&
      typeof identity.commandHash === "string" &&
      identity.commandHash.length > 0
  );
}

function validLockRecord(record) {
  return Boolean(
    record &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      record.version === 1 &&
      typeof record.token === "string" &&
      /^[a-f0-9]{32}$/.test(record.token) &&
      Number.isInteger(record.ownerPid) &&
      record.ownerPid > 1 &&
      validLockIdentity(record.ownerIdentity)
  );
}

function lockOwnerIdentity() {
  const identity = getProcessIdentity(process.pid);
  if (!validLockIdentity(identity)) {
    throw new Error(`Unable to verify lock owner process ${process.pid}.`);
  }
  return identity;
}

function readLockRecord(lockDir) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    return validLockRecord(record) ? record : null;
  } catch {
    return null;
  }
}

function sameLockIdentity(left, right) {
  return validLockIdentity(left) && validLockIdentity(right) && left.version === right.version && left.platform === right.platform && left.bootMarker === right.bootMarker && left.startMarker === right.startMarker && left.commandHash === right.commandHash;
}

function directLockOwnerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function lockOwnerWasReplaced(record) {
  if (processIdentityMatches(record.ownerPid, record.ownerIdentity)) {
    return false;
  }
  const currentIdentity = getProcessIdentity(record.ownerPid);
  if (currentIdentity) {
    return !sameLockIdentity(currentIdentity, record.ownerIdentity);
  }
  return !directLockOwnerAlive(record.ownerPid);
}

function lockOwnerDir(lockDir, token) {
  return `${lockDir}.owner.${token}`;
}

function lockTargetsToken(lockDir, token) {
  try {
    return fs.lstatSync(lockDir).isSymbolicLink() && path.resolve(path.dirname(lockDir), fs.readlinkSync(lockDir)) === lockOwnerDir(lockDir, token);
  } catch {
    return false;
  }
}

function publishPreparedLock(lockDir, ownerDir) {
  try {
    fs.symlinkSync(path.basename(ownerDir), lockDir, "dir");
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

function createLinkedOwner(linkPath, record) {
  const ownerDir = lockOwnerDir(linkPath, record.token);
  fs.mkdirSync(ownerDir, { mode: PRIVATE_DIR_MODE });
  try {
    atomicWriteFile(path.join(ownerDir, "owner.json"), `${JSON.stringify(record)}\n`);
    return { ownerDir, published: publishPreparedLock(linkPath, ownerDir) };
  } catch (error) {
    try {
      fs.rmSync(ownerDir, { recursive: true, force: true });
    } catch {}
    throw error;
  }
}

function publishLockCandidate(lockDir, record) {
  const candidate = createLinkedOwner(lockDir, record);
  if (candidate.published) {
    return null;
  }
  return candidate.ownerDir;
}

function linkedPathExists(linkPath) {
  try {
    fs.lstatSync(linkPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function acquireReaperClaim(ownerDir) {
  const claim = {
    version: 1,
    token: randomBytes(16).toString("hex"),
    ownerPid: process.pid,
    ownerIdentity: lockOwnerIdentity()
  };
  let slot = path.join(ownerDir, ".reap");
  const observedTokens = new Set();
  for (;;) {
    const existing = readLockRecord(slot);
    if (!existing) {
      if (linkedPathExists(slot)) {
        return null;
      }
      let candidate;
      try {
        candidate = createLinkedOwner(slot, claim);
      } catch (error) {
        if (error?.code === "ENOENT") {
          return null;
        }
        throw error;
      }
      if (candidate.published) {
        return { slot, token: claim.token };
      }
      fs.rmSync(candidate.ownerDir, { recursive: true, force: true });
      continue;
    }
    if (!lockTargetsToken(slot, existing.token) || !lockOwnerWasReplaced(existing)) {
      return null;
    }
    if (observedTokens.has(existing.token)) {
      return null;
    }
    observedTokens.add(existing.token);
    slot = path.join(ownerDir, `.reap-successor-${existing.token}`);
  }
}

function reclaimReplacedLock(lockDir, observed) {
  if (!observed || !lockOwnerWasReplaced(observed)) {
    return false;
  }
  const claim = acquireReaperClaim(lockOwnerDir(lockDir, observed.token));
  if (!claim) {
    return false;
  }
  let reaped = false;
  try {
    const current = readLockRecord(lockDir);
    if (current?.token !== observed.token || !lockTargetsToken(lockDir, observed.token) || !lockOwnerWasReplaced(current)) {
      return false;
    }
    fs.unlinkSync(lockDir);
    reaped = true;
    fs.rmSync(lockOwnerDir(lockDir, observed.token), { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
    throw error;
  } finally {
    if (!reaped) {
      releaseLock(claim.slot, claim.token);
    }
  }
}

function releaseLock(lockDir, token) {
  const record = readLockRecord(lockDir);
  if (record?.token !== token || !lockTargetsToken(lockDir, token)) {
    return false;
  }
  try {
    fs.unlinkSync(lockDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  fs.rmSync(lockOwnerDir(lockDir, token), { recursive: true, force: true });
  return true;
}

function withRecordLock(file, callback, timeoutMs = resolveLockTimeoutMs()) {
  ensurePrivateDir(path.dirname(file));
  const lockDir = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  const token = randomBytes(16).toString("hex");
  const record = {
    version: 1,
    token,
    ownerPid: process.pid,
    ownerIdentity: lockOwnerIdentity()
  };
  let candidateDir = null;
  try {
    for (;;) {
      try {
        candidateDir = publishLockCandidate(lockDir, record);
        break;
      } catch (error) {
        if (error?.code !== "ENOENT" || Date.now() >= deadline) {
          throw error;
        }
        ensurePrivateDir(path.dirname(file));
      }
    }
    while (candidateDir) {
      const observed = readLockRecord(lockDir);
      if (reclaimReplacedLock(lockDir, observed)) {
        if (publishPreparedLock(lockDir, candidateDir)) {
          candidateDir = null;
          break;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the job record lock at ${file}.`);
      }
      sleepMs(LOCK_RETRY_MS);
      if (publishPreparedLock(lockDir, candidateDir)) {
        candidateDir = null;
      }
    }
    try {
      return callback();
    } finally {
      releaseLock(lockDir, token);
    }
  } finally {
    if (candidateDir) {
      try {
        fs.rmSync(candidateDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

function quarantineCorruptRecord(file) {
  const quarantine = `${file}.corrupt.${Date.now()}.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(file, quarantine);
    fs.chmodSync(quarantine, PRIVATE_FILE_MODE);
    return quarantine;
  } catch {
    return null;
  }
}

function assertJobRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("Job record must be an object.");
  }
  validateIdentifier(record.id, "Job id");
  if (!JOB_STATUSES.has(record.status)) {
    throw new TypeError("Job status is invalid.");
  }
  if (record.delivery != null && !DELIVERY_MODES.has(record.delivery)) {
    throw new TypeError("Job delivery mode is invalid.");
  }
  if (record.semanticStatus != null && !SEMANTIC_STATUSES.has(record.semanticStatus)) {
    throw new TypeError("Job semantic status is invalid.");
  }
  if (record.acceptanceSource != null && !ACCEPTANCE_SOURCES.has(record.acceptanceSource)) {
    throw new TypeError("Job acceptance source is invalid.");
  }
  if (record.acceptanceRecordedAt != null && (typeof record.acceptanceRecordedAt !== "string" || !Number.isFinite(Date.parse(record.acceptanceRecordedAt)))) {
    throw new TypeError("Job acceptance recorded timestamp is invalid.");
  }
}

function ownerSessionId(record) {
  const value = record?.claudeSessionId ?? record?.sessionId ?? null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeRecord(record) {
  const sessionId = ownerSessionId(record);
  return {
    ...record,
    delivery: record.delivery ?? (record.background ? "manual" : "foreground"),
    deliveryCollectedAt: record.deliveryCollectedAt ?? null,
    schemaVersion: record.schemaVersion ?? JOB_SCHEMA_VERSION,
    acceptanceSource: record.acceptanceSource ?? null,
    acceptanceRecordedAt: record.acceptanceRecordedAt ?? null,
    semanticStatus: record.semanticStatus ?? "unverified",
    semanticFailureKind: record.semanticFailureKind ?? null,
    semanticFailureMessage: record.semanticFailureMessage ?? null,
    serviceTier: record.serviceTier ?? record.request?.serviceTier ?? null,
    appliedServiceTier: record.appliedServiceTier ?? null,
    resolvedModel: record.resolvedModel ?? null,
    resolvedEffort: record.resolvedEffort ?? null,
    sessionId,
    claudeSessionId: sessionId
  };
}

function patchedSessionId(existing, patch) {
  const claudeChanged = Object.hasOwn(patch, "claudeSessionId") && patch.claudeSessionId !== existing.claudeSessionId;
  const legacyChanged = Object.hasOwn(patch, "sessionId") && patch.sessionId !== existing.sessionId;
  if (claudeChanged) {
    return ownerSessionId({ claudeSessionId: patch.claudeSessionId });
  }
  if (legacyChanged) {
    return ownerSessionId({ sessionId: patch.sessionId });
  }
  return ownerSessionId(existing);
}

function terminalPatch(existing, patch, timestamp) {
  const cancellationWins = existing.cancelRequestedAt != null || patch.status === "cancelled";
  const status = cancellationWins ? "cancelled" : patch.status;
  return {
    ...patch,
    status,
    phase: null,
    pid: null,
    pidIdentity: null,
    pidOwnsProcessGroup: false,
    codexPid: null,
    codexPidIdentity: null,
    codexPidOwnsProcessGroup: false,
    finishedAt: existing.finishedAt ?? patch.finishedAt ?? timestamp,
    updatedAt: patch.updatedAt ?? timestamp,
    acceptanceSource: patch.acceptanceSource ?? existing.acceptanceSource ?? null,
    acceptanceRecordedAt: patch.acceptanceRecordedAt ?? existing.acceptanceRecordedAt ?? null,
    failureKind: status === "cancelled" ? "cancelled" : patch.failureKind ?? existing.failureKind ?? null,
    cancelRequestedAt: null
  };
}

function mergeRecord(existing, patch) {
  const timestamp = nowIso();
  const requestedStatus = patch.status ?? existing.status;
  const effectivePatch = TERMINAL_STATUSES.has(requestedStatus)
    ? terminalPatch(existing, { ...patch, status: requestedStatus }, timestamp)
    : { ...patch, updatedAt: patch.updatedAt ?? timestamp };
  const sessionId = patchedSessionId(existing, patch);
  const next = normalizeRecord({
    ...existing,
    ...effectivePatch,
    sessionId,
    claudeSessionId: sessionId
  });
  assertJobRecord(next);
  return next;
}

function appendBoundedFile(file, content, maximumBytes) {
  ensurePrivateDir(path.dirname(file));
  fs.appendFileSync(file, content, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  fs.chmodSync(file, PRIVATE_FILE_MODE);
  const size = fs.statSync(file).size;
  if (size <= maximumBytes) {
    return;
  }
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(maximumBytes);
    fs.readSync(descriptor, buffer, 0, maximumBytes, size - maximumBytes);
    let retained = buffer.toString("utf8");
    const firstLineEnd = retained.indexOf("\n");
    if (firstLineEnd !== -1) {
      retained = retained.slice(firstLineEnd + 1);
    }
    atomicWriteFile(file, retained);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function resolveDataDir(env = process.env) {
  const override = env[DATA_DIR_ENV];
  if (override && String(override).trim()) {
    const resolved = String(override).trim();
    if (!path.isAbsolute(resolved)) {
      const error = new TypeError(`${DATA_DIR_ENV} must be an absolute path.`);
      error.failureKind = "input";
      throw error;
    }
    return path.resolve(resolved);
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "codex-claude-code-fusion");
}

export function canonicalWorkspaceRoot(cwd) {
  const resolved = requiredPath(cwd, "Working directory");
  const root = gitValue(resolved, ["rev-parse", "--show-toplevel"]);
  return canonicalPath(root ?? resolved);
}

export function repositoryIdentity(cwd) {
  const resolved = requiredPath(cwd, "Working directory");
  const commonDir = gitValue(resolved, ["rev-parse", "--git-common-dir"]);
  if (!commonDir) {
    return canonicalWorkspaceRoot(resolved);
  }
  return canonicalPath(path.isAbsolute(commonDir) ? commonDir : path.resolve(resolved, commonDir));
}

export function repositoryKey(cwd) {
  return createHash("sha256").update(repositoryIdentity(cwd)).digest("hex").slice(0, 16);
}

export function workspaceSlug(cwd) {
  const root = canonicalWorkspaceRoot(cwd);
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return `${path.basename(root) || "workspace"}-${hash}`;
}

export function workspaceStateDir(dataDir, cwd) {
  return path.join(path.resolve(dataDir), "state", workspaceSlug(cwd));
}

export function withWorkspaceLock(dataDir, cwd, callback) {
  if (typeof callback !== "function") {
    throw new TypeError("Workspace lock callback must be a function.");
  }
  return withRecordLock(path.join(workspaceStateDir(dataDir, cwd), ".launch"), () => {
    const result = callback();
    if (result && typeof result.then === "function") {
      throw new TypeError("Workspace lock callback must be synchronous.");
    }
    return result;
  });
}

export function withThreadLock(dataDir, threadId, callback) {
  if (typeof callback !== "function") {
    throw new TypeError("Thread lock callback must be a function.");
  }
  const id = validateIdentifier(threadId, "Thread id");
  const key = createHash("sha256").update(id).digest("hex");
  return withRecordLock(path.join(path.resolve(dataDir), "locks", "threads", key), () => {
    const result = callback();
    if (result && typeof result.then === "function") {
      throw new TypeError("Thread lock callback must be synchronous.");
    }
    return result;
  });
}

export function jobsDir(dataDir, cwd) {
  return path.join(workspaceStateDir(dataDir, cwd), "jobs");
}

export function briefsDir(dataDir, cwd) {
  return path.join(workspaceStateDir(dataDir, cwd), "briefs");
}

export function jobFilePath(dataDir, cwd, jobId) {
  return path.join(jobsDir(dataDir, cwd), `${validateIdentifier(jobId, "Job id")}.json`);
}

export function jobLogPath(dataDir, cwd, jobId) {
  return path.join(jobsDir(dataDir, cwd), `${validateIdentifier(jobId, "Job id")}.log`);
}

export function jobEventsPath(dataDir, cwd, jobId) {
  return path.join(jobsDir(dataDir, cwd), `${validateIdentifier(jobId, "Job id")}.events.jsonl`);
}

export function briefPath(dataDir, cwd, name) {
  return path.join(briefsDir(dataDir, cwd), `${validateIdentifier(name, "Brief name")}.md`);
}

export function generateJobId() {
  return randomBytes(16).toString("hex");
}

export function nowIso() {
  return new Date().toISOString();
}

export function createJobRecord(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new TypeError("Job fields must be an object.");
  }
  const id = validateIdentifier(fields.id, "Job id");
  const cwd = requiredPath(fields.cwd, "Working directory");
  const workspaceRoot = canonicalWorkspaceRoot(fields.workspaceRoot ?? cwd);
  const identity = fields.repositoryIdentity ?? repositoryIdentity(workspaceRoot);
  const createdAt = fields.createdAt ?? nowIso();
  const sessionId = ownerSessionId(fields);
  const status = fields.status ?? "running";
  const record = {
    schemaVersion: JOB_SCHEMA_VERSION,
    engine: "codex",
    id,
    status,
    phase: TERMINAL_STATUSES.has(status) ? null : fields.phase ?? "starting",
    kind: fields.kind ?? fields.jobClass ?? "task",
    jobClass: fields.jobClass ?? fields.kind ?? "task",
    mode: fields.mode ?? "consult",
    background: Boolean(fields.background),
    delivery: fields.delivery ?? (fields.background ? "manual" : "foreground"),
    deliveryCollectedAt: fields.deliveryCollectedAt ?? null,
    cwd,
    workspaceRoot,
    repositoryIdentity: identity,
    repositoryKey: fields.repositoryKey ?? createHash("sha256").update(identity).digest("hex").slice(0, 16),
    sessionId,
    claudeSessionId: sessionId,
    pid: fields.pid ?? null,
    pidIdentity: fields.pidIdentity ?? null,
    pidOwnsProcessGroup: Boolean(fields.pidOwnsProcessGroup),
    codexPid: fields.codexPid ?? null,
    codexPidIdentity: fields.codexPidIdentity ?? null,
    codexPidIdentitySettled: Boolean(fields.codexPidIdentitySettled),
    codexPidOwnsProcessGroup: Boolean(fields.codexPidOwnsProcessGroup),
    threadId: fields.threadId ?? null,
    turnId: fields.turnId ?? null,
    briefFile: fields.briefFile ?? null,
    logFile: fields.logFile ?? null,
    eventsFile: fields.eventsFile ?? null,
    createdAt,
    startedAt: fields.startedAt ?? null,
    updatedAt: fields.updatedAt ?? createdAt,
    heartbeatAt: fields.heartbeatAt ?? null,
    deadlineAt: fields.deadlineAt ?? null,
    launchApprovedAt: fields.launchApprovedAt ?? null,
    launchAbortRequestedAt: fields.launchAbortRequestedAt ?? null,
    finishedAt: fields.finishedAt ?? null,
    collectedAt: fields.collectedAt ?? null,
    exitCode: fields.exitCode ?? null,
    resultText: fields.resultText ?? null,
    partialResultText: fields.partialResultText ?? null,
    tokenUsage: fields.tokenUsage ?? null,
    cumulativeTokenUsage: fields.cumulativeTokenUsage ?? null,
    tokenUsageAvailability: fields.tokenUsageAvailability ?? "unreported",
    tokenUsageUnavailableReason: fields.tokenUsageUnavailableReason ?? null,
    usageIsIncomplete: fields.usageIsIncomplete ?? null,
    serviceTier: Object.hasOwn(fields, "serviceTier") ? fields.serviceTier : fields.request?.serviceTier ?? null,
    appliedServiceTier: fields.appliedServiceTier ?? null,
    resolvedModel: fields.resolvedModel ?? fields.request?.model ?? null,
    resolvedEffort: fields.resolvedEffort ?? fields.request?.effort ?? null,
    ...(fields.modelDrift ? { modelDrift: fields.modelDrift } : {}),
    rolloutRecoveryStatus: fields.rolloutRecoveryStatus ?? null,
    acceptanceSource: fields.acceptanceSource ?? null,
    acceptanceRecordedAt: fields.acceptanceRecordedAt ?? null,
    semanticStatus: fields.semanticStatus ?? "unverified",
    semanticFailureKind: fields.semanticFailureKind ?? null,
    semanticFailureMessage: fields.semanticFailureMessage ?? null,
    diagnostics: fields.diagnostics ?? [],
    protocolError: fields.protocolError ?? null,
    resultSource: fields.resultSource ?? null,
    unknownEventCount: fields.unknownEventCount ?? 0,
    eventsTruncated: Boolean(fields.eventsTruncated),
    errorMessage: fields.errorMessage ?? null,
    errorTail: fields.errorTail ?? null,
    failureKind: fields.failureKind ?? null,
    cancelRequestedAt: fields.cancelRequestedAt ?? null,
    codexVersion: fields.codexVersion ?? null,
    request: fields.request ?? null
  };
  assertJobRecord(record);
  return record;
}

export function writeJobRecordFile(file, record) {
  assertJobRecord(record);
  withRecordLock(file, () => {
    const existing = readJobRecordFile(file);
    if (existing && TERMINAL_STATUSES.has(existing.status)) {
      return;
    }
    const next = normalizeRecord(record);
    assertJobRecord(next);
    atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
  });
  return file;
}

export function readJobRecordFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    quarantineCorruptRecord(file);
    return null;
  }
  try {
    assertJobRecord(parsed);
    return normalizeRecord(parsed);
  } catch {
    return null;
  }
}

export function updateJobRecordFile(file, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("Job record patch must be an object.");
  }
  return withRecordLock(file, () => {
    const existing = readJobRecordFile(file);
    if (!existing) {
      throw new Error(`No job record found at ${file}.`);
    }
    if (TERMINAL_STATUSES.has(existing.status)) {
      return existing;
    }
    const next = mergeRecord(existing, patch);
    atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function updateJobRecordFileWithCurrent(file, updater, options = {}) {
  if (typeof updater !== "function") {
    throw new TypeError("Job record updater must be a function.");
  }
  const allowTerminal = options.allowTerminal === true;
  return withRecordLock(file, () => {
    const existing = readJobRecordFile(file);
    if (!existing) {
      throw new Error(`No job record found at ${file}.`);
    }
    if (TERMINAL_STATUSES.has(existing.status) && !allowTerminal) {
      return existing;
    }
    const patch = updater({ ...existing });
    if (!patch || patch === existing) {
      return existing;
    }
    const next = mergeRecord(existing, patch);
    atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function finishJobRecordFile(file, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("Job record patch must be an object.");
  }
  if (!TERMINAL_STATUSES.has(patch.status)) {
    throw new TypeError("A terminal job status is required.");
  }
  return withRecordLock(file, () => {
    const existing = readJobRecordFile(file);
    if (!existing) {
      throw new Error(`No job record found at ${file}.`);
    }
    if (TERMINAL_STATUSES.has(existing.status)) {
      return existing;
    }
    const next = mergeRecord(existing, patch);
    atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function markJobCollectedFile(file, collectedAt = nowIso()) {
  if (typeof collectedAt !== "string" || !Number.isFinite(Date.parse(collectedAt))) {
    throw new TypeError("A valid collection timestamp is required.");
  }
  return withRecordLock(file, () => {
    const existing = readJobRecordFile(file);
    if (!existing) {
      throw new Error(`No job record found at ${file}.`);
    }
    if (!TERMINAL_STATUSES.has(existing.status) || existing.collectedAt) {
      return existing;
    }
    const next = normalizeRecord({
      ...existing,
      collectedAt,
      deliveryCollectedAt: existing.delivery === "foreground" ? existing.deliveryCollectedAt ?? null : existing.deliveryCollectedAt ?? collectedAt
    });
    assertJobRecord(next);
    atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function listJobRecords(dataDir, cwd) {
  const dir = jobsDir(dataDir, cwd);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const record = readJobRecordFile(path.join(dir, entry));
    if (record?.id === entry.slice(0, -".json".length)) {
      records.push(record);
    }
  }
  return records.sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")));
}

export function listAllJobRecords(dataDir) {
  const stateRoot = path.join(path.resolve(dataDir), "state");
  let workspaces;
  try {
    workspaces = fs.readdirSync(stateRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const results = [];
  for (const workspace of workspaces) {
    const dir = path.join(stateRoot, workspace, "jobs");
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const file = path.join(dir, entry);
      const record = readJobRecordFile(file);
      if (record?.id === entry.slice(0, -".json".length)) {
        results.push({ record, file });
      }
    }
  }
  return results.sort((left, right) => {
    const timestamp = String(right.record.createdAt ?? "").localeCompare(String(left.record.createdAt ?? ""));
    return timestamp || left.file.localeCompare(right.file);
  });
}

export function latestJobRecordForThread(dataDir, threadId) {
  if (typeof threadId !== "string" || !threadId.trim()) {
    return null;
  }
  const candidates = listAllJobRecords(dataDir).map(({ record }) => record).filter((record) => record.jobClass === "task" && (record.threadId === threadId || record.request?.resumeThreadId === threadId));
  candidates.sort((left, right) => {
    const timestamp = String(right.finishedAt ?? right.updatedAt ?? right.createdAt ?? "").localeCompare(String(left.finishedAt ?? left.updatedAt ?? left.createdAt ?? ""));
    return timestamp || String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")) || String(left.id ?? "").localeCompare(String(right.id ?? ""));
  });
  return candidates[0] ?? null;
}

function retentionLimit(value, fallback) {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveJobHistoryLimits(env = process.env) {
  return {
    maxBytes: retentionLimit(env[STATE_MAX_BYTES_ENV], DEFAULT_JOB_HISTORY_MAX_BYTES),
    maxRecords: retentionLimit(env[STATE_MAX_RECORDS_ENV], DEFAULT_JOB_HISTORY_MAX_RECORDS)
  };
}

function regularFileDescriptor(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) {
      return { kind: "unsafe" };
    }
    return { dev: stat.dev, file, ino: stat.ino, kind: "regular", size: stat.size };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { file, kind: "missing", size: 0 };
    }
    throw error;
  }
}

function expectedManagedArtifacts(workspaceDir, id) {
  const jobs = path.join(workspaceDir, "jobs");
  return [
    { field: "briefFile", file: path.join(workspaceDir, "briefs", `${id}.md`) },
    { field: "logFile", file: path.join(jobs, `${id}.log`) },
    { field: "eventsFile", file: path.join(jobs, `${id}.events.jsonl`) }
  ];
}

function readManagedJobEntry(workspace, workspaceDir, file, id) {
  const recordDescriptor = regularFileDescriptor(file);
  if (recordDescriptor.kind !== "regular" || recordDescriptor.size > JOB_RECORD_SCAN_MAX_BYTES) {
    return null;
  }
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, "utf8"));
    assertJobRecord(record);
  } catch {
    return null;
  }
  if (record.schemaVersion !== JOB_SCHEMA_VERSION || record.engine !== "codex" || record.id !== id) {
    return null;
  }
  if (record.request !== null && (typeof record.request !== "object" || Array.isArray(record.request))) {
    return null;
  }
  const resumeSourceJobId = record.request?.resumeSourceJobId ?? null;
  if (resumeSourceJobId !== null && (typeof resumeSourceJobId !== "string" || !JOB_ID_PATTERN.test(resumeSourceJobId))) {
    return null;
  }
  if (record.collectedAt !== null && record.collectedAt !== undefined && (typeof record.collectedAt !== "string" || !Number.isFinite(Date.parse(record.collectedAt)))) {
    return null;
  }
  const createdTimestamp = Date.parse(record.createdAt ?? "");
  const timestamp = Date.parse(record.finishedAt ?? record.updatedAt ?? record.createdAt ?? "");
  if (!Number.isFinite(createdTimestamp) || !Number.isFinite(timestamp)) {
    return null;
  }
  const files = [];
  for (const artifact of expectedManagedArtifacts(workspaceDir, id)) {
    const configured = record[artifact.field];
    if (configured !== null && configured !== undefined && (typeof configured !== "string" || path.resolve(configured) !== artifact.file)) {
      return null;
    }
    const descriptor = regularFileDescriptor(artifact.file);
    if (descriptor.kind === "unsafe" || ((configured === null || configured === undefined) && descriptor.kind !== "missing")) {
      return null;
    }
    if (descriptor.kind === "regular") {
      files.push(descriptor);
    }
  }
  files.push(recordDescriptor);
  return {
    bytes: files.reduce((total, descriptor) => total + descriptor.size, 0),
    createdAt: record.createdAt,
    file,
    files,
    id,
    key: `${workspace}\0${id}`,
    record: normalizeRecord(record),
    resumeSourceJobId,
    timestamp,
    workspace
  };
}

function scanManagedJobState(dataDir) {
  const stateRoot = path.join(path.resolve(dataDir), "state");
  let workspaces;
  try {
    workspaces = fs.readdirSync(stateRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { entries: [], unrecognizedRecords: 0, workspaceDirs: [] };
    }
    throw error;
  }
  const entries = [];
  let unrecognizedRecords = 0;
  const workspaceDirs = [];
  for (const workspaceEntry of workspaces) {
    if (!workspaceEntry.isDirectory()) {
      continue;
    }
    const workspace = workspaceEntry.name;
    const workspaceDir = path.join(stateRoot, workspace);
    if (WORKSPACE_SLUG_PATTERN.test(workspace)) {
      workspaceDirs.push(workspaceDir);
    }
    const dir = path.join(workspaceDir, "jobs");
    let jobEntries;
    try {
      jobEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const jobEntry of jobEntries) {
      if (!jobEntry.name.endsWith(".json")) {
        continue;
      }
      const id = jobEntry.name.slice(0, -".json".length);
      const file = path.join(dir, jobEntry.name);
      if (!jobEntry.isFile() || !JOB_ID_PATTERN.test(id)) {
        unrecognizedRecords += 1;
        continue;
      }
      const entry = readManagedJobEntry(workspace, workspaceDir, file, id);
      if (entry) {
        entries.push(entry);
      } else {
        unrecognizedRecords += 1;
      }
    }
  }
  return { entries, unrecognizedRecords, workspaceDirs };
}

function protectedManagedJobs(entries, claudeSessionId, protectedJobFiles, resumeWorkspaceJobFiles) {
  const protectedKeys = new Set(entries.filter((entry) => entry.record.status === "running" || (TERMINAL_STATUSES.has(entry.record.status) && entry.record.background === true && !entry.record.collectedAt)).map((entry) => entry.key));
  const protectedFiles = new Set((Array.isArray(protectedJobFiles) ? protectedJobFiles : []).filter((file) => typeof file === "string" && file.trim()).map((file) => path.resolve(file)));
  const resumeWorkspaceFiles = new Set((Array.isArray(resumeWorkspaceJobFiles) ? resumeWorkspaceJobFiles : []).filter((file) => typeof file === "string" && file.trim()).map((file) => path.resolve(file)));
  const resumeWorkspaces = new Set();
  for (const entry of entries) {
    if (protectedFiles.has(entry.file)) {
      protectedKeys.add(entry.key);
    }
    if (resumeWorkspaceFiles.has(entry.file)) {
      resumeWorkspaces.add(entry.workspace);
    }
  }
  const sessionId = typeof claudeSessionId === "string" && claudeSessionId.trim() ? claudeSessionId.trim() : null;
  const headGroups = resumeWorkspaces.size > 0 ? [...resumeWorkspaces].map((workspace) => entries.filter((entry) => entry.workspace === workspace)) : [entries];
  for (const records of headGroups) {
    const candidates = records
      .filter((entry) => TERMINAL_STATUSES.has(entry.record.status) && entry.record.jobClass === "task" && typeof entry.record.threadId === "string" && entry.record.threadId.trim() && (!sessionId || entry.record.claudeSessionId === sessionId))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || left.file.localeCompare(right.file));
    const latestCreatedAt = candidates[0]?.createdAt;
    for (const candidate of candidates) {
      if (candidate.createdAt !== latestCreatedAt) {
        break;
      }
      protectedKeys.add(candidate.key);
    }
  }
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  for (const key of [...protectedKeys]) {
    const entry = byKey.get(key);
    if (!entry?.resumeSourceJobId) {
      continue;
    }
    const sourceKey = `${entry.workspace}\0${entry.resumeSourceJobId}`;
    if (byKey.has(sourceKey)) {
      protectedKeys.add(sourceKey);
    }
  }
  return protectedKeys;
}

function unlinkManagedDescriptor(descriptor) {
  let current;
  try {
    current = fs.lstatSync(descriptor.file);
  } catch (error) {
    return error?.code === "ENOENT";
  }
  if (!current.isFile() || current.dev !== descriptor.dev || current.ino !== descriptor.ino) {
    return false;
  }
  try {
    fs.unlinkSync(descriptor.file);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function removeEmptyManagedDirectory(dir) {
  try {
    if (!fs.lstatSync(dir).isDirectory()) {
      return false;
    }
    fs.rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

function removeEmptyManagedWorkspace(workspaceDir) {
  removeEmptyManagedDirectory(path.join(workspaceDir, "briefs"));
  removeEmptyManagedDirectory(path.join(workspaceDir, "jobs"));
  removeEmptyManagedDirectory(workspaceDir);
}

function deleteManagedJobEntry(entry) {
  const workspaceDir = path.dirname(path.dirname(entry.file));
  const refreshed = readManagedJobEntry(entry.workspace, workspaceDir, entry.file, entry.id);
  if (!refreshed || !TERMINAL_STATUSES.has(refreshed.record.status) || refreshed.record.updatedAt !== entry.record.updatedAt || refreshed.bytes !== entry.bytes) {
    return null;
  }
  const recordDescriptor = refreshed.files.find((descriptor) => descriptor.file === refreshed.file);
  const artifacts = refreshed.files.filter((descriptor) => descriptor.file !== refreshed.file);
  for (const descriptor of artifacts) {
    if (!unlinkManagedDescriptor(descriptor)) {
      return null;
    }
  }
  if (!recordDescriptor || !unlinkManagedDescriptor(recordDescriptor)) {
    return null;
  }
  removeEmptyManagedWorkspace(workspaceDir);
  removeEmptyManagedDirectory(path.dirname(workspaceDir));
  return refreshed.bytes;
}

export function pruneJobState(dataDir, options = {}) {
  const defaults = resolveJobHistoryLimits(options.env ?? process.env);
  const maxBytes = retentionLimit(options.maxBytes, defaults.maxBytes);
  const maxRecords = retentionLimit(options.maxRecords, defaults.maxRecords);
  const failure = (error) => ({
    afterBytes: null,
    afterRecords: null,
    deletedBytes: 0,
    deletedRecords: 0,
    errorMessage: error instanceof Error ? error.message : String(error),
    maxBytes,
    maxRecords,
    ok: false,
    quotaSatisfied: false,
    unrecognizedRecords: null
  });
  try {
    return withRecordLock(path.join(path.resolve(dataDir), "locks", "history-gc"), () => {
      const { entries, unrecognizedRecords, workspaceDirs } = scanManagedJobState(dataDir);
      const protectedKeys = protectedManagedJobs(entries, options.claudeSessionId, options.protectedJobFiles, options.resumeWorkspaceJobFiles);
      let afterBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
      let afterRecords = entries.length;
      let deletedBytes = 0;
      let deletedRecords = 0;
      const candidates = entries
        .filter((entry) => TERMINAL_STATUSES.has(entry.record.status) && !protectedKeys.has(entry.key))
        .sort((left, right) => left.timestamp - right.timestamp || left.file.localeCompare(right.file));
      for (const entry of candidates) {
        if (afterRecords <= maxRecords && afterBytes <= maxBytes) {
          break;
        }
        const removedBytes = deleteManagedJobEntry(entry);
        if (removedBytes === null) {
          continue;
        }
        afterRecords -= 1;
        afterBytes = Math.max(0, afterBytes - removedBytes);
        deletedRecords += 1;
        deletedBytes += removedBytes;
      }
      for (const workspaceDir of workspaceDirs) {
        removeEmptyManagedWorkspace(workspaceDir);
      }
      removeEmptyManagedDirectory(path.join(path.resolve(dataDir), "state"));
      return {
        afterBytes,
        afterRecords,
        deletedBytes,
        deletedRecords,
        errorMessage: null,
        maxBytes,
        maxRecords,
        ok: true,
        quotaSatisfied: afterRecords <= maxRecords && afterBytes <= maxBytes,
        unrecognizedRecords
      };
    }, 0);
  } catch (error) {
    return failure(error);
  }
}

export function findJobRecordById(dataDir, jobId) {
  const id = validateIdentifier(jobId, "Job id");
  const matches = listAllJobRecords(dataDir).filter((entry) => entry.record.id === id);
  if (matches.length > 1) {
    throw new Error(`Job id ${id} is ambiguous across workspaces. Pass --cwd to select one workspace.`);
  }
  return matches[0] ?? null;
}

export function writeBrief(dataDir, cwd, name, content) {
  const file = briefPath(dataDir, cwd, name);
  const text = String(content ?? "");
  atomicWriteFile(file, text);
  return file;
}

export function appendJobLog(logFile, text) {
  if (!logFile) {
    return;
  }
  const raw = String(text ?? "");
  if (!raw) {
    return;
  }
  appendBoundedFile(logFile, raw.endsWith("\n") ? raw : `${raw}\n`, JOB_LOG_MAX_BYTES);
}

export function appendJobEvent(eventsFile, event) {
  if (!eventsFile) {
    return;
  }
  const line = typeof event === "string" ? event.trimEnd() : JSON.stringify(event);
  if (!line) {
    return;
  }
  appendBoundedFile(eventsFile, `${line}\n`, JOB_EVENTS_MAX_BYTES);
}

export function readLogTail(logFile, maxLines = 20) {
  if (!logFile) {
    return "";
  }
  let size;
  try {
    size = fs.statSync(logFile).size;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
  const bytes = Math.min(size, LOG_TAIL_MAX_BYTES);
  const buffer = Buffer.alloc(bytes);
  const descriptor = fs.openSync(logFile, "r");
  try {
    fs.readSync(descriptor, buffer, 0, bytes, size - bytes);
  } finally {
    fs.closeSync(descriptor);
  }
  const content = buffer.toString("utf8").trimEnd();
  if (!content) {
    return "";
  }
  return content.split(/\r?\n/).slice(-maxLines).join("\n");
}
