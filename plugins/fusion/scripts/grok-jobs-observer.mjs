#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FILE_ENGINE_DESCRIPTORS, appendModelAuditObservation, appendTokenUsageObservation, fusionRepositoryKey, modelAuditSidecarPath, resolveFusionDataDir, tokenUsageSidecarPath } from "./fusion-stats.mjs";

const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);
const DEFAULT_POLL_INTERVAL_MS = 15000;
const DEFAULT_UNAVAILABLE_TTL_MS = 6 * 60 * 60 * 1000;
const INTERVAL_ENV = "GROK_JOBS_OBSERVER_INTERVAL_MS";
const UNAVAILABLE_TTL_ENV = "GROK_JOBS_OBSERVER_UNAVAILABLE_TTL_MS";
const STATE_SCHEMA_VERSION = 2;

function resolvePollIntervalMs(env = process.env) {
  const parsed = Number.parseInt(String(env[INTERVAL_ENV]), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_MS;
}

function resolveUnavailableTtlMs(env = process.env) {
  const parsed = Number.parseInt(String(env[UNAVAILABLE_TTL_ENV]), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_UNAVAILABLE_TTL_MS;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function tokenField(usage, names) {
  for (const name of names) {
    if (Object.hasOwn(usage, name)) {
      return nonNegativeInteger(usage[name]);
    }
  }
  return null;
}

export function grokTokenUsageObservation(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  return {
    inputTokens: tokenField(usage, ["input_tokens", "inputTokens"]),
    cachedInputTokens: tokenField(usage, ["cache_read_input_tokens", "cacheReadInputTokens", "cachedReadTokens", "cacheReadTokens"]),
    outputTokens: tokenField(usage, ["output_tokens", "outputTokens"]),
    reasoningOutputTokens: tokenField(usage, ["reasoning_tokens", "reasoningTokens"]),
    totalTokens: tokenField(usage, ["total_tokens", "totalTokens"])
  };
}

export function grokJobsObserverStatePath(env = process.env) {
  return path.join(resolveFusionDataDir(env), "state", "grok-jobs-observer.json");
}

function loadObserverState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(state?.observedJobIds)) {
      return { observedJobIds: new Set(), unavailableObservedAt: new Map() };
    }
    const unavailableObservedAt = state.schemaVersion === STATE_SCHEMA_VERSION && state.unavailableObservedAt && typeof state.unavailableObservedAt === "object" && !Array.isArray(state.unavailableObservedAt)
      ? new Map(Object.entries(state.unavailableObservedAt).filter(([jobId, observedAt]) => typeof jobId === "string" && jobId && Number.isFinite(Date.parse(observedAt))))
      : new Map();
    return { observedJobIds: new Set(state.observedJobIds.filter((jobId) => typeof jobId === "string" && jobId)), unavailableObservedAt };
  } catch {
    return { observedJobIds: new Set(), unavailableObservedAt: new Map() };
  }
}

function saveObserverState(file, observedJobIds, unavailableObservedAt) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(file), 0o700);
  } catch {
    void 0;
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    engine: "grok",
    observedJobIds: [...observedJobIds].sort(),
    unavailableObservedAt: Object.fromEntries([...unavailableObservedAt].sort(([left], [right]) => left.localeCompare(right))),
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function hasUsageObject(record) {
  return Boolean(record?.usage && typeof record.usage === "object" && !Array.isArray(record.usage));
}

function recordAgeMs(record, firstObservedAt, nowMs) {
  const timestamp = [record?.finishedAt, record?.completedAt, record?.updatedAt, record?.createdAt, firstObservedAt]
    .map((value) => Date.parse(value))
    .find(Number.isFinite);
  return Number.isFinite(timestamp) && Number.isFinite(nowMs) ? nowMs - timestamp : 0;
}

function terminalRecords(env) {
  const descriptor = FILE_ENGINE_DESCRIPTORS.grok;
  const stateRoot = descriptor.defaultStateRoot(env);
  return descriptor
    .enumerateJobs(stateRoot)
    .filter((record) => TERMINAL_STATUSES.has(record?.status) && typeof record?.id === "string" && record.id && typeof record?.cwd === "string" && record.cwd)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function observeGrokJobs({ env = process.env, now = () => new Date().toISOString() } = {}) {
  const stateFile = grokJobsObserverStatePath(env);
  const { observedJobIds, unavailableObservedAt } = loadObserverState(stateFile);
  const unavailableTtlMs = resolveUnavailableTtlMs(env);
  let changed = false;
  let observations = 0;
  for (const record of terminalRecords(env)) {
    if (observedJobIds.has(record.id)) {
      continue;
    }
    const workspaceRoot = path.resolve(record.cwd);
    const repositoryKey = fusionRepositoryKey(workspaceRoot);
    const available = hasUsageObject(record);
    const observedAt = now();
    const appended = appendTokenUsageObservation(tokenUsageSidecarPath(workspaceRoot, env), {
      schemaVersion: 1,
      jobId: record.id,
      engine: "grok",
      workspaceRoot,
      repositoryKey,
      availability: available ? "available" : "unavailable",
      tokenUsage: available ? grokTokenUsageObservation(record.usage) : null,
      source: "grok-job-record",
      observedAt
    });
    if (!appended) {
      continue;
    }
    const resolvedModel = typeof record.resolvedModel === "string" && record.resolvedModel.trim() ? record.resolvedModel.trim() : null;
    if (resolvedModel) {
      const resolvedEffort = typeof record.resolvedEffort === "string" && record.resolvedEffort.trim() ? record.resolvedEffort.trim() : null;
      appendModelAuditObservation(modelAuditSidecarPath(workspaceRoot, env), {
        schemaVersion: 1,
        jobId: record.id,
        engine: "grok",
        model: resolvedModel,
        effort: resolvedEffort,
        workspaceRoot,
        repositoryKey,
        source: "grok-job-record",
        observedAt
      });
    }
    observations += 1;
    if (available) {
      const becameObserved = !observedJobIds.has(record.id);
      observedJobIds.add(record.id);
      if (unavailableObservedAt.delete(record.id) || becameObserved) {
        changed = true;
      }
      continue;
    }
    const firstObservedAt = unavailableObservedAt.get(record.id) ?? observedAt;
    if (!unavailableObservedAt.has(record.id)) {
      unavailableObservedAt.set(record.id, firstObservedAt);
      changed = true;
    }
    if (recordAgeMs(record, firstObservedAt, Date.parse(observedAt)) > unavailableTtlMs) {
      observedJobIds.add(record.id);
      unavailableObservedAt.delete(record.id);
      changed = true;
    }
  }
  if (changed) {
    saveObserverState(stateFile, observedJobIds, unavailableObservedAt);
  }
  return observations;
}

function observeGrokJobsSafely() {
  try {
    return observeGrokJobs();
  } catch {
    return 0;
  }
}

function installExitHandlers(timer) {
  const shutdown = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);
}

function main() {
  observeGrokJobsSafely();
  const timer = setInterval(() => {
    observeGrokJobsSafely();
  }, resolvePollIntervalMs());
  installExitHandlers(timer);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
