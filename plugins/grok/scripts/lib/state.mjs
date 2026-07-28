import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getProcessIdentity,
  processIdentitiesMatch,
  processIdentityMatches,
  processIsDirectlyAlive,
  validProcessIdentity
} from "./process-identity.mjs";

const DATA_DIR_ENV = "GROK_COMPANION_DATA";
const JOB_LOG_MAX_BYTES = 1024 * 1024;
const LOG_TAIL_MAX_BYTES = 64 * 1024;
const LOCK_TIMEOUT_ENV = "GROK_COMPANION_LOCK_TIMEOUT_MS";
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 10000;
const RESUME_OWNER_LAUNCH_GRACE_MS = 15000;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);

export const SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";
export const DEFAULT_LOCK_TIMEOUT_MS = 5000;

export function resolveLockTimeoutMs(env = process.env) {
  const raw = env[LOCK_TIMEOUT_ENV];
  if (raw === undefined || raw === null || (typeof raw === "string" && !String(raw).trim())) {
    return DEFAULT_LOCK_TIMEOUT_MS;
  }
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LOCK_TIMEOUT_MS;
}

export function resolveDataDir(env = process.env) {
  const override = env[DATA_DIR_ENV];
  if (override && String(override).trim()) {
    const value = String(override).trim();
    if (!path.isAbsolute(value)) {
      const error = new Error(`${DATA_DIR_ENV} must be an absolute path.`);
      error.failureKind = "input";
      throw error;
    }
    return path.normalize(value);
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "grok-claude-code-fusion");
}

export function workspaceSlug(cwd) {
  const absolute = path.resolve(cwd);
  const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 16);
  return `${path.basename(absolute)}-${hash}`;
}

export function workspaceStateDir(dataDir, cwd) {
  return path.join(dataDir, "state", workspaceSlug(cwd));
}

export function jobsDir(dataDir, cwd) {
  return path.join(workspaceStateDir(dataDir, cwd), "jobs");
}

export function briefsDir(dataDir, cwd) {
  return path.join(workspaceStateDir(dataDir, cwd), "briefs");
}

export function jobFilePath(dataDir, cwd, jobId) {
  return path.join(jobsDir(dataDir, cwd), `${jobId}.json`);
}

export function jobLogPath(dataDir, cwd, jobId) {
  return path.join(jobsDir(dataDir, cwd), `${jobId}.log`);
}

export function briefPath(dataDir, cwd, name) {
  return path.join(briefsDir(dataDir, cwd), `${name}.md`);
}

export function resumeSessionLeasePath(dataDir, cwd, sessionId) {
  const hash = createHash("sha256").update(String(sessionId)).digest("hex");
  return path.join(workspaceStateDir(dataDir, cwd), "session-leases", `${hash}.json`);
}

export function generateJobId() {
  return randomBytes(16).toString("hex");
}

export function nowIso() {
  return new Date().toISOString();
}

