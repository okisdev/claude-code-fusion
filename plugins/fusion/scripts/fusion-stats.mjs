#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAuditEvents as readGuardAuditEvents, resolveStateDir as resolveGuardStateDir, stateFile as guardStateFile } from "./inline-delegation-guard.mjs";
import { resolveCodexStateDir, resolveCodexStateRoots } from "./lib/codex-state-roots.mjs";

const GROK_DATA_DIR_ENV = "GROK_COMPANION_DATA";
const FUSION_DATA_DIR_ENV = "FUSION_DATA_DIR";
const CODEX_TERMINAL_STATUSES = new Set(["done", "error", "cancelled", "completed", "failed"]);
const GROK_TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);
const CODEX_ACCEPTANCE_STATES = new Set(["accepted", "rejected", "unverified"]);
const ACCEPTANCE_FILENAME = "acceptance.jsonl";
const TOKEN_USAGE_FILENAME = "token-usage.jsonl";
const TERMINAL_LEDGER_PREFIX = "codex-jobs-monitor-announced";
const OBSERVATION_LOCK_STALE_MS = 30000;
const OBSERVATION_LOCK_ATTEMPTS = 8;
const PRUNE_EVIDENCE = Symbol("pruneEvidence");

export function fusionWorkspaceKey(workspaceRoot) {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}

export function resolveFusionDataDir(env = process.env) {
  const override = env[FUSION_DATA_DIR_ENV];
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "fusion-claude-code-fusion");
}

export function modelAuditSidecarPath(workspaceRoot, env = process.env) {
  return path.join(resolveFusionDataDir(env), "observations", fusionWorkspaceKey(workspaceRoot), "model-audit.jsonl");
}

export function tokenUsageSidecarPath(workspaceRoot, env = process.env) {
  return path.join(resolveFusionDataDir(env), "observations", fusionWorkspaceKey(workspaceRoot), TOKEN_USAGE_FILENAME);
}

export function acceptanceSidecarPath(workspaceRoot, env = process.env) {
  return path.join(resolveFusionDataDir(env), "observations", fusionWorkspaceKey(workspaceRoot), ACCEPTANCE_FILENAME);
}

function observationTimestamp(observation) {
  const parsed = Date.parse(observation?.observedAt ?? observation?.recordedAt ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function modelObservationRank(observation) {
  if (observation?.source === "rollout-turn-context") {
    return 2;
  }
  if (observation?.source === "argv") {
    return 1;
  }
  return 0;
}

export function loadModelAuditObservations(sidecarPath) {
  const byJobId = new Map();
  let text;
  try {
    text = fs.readFileSync(sidecarPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      void 0;
    }
    return byJobId;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const observation = JSON.parse(line);
      if (observation?.jobId && typeof observation.jobId === "string") {
        const current = byJobId.get(observation.jobId);
        if (!current || modelObservationRank(observation) > modelObservationRank(current) || (modelObservationRank(observation) === modelObservationRank(current) && observationTimestamp(observation) > observationTimestamp(current))) {
          byJobId.set(observation.jobId, observation);
        }
      }
    } catch {
      void 0;
    }
  }
  return byJobId;
}

function nonEmptyString(value) {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
}

export function resolveCodexJobModel(raw, observation) {
  if (observation?.source === "rollout-turn-context") {
    return nonEmptyString(observation?.model) ?? nonEmptyString(raw?.request?.model) ?? "unknown";
  }
  return nonEmptyString(raw?._fusionObservedModel) ?? nonEmptyString(raw?.request?.model) ?? nonEmptyString(observation?.model) ?? "unknown";
}

export function resolveCodexJobEffort(raw, observation) {
  if (observation?.source === "rollout-turn-context") {
    return nonEmptyString(observation?.effort) ?? nonEmptyString(raw?.request?.effort) ?? null;
  }
  return nonEmptyString(raw?._fusionObservedEffort) ?? nonEmptyString(raw?.request?.effort) ?? nonEmptyString(observation?.effort) ?? null;
}

function loadLatestJsonlByJobId(sidecarPath, timestampField) {
  const byJobId = new Map();
  let text;
  try {
    text = fs.readFileSync(sidecarPath, "utf8");
  } catch {
    return byJobId;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const observation = JSON.parse(line);
      const jobId = nonEmptyString(observation?.jobId);
      if (!jobId) {
        continue;
      }
      const current = byJobId.get(jobId);
      const candidateTimestamp = Date.parse(observation?.[timestampField] ?? "");
      const currentTimestamp = Date.parse(current?.[timestampField] ?? "");
      if (!current || (Number.isFinite(candidateTimestamp) && (!Number.isFinite(currentTimestamp) || candidateTimestamp >= currentTimestamp))) {
        byJobId.set(jobId, observation);
      }
    } catch {
      void 0;
    }
  }
  return byJobId;
}

export function loadTokenUsageObservations(sidecarPath) {
  return loadLatestJsonlByJobId(sidecarPath, "observedAt");
}

export function loadAcceptanceObservations(sidecarPath) {
  return loadLatestJsonlByJobId(sidecarPath, "recordedAt");
}

function waitForObservationLock() {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, 10);
}

function acquireObservationLock(lockPath) {
  for (let attempt = 0; attempt < OBSERVATION_LOCK_ATTEMPTS; attempt += 1) {
    try {
      return fs.openSync(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > OBSERVATION_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") {
          continue;
        }
      }
      if (attempt + 1 < OBSERVATION_LOCK_ATTEMPTS) {
        waitForObservationLock();
      }
    }
  }
  return null;
}

function appendJsonlObservation(sidecarPath, observation, shouldAppend = () => true) {
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  const lockPath = `${sidecarPath}.lock`;
  const lock = acquireObservationLock(lockPath);
  if (lock == null) {
    return false;
  }
  try {
    if (!shouldAppend()) {
      return true;
    }
    fs.appendFileSync(sidecarPath, `${JSON.stringify(observation)}\n`, "utf8");
    return true;
  } finally {
    fs.closeSync(lock);
    fs.rmSync(lockPath, { force: true });
  }
}

export function appendTokenUsageObservation(sidecarPath, observation) {
  return appendJsonlObservation(sidecarPath, observation, () => {
    const current = loadTokenUsageObservations(sidecarPath).get(observation.jobId);
    return !current || (current.availability !== "available" && current.availability !== observation.availability);
  });
}

export function resolveGitWorkspaceRoot(cwd) {
  const resolved = path.resolve(cwd);
  const result = spawnSync("git", ["-C", resolved, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (!result.error && result.status === 0 && result.stdout.trim()) {
    return path.resolve(result.stdout.trim());
  }
  return resolved;
}

export function resolveGitRepositoryCommonDir(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) {
    return null;
  }
  const resolved = path.resolve(cwd);
  const result = spawnSync("git", ["-C", resolved, "rev-parse", "--git-common-dir"], { encoding: "utf8" });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    return null;
  }
  const commonDir = path.resolve(resolved, result.stdout.trim());
  try {
    return fs.realpathSync(commonDir);
  } catch {
    return commonDir;
  }
}

export function workspaceRootInScope(recordedRoot, workspaceRoot) {
  if (typeof recordedRoot !== "string" || !recordedRoot.trim()) {
    return false;
  }
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(recordedRoot));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function repositoryIdentity(cwd, cache) {
  const resolved = path.resolve(cwd);
  if (!cache.has(resolved)) {
    cache.set(resolved, resolveGitRepositoryCommonDir(resolved));
  }
  return cache.get(resolved);
}

export function fusionRepositoryKey(workspaceRoot, cache = new Map()) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
    return null;
  }
  const resolved = path.resolve(workspaceRoot);
  return fusionWorkspaceKey(repositoryIdentity(resolved, cache) ?? resolved);
}

export function workspaceRootsShareRepository(leftRoot, rightRoot, cache = new Map()) {
  if (typeof leftRoot !== "string" || !leftRoot.trim() || typeof rightRoot !== "string" || !rightRoot.trim()) {
    return false;
  }
  const leftIdentity = repositoryIdentity(leftRoot, cache);
  const rightIdentity = repositoryIdentity(rightRoot, cache);
  if (leftIdentity && rightIdentity) {
    return leftIdentity === rightIdentity;
  }
  return workspaceRootInScope(leftRoot, rightRoot) || workspaceRootInScope(rightRoot, leftRoot);
}

