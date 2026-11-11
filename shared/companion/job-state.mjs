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

const JOB_LOG_MAX_BYTES = 1024 * 1024;
const LOG_TAIL_MAX_BYTES = 64 * 1024;
const RESUME_OWNER_LAUNCH_GRACE_MS = 15000;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);

const SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";
const DEFAULT_LOCK_TIMEOUT_MS = 5000;

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
  maintainTerminalRecord
}) {
  const versionField = `${engine}Version`;
  const buildPathField = `${engine}BuildPath`;
  const engineIdentityField = `${enginePidField}Identity`;

  function resolveLockTimeoutMs(env = process.env) {
    const raw = env[lockTimeoutEnv];
    if (raw === undefined || raw === null || (typeof raw === "string" && !String(raw).trim())) {
      return DEFAULT_LOCK_TIMEOUT_MS;
    }
    const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LOCK_TIMEOUT_MS;
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
    const absolute = path.resolve(cwd);
    const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 16);
    return `${path.basename(absolute)}-${hash}`;
  }

  function workspaceStateDir(dataDir, cwd) {
    return path.join(dataDir, "state", workspaceSlug(cwd));
  }

  function jobsDir(dataDir, cwd) {
    return path.join(workspaceStateDir(dataDir, cwd), "jobs");
  }

  function briefsDir(dataDir, cwd) {
    return path.join(workspaceStateDir(dataDir, cwd), "briefs");
  }

  function jobFilePath(dataDir, cwd, jobId) {
    return path.join(jobsDir(dataDir, cwd), `${jobId}.json`);
  }

  function jobLogPath(dataDir, cwd, jobId) {
    return path.join(jobsDir(dataDir, cwd), `${jobId}.log`);
  }

  function briefPath(dataDir, cwd, name) {
    return path.join(briefsDir(dataDir, cwd), `${name}.md`);
  }

  function resumeSessionLeasePath(dataDir, cwd, sessionId) {
    const hash = createHash("sha256").update(String(sessionId)).digest("hex");
    return path.join(workspaceStateDir(dataDir, cwd), "session-leases", `${hash}.json`);
  }

  function generateJobId() {
    return randomBytes(16).toString("hex");
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function createJobRecord(fields) {
    const pid = Number.isInteger(fields.pid) && fields.pid > 1 ? fields.pid : null;
    return withStructuredStatuses({
      schemaVersion: 1,
      engine,
      companionVersion: fields.companionVersion ?? null,
      [versionField]: typeof fields[versionField] === "string" && fields[versionField].trim() ? fields[versionField].trim() : null,
      [buildPathField]: fields[buildPathField] ?? null,
      id: fields.id,
      pid,
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
      claudeSessionId: fields.claudeSessionId ?? null,
      createdAt: fields.createdAt ?? nowIso(),
      finishedAt: null,
      exitCode: null,
      sessionId: fields.sessionId ?? null,
      requestId: fields.requestId ?? null,
      resultText: null,
      resultPayload: null,
      requestedModel: fields.requestedModel ?? null,
      resolvedModel: fields.resolvedModel ?? null,
      observedModel: fields.observedModel ?? null,
      modelDrift: fields.modelDrift ?? null,
      requestedEffort: fields.requestedEffort ?? null,
      effortApplied: fields.effortApplied ?? null,
      billingPool: fields.billingPool ?? null,
      role: fields.role ?? null,
      usage: fields.usage ?? null,
      usageIsIncomplete: fields.usageIsIncomplete ?? null,
      ...recordFields(fields),
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

  function writePrivateStateFile(file, content) {
    atomicWriteFile(file, String(content ?? ""));
    return file;
  }

  function hardenPrivateStateFile(file) {
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
    return {
      ...record,
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
      [enginePidField]: null,
      [engineIdentityField]: null,
      cleanupRequired: false
    });
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
        if (fs.existsSync(file)) {
          throw resourceError(`Job record already exists at ${file}.`);
        }
        atomicWriteFile(file, `${JSON.stringify(record, null, 2)}\n`);
        return file;
      })
    );
  }

  function writeJobRecordFile(file, record) {
    withRecordLock(file, () => {
      const existing = readJobRecordFile(file);
      const next = preserveTerminalRecord(existing, record);
      atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
      maintainTerminalRecord(file, next);
    });
    return file;
  }

  function markManagedDeliveryCollectedFile(file, collectedAt = nowIso()) {
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

  function markDeliveryCollectedFile(file, collectedAt = nowIso()) {
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

  function readJobRecordFile(file) {
    if (!fs.existsSync(file)) {
      return null;
    }
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      return path.basename(path.dirname(file)) === "jobs" && !currentJobRecord(record) ? null : record;
    } catch {
      return null;
    }
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
          if (!stats?.isFile() || stats.isSymbolicLink() ||
              !expired(JSON.parse(fs.readFileSync(file, "utf8")), stats, id)) continue;
          withRecordLock(file, () => {
            const stats = fs.lstatSync(file, { throwIfNoEntry: false });
            const record = JSON.parse(fs.readFileSync(file, "utf8"));
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
      [record[enginePidField], record[engineIdentityField]]
    ].filter(([pid]) => Number.isInteger(pid) && pid > 1);
    if (processes.some(([pid, identity]) => recordedResumeOwnerProcessIsAlive(pid, identity))) {
      return true;
    }
    if (processes.length > 0) {
      return false;
    }
    const createdAt = Date.parse(record.createdAt);
    return Number.isFinite(createdAt) && now - createdAt < RESUME_OWNER_LAUNCH_GRACE_MS;
  }

  function repairDeadResumeOwner(file, sessionId) {
    return updateJobRecordFileWithCurrent(file, (current) => {
      if (current.status !== "running" || resumeOwnerMayStillRun(current)) {
        return current;
      }
      const message = `The process that owned ${engineName} session ${sessionId} exited without recording a terminal outcome.`;
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

  function claimResumeSessionLease(dataDir, cwd, sessionId, ownerJobId, { preflight = false } = {}) {
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
        if (!owner && Number.isInteger(existing.ownerPid) && recordedResumeOwnerProcessIsAlive(existing.ownerPid, existing.ownerPidIdentity)) {
          throw resourceError(`${engineName} session ${sessionId} is already being resumed by running job ${existing.ownerJobId} in this workspace. Inspect it with /${engine}:status ${existing.ownerJobId}, then collect or cancel it before retrying.`);
        }
        if (owner && (owner.id !== existing.ownerJobId || (owner.status !== "running" && !TERMINAL_STATUSES.has(owner.status)))) {
          throw resourceError(`The resume session lease for ${sessionId} has an invalid owner record.`);
        }
        if (!owner && !Number.isInteger(existing.ownerPid)) {
          throw resourceError(`The resume session lease for ${sessionId} has an invalid owner record.`);
        }
        if (owner?.status === "running") {
          const repaired = repairDeadResumeOwner(jobFilePath(dataDir, cwd, existing.ownerJobId), sessionId);
          if (repaired.status === "running") {
            throw resourceError(`${engineName} session ${sessionId} is already being resumed by running job ${existing.ownerJobId} in this workspace. Inspect it with /${engine}:status ${existing.ownerJobId}, then collect or cancel it before retrying.`);
          }
        }
      }
      const nextOwner = readJobRecord(dataDir, cwd, ownerJobId);
      if ((!preflight || nextOwner) && (!nextOwner || nextOwner.id !== ownerJobId || nextOwner.status !== "running")) {
        throw resourceError(`${engineName} session ${sessionId} cannot be leased to invalid job ${ownerJobId}.`);
      }
      const next = {
        version: 1,
        sessionId,
        ownerJobId,
        ...(preflight ? { ownerPid: process.pid, ownerPidIdentity: getProcessIdentity(process.pid) } : {}),
        claimedAt: nowIso()
      };
      atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  }

  function updateJobRecordFile(file, patch) {
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
      if (!TERMINAL_STATUSES.has(existing.status)) maintainTerminalRecord(file, next);
      return next;
    });
  }

  function launchRunningJobProcess(file, launch, options = {}) {
    return withRecordLock(file, () => {
      const processRole = options.processRole === "worker" ? "worker" : engine;
      const processLabel = processRole === "worker" ? "Background worker" : `${engineName} process`;
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
      const pid = launched?.child?.pid;
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
      if (!TERMINAL_STATUSES.has(existing.status)) maintainTerminalRecord(file, next);
      return next;
    });
  }

  function finishSuccessfulJobRecordFile(file, successPatch) {
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
      atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
      maintainTerminalRecord(file, next);
      return next;
    });
  }

  function listJobRecords(dataDir, cwd) {
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
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
    );
  }

  function listAllJobRecords(dataDir) {
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
        right.record.createdAt.localeCompare(left.record.createdAt) ||
        right.record.id.localeCompare(left.record.id) ||
        String(left.file).localeCompare(String(right.file))
    );
  }

  function findJobRecordById(dataDir, jobId) {
    const matches = listAllJobRecords(dataDir).filter((entry) => entry.record.id === jobId);
    if (matches.length > 1) {
      throw resourceError(`Job id ${jobId} exists in multiple workspaces. Repeat the command with --cwd.`);
    }
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
      if (error?.code === "EEXIST") {
        throw resourceError(`Brief already exists at ${file}.`);
      }
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

  function appendJobLog(logFile, text) {
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

  function readLogTail(logFile, maxLines = 20) {
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

  return {
    SESSION_ID_ENV,
    DEFAULT_LOCK_TIMEOUT_MS,
    resolveLockTimeoutMs,
    resolveDataDir,
    workspaceSlug,
    workspaceStateDir,
    jobsDir,
    briefsDir,
    jobFilePath,
    jobLogPath,
    briefPath,
    resumeSessionLeasePath,
    generateJobId,
    nowIso,
    createJobRecord,
    ensurePrivateDataDir,
    writePrivateStateFile,
    hardenPrivateStateFile,
    createJobRecordFile,
    writeJobRecordFile,
    markManagedDeliveryCollectedFile,
    markDeliveryCollectedFile,
    readJobRecordFile,
    claimResumeSessionLease,
    updateJobRecordFile,
    launchRunningJobProcess,
    updateJobRecordFileWithCurrent,
    finishSuccessfulJobRecordFile,
    listJobRecords,
    listAllJobRecords,
    pruneJobRecords,
    findJobRecordById,
    writeBrief,
    writePrivateDataFile,
    appendJobLog,
    readLogTail
  };
}
