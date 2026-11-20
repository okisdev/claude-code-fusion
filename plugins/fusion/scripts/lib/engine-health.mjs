import fs from "node:fs";
import path from "node:path";
import { ENGINES, ENGINE_IDS, engineForAgentType, engineStateRoots } from "./engines.mjs";
import { engineHostBlockers } from "./engine-host-check.mjs";
import { canonicalWorkerAgentType, readWorkerRecords } from "./worker-state.mjs";

const HARD_FAILURE_KINDS = new Set(["auth", "missing_cli", "setup", "protocol", "transport", "sandbox"]);
const REPEATED_FAILURE_KINDS = new Set(["rate_limited", "timeout", "stall", "network", "process", "died", "patch_thrash", "exec_lost"]);
const POOL_SCOPED_KINDS = new Set(["quota", "rate_limited"]);
const FAILURE_STATUSES = new Set(["error", "failed"]);
const SUCCESS_STATUSES = new Set(["done", "completed"]);
const TERMINAL_STATUSES = new Set([...FAILURE_STATUSES, ...SUCCESS_STATUSES, "cancelled"]);
const SESSION_WINDOW_MS = 30 * 60 * 1000;
const TRANSPORT_PERMISSION_PATTERN = /(?:sandbox|seatbelt|landlock).*(?:init|initializ|profile|policy)|(?:operation not permitted|\bEACCES\b|\bEPERM\b|permission denied).*(?:brief|prompt|transport|state|plugin|sandbox)|(?:brief|prompt|transport|state|plugin|sandbox).*(?:operation not permitted|\bEACCES\b|\bEPERM\b|permission denied)/i;
let healthRecordCache = null;

export function withEngineHealthRecords(callback) {
  const previous = healthRecordCache;
  healthRecordCache = new Map();
  try {
    return callback();
  } finally {
    healthRecordCache = previous;
  }
}