function validatedIdentifier(value, label, pattern, maximumLength) {
  const normalized = nonEmptyString(value);
  if (!normalized || normalized.length > maximumLength || !pattern.test(normalized)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return normalized;
}

function validatedIsoTimestamp(value) {
  const normalized = nonEmptyString(value);
  const parsed = normalized ? Date.parse(normalized) : Number.NaN;
  if (!normalized || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    throw new TypeError("Codex acceptance recordedAt must be an ISO timestamp.");
  }
  return normalized;
}

function sanitizedAcceptanceReason(value) {
  const normalized = nonEmptyString(value);
  if (!normalized) {
    return null;
  }
  if (normalized.length > 240 || /[\r\n\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError("Codex acceptance reason must be a single non-sensitive line of at most 240 characters.");
  }
  return normalized
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[redacted]")
    .replace(/(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/xai-[A-Za-z0-9]{16,}/g, "[redacted]")
    .replace(/Bearer\s+\S{20,}/gi, "Bearer [redacted]");
}

export function recordCodexAcceptance({ jobId, acceptance, workspaceRoot = process.cwd(), env = process.env, sessionId = env.CLAUDE_CODE_SESSION_ID || null, reason = null, source = "collector", recordedAt = new Date().toISOString() }) {
  const normalizedJobId = validatedIdentifier(jobId, "Codex job id", /^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 128);
  if (!CODEX_ACCEPTANCE_STATES.has(acceptance)) {
    throw new TypeError(`Codex acceptance must be one of ${[...CODEX_ACCEPTANCE_STATES].join(", ")}.`);
  }
  const normalizedRoot = resolveGitWorkspaceRoot(workspaceRoot);
  const normalizedSessionId = sessionId == null ? null : validatedIdentifier(sessionId, "Codex session id", /^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 128);
  const normalizedSource = validatedIdentifier(source, "Codex acceptance source", /^[a-z][a-z0-9._-]*$/, 32);
  const normalizedReason = sanitizedAcceptanceReason(reason);
  const observation = {
    schemaVersion: 1,
    engine: "codex",
    jobId: normalizedJobId,
    acceptance,
    workspaceRoot: normalizedRoot,
    repositoryKey: fusionRepositoryKey(normalizedRoot),
    sessionId: normalizedSessionId,
    source: normalizedSource,
    recordedAt: validatedIsoTimestamp(recordedAt),
    ...(normalizedReason ? { reason: normalizedReason } : {})
  };
  if (!appendJsonlObservation(acceptanceSidecarPath(normalizedRoot, env), observation)) {
    throw new Error("Codex acceptance ledger is busy; retry the write.");
  }
  return observation;
}

export function newestGrokCompanion(env = process.env) {
  const override = env.FUSION_GROK_COMPANION;
  if (override) {
    return fs.existsSync(override) ? override : null;
  }
  const base = path.join(os.homedir(), ".claude", "plugins", "cache", "claude-code-fusion", "grok");
  try {
    const candidates = fs
      .readdirSync(base)
      .map((version) => path.join(base, version, "scripts", "grok-companion.mjs"))
      .filter((candidate) => fs.existsSync(candidate))
      .map((candidate) => ({ candidate, mtime: fs.statSync(candidate).mtimeMs }))
      .sort((left, right) => right.mtime - left.mtime);
    if (candidates.length > 0) {
      return candidates[0].candidate;
    }
  } catch {
    void 0;
  }
  const sibling = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "grok", "scripts", "grok-companion.mjs");
  return fs.existsSync(sibling) ? sibling : null;
}

export function grokStats({ all = false, env = process.env, cwd = process.cwd() } = {}) {
  const bin = newestGrokCompanion(env);
  if (!bin) {
    return { available: false, reason: "grok companion not found in the plugin cache or the sibling plugin" };
  }
  const result = spawnSync(process.execPath, [bin, "stats", ...(all ? ["--all"] : ["--cwd", cwd]), "--json"], { encoding: "utf8", env });
  if (result.error || result.status !== 0) {
    const reason = (result.stderr || result.error?.message || "grok stats failed").trim().split("\n")[0];
    return { available: false, reason };
  }
  try {
    return { available: true, ...JSON.parse(result.stdout) };
  } catch {
    return { available: false, reason: "grok stats returned unparseable output" };
  }
}

function resolveGrokDataDir(env = process.env) {
  const override = env[GROK_DATA_DIR_ENV];
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "grok-claude-code-fusion");
}

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function resolveStateRoot(descriptor, env) {
  const override = env[descriptor.stateEnvVar];
  return override || descriptor.defaultStateRoot(env);
}

function readWorkspaceJobFiles(stateRoot) {
  const jobs = [];
  let workspaces;
  try {
    workspaces = fs.readdirSync(stateRoot);
  } catch {
    return jobs;
  }
  for (const workspace of workspaces) {
    const dir = path.join(stateRoot, workspace, "jobs");
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      try {
        const file = path.join(dir, entry);
        const record = JSON.parse(fs.readFileSync(file, "utf8"));
        jobs.push({
          ...record,
          _fusionEvidence: "state",
          _fusionRepositoryKey: nonEmptyString(record?.repositoryKey)
        });
      } catch {
        void 0;
      }
    }
  }
  return jobs;
}

function terminalLedgerWorkspaceKey(file) {
  const match = path.basename(file).match(/\.([a-f0-9]{16})\.json$/);
  return match?.[1] ?? null;
}

function terminalLedgerRecord(raw, { workspaceRoot = null, workspaceKey = null, repositoryKey = null } = {}) {
  const jobId = nonEmptyString(raw?.jobId ?? raw?.id);
  const status = nonEmptyString(raw?.transportStatus ?? raw?.status);
  if (!jobId || !status || !CODEX_TERMINAL_STATUSES.has(status)) {
    return null;
  }
  const model = nonEmptyString(raw?.model ?? raw?.request?.model);
  const effort = nonEmptyString(raw?.effort ?? raw?.request?.effort);
  return {
    id: jobId,
    status,
    workspaceRoot: nonEmptyString(raw?.workspaceRoot) ?? workspaceRoot,
    sessionId: nonEmptyString(raw?.sessionId),
    jobClass: nonEmptyString(raw?.kind ?? raw?.jobClass) ?? "unknown",
    createdAt: raw?.createdAt ?? null,
    startedAt: raw?.startedAt ?? null,
    finishedAt: raw?.finishedAt ?? raw?.completedAt ?? raw?.observedAt ?? null,
    completedAt: raw?.finishedAt ?? raw?.completedAt ?? raw?.observedAt ?? null,
    request: model || effort ? { model, effort } : null,
    _fusionObservedModel: raw?.modelSource === "rollout-turn-context" ? model : null,
    _fusionObservedEffort: raw?.effortSource === "rollout-turn-context" ? effort : null,
    tokenUsage: raw?.tokenUsage ?? null,
    tokenUsageAvailability: raw?.tokenUsageAvailability ?? (raw?.tokenUsage ? "available" : "unavailable"),
    _fusionEvidence: "terminal-ledger",
    _fusionScopeKey: workspaceKey,
    _fusionRepositoryKey: nonEmptyString(raw?.repositoryKey) ?? repositoryKey
  };
}

function legacyTerminalLedgerRecords(keys, workspaceKey, repositoryKey = null) {
  const records = [];
  for (const key of keys) {
    if (typeof key !== "string") {
      continue;
    }
    const separator = key.lastIndexOf(":");
    if (separator <= 0) {
      continue;
    }
    const record = terminalLedgerRecord(
      { jobId: key.slice(0, separator), transportStatus: key.slice(separator + 1) },
      { workspaceKey, repositoryKey }
    );
    if (record) {
      record._fusionEvidence = "legacy-terminal-ledger";
      records.push(record);
    }
  }
  return records;
}

