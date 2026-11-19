import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureRecordLock, withRecordLock } from "./record-lock.mjs";
import { JOB_ID_PATTERN } from "./job-id.mjs";

import {
  getProcessIdentity,
  processGroupAlive,
  processIdentitiesMatch,
  processIsDirectlyAlive,
  validProcessIdentity
} from "./process-identity.mjs";

const JOB_LOG_MAX_BYTES = 1024 * 1024;
const LOG_TAIL_MAX_BYTES = 64 * 1024;
const RESUME_OWNER_LAUNCH_GRACE_MS = 15000;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);

const SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";
const DEFAULT_LOCK_TIMEOUT_MS = 5000;

export function resolveTimeoutMs(value, fallback = DEFAULT_LOCK_TIMEOUT_MS, minimum = 1) {
  if (value == null || !String(value).trim()) return fallback;
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

const JOB_RECORD_SCAN_MAX_BYTES = 16 * 1024 * 1024;
const WORKSPACE_SLUG_PATTERN = /^.+-[a-f0-9]{16}$/;
const GC_INTERVAL_MS = 60 * 1000;
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const TEMP_AGE_MS = 60 * 60 * 1000;

function retentionLimit(value, fallback) {
  if (value == null || typeof value === "string" && !value.trim()) return fallback;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function createJobState({
  engine,
  engineName,
  pidField: enginePidField,
  dataDirEnv,
  lockTimeoutEnv,
  dataDirName,
  sweepMarker,
  recordFields,
  requiredRecordFields,
  cancelledRecordFields = () => ({}),
  migrate,
  validateRecord,
  normalizeRecord = (record) => record,
  maintainTerminalRecord = () => {},
  resolveWorkspace = path.resolve,
  validateIdentifier = (value) => value,
  compareRecords = (left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")) || String(right.id ?? "").localeCompare(String(left.id ?? "")),
  recordLock = {},
  history,
  onCorruptRecord,
  onReadError
}) {
  const versionField = `${engine}Version`;
  const buildPathField = `${engine}BuildPath`;
  const engineIdentityField = `${enginePidField}Identity`;

  function resolveLockTimeoutMs(env = process.env) {
    return resolveTimeoutMs(env[lockTimeoutEnv]);
  }

  function resolveDataDir(env = process.env) {
    const override = env[dataDirEnv];
    if (override && String(override).trim()) {
      const value = String(override).trim();
      if (!path.isAbsolute(value)) {
        const error = new Error(`${dataDirEnv} must be an absolute path.`);
        error.failureKind = "input";
        throw error;
      }
      return path.normalize(value);
    }
    return path.join(os.homedir(), ".claude", "plugins", "data", dataDirName);
  }

  function workspaceSlug(cwd) {
    const absolute = resolveWorkspace(cwd);
    const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 16);
    return `${path.basename(absolute) || "workspace"}-${hash}`;
  }

  const workspaceStateDir = (dataDir, cwd) => path.join(dataDir, "state", workspaceSlug(cwd));
  const jobsDir = (dataDir, cwd) => path.join(workspaceStateDir(dataDir, cwd), "jobs");
  const briefsDir = (dataDir, cwd) => path.join(workspaceStateDir(dataDir, cwd), "briefs");
  const jobFilePath = (dataDir, cwd, id) => path.join(jobsDir(dataDir, cwd), `${validateIdentifier(id, "Job id")}.json`);
  const jobLogPath = (dataDir, cwd, id) => path.join(jobsDir(dataDir, cwd), `${validateIdentifier(id, "Job id")}.log`);
  const briefPath = (dataDir, cwd, name) => path.join(briefsDir(dataDir, cwd), `${validateIdentifier(name, "Brief name")}.md`);
  const resumeSessionLeasePath = (dataDir, cwd, id) => path.join(workspaceStateDir(dataDir, cwd), "session-leases", `${createHash("sha256").update(String(id)).digest("hex")}.json`);
  const generateJobId = () => randomBytes(16).toString("hex");
  const nowIso = () => new Date().toISOString();

  function createJobRecord(fields) {
    const engineFields = recordFields(fields);
    const pid = Number.isInteger(fields.pid) && fields.pid > 1 ? fields.pid : null;
    const nullable = [
      "companionVersion", buildPathField, "claudeSessionId", "sessionId", "requestId", "requestedModel",
      "resolvedModel", "observedModel", "modelDrift", "requestedEffort", "effortApplied", "billingPool",
      "role", "usage", "usageIsIncomplete", "request"
    ];
    return withStructuredStatuses({
      ...Object.fromEntries(nullable.map((key) => [key, fields[key] ?? null])),
      schemaVersion: 1, engine, id: fields.id, pid,
      [versionField]: typeof fields[versionField] === "string" && fields[versionField].trim() ? fields[versionField].trim() : null,
      pidIdentity: Object.hasOwn(fields, "pidIdentity") ? fields.pidIdentity : pid ? getProcessIdentity(pid) : null,
      [enginePidField]: null,
      [engineIdentityField]: null,
      cleanupRequired: false,
      status: fields.status ?? "running",
      mode: fields.mode,
      cwd: fields.cwd,
      briefFile: fields.briefFile,
      background: Boolean(fields.background),
      delivery: fields.delivery ?? (fields.background ? "manual" : "foreground"),
      deliveryStatus: "pending",
      deliveryCollectedAt: null,
      createdAt: fields.createdAt ?? nowIso(),
      finishedAt: null,
      exitCode: null,
      resultText: null,
      resultPayload: null,
      warnings: Array.isArray(fields.warnings) ? fields.warnings.filter((warning) => typeof warning === "string") : [],
      errorMessage: null,
      errorTail: null,
      failureKind: null,
      semanticStatus: "unverified",
      semanticFailureKind: null,
      semanticFailureMessage: null,
      transportStatus: fields.status ?? "running",
      cancelRequestedAt: null,
      jobClass: fields.jobClass ?? "unknown",
      ...engineFields
    });
  }

  function ensurePrivateDir(dir) {
    const missing = [];
    for (let current = path.resolve(dir); !fs.existsSync(current); current = path.dirname(current)) {
      missing.push(current);
      if (path.dirname(current) === current) break;
    }
    fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    for (const created of [...missing, dir]) fs.chmodSync(created, PRIVATE_DIR_MODE);
  }

  function ensurePrivateDataDir(dataDir) {
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

  function atomicWriteFile(file, content, retryMissingDirectory = true) {
    const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const deadline = Date.now() + resolveLockTimeoutMs();
    let descriptor;
    try {
      while (descriptor === undefined) {
        try {
          ensurePrivateStatePath(path.dirname(file));
          descriptor = fs.openSync(temp, "wx", PRIVATE_FILE_MODE);
        } catch (error) {
          if (error?.code !== "ENOENT" || !retryMissingDirectory || Date.now() >= deadline) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
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

  function writePrivateStateFile(file, content) {
    atomicWriteFile(file, String(content ?? ""));
    return file;
  }

  function hardenPrivateStateFile(file) {
    if (!fs.existsSync(file)) return file;
    ensurePrivateStatePath(path.dirname(file));
    fs.chmodSync(file, PRIVATE_FILE_MODE);
    return file;
  }

  configureRecordLock({ ...recordLock, atomicWriteFile, ensurePrivateDir, ensurePrivateStatePath, resolveLockTimeoutMs });

  function deliveryStatusFor(record) {
    return record.deliveryCollectedAt ? "collected" : record.delivery === "foreground" && TERMINAL_STATUSES.has(record.status) ? "delivered" : "pending";
  }

  function withStructuredStatuses(record) {
    return normalizeRecord({ ...record, transportStatus: record.status, semanticStatus: record.semanticStatus, deliveryStatus: deliveryStatusFor(record) });
  }

  function preserveTerminalRecord(existing, next) {
    if (existing && TERMINAL_STATUSES.has(existing.status)) return withStructuredStatuses(existing);
    return withStructuredStatuses(TERMINAL_STATUSES.has(next.status)
      ? { ...next, pid: null, pidIdentity: null, [enginePidField]: null, [engineIdentityField]: null, cleanupRequired: false }
      : next);
  }

  function storeRecord(file, record) {
    atomicWriteFile(file, `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  function resourceError(message) {
    const error = new Error(message);
    error.failureKind = "resource";
    return error;
  }

  function createJobRecordFile(file, record) {
    const dataDir = path.resolve(path.dirname(file), "../../..");
    return withRecordLock(path.join(dataDir, sweepMarker), () =>
      withRecordLock(file, () => {
        if (fs.existsSync(file)) throw resourceError(`Job record already exists at ${file}.`);
        atomicWriteFile(file, `${JSON.stringify(record, null, 2)}\n`);
        return file;
      })
    );
  }

  function writeJobRecordFile(file, record) {
    withRecordUpdate(file, (existing) => storeRecord(file, preserveTerminalRecord(existing, record)));
    return file;
  }

  function collectDelivery(file, collectedAt, managedOnly) {
    return withRecordLock(file, () => {
      const existing = readJobRecordFile(file, true);
      if (!existing || (managedOnly ? existing.delivery !== "managed" : existing.delivery === "foreground") ||
          !TERMINAL_STATUSES.has(existing.status) || existing.deliveryCollectedAt) return existing;
      return storeRecord(file, withStructuredStatuses({ ...existing, deliveryCollectedAt: collectedAt }));
    });
  }

  function markManagedDeliveryCollectedFile(file, collectedAt = nowIso()) {
    return collectDelivery(file, collectedAt, true);
  }

  function markDeliveryCollectedFile(file, collectedAt = nowIso()) {
    return collectDelivery(file, collectedAt, false);
  }

  function currentJobRecord(record) {
    return record && typeof record === "object" && !Array.isArray(record) &&
      record.schemaVersion === 1 && record.engine === engine &&
      typeof record.id === "string" && typeof record.cwd === "string" &&
      typeof record.createdAt === "string" &&
      ["running", "done", "error", "cancelled"].includes(record.status) &&
      ["consult", "write", "review"].includes(record.mode) &&
      typeof record.jobClass === "string" && typeof record.delivery === "string" &&
      typeof record.semanticStatus === "string" && typeof record.transportStatus === "string" &&
      typeof record.deliveryStatus === "string" && Array.isArray(record.warnings) &&
      record.resultPayload === null &&
      Object.hasOwn(record, "finishedAt") && requiredRecordFields.every((field) => Object.hasOwn(record, field)) &&
      Object.hasOwn(record, versionField) && Object.hasOwn(record, buildPathField) &&
      Object.hasOwn(record, "pidIdentity") && Object.hasOwn(record, engineIdentityField) &&
      Object.hasOwn(record, "cleanupRequired");
  }

  function readJobRecordFile(file, locked = false) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); }
    catch (error) { onReadError?.(error, file); return null; }
    let record;
    try { record = JSON.parse(text); }
    catch (error) { onCorruptRecord?.(file, error); return null; }
    let migrated = record;
    try {
      if (migrate) {
        if (path.basename(path.dirname(file)) !== "jobs" &&
            (!record || typeof record !== "object" || Array.isArray(record) || !Object.hasOwn(record, "id"))) return record;
        migrated = migrate(record);
      }
      if ((migrate || path.basename(path.dirname(file)) === "jobs") && !(validateRecord ?? currentJobRecord)(migrated)) return null;
    } catch { return null; }
    if (migrated === record) return record;
    try {
      return locked ? storeRecord(file, migrated) : withRecordLock(file, () => readJobRecordFile(file, true));
    } catch (error) { onReadError?.(error, file); return null; }
  }

  function readJobRecord(dataDir, cwd, jobId) {
    return readJobRecordFile(jobFilePath(dataDir, cwd, jobId));
  }

  function pruneJobRecords(dataDir, now = Date.now()) {
    const rawDays = process.env[`${engine.toUpperCase()}_COMPANION_RECORD_RETENTION_DAYS`];
    const days = typeof rawDays === "string" && /^(0|[1-9]\d*)$/.test(rawDays.trim()) && Number.isSafeInteger(Number(rawDays.trim()))
      ? Number(rawDays.trim()) : 90;
    if (days === 0) return;
    const retentionMs = days * 24 * 60 * 60 * 1000;
    const stateRoot = path.join(dataDir, "state");
    if (!fs.lstatSync(stateRoot, { throwIfNoEntry: false })?.isDirectory()) return;
    for (const workspace of fs.readdirSync(stateRoot, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      const workspaceDir = path.join(stateRoot, workspace.name);
      const jobs = path.join(workspaceDir, "jobs");
      if (!fs.lstatSync(jobs, { throwIfNoEntry: false })?.isDirectory()) continue;
      const leaseOwners = new Set();
      const leases = path.join(workspaceDir, "session-leases");
      if (fs.lstatSync(leases, { throwIfNoEntry: false })?.isDirectory()) {
        for (const entry of fs.readdirSync(leases, { withFileTypes: true })) {
          if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
          try {
            const lease = JSON.parse(fs.readFileSync(path.join(leases, entry.name), "utf8"));
            if (lease.version === 1 && typeof lease.sessionId === "string" &&
                createHash("sha256").update(lease.sessionId).digest("hex") + ".json" === entry.name &&
                typeof lease.ownerJobId === "string" && typeof lease.claimedAt === "string") {
              leaseOwners.add(lease.ownerJobId);
            }
          } catch {}
        }
      }
      const expired = (record, stats, id) => {
        if (!stats?.isFile() || stats.isSymbolicLink() || record?.engine !== engine || record.id !== id ||
            !TERMINAL_STATUSES.has(record.status) || record.cleanupRequired ||
            ((record.background || record.delivery !== "foreground") && !record.deliveryCollectedAt) ||
            leaseOwners.has(id)) return false;
        const finished = record.finishedAt == null ? stats.mtimeMs : Date.parse(record.finishedAt);
        return Number.isFinite(finished) && now - finished >= retentionMs;
      };
      for (const entry of fs.readdirSync(jobs, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[A-Za-z0-9_-]+\.json$/.test(entry.name)) continue;
        const file = path.join(jobs, entry.name);
        const id = entry.name.slice(0, -5);
        try {
          const stats = fs.lstatSync(file, { throwIfNoEntry: false });
          if (!stats?.isFile() || stats.isSymbolicLink()) continue;
          const raw = JSON.parse(fs.readFileSync(file, "utf8"));
          if (!expired(migrate ? migrate(raw) : raw, stats, id)) continue;
          withRecordLock(file, () => {
            const stats = fs.lstatSync(file, { throwIfNoEntry: false });
            const raw = JSON.parse(fs.readFileSync(file, "utf8"));
            const record = migrate ? migrate(raw) : raw;
            if (!expired(record, stats, id)) return;
            const brief = record.briefFile;
            const briefDir = path.join(workspaceDir, "briefs");
            const briefDirStats = fs.lstatSync(briefDir, { throwIfNoEntry: false });
            if (briefDirStats?.isDirectory() && !briefDirStats.isSymbolicLink() &&
                typeof brief === "string" && path.dirname(brief) === briefDir) {
              const briefStats = fs.lstatSync(brief, { throwIfNoEntry: false });
              if (briefStats?.isFile() && !briefStats.isSymbolicLink()) fs.unlinkSync(brief);
            }
            const log = path.join(jobs, `${id}.log`);
            const logStats = fs.lstatSync(log, { throwIfNoEntry: false });
            if (logStats?.isFile() && !logStats.isSymbolicLink()) fs.unlinkSync(log);
            fs.unlinkSync(file);
          });
        } catch {}
      }
    }
  }

  function recordedResumeOwnerProcessIsAlive(pid, identity) {
    if (!Number.isInteger(pid) || pid <= 1) return false;
    if (!validProcessIdentity(identity)) return processIsDirectlyAlive(pid) || processGroupAlive(pid);
    const currentIdentity = getProcessIdentity(pid);
    if (currentIdentity) return processIdentitiesMatch(currentIdentity, identity);
    return processIsDirectlyAlive(pid) || processGroupAlive(pid);
  }

  function resumeOwnerMayStillRun(record, now = Date.now()) {
    const processes = [
      [record.pid, record.pidIdentity],
      [record[enginePidField], record[engineIdentityField]]
    ].filter(([pid]) => Number.isInteger(pid) && pid > 1);
    if (processes.some(([pid, identity]) => recordedResumeOwnerProcessIsAlive(pid, identity))) return true;
    if (processes.length > 0) return false;
    const createdAt = Date.parse(record.createdAt);
    return Number.isFinite(createdAt) && now - createdAt < RESUME_OWNER_LAUNCH_GRACE_MS;
  }

  function repairDeadResumeOwner(file, sessionId) {
    return withRecordLock(file, () => {
      const current = requireRecord(file);
      if (current.status !== "running" || resumeOwnerMayStillRun(current)) return current;
      const message = `The process that owned ${engineName} session ${sessionId} exited without recording a terminal outcome.`;
      return storeRecord(file, preserveTerminalRecord(current, {
        ...current, status: "error", finishedAt: nowIso(), errorMessage: message, errorTail: message, failureKind: "died", cancelRequestedAt: null
      }));
    });
  }

  function claimResumeSessionLease(dataDir, cwd, sessionId, ownerJobId, { preflight = false } = {}) {
    const file = resumeSessionLeasePath(dataDir, cwd, sessionId);
    let repairedOwner;
    try {
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
        if (existing?.ownerJobId === ownerJobId) return existing;
        if (existing) {
          const owner = readJobRecord(dataDir, cwd, existing.ownerJobId);
          if (!owner && Number.isInteger(existing.ownerPid) && recordedResumeOwnerProcessIsAlive(existing.ownerPid, existing.ownerPidIdentity)) throw resourceError(`${engineName} session ${sessionId} is already being resumed by running job ${existing.ownerJobId} in this workspace. Inspect it with /${engine}:status ${existing.ownerJobId}, then collect or cancel it before retrying.`);
          if (owner && (owner.id !== existing.ownerJobId || (owner.status !== "running" && !TERMINAL_STATUSES.has(owner.status)))) throw resourceError(`The resume session lease for ${sessionId} has an invalid owner record.`);
          if (!owner && !Number.isInteger(existing.ownerPid)) throw resourceError(`The resume session lease for ${sessionId} has an invalid owner record.`);
          if (owner?.status === "running") {
            const repaired = repairDeadResumeOwner(jobFilePath(dataDir, cwd, existing.ownerJobId), sessionId);
            if (repaired.status === "running") throw resourceError(`${engineName} session ${sessionId} is already being resumed by running job ${existing.ownerJobId} in this workspace. Inspect it with /${engine}:status ${existing.ownerJobId}, then collect or cancel it before retrying.`);
            repairedOwner = repaired;
          }
        }
        const nextOwner = readJobRecord(dataDir, cwd, ownerJobId);
        if ((!preflight || nextOwner) && (!nextOwner || nextOwner.id !== ownerJobId || nextOwner.status !== "running")) throw resourceError(`${engineName} session ${sessionId} cannot be leased to invalid job ${ownerJobId}.`);
        const next = {
          version: 1,
          sessionId,
          ownerJobId,
          ...(preflight ? { ownerPid: process.pid, ownerPidIdentity: getProcessIdentity(process.pid) } : {}),
          claimedAt: nowIso()
        };
        return storeRecord(file, next);
      });
    } finally {
      if (repairedOwner) maintainTerminalRecord(jobFilePath(dataDir, cwd, repairedOwner.id), repairedOwner);
    }
  }

  function withRecordUpdate(file, update) {
    let becameTerminal = false;
    const record = withRecordLock(file, () => {
      const existing = readJobRecordFile(file, true);
      const wasActive = existing && !TERMINAL_STATUSES.has(existing.status);
      const next = update(existing);
      becameTerminal = wasActive && TERMINAL_STATUSES.has(next?.status);
      return next;
    });
    if (becameTerminal) maintainTerminalRecord(file, record);
    return record;
  }

  function requireRecord(file) {
    const record = readJobRecordFile(file, true);
    if (!record) throw new Error(`No job record found at ${file}.`);
    return record;
  }

  function updateJobRecordFile(file, patch) {
    return withRecordUpdate(file, (existing) => {
      if (!existing) throw new Error(`No job record found at ${file}.`);
      if (TERMINAL_STATUSES.has(existing.status) && !Object.hasOwn(patch, "status")) return existing;
      return storeRecord(file, preserveTerminalRecord(existing, { ...existing, ...patch }));
    });
  }

  function launchRunningJobProcess(file, launch, options = {}) {
    return withRecordLock(file, () => {
      const processRole = options.processRole === "worker" ? "worker" : engine;
      const processLabel = processRole === "worker" ? "Background worker" : `${engineName} process`;
      const existing = readJobRecordFile(file, true);
      if (!existing) throw new Error(`No job record found at ${file}.`);
      if (existing.status !== "running" || existing.cancelRequestedAt != null || existing.cleanupRequired) {
        const cancelled = existing.status === "cancelled" || existing.cancelRequestedAt != null;
        const reason = cancelled
          ? "cancellation was already requested"
          : existing.cleanupRequired
            ? "process cleanup is still required"
            : `the job is already ${existing.status}`;
        const error = new Error(`${processLabel} launch for job ${existing.id} was blocked because ${reason}.`);
        error.failureKind = cancelled ? "cancelled" : existing.failureKind ?? "resource";
        error.launchPrevented = true;
        error.processRole = processRole;
        if (existing.cleanupRequired) {
          error.cleanupRequired = true;
          error.pid = processRole === "worker" ? existing.pid ?? null : existing[enginePidField] ?? null;
          error.pidIdentity = processRole === "worker" ? existing.pidIdentity ?? null : existing[engineIdentityField] ?? null;
        }
        throw error;
      }

      const launched = launch();
      const pid = launched?.pid ?? launched?.child?.pid;
      if (!Number.isInteger(pid) || pid <= 1) {
        const error = resourceError(`${processLabel} launch for job ${existing.id} did not produce a valid PID.`);
        error.processRole = processRole;
        throw error;
      }
      const pidField = processRole === "worker" ? "pid" : enginePidField;
      const identityField = processRole === "worker" ? "pidIdentity" : engineIdentityField;
      const next = {
        ...existing,
        [pidField]: pid,
        [identityField]: launched?.identity ?? null
      };
      atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
      return { ...launched, record: next };
    });
  }

  function updateJobRecordFileWithCurrent(file, updater, options = {}) {
    return withRecordUpdate(file, (existing) => {
      if (!existing) throw new Error(`No job record found at ${file}.`);
      const terminal = TERMINAL_STATUSES.has(existing.status);
      if (terminal && !options.allowTerminal) return withStructuredStatuses(existing);
      const updated = updater(existing);
      if (!updated || updated === existing) return existing;
      const next = terminal && options.allowTerminal
        ? withStructuredStatuses({ ...existing, ...updated, status: existing.status })
        : preserveTerminalRecord(existing, updated);
      return next === existing ? existing : storeRecord(file, next);
    });
  }

  function finishSuccessfulJobRecordFile(file, successPatch) {
    return withRecordUpdate(file, (existing) => {
      if (!existing) throw new Error(`No job record found at ${file}.`);
      if (TERMINAL_STATUSES.has(existing.status)) return existing;
      const treatAsCancelled =
        existing.status === "cancelled" || existing.cancelRequestedAt != null;
      const { terminalAttribution = {}, ...success } = successPatch;
      const patch = treatAsCancelled
        ? {
            status: "cancelled",
            pid: null,
            [enginePidField]: null,
            finishedAt: success.finishedAt ?? nowIso(),
            exitCode: success.exitCode ?? null,
            sessionId: success.sessionId ?? null,
            requestId: success.requestId ?? existing.requestId ?? null,
            resolvedModel: terminalAttribution.resolvedModel ?? success.resolvedModel ?? existing.resolvedModel ?? null,
            observedModel: terminalAttribution.observedModel ?? success.observedModel ?? existing.observedModel ?? null,
            modelDrift: success.modelDrift ?? existing.modelDrift ?? null,
            effortApplied: terminalAttribution.effortApplied ?? success.effortApplied ?? existing.effortApplied ?? null,
            resultText: success.resultText ?? null,
            usage: success.usage ?? existing.usage ?? null,
            usageIsIncomplete: success.usageIsIncomplete ?? existing.usageIsIncomplete ?? null,
            ...cancelledRecordFields(existing, success, terminalAttribution),
            warnings: success.warnings ?? existing.warnings ?? [],
            errorTail: null,
            failureKind: "cancelled",
            cancelRequestedAt: null
          }
        : { ...success, cancelRequestedAt: null };
      const next = preserveTerminalRecord(existing, { ...existing, ...patch });
      return storeRecord(file, next);
    });
  }

  function recordsInDirectory(dir) {
    try {
      const stats = fs.lstatSync(dir);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return [];
    } catch { return []; }
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return [];
      const file = path.join(dir, entry.name);
      const record = readJobRecordFile(file);
      return record?.id === entry.name.slice(0, -5) ? [{ record, file }] : [];
    });
  }

  function listJobRecords(dataDir, cwd) {
    return recordsInDirectory(jobsDir(dataDir, cwd)).map(({ record }) => record).sort(compareRecords);
  }

  function stateWorkspaces(dataDir) {
    const root = path.join(dataDir, "state");
    try {
      const stats = fs.lstatSync(root);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return [];
    } catch { return []; }
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .map((entry) => ({ workspace: entry.name, workspaceDir: path.join(root, entry.name) }));
  }

  function listAllJobRecords(dataDir) {
    return stateWorkspaces(dataDir).flatMap(({ workspaceDir }) => recordsInDirectory(path.join(workspaceDir, "jobs")))
      .sort((left, right) => compareRecords(left.record, right.record) || left.file.localeCompare(right.file));
  }

  function regularFileDescriptor(file) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return { file, kind: "missing", size: 0 };
    return stat.isFile()
      ? { dev: stat.dev, file, ino: stat.ino, kind: "regular", mtimeMs: stat.mtimeMs, size: stat.size }
      : { file, kind: "unsafe" };
  }

  function readManagedJobEntry(workspace, workspaceDir, file, id, locked = false) {
    let descriptor = regularFileDescriptor(file);
    if (descriptor.kind !== "regular" || descriptor.size > JOB_RECORD_SCAN_MAX_BYTES) return null;
    const record = readJobRecordFile(file, locked);
    if (!record || record.schemaVersion !== 1 || record.engine !== engine || record.id !== id) return null;
    descriptor = regularFileDescriptor(file);
    if (descriptor.kind !== "regular" || descriptor.size > JOB_RECORD_SCAN_MAX_BYTES ||
        record.request !== null && (typeof record.request !== "object" || Array.isArray(record.request))) return null;
    const resumeSourceJobId = record.request?.resumeSourceJobId ?? null;
    const timestamp = Date.parse(record.finishedAt ?? record.updatedAt ?? record.createdAt ?? "");
    if (resumeSourceJobId !== null && (typeof resumeSourceJobId !== "string" || !JOB_ID_PATTERN.test(resumeSourceJobId)) ||
        record.collectedAt != null && (typeof record.collectedAt !== "string" || !Number.isFinite(Date.parse(record.collectedAt))) ||
        !Number.isFinite(Date.parse(record.createdAt ?? "")) || !Number.isFinite(timestamp)) return null;
    const files = [{ ...descriptor, tier: "light" }];
    for (const artifact of history.artifacts(workspaceDir, id)) {
      const configured = artifact.field ? record[artifact.field] : undefined;
      if (configured != null && (typeof configured !== "string" || path.resolve(configured) !== artifact.file)) return null;
      const artifactDescriptor = regularFileDescriptor(artifact.file);
      if (artifactDescriptor.kind === "unsafe" || artifact.field && configured == null && artifactDescriptor.kind !== "missing") return null;
      if (artifactDescriptor.kind === "regular") files.push({ ...artifactDescriptor, tier: artifact.field === "briefFile" ? "light" : "heavy" });
    }
    return {
      bytes: files.reduce((sum, item) => sum + item.size, 0),
      artifactBytes: files.filter((item) => item.tier === "heavy").reduce((sum, item) => sum + item.size, 0),
      createdAt: record.createdAt, file, files, id, key: `${workspace}\0${id}`, record, resumeSourceJobId, timestamp, workspace
    };
  }

  function scanManagedJobState(dataDir) {
    const entries = [];
    const workspaceDirs = [];
    let unrecognizedRecords = 0;
    for (const { workspace, workspaceDir } of stateWorkspaces(dataDir)) {
      if (WORKSPACE_SLUG_PATTERN.test(workspace)) workspaceDirs.push(workspaceDir);
      const jobs = path.join(workspaceDir, "jobs");
      let names;
      try { names = fs.readdirSync(jobs, { withFileTypes: true }); } catch { continue; }
      for (const entry of names) {
        if (!entry.name.endsWith(".json")) continue;
        const id = entry.name.slice(0, -5);
        const managed = entry.isFile() && JOB_ID_PATTERN.test(id) ? readManagedJobEntry(workspace, workspaceDir, path.join(jobs, entry.name), id) : null;
        if (managed) entries.push(managed);
        else unrecognizedRecords += 1;
      }
    }
    return { entries, unrecognizedRecords, workspaceDirs };
  }

  function unlinkManagedDescriptor(descriptor) {
    try {
      const current = fs.lstatSync(descriptor.file);
      if (!current.isFile() || current.dev !== descriptor.dev || current.ino !== descriptor.ino) return false;
      fs.unlinkSync(descriptor.file);
      return true;
    } catch (error) { return error?.code === "ENOENT"; }
  }

  function removeEmptyManagedDirectory(dir) {
    try {
      if (!fs.lstatSync(dir).isDirectory()) return false;
      fs.rmdirSync(dir);
      return true;
    } catch { return false; }
  }

  function removeEmptyManagedWorkspace(workspaceDir) {
    for (const dir of [path.join(workspaceDir, "briefs"), path.join(workspaceDir, "jobs"), workspaceDir]) removeEmptyManagedDirectory(dir);
  }

  function refreshHistoryProtection(entry, current, protection) {
    const jobs = path.dirname(entry.file);
    const seen = new Set();
    let changed = false;
    for (const name of fs.readdirSync(jobs)) {
      const id = name.slice(0, -5);
      if (!name.endsWith(".json") || !JOB_ID_PATTERN.test(id)) continue;
      const file = path.join(jobs, name);
      seen.add(file);
      const descriptor = regularFileDescriptor(file);
      const previous = protection.descriptors.get(file);
      if (["kind", "dev", "ino", "size", "mtimeMs"].every((key) => descriptor[key] === previous?.[key])) continue;
      changed = true;
      protection.descriptors.set(file, descriptor);
      const refreshed = file === entry.file ? current : readManagedJobEntry(entry.workspace, path.dirname(jobs), file, id);
      if (refreshed) protection.entries.set(file, refreshed);
      else protection.entries.delete(file);
    }
    for (const [file, known] of protection.entries) {
      if (known.workspace !== entry.workspace || seen.has(file)) continue;
      changed = true;
      protection.entries.delete(file);
      protection.descriptors.delete(file);
    }
    if (changed) protection.currentKeys = history.protect([...protection.entries.values()], protection.claudeSessionId, protection.protectedJobFiles, protection.resumeWorkspaceJobFiles);
  }

  function deleteManagedJobEntry(entry, tier, protection) {
    return withRecordLock(entry.file, () => {
      const workspaceDir = path.dirname(path.dirname(entry.file));
      const current = readManagedJobEntry(entry.workspace, workspaceDir, entry.file, entry.id, true);
      if (!current || !TERMINAL_STATUSES.has(current.record.status) || current.record.background && !current.record.collectedAt) return null;
      refreshHistoryProtection(entry, current, protection);
      if (protection.snapshotKeys.has(current.key) || protection.currentKeys.has(current.key) ||
          (tier === "heavy" ? current.record.artifactsPruned : current.record.updatedAt !== entry.record.updatedAt)) return null;
      const files = current.files.filter((item) => tier === "light" || item.tier === "heavy");
      for (const file of files.filter((item) => item.file !== entry.file)) if (!unlinkManagedDescriptor(file)) return null;
      if (tier === "heavy") return { bytes: current.artifactBytes, record: storeRecord(entry.file, { ...current.record, artifactsPruned: true }) };
      const descriptor = files.find((item) => item.file === entry.file);
      if (!descriptor || !unlinkManagedDescriptor(descriptor)) return null;
      removeEmptyManagedWorkspace(workspaceDir);
      removeEmptyManagedDirectory(path.dirname(workspaceDir));
      return { bytes: current.bytes, record: null };
    });
  }

  const artifactSuffixes = [".events.jsonl", ".stdout.log", ".stderr.log", ".partial.txt", ".partial-result.txt", ".log"];

  function artifactJobId(name) {
    const suffix = artifactSuffixes.find((suffix) => name.endsWith(suffix));
    const id = suffix ? name.slice(0, -suffix.length) : null;
    return id && JOB_ID_PATTERN.test(id) ? id : null;
  }

  function sweepOrphanJobs(workspaceDirs, now) {
    let removed = 0;
    for (const workspaceDir of workspaceDirs) {
      const jobs = path.join(workspaceDir, "jobs");
      let names;
      try { names = fs.readdirSync(jobs); } catch { continue; }
      const quarantined = new Set(names.filter((name) => name.includes(".json.corrupt.")).map((name) => name.split(".json.corrupt.")[0]));
      for (const name of names) {
        const temporary = name.endsWith(".tmp");
        const match = temporary ? /^(.+?)(?:\.json|\.events\.jsonl|\.stdout\.log|\.stderr\.log|\.partial\.txt|\.partial-result\.txt|\.log)(?:\..+)?\.tmp$/.exec(name) : null;
        const id = temporary ? match?.[1] ?? name.slice(0, -4) : artifactJobId(name);
        if (!id || !JOB_ID_PATTERN.test(id)) continue;
        const file = path.join(jobs, name);
        const recordFile = path.join(jobs, `${id}.json`);
        const eligible = () => {
          const descriptor = regularFileDescriptor(file);
          return descriptor.kind === "regular" && now - descriptor.mtimeMs >= (temporary ? TEMP_AGE_MS : ORPHAN_AGE_MS) &&
            (temporary || !fs.existsSync(recordFile) && !quarantined.has(id)) ? descriptor : null;
        };
        if (!eligible()) continue;
        withRecordLock(recordFile, () => {
          const descriptor = eligible();
          if (descriptor && unlinkManagedDescriptor(descriptor)) removed += 1;
        });
      }
    }
    return removed;
  }

  function readGcStamp(file) {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      return value && typeof value === "object" ? value : null;
    } catch { return null; }
  }

  function recentSweepCanSkip(dataDir, stamp, limits, now) {
    if (!stamp || now - stamp.at >= GC_INTERVAL_MS || now < stamp.at || Object.keys(limits).some((key) => stamp[key] !== limits[key])) return false;
    const known = new Set(stamp.recordFiles ?? []);
    let newRecords = 0;
    let artifactBytes = 0;
    for (const { workspace, workspaceDir } of stateWorkspaces(dataDir)) {
      if (!WORKSPACE_SLUG_PATTERN.test(workspace)) continue;
      const jobs = path.join(workspaceDir, "jobs");
      let names;
      try { names = fs.readdirSync(jobs); } catch { continue; }
      for (const name of names) {
        const file = path.join(jobs, name);
        if (name.endsWith(".json") && !known.has(file)) newRecords += 1;
        if (artifactJobId(name)) {
          const descriptor = regularFileDescriptor(file);
          if (descriptor.kind === "regular") artifactBytes += descriptor.size;
        }
      }
    }
    return stamp.afterRecords + newRecords <= limits.maxRecords * 1.1 && artifactBytes <= limits.maxBytes * 1.1 &&
      stamp.afterLightRecords + newRecords <= limits.recordMaxRecords * 1.1;
  }

  function pruneJobState(dataDir, options = {}) {
    const defaults = history.resolveLimits(options.env ?? process.env);
    const limits = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, retentionLimit(options[key], fallback)]));
    const { maxBytes, maxRecords, recordMaxRecords, recordRetentionDays } = limits;
    try {
      return withRecordLock(path.join(path.resolve(dataDir), "locks", "history-gc"), () => {
        const stampFile = path.join(path.resolve(dataDir), "history-gc-stamp.json");
        const now = Date.now();
        const stamp = readGcStamp(stampFile);
        if (recentSweepCanSkip(dataDir, stamp, limits, now)) {
          const { recordFiles, ...previous } = stamp;
          return { ...previous, deletedBytes: 0, deletedRecords: 0, deletedOrphans: 0, prunedArtifacts: 0, ok: true, skipped: true, errorMessage: null };
        }
        const { entries, unrecognizedRecords, workspaceDirs } = scanManagedJobState(dataDir);
        const protectedKeys = history.protect(entries, options.claudeSessionId, options.protectedJobFiles, options.resumeWorkspaceJobFiles);
        const protection = {
          entries: new Map(entries.map((entry) => [entry.file, entry])),
          descriptors: new Map(entries.map((entry) => [entry.file, entry.files.find((item) => item.file === entry.file)])),
          snapshotKeys: protectedKeys, currentKeys: protectedKeys,
          claudeSessionId: options.claudeSessionId, protectedJobFiles: options.protectedJobFiles, resumeWorkspaceJobFiles: options.resumeWorkspaceJobFiles
        };
        let afterBytes = entries.reduce((sum, entry) => sum + entry.artifactBytes, 0);
        let afterRecords = entries.filter((entry) => !entry.record.artifactsPruned).length;
        let afterLightRecords = entries.length;
        let deletedBytes = 0;
        let deletedRecords = 0;
        let prunedArtifacts = 0;
        const prunedKeys = new Set();
        const candidates = entries.filter((entry) => TERMINAL_STATUSES.has(entry.record.status) && !protectedKeys.has(entry.key))
          .sort((left, right) => left.timestamp - right.timestamp || left.file.localeCompare(right.file));
        for (const entry of candidates) {
          if (afterRecords <= maxRecords && afterBytes <= maxBytes) break;
          if (entry.record.artifactsPruned) continue;
          const removed = deleteManagedJobEntry(entry, "heavy", protection);
          if (!removed) continue;
          afterRecords -= 1;
          afterBytes = Math.max(0, afterBytes - removed.bytes);
          deletedBytes += removed.bytes;
          prunedArtifacts += 1;
          prunedKeys.add(entry.key);
        }
        const cutoff = now - recordRetentionDays * 24 * 60 * 60 * 1000;
        for (const entry of candidates) {
          if (afterLightRecords <= recordMaxRecords && (recordRetentionDays === 0 || entry.timestamp >= cutoff)) break;
          const removed = deleteManagedJobEntry(entry, "light", protection);
          if (!removed) continue;
          afterLightRecords -= 1;
          deletedRecords += 1;
          deletedBytes += removed.bytes;
          if (!entry.record.artifactsPruned && !prunedKeys.has(entry.key)) {
            afterRecords -= 1;
            afterBytes = Math.max(0, afterBytes - entry.artifactBytes);
          }
        }
        const deletedOrphans = sweepOrphanJobs(workspaceDirs, now);
        for (const workspaceDir of workspaceDirs) removeEmptyManagedWorkspace(workspaceDir);
        removeEmptyManagedDirectory(path.join(path.resolve(dataDir), "state"));
        const result = {
          at: now, afterBytes, afterRecords, afterLightRecords, deletedBytes, deletedRecords, deletedOrphans, prunedArtifacts,
          errorMessage: null, ...limits, ok: true, quotaSatisfied: afterRecords <= maxRecords && afterBytes <= maxBytes && afterLightRecords <= recordMaxRecords,
          unrecognizedRecords, recordFiles: entries.map((entry) => entry.file)
        };
        atomicWriteFile(stampFile, `${JSON.stringify(result)}\n`);
        return { ...result, recordFiles: undefined };
      }, 0);
    } catch (error) {
      return { afterBytes: null, afterRecords: null, deletedBytes: 0, deletedRecords: 0, ...limits, ok: false, quotaSatisfied: false, unrecognizedRecords: null, errorMessage: error instanceof Error ? error.message : String(error) };
    }
  }

  function findJobRecordById(dataDir, jobId) {
    const matches = listAllJobRecords(dataDir).filter((entry) => entry.record.id === jobId);
    if (matches.length > 1) throw resourceError(`Job id ${jobId} exists in multiple workspaces. Repeat the command with --cwd.`);
    return matches[0] ?? null;
  }

  function writeBrief(dataDir, cwd, name, content) {
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
      if (error?.code === "EEXIST") throw resourceError(`Brief already exists at ${file}.`);
      throw error;
    }
    return file;
  }

  function writePrivateDataFile(dataDir, name, content) {
    ensurePrivateDir(dataDir);
    const file = path.join(dataDir, name);
    atomicWriteFile(file, String(content ?? ""));
    return file;
  }

  function appendJobLog(logFile, text, { maxBytes = JOB_LOG_MAX_BYTES, trimIncompleteLine = false } = {}) {
    if (!logFile) {
      return;
    }
    ensurePrivateStatePath(path.dirname(logFile));
    const raw = String(text ?? "");
    if (trimIncompleteLine && !raw) return;
    const value = raw.endsWith("\n") ? raw : `${raw}\n`;
    fs.appendFileSync(logFile, trimIncompleteLine ? value : value.slice(-maxBytes), { encoding: "utf8", mode: PRIVATE_FILE_MODE });
    fs.chmodSync(logFile, PRIVATE_FILE_MODE);
    const size = fs.statSync(logFile).size;
    if (size > maxBytes) {
      const fd = fs.openSync(logFile, "r");
      try {
        const keep = Buffer.alloc(maxBytes);
        fs.readSync(fd, keep, 0, maxBytes, size - maxBytes);
        const retained = keep.toString("utf8");
        const firstLineEnd = trimIncompleteLine ? retained.indexOf("\n") : -1;
        atomicWriteFile(logFile, firstLineEnd === -1 ? retained : retained.slice(firstLineEnd + 1));
      } finally {
        fs.closeSync(fd);
      }
    }
  }

  function readLogTail(logFile, maxLines = 20) {
    if (!logFile || !fs.existsSync(logFile)) return "";
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
    if (!content) return "";
    return content.split(/\r?\n/).slice(-maxLines).join("\n");
  }

  return {
    SESSION_ID_ENV, DEFAULT_LOCK_TIMEOUT_MS, resolveLockTimeoutMs, resolveDataDir,
    workspaceSlug, workspaceStateDir, jobsDir, briefsDir, jobFilePath, jobLogPath, briefPath, resumeSessionLeasePath,
    generateJobId, nowIso, createJobRecord, ensurePrivateDataDir, writePrivateStateFile, hardenPrivateStateFile,
    createJobRecordFile, writeJobRecordFile, markManagedDeliveryCollectedFile, markDeliveryCollectedFile, readJobRecordFile,
    claimResumeSessionLease, updateJobRecordFile, launchRunningJobProcess, updateJobRecordFileWithCurrent,
    finishSuccessfulJobRecordFile, listJobRecords, listAllJobRecords, pruneJobRecords, pruneJobState, resumeOwnerMayStillRun,
    findJobRecordById, writeBrief, writePrivateDataFile, appendJobLog, readLogTail
  };
}