export function createJobRecord(fields) {
  const pid = Number.isInteger(fields.pid) && fields.pid > 1 ? fields.pid : null;
  return withStructuredStatuses({
    schemaVersion: 1,
    engine: "grok",
    companionVersion: fields.companionVersion ?? null,
    id: fields.id,
    pid,
    pidIdentity: Object.hasOwn(fields, "pidIdentity") ? fields.pidIdentity : pid ? getProcessIdentity(pid) : null,
    grokPid: null,
    grokPidIdentity: null,
    cleanupRequired: false,
    status: fields.status ?? "running",
    mode: fields.mode,
    cwd: fields.cwd,
    briefFile: fields.briefFile,
    background: Boolean(fields.background),
    delivery: fields.delivery ?? (fields.background ? "manual" : "foreground"),
    deliveryStatus: "pending",
    deliveryCollectedAt: null,
    claudeSessionId: fields.claudeSessionId ?? null,
    createdAt: fields.createdAt ?? nowIso(),
    finishedAt: null,
    exitCode: null,
    sessionId: null,
    resultText: null,
    resultPayload: null,
    resolvedModel: null,
    resolvedEffort: null,
    role: fields.role ?? null,
    usage: null,
    modelUsage: null,
    usageIsIncomplete: null,
    modelUsageIsIncomplete: null,
    errorMessage: null,
    errorTail: null,
    failureKind: null,
    semanticStatus: "unverified",
    semanticFailureKind: null,
    semanticFailureMessage: null,
    transportStatus: fields.status ?? "running",
    cancelRequestedAt: null,
    jobClass: fields.jobClass ?? "unknown",
    request: fields.request ?? null
  });
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensurePrivateDir(dir) {
  const missing = [];
  let current = path.resolve(dir);
  while (!fs.existsSync(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  for (const created of missing) {
    fs.chmodSync(created, PRIVATE_DIR_MODE);
  }
  fs.chmodSync(dir, PRIVATE_DIR_MODE);
}

export function ensurePrivateDataDir(dataDir) {
  ensurePrivateDir(dataDir);
  return dataDir;
}

function ensurePrivateStatePath(target) {
  const absolute = path.resolve(target);
  const parts = absolute.split(path.sep);
  const stateIndex = parts.lastIndexOf("state");
  if (stateIndex > 0) {
    const prefix = absolute.startsWith(path.sep) ? path.sep : "";
    for (let index = stateIndex; index < parts.length; index += 1) {
      const dir = path.join(prefix, ...parts.slice(0, index + 1));
      ensurePrivateDir(dir);
    }
    const dataDir = path.join(prefix, ...parts.slice(0, stateIndex));
    ensurePrivateDir(dataDir);
    return;
  }
  ensurePrivateDir(absolute);
}

function atomicWriteFile(file, content) {
  ensurePrivateStatePath(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temp, "wx", PRIVATE_FILE_MODE);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.chmodSync(temp, PRIVATE_FILE_MODE);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temp, file);
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

export function writePrivateStateFile(file, content) {
  atomicWriteFile(file, String(content ?? ""));
  return file;
}

export function hardenPrivateStateFile(file) {
  if (!fs.existsSync(file)) {
    return file;
  }
  ensurePrivateStatePath(path.dirname(file));
  fs.chmodSync(file, PRIVATE_FILE_MODE);
  return file;
}

function lockOwnerDir(lockDir, token) {
  return `${lockDir}.owner.${token}`;
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
      validProcessIdentity(record.ownerIdentity)
  );
}

function lockOwnerIdentity() {
  const identity = getProcessIdentity(process.pid);
  if (!validProcessIdentity(identity)) {
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

function lockOwnerWasReplaced(record) {
  if (processIdentityMatches(record.ownerPid, record.ownerIdentity)) {
    return false;
  }
  const currentIdentity = getProcessIdentity(record.ownerPid);
  if (currentIdentity) {
    return !processIdentitiesMatch(currentIdentity, record.ownerIdentity);
  }
  return !processIsDirectlyAlive(record.ownerPid);
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
  const preparedDir = `${ownerDir}.prepare.${process.pid}.${randomBytes(8).toString("hex")}`;
  ensurePrivateDir(preparedDir);
  try {
    atomicWriteFile(path.join(preparedDir, "owner.json"), `${JSON.stringify(record)}\n`);
    fs.renameSync(preparedDir, ownerDir);
    return { ownerDir, published: publishPreparedLock(linkPath, ownerDir) };
  } catch (error) {
    try {
      fs.rmSync(ownerDir, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(preparedDir, { recursive: true, force: true });
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
    try {
      fs.rmSync(lockOwnerDir(lockDir, observed.token), { recursive: true, force: true });
    } catch {}
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

function reclaimLegacyLock(lockDir) {
  try {
    const stats = fs.lstatSync(lockDir);
    if (!stats.isDirectory() || stats.isSymbolicLink() || Date.now() - stats.mtimeMs < LOCK_STALE_MS) {
      return false;
    }
    fs.rmdirSync(lockDir);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function linkedOwnerDir(linkPath) {
  try {
    if (!fs.lstatSync(linkPath).isSymbolicLink()) {
      return null;
    }
    const ownerDir = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
    if (path.dirname(ownerDir) !== path.dirname(linkPath) || !path.basename(ownerDir).startsWith(`${path.basename(linkPath)}.owner.`)) {
      return null;
    }
    return ownerDir;
  } catch {
    return null;
  }
}

function scavengeOrphanOwnerDirs(lockDir) {
  const dir = path.dirname(lockDir);
  const prefix = `${path.basename(lockDir)}.owner.`;
  const activeOwner = linkedOwnerDir(lockDir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const ownerDir = path.join(dir, entry);
    if (ownerDir === activeOwner) {
      continue;
    }
    let stats;
    try {
      stats = fs.lstatSync(ownerDir);
    } catch {
      continue;
    }
    if (Date.now() - stats.mtimeMs < LOCK_STALE_MS) {
      continue;
    }
    const prepared = entry.includes(".prepare.");
    const released = fs.existsSync(path.join(ownerDir, ".released"));
    const record = readLockRecord(ownerDir);
    if (!prepared && !released && (!record || !lockOwnerWasReplaced(record))) {
      continue;
    }
    if (linkedOwnerDir(lockDir) === ownerDir) {
      continue;
    }
    const claimedDir = `${ownerDir}.scavenged.${randomBytes(8).toString("hex")}`;
    try {
      fs.renameSync(ownerDir, claimedDir);
      fs.rmSync(claimedDir, { recursive: true, force: true });
    } catch {}
  }
}

function releaseLock(lockDir, token) {
  const ownerDir = lockOwnerDir(lockDir, token);
  try {
    fs.writeFileSync(path.join(ownerDir, ".released"), `${token}\n`, { flag: "wx", mode: PRIVATE_FILE_MODE });
  } catch {}
  if (!lockTargetsToken(lockDir, token)) {
    try {
      fs.rmSync(ownerDir, { recursive: true, force: true });
    } catch {}
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
  try {
    fs.rmSync(ownerDir, { recursive: true, force: true });
  } catch {}
  return true;
}

function withRecordLock(file, fn) {
  ensurePrivateStatePath(path.dirname(file));
  const lockDir = `${file}.lock`;
  scavengeOrphanOwnerDirs(lockDir);
  const deadline = Date.now() + resolveLockTimeoutMs();
  const token = randomBytes(16).toString("hex");
  const record = {
    version: 1,
    token,
    ownerPid: process.pid,
    ownerIdentity: lockOwnerIdentity()
  };
  let candidateDir = publishLockCandidate(lockDir, record);
  try {
    while (candidateDir) {
      const observed = readLockRecord(lockDir);
      if (reclaimReplacedLock(lockDir, observed) || (!observed && reclaimLegacyLock(lockDir))) {
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
    let callbackError = null;
    try {
      return fn();
    } catch (error) {
      callbackError = error;
      throw error;
    } finally {
      try {
        releaseLock(lockDir, token);
      } catch (error) {
        if (!callbackError) {
          throw error;
        }
      }
    }
  } finally {
    if (candidateDir) {
      try {
        fs.rmSync(candidateDir, { recursive: true, force: true });
      } catch {}
    }
    scavengeOrphanOwnerDirs(lockDir);
  }
}

function deliveryStatusFor(record) {
  if (record.deliveryCollectedAt) {
    return "collected";
  }
  if (record.delivery === "foreground" && TERMINAL_STATUSES.has(record.status)) {
    return "delivered";
  }
  return "pending";
}

function withStructuredStatuses(record) {
  const transportStatus = record.status;
  const semanticStatus = record.semanticStatus ?? "unverified";
  const deliveryStatus = deliveryStatusFor(record);
  const resultPayload = record.resultPayload && typeof record.resultPayload === "object" && !Array.isArray(record.resultPayload)
    ? {
        ...record.resultPayload,
        transportStatus,
        semanticStatus,
        delivery: record.delivery,
        deliveryStatus
      }
    : record.resultPayload;
  return {
    ...record,
    resultPayload,
    transportStatus,
    semanticStatus,
    deliveryStatus
  };
}

function preserveTerminalRecord(existing, next) {
  if (existing && TERMINAL_STATUSES.has(existing.status)) {
    return withStructuredStatuses(existing);
  }
  if (!TERMINAL_STATUSES.has(next.status)) {
    return withStructuredStatuses(next);
  }
  return withStructuredStatuses({
    ...next,
    pid: null,
    pidIdentity: null,
    grokPid: null,
    grokPidIdentity: null,
    cleanupRequired: false
  });
}

function resourceError(message) {
  const error = new Error(message);
  error.failureKind = "resource";
  return error;
}

export function createJobRecordFile(file, record) {
  return withRecordLock(file, () => {
    if (fs.existsSync(file)) {
      throw resourceError(`Job record already exists at ${file}.`);
    }
    atomicWriteFile(file, `${JSON.stringify(record, null, 2)}\n`);
    return file;
  });
}

export function writeJobRecordFile(file, record) {
  withRecordLock(file, () => {
    const existing = readJobRecordFile(file);
    const next = preserveTerminalRecord(existing, record);
    atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
  });
  return file;
}

export function markManagedDeliveryCollectedFile(file, collectedAt = nowIso()) {
  return withRecordLock(file, () => {
    const existing = readJobRecordFile(file);
    if (!existing || existing.delivery !== "managed" || !TERMINAL_STATUSES.has(existing.status) || existing.deliveryCollectedAt) {
      return existing;
    }
    const next = withStructuredStatuses({ ...existing, deliveryCollectedAt: collectedAt });
    atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function markDeliveryCollectedFile(file, collectedAt = nowIso()) {
  return withRecordLock(file, () => {
    const existing = readJobRecordFile(file);
    if (!existing || existing.delivery === "foreground" || !TERMINAL_STATUSES.has(existing.status) || existing.deliveryCollectedAt) {
      return existing;
    }
    const next = withStructuredStatuses({ ...existing, deliveryCollectedAt: collectedAt });
    atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function readJobRecordFile(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJobRecord(dataDir, cwd, record) {
  return writeJobRecordFile(jobFilePath(dataDir, cwd, record.id), record);
}

export function readJobRecord(dataDir, cwd, jobId) {
  return readJobRecordFile(jobFilePath(dataDir, cwd, jobId));
}

function recordedResumeOwnerProcessIsAlive(pid, identity) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  if (!validProcessIdentity(identity)) {
    return processIsDirectlyAlive(pid) || processGroupIsDirectlyAlive(pid);
  }
  const currentIdentity = getProcessIdentity(pid);
  if (currentIdentity) {
    return processIdentitiesMatch(currentIdentity, identity);
  }
  return processIsDirectlyAlive(pid) || processGroupIsDirectlyAlive(pid);
}

function processGroupIsDirectlyAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function resumeOwnerMayStillRun(record, now = Date.now()) {
  const processes = [
    [record.pid, record.pidIdentity],
    [record.grokPid, record.grokPidIdentity]
  ].filter(([pid]) => Number.isInteger(pid) && pid > 1);
  if (processes.some(([pid, identity]) => recordedResumeOwnerProcessIsAlive(pid, identity))) {
    return true;
  }
  if (processes.length > 0) {
    return false;
  }
  const createdAt = Date.parse(record.createdAt ?? "");
  return Number.isFinite(createdAt) && now - createdAt < RESUME_OWNER_LAUNCH_GRACE_MS;
}

function repairDeadResumeOwner(file, sessionId) {
  return updateJobRecordFileWithCurrent(file, (current) => {
    if (current.status !== "running" || resumeOwnerMayStillRun(current)) {
      return current;
    }
    const message = `The process that owned Grok session ${sessionId} exited without recording a terminal outcome.`;
    return {
      ...current,
      status: "error",
      finishedAt: nowIso(),
      errorMessage: message,
      errorTail: message,
      failureKind: "died",
      cancelRequestedAt: null
    };
  });
}

export function claimResumeSessionLease(dataDir, cwd, sessionId, ownerJobId) {
  const file = resumeSessionLeasePath(dataDir, cwd, sessionId);
  return withRecordLock(file, () => {
    const exists = fs.existsSync(file);
    const existing = readJobRecordFile(file);
    if (
      exists &&
      (!existing ||
        existing.version !== 1 ||
        existing.sessionId !== sessionId ||
        typeof existing.ownerJobId !== "string" ||
        typeof existing.claimedAt !== "string")
    ) {
      throw resourceError(`The resume session lease for ${sessionId} is invalid.`);
    }
    if (existing?.ownerJobId === ownerJobId) {
      return existing;
    }
    if (existing) {
      const owner = readJobRecord(dataDir, cwd, existing.ownerJobId);
      if (!owner || owner.id !== existing.ownerJobId || (owner.status !== "running" && !TERMINAL_STATUSES.has(owner.status))) {
        throw resourceError(`The resume session lease for ${sessionId} has an invalid owner record.`);
      }
      if (owner.status === "running") {
        const repaired = repairDeadResumeOwner(jobFilePath(dataDir, cwd, existing.ownerJobId), sessionId);
        if (repaired.status === "running") {
          throw resourceError(`Grok session ${sessionId} is already being resumed by running job ${existing.ownerJobId} in this workspace. Inspect it with /grok:status ${existing.ownerJobId}, then collect or cancel it before retrying.`);
        }
      }
    }
    const nextOwner = readJobRecord(dataDir, cwd, ownerJobId);
    if (!nextOwner || nextOwner.id !== ownerJobId || nextOwner.status !== "running") {
      throw resourceError(`Grok session ${sessionId} cannot be leased to invalid job ${ownerJobId}.`);
    }
    const next = {
      version: 1,
      sessionId,
      ownerJobId,
      claimedAt: nowIso()
    };
    atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function updateJobRecordFile(file, patch) {
  return withRecordLock(file, () => {
    const existing = readJobRecordFile(file);
    if (!existing) {
      throw new Error(`No job record found at ${file}.`);
    }
    if (TERMINAL_STATUSES.has(existing.status) && !Object.hasOwn(patch, "status")) {
      return existing;
    }
    const next = preserveTerminalRecord(existing, { ...existing, ...patch });
    atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function launchRunningJobProcess(file, launch, options = {}) {
  return withRecordLock(file, () => {
    const processRole = options.processRole === "worker" ? "worker" : "grok";
    const processLabel = processRole === "worker" ? "Background worker" : "Grok process";
    const existing = readJobRecordFile(file);
    if (!existing) {
      throw new Error(`No job record found at ${file}.`);
    }
    if (existing.status !== "running" || existing.cancelRequestedAt != null || existing.cleanupRequired) {
      const cancelled = existing.status === "cancelled" || existing.cancelRequestedAt != null;
      const reason = cancelled
        ? "cancellation was already requested"
        : existing.cleanupRequired
          ? "process cleanup is still required"
          : `the job is already ${existing.status}`;
      const error = new Error(`${processLabel} launch for job ${existing.id ?? "unknown"} was blocked because ${reason}.`);
      error.failureKind = cancelled ? "cancelled" : existing.failureKind ?? "resource";
      error.launchPrevented = true;
      error.processRole = processRole;
      if (existing.cleanupRequired) {
        error.cleanupRequired = true;
        error.pid = processRole === "worker" ? existing.pid ?? null : existing.grokPid ?? null;
        error.pidIdentity = processRole === "worker" ? existing.pidIdentity ?? null : existing.grokPidIdentity ?? null;
      }
      throw error;
    }

    const launched = launch();
    const pid = launched?.pid ?? launched?.child?.pid;
    if (!Number.isInteger(pid) || pid <= 1) {
      const error = resourceError(`${processLabel} launch for job ${existing.id ?? "unknown"} did not produce a valid PID.`);
      error.processRole = processRole;
      throw error;
    }
    const pidField = processRole === "worker" ? "pid" : "grokPid";
    const identityField = processRole === "worker" ? "pidIdentity" : "grokPidIdentity";
    const next = {
      ...existing,
      [pidField]: pid,
      [identityField]: launched?.identity ?? null
    };
    atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
    return { ...launched, record: next };
  });
}

export function updateJobRecordFileWithCurrent(file, updater, options = {}) {
  return withRecordLock(file, () => {
    const existing = readJobRecordFile(file);
    if (!existing) {
      throw new Error(`No job record found at ${file}.`);
    }
    const allowTerminal = options.allowTerminal === true;
    if (TERMINAL_STATUSES.has(existing.status) && !allowTerminal) {
      return withStructuredStatuses(existing);
    }
    const updated = updater(existing);
    if (!updated || updated === existing) {
      return existing;
    }
    const next = allowTerminal && TERMINAL_STATUSES.has(existing.status)
      ? withStructuredStatuses({
          ...existing,
          ...updated,
          status: existing.status
        })
      : preserveTerminalRecord(existing, updated);
    if (next === existing) {
      return existing;
    }
    atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function finishSuccessfulJobRecordFile(file, successPatch) {
  return withRecordLock(file, () => {
    const existing = readJobRecordFile(file);
    if (!existing) {
      throw new Error(`No job record found at ${file}.`);
    }
    if (TERMINAL_STATUSES.has(existing.status)) {
      return existing;
    }
    const treatAsCancelled =
      existing.status === "cancelled" || existing.cancelRequestedAt != null;
    const { terminalAttribution = {}, ...success } = successPatch;
    const patch = treatAsCancelled
      ? {
          status: "cancelled",
          pid: null,
          grokPid: null,
          finishedAt: success.finishedAt ?? nowIso(),
          exitCode: success.exitCode ?? null,
          sessionId: success.sessionId ?? null,
          resolvedModel: terminalAttribution.resolvedModel ?? success.resolvedModel ?? existing.resolvedModel ?? existing.request?.model ?? null,
          resolvedEffort: terminalAttribution.resolvedEffort ?? success.resolvedEffort ?? existing.resolvedEffort ?? existing.request?.effort ?? null,
          resultText: success.resultText ?? null,
          usage: success.usage ?? existing.usage ?? null,
          modelUsage: success.modelUsage ?? existing.modelUsage ?? null,
          usageIsIncomplete: success.usageIsIncomplete ?? existing.usageIsIncomplete ?? null,
          modelUsageIsIncomplete: success.modelUsageIsIncomplete ?? existing.modelUsageIsIncomplete ?? null,
          errorTail: null,
          failureKind: "cancelled",
          cancelRequestedAt: null
        }
      : { ...success, cancelRequestedAt: null };
    const next = preserveTerminalRecord(existing, { ...existing, ...patch });
    atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function listJobRecords(dataDir, cwd) {
  const dir = jobsDir(dataDir, cwd);
  try {
    const stats = fs.lstatSync(dir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return [];
    }
  } catch {
    return [];
  }
  const records = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const expectedId = entry.name.slice(0, -".json".length);
    const record = readJobRecordFile(path.join(dir, entry.name));
    if (record?.id === expectedId) {
      records.push(record);
    }
  }
  return records.sort((left, right) =>
    String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")) ||
    String(right.id ?? "").localeCompare(String(left.id ?? ""))
  );
}

export function listAllJobRecords(dataDir) {
  const stateRoot = path.join(dataDir, "state");
  try {
    const stats = fs.lstatSync(stateRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return [];
    }
  } catch {
    return [];
  }
  const results = [];
  for (const workspace of fs.readdirSync(stateRoot, { withFileTypes: true })) {
    if (!workspace.isDirectory()) {
      continue;
    }
    const dir = path.join(stateRoot, workspace.name, "jobs");
    try {
      const stats = fs.lstatSync(dir);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        continue;
      }
    } catch {
      continue;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const file = path.join(dir, entry.name);
      const expectedId = entry.name.slice(0, -".json".length);
      const record = readJobRecordFile(file);
      if (record?.id === expectedId) {
        results.push({ record, file });
      }
    }
  }
  return results.sort(
    (left, right) =>
      String(right.record.createdAt ?? "").localeCompare(String(left.record.createdAt ?? "")) ||
      String(right.record.id ?? "").localeCompare(String(left.record.id ?? "")) ||
      String(left.file).localeCompare(String(right.file))
  );
}

export function findJobRecordById(dataDir, jobId) {
  const matches = listAllJobRecords(dataDir).filter((entry) => entry.record.id === jobId);
  if (matches.length > 1) {
    throw resourceError(`Job id ${jobId} exists in multiple workspaces. Repeat the command with --cwd.`);
  }
  return matches[0] ?? null;
}

export function writeBrief(dataDir, cwd, name, content) {
  const file = briefPath(dataDir, cwd, name);
  ensurePrivateStatePath(path.dirname(file));
  const text = String(content ?? "");
  try {
    fs.writeFileSync(file, text, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE
    });
    fs.chmodSync(file, PRIVATE_FILE_MODE);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw resourceError(`Brief already exists at ${file}.`);
    }
    throw error;
  }
  return file;
}

export function writePrivateDataFile(dataDir, name, content) {
  ensurePrivateDir(dataDir);
  const file = path.join(dataDir, name);
  atomicWriteFile(file, String(content ?? ""));
  return file;
}

export function appendJobLog(logFile, text) {
  if (!logFile) {
    return;
  }
  ensurePrivateStatePath(path.dirname(logFile));
  const raw = String(text ?? "");
  const value = raw.endsWith("\n") ? raw : `${raw}\n`;
  fs.appendFileSync(logFile, value.slice(-JOB_LOG_MAX_BYTES), { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  fs.chmodSync(logFile, PRIVATE_FILE_MODE);
  const size = fs.statSync(logFile).size;
  if (size > JOB_LOG_MAX_BYTES) {
    const fd = fs.openSync(logFile, "r");
    try {
      const keep = Buffer.alloc(JOB_LOG_MAX_BYTES);
      fs.readSync(fd, keep, 0, JOB_LOG_MAX_BYTES, size - JOB_LOG_MAX_BYTES);
      atomicWriteFile(logFile, keep.toString("utf8"));
    } finally {
      fs.closeSync(fd);
    }
  }
}

export function readLogTail(logFile, maxLines = 20) {
  if (!logFile || !fs.existsSync(logFile)) {
    return "";
  }
  const size = fs.statSync(logFile).size;
  const bytes = Math.min(size, LOG_TAIL_MAX_BYTES);
  const buffer = Buffer.alloc(bytes);
  const fd = fs.openSync(logFile, "r");
  try {
    fs.readSync(fd, buffer, 0, bytes, size - bytes);
  } finally {
    fs.closeSync(fd);
  }
  const content = buffer.toString("utf8").trimEnd();
  if (!content) {
    return "";
  }
  return content.split(/\r?\n/).slice(-maxLines).join("\n");
}