export function readCodexTerminalLedgerFiles(stateRoot) {
  const records = [];
  let entries;
  try {
    entries = fs.readdirSync(stateRoot).filter((entry) => entry.startsWith(TERMINAL_LEDGER_PREFIX) && entry.endsWith(".json"));
  } catch {
    return records;
  }
  for (const entry of entries) {
    const file = path.join(stateRoot, entry);
    const workspaceKey = terminalLedgerWorkspaceKey(file);
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(raw)) {
        records.push(...legacyTerminalLedgerRecords(raw, workspaceKey));
        continue;
      }
      const scopeRoot = nonEmptyString(raw?.workspaceRoot);
      const repositoryKey = nonEmptyString(raw?.repositoryKey);
      if (Array.isArray(raw?.records)) {
        for (const candidate of raw.records) {
          const record = terminalLedgerRecord(candidate, { workspaceRoot: scopeRoot, workspaceKey, repositoryKey });
          if (record) {
            records.push(record);
          }
        }
      } else if (Array.isArray(raw?.keys)) {
        records.push(...legacyTerminalLedgerRecords(raw.keys, workspaceKey, repositoryKey));
      }
    } catch {
      void 0;
    }
  }
  return records;
}

function readCodexJobEvidence(stateRoot, options = {}) {
  const roots = Object.hasOwn(options, "env") ? resolveCodexStateRoots(options.env) : [stateRoot];
  const compatibilityOverride = Object.hasOwn(options, "env") && !nonEmptyString(options.env.FUSION_CODEX_STATE) && Boolean(nonEmptyString(options.env.FUSION_CODEX_STATE_DIR));
  return roots.flatMap((root) => {
    const legacy = compatibilityOverride || path.basename(path.dirname(path.resolve(root))) === "codex-openai-codex";
    return [...readWorkspaceJobFiles(root), ...readCodexTerminalLedgerFiles(root)].map((record) => legacy ? { ...record, _fusionLegacySource: true } : record);
  });
}

