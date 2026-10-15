#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { appendModelAuditObservation, appendTokenUsageObservation, fusionRepositoryKey, modelAuditSidecarPath, resolveFusionDataDir, tokenUsageSidecarPath } from "./fusion-stats.mjs";
import { ENGINE_TERMINAL_STATUSES, engineStateRoots, isEngineId } from "./lib/engines.mjs";

const DEFAULT_UNAVAILABLE_TTL_MS = 6 * 60 * 60 * 1000;
const STATE_SCHEMA_VERSION = 2;
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const scanCaches = new Map();

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
    if (state?.schemaVersion !== STATE_SCHEMA_VERSION || !Array.isArray(state.observedJobIds)) {
      return { observedJobIds: new Set(), unavailableObservedAt: new Map(), notifiedJobIds: new Set(), missingSince: new Map() };
    }
    const unavailableObservedAt = state.unavailableObservedAt && typeof state.unavailableObservedAt === "object" && !Array.isArray(state.unavailableObservedAt)
      ? new Map(Object.entries(state.unavailableObservedAt).filter(([jobId, observedAt]) => typeof jobId === "string" && jobId && Number.isFinite(Date.parse(observedAt))))
      : new Map();
    const notifiedJobIds = Array.isArray(state.notifiedJobIds) ? state.notifiedJobIds.filter((jobId) => typeof jobId === "string" && jobId) : [];
    const missingSince = state.missingSince && typeof state.missingSince === "object" && !Array.isArray(state.missingSince)
      ? new Map(Object.entries(state.missingSince).filter(([id, date]) => typeof id === "string" && id && Number.isFinite(Date.parse(date))))
      : new Map();
    return { observedJobIds: new Set(state.observedJobIds.filter((jobId) => typeof jobId === "string" && jobId)), unavailableObservedAt, notifiedJobIds: new Set(notifiedJobIds), missingSince };
  } catch {
    return { observedJobIds: new Set(), unavailableObservedAt: new Map(), notifiedJobIds: new Set(), missingSince: new Map() };
  }
}

function saveObserverState(file, engine, observedJobIds, unavailableObservedAt, notifiedJobIds, missingSince) {
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
    ...(missingSince.size > 0 ? { missingSince: Object.fromEntries([...missingSince].sort(([left], [right]) => left.localeCompare(right))) } : {}),
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

function observerRecordSummary(record) {
  const { id, cwd, status, claudeSessionId, background, resolvedModel, resolvedEffort,
    usage, finishedAt, completedAt, updatedAt, createdAt } = record;
  return { id, cwd, status, claudeSessionId, resolvedModel, resolvedEffort,
    ...(Object.hasOwn(record, "background") ? { background } : {}),
    usage: usage && typeof usage === "object" && !Array.isArray(usage) ? engineTokenUsageObservation(usage) : null,
    finishedAt, completedAt, updatedAt, createdAt };
}

function observerScanCache(engine, env) {
  const roots = engineStateRoots(engine, env);
  const key = JSON.stringify(roots);
  const previous = scanCaches.get(engine);
  if (previous?.key === key) return { roots, cache: previous };
  const cache = { key, files: new Map(), scannedAt: 0 };
  scanCaches.set(engine, cache);
  return { roots, cache };
}

function terminalRecords(engine, env) {
  const { roots, cache } = observerScanCache(engine, env);
  const records = [];
  const liveIds = new Set();
  const seenFiles = new Set();
  const reconcile = Date.now() - cache.scannedAt >= RECONCILE_INTERVAL_MS;
  let complete = true;
  for (const root of roots) {
    let workspaces;
    try {
      workspaces = fs.readdirSync(root);
    } catch (error) {
      if (error?.code !== "ENOENT") complete = false;
      continue;
    }
    for (const workspace of workspaces) {
      let entries;
      try {
        entries = fs.readdirSync(path.join(root, workspace, "jobs"));
      } catch (error) {
        if (error?.code !== "ENOENT") complete = false;
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".json")) {
          continue;
        }
        const file = path.join(root, workspace, "jobs", entry);
        seenFiles.add(file);
        liveIds.add(entry.slice(0, -5));
        try {
          const stat = fs.statSync(file);
          const previous = cache.files.get(file);
          let cached = previous;
          let sourceRecord = null;
          if (reconcile || !previous || previous.mtimeMs !== stat.mtimeMs || previous.size !== stat.size || previous.ino !== stat.ino) {
            let record = null;
            try {
              sourceRecord = JSON.parse(fs.readFileSync(file, "utf8"));
              record = observerRecordSummary(sourceRecord);
            } catch {}
            cached = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, record };
            cache.files.set(file, cached);
          }
          if (cached.record) {
            records.push({ record: cached.record, file, sourceRecord });
            if (cached.record.id) liveIds.add(cached.record.id);
          }
        } catch {
          continue;
        }
      }
    }
  }
  if (complete) {
    for (const file of cache.files.keys()) {
      if (!seenFiles.has(file)) cache.files.delete(file);
    }
  }
  if (reconcile) cache.scannedAt = Date.now();
  return { records: records
    .filter(({ record }) => ENGINE_TERMINAL_STATUSES.has(record?.status) && typeof record?.id === "string" && record.id && typeof record?.cwd === "string" && record.cwd)
    .sort((left, right) => left.record.id.localeCompare(right.record.id)), liveIds, complete };
}

export function observeEngineJobs(engine, { env = process.env, now = () => new Date().toISOString(), notify } = {}) {
  const stateFile = engineJobsObserverStatePath(engine, env);
  const { observedJobIds, unavailableObservedAt, notifiedJobIds, missingSince } = loadObserverState(stateFile);
  const unavailableTtlMs = resolveUnavailableTtlMs(engine, env);
  let changed = false;
  let observations = 0;
  const { records, liveIds, complete } = terminalRecords(engine, env);
  if (complete) {
    const observedAt = now();
    const nowMs = Date.parse(observedAt);
    for (const id of new Set([...observedJobIds, ...notifiedJobIds, ...unavailableObservedAt.keys(), ...missingSince.keys()])) {
      if (liveIds.has(id)) {
        if (missingSince.delete(id)) changed = true;
        continue;
      }
      const missingAt = missingSince.get(id);
      if (!missingAt) {
        missingSince.set(id, observedAt);
        changed = true;
      } else if (Number.isFinite(nowMs) && nowMs - Date.parse(missingAt) > RETENTION_MS) {
        changed = true;
        observedJobIds.delete(id);
        notifiedJobIds.delete(id);
        unavailableObservedAt.delete(id);
        missingSince.delete(id);
      }
    }
  }
  for (const entry of records) {
    const record = entry.record;
    const ownSessionId = typeof env.CLAUDE_CODE_SESSION_ID === "string" && env.CLAUDE_CODE_SESSION_ID.trim() ? env.CLAUDE_CODE_SESSION_ID.trim() : null;
    const recordSessionId = typeof record.claudeSessionId === "string" && record.claudeSessionId.trim() ? record.claudeSessionId.trim() : null;
    if (notify && !notifiedJobIds.has(record.id) && (!ownSessionId || !recordSessionId || ownSessionId === recordSessionId) && (!Object.hasOwn(record, "background") || record.background === true)) {
      notify(entry.sourceRecord ?? JSON.parse(fs.readFileSync(entry.file, "utf8")));
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
      tokenUsage: available ? record.usage : null,
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
    saveObserverState(stateFile, engine, observedJobIds, unavailableObservedAt, notifiedJobIds, missingSince);
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
