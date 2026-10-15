import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENGINE_TERMINAL_STATUSES, engineStateRoots } from "../../lib/engines.mjs";
import { WORKER_COLLECTION_METHODS } from "../../lib/worker-state.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export function isPathPositivelyAbsent(target) {
  try {
    fs.statSync(target);
    return false;
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR";
  }
}

const FUSION_DATA_DIR_ENV = "FUSION_DATA_DIR";
export const CODEX_ACCEPTANCE_STATES = new Set(["accepted", "rejected", "unverified"]);
export const TOKEN_USAGE_FILENAME = "token-usage.jsonl";
const TERMINAL_LEDGER_PREFIX = "codex-jobs-monitor-announced";
const OBSERVATION_LOCK_STALE_MS = 30000;
const OBSERVATION_LOCK_ATTEMPTS = 8;
export const PRUNE_EVIDENCE = Symbol("pruneEvidence");
export const DAY_MS = 24 * 60 * 60 * 1000;
export const FUSION_TASK_ID_PATTERN = /^fusion-[0-9a-f]{24}$/;
export const ENGINE_JOB_ID_PATTERN = /^[0-9a-f]{32}$/;
export const RECORD_VERDICTS = new Set(["accepted", "rejected", "unverified"]);
export const RESUMABLE_CODEX_FAILURE_KINDS = new Set(["timeout", "policy", "patch_thrash"]);
export const SEMANTIC_FAILURE_KINDS = new Set(["intent_override", "scope_rewrite", "wrong_approach", "style_mismatch", "oversized"]);
export const RECORD_SOURCES = new Set(["collector", "main-loop"]);
export const LAST_SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
export const LANE_SIGNAL_TRAILING_JOBS = 30;
export const LANE_SIGNAL_MIN_JUDGED_JOBS = 10;
export const LANE_SIGNAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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

