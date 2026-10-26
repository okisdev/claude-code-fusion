import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configureRecordLock, withRecordLock } from "./record-lock.mjs";

import {
  getProcessIdentity,
  processGroupAlive,
  processIdentitiesMatch,
  processIsDirectlyAlive,
  validProcessIdentity
} from "./process-identity.mjs";

const DATA_DIR_ENV = "GROK_COMPANION_DATA";
const JOB_LOG_MAX_BYTES = 1024 * 1024;
const LOG_TAIL_MAX_BYTES = 64 * 1024;
const LOCK_TIMEOUT_ENV = "GROK_COMPANION_LOCK_TIMEOUT_MS";
const RESUME_OWNER_LAUNCH_GRACE_MS = 15000;
const LEASE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MONITOR_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
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

export function quotaCooldownPath(dataDir) {
  return path.join(dataDir, "quota-cooldown.json");
}

export function readQuotaCooldown(dataDir) {
  const file = quotaCooldownPath(dataDir);
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && Number.isFinite(Date.parse(value.setAt)) &&
      Number.isFinite(Date.parse(value.expiresAt)) &&
      typeof value.jobId === "string" && typeof value.message === "string"
      ? value : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function writeQuotaCooldown(dataDir, value) {
  atomicWriteFile(quotaCooldownPath(dataDir), `${JSON.stringify(value, null, 2)}\n`);
}

export function clearQuotaCooldown(dataDir) {
  try {
    fs.unlinkSync(quotaCooldownPath(dataDir));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
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
    grokVersion: typeof fields.grokVersion === "string" && fields.grokVersion.trim() ? fields.grokVersion.trim() : null,
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
  try {
    sweepGrokState(dataDir);
  } catch {}
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

function fsyncDirectory(dir) {
  let descriptor;
  try {
    descriptor = fs.openSync(dir, "r");
    fs.fsyncSync(descriptor);
  } catch {
    return;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function atomicWriteFile(file, content) {
  ensurePrivateStatePath(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temp, "wx", PRIVATE_FILE_MODE);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.chmodSync(temp, PRIVATE_FILE_MODE);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temp, file);
    fsyncDirectory(path.dirname(file));
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

configureRecordLock({ atomicWriteFile, ensurePrivateDir, ensurePrivateStatePath, resolveLockTimeoutMs });

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
  const semanticStatus = record.semanticStatus;
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

const JOB_RECORD_FIELDS = ["jobClass", "delivery", "semanticStatus", "request", "pidIdentity",
  "grokPidIdentity", "grokVersion", "deliveryStatus", "transportStatus", "resultPayload", "cleanupRequired"];

function assertJobRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)
      || record.schemaVersion !== 1 || record.engine !== "grok"
      || typeof record.id !== "string"
      || JOB_RECORD_FIELDS.some((field) => !Object.hasOwn(record, field))) {
    throw new TypeError("Job record schema is invalid.");
  }
}

export function migrateJobRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || raw.engine != null && raw.engine !== "grok"
      || raw.schemaVersion != null && raw.schemaVersion !== 1) return raw;
  if (raw.schemaVersion === 1 && raw.engine === "grok"
      && JOB_RECORD_FIELDS.every((field) => Object.hasOwn(raw, field))) return raw;
  if (typeof raw.id !== "string" || !raw.id || typeof raw.mode !== "string"
      || typeof raw.cwd !== "string" || typeof raw.createdAt !== "string"
      || typeof raw.background !== "boolean" || !Object.hasOwn(raw, "request")) return raw;
  return withStructuredStatuses({
    ...raw,
    schemaVersion: 1,
    engine: "grok",
    companionVersion: raw.companionVersion ?? null,
    grokVersion: typeof raw.grokVersion === "string" && raw.grokVersion.trim() ? raw.grokVersion.trim() : null,
    jobClass: raw.jobClass ?? "unknown",
    delivery: raw.delivery ?? (raw.background ? "manual" : "foreground"),
    deliveryCollectedAt: raw.deliveryCollectedAt ?? null,
    claudeSessionId: raw.claudeSessionId ?? null,
    finishedAt: raw.finishedAt ?? null,
    exitCode: raw.exitCode ?? null,
    sessionId: raw.sessionId ?? null,
    resultText: raw.resultText ?? null,
    resolvedModel: raw.resolvedModel ?? null,
    resolvedEffort: raw.resolvedEffort ?? null,
    role: raw.role ?? null,
    usage: raw.usage ?? null,
    modelUsage: raw.modelUsage ?? null,
    usageIsIncomplete: raw.usageIsIncomplete ?? null,
    modelUsageIsIncomplete: raw.modelUsageIsIncomplete ?? null,
    errorMessage: raw.errorMessage ?? null,
    errorTail: raw.errorTail ?? null,
    failureKind: raw.failureKind ?? null,
    semanticStatus: raw.semanticStatus ?? "unverified",
    semanticFailureKind: raw.semanticFailureKind ?? null,
    semanticFailureMessage: raw.semanticFailureMessage ?? null,
    pidIdentity: raw.pidIdentity ?? null,
    grokPidIdentity: raw.grokPidIdentity ?? null,
    cleanupRequired: raw.cleanupRequired ?? false,
    resultPayload: raw.resultPayload ?? null,
    cancelRequestedAt: raw.cancelRequestedAt ?? null
  });
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
    const existing = readJobRecordFile(file, true);
    const next = preserveTerminalRecord(existing, record);
    atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
  });
  return file;
}

