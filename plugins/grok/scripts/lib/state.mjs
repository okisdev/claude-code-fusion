import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createJobState } from "./job-state.mjs";
import { withRecordLock } from "./record-lock.mjs";

export const PRIVATE_GROK_HOME = "home";

const LEASE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MONITOR_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);
const JOB_STATUSES = new Set([...TERMINAL_STATUSES, "running", "queued"]);

const jobState = createJobState({
  engine: "grok",
  engineName: "Grok",
  pidField: "grokPid",
  dataDirEnv: "GROK_COMPANION_DATA",
  lockTimeoutEnv: "GROK_COMPANION_LOCK_TIMEOUT_MS",
  dataDirName: "grok-claude-code-fusion",
  sweepMarker: ".grok-state-sweep.json",
  recordFields: () => ({
    sessionHome: PRIVATE_GROK_HOME,
    resolvedEffort: null,
    modelUsage: null,
    modelUsageIsIncomplete: null
  }),
  requiredRecordFields: [],
  cancelledRecordFields: (existing, success, terminalAttribution) => ({
    resolvedModel: terminalAttribution.resolvedModel ?? success.resolvedModel ?? existing.resolvedModel ?? existing.request?.model ?? null,
    resolvedEffort: terminalAttribution.resolvedEffort ?? success.resolvedEffort ?? existing.resolvedEffort ?? existing.request?.effort ?? null,
    numTurns: success.numTurns ?? existing.numTurns ?? null,
    totalCostUsd: success.totalCostUsd ?? existing.totalCostUsd ?? null,
    totalCostUsdTicks: success.totalCostUsdTicks ?? existing.totalCostUsdTicks ?? null,
    costIsPartial: success.costIsPartial ?? existing.costIsPartial ?? null,
    modelUsage: success.modelUsage ?? existing.modelUsage ?? null,
    modelUsageIsIncomplete: success.modelUsageIsIncomplete ?? existing.modelUsageIsIncomplete ?? null
  }),
  migrate: migrateJobRecord,
  validateRecord: validJobRecord,
  normalizeRecord: withStructuredStatuses,
  maintainTerminalRecord: (file) => maintainGrokState(path.resolve(path.dirname(file), "../../.."))
});

export const {
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
  findJobRecordById,
  writeBrief,
  writePrivateDataFile,
  appendJobLog,
  readLogTail
} = jobState;

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
  writePrivateStateFile(quotaCooldownPath(dataDir), `${JSON.stringify(value, null, 2)}\n`);
}

export function clearQuotaCooldown(dataDir) {
  try {
    fs.unlinkSync(quotaCooldownPath(dataDir));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function withStructuredStatuses(record) {
  const transportStatus = record.status;
  const semanticStatus = record.semanticStatus;
  const deliveryStatus = record.deliveryCollectedAt ? "collected"
    : record.delivery === "foreground" && TERMINAL_STATUSES.has(record.status) ? "delivered" : "pending";
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

function validJobRecord(record) {
  return Boolean(record && typeof record === "object" && !Array.isArray(record)
    && record.schemaVersion === 1 && record.engine === "grok"
    && typeof record.id === "string" && JOB_STATUSES.has(record.status)
    && JOB_RECORD_FIELDS.every((field) => Object.hasOwn(record, field)));
}

export function migrateJobRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || raw.engine != null && raw.engine !== "grok"
      || raw.schemaVersion != null && raw.schemaVersion !== 1 || !JOB_STATUSES.has(raw.status)) return raw;
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

export function ensurePrivateDataDir(dataDir) {
  jobState.ensurePrivateDataDir(dataDir);
  maintainGrokState(dataDir);
  return dataDir;
}

function maintainGrokState(dataDir) {
  try {
    sweepGrokState(dataDir);
  } catch {}
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
              if (owner?.id === lease.ownerJobId && jobState.resumeOwnerMayStillRun(owner, now)) return;
              if (!owner && jobState.resumeOwnerMayStillRun({ pid: lease.ownerPid, pidIdentity: lease.ownerPidIdentity }, now)) return;
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
    try { jobState.pruneJobRecords(dataDir, now); } catch {}
    writePrivateStateFile(stamp, `${JSON.stringify({ sweptAt: now })}\n`);
    return true;
  });
}
