#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { appendModelAuditObservation, appendTokenUsageObservation, fusionRepositoryKey, modelAuditSidecarPath, resolveFusionDataDir, tokenUsageSidecarPath } from "./fusion-stats.mjs";
import { ENGINE_TERMINAL_STATUSES, engineStateRoots, isEngineId } from "./lib/engines.mjs";

const TERMINAL_STATUSES = ENGINE_TERMINAL_STATUSES;
const DEFAULT_UNAVAILABLE_TTL_MS = 6 * 60 * 60 * 1000;
const STATE_SCHEMA_VERSION = 2;

function resolveUnavailableTtlMs(engine, env = process.env) {
  const parsed = Number.parseInt(String(env[`${engine.toUpperCase()}_JOBS_OBSERVER_UNAVAILABLE_TTL_MS`]), 10);
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

function engineTokenUsageObservation(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  const inputTokens = tokenField(usage, ["input_tokens", "inputTokens"]);
  const cacheCreationTokens = tokenField(usage, ["cache_creation_input_tokens", "cacheCreationInputTokens", "cache_write_tokens", "cacheWriteTokens"]);
  return {
    inputTokens: inputTokens == null || cacheCreationTokens == null ? inputTokens : nonNegativeInteger(inputTokens + cacheCreationTokens),
    cachedInputTokens: tokenField(usage, ["cache_read_input_tokens", "cacheReadInputTokens", "cachedReadTokens", "cacheReadTokens"]),
    outputTokens: tokenField(usage, ["output_tokens", "outputTokens"]),
    reasoningOutputTokens: tokenField(usage, ["reasoning_tokens", "reasoningTokens"]),
    totalTokens: tokenField(usage, ["total_tokens", "totalTokens"])
  };
}

export function engineJobsObserverStatePath(engine, env = process.env) {
  if (!isEngineId(engine)) {
    throw new TypeError(`Unknown engine: ${engine}`);
  }
  return path.join(resolveFusionDataDir(env), "state", `${engine}-jobs-observer.json`);
}

function loadObserverState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(state?.observedJobIds)) {
      return { observedJobIds: new Set(), unavailableObservedAt: new Map(), notifiedJobIds: new Set() };
    }
    const unavailableObservedAt = state.schemaVersion === STATE_SCHEMA_VERSION && state.unavailableObservedAt && typeof state.unavailableObservedAt === "object" && !Array.isArray(state.unavailableObservedAt)
      ? new Map(Object.entries(state.unavailableObservedAt).filter(([jobId, observedAt]) => typeof jobId === "string" && jobId && Number.isFinite(Date.parse(observedAt))))
      : new Map();
    const notifiedJobIds = Array.isArray(state.notifiedJobIds) ? state.notifiedJobIds.filter((jobId) => typeof jobId === "string" && jobId) : [];
    return { observedJobIds: new Set(state.observedJobIds.filter((jobId) => typeof jobId === "string" && jobId)), unavailableObservedAt, notifiedJobIds: new Set(notifiedJobIds) };
  } catch {
    return { observedJobIds: new Set(), unavailableObservedAt: new Map(), notifiedJobIds: new Set() };
  }
}

function saveObserverState(file, engine, observedJobIds, unavailableObservedAt, notifiedJobIds) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(file), 0o700);
  } catch {
    void 0;
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    engine,
    observedJobIds: [...observedJobIds].sort(),
    unavailableObservedAt: Object.fromEntries([...unavailableObservedAt].sort(([left], [right]) => left.localeCompare(right))),
    ...(notifiedJobIds.size > 0 ? { notifiedJobIds: [...notifiedJobIds].sort() } : {}),
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

function terminalRecords(engine, env) {
  const records = [];
  for (const root of engineStateRoots(engine, env)) {
    let workspaces;
    try {
      workspaces = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const workspace of workspaces) {
      let entries;
      try {
        entries = fs.readdirSync(path.join(root, workspace, "jobs"));
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".json")) {
          continue;
        }
        try {
          records.push(JSON.parse(fs.readFileSync(path.join(root, workspace, "jobs", entry), "utf8")));
        } catch {
          continue;
        }
      }
    }
  }
  return records
    .filter((record) => TERMINAL_STATUSES.has(record?.status) && typeof record?.id === "string" && record.id && typeof record?.cwd === "string" && record.cwd)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function observeEngineJobs(engine, { env = process.env, now = () => new Date().toISOString(), notify } = {}) {
  const stateFile = engineJobsObserverStatePath(engine, env);
  const { observedJobIds, unavailableObservedAt, notifiedJobIds } = loadObserverState(stateFile);
  const unavailableTtlMs = resolveUnavailableTtlMs(engine, env);
  let changed = false;
  let observations = 0;
  for (const record of terminalRecords(engine, env)) {
    const ownSessionId = typeof env.CLAUDE_CODE_SESSION_ID === "string" && env.CLAUDE_CODE_SESSION_ID.trim() ? env.CLAUDE_CODE_SESSION_ID.trim() : null;
    const recordSessionId = typeof record.claudeSessionId === "string" && record.claudeSessionId.trim() ? record.claudeSessionId.trim() : null;
    if (notify && !notifiedJobIds.has(record.id) && (!ownSessionId || !recordSessionId || ownSessionId === recordSessionId) && (!Object.hasOwn(record, "background") || record.background === true)) {
      notify(record);
      notifiedJobIds.add(record.id);
      changed = true;
    }
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
      engine,
      workspaceRoot,
      repositoryKey,
      availability: available ? "available" : "unavailable",
      tokenUsage: available ? engineTokenUsageObservation(record.usage) : null,
      source: `${engine}-job-record`,
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
        engine,
        model: resolvedModel,
        effort: resolvedEffort,
        workspaceRoot,
        repositoryKey,
        source: `${engine}-job-record`,
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
    saveObserverState(stateFile, engine, observedJobIds, unavailableObservedAt, notifiedJobIds);
  }
  return observations;
}

export function observeEngineJobsSafely(engine, options) {
  try {
    return observeEngineJobs(engine, options);
  } catch {
    return 0;
  }
}
