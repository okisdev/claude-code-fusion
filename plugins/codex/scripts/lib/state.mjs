import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { getProcessIdentity, isProcessAlive, processIdentityMatches } from "./codex-exec.mjs";
import { observedEventLine } from "./codex-events.mjs";
import { withRecordLock } from "./record-lock.mjs";
import { createJobState } from "./job-state.mjs";

const JOB_SCHEMA_VERSION = 1;
const JOB_EVENTS_MAX_BYTES = 8 * 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const STATE_MAX_BYTES_ENV = "CODEX_COMPANION_HISTORY_MAX_BYTES";
const STATE_MAX_RECORDS_ENV = "CODEX_COMPANION_HISTORY_MAX_RECORDS";
const RECORD_MAX_RECORDS_ENV = "CODEX_COMPANION_RECORD_MAX_RECORDS";
const RECORD_RETENTION_DAYS_ENV = "CODEX_COMPANION_RECORD_RETENTION_DAYS";
const JOB_STATUSES = new Set(["running", "done", "error", "cancelled"]);
const DELIVERY_MODES = new Set(["foreground", "manual", "managed"]);
const SEMANTIC_STATUSES = new Set(["accepted", "rejected", "unverified"]);
const SEMANTIC_FAILURE_KINDS = new Set(["intent_override", "scope_rewrite", "wrong_approach", "style_mismatch", "oversized"]);
const ACCEPTANCE_SOURCES = new Set(["collector", "main-loop", "stats"]);
const JOB_REQUIRED_FIELDS = ["claudeSessionId", "delivery", "deliveryCollectedAt", "artifactsPruned",
  "acceptanceSource", "acceptanceRecordedAt", "fileChangeCount", "semanticStatus",
  "semanticFailureKind", "semanticFailureMessage", "serviceTier", "resolvedModel", "resolvedEffort",
  "timeoutMs", "companionVersion"];
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GIT_CACHE_TTL_MS = 3000;
const GIT_CACHE_MAX_ENTRIES = 128;
const gitValueCache = new Map();

export const DEFAULT_JOB_HISTORY_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_JOB_HISTORY_MAX_RECORDS = 256;
export const DEFAULT_JOB_RECORD_MAX_RECORDS = 5000;
export const DEFAULT_JOB_RECORD_RETENTION_DAYS = 90;
export const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);

const jobState = createJobState({
  engine: "codex",
  engineName: "Codex",
  pidField: "codexPid",
  dataDirEnv: "CODEX_COMPANION_DATA",
  lockTimeoutEnv: "CODEX_COMPANION_LOCK_TIMEOUT_MS",
  dataDirName: "codex-claude-code-fusion",
  resolveWorkspace: canonicalWorkspaceRoot,
  validateIdentifier,
  compareRecords: (left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")),
  recordFields: codexRecordFields,
  history: { resolveLimits: resolveJobHistoryLimits, artifacts: expectedManagedArtifacts, protect: protectedManagedJobs },
  migrate: migrateJobRecord,
  validateRecord(record) {
    assertJobRecord(record);
    return true;
  },
  normalizeRecord(record) {
    const { sessionId, modelDrift, codexBuildPath, requestId, requestedModel, observedModel, requestedEffort,
      effortApplied, billingPool, role, usage, cleanupRequired, deliveryStatus, resultPayload, warnings, transportStatus, ...next } = record;
    return modelDrift ? { ...next, modelDrift } : next;
  },
  recordLock: {
    reaperClaimPath(lockDir, token, predecessorToken) {
      return `${lockDir}.owner.${token}.reap${predecessorToken ? `-successor-${predecessorToken}` : ""}`;
    },
    onReleaseError(error) { throw error; }
  },
  onCorruptRecord: quarantineCorruptRecord,
  onReadError(error) {
    if (error?.code !== "ENOENT") throw error;
  }
});

export const {
  SESSION_ID_ENV, DEFAULT_LOCK_TIMEOUT_MS, resolveLockTimeoutMs, resolveDataDir,
  workspaceSlug, workspaceStateDir, jobsDir, briefsDir, jobFilePath, jobLogPath, briefPath,
  generateJobId, nowIso, readJobRecordFile, listJobRecords, listAllJobRecords, readLogTail, pruneJobState, writePrivateStateFile
} = jobState;

const atomicWriteFile = jobState.writePrivateStateFile;

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required.`);
  return path.resolve(value.trim());
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch { return resolved; }
}

function gitValue(cwd, args) {
  const key = `${cwd}\0${args.join("\0")}`;
  const cached = gitValueCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  gitValueCache.delete(key);
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.error || result.status !== 0) return null;
  const value = String(result.stdout ?? "").trim();
  if (value) {
    if (gitValueCache.size >= GIT_CACHE_MAX_ENTRIES) {
      gitValueCache.delete(gitValueCache.keys().next().value);
    }
    gitValueCache.set(key, { value, expiresAt: Date.now() + GIT_CACHE_TTL_MS });
  }
  return value || null;
}

function validateIdentifier(value, label) {
  if (typeof value !== "string" || !JOB_ID_PATTERN.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function quarantineCorruptRecord(file) {
  const quarantine = `${file}.corrupt.${Date.now()}.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(file, quarantine);
    fs.chmodSync(quarantine, PRIVATE_FILE_MODE);
    return quarantine;
  } catch { return null; }
}

function assertJobRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new TypeError("Job record must be an object.");
  validateIdentifier(record.id, "Job id");
  if (!JOB_STATUSES.has(record.status)) throw new TypeError("Job status is invalid.");
  if (record.delivery != null && !DELIVERY_MODES.has(record.delivery)) throw new TypeError("Job delivery mode is invalid.");
  if (record.semanticStatus != null && !SEMANTIC_STATUSES.has(record.semanticStatus)) throw new TypeError("Job semantic status is invalid.");
  if (record.semanticFailureKind != null && record.semanticFailureKind !== "policy" && !SEMANTIC_FAILURE_KINDS.has(record.semanticFailureKind)) throw new TypeError("Job semantic failure kind is invalid.");
  if (record.acceptanceSource != null && !ACCEPTANCE_SOURCES.has(record.acceptanceSource)) throw new TypeError("Job acceptance source is invalid.");
  if (record.acceptanceRecordedAt != null && (typeof record.acceptanceRecordedAt !== "string" || !Number.isFinite(Date.parse(record.acceptanceRecordedAt)))) throw new TypeError("Job acceptance recorded timestamp is invalid.");
  if (record.timeoutMs != null && (!Number.isSafeInteger(record.timeoutMs) || record.timeoutMs <= 0)) throw new TypeError("Job timeout is invalid.");
  if (record.companionVersion != null && (typeof record.companionVersion !== "string" || !record.companionVersion.trim())) throw new TypeError("Job companion version is invalid.");
  if (record.schemaVersion !== JOB_SCHEMA_VERSION || record.engine !== "codex"
    || Object.hasOwn(record, "appliedServiceTier") || Object.hasOwn(record, "sessionId")
    || JOB_REQUIRED_FIELDS.some((field) => !Object.hasOwn(record, field))) {
    throw new TypeError("Job record schema is invalid.");
  }
}

export function migrateJobRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.engine !== "codex"
      || (raw.schemaVersion != null && raw.schemaVersion !== JOB_SCHEMA_VERSION)) return raw;
  if (raw.schemaVersion === JOB_SCHEMA_VERSION && !Object.hasOwn(raw, "sessionId")
      && !Object.hasOwn(raw, "appliedServiceTier")
      && JOB_REQUIRED_FIELDS.every((field) => Object.hasOwn(raw, field))) return raw;
  const { appliedServiceTier, sessionId, ...record } = raw;
  return {
    ...record,
    claudeSessionId: raw.claudeSessionId ?? sessionId ?? null,
    delivery: raw.delivery ?? (raw.background ? "manual" : "foreground"),
    deliveryCollectedAt: raw.deliveryCollectedAt ?? null,
    acceptanceSource: raw.acceptanceSource ?? null,
    acceptanceRecordedAt: raw.acceptanceRecordedAt ?? null,
    fileChangeCount: raw.fileChangeCount ?? null,
    semanticStatus: raw.semanticStatus ?? "unverified",
    semanticFailureKind: raw.semanticFailureKind ?? null,
    semanticFailureMessage: raw.semanticFailureMessage ?? null,
    serviceTier: raw.serviceTier ?? raw.request?.serviceTier ?? null,
    resolvedModel: raw.resolvedModel ?? null,
    resolvedEffort: raw.resolvedEffort ?? null,
    timeoutMs: raw.timeoutMs ?? null,
    companionVersion: raw.companionVersion ?? null,
    schemaVersion: raw.schemaVersion ?? JOB_SCHEMA_VERSION,
    artifactsPruned: raw.artifactsPruned ?? false
  };
}

function ownerSessionId(record) {
  const value = record?.claudeSessionId ?? null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
  const sessionId = ownerSessionId({ claudeSessionId: Object.hasOwn(patch, "claudeSessionId") ? patch.claudeSessionId : existing.claudeSessionId });
  const next = {
    ...existing,
    ...effectivePatch,
    claudeSessionId: sessionId
  };
  assertJobRecord(next);
  return next;
}

export function canonicalWorkspaceRoot(cwd) {
  const resolved = requiredPath(cwd, "Working directory");
  const root = gitValue(resolved, ["rev-parse", "--show-toplevel"]);
  return canonicalPath(root ?? resolved);
}