function recordTimestamp(record) {
  const timestamp = Date.parse(record.finishedAt ?? record.completedAt ?? record.updatedAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function recordMode(record) {
  if (!record.mode && !record.packageType) return null;
  return record.mode === "write" || (!record.mode && record.packageType === "implementation") ? "write" : "consult";
}

function normalizedPool(engine, pool) {
  if (engine === "devin" && pool === "first-party") return "free";
  if (engine === "devin" && pool === "api") return "credits";
  return pool ?? null;
}

function failureKind(record) {
  const kind = typeof record.failureKind === "string" ? record.failureKind.trim().toLowerCase() : "";
  const text = [record.errorMessage, record.errorTail, record.cancelReason].filter((value) => typeof value === "string").join("\n");
  if (kind === "policy" && /collaboration policy violation|companion protocol violation|transport protocol violation|delegated Codex execution attempted the disabled \w+ tool/i.test(text)) return "protocol";
  return kind;
}

function failureScope(kind) {
  return HARD_FAILURE_KINDS.has(kind) ? "engine" : POOL_SCOPED_KINDS.has(kind) ? "pool" : "mode";
}

function readJobRecords(stateRoot, modifiedSinceMs) {
  const records = [];
  let workspaces;
  try {
    workspaces = fs.readdirSync(stateRoot, { withFileTypes: true });
  } catch {
    return records;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) {
      continue;
    }
    const jobsDir = path.join(stateRoot, workspace.name, "jobs");
    let entries;
    try {
      entries = fs.readdirSync(jobsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      try {
        const file = path.join(jobsDir, entry.name);
        if (fs.statSync(file).mtimeMs < modifiedSinceMs) {
          continue;
        }
        const record = JSON.parse(fs.readFileSync(file, "utf8"));
        if (record && typeof record === "object" && !Array.isArray(record)) {
          records.push(record);
        }
      } catch {
        void 0;
      }
    }
  }
  return records;
}

function readDeduplicatedJobRecords(stateRoots, modifiedSinceMs) {
  const recordsWithoutIds = [];
  const byId = new Map();
  for (const root of stateRoots) {
    for (const record of readJobRecords(root, modifiedSinceMs)) {
      const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : null;
      if (!id) {
        recordsWithoutIds.push(record);
        continue;
      }
      const current = byId.get(id);
      if (!current || (TERMINAL_STATUSES.has(record.status) && !TERMINAL_STATUSES.has(current.status)) || (TERMINAL_STATUSES.has(record.status) === TERMINAL_STATUSES.has(current.status) && (recordTimestamp(record) ?? Number.NEGATIVE_INFINITY) > (recordTimestamp(current) ?? Number.NEGATIVE_INFINITY))) {
        byId.set(id, record);
      }
    }
  }
  return [...recordsWithoutIds, ...byId.values()];
}

export function readEngineHealthRecords(env = process.env, now = Date.now()) {
  if (healthRecordCache?.has(env)) return healthRecordCache.get(env);
  const parsed = Number.parseFloat(String(env.FUSION_BREAKER_LOOKBACK_HOURS ?? ""));
  const lookbackMs = (Number.isFinite(parsed) && parsed > 0 ? parsed : 12) * 60 * 60 * 1000;
  const workers = readWorkerRecords(env, { modifiedSinceMs: now - Math.max(lookbackMs, SESSION_WINDOW_MS) });
  const engines = new Map(ENGINE_IDS.map((engine) => {
    const jobs = readDeduplicatedJobRecords(engineStateRoots(engine, env), now - Math.max(lookbackMs, SESSION_WINDOW_MS));
    const byId = new Map(jobs.filter((record) => record.id).map((record) => [record.id, record]));
    const wrappers = new Map();
    for (const worker of workers) {
      if ((worker.peerEngine ?? engineForAgentType(worker.agentType)) !== engine || !Number.isFinite(Date.parse(worker.finishedAt ?? ""))) continue;
      const peer = byId.get(worker.peerJobId);
      if (peer && TERMINAL_STATUSES.has(peer.status)) {
        peer.mode ??= recordMode(worker);
        peer.claudeSessionId ??= worker.sessionId;
        peer.billingPool ??= worker.peerBillingPool ?? worker.billingPool;
        continue;
      }
      const record = {
        ...worker,
        status: worker.transportStatus === "done" ? "done" : ["failed", "incomplete", "owner_ended"].includes(worker.transportStatus) ? "failed" : worker.transportStatus,
        failureKind: worker.peerFailureKind ?? worker.failureKind,
        billingPool: worker.peerBillingPool ?? worker.billingPool
      };
      const key = worker.peerJobId ?? worker.taskId;
      const current = wrappers.get(key);
      if (!current || recordTimestamp(record) > recordTimestamp(current)) wrappers.set(key, record);
    }
    return [engine, [...jobs, ...wrappers.values()]];
  }));
  const records = { workers, engines, lookbackMs };
  healthRecordCache?.set(env, records);
  return records;
}

function latestFailure(records, scope, mode, pool, engine, now, windowMs) {
  const outcomes = records.filter((record) => {
    const timestamp = recordTimestamp(record);
    const age = now - timestamp;
    return timestamp !== null && (FAILURE_STATUSES.has(record.status) || SUCCESS_STATUSES.has(record.status)) && age >= 0 && age < windowMs &&
      (scope !== "pool" || normalizedPool(engine, record.billingPool) === pool) &&
      (scope !== "mode" || recordMode(record) === null || recordMode(record) === mode);
  }).sort((left, right) => recordTimestamp(left) - recordTimestamp(right));
  let immediate = null;
  let previous = null;
  let repeated = null;
  for (const outcome of outcomes) {
    if (SUCCESS_STATUSES.has(outcome.status)) {
      immediate = previous = repeated = null;
      continue;
    }
    const kind = failureKind(outcome);
    if (FAILURE_STATUSES.has(outcome.status) && failureScope(kind) !== scope) continue;
    const text = [outcome.errorMessage, outcome.errorTail, outcome.cancelReason].filter((value) => typeof value === "string").join("\n");
    const failure = {
      failureKind: kind,
      timestamp: recordTimestamp(outcome),
      version: outcome[ENGINES[engine]?.versionField] ?? null,
      scope,
      mode: scope === "mode" ? mode : null,
      pool: scope === "pool" ? pool : null,
      until: recordTimestamp(outcome) + windowMs
    };
    if (HARD_FAILURE_KINDS.has(kind) || kind === "quota" || (kind === "permission" && TRANSPORT_PERMISSION_PATTERN.test(text)) || (engine === "agy" && kind === "policy")) {
      immediate = failure;
      previous = repeated = null;
    } else if (REPEATED_FAILURE_KINDS.has(kind)) {
      if (previous?.failureKind === kind) repeated = failure;
      else repeated = null;
      previous = failure;
    } else {
      previous = repeated = null;
    }
  }
  const failure = [immediate, repeated].filter(Boolean).sort((left, right) => right.timestamp - left.timestamp)[0];
  return failure ? {
    ...failure,
    kindCount: outcomes.filter((record) => FAILURE_STATUSES.has(record.status) && failureKind(record) === failure.failureKind).length,
    terminalCount: outcomes.length
  } : null;
}

export function engineHealth(engine, mode = "consult", pool = null, { env = process.env, now = Date.now(), sessionId = null, records = null } = {}) {
  mode = mode === "write" ? "write" : "consult";
  records ??= readEngineHealthRecords(env, now);
  const canonical = canonicalWorkerAgentType(engine);
  let outcomes = records.engines.get(engine) ?? [];
  if (canonical) {
    outcomes = records.workers.filter((record) => canonicalWorkerAgentType(record.agentType) === canonical).map((record) => ({
      ...record,
      status: record.transportStatus === "done" ? "done" : ["failed", "incomplete", "owner_ended"].includes(record.transportStatus) ? "failed" : record.transportStatus
    }));
  }
  if (sessionId) outcomes = outcomes.filter((record) => (record.claudeSessionId ?? record.sessionId) === sessionId);
  const windowMs = sessionId ? SESSION_WINDOW_MS : records.lookbackMs;
  const pools = pool === null ? new Set(outcomes.map((record) => normalizedPool(engine, record.billingPool))) : [normalizedPool(engine, pool)];
  const failures = [
    ...["engine", "mode"].map((scope) => latestFailure(outcomes, scope, mode, null, engine, now, windowMs)),
    ...[...pools].map((billingPool) => latestFailure(outcomes, "pool", mode, billingPool, engine, now, windowMs))
  ].filter(Boolean);
  const blockers = engineHostBlockers(engine, env, now).filter((blocker) => blocker.modes.some((value) => (value === "write" ? "write" : "consult") === mode));
  const failure = failures.sort((left, right) => right.until - left.until)[0];
  return {
    healthy: !failure && blockers.length === 0,
    reason: blockers[0]?.kind ?? failure?.failureKind ?? null,
    scope: blockers.length ? "mode" : failure?.scope ?? null,
    until: blockers.length ? now + 60_000 : failure?.until ?? null,
    failures,
    blockers
  };
}