export function markManagedDeliveryCollectedFile(file, collectedAt = nowIso()) {
  return withRecordLock(file, () => {
    const existing = readJobRecordFile(file, true);
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
    const existing = readJobRecordFile(file, true);
    if (!existing || existing.delivery === "foreground" || !TERMINAL_STATUSES.has(existing.status) || existing.deliveryCollectedAt) {
      return existing;
    }
    const next = withStructuredStatuses({ ...existing, deliveryCollectedAt: collectedAt });
    atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function readJobRecordFile(file, locked = false) {
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record) || !Object.hasOwn(record, "id")) return record;
    const migrated = migrateJobRecord(record);
    assertJobRecord(migrated);
    if (migrated === record) return record;
    if (locked) {
      atomicWriteFile(file, `${JSON.stringify(migrated, null, 2)}\n`);
      return migrated;
    }
    return withRecordLock(file, () => readJobRecordFile(file, true));
  } catch {
    return null;
  }
}

function writeJobRecord(dataDir, cwd, record) {
  return writeJobRecordFile(jobFilePath(dataDir, cwd, record.id), record);
}

function readJobRecord(dataDir, cwd, jobId) {
  return readJobRecordFile(jobFilePath(dataDir, cwd, jobId));
}

function recordedResumeOwnerProcessIsAlive(pid, identity) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  if (!validProcessIdentity(identity)) {
    return processIsDirectlyAlive(pid) || processGroupAlive(pid);
  }
  const currentIdentity = getProcessIdentity(pid);
  if (currentIdentity) {
    return processIdentitiesMatch(currentIdentity, identity);
  }
  return processIsDirectlyAlive(pid) || processGroupAlive(pid);
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

function regularFileOlderThan(file, ageMs, now) {
  const stats = fs.lstatSync(file, { throwIfNoEntry: false });
  return Boolean(stats?.isFile() && now - stats.mtimeMs >= ageMs);
}

function sweepGrokState(dataDir, now = Date.now()) {
  const stamp = path.join(dataDir, ".grok-state-sweep.json");
  return withRecordLock(stamp, () => {
    const last = readJobRecordFile(stamp)?.sweptAt;
    if (Number.isFinite(last) && now - last < STATE_SWEEP_INTERVAL_MS) return false;
    const stateRoot = path.join(dataDir, "state");
    if (fs.lstatSync(stateRoot, { throwIfNoEntry: false })?.isDirectory()) {
      for (const workspace of fs.readdirSync(stateRoot, { withFileTypes: true })) {
        if (!workspace.isDirectory()) continue;
        const workspaceDir = path.join(stateRoot, workspace.name);
        const leasesDir = path.join(workspaceDir, "session-leases");
        if (fs.lstatSync(leasesDir, { throwIfNoEntry: false })?.isDirectory()) {
          for (const entry of fs.readdirSync(leasesDir, { withFileTypes: true })) {
            if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
            const file = path.join(leasesDir, entry.name);
            if (!regularFileOlderThan(file, LEASE_RETENTION_MS, now)) continue;
            withRecordLock(file, () => {
              if (!regularFileOlderThan(file, LEASE_RETENTION_MS, now)) return;
              const lease = readJobRecordFile(file);
              if (lease?.version !== 1 || typeof lease.sessionId !== "string" || typeof lease.ownerJobId !== "string" || typeof lease.claimedAt !== "string") return;
              if (`${createHash("sha256").update(lease.sessionId).digest("hex")}.json` !== entry.name) return;
              if (!/^[A-Za-z0-9_-]+$/.test(lease.ownerJobId)) return;
              const ownerFile = path.join(workspaceDir, "jobs", `${lease.ownerJobId}.json`);
              const owner = readJobRecordFile(ownerFile);
              if (owner?.id === lease.ownerJobId && resumeOwnerMayStillRun(owner, now)) return;
              fs.unlinkSync(file);
            });
          }
        }
        for (const entry of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
          if (!entry.isFile() || !/^jobs-monitor-announced(?:\..*)?\.json$/.test(entry.name)) continue;
          const file = path.join(workspaceDir, entry.name);
          if (regularFileOlderThan(file, MONITOR_RETENTION_MS, now)) fs.unlinkSync(file);
        }
      }
    }
    atomicWriteFile(stamp, `${JSON.stringify({ sweptAt: now })}\n`);
    return true;
  });
}

export function updateJobRecordFile(file, patch) {
  return withRecordLock(file, () => {
    const existing = readJobRecordFile(file, true);
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
    const existing = readJobRecordFile(file, true);
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
    const existing = readJobRecordFile(file, true);
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
    const existing = readJobRecordFile(file, true);
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
          numTurns: success.numTurns ?? existing.numTurns ?? null,
          totalCostUsd: success.totalCostUsd ?? existing.totalCostUsd ?? null,
          totalCostUsdTicks: success.totalCostUsdTicks ?? existing.totalCostUsdTicks ?? null,
          costIsPartial: success.costIsPartial ?? existing.costIsPartial ?? null,
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
