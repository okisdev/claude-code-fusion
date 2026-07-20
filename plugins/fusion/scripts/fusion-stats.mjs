#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readAuditEvents as readGuardAuditEvents, resolveStateDir as resolveGuardStateDir, stateFile as guardStateFile } from "./inline-delegation-guard.mjs";
import { resolveCodexStateDir, resolveCodexStateRoots } from "./lib/codex-state-roots.mjs";
import { consumeRawArgsTransport, createRawArgsTransport, resolveRawArgsTransport } from "./lib/raw-args-transport.mjs";
import { canonicalWorkerAgentType, isTerminalWorkerStatus, readWorkerRecords, recordCodexCollectorAcceptance, recordWorkerAcceptance } from "./lib/worker-state.mjs";

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
const FUSION_TASK_ID_PATTERN = /^fusion-[0-9a-f]{24}$/;
const ENGINE_JOB_ID_PATTERN = /^[0-9a-f]{32}$/;
const RECORD_VERDICTS = new Set(["accepted", "rejected", "unverified"]);
const RECORD_SOURCES = new Set(["collector", "main-loop"]);

export class GrokPluginUpgradeRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "GrokPluginUpgradeRequiredError";
    this.code = "GROK_PLUGIN_UPGRADE_REQUIRED";
  }
}

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