export function repositoryIdentity(cwd) {
  const resolved = requiredPath(cwd, "Working directory");
  const commonDir = gitValue(resolved, ["rev-parse", "--git-common-dir"]);
  if (!commonDir) return canonicalWorkspaceRoot(resolved);
  return canonicalPath(path.isAbsolute(commonDir) ? commonDir : path.resolve(resolved, commonDir));
}

export function repositoryKey(cwd) {
  return createHash("sha256").update(repositoryIdentity(cwd)).digest("hex").slice(0, 16);
}

export function withWorkspaceLock(dataDir, cwd, callback) {
  if (typeof callback !== "function") throw new TypeError("Workspace lock callback must be a function.");
  return withRecordLock(path.join(workspaceStateDir(dataDir, cwd), ".launch"), () => {
    const result = callback();
    if (result && typeof result.then === "function") throw new TypeError("Workspace lock callback must be synchronous.");
    return result;
  });
}

export function withThreadLock(dataDir, threadId, callback) {
  if (typeof callback !== "function") throw new TypeError("Thread lock callback must be a function.");
  const id = validateIdentifier(threadId, "Thread id");
  const key = createHash("sha256").update(id).digest("hex");
  return withRecordLock(path.join(path.resolve(dataDir), "locks", "threads", key), () => {
    const result = callback();
    if (result && typeof result.then === "function") throw new TypeError("Thread lock callback must be synchronous.");
    return result;
  });
}

export function jobEventsPath(dataDir, cwd, jobId) {
  return path.join(jobsDir(dataDir, cwd), `${validateIdentifier(jobId, "Job id")}.events.jsonl`);
}

export function createJobRecord(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new TypeError("Job fields must be an object.");
  const record = jobState.createJobRecord({
    ...fields,
    id: validateIdentifier(fields.id, "Job id"),
    cwd: requiredPath(fields.cwd, "Working directory"),
    pidIdentity: fields.pidIdentity ?? null
  });
  assertJobRecord(record);
  return record;
}

function codexRecordFields(fields) {
  const workspaceRoot = canonicalWorkspaceRoot(fields.workspaceRoot ?? fields.cwd);
  const identity = fields.repositoryIdentity ?? repositoryIdentity(workspaceRoot);
  const status = fields.status ?? "running";
  const createdAt = fields.createdAt ?? nowIso();
  return {
    createdAt,
    phase: TERMINAL_STATUSES.has(status) ? null : fields.phase ?? "starting",
    kind: fields.kind ?? fields.jobClass ?? "task",
    jobClass: fields.jobClass ?? fields.kind ?? "task",
    mode: fields.mode ?? "consult",
    workspaceRoot,
    repositoryTopLevel: gitValue(fields.cwd, ["rev-parse", "--show-toplevel"]),
    repositoryIdentity: identity,
    repositoryKey: fields.repositoryKey ?? createHash("sha256").update(identity).digest("hex").slice(0, 16),
    claudeSessionId: ownerSessionId(fields),
    codexPid: fields.codexPid ?? null,
    codexPidIdentity: fields.codexPidIdentity ?? null,
    pidOwnsProcessGroup: Boolean(fields.pidOwnsProcessGroup),
    codexPidIdentitySettled: Boolean(fields.codexPidIdentitySettled),
    codexPidOwnsProcessGroup: Boolean(fields.codexPidOwnsProcessGroup),
    artifactsPruned: Boolean(fields.artifactsPruned),
    briefFile: fields.briefFile ?? null,
    updatedAt: fields.updatedAt ?? createdAt,
    tokenUsageAvailability: fields.tokenUsageAvailability ?? "unreported",
    serviceTier: Object.hasOwn(fields, "serviceTier") ? fields.serviceTier : fields.request?.serviceTier ?? null,
    resolvedModel: fields.resolvedModel ?? fields.request?.model ?? null,
    resolvedEffort: fields.resolvedEffort ?? fields.request?.effort ?? null,
    diagnostics: fields.diagnostics ?? [],
    unknownEventCount: fields.unknownEventCount ?? 0,
    eventsTruncated: Boolean(fields.eventsTruncated),
    semanticStatus: fields.semanticStatus ?? "unverified",
    ...Object.fromEntries([
      "threadId", "turnId", "logFile", "eventsFile", "startedAt", "heartbeatAt", "deadlineAt",
      "launchApprovedAt", "launchAbortRequestedAt", "finishedAt", "collectedAt", "deliveryCollectedAt", "exitCode",
      "resultText", "partialResultText", "tokenUsage", "cumulativeTokenUsage", "tokenUsageUnavailableReason",
      "rolloutRecoveryStatus", "acceptanceSource", "acceptanceRecordedAt", "semanticFailureKind",
      "semanticFailureMessage", "protocolError", "resultSource", "fileChangeCount", "errorMessage",
      "errorTail", "failureKind", "cancelRequestedAt", "timeoutMs"
    ].map((key) => [key, fields[key] ?? null]))
  };
}