export function observationTimestamp(observation) {
  const parsed = Date.parse(observation?.observedAt ?? observation?.recordedAt ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function modelObservationRank(observation) {
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

export function nonEmptyString(value) {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
}

export function normalizeCollectionMethod(value) {
  return Object.values(WORKER_COLLECTION_METHODS).includes(value) ? value : null;
}

export function resolveCodexJobModel(raw, observation) {
  const resolved = nonEmptyString(raw?.resolvedModel);
  if (resolved) {
    return resolved;
  }
  if (observation?.source === "rollout-turn-context") {
    return nonEmptyString(observation?.model) ?? nonEmptyString(raw?.request?.model) ?? "unknown";
  }
  return nonEmptyString(raw?._fusionObservedModel) ?? nonEmptyString(raw?.request?.model) ?? nonEmptyString(observation?.model) ?? "unknown";
}

export function resolveCodexJobEffort(raw, observation) {
  const resolved = nonEmptyString(raw?.resolvedEffort);
  if (resolved) {
    return resolved;
  }
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

function waitForObservationLock() {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, 10);
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    void 0;
  }
}

function acquireObservationLock(lockPath) {
  for (let attempt = 0; attempt < OBSERVATION_LOCK_ATTEMPTS; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.fchmodSync(descriptor, 0o600);
      return descriptor;
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
  ensurePrivateDirectory(path.dirname(sidecarPath));
  const lockPath = `${sidecarPath}.lock`;
  const lock = acquireObservationLock(lockPath);
  if (lock == null) {
    return false;
  }
  try {
    if (fs.existsSync(sidecarPath)) {
      fs.chmodSync(sidecarPath, 0o600);
    }
    if (!shouldAppend()) {
      return true;
    }
    fs.appendFileSync(sidecarPath, `${JSON.stringify(observation)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(sidecarPath, 0o600);
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

export function appendModelAuditObservations(sidecarPath, batch, onMerged = () => {}) {
  if (batch.length === 0) return true;
  ensurePrivateDirectory(path.dirname(sidecarPath));
  const lockPath = `${sidecarPath}.lock`;
  let lock;
  try {
    lock = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.fchmodSync(lock, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    if (fs.existsSync(sidecarPath)) {
      fs.chmodSync(sidecarPath, 0o600);
    }
    const observations = loadModelAuditObservations(sidecarPath);
    let changed = false;
    for (const observation of batch) {
      const current = observations.get(observation.jobId);
      if (!current || modelObservationRank(observation) > modelObservationRank(current)) {
        observations.set(observation.jobId, observation);
        changed = true;
      }
    }
    if (!changed) {
      onMerged(observations);
      return true;
    }
    const replacementPath = `${sidecarPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(replacementPath, `${[...observations.values()].map((entry) => JSON.stringify(entry)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(replacementPath, 0o600);
      fs.renameSync(replacementPath, sidecarPath);
    } finally {
      fs.rmSync(replacementPath, { force: true });
    }
    onMerged(observations);
    return true;
  } finally {
    fs.closeSync(lock);
    fs.rmSync(lockPath, { force: true });
  }
}

export function appendModelAuditObservation(sidecarPath, observation) {
  return appendModelAuditObservations(sidecarPath, [observation]);
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

function workspaceRootInScope(recordedRoot, workspaceRoot) {
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

export function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

export function resolveStateRoot(descriptor, env) {
  return engineStateRoots(descriptor.id, env)[0];
}

export function readWorkspaceJobFiles(stateRoot) {
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

function terminalLedgerRecord(raw, { workspaceRoot = null, workspaceKey = null } = {}) {
  const jobId = nonEmptyString(raw?.jobId);
  const status = nonEmptyString(raw?.transportStatus);
  if (!jobId || !status || !ENGINE_TERMINAL_STATUSES.has(status)) {
    return null;
  }
  const model = nonEmptyString(raw?.model);
  const effort = nonEmptyString(raw?.effort);
  return {
    id: jobId,
    status,
    workspaceRoot: nonEmptyString(raw?.workspaceRoot) ?? workspaceRoot,
    sessionId: nonEmptyString(raw?.sessionId),
    threadId: nonEmptyString(raw?.threadId),
    jobClass: nonEmptyString(raw?.kind) ?? "unknown",
    createdAt: raw?.createdAt ?? null,
    startedAt: raw?.startedAt ?? null,
    finishedAt: raw?.finishedAt ?? null,
    completedAt: raw?.finishedAt ?? null,
    timeoutMs: raw?.timeoutMs ?? null,
    failureKind: raw?.failureKind ?? null,
    request: model || effort ? { model, effort } : null,
    _fusionObservedModel: raw?.modelSource === "rollout-turn-context" ? model : null,
    _fusionObservedEffort: raw?.effortSource === "rollout-turn-context" ? effort : null,
    tokenUsage: raw?.tokenUsage ?? null,
    tokenUsageAvailability: raw?.tokenUsageAvailability ?? null,
    _fusionEvidence: "terminal-ledger",
    _fusionScopeKey: workspaceKey,
    _fusionRepositoryKey: nonEmptyString(raw?.repositoryKey)
  };
}

function readCodexTerminalLedgerFiles(stateRoot) {
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
      if (raw?.schemaVersion !== 3 || !Array.isArray(raw.records)) {
        continue;
      }
      const scopeRoot = nonEmptyString(raw?.workspaceRoot);
      for (const candidate of raw.records) {
        const record = terminalLedgerRecord(candidate, { workspaceRoot: scopeRoot, workspaceKey });
        if (record) {
          records.push(record);
        }
      }
    } catch {
      void 0;
    }
  }
  return records;
}

export function readCodexJobEvidence(stateRoot, options = {}) {
  const roots = Object.hasOwn(options, "env") ? engineStateRoots("codex", options.env) : [stateRoot];
  return roots.flatMap((root) => [...readWorkspaceJobFiles(root), ...readCodexTerminalLedgerFiles(root)]);
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
  const evidenceRank = { state: 2, "terminal-ledger": 1 };
  const currentRank = evidenceRank[current?._fusionEvidence] ?? 0;
  const candidateRank = evidenceRank[candidate?._fusionEvidence] ?? 0;
  if (currentRank !== candidateRank) {
    return candidateRank > currentRank ? candidate : current;
  }
  return jobTimestamp(candidate) > jobTimestamp(current) ? candidate : current;
}

export function workspaceKeyMatchesRepository(workspaceKey, workspaceRoot, repositoryCache) {
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
    for (const field of ["workspaceRoot", "sessionId", "threadId", "jobClass", "kind", "createdAt", "startedAt", "finishedAt", "completedAt", "updatedAt", "tokenUsage", "tokenUsageAvailability", "_fusionObservedModel", "_fusionObservedEffort", "_fusionScopeKey", "_fusionRepositoryKey"]) {
      if (merged[field] == null && record?.[field] != null) {
        merged[field] = record[field];
      }
    }
    if (record?.request && typeof record.request === "object") {
      merged.request = merged.request && typeof merged.request === "object" ? merged.request : {};
      for (const field of ["model", "effort", "resumeThreadId"]) {
        if (merged.request[field] == null && record.request[field] != null) {
          merged.request[field] = record.request[field];
        }
      }
    }
  }
  return merged;
}

export function selectPreferredJobs(jobs, descriptor, include) {
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