function nonEmptyString(value) {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
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

export function loadAcceptanceObservations(sidecarPath) {
  return loadLatestJsonlByJobId(sidecarPath, "recordedAt");
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

function appendAcceptanceObservation(sidecarPath, observation) {
  return appendJsonlObservation(sidecarPath, observation, () => {
    const current = loadAcceptanceObservations(sidecarPath).get(observation.jobId);
    return !current || ["acceptance", "workspaceRoot", "repositoryKey", "sessionId", "source", "reason"].some((field) => (current[field] ?? null) !== (observation[field] ?? null));
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

function prepareCodexAcceptance({ jobId, acceptance, workspaceRoot = process.cwd(), env = process.env, sessionId = env.CLAUDE_CODE_SESSION_ID || null, reason = null, source = "collector", recordedAt = new Date().toISOString() }) {
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
  return { observation, normalizedRoot, normalizedSessionId, normalizedSource, normalizedReason, env };
}

export function recordCodexAcceptance(options) {
  const { observation, normalizedRoot, normalizedSessionId, normalizedSource, normalizedReason, env } = prepareCodexAcceptance(options);
  if (!appendAcceptanceObservation(acceptanceSidecarPath(normalizedRoot, env), observation)) {
    throw new Error("Codex acceptance ledger is busy; retry the write.");
  }
  for (const record of normalizedSessionId == null ? [] : readWorkerRecords(env).filter((candidate) => candidate.sessionId === normalizedSessionId && canonicalWorkerAgentType(candidate.agentType) === "fusion:job-collector" && candidate.completionContract === "collector" && candidate.peerEngine === "codex" && candidate.peerJobId === observation.jobId && isTerminalWorkerStatus(candidate.transportStatus))) {
    recordCodexCollectorAcceptance({ taskId: record.taskId, jobId: observation.jobId, sessionId: normalizedSessionId, acceptance: observation.acceptance, env, source: normalizedSource, reason: normalizedReason });
  }
  return observation;
}

export function newestGrokCompanion(env = process.env) {
  const override = typeof env.FUSION_GROK_COMPANION === "string" ? env.FUSION_GROK_COMPANION.trim() : "";
  if (override && path.isAbsolute(override) && regularFile(override)) {
    return override;
  }
  const base = path.join(configuredHome(env), ".claude", "plugins", "cache", "claude-code-fusion", "grok");
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

function configuredHome(env = process.env) {
  const candidate = typeof env.HOME === "string" ? env.HOME.trim() : "";
  return candidate && path.isAbsolute(candidate) ? candidate : os.homedir();
}

function regularFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function newestCodexCompanion(env = process.env) {
  const override = typeof env.FUSION_CODEX_COMPANION === "string" ? env.FUSION_CODEX_COMPANION.trim() : "";
  if (override && path.isAbsolute(override) && regularFile(override)) {
    return override;
  }
  const base = path.join(configuredHome(env), ".claude", "plugins", "cache", "claude-code-fusion", "codex");
  try {
    const candidates = fs
      .readdirSync(base)
      .map((version) => path.join(base, version, "scripts", "codex-companion.mjs"))
      .filter((candidate) => fs.existsSync(candidate))
      .map((candidate) => ({ candidate, mtime: fs.statSync(candidate).mtimeMs }))
      .sort((left, right) => right.mtime - left.mtime || left.candidate.localeCompare(right.candidate));
    if (candidates.length > 0) {
      return candidates[0].candidate;
    }
  } catch {
    void 0;
  }
  const sibling = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "codex", "scripts", "codex-companion.mjs");
  return fs.existsSync(sibling) ? sibling : null;
}

function companionFailureMessage(result) {
  return [result.stderr, result.stdout, result.error?.message].filter((value) => typeof value === "string" && value.trim()).join("\n").trim();
}

function codexAcceptanceSubcommandUnavailable(result) {
  if (result.error) {
    return true;
  }
  const message = companionFailureMessage(result);
  return /\b(?:unknown|unsupported|unrecognized)\s+(?:subcommand|command)\b/i.test(message) || /\brecord-acceptance\b.*\b(?:unknown|unsupported|unavailable|not found|not supported)\b/i.test(message) || /\b(?:cannot find module|ERR_MODULE_NOT_FOUND)\b/i.test(message);
}

function grokAcceptanceSubcommandUnavailable(result) {
  if (result.error) {
    return false;
  }
  const message = companionFailureMessage(result);
  return /\b(?:unknown|unsupported|unrecognized)\s+(?:subcommand|command)\b/i.test(message) || /\brecord-acceptance\b.*\b(?:unknown|unsupported|unavailable|not found|not supported)\b/i.test(message) || /\b(?:cannot find module|ERR_MODULE_NOT_FOUND)\b/i.test(message);
}

function recordCodexCompanionAcceptance({ jobId, acceptance, reason, acceptFailedTransport, workspaceRoot, env }) {
  const bin = newestCodexCompanion(env);
  if (!bin) {
    return { updated: false };
  }
  const argv = [bin, "record-acceptance", "--job-id", jobId, "--acceptance", acceptance, ...(reason ? ["--reason", reason] : []), ...(acceptFailedTransport ? ["--accept-failed-transport"] : [])];
  const result = spawnSync(process.execPath, argv, { cwd: workspaceRoot, encoding: "utf8", env });
  if (!result.error && result.status === 0) {
    return { updated: true };
  }
  if (codexAcceptanceSubcommandUnavailable(result)) {
    return { updated: false };
  }
  throw new Error(companionFailureMessage(result) || "Codex acceptance record update failed.");
}

function recordGrokCompanionAcceptance({ jobId, acceptance, reason, acceptFailedTransport, workspaceRoot, asJson, env }) {
  const bin = newestGrokCompanion(env);
  if (!bin) {
    throw new GrokPluginUpgradeRequiredError("The Grok job was found, but its companion is unavailable. Upgrade the Grok plugin and retry.");
  }
  const argv = [bin, "record-acceptance", "--job-id", jobId, "--acceptance", acceptance, ...(reason ? ["--reason", reason] : []), ...(acceptFailedTransport ? ["--accept-failed-transport"] : []), ...(asJson ? ["--json"] : [])];
  const result = spawnSync(process.execPath, argv, { cwd: workspaceRoot, encoding: "utf8", env });
  if (!result.error && result.status === 0) {
    return;
  }
  if (grokAcceptanceSubcommandUnavailable(result)) {
    throw new GrokPluginUpgradeRequiredError("The installed Grok plugin does not support record-acceptance. Upgrade the Grok plugin and retry.");
  }
  throw new Error(companionFailureMessage(result) || "Grok acceptance record update failed.");
}

export function grokStats({ all = false, env = process.env, cwd = process.cwd() } = {}) {
  return fileBasedEngineStats(FILE_ENGINE_DESCRIPTORS.grok, { all, env, cwd });
}

function resolveGrokDataDir(env = process.env) {
  const override = env[GROK_DATA_DIR_ENV];
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "grok-claude-code-fusion");
}

function grokStateRoots(env = process.env) {
  return [path.join(resolveGrokDataDir(env), "state")];
}

function resolveGrokStateRoot(env = process.env) {
  return grokStateRoots(env)[0];
}

function grokJobById(jobId, env) {
  for (const stateRoot of grokStateRoots(env)) {
    for (const job of readWorkspaceJobFiles(stateRoot)) {
      if (nonEmptyString(job?.id) === jobId) {
        return job;
      }
    }
  }
  return null;
}

function codexJobExists(jobId, env) {
  return readCodexJobEvidence(resolveCodexStateDir(env), { env }).some((job) => nonEmptyString(job?.id) === jobId);
}

function resolveEngineJob(jobId, env) {
  const codexFound = codexJobExists(jobId, env);
  const grokFound = grokJobById(jobId, env) !== null;
  if (codexFound && grokFound) {
    throw new Error(`Engine job ${jobId} exists in both Codex and Grok state.`);
  }
  if (codexFound) {
    return "codex";
  }
  if (grokFound) {
    return "grok";
  }
  throw new Error(`Engine job ${jobId} was not found in Codex or Grok state.`);
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

function readGrokJobEvidence(stateRoot) {
  return readWorkspaceJobFiles(stateRoot);
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
  grok: {
    id: "grok",
    defaultStateRoot: resolveGrokStateRoot,
    unavailableReason: "grok plugin job state not found; the grok plugin may not be installed",
    note: "read best effort from Grok job state; totals are lower bounds",
    enumerateJobs: readGrokJobEvidence,
    resolveScope: resolveGitWorkspaceRoot,
    matchesWorkspace(raw, cwd, workspaceRoot, repositoryCache) {
      return workspaceRootsShareRepository(raw?.cwd, workspaceRoot, repositoryCache);
    },
    includeByModel: true,
    includeTokenUsage: true,
    dedupeById: true,
    isTerminal: (raw) => GROK_TERMINAL_STATUSES.has(raw.status),
    normalizeJob(raw) {
      const finished = raw.finishedAt ?? raw.completedAt ?? raw.updatedAt ?? null;
      let durationSeconds = null;
      if (raw.status === "done" && raw.createdAt && finished) {
        const span = (Date.parse(finished) - Date.parse(raw.createdAt)) / 1000;
        if (Number.isFinite(span) && span >= 0) {
          durationSeconds = span;
        }
      }
      return {
        status: raw.status ?? "unknown",
        kind: raw.role ?? raw.mode ?? raw.jobClass ?? "unknown",
        createdAt: raw.createdAt ?? null,
        durationSeconds,
        evidence: "state"
      };
    },
    resolveModel(raw) {
      return nonEmptyString(raw?.resolvedModel) ?? "unknown";
    },
    resolveEffort(raw) {
      return nonEmptyString(raw?.resolvedEffort);
    },
    resolveMode(raw) {
      return nonEmptyString(raw?.mode) ?? "unknown";
    },
    resolveFailureKind(raw) {
      if (raw?.status !== "error" && raw?.status !== "cancelled") {
        return null;
      }
      return nonEmptyString(raw?.failureKind) ?? (raw.status === "cancelled" ? "cancelled" : "error");
    },
    resolveTokenUsage: grokTokenUsageForJob,
    tokenUsageScope: "terminal jobs only"
  },
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
    includeTokenUsage: true,
    usesModelAudit: true,
    usesTokenUsageObservations: true,
    tokenUsageScope: "terminal transport jobs only",
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

function checkedUsageAddition(totals, usage) {
  const next = {};
  for (const key of Object.keys(totals)) {
    const total = totals[key] + usage[key];
    if (!Number.isSafeInteger(total)) {
      return null;
    }
    next[key] = total;
  }
  return next;
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
  return BigInt(usage.totalTokens) === BigInt(usage.inputTokens) + BigInt(usage.outputTokens) ? usage : null;
}

function grokTokenField(value, names) {
  const observed = names.filter((name) => Object.hasOwn(value, name)).map((name) => value[name]);
  if (observed.length === 0 || observed.some((candidate) => candidate !== observed[0])) {
    return null;
  }
  return integerTokenField(observed[0]);
}

function normalizeGrokTokenUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const inputTokens = grokTokenField(value, ["input_tokens", "inputTokens"]);
  const cachedInputTokens = grokTokenField(value, ["cache_read_input_tokens", "cacheReadInputTokens", "cachedReadTokens", "cacheReadTokens"]);
  const outputTokens = grokTokenField(value, ["output_tokens", "outputTokens"]);
  const reasoningOutputTokens = grokTokenField(value, ["reasoning_tokens", "reasoningTokens"]);
  const totalTokens = grokTokenField(value, ["total_tokens", "totalTokens"]);
  if ([inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens].some((field) => field == null) || reasoningOutputTokens > outputTokens) {
    return null;
  }
  const uncachedTotal = BigInt(inputTokens) + BigInt(cachedInputTokens) + BigInt(outputTokens);
  const fullInputTotal = BigInt(inputTokens) + BigInt(outputTokens);
  if (BigInt(totalTokens) !== uncachedTotal && BigInt(totalTokens) !== fullInputTotal) {
    return null;
  }
  return {
    inputTokens: Number(BigInt(totalTokens) === fullInputTotal ? BigInt(inputTokens) : BigInt(inputTokens) + BigInt(cachedInputTokens)),
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  };
}

function grokTokenUsageFromModels(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entries = Object.values(value);
  if (entries.length === 0) {
    return null;
  }
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const input = grokTokenField(entry, ["input_tokens", "inputTokens"]);
    const cached = grokTokenField(entry, ["cache_read_input_tokens", "cacheReadInputTokens", "cachedReadTokens", "cacheReadTokens"]);
    const output = grokTokenField(entry, ["output_tokens", "outputTokens"]);
    if (input == null || cached == null || output == null) {
      return null;
    }
    const next = checkedUsageAddition(
      { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens: 0, totalTokens: inputTokens + outputTokens },
      { inputTokens: input + cached, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: 0, totalTokens: input + cached + output }
    );
    if (!next) {
      return null;
    }
    ({ inputTokens, cachedInputTokens, outputTokens } = next);
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens
  };
}

function grokTokenUsageForJob(raw) {
  if (raw?.usageIsIncomplete === true || raw?.usage_is_incomplete === true || raw?.modelUsageIsIncomplete === true) {
    return { availability: "partial", usage: null };
  }
  const direct = normalizeGrokTokenUsage(raw?.usage);
  if (direct) {
    return { availability: "available", usage: direct };
  }
  const byModel = grokTokenUsageFromModels(raw?.modelUsage);
  if (byModel) {
    return { availability: "available", usage: byModel };
  }
  return { availability: raw?.usage != null || raw?.modelUsage != null ? "partial" : "unavailable", usage: null };
}

function normalizeClaudeWorkerUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const usage = {
    inputTokens: integerTokenField(value.inputTokens),
    cacheCreationInputTokens: integerTokenField(value.cacheCreationInputTokens),
    cacheReadInputTokens: integerTokenField(value.cacheReadInputTokens),
    outputTokens: integerTokenField(value.outputTokens),
    totalTokens: integerTokenField(value.totalTokens),
    uncachedTokens: integerTokenField(value.uncachedTokens)
  };
  if (Object.values(usage).some((field) => field == null)) {
    return null;
  }
  const totalTokens = BigInt(usage.inputTokens) + BigInt(usage.cacheCreationInputTokens) + BigInt(usage.cacheReadInputTokens) + BigInt(usage.outputTokens);
  const uncachedTokens = BigInt(usage.inputTokens) + BigInt(usage.cacheCreationInputTokens) + BigInt(usage.outputTokens);
  return BigInt(usage.totalTokens) === totalTokens && BigInt(usage.uncachedTokens) === uncachedTokens ? usage : null;
}

function tokenUsageForJob(raw, observation) {
  const candidates = [
    { value: raw?.tokenUsage, availability: raw?.tokenUsageAvailability },
    { value: raw?.usage, availability: raw?.tokenUsageAvailability ?? raw?.usageAvailability },
    { value: raw?.result?.tokenUsage, availability: raw?.result?.tokenUsageAvailability ?? raw?.result?.usageAvailability },
    { value: raw?.result?.usage, availability: raw?.result?.tokenUsageAvailability ?? raw?.result?.usageAvailability },
    { value: observation?.tokenUsage, availability: observation?.availability },
    { value: observation?.usage, availability: observation?.availability }
  ];
  let incomplete = false;
  for (const candidate of candidates) {
    if (candidate.availability === "partial" || candidate.availability === "incomplete") {
      incomplete = true;
      continue;
    }
    const normalized = normalizeCodexTokenUsage(candidate.value);
    if (!normalized) {
      incomplete ||= candidate.value != null || candidate.availability === "available";
      continue;
    }
    if (candidate.availability === "unavailable" || candidate.availability === "unreported") {
      continue;
    }
    if (candidate.availability != null && candidate.availability !== "available") {
      continue;
    }
    return { availability: "available", usage: normalized };
  }
  return { availability: incomplete ? "partial" : "unavailable", usage: null };
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
  if (descriptor.id === "grok" && jobs.length === 0) {
    return { available: false, reason: descriptor.unavailableReason };
  }
  const workspaceRoot = typeof descriptor.resolveScope === "function" ? descriptor.resolveScope(cwd) : cwd;
  const repositoryCache = new Map();
  const include = (job) => all || descriptor.matchesWorkspace(job, cwd, workspaceRoot, repositoryCache);
  const candidates = all
    ? jobs
    : jobs.map((job) => include(job) && !job?._fusionScopeKey ? { ...job, _fusionScopeKey: fusionWorkspaceKey(workspaceRoot) } : job);
  const scoped = selectPreferredJobs(candidates, descriptor, include);
  if (descriptor.id === "grok" && !all && scoped.length === 0) {
    return { available: false, reason: descriptor.unavailableReason };
  }
  const byStatus = {};
  const byKind = {};
  const byModel = {};
  const byEffort = {};
  const byMode = {};
  const byFailureKind = {};
  const byAcceptance = {};
  const byEvidence = {};
  const auditCache = new Map();
  const tokenObservations = descriptor.usesTokenUsageObservations ? loadAllObservationCandidates(env, TOKEN_USAGE_FILENAME, loadTokenUsageObservations) : new Map();
  const acceptanceObservations = descriptor.id === "codex" ? loadAllObservationCandidates(env, ACCEPTANCE_FILENAME, loadAcceptanceObservations) : new Map();
  const observationRepositoryCache = new Map();
  let tokenTotals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  let tokenAggregationOverflow = false;
  let jobsWithTokenUsage = 0;
  let jobsWithIncompleteTokenUsage = 0;
  let jobsWithoutTokenUsage = 0;
  let jobsWithUnreportedTokenUsage = 0;
  let pendingTransportJobs = 0;
  const acceptedWithErrorTransport = [];
  const doneWithoutAcceptance = [];
  let durationSum = 0;
  let durationCount = 0;
  let earliest = null;
  let latest = null;
  for (const raw of scoped) {
    const job = descriptor.normalizeJob(raw);
    bump(byStatus, job.status);
    bump(byKind, job.kind);
    bump(byEvidence, job.evidence ?? "state");
    if (typeof descriptor.resolveMode === "function") {
      bump(byMode, descriptor.resolveMode(raw, job));
    }
    if (typeof descriptor.resolveFailureKind === "function") {
      const failureKind = descriptor.resolveFailureKind(raw, job);
      if (failureKind) {
        bump(byFailureKind, failureKind);
      }
    }
    if (descriptor.includeByModel && typeof descriptor.resolveModel === "function") {
      const observation = descriptor.usesModelAudit ? observationForJob(raw, env, auditCache) : null;
      const model = descriptor.resolveModel(raw, observation);
      const effort = typeof descriptor.resolveEffort === "function" ? descriptor.resolveEffort(raw, observation) : null;
      bump(byModel, effort ? `${model}@${effort}` : model);
      bump(byEffort, effort ?? "unavailable");
    }
    if (descriptor.id === "codex") {
      const jobId = nonEmptyString(raw?.id);
      const acceptanceObservation = jobId ? scopedObservationForJob(acceptanceObservations, raw, observationRepositoryCache) : null;
      if (CODEX_TERMINAL_STATUSES.has(job.status)) {
        const acceptance = acceptanceObservation?.acceptance;
        bump(byAcceptance, CODEX_ACCEPTANCE_STATES.has(acceptance) ? acceptance : "unverified");
      } else {
        pendingTransportJobs += 1;
      }
      if (jobId && job.status === "error" && acceptanceObservation?.acceptance === "accepted") {
        acceptedWithErrorTransport.push(jobId);
      }
      if (jobId && job.status === "done" && !acceptanceObservation) {
        doneWithoutAcceptance.push(jobId);
      }
    }
    if (descriptor.includeTokenUsage && descriptor.isTerminal(raw)) {
      const observation = descriptor.usesTokenUsageObservations && raw?.id ? scopedObservationForJob(tokenObservations, raw, observationRepositoryCache) : null;
      const usageResult = typeof descriptor.resolveTokenUsage === "function" ? descriptor.resolveTokenUsage(raw) : tokenUsageForJob(raw, observation);
        if (usageResult.usage) {
          jobsWithTokenUsage += 1;
          if (!tokenAggregationOverflow) {
            const nextTotals = checkedUsageAddition(tokenTotals, usageResult.usage);
            if (nextTotals) {
              tokenTotals = nextTotals;
            } else {
              tokenAggregationOverflow = true;
            }
          }
        } else {
          jobsWithoutTokenUsage += 1;
          if (usageResult.availability === "partial") {
            jobsWithIncompleteTokenUsage += 1;
          } else {
            jobsWithUnreportedTokenUsage += 1;
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
    ...(descriptor.id === "codex"
      ? {
          byTransportStatus: { ...byStatus },
          byAcceptance,
          acceptanceScope: "terminal transport jobs only",
          pendingTransportJobs,
          acceptanceAnomalies: {
            acceptedWithErrorTransport,
            doneWithoutAcceptance
          }
        }
      : {}),
    byKind,
    ...(typeof descriptor.resolveMode === "function" ? { byMode } : {}),
    ...(typeof descriptor.resolveFailureKind === "function" ? { byFailureKind } : {}),
    ...(descriptor.includeByModel ? { byModel } : {}),
    ...(descriptor.includeByModel ? { byEffort } : {}),
    ...(descriptor.includeTokenUsage
      ? {
          tokenUsage: {
            availability: tokenAggregationOverflow ? "overflow" : jobsWithTokenUsage === 0 ? "unavailable" : jobsWithoutTokenUsage === 0 ? "available" : "partial",
            scope: descriptor.tokenUsageScope ?? "terminal jobs only",
            jobsWithUsage: jobsWithTokenUsage,
            jobsWithIncompleteUsage: jobsWithIncompleteTokenUsage,
            jobsWithoutUsage: jobsWithoutTokenUsage,
            jobsWithUnreportedUsage: jobsWithUnreportedTokenUsage,
            totals: jobsWithTokenUsage > 0 && !tokenAggregationOverflow ? tokenTotals : null,
            ...(tokenAggregationOverflow ? { aggregationOverflow: true } : {})
          },
          ...(descriptor.id === "codex"
            ? {
                evidence: {
                  bySource: byEvidence,
                  recoveredTerminalJobs: byEvidence["terminal-ledger"] ?? 0,
                  recoveredLegacyTerminalJobs: byEvidence["legacy-terminal-ledger"] ?? 0,
                  isLowerBound: true
                }
              }
            : {})
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

export function claudeWorkerStats({ all = false, env = process.env, cwd = process.cwd(), sessionId = null } = {}) {
  const workspaceRoot = resolveGitWorkspaceRoot(cwd);
  const repositoryCache = new Map();
  const records = readWorkerRecords(env).filter((record) => {
    const agentType = canonicalWorkerAgentType(record.agentType);
    if (!agentType || agentType === "fusion:job-collector") {
      return false;
    }
    if (sessionId && record.sessionId !== sessionId) {
      return false;
    }
    return all || workspaceRootsShareRepository(record.workspaceRoot, workspaceRoot, repositoryCache);
  });
  const byStatus = {};
  const byAcceptance = {};
  const byAgent = {};
  const byFailureKind = {};
  const byDelivery = {};
  const byModel = {};
  let usage = { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, totalTokens: 0, uncachedTokens: 0 };
  let usageAggregationOverflow = false;
  let pendingTransportJobs = 0;
  let harnessAsyncDeliveries = 0;
  let completeUsage = 0;
  let partialUsage = 0;
  let unreportedUsage = 0;
  let durationSum = 0;
  let durationCount = 0;
  let earliest = null;
  let latest = null;
  for (const record of records) {
    const status = nonEmptyString(record.transportStatus) ?? "unknown";
    bump(byStatus, status);
    bump(byAgent, nonEmptyString(record.agentType) ?? "unknown");
    bump(byDelivery, nonEmptyString(record.expectedDelivery) ?? "unknown");
    if (record.resolvedModel) {
      bump(byModel, record.resolvedModel);
    }
    const legacyHarnessAsyncDelivery = record.failureKind === "unexpected_async" && status === "done";
    if (record.deliveryMode === "harness_async" || legacyHarnessAsyncDelivery) {
      harnessAsyncDeliveries += 1;
    }
    if (record.failureKind && !legacyHarnessAsyncDelivery) {
      bump(byFailureKind, record.failureKind);
    }
    if (isTerminalWorkerStatus(status)) {
      bump(byAcceptance, CODEX_ACCEPTANCE_STATES.has(record.acceptance) ? record.acceptance : "unverified");
    } else {
      pendingTransportJobs += 1;
    }
    if (record.usageAvailability === "available") {
      const normalizedUsage = normalizeClaudeWorkerUsage(record.usage);
      if (normalizedUsage) {
        completeUsage += 1;
        if (!usageAggregationOverflow) {
          const nextUsage = checkedUsageAddition(usage, normalizedUsage);
          if (nextUsage) {
            usage = nextUsage;
          } else {
            usageAggregationOverflow = true;
          }
        }
      } else {
        partialUsage += 1;
      }
    } else if (record.usageAvailability === "partial") {
      partialUsage += 1;
    } else {
      unreportedUsage += 1;
    }
    const started = Date.parse(record.startedAt ?? "");
    const finished = Date.parse(record.finishedAt ?? "");
    if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
      durationSum += (finished - started) / 1000;
      durationCount += 1;
    }
    const created = Date.parse(record.createdAt ?? "");
    if (Number.isFinite(created)) {
      earliest = earliest == null || created < earliest ? created : earliest;
      latest = latest == null || created > latest ? created : latest;
    }
  }
  const identities = records
    .slice()
    .sort((left, right) => Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? ""))
    .slice(0, 100)
    .map((record) => ({
      taskId: record.taskId,
      sessionId: record.sessionId ?? null,
      agentId: record.agentId ?? null,
      backgroundTaskId: record.backgroundTaskId ?? null,
      agentType: record.agentType,
      transportStatus: record.transportStatus,
      acceptance: record.acceptance ?? "unverified"
    }));
  return {
    available: true,
    totalJobs: records.length,
    byTransportStatus: byStatus,
    byAcceptance,
    acceptanceScope: "terminal transport jobs only",
    pendingTransportJobs,
    byAgent,
    byFailureKind,
    harnessAsyncDeliveries,
    byDelivery,
    byModel,
    usage: usageAggregationOverflow ? null : usage,
    usageCoverage: {
      availability: usageAggregationOverflow ? "overflow" : records.length > 0 && completeUsage === records.length ? "available" : completeUsage > 0 ? "partial" : "unavailable",
      completeJobs: completeUsage,
      incompleteJobs: partialUsage,
      unreportedJobs: unreportedUsage,
      ...(usageAggregationOverflow ? { aggregationOverflow: true } : {})
    },
    meanWallClockSeconds: durationCount > 0 ? Math.round((durationSum / durationCount) * 1000) / 1000 : null,
    earliestCreatedAt: earliest == null ? null : new Date(earliest).toISOString(),
    latestCreatedAt: latest == null ? null : new Date(latest).toISOString(),
    identities
  };
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
  const eventsByDay = {};
  const dispatchesByLane = {};
  const sessions = new Set();
  for (const event of events) {
    bump(byEvent, event.event);
    const day = event.at.slice(0, 10);
    const counts = eventsByDay[day] ?? { dispatch: 0, write: 0, deny: 0, warn: 0 };
    counts[event.event] += 1;
    eventsByDay[day] = counts;
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
    eventsByDay,
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
  const days = Object.keys(report.eventsByDay ?? {}).sort();
  if (days.length > 0) {
    lines.push("", "Events by day:");
    for (const day of days) {
      const { dispatch = 0, write = 0, deny = 0, warn = 0 } = report.eventsByDay[day];
      lines.push(`- ${day}: dispatch ${dispatch}, write ${write}, deny ${deny}, warn ${warn}`);
    }
  }
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
    ...(nonEmptyString(raw?.id) ? { jobId: raw.id } : {}),
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
  for (const record of readWorkerRecords(env)) {
    const agentType = canonicalWorkerAgentType(record.agentType);
    if (record.sessionId !== sessionId || !agentType || agentType === "fusion:job-collector") {
      continue;
    }
    const timestamp = traceTimestamp(record.createdAt);
    if (timestamp == null) {
      continue;
    }
    timeline.push({
      time: record.createdAt,
      timestamp,
      source: "Claude worker",
      engine: "claude",
      join: "exact",
      taskId: record.taskId,
      agentId: record.agentId ?? null,
      backgroundTaskId: record.backgroundTaskId ?? null,
      model: record.resolvedModel ?? null,
      status: record.transportStatus ?? "unknown"
    });
  }
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
  lines.push("", `Workspace root: ${report.workspaceRoot}`, "", "Time | Source | Lane or engine | Task or job | Model@effort | Status | Description");
  if (report.timeline.length === 0) {
    lines.push("no dispatches or matching engine jobs recorded");
  } else {
    for (const entry of report.timeline) {
      const subject = entry.source === "dispatch" ? entry.lane : `${entry.engine}${entry.join === "approximate" ? " (approximate)" : ""}`;
      lines.push(`${entry.time} | ${entry.source} | ${subject} | ${entry.taskId ?? entry.jobId ?? ""} | ${formatTraceModel(entry.model, entry.effort) ?? ""} | ${entry.status ?? ""} | ${entry.description ?? ""}`);
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
    return { available: false, reason, sessionId, guard: null, workers: null, engines };
  }
  for (const descriptor of WORKSPACE_ENGINE_DESCRIPTORS) {
    engines[descriptor.id] = sessionScopedEngineStats(descriptor, sessionId, env);
  }
  return { available: true, sessionId, guard: readGuardSessionState(env, sessionId), workers: claudeWorkerStats({ all: true, env, sessionId }), engines };
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
  if (report.workers) {
    lines.push("", "## Claude workers (session scope)", "", `Total jobs: ${report.workers.totalJobs}`);
    renderCounts(lines, "By transport status", report.workers.byTransportStatus);
    renderCounts(lines, "By semantic acceptance", report.workers.byAcceptance);
    lines.push("", `Semantic acceptance scope: ${report.workers.acceptanceScope}; ${report.workers.pendingTransportJobs} non-terminal job${report.workers.pendingTransportJobs === 1 ? "" : "s"} excluded`);
    renderWorkerIdentities(lines, report.workers.identities);
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
    id: "claudeWorkers",
    displayName: "Claude workers",
    collect: (options) => claudeWorkerStats(options)
  },
  {
    id: "grok",
    displayName: "Grok",
    collect: (options) => fileBasedEngineStats(FILE_ENGINE_DESCRIPTORS.grok, options)
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

function renderAcceptanceAnomalies(lines, anomalies) {
  const acceptedWithErrorTransport = anomalies?.acceptedWithErrorTransport ?? [];
  const doneWithoutAcceptance = anomalies?.doneWithoutAcceptance ?? [];
  if (acceptedWithErrorTransport.length === 0 && doneWithoutAcceptance.length === 0) {
    return;
  }
  lines.push("", "Acceptance anomalies:");
  if (acceptedWithErrorTransport.length > 0) {
    lines.push(`- Accepted ledger entries with error transport: ${acceptedWithErrorTransport.length} (${acceptedWithErrorTransport.map((jobId) => jobId.slice(0, 8)).join(", ")})`);
  }
  if (doneWithoutAcceptance.length > 0) {
    lines.push(`- Done jobs without acceptance records: ${doneWithoutAcceptance.length} (${doneWithoutAcceptance.join(", ")})`);
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
    lines.push(`Mean wall clock for finished jobs: ${stats.meanWallClockSeconds}s`);
  }
  renderCounts(lines, stats.byTransportStatus ? "By transport status" : "By status", stats.byTransportStatus ?? stats.byStatus ?? {});
  renderCounts(lines, "By semantic acceptance", stats.byAcceptance ?? {});
  if (stats.acceptanceScope) {
    lines.push("", `Semantic acceptance scope: ${stats.acceptanceScope}; ${stats.pendingTransportJobs} non-terminal job${stats.pendingTransportJobs === 1 ? "" : "s"} excluded`);
  }
  renderAcceptanceAnomalies(lines, stats.acceptanceAnomalies);
  renderCounts(lines, "By mode", stats.byMode ?? {});
  renderCounts(lines, "By agent", stats.byAgent ?? {});
  renderCounts(lines, "By delivery", stats.byDelivery ?? {});
  renderCounts(lines, "By kind", stats.byKind ?? {});
  renderCounts(lines, "By model", stats.byModel ?? {});
  renderCounts(lines, "By effort", stats.byEffort ?? {});
  renderCounts(lines, "By failure kind", stats.byFailureKind ?? {});
  if (Number.isSafeInteger(stats.harnessAsyncDeliveries)) {
    lines.push("", `Harness async deliveries: ${stats.harnessAsyncDeliveries}`);
  }
  if (stats.tokenUsage) {
    const scope = stats.tokenUsage.scope ? `, ${stats.tokenUsage.scope}` : "";
    const incomplete = stats.tokenUsage.jobsWithIncompleteUsage ?? 0;
    const unreported = stats.tokenUsage.jobsWithUnreportedUsage ?? Math.max(0, stats.tokenUsage.jobsWithoutUsage - incomplete);
    lines.push("", `Exact token usage coverage${scope}: ${stats.tokenUsage.availability} (${stats.tokenUsage.jobsWithUsage} complete, ${incomplete} incomplete, ${unreported} unreported)`);
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
      const reasoning = Number.isSafeInteger(stats.usage.reasoningTokens) ? `, ${stats.usage.reasoningTokens} reasoning output` : "";
      lines.push(`Observed tokens: ${stats.usage.totalTokens} total, ${stats.usage.inputTokens} input, ${stats.usage.cacheReadInputTokens} cached input, ${stats.usage.outputTokens} output${reasoning}`);
    }
  }
  if (stats.evidence?.recoveredTerminalJobs || stats.evidence?.recoveredLegacyTerminalJobs) {
    lines.push("", `Recovered from retained terminal ledgers: ${stats.evidence.recoveredTerminalJobs + stats.evidence.recoveredLegacyTerminalJobs}`);
  }
  renderWorkerIdentities(lines, stats.identities);
}

function renderWorkerIdentities(lines, identities) {
  if (!Array.isArray(identities) || identities.length === 0) {
    return;
  }
  lines.push("", "Task identity map:", "task | session | agent | background task | transport | acceptance");
  for (const identity of identities) {
    lines.push(`${identity.taskId} | ${identity.sessionId ?? ""} | ${identity.agentId ?? ""} | ${identity.backgroundTaskId ?? ""} | ${identity.transportStatus} | ${identity.acceptance}`);
  }
}

/** Dispatches from one session that land within this gap form one burst (ultra fleet fan-out). */
const FLEET_BURST_GAP_MS = 5000;
const FLEET_SHAPED_MIN_WIDTH = 3;

function emptyFleetUsageStats() {
  return {
    surface: "ultra",
    totalDispatches: 0,
    totalBursts: 0,
    fleetShapedBursts: 0,
    widthDistribution: {},
    byDay: {},
    widest: null
  };
}

function clusterDispatchBursts(dispatchEvents, gapMs = FLEET_BURST_GAP_MS) {
  const bySession = new Map();
  for (const event of dispatchEvents) {
    const session = nonEmptyString(event?.session);
    const at = nonEmptyString(event?.at);
    const atMs = at ? Date.parse(at) : Number.NaN;
    if (!session || !Number.isFinite(atMs)) {
      continue;
    }
    const list = bySession.get(session) ?? [];
    list.push({ at, atMs, session, day: at.slice(0, 10) });
    bySession.set(session, list);
  }
  const bursts = [];
  for (const [session, events] of bySession) {
    events.sort((left, right) => left.atMs - right.atMs || left.at.localeCompare(right.at));
    let current = null;
    for (const event of events) {
      if (!current || event.atMs - current.lastAtMs > gapMs) {
        current = {
          session,
          day: event.day,
          width: 1,
          firstAt: event.at,
          lastAt: event.at,
          lastAtMs: event.atMs
        };
        bursts.push(current);
        continue;
      }
      current.width += 1;
      current.lastAt = event.at;
      current.lastAtMs = event.atMs;
    }
  }
  return bursts;
}

function summarizeFleetBursts(bursts) {
  const widthDistribution = {};
  const byDay = {};
  let fleetShapedBursts = 0;
  let widest = null;
  for (const burst of bursts) {
    bump(widthDistribution, String(burst.width));
    if (burst.width >= FLEET_SHAPED_MIN_WIDTH) {
      fleetShapedBursts += 1;
    }
    if (!widest || burst.width > widest.width || (burst.width === widest.width && (burst.firstAt < widest.at || (burst.firstAt === widest.at && burst.session < widest.session)))) {
      widest = { width: burst.width, session: burst.session, day: burst.day, at: burst.firstAt };
    }
    const dayStats = byDay[burst.day] ?? {
      bursts: 0,
      fleetShapedBursts: 0,
      widthDistribution: {},
      widest: null
    };
    dayStats.bursts += 1;
    bump(dayStats.widthDistribution, String(burst.width));
    if (burst.width >= FLEET_SHAPED_MIN_WIDTH) {
      dayStats.fleetShapedBursts += 1;
    }
    if (!dayStats.widest || burst.width > dayStats.widest.width || (burst.width === dayStats.widest.width && (burst.firstAt < dayStats.widest.at || (burst.firstAt === dayStats.widest.at && burst.session < dayStats.widest.session)))) {
      dayStats.widest = { width: burst.width, session: burst.session, at: burst.firstAt };
    }
    byDay[burst.day] = dayStats;
  }
  return {
    surface: "ultra",
    totalDispatches: bursts.reduce((sum, burst) => sum + burst.width, 0),
    totalBursts: bursts.length,
    fleetShapedBursts,
    widthDistribution,
    byDay,
    widest: widest ? { width: widest.width, session: widest.session, day: widest.day } : null
  };
}

/**
 * Derive ultra / fleet visibility from inline-guard audit dispatch events.
 * Pure read-side: clusters same-session dispatches within a short window into bursts.
 */
export function buildFleetUsageStats({ env = process.env } = {}) {
  let events;
  try {
    ({ events } = readGuardAuditEvents({ env }));
  } catch {
    return emptyFleetUsageStats();
  }
  const dispatches = events.filter((event) => event?.event === "dispatch");
  if (dispatches.length === 0) {
    return emptyFleetUsageStats();
  }
  return summarizeFleetBursts(clusterDispatchBursts(dispatches));
}

function renderFleetUsageStats(lines, fleet) {
  if (!fleet || typeof fleet !== "object") {
    return;
  }
  lines.push("", "## Ultra usage surface", "", "Fleet visibility derived from inline-guard audit dispatches (same-session bursts within a short window).");
  lines.push(`Total dispatches: ${fleet.totalDispatches ?? 0}`);
  lines.push(`Dispatch bursts: ${fleet.totalBursts ?? 0}`);
  lines.push(`Fleet-shaped bursts (width ≥ ${FLEET_SHAPED_MIN_WIDTH}): ${fleet.fleetShapedBursts ?? 0}`);
  renderCounts(lines, "Burst width distribution", fleet.widthDistribution ?? {});
  if (fleet.widest) {
    lines.push("", `Widest burst: width ${fleet.widest.width}, session ${fleet.widest.session}${fleet.widest.day ? `, day ${fleet.widest.day}` : ""}`);
  } else {
    lines.push("", "Widest burst: none");
  }
  const days = Object.keys(fleet.byDay ?? {}).sort();
  if (days.length > 0) {
    lines.push("", "By day:");
    for (const day of days) {
      const dayStats = fleet.byDay[day];
      const widths = Object.keys(dayStats.widthDistribution ?? {})
        .sort((left, right) => Number(left) - Number(right))
        .map((width) => `${width}×${dayStats.widthDistribution[width]}`)
        .join(", ");
      const widest = dayStats.widest ? `; widest ${dayStats.widest.width} (session ${dayStats.widest.session})` : "";
      lines.push(`- ${day}: ${dayStats.bursts} burst${dayStats.bursts === 1 ? "" : "s"}, ${dayStats.fleetShapedBursts} fleet-shaped${widths ? ` [${widths}]` : ""}${widest}`);
    }
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
    ...engines,
    fleet: buildFleetUsageStats({ env })
  };
}

export function renderFusionStats(report) {
  const lines = ["# Fusion stats", "", `Scope: ${report.scope === "all" ? "all workspaces" : `workspace ${report.scope}`}`];
  for (const provider of STATS_PROVIDER_REGISTRY) {
    if (report[provider.id]) {
      renderEngine(lines, provider.displayName, report[provider.id]);
    }
  }
  renderFleetUsageStats(lines, report.fleet);
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

function parseRecordPair(value) {
  if (typeof value !== "string") {
    throw new TypeError("--record requires an <id>=<verdict> pair.");
  }
  const separator = value.indexOf("=");
  if (separator <= 0 || separator !== value.lastIndexOf("=")) {
    throw new TypeError("--record requires an <id>=<verdict> pair.");
  }
  const id = value.slice(0, separator);
  const verdict = value.slice(separator + 1);
  if (!FUSION_TASK_ID_PATTERN.test(id) && !ENGINE_JOB_ID_PATTERN.test(id)) {
    throw new TypeError("--record id must be a Fusion task id or a 32 character engine job id.");
  }
  if (!RECORD_VERDICTS.has(verdict)) {
    throw new TypeError("--record verdict must be accepted, rejected, or unverified.");
  }
  return { id, verdict };
}

function parseRecordArguments(argv) {
  const records = [];
  let source = null;
  let reason = null;
  let asJson = false;
  let acceptFailedTransport = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--record") {
      records.push(parseRecordPair(argv[index + 1]));
      index += 1;
      continue;
    }
    if (token === "--source") {
      if (source !== null || !RECORD_SOURCES.has(argv[index + 1])) {
        throw new TypeError("--source must be collector or main-loop.");
      }
      source = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--reason") {
      if (reason !== null || typeof argv[index + 1] !== "string" || !argv[index + 1]) {
        throw new TypeError("--reason requires text.");
      }
      reason = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--json" && !asJson) {
      asJson = true;
      continue;
    }
    if (token === "--accept-failed-transport") {
      if (acceptFailedTransport) {
        throw new TypeError("Duplicate --accept-failed-transport.");
      }
      acceptFailedTransport = true;
      continue;
    }
    throw new TypeError(`Unsupported --record argument: ${String(token)}.`);
  }
  if (records.length === 0) {
    throw new TypeError("At least one --record <id>=<verdict> pair is required.");
  }
  if (reason !== null && records.length !== 1) {
    throw new TypeError("--reason can be used only when exactly one --record pair is present.");
  }
  return { records, source: source ?? "main-loop", reason, asJson, acceptFailedTransport };
}

function isStrictDirectRecordArguments(argv) {
  if (!argv.includes("--record") || argv.includes("--reason")) {
    return false;
  }
  try {
    parseRecordArguments(argv);
    return true;
  } catch {
    return false;
  }
}

function recordEngineAcceptance({ engine, jobId, verdict, reason, acceptFailedTransport = false, workspaceRoot, asJson, env }) {
  if (engine === "grok") {
    recordGrokCompanionAcceptance({
      jobId,
      acceptance: verdict,
      reason,
      acceptFailedTransport,
      workspaceRoot,
      asJson,
      env
    });
    return true;
  }
  const companion = recordCodexCompanionAcceptance({
    jobId,
    acceptance: verdict,
    reason,
    acceptFailedTransport,
    workspaceRoot,
    env
  });
  if (!companion.updated) {
    throw new Error("Codex job record was not updated because the companion or subcommand is unavailable.");
  }
  return true;
}

function writeRecordConfirmation({ kind, engine = null, jobId = null, worker = null, asJson, stdout }) {
  if (asJson) {
    stdout.write(`${JSON.stringify(kind === "engine" ? { kind, engine, jobId, acceptance: worker?.acceptance } : { kind, taskId: worker.taskId, acceptance: worker.acceptance })}\n`);
    return;
  }
  if (kind === "engine") {
    stdout.write(`Recorded ${worker.acceptance} for ${engine === "codex" ? "Codex" : "Grok"} job ${jobId}.\n`);
    return;
  }
  stdout.write(`Recorded ${worker.acceptance} for Fusion worker task ${worker.taskId}.\n`);
}

function settleWorkerRecord({ taskId, verdict, source, reason, acceptFailedTransport = false, asJson, workspaceRoot, env, stdout }) {
  const worker = recordWorkerAcceptance({ taskId, acceptance: verdict, env, source, reason, acceptFailedTransport });
  writeRecordConfirmation({ kind: "worker", worker, asJson, stdout });
  const peerJobId = typeof worker.peerJobId === "string" && ENGINE_JOB_ID_PATTERN.test(worker.peerJobId) ? worker.peerJobId : null;
  if (!peerJobId) {
    return [worker];
  }
  const engine = worker.peerEngine === "codex" || worker.peerEngine === "grok" ? worker.peerEngine : resolveEngineJob(peerJobId, env);
  recordEngineAcceptance({ engine, jobId: peerJobId, verdict, reason, acceptFailedTransport, workspaceRoot, asJson, env });
  writeRecordConfirmation({ kind: "engine", engine, jobId: peerJobId, worker, asJson, stdout });
  return [worker, { engine, jobId: peerJobId, acceptance: verdict }];
}

function settleEngineRecord({ jobId, verdict, source, reason, acceptFailedTransport = false, asJson, workspaceRoot, env, stdout }) {
  const engine = resolveEngineJob(jobId, env);
  const confirmation = { engine, jobId, acceptance: verdict };
  recordEngineAcceptance({ engine, jobId, verdict, reason, acceptFailedTransport, workspaceRoot, asJson, env });
  writeRecordConfirmation({ kind: "engine", engine, jobId, worker: confirmation, asJson, stdout });
  const writes = [confirmation];
  for (const record of readWorkerRecords(env).filter((candidate) => candidate.peerJobId === jobId)) {
    const worker = recordWorkerAcceptance({ taskId: record.taskId, acceptance: verdict, env, source, reason, acceptFailedTransport });
    writeRecordConfirmation({ kind: "worker", worker, asJson, stdout });
    writes.push(worker);
  }
  return writes;
}

function settleRecords({ records, source, reason, acceptFailedTransport = false, asJson, workspaceRoot, env, stdout }) {
  const writes = [];
  for (const { id, verdict } of records) {
    if (FUSION_TASK_ID_PATTERN.test(id)) {
      writes.push(...settleWorkerRecord({ taskId: id, verdict, source, reason, acceptFailedTransport, asJson, workspaceRoot, env, stdout }));
    } else {
      writes.push(...settleEngineRecord({ jobId: id, verdict, source, reason, acceptFailedTransport, asJson, workspaceRoot, env, stdout }));
    }
  }
  return writes;
}

export function main(argv = process.argv.slice(2), { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  const asJson = argv.includes("--json");
  const effectiveEnv = argv.includes("--include-legacy") ? { ...env, FUSION_CODEX_INCLUDE_LEGACY: "1" } : env;

  if (argv.includes("--audit")) {
    const all = argv.includes("--all");
    const report = buildAuditReport({
      env: effectiveEnv,
      sessionId: argv.includes("--session") ? sessionIdFromArgs(argv, effectiveEnv) : null,
      days: all ? null : positiveAuditDays(argumentValue(argv, "--days")),
      all
    });
    stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : renderAuditReport(report));
    return report;
  }

  if (argv.includes("--record")) {
    const request = parseRecordArguments(argv);
    return settleRecords({ ...request, workspaceRoot: cwd, env: effectiveEnv, stdout });
  }

  if (argv.includes("--record-acceptance")) {
    if (argv.includes("--session")) {
      throw new TypeError("--session cannot be used with --record-acceptance; acceptance is bound to the current Claude session.");
    }
    const index = argv.indexOf("--record-acceptance");
    const workspaceRoot = argumentValue(argv, "--workspace") ?? cwd;
    const acceptanceRequest = {
      jobId: argv[index + 1],
      acceptance: argv[index + 2],
      workspaceRoot,
      env: effectiveEnv,
      sessionId: effectiveEnv.CLAUDE_CODE_SESSION_ID || null,
      reason: argumentValue(argv, "--reason"),
      source: argumentValue(argv, "--source") ?? "collector"
    };
    const preparedAcceptance = prepareCodexAcceptance(acceptanceRequest);
    const codexFound = codexJobExists(preparedAcceptance.observation.jobId, effectiveEnv);
    const grokJob = codexFound ? null : grokJobById(preparedAcceptance.observation.jobId, effectiveEnv);
    if (grokJob) {
      recordGrokCompanionAcceptance({
        jobId: preparedAcceptance.observation.jobId,
        acceptance: preparedAcceptance.observation.acceptance,
        reason: preparedAcceptance.normalizedReason,
        acceptFailedTransport: argv.includes("--accept-failed-transport"),
        workspaceRoot: preparedAcceptance.normalizedRoot,
        asJson,
        env: effectiveEnv
      });
      const observation = { ...preparedAcceptance.observation, engine: "grok" };
      stdout.write(asJson ? `${JSON.stringify(observation, null, 2)}\n` : `Recorded ${observation.acceptance} for Grok job ${observation.jobId}.\n`);
      return observation;
    }
    const companion = recordCodexCompanionAcceptance({
      jobId: preparedAcceptance.observation.jobId,
      acceptance: preparedAcceptance.observation.acceptance,
      reason: preparedAcceptance.normalizedReason,
      acceptFailedTransport: argv.includes("--accept-failed-transport"),
      workspaceRoot: preparedAcceptance.normalizedRoot,
      env: effectiveEnv
    });
    const observation = recordCodexAcceptance(acceptanceRequest);
    if (!companion.updated) {
      stderr.write("Warning: Codex job record was not updated because the companion or subcommand is unavailable.\n");
    }
    stdout.write(asJson ? `${JSON.stringify(observation, null, 2)}\n` : `Recorded ${observation.acceptance} for Codex job ${observation.jobId}.\n`);
    return observation;
  }

  if (argv.includes("--record-worker-acceptance")) {
    const index = argv.indexOf("--record-worker-acceptance");
    const observation = recordWorkerAcceptance({
      taskId: argv[index + 1],
      acceptance: argv[index + 2],
      env: effectiveEnv,
      reason: argumentValue(argv, "--reason"),
      source: argumentValue(argv, "--source") ?? "main-loop",
      acceptFailedTransport: argv.includes("--accept-failed-transport")
    });
    stdout.write(asJson ? `${JSON.stringify(observation, null, 2)}\n` : `Recorded ${observation.acceptance} for Fusion worker task ${observation.taskId}.\n`);
    return observation;
  }

  if (argv.includes("--prune-dead")) {
    const result = pruneDeadWorkspaces({ env: effectiveEnv, yes: argv.includes("--yes") });
    stdout.write(asJson ? `${JSON.stringify(result, null, 2)}\n` : renderPruneReport(result));
    return result;
  }

  if (argv.includes("--trace")) {
    const report = buildTraceReport({ env: effectiveEnv, cwd, sessionId: sessionIdFromArgs(argv, effectiveEnv) });
    stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : renderTraceReport(report));
    return report;
  }

  if (argv.includes("--session")) {
    const report = buildSessionReport({ env: effectiveEnv, sessionId: sessionIdFromArgs(argv, effectiveEnv) });
    stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : renderSessionReport(report));
    return report;
  }

  const all = argv.includes("--all");
  const report = buildFusionStats({ all, env: effectiveEnv, cwd });
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

function runCli(argv = process.argv.slice(2)) {
  if (argv[0] === "transport-create") {
    if (argv.length !== 1) {
      throw new TypeError("transport-create does not accept arguments.");
    }
    process.stdout.write(`${JSON.stringify(createRawArgsTransport())}\n`);
    return;
  }
  if (argv[0] === "transport-discard") {
    if (argv.length !== 3 || argv[1] !== "--raw-args-token") {
      throw new TypeError("transport-discard requires --raw-args-token TOKEN.");
    }
    consumeRawArgsTransport(argv[2]);
    return;
  }
  if (isStrictDirectRecordArguments(argv)) {
    main(argv);
    return;
  }
  if (argv[0] !== "--raw-args-token") {
    throw new TypeError("Fusion stats requests must be supplied through --raw-args-token.");
  }
  const transport = resolveRawArgsTransport(argv);
  main(transport.argv);
}

if (isMain()) {
  runCli();
}