export function writeJobRecordFile(file, record) {
  assertJobRecord(record);
  return jobState.writeJobRecordFile(file, record);
}

export function updateJobRecordFileWithCurrent(file, updater, options = {}) {
  if (typeof updater !== "function") throw new TypeError("Job record updater must be a function.");
  return jobState.updateJobRecordFileWithCurrent(file, (current) => {
    const patch = updater({ ...current });
    return patch ? mergeRecord(current, patch) : current;
  }, options);
}

export function updateJobRecordFile(file, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("Job record patch must be an object.");
  return updateJobRecordFileWithCurrent(file, () => patch);
}

export function finishJobRecordFile(file, patch) {
  if (!TERMINAL_STATUSES.has(patch?.status)) throw new TypeError("A terminal job status is required.");
  return updateJobRecordFile(file, patch);
}

export function markJobCollectedFile(file, collectedAt = nowIso()) {
  if (typeof collectedAt !== "string" || !Number.isFinite(Date.parse(collectedAt))) throw new TypeError("A valid collection timestamp is required.");
  return jobState.updateJobRecordFileWithCurrent(file, (existing) => {
    if (!TERMINAL_STATUSES.has(existing.status) || existing.collectedAt) return existing;
    return {
      ...existing,
      collectedAt,
      deliveryCollectedAt: existing.delivery === "foreground" ? existing.deliveryCollectedAt ?? null : existing.deliveryCollectedAt ?? collectedAt
    };
  }, { allowTerminal: true });
}

export function latestJobRecordForThread(dataDir, threadId, cwd = null) {
  if (typeof threadId !== "string" || !threadId.trim()) return null;
  const records = cwd ? listJobRecords(dataDir, cwd) : listAllJobRecords(dataDir).map(({ record }) => record);
  const candidates = records.filter((record) => record.jobClass === "task" && (record.threadId === threadId || (!cwd && record.request?.resumeThreadId === threadId)));
  candidates.sort((left, right) => {
    const timestamp = String(right.finishedAt ?? right.updatedAt ?? right.createdAt ?? "").localeCompare(String(left.finishedAt ?? left.updatedAt ?? left.createdAt ?? ""));
    return timestamp || String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")) || String(left.id ?? "").localeCompare(String(right.id ?? ""));
  });
  return candidates[0] ?? null;
}

function retentionLimit(value, fallback) {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return fallback;
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveJobHistoryLimits(env = process.env) {
  return {
    maxBytes: retentionLimit(env[STATE_MAX_BYTES_ENV], DEFAULT_JOB_HISTORY_MAX_BYTES),
    maxRecords: retentionLimit(env[STATE_MAX_RECORDS_ENV], DEFAULT_JOB_HISTORY_MAX_RECORDS),
    recordMaxRecords: retentionLimit(env[RECORD_MAX_RECORDS_ENV], DEFAULT_JOB_RECORD_MAX_RECORDS),
    recordRetentionDays: retentionLimit(env[RECORD_RETENTION_DAYS_ENV], DEFAULT_JOB_RECORD_RETENTION_DAYS)
  };
}

function expectedManagedArtifacts(workspaceDir, id) {
  const jobs = path.join(workspaceDir, "jobs");
  return [
    { field: "briefFile", file: path.join(workspaceDir, "briefs", `${id}.md`) },
    { field: "logFile", file: path.join(jobs, `${id}.log`) },
    { field: "eventsFile", file: path.join(jobs, `${id}.events.jsonl`) },
    { file: path.join(jobs, `${id}.stdout.log`) },
    { file: path.join(jobs, `${id}.stderr.log`) },
    { file: path.join(jobs, `${id}.partial.txt`) },
    { file: path.join(jobs, `${id}.partial-result.txt`) }
  ];
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

export function findJobRecordById(dataDir, jobId) {
  const id = validateIdentifier(jobId, "Job id");
  const matches = listAllJobRecords(dataDir).filter((entry) => entry.record.id === id);
  if (matches.length > 1) throw new Error(`Job id ${id} is ambiguous across workspaces. Pass --cwd to select one workspace.`);
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
  jobState.appendJobLog(logFile, raw, { trimIncompleteLine: true });
}

export function appendJobEvent(eventsFile, event) {
  if (!eventsFile) {
    return;
  }
  const value = typeof event === "string" ? event.trimEnd() : event;
  if (!value) {
    return;
  }
  jobState.appendJobLog(eventsFile, observedEventLine(value), { maxBytes: JOB_EVENTS_MAX_BYTES, trimIncompleteLine: true });
}