function jobTimestamp(raw) {
  const parsed = Date.parse(raw?.finishedAt ?? raw?.completedAt ?? raw?.updatedAt ?? raw?.createdAt ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function preferJobCopy(current, candidate, isTerminal) {
  const currentTerminal = isTerminal(current);
  const candidateTerminal = isTerminal(candidate);
  if (currentTerminal !== candidateTerminal) {
    return candidateTerminal ? candidate : current;
  }
  const evidenceRank = { state: 2, "terminal-ledger": 1, "legacy-terminal-ledger": 0 };
  const currentRank = evidenceRank[current?._fusionEvidence] ?? 0;
  const candidateRank = evidenceRank[candidate?._fusionEvidence] ?? 0;
  if (currentRank !== candidateRank) {
    return candidateRank > currentRank ? candidate : current;
  }
  return jobTimestamp(candidate) > jobTimestamp(current) ? candidate : current;
}

function workspaceKeyMatchesRepository(workspaceKey, workspaceRoot, repositoryCache) {
  if (fusionWorkspaceKey(path.resolve(workspaceRoot)) === workspaceKey) {
    return true;
  }
  const commonDir = repositoryIdentity(workspaceRoot, repositoryCache);
  return commonDir && path.basename(commonDir) === ".git" && fusionWorkspaceKey(path.dirname(commonDir)) === workspaceKey;
}

function workspaceKeyMatchesRecordScope(workspaceKey, workspaceRoot, repositoryCache) {
  if (workspaceKeyMatchesRepository(workspaceKey, workspaceRoot, repositoryCache)) {
    return true;
  }
  let current = path.dirname(path.resolve(workspaceRoot));
  for (;;) {
    if (fusionWorkspaceKey(current) === workspaceKey) {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

function sameJobScope(left, right, repositoryCache) {
  const leftRepositoryKey = nonEmptyString(left?._fusionRepositoryKey);
  const rightRepositoryKey = nonEmptyString(right?._fusionRepositoryKey);
  const leftRoot = nonEmptyString(left?.workspaceRoot);
  const rightRoot = nonEmptyString(right?.workspaceRoot);
  if (left?._fusionLegacySource && right?._fusionLegacySource && leftRoot && rightRoot && path.resolve(leftRoot) === path.resolve(rightRoot)) {
    return true;
  }
  if (leftRepositoryKey && rightRepositoryKey) {
    return leftRepositoryKey === rightRepositoryKey;
  }
  if (leftRoot && rightRoot && path.resolve(leftRoot) === path.resolve(rightRoot) && isPathPositivelyAbsent(leftRoot)) {
    return Boolean(leftRepositoryKey || rightRepositoryKey);
  }
  if (leftRepositoryKey && rightRoot) {
    return leftRepositoryKey === fusionRepositoryKey(rightRoot, repositoryCache);
  }
  if (rightRepositoryKey && leftRoot) {
    return rightRepositoryKey === fusionRepositoryKey(leftRoot, repositoryCache);
  }
  if (leftRepositoryKey) {
    return Boolean(leftRoot && leftRepositoryKey === fusionRepositoryKey(leftRoot, repositoryCache) && right?._fusionScopeKey && workspaceKeyMatchesRecordScope(right._fusionScopeKey, leftRoot, repositoryCache));
  }
  if (rightRepositoryKey) {
    return Boolean(rightRoot && rightRepositoryKey === fusionRepositoryKey(rightRoot, repositoryCache) && left?._fusionScopeKey && workspaceKeyMatchesRecordScope(left._fusionScopeKey, rightRoot, repositoryCache));
  }
  if (left?._fusionScopeKey && right?._fusionScopeKey && left._fusionScopeKey === right._fusionScopeKey) {
    return true;
  }
  if (leftRoot && rightRoot && workspaceRootsShareRepository(leftRoot, rightRoot, repositoryCache)) {
    return true;
  }
  if (left?._fusionScopeKey && rightRoot && workspaceKeyMatchesRecordScope(left._fusionScopeKey, rightRoot, repositoryCache)) {
    return true;
  }
  if (right?._fusionScopeKey && leftRoot && workspaceKeyMatchesRecordScope(right._fusionScopeKey, leftRoot, repositoryCache)) {
    return true;
  }
  return false;
}

function mergeJobEvidence(preferred, records) {
  const merged = { ...preferred, request: preferred?.request && typeof preferred.request === "object" ? { ...preferred.request } : preferred?.request };
  merged._fusionWorkspaceRoots = [...new Set(records.flatMap((record) => Array.isArray(record?._fusionWorkspaceRoots) ? record._fusionWorkspaceRoots : [record?.workspaceRoot]).filter((value) => typeof value === "string" && value.trim()).map((value) => path.resolve(value)))];
  for (const record of records) {
    for (const field of ["workspaceRoot", "sessionId", "jobClass", "kind", "createdAt", "startedAt", "finishedAt", "completedAt", "updatedAt", "tokenUsage", "tokenUsageAvailability", "_fusionObservedModel", "_fusionObservedEffort", "_fusionScopeKey", "_fusionRepositoryKey"]) {
      if (merged[field] == null && record?.[field] != null) {
        merged[field] = record[field];
      }
    }
    if (record?.request && typeof record.request === "object") {
      merged.request = merged.request && typeof merged.request === "object" ? merged.request : {};
      for (const field of ["model", "effort"]) {
        if (merged.request[field] == null && record.request[field] != null) {
          merged.request[field] = record.request[field];
        }
      }
    }
  }
  return merged;
}

function selectPreferredJobs(jobs, descriptor, include) {
  if (!descriptor.dedupeById) {
    return jobs.filter(include);
  }
  const groups = [];
  const groupsById = new Map();
  const repositoryCache = new Map();
  for (const raw of jobs) {
    const id = typeof raw?.id === "string" && raw.id.trim() ? raw.id : null;
    if (!id) {
      groups.push({ records: [raw], preferred: raw });
      continue;
    }
    let idGroups = groupsById.get(id);
    if (!idGroups) {
      idGroups = [];
      groupsById.set(id, idGroups);
    }
    let group = idGroups.find((candidate) => candidate.records.some((record) => sameJobScope(record, raw, repositoryCache)));
    if (!group) {
      group = { records: [], preferred: raw };
      idGroups.push(group);
      groups.push(group);
    }
    group.records.push(raw);
    group.preferred = preferJobCopy(group.preferred, raw, descriptor.isTerminal);
  }
  return groups.flatMap((group) => {
    const included = group.records.filter(include);
    if (included.length === 0) {
      return [];
    }
    const preferred = included.slice(1).reduce((current, candidate) => preferJobCopy(current, candidate, descriptor.isTerminal), included[0]);
    return [mergeJobEvidence(preferred, included)];
  });
}

export const FILE_ENGINE_DESCRIPTORS = {
  codex: {
    id: "codex",
    stateEnvVar: "FUSION_CODEX_STATE",
    defaultStateRoot: resolveCodexStateDir,
    unavailableReason: "codex plugin job state not found; the codex plugin may not be installed",
    note: "read best effort from Codex job state and retained Fusion terminal ledgers; totals are lower bounds",
    enumerateJobs: readCodexJobEvidence,
    resolveScope: resolveGitWorkspaceRoot,
    matchesWorkspace(raw, cwd, workspaceRoot, repositoryCache) {
      if (raw?._fusionRepositoryKey) {
        return raw._fusionRepositoryKey === fusionRepositoryKey(workspaceRoot, repositoryCache);
      }
      if (workspaceRootsShareRepository(raw?.workspaceRoot, workspaceRoot, repositoryCache)) {
        return true;
      }
      return raw?._fusionScopeKey && workspaceKeyMatchesRepository(raw._fusionScopeKey, workspaceRoot, repositoryCache);
    },
    includeByModel: true,
    dedupeById: true,
    isTerminal: (raw) => CODEX_TERMINAL_STATUSES.has(raw.status),
    normalizeJob(raw) {
      const finished = raw.finishedAt ?? raw.completedAt ?? raw.updatedAt ?? null;
      let durationSeconds = null;
      if (CODEX_TERMINAL_STATUSES.has(raw.status) && raw.startedAt && finished) {
        const span = (Date.parse(finished) - Date.parse(raw.startedAt)) / 1000;
        if (Number.isFinite(span) && span >= 0) {
          durationSeconds = span;
        }
      }
      return {
        status: raw.status ?? "unknown",
        kind: raw.jobClass ?? raw.kind ?? "unknown",
        createdAt: raw.createdAt ?? null,
        durationSeconds,
        evidence: raw._fusionEvidence ?? "state"
      };
    },
    resolveModel(raw, observation) {
      return resolveCodexJobModel(raw, observation);
    },
    resolveEffort(raw, observation) {
      return resolveCodexJobEffort(raw, observation);
    }
  }
};

function workspaceRootsForJob(raw) {
  return [...new Set([...(Array.isArray(raw?._fusionWorkspaceRoots) ? raw._fusionWorkspaceRoots : []), raw?.workspaceRoot].filter((value) => typeof value === "string" && value.trim()).map((value) => path.resolve(value)))];
}

function observationForJob(raw, env, auditCache) {
  const workspaceRoots = workspaceRootsForJob(raw);
  if (workspaceRoots.length === 0) {
    return null;
  }
  const jobId = typeof raw?.id === "string" ? raw.id : null;
  if (!jobId) {
    return null;
  }
  let selected = null;
  for (const workspaceRoot of workspaceRoots) {
    if (!auditCache.has(workspaceRoot)) {
      auditCache.set(workspaceRoot, loadModelAuditObservations(modelAuditSidecarPath(workspaceRoot, env)));
    }
    const candidate = auditCache.get(workspaceRoot).get(jobId);
    if (candidate && (!selected || modelObservationRank(candidate) > modelObservationRank(selected) || (modelObservationRank(candidate) === modelObservationRank(selected) && observationTimestamp(candidate) > observationTimestamp(selected)))) {
      selected = candidate;
    }
  }
  return selected;
}

function loadAllObservationCandidates(env, filename, loader) {
  const observations = new Map();
  const root = path.join(resolveFusionDataDir(env), "observations");
  let workspaces;
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return observations;
  }
  for (const workspace of workspaces) {
    for (const [jobId, candidate] of loader(path.join(root, workspace.name, filename))) {
      const candidates = observations.get(jobId) ?? [];
      candidates.push({ ...candidate, _fusionObservationScopeKey: workspace.name });
      observations.set(jobId, candidates);
    }
  }
  return observations;
}

function observationMatchesJobScope(observation, raw, repositoryCache) {
  const roots = workspaceRootsForJob(raw);
  const observationRepositoryKey = nonEmptyString(observation?.repositoryKey);
  const jobRepositoryKey = nonEmptyString(raw?._fusionRepositoryKey);
  if (observationRepositoryKey && jobRepositoryKey) {
    return observationRepositoryKey === jobRepositoryKey;
  }
  if (observationRepositoryKey && roots.length > 0) {
    return roots.some((root) => observationRepositoryKey === fusionRepositoryKey(root, repositoryCache));
  }
  const observationRoot = nonEmptyString(observation?.workspaceRoot);
  if (jobRepositoryKey && observationRoot) {
    return jobRepositoryKey === fusionRepositoryKey(observationRoot, repositoryCache);
  }
  const scopeKey = nonEmptyString(observation?._fusionObservationScopeKey);
  if (!observationRepositoryKey && !observationRoot && scopeKey && (scopeKey === raw?._fusionScopeKey || roots.some((root) => fusionWorkspaceKey(root) === scopeKey))) {
    return true;
  }
  if (jobRepositoryKey || observationRepositoryKey) {
    return false;
  }
  if (observationRoot && roots.some((root) => workspaceRootsShareRepository(observationRoot, root, repositoryCache))) {
    return true;
  }
  return Boolean(scopeKey) && (scopeKey === raw?._fusionScopeKey || roots.some((root) => fusionWorkspaceKey(root) === scopeKey));
}

function scopedObservationForJob(observations, raw, repositoryCache) {
  const jobId = nonEmptyString(raw?.id);
  if (!jobId) {
    return null;
  }
  let selected = null;
  for (const candidate of observations.get(jobId) ?? []) {
    if (observationMatchesJobScope(candidate, raw, repositoryCache) && (!selected || observationTimestamp(candidate) >= observationTimestamp(selected))) {
      selected = candidate;
    }
  }
  return selected;
}

function integerTokenField(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function normalizeCodexTokenUsage(value) {
  const raw = value?.total_token_usage ?? value?.totalTokenUsage ?? value;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const usage = {
    inputTokens: integerTokenField(raw.inputTokens ?? raw.input_tokens),
    cachedInputTokens: integerTokenField(raw.cachedInputTokens ?? raw.cached_input_tokens),
    outputTokens: integerTokenField(raw.outputTokens ?? raw.output_tokens),
    reasoningOutputTokens: integerTokenField(raw.reasoningOutputTokens ?? raw.reasoning_output_tokens),
    totalTokens: integerTokenField(raw.totalTokens ?? raw.total_tokens)
  };
  if (Object.values(usage).some((field) => field == null)) {
    return null;
  }
  if (usage.cachedInputTokens > usage.inputTokens || usage.reasoningOutputTokens > usage.outputTokens) {
    return null;
  }
  return usage.totalTokens === usage.inputTokens + usage.outputTokens ? usage : null;
}

function tokenUsageForJob(raw, observation) {
  const candidates = [raw?.tokenUsage, raw?.usage, raw?.result?.tokenUsage, raw?.result?.usage, observation?.tokenUsage, observation?.usage];
  for (const candidate of candidates) {
    const normalized = normalizeCodexTokenUsage(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

export function fileBasedEngineStats(descriptor, { all = false, env = process.env, cwd = process.cwd() } = {}) {
  const root = resolveStateRoot(descriptor, env);
  const availableRoots = descriptor.id === "codex" ? resolveCodexStateRoots(env) : [root];
  if (!availableRoots.some((candidate) => fs.existsSync(candidate))) {
    return { available: false, reason: descriptor.unavailableReason };
  }
  let jobs;
  try {
    jobs = descriptor.enumerateJobs(root, { all, env, cwd });
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const workspaceRoot = typeof descriptor.resolveScope === "function" ? descriptor.resolveScope(cwd) : cwd;
  const repositoryCache = new Map();
  const include = (job) => all || descriptor.matchesWorkspace(job, cwd, workspaceRoot, repositoryCache);
  const candidates = all
    ? jobs
    : jobs.map((job) => include(job) && !job?._fusionScopeKey ? { ...job, _fusionScopeKey: fusionWorkspaceKey(workspaceRoot) } : job);
  const scoped = selectPreferredJobs(candidates, descriptor, include);
  const byStatus = {};
  const byKind = {};
  const byModel = {};
  const byEffort = {};
  const byAcceptance = {};
  const byEvidence = {};
  const auditCache = new Map();
  const tokenObservations = descriptor.id === "codex" ? loadAllObservationCandidates(env, TOKEN_USAGE_FILENAME, loadTokenUsageObservations) : new Map();
  const acceptanceObservations = descriptor.id === "codex" ? loadAllObservationCandidates(env, ACCEPTANCE_FILENAME, loadAcceptanceObservations) : new Map();
  const observationRepositoryCache = new Map();
  const tokenTotals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  let jobsWithTokenUsage = 0;
  let jobsWithoutTokenUsage = 0;
  let pendingTransportJobs = 0;
  let durationSum = 0;
  let durationCount = 0;
  let earliest = null;
  let latest = null;
  for (const raw of scoped) {
    const job = descriptor.normalizeJob(raw);
    bump(byStatus, job.status);
    bump(byKind, job.kind);
    bump(byEvidence, job.evidence ?? "state");
    if (descriptor.includeByModel && typeof descriptor.resolveModel === "function") {
      const observation = observationForJob(raw, env, auditCache);
      const model = descriptor.resolveModel(raw, observation);
      const effort = typeof descriptor.resolveEffort === "function" ? descriptor.resolveEffort(raw, observation) : null;
      bump(byModel, effort ? `${model}@${effort}` : model);
      bump(byEffort, effort ?? "unavailable");
    }
    if (descriptor.id === "codex") {
      const jobId = nonEmptyString(raw?.id);
      if (CODEX_TERMINAL_STATUSES.has(job.status)) {
        const acceptance = jobId ? scopedObservationForJob(acceptanceObservations, raw, observationRepositoryCache)?.acceptance : null;
        bump(byAcceptance, CODEX_ACCEPTANCE_STATES.has(acceptance) ? acceptance : "unverified");
      } else {
        pendingTransportJobs += 1;
      }
      if (CODEX_TERMINAL_STATUSES.has(job.status)) {
        const usage = tokenUsageForJob(raw, jobId ? scopedObservationForJob(tokenObservations, raw, observationRepositoryCache) : null);
        if (usage) {
          jobsWithTokenUsage += 1;
          for (const key of Object.keys(tokenTotals)) {
            tokenTotals[key] += usage[key];
          }
        } else {
          jobsWithoutTokenUsage += 1;
        }
      }
    }
    if (job.durationSeconds != null) {
      durationSum += job.durationSeconds;
      durationCount += 1;
    }
    const created = job.createdAt;
    if (created) {
      if (!earliest || created < earliest) {
        earliest = created;
      }
      if (!latest || created > latest) {
        latest = created;
      }
    }
  }
  return {
    available: true,
    scope: all ? "all" : workspaceRoot,
    totalJobs: scoped.length,
    byStatus,
    ...(descriptor.id === "codex" ? { byTransportStatus: { ...byStatus }, byAcceptance, acceptanceScope: "terminal transport jobs only", pendingTransportJobs, byEffort } : {}),
    byKind,
    ...(descriptor.includeByModel ? { byModel } : {}),
    ...(descriptor.id === "codex"
      ? {
          tokenUsage: {
            availability: jobsWithTokenUsage === 0 ? "unavailable" : jobsWithoutTokenUsage === 0 ? "available" : "partial",
            scope: "terminal transport jobs only",
            jobsWithUsage: jobsWithTokenUsage,
            jobsWithoutUsage: jobsWithoutTokenUsage,
            totals: jobsWithTokenUsage > 0 ? tokenTotals : null
          },
          evidence: {
            bySource: byEvidence,
            recoveredTerminalJobs: byEvidence["terminal-ledger"] ?? 0,
            recoveredLegacyTerminalJobs: byEvidence["legacy-terminal-ledger"] ?? 0,
            isLowerBound: true
          }
        }
      : {}),
    meanWallClockSeconds: durationCount > 0 ? Math.round((durationSum / durationCount) * 1000) / 1000 : null,
    earliestCreatedAt: earliest,
    latestCreatedAt: latest,
    note: descriptor.note
  };
}

export function codexStats(options = {}) {
  return fileBasedEngineStats(FILE_ENGINE_DESCRIPTORS.codex, options);
}

function listWorkspaceEntries(stateRoot) {
  if (!fs.existsSync(stateRoot)) {
    return [];
  }
  return fs
    .readdirSync(stateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function readJobFilesInWorkspace(stateRoot, workspace) {
  const dir = path.join(stateRoot, workspace, "jobs");
  if (!fs.existsSync(dir)) {
    return [];
  }
  const jobs = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    try {
      jobs.push(JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")));
    } catch {
      void 0;
    }
  }
  return jobs;
}

export const WORKSPACE_ENGINE_DESCRIPTORS = [
  {
    id: "grok",
    displayName: "Grok",
    unavailableReason: "grok plugin job state not found; the grok plugin may not be installed",
    resolveRoot: (env) => path.join(resolveGrokDataDir(env), "state"),
    cwdOf: (raw) => (typeof raw.cwd === "string" ? raw.cwd : null),
    sessionOf: (raw) => (typeof raw.claudeSessionId === "string" ? raw.claudeSessionId : null),
    isLive: (raw) => !GROK_TERMINAL_STATUSES.has(raw.status)
  },
  {
    id: "codex",
    displayName: "Codex",
    unavailableReason: FILE_ENGINE_DESCRIPTORS.codex.unavailableReason,
    resolveRoot: (env) => resolveStateRoot(FILE_ENGINE_DESCRIPTORS.codex, env),
    cwdOf: (raw) => (typeof raw.workspaceRoot === "string" ? raw.workspaceRoot : null),
    sessionOf: (raw) => nonEmptyString(raw?.sessionId) ?? nonEmptyString(raw?.claudeSessionId),
    isLive: (raw) => !CODEX_TERMINAL_STATUSES.has(raw.status),
    dedupeById: true,
    isTerminal: (raw) => CODEX_TERMINAL_STATUSES.has(raw.status)
  }
];

function readGuardSessionState(env, sessionId) {
  if (!sessionId) {
    return null;
  }
  const stateDir = resolveGuardStateDir(env);
  const file = guardStateFile(stateDir, sessionId);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        writeCount: Number.isFinite(parsed.writeCount) ? parsed.writeCount : 0,
        dispatches: parsed.dispatches && typeof parsed.dispatches === "object" ? { ...parsed.dispatches } : {},
        source: "session state",
        malformedCount: 0
      };
    }
  } catch {
    void 0;
  }
  const audit = readGuardAuditEvents({ env, sessionId });
  if (audit.events.length === 0) {
    return null;
  }
  const dispatches = {};
  let writeCount = 0;
  for (const event of audit.events) {
    if (event.event === "write") {
      writeCount += 1;
    } else if (event.event === "dispatch") {
      bump(dispatches, event.lane);
    }
  }
  return { writeCount, dispatches, source: "long term audit", malformedCount: audit.malformedCount };
}

function readGuardDispatchLog(env, sessionId) {
  if (!sessionId) {
    return [];
  }
  const stateDir = resolveGuardStateDir(env);
  const file = guardStateFile(stateDir, sessionId);
  let stateEntries = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    stateEntries = Array.isArray(parsed?.dispatchLog) ? parsed.dispatchLog : [];
  } catch {
    void 0;
  }
  const auditEntries = readGuardAuditEvents({ env, sessionId }).events
    .filter((event) => event.event === "dispatch")
    .map((event) => ({ at: event.at, lane: event.lane, ...(event.description ? { description: event.description } : {}) }));
  const merged = new Map();
  for (const entry of [...auditEntries, ...stateEntries]) {
    const key = `${entry?.at ?? ""}\u0000${entry?.lane ?? ""}\u0000${entry?.description ?? ""}`;
    merged.set(key, entry);
  }
  return [...merged.values()].sort((left, right) => (traceTimestamp(left?.at) ?? 0) - (traceTimestamp(right?.at) ?? 0));
}

function positiveAuditDays(value) {
  if (value == null) {
    return 7;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 3650) {
    throw new TypeError("Fusion audit days must be an integer from 1 to 3650.");
  }
  return parsed;
}

export function buildAuditReport({ env = process.env, sessionId = null, days = 7, all = false, now = Date.now() } = {}) {
  const windowDays = all ? null : positiveAuditDays(days);
  const sinceMs = all ? null : now - windowDays * 24 * 60 * 60 * 1000;
  const { events, malformedCount } = readGuardAuditEvents({ env, sessionId, sinceMs, untilMs: now });
  const windowLabel = all ? "all retained audit events" : `last ${windowDays} ${windowDays === 1 ? "day" : "days"}`;
  const byEvent = {};
  const dispatchesByLane = {};
  const sessions = new Set();
  for (const event of events) {
    bump(byEvent, event.event);
    sessions.add(event.session);
    if (event.event === "dispatch") {
      bump(dispatchesByLane, event.lane);
    }
  }
  return {
    scope: sessionId ? `session ${sessionId}, ${windowLabel}` : windowLabel,
    sessionId,
    days: windowDays,
    totalEvents: events.length,
    sessionCount: sessions.size,
    byEvent,
    dispatchesByLane,
    earliestAt: events[0]?.at ?? null,
    latestAt: events.at(-1)?.at ?? null,
    malformedCount
  };
}

export function renderAuditReport(report) {
  const lines = ["# Fusion inline audit", "", `Scope: ${report.scope}`, "", `Total events: ${report.totalEvents}`, `Sessions: ${report.sessionCount}`];
  if (report.earliestAt && report.latestAt) {
    lines.push(`Recorded between ${report.earliestAt} and ${report.latestAt}`);
  }
  renderCounts(lines, "By event", report.byEvent);
  renderCounts(lines, "Dispatches by lane", report.dispatchesByLane);
  if (report.malformedCount > 0) {
    lines.push("", `Malformed audit entries skipped: ${report.malformedCount}`);
  }
  return `${lines.join("\n")}\n`;
}

function traceTimestamp(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function truncateTraceDescription(value) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 120) : null;
}

function dispatchTraceEntries(env, sessionId) {
  const entries = [];
  for (const entry of readGuardDispatchLog(env, sessionId)) {
    const timestamp = traceTimestamp(entry?.at);
    if (timestamp == null) {
      continue;
    }
    const description = truncateTraceDescription(entry.description);
    entries.push({
      time: entry.at,
      timestamp,
      source: "dispatch",
      lane: typeof entry.lane === "string" && entry.lane ? entry.lane : "unknown",
      ...(typeof entry.subagentType === "string" && entry.subagentType ? { subagentType: entry.subagentType } : {}),
      ...(description ? { description } : {})
    });
  }
  return entries;
}

function traceWorkspaceJobs(descriptor, env) {
  if (!descriptor) {
    return [];
  }
  const root = descriptor.resolveRoot(env);
  const availableRoots = descriptor.id === "codex" ? resolveCodexStateRoots(env) : [root];
  if (!availableRoots.some((candidate) => fs.existsSync(candidate))) {
    return [];
  }
  try {
    if (descriptor.id === "codex") {
      return readCodexJobEvidence(root, { env });
    }
    const jobs = [];
    for (const workspace of listWorkspaceEntries(root)) {
      jobs.push(...readJobFilesInWorkspace(root, workspace));
    }
    return jobs;
  } catch {
    return [];
  }
}

function resolveTraceGitRoot(cwd) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (!result.error && result.status === 0 && result.stdout.trim()) {
    return path.resolve(result.stdout.trim());
  }
  return path.resolve(cwd);
}

function formatTraceModel(model, effort) {
  if (!model) {
    return effort ? `unknown@${effort}` : null;
  }
  return effort ? `${model}@${effort}` : model;
}

function engineTraceEntry(raw, { engine, join, model, effort }) {
  const timestamp = traceTimestamp(raw?.createdAt);
  if (timestamp == null) {
    return null;
  }
  return {
    time: raw.createdAt,
    timestamp,
    source: "engine job",
    engine,
    join,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    status: raw.status ?? "unknown"
  };
}

function traceSpan(entries) {
  if (entries.length === 0) {
    return null;
  }
  const timestamps = entries.map((entry) => entry.timestamp);
  return { start: Math.min(...timestamps) - 60 * 1000, end: Math.max(...timestamps) + 60 * 60 * 1000 };
}

export function buildTraceReport({ env = process.env, cwd = process.cwd(), sessionId = env.CLAUDE_CODE_SESSION_ID || null } = {}) {
  if (!sessionId) {
    return { available: false, reason: "CLAUDE_CODE_SESSION_ID is unset", sessionId: null, workspaceRoot: null, timeline: [] };
  }

  const gitRoot = resolveTraceGitRoot(cwd);
  const dispatches = dispatchTraceEntries(env, sessionId);
  const timeline = [...dispatches];
  const grokDescriptor = WORKSPACE_ENGINE_DESCRIPTORS.find((descriptor) => descriptor.id === "grok");
  if (grokDescriptor) {
    for (const raw of traceWorkspaceJobs(grokDescriptor, env)) {
      if (raw?.claudeSessionId !== sessionId) {
        continue;
      }
      const model = nonEmptyString(raw?.request?.model);
      const effort = nonEmptyString(raw?.request?.effort);
      const entry = engineTraceEntry(raw, { engine: "grok", join: "exact", model, effort });
      if (entry) {
        timeline.push(entry);
      }
    }
  }

  const span = traceSpan(dispatches);
  const codexDescriptor = WORKSPACE_ENGINE_DESCRIPTORS.find((descriptor) => descriptor.id === "codex");
  if (codexDescriptor) {
    const repositoryCache = new Map();
    const codexJobs = traceWorkspaceJobs(codexDescriptor, env).filter((raw) => FILE_ENGINE_DESCRIPTORS.codex.matchesWorkspace(raw, cwd, gitRoot, repositoryCache));
    const auditCache = new Map();
    for (const raw of selectPreferredJobs(codexJobs, FILE_ENGINE_DESCRIPTORS.codex, () => true)) {
      const recordedSessionId = nonEmptyString(raw?.sessionId) ?? nonEmptyString(raw?.claudeSessionId);
      const createdAt = traceTimestamp(raw?.createdAt);
      const exact = recordedSessionId === sessionId;
      const approximate = !recordedSessionId && span && createdAt != null && createdAt >= span.start && createdAt <= span.end;
      if (!exact && !approximate) {
        continue;
      }
      const observation = observationForJob(raw, env, auditCache);
      const model = resolveCodexJobModel(raw, observation);
      const effort = resolveCodexJobEffort(raw, observation);
      const entry = engineTraceEntry(raw, { engine: "codex", join: exact ? "exact" : "approximate", model, effort });
      if (entry) {
        timeline.push(entry);
      }
    }
  }

  timeline.sort((left, right) => left.timestamp - right.timestamp || left.source.localeCompare(right.source));
  return {
    available: true,
    sessionId,
    workspaceRoot: gitRoot,
    timeline: timeline.map(({ timestamp, ...entry }) => entry)
  };
}

export function renderTraceReport(report) {
  const lines = ["# Fusion session trace", "", `Session: ${report.sessionId ?? "unset"}`];
  if (!report.available) {
    lines.push("", `Session data unavailable: ${report.reason}`);
    return `${lines.join("\n")}\n`;
  }
  lines.push("", `Workspace root: ${report.workspaceRoot}`, "", "Time | Source | Lane or engine | Model@effort | Status | Description");
  if (report.timeline.length === 0) {
    lines.push("no dispatches or matching engine jobs recorded");
  } else {
    for (const entry of report.timeline) {
      const subject = entry.source === "dispatch" ? entry.lane : `${entry.engine}${entry.join === "approximate" ? " (approximate)" : ""}`;
      lines.push(`${entry.time} | ${entry.source} | ${subject} | ${formatTraceModel(entry.model, entry.effort) ?? ""} | ${entry.status ?? ""} | ${entry.description ?? ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function sessionScopedEngineStats(descriptor, sessionId, env) {
  const root = descriptor.resolveRoot(env);
  const availableRoots = descriptor.id === "codex" ? resolveCodexStateRoots(env) : [root];
  if (!availableRoots.some((candidate) => fs.existsSync(candidate))) {
    return { available: false, reason: descriptor.unavailableReason };
  }
  const byStatus = {};
  const byAcceptance = {};
  let totalJobs = 0;
  let pendingTransportJobs = 0;
  if (sessionId) {
    let jobs;
    if (descriptor.id === "codex") {
      jobs = readCodexJobEvidence(root, { env });
    } else {
      jobs = [];
      for (const workspace of listWorkspaceEntries(root)) {
        for (const raw of readJobFilesInWorkspace(root, workspace)) {
          jobs.push(raw);
        }
      }
    }
    const scoped = selectPreferredJobs(jobs, descriptor, (raw) => descriptor.sessionOf(raw) === sessionId);
    const acceptanceObservations = descriptor.id === "codex" ? loadAllObservationCandidates(env, ACCEPTANCE_FILENAME, loadAcceptanceObservations) : new Map();
    const observationRepositoryCache = new Map();
    totalJobs = scoped.length;
    for (const raw of scoped) {
      const status = raw.status ?? "unknown";
      bump(byStatus, status);
      if (descriptor.id === "codex") {
        if (CODEX_TERMINAL_STATUSES.has(status)) {
          const acceptance = scopedObservationForJob(acceptanceObservations, raw, observationRepositoryCache)?.acceptance;
          bump(byAcceptance, CODEX_ACCEPTANCE_STATES.has(acceptance) ? acceptance : "unverified");
        } else {
          pendingTransportJobs += 1;
        }
      }
    }
  }
  return {
    available: true,
    totalJobs,
    byStatus,
    ...(descriptor.id === "codex" ? { byTransportStatus: { ...byStatus }, byAcceptance, acceptanceScope: "terminal transport jobs only", pendingTransportJobs } : {})
  };
}

export function buildSessionReport({ env = process.env, sessionId = env.CLAUDE_CODE_SESSION_ID || null } = {}) {
  const engines = {};
  if (!sessionId) {
    const reason = "CLAUDE_CODE_SESSION_ID is unset";
    for (const descriptor of WORKSPACE_ENGINE_DESCRIPTORS) {
      engines[descriptor.id] = { available: false, reason };
    }
    return { available: false, reason, sessionId, guard: null, engines };
  }
  for (const descriptor of WORKSPACE_ENGINE_DESCRIPTORS) {
    engines[descriptor.id] = sessionScopedEngineStats(descriptor, sessionId, env);
  }
  return { available: true, sessionId, guard: readGuardSessionState(env, sessionId), engines };
}

export function renderSessionReport(report) {
  const lines = ["# Fusion session stats", "", `Session: ${report.sessionId ?? "unset"}`, "", "## Inline guard"];
  if (report.available === false) {
    lines.push("", `Session data unavailable: ${report.reason}`, "", "no dispatches recorded");
  } else if (!report.guard) {
    lines.push("", "no dispatches recorded");
  } else {
    lines.push("", `Write tool calls: ${report.guard.writeCount}`);
    renderCounts(lines, "Agent dispatches by lane", report.guard.dispatches);
    if (report.guard.source === "long term audit") {
      lines.push("", "Guard source: long term audit (short lived session state unavailable)");
    }
    if (report.guard.malformedCount > 0) {
      lines.push(`Malformed audit entries skipped: ${report.guard.malformedCount}`);
    }
  }
  for (const descriptor of WORKSPACE_ENGINE_DESCRIPTORS) {
    const stats = report.engines[descriptor.id];
    lines.push("", `## ${descriptor.displayName} jobs (session scope)`);
    if (!stats.available) {
      lines.push("", `Unavailable: ${stats.reason}`);
      continue;
    }
    lines.push("", `Total jobs: ${stats.totalJobs}`);
    renderCounts(lines, stats.byTransportStatus ? "By transport status" : "By status", stats.byTransportStatus ?? stats.byStatus);
    renderCounts(lines, "By semantic acceptance", stats.byAcceptance ?? {});
    if (stats.acceptanceScope) {
      lines.push("", `Semantic acceptance scope: ${stats.acceptanceScope}; ${stats.pendingTransportJobs} non-terminal job${stats.pendingTransportJobs === 1 ? "" : "s"} excluded`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function isWorkspaceDead(jobs, descriptor) {
  for (const raw of jobs) {
    if (descriptor.isLive(raw)) {
      return false;
    }
    const cwd = descriptor.cwdOf(raw);
    if (typeof cwd !== "string" || !cwd.trim() || !path.isAbsolute(cwd) || !isPathPositivelyAbsent(cwd)) {
      return false;
    }
  }
  return true;
}

function isPathPositivelyAbsent(target) {
  try {
    fs.statSync(target);
    return false;
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR";
  }
}

function readPruneSnapshot(stateRoot, workspace) {
  const dir = path.join(stateRoot, workspace, "jobs");
  try {
    const initialStat = fs.statSync(dir);
    if (!initialStat.isDirectory()) {
      return null;
    }
    const entries = fs.readdirSync(dir).sort();
    const jobEntries = entries.filter((entry) => entry.endsWith(".json"));
    if (jobEntries.length === 0) {
      return null;
    }
    const jobs = jobEntries.map((entry) => JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")));
    const verifiedEntries = fs.readdirSync(dir).sort();
    const verifiedStat = fs.statSync(dir);
    if (initialStat.mtimeMs !== verifiedStat.mtimeMs || entries.length !== verifiedEntries.length || entries.some((entry, index) => entry !== verifiedEntries[index])) {
      return null;
    }
    return { dir, entries, jobs, mtimeMs: verifiedStat.mtimeMs };
  } catch {
    return null;
  }
}

function sameEntries(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function stillSafeToPrune(candidate, descriptor) {
  const evidence = candidate[PRUNE_EVIDENCE];
  if (!evidence) {
    return false;
  }
  const current = readPruneSnapshot(evidence.stateRoot, candidate.workspace);
  return current !== null && current.mtimeMs === evidence.mtimeMs && sameEntries(current.entries, evidence.entries) && isWorkspaceDead(current.jobs, descriptor);
}

function scanDeadWorkspaces(descriptor, env) {
  const root = descriptor.resolveRoot(env);
  if (!fs.existsSync(root)) {
    return [];
  }
  const candidates = [];
  for (const workspace of listWorkspaceEntries(root)) {
    const snapshot = readPruneSnapshot(root, workspace);
    if (!snapshot || !isWorkspaceDead(snapshot.jobs, descriptor)) {
      continue;
    }
    const candidate = { workspace, dir: path.join(root, workspace), jobCount: snapshot.jobs.length };
    Object.defineProperty(candidate, PRUNE_EVIDENCE, {
      value: { stateRoot: root, entries: snapshot.entries, mtimeMs: snapshot.mtimeMs }
    });
    candidates.push(candidate);
  }
  return candidates;
}

export function findDeadWorkspaces(env = process.env) {
  const dead = {};
  for (const descriptor of WORKSPACE_ENGINE_DESCRIPTORS) {
    dead[descriptor.id] = scanDeadWorkspaces(descriptor, env);
  }
  return dead;
}

export function pruneDeadWorkspaces({ env = process.env, yes = false, beforeRemove } = {}) {
  const dead = findDeadWorkspaces(env);
  if (!yes) {
    return { applied: false, dead };
  }
  const removed = {};
  for (const [engineId, candidates] of Object.entries(dead)) {
    removed[engineId] = [];
    const descriptor = WORKSPACE_ENGINE_DESCRIPTORS.find((entry) => entry.id === engineId);
    for (const candidate of candidates) {
      if (beforeRemove) {
        beforeRemove(candidate, descriptor);
      }
      if (!descriptor || !stillSafeToPrune(candidate, descriptor)) {
        continue;
      }
      fs.rmSync(candidate.dir, { recursive: true, force: true });
      removed[engineId].push(candidate);
    }
  }
  return { applied: true, dead: removed };
}

export function renderPruneReport(result) {
  const lines = [`# Fusion dead workspace ${result.applied ? "prune" : "prune (dry run)"}`];
  for (const descriptor of WORKSPACE_ENGINE_DESCRIPTORS) {
    const candidates = result.dead[descriptor.id] ?? [];
    lines.push("", `## ${descriptor.displayName}`);
    if (candidates.length === 0) {
      lines.push("", "no dead workspace directories found");
      continue;
    }
    lines.push("");
    for (const candidate of candidates) {
      lines.push(`- ${candidate.dir} (${candidate.jobCount} job${candidate.jobCount === 1 ? "" : "s"})`);
    }
  }
  lines.push(
    "",
    result.applied
      ? "removed the directories listed above"
      : "dry run: rerun with --prune-dead --yes to delete these directories"
  );
  return `${lines.join("\n")}\n`;
}

export const STATS_PROVIDER_REGISTRY = [
  {
    id: "grok",
    displayName: "Grok",
    collect: (options) => grokStats(options)
  },
  {
    id: "codex",
    displayName: "Codex",
    collect: (options) => fileBasedEngineStats(FILE_ENGINE_DESCRIPTORS.codex, options)
  }
];

function renderCounts(lines, title, map) {
  const keys = Object.keys(map);
  if (keys.length === 0) {
    return;
  }
  lines.push("", `${title}:`);
  for (const key of keys.sort()) {
    lines.push(`- ${key}: ${map[key]}`);
  }
}

function renderEngine(lines, name, stats) {
  lines.push("", `## ${name}`);
  if (!stats.available) {
    lines.push("", `Unavailable: ${stats.reason}`);
    return;
  }
  lines.push("", `Total jobs: ${stats.totalJobs}`);
  if (stats.earliestCreatedAt && stats.latestCreatedAt) {
    lines.push(`Created between ${stats.earliestCreatedAt} and ${stats.latestCreatedAt}`);
  }
  if (stats.meanWallClockSeconds != null) {
    lines.push(`Mean wall clock for successful transport completions: ${stats.meanWallClockSeconds}s`);
  }
  renderCounts(lines, stats.byTransportStatus ? "By transport status" : "By status", stats.byTransportStatus ?? stats.byStatus ?? {});
  renderCounts(lines, "By semantic acceptance", stats.byAcceptance ?? {});
  if (stats.acceptanceScope) {
    lines.push("", `Semantic acceptance scope: ${stats.acceptanceScope}; ${stats.pendingTransportJobs} non-terminal job${stats.pendingTransportJobs === 1 ? "" : "s"} excluded`);
  }
  renderCounts(lines, "By mode", stats.byMode ?? {});
  renderCounts(lines, "By kind", stats.byKind ?? {});
  renderCounts(lines, "By model", stats.byModel ?? {});
  renderCounts(lines, "By effort", stats.byEffort ?? {});
  renderCounts(lines, "By failure kind", stats.byFailureKind ?? {});
  if (stats.tokenUsage) {
    const scope = stats.tokenUsage.scope ? `, ${stats.tokenUsage.scope}` : "";
    lines.push("", `Exact token usage coverage${scope}: ${stats.tokenUsage.availability} (${stats.tokenUsage.jobsWithUsage} available, ${stats.tokenUsage.jobsWithoutUsage} unavailable)`);
    if (stats.tokenUsage.totals) {
      lines.push(`Observed tokens: ${stats.tokenUsage.totals.totalTokens} total, ${stats.tokenUsage.totals.inputTokens} input, ${stats.tokenUsage.totals.cachedInputTokens} cached input, ${stats.tokenUsage.totals.outputTokens} output, ${stats.tokenUsage.totals.reasoningOutputTokens} reasoning output`);
    }
  }
  if (stats.usageCoverage || Object.hasOwn(stats, "usage")) {
    const completeJobs = stats.usageCoverage?.completeJobs ?? stats.usage?.reportedJobs ?? 0;
    const incompleteJobs = stats.usageCoverage?.incompleteJobs ?? 0;
    const unreportedJobs = stats.usageCoverage?.unreportedJobs ?? Math.max(0, (stats.totalJobs ?? 0) - completeJobs - incompleteJobs);
    const availability = stats.usageCoverage?.availability ?? (completeJobs === 0 ? "unavailable" : completeJobs === (stats.totalJobs ?? 0) ? "available" : "partial");
    lines.push("", `Exact token usage coverage: ${availability} (${completeJobs} complete, ${incompleteJobs} incomplete, ${unreportedJobs} unreported)`);
    if (stats.usage && completeJobs > 0) {
      lines.push(`Observed tokens: ${stats.usage.totalTokens} total, ${stats.usage.inputTokens} input, ${stats.usage.cacheReadInputTokens} cached input, ${stats.usage.outputTokens} output, ${stats.usage.reasoningTokens} reasoning output`);
    }
  }
  if (stats.evidence?.recoveredTerminalJobs || stats.evidence?.recoveredLegacyTerminalJobs) {
    lines.push("", `Recovered from retained terminal ledgers: ${stats.evidence.recoveredTerminalJobs + stats.evidence.recoveredLegacyTerminalJobs}`);
  }
}

export function buildFusionStats({ all = false, env = process.env, cwd = process.cwd() } = {}) {
  const options = { all, env, cwd };
  const engines = {};
  for (const provider of STATS_PROVIDER_REGISTRY) {
    engines[provider.id] = provider.collect(options);
  }
  return {
    scope: all ? "all" : resolveGitWorkspaceRoot(cwd),
    ...engines
  };
}

export function renderFusionStats(report) {
  const lines = ["# Fusion stats", "", `Scope: ${report.scope === "all" ? "all workspaces" : `workspace ${report.scope}`}`];
  for (const provider of STATS_PROVIDER_REGISTRY) {
    renderEngine(lines, provider.displayName, report[provider.id]);
  }
  lines.push("", "Peer token totals include only jobs with exact reported usage. Unavailable jobs are never estimated.");
  return `${lines.join("\n")}\n`;
}

function argumentValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  const value = argv[index + 1];
  return typeof value === "string" && value && !value.startsWith("--") ? value : null;
}

function sessionIdFromArgs(argv, env) {
  const index = argv.indexOf("--session");
  const selected = index === -1 ? null : argv[index + 1];
  return typeof selected === "string" && selected && !selected.startsWith("--") ? selected : env.CLAUDE_CODE_SESSION_ID || null;
}

export function main(argv = process.argv.slice(2), { env = process.env, cwd = process.cwd(), stdout = process.stdout } = {}) {
  const asJson = argv.includes("--json");

  if (argv.includes("--audit")) {
    const all = argv.includes("--all");
    const report = buildAuditReport({
      env,
      sessionId: argv.includes("--session") ? sessionIdFromArgs(argv, env) : null,
      days: all ? null : positiveAuditDays(argumentValue(argv, "--days")),
      all
    });
    stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : renderAuditReport(report));
    return report;
  }

  if (argv.includes("--record-acceptance")) {
    const index = argv.indexOf("--record-acceptance");
    const observation = recordCodexAcceptance({
      jobId: argv[index + 1],
      acceptance: argv[index + 2],
      workspaceRoot: argumentValue(argv, "--workspace") ?? cwd,
      env,
      sessionId: sessionIdFromArgs(argv, env),
      reason: argumentValue(argv, "--reason"),
      source: argumentValue(argv, "--source") ?? "collector"
    });
    stdout.write(asJson ? `${JSON.stringify(observation, null, 2)}\n` : `Recorded ${observation.acceptance} for Codex job ${observation.jobId}.\n`);
    return observation;
  }

  if (argv.includes("--prune-dead")) {
    const result = pruneDeadWorkspaces({ env, yes: argv.includes("--yes") });
    stdout.write(asJson ? `${JSON.stringify(result, null, 2)}\n` : renderPruneReport(result));
    return result;
  }

  if (argv.includes("--trace")) {
    const report = buildTraceReport({ env, cwd, sessionId: sessionIdFromArgs(argv, env) });
    stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : renderTraceReport(report));
    return report;
  }

  if (argv.includes("--session")) {
    const report = buildSessionReport({ env, sessionId: sessionIdFromArgs(argv, env) });
    stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : renderSessionReport(report));
    return report;
  }

  const all = argv.includes("--all");
  const report = buildFusionStats({ all, env, cwd });
  if (asJson) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stdout.write(renderFusionStats(report));
  }
  return report;
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  main();
}
