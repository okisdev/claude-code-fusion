#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FILE_ENGINE_DESCRIPTORS,
  appendTokenUsageObservation,
  fusionRepositoryKey,
  loadModelAuditObservations,
  normalizeCodexTokenUsage,
  resolveFusionDataDir,
  fusionWorkspaceKey,
  tokenUsageSidecarPath,
  workspaceRootsShareRepository
} from "./fusion-stats.mjs";

const CURRENT_TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);
const LEGACY_TERMINAL_STATUSES = new Set(["completed", "failed"]);
const TERMINAL_STATUSES = new Set([...CURRENT_TERMINAL_STATUSES, ...LEGACY_TERMINAL_STATUSES]);
const DEFAULT_POLL_INTERVAL_MS = 15000;
const INTERVAL_ENV = "CODEX_JOBS_MONITOR_INTERVAL_MS";
const PS_COMMAND_ENV = "CODEX_JOBS_MONITOR_PS_COMMAND";
const SESSIONS_DIR_ENV = "CODEX_JOBS_MONITOR_SESSIONS_DIR";
const SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";
const ERROR_MESSAGE_MAX_LENGTH = 80;
const DEAD_STATUS_KEY = "dead";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MODEL_AUDIT_FILENAME = "model-audit.jsonl";
const TERMINAL_LEDGER_SCHEMA_VERSION = 3;

function resolvePollIntervalMs(env = process.env) {
  const raw = env[INTERVAL_ENV];
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_MS;
}

function resolveStateRoot(env = process.env) {
  const descriptor = FILE_ENGINE_DESCRIPTORS.codex;
  const override = env[descriptor.stateEnvVar];
  return override || descriptor.defaultStateRoot(env);
}

function resolveWorkspaceRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (result.status === 0) {
    const root = result.stdout.trim();
    if (root) {
      return root;
    }
  }
  return cwd;
}

function readWorkspaceJobsSnapshot(root, workspaceRoot, repositoryCache = new Map()) {
  try {
    if (!fs.statSync(root).isDirectory()) {
      return { available: false, records: [] };
    }
    const records = [];
    const recordIds = new Set();
    const scopeRepositoryKey = fusionRepositoryKey(workspaceRoot, repositoryCache);
    for (const workspace of fs.readdirSync(root, { withFileTypes: true })) {
      if (!workspace.isDirectory()) {
        continue;
      }
      const dir = path.join(root, workspace.name, "jobs");
      let entries;
      try {
        entries = fs.readdirSync(dir).filter((entry) => entry.endsWith(".json"));
      } catch (error) {
        if (error?.code === "ENOENT") {
          continue;
        }
        return { available: false, records: [], recordIds: new Set() };
      }
      for (const entry of entries) {
        const fileId = entry.slice(0, -".json".length);
        try {
          const recordFile = path.join(dir, entry);
          const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
          const storedRepositoryKey = typeof record?.repositoryKey === "string" && record.repositoryKey.trim() ? record.repositoryKey.trim() : null;
          if ((storedRepositoryKey && storedRepositoryKey === scopeRepositoryKey) || (!storedRepositoryKey && workspaceRootsShareRepository(record?.workspaceRoot, workspaceRoot, repositoryCache))) {
            records.push(record);
            if (record?.id) {
              recordIds.add(record.id);
            }
          }
        } catch {
          if (fileId) {
            recordIds.add(fileId);
          }
        }
      }
    }
    return { available: true, records, recordIds };
  } catch {
    return { available: false, records: [], recordIds: new Set() };
  }
}

function truncateErrorMessage(message) {
  const firstLine = String(message).split("\n")[0].trim();
  if (firstLine.length <= ERROR_MESSAGE_MAX_LENGTH) {
    return firstLine;
  }
  return `${firstLine.slice(0, ERROR_MESSAGE_MAX_LENGTH)}...`;
}

function formatOutcomeLine(record) {
  const isFailureLike = record.status === "error" || record.status === "failed" || record.status === "cancelled";
  const truncated = isFailureLike && record.errorMessage ? truncateErrorMessage(record.errorMessage) : "";
  const failureMessage = truncated.endsWith("...") ? truncated : truncated.replace(/[.!?]+$/, "");
  const failureSuffix = failureMessage ? ` (${failureMessage})` : "";
  return `codex job ${record.id} ${record.status}${failureSuffix}. collect with /codex:result ${record.id}; completion notices do not replace collection.`;
}

function shouldAnnounceTerminal(record) {
  return !Object.hasOwn(record, "background") || record.background === true;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function nonEmptyRequestField(value) {
  if (value == null) {
    return false;
  }
  return String(value).trim() !== "";
}

function recordLacksModelOrEffort(record) {
  const request = record?.request;
  if (!request || typeof request !== "object") {
    return true;
  }
  return !nonEmptyRequestField(request.model) || !nonEmptyRequestField(request.effort);
}

function readProcessArgv(pid, env = process.env) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const command = env[PS_COMMAND_ENV] || "ps";
  try {
    const result = spawnSync(command, ["-o", "args=", "-p", String(pid)], {
      encoding: "utf8"
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    const args = String(result.stdout ?? "").trim();
    return args || null;
  } catch {
    return null;
  }
}

function parseModelAndEffortFromArgv(argvLine) {
  if (!argvLine || !String(argvLine).trim()) {
    return null;
  }
  const tokens = String(argvLine).trim().split(/\s+/).filter(Boolean);
  let model = null;
  let effort = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--model" || token === "-m") {
      const value = tokens[index + 1];
      if (value && !value.startsWith("-")) {
        model = value;
        index += 1;
      }
      continue;
    }
    if (token.startsWith("--model=")) {
      const value = token.slice("--model=".length);
      if (value) {
        model = value;
      }
      continue;
    }
    if (token === "--effort") {
      const value = tokens[index + 1];
      if (value && !value.startsWith("-")) {
        effort = value;
        index += 1;
      }
      continue;
    }
    if (token.startsWith("--effort=")) {
      const value = token.slice("--effort=".length);
      if (value) {
        effort = value;
      }
    }
  }
  if (model == null && effort == null) {
    return null;
  }
  return { model, effort };
}

function modelAuditSidecarPath(workspaceRoot, env = process.env) {
  return path.join(resolveFusionDataDir(env), "observations", fusionWorkspaceKey(workspaceRoot), MODEL_AUDIT_FILENAME);
}

function appendModelAuditObservation(sidecarPath, observation) {
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  const lockPath = `${sidecarPath}.lock`;
  let lock;
  try {
    lock = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    const current = loadModelAuditObservations(sidecarPath).get(observation.jobId);
    if (current && (current.source === "rollout-turn-context" || observation.source !== "rollout-turn-context")) {
      return true;
    }
    fs.appendFileSync(sidecarPath, `${JSON.stringify(observation)}\n`, "utf8");
    return true;
  } finally {
    fs.closeSync(lock);
    fs.rmSync(lockPath, { force: true });
  }
}

function resolveSessionsDir(env = process.env) {
  const override = env[SESSIONS_DIR_ENV];
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  if (typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim()) {
    return path.join(env.CODEX_HOME.trim(), "sessions");
  }
  return path.join(os.homedir(), ".codex", "sessions");
}

function scanRolloutFiles(env) {
  const root = resolveSessionsDir(env);
  const directories = [root];
  const candidates = [];
  while (directories.length > 0) {
    const dir = directories.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        directories.push(candidate);
      } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        try {
          candidates.push({ file: candidate, mtimeMs: fs.statSync(candidate).mtimeMs });
        } catch {
          void 0;
        }
      }
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates;
}

function findRolloutFile(threadId, env = process.env, index = null) {
  if (!threadId) {
    return null;
  }
  const suffix = `${threadId}.jsonl`;
  if (!index) {
    return scanRolloutFiles(env).find((candidate) => candidate.file.endsWith(suffix))?.file ?? null;
  }
  const current = index.files.find((candidate) => candidate.file.endsWith(suffix));
  if (current) {
    return current.file;
  }
  if (Date.now() - index.scannedAt >= 1000) {
    index.files = scanRolloutFiles(env);
    index.scannedAt = Date.now();
  }
  return index.files.find((candidate) => candidate.file.endsWith(suffix))?.file ?? null;
}

function readRolloutEntries(file) {
  const entries = [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return entries;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(JSON.parse(line));
    } catch {
      void 0;
    }
  }
  return entries;
}

function eventTurnId(entry) {
  return nonEmptyRequestField(entry?.payload?.turn_id) ? String(entry.payload.turn_id).trim() : null;
}

function cumulativeUsage(entry) {
  if (entry?.type !== "event_msg" || entry?.payload?.type !== "token_count") {
    return null;
  }
  return normalizeCodexTokenUsage(entry?.payload?.info?.total_token_usage);
}

function subtractUsage(end, start) {
  const usage = {};
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]) {
    const value = end[key] - start[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      return null;
    }
    usage[key] = value;
  }
  return usage;
}

export function inspectCodexRollout(record, env = process.env, rolloutIndex = null) {
  const threadId = record?.result?.threadId ?? record?.threadId ?? null;
  const turnId = record?.turnId ?? record?.result?.turnId ?? null;
  if (!threadId || !turnId) {
    return { availability: "unavailable", reason: "missing_thread_or_turn_id", threadId, turnId, model: null, effort: null, tokenUsage: null };
  }
  const file = findRolloutFile(threadId, env, rolloutIndex);
  if (!file) {
    return { availability: "unavailable", reason: "rollout_not_found", threadId, turnId, model: null, effort: null, tokenUsage: null };
  }
  const entries = readRolloutEntries(file);
  let model = null;
  let effort = null;
  let startIndex = -1;
  let endIndex = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.type === "turn_context" && eventTurnId(entry) === turnId) {
      model = nonEmptyRequestField(entry.payload.model) ? String(entry.payload.model).trim() : model;
      effort = nonEmptyRequestField(entry.payload.effort) ? String(entry.payload.effort).trim() : effort;
    }
    if (entry?.type === "event_msg" && entry?.payload?.type === "task_started" && eventTurnId(entry) === turnId) {
      startIndex = index;
    }
    if (startIndex !== -1 && entry?.type === "event_msg" && entry?.payload?.type === "task_complete" && eventTurnId(entry) === turnId) {
      endIndex = index;
      break;
    }
  }
  if (startIndex === -1 || endIndex === -1) {
    return { availability: "unavailable", reason: "turn_boundary_not_found", threadId, turnId, model, effort, tokenUsage: null };
  }
  let finalUsage = null;
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    finalUsage = cumulativeUsage(entries[index]) ?? finalUsage;
  }
  if (!finalUsage) {
    return { availability: "unavailable", reason: "terminal_token_count_not_found", threadId, turnId, model, effort, tokenUsage: null };
  }
  let baseline = null;
  let earlierTurnExists = false;
  for (let index = 0; index < startIndex; index += 1) {
    baseline = cumulativeUsage(entries[index]) ?? baseline;
    if (entries[index]?.type === "event_msg" && entries[index]?.payload?.type === "task_started") {
      earlierTurnExists = true;
    }
  }
  if (!baseline && earlierTurnExists) {
    return { availability: "unavailable", reason: "resume_baseline_not_found", threadId, turnId, model, effort, tokenUsage: null };
  }
  const zero = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  const tokenUsage = subtractUsage(finalUsage, baseline ?? zero);
  if (!tokenUsage) {
    return { availability: "unavailable", reason: "invalid_turn_token_delta", threadId, turnId, model, effort, tokenUsage: null };
  }
  return { availability: "available", reason: null, threadId, turnId, model, effort, tokenUsage };
}

function maybeCaptureModelAudit(record, seenJobIds, sidecarPath, env = process.env) {
  if (!record?.id || seenJobIds.has(record.id)) {
    return;
  }
  if (record.status !== "running" || !recordLacksModelOrEffort(record)) {
    return;
  }
  const argvLine = readProcessArgv(record.pid, env);
  if (!argvLine) {
    return;
  }
  const parsed = parseModelAndEffortFromArgv(argvLine);
  if (!parsed) {
    return;
  }
  const observation = {
    jobId: record.id,
    engine: "codex",
    model: parsed.model,
    effort: parsed.effort,
    workspaceRoot: record.workspaceRoot ?? null,
    repositoryKey: record.repositoryKey ?? fusionRepositoryKey(record.workspaceRoot),
    source: "argv",
    observedAt: new Date().toISOString()
  };
  try {
    if (appendModelAuditObservation(sidecarPath, observation)) {
      seenJobIds.add(record.id);
    }
  } catch {
    void 0;
  }
}

function terminalObservations(record, env = process.env, rolloutIndex = null) {
  const workspaceRoot = record?.workspaceRoot;
  const usesLegacyContract = LEGACY_TERMINAL_STATUSES.has(record?.status) || (record?.status === "cancelled" && !record?.finishedAt && record?.completedAt);
  const rollout = usesLegacyContract
    ? inspectCodexRollout(record, env, rolloutIndex)
    : {
        availability: "unavailable",
        reason: record?.tokenUsageUnavailableReason ?? "job_record_unavailable",
        threadId: record?.threadId ?? record?.result?.threadId ?? null,
        turnId: record?.turnId ?? record?.result?.turnId ?? null,
        model: null,
        effort: null,
        tokenUsage: null
      };
  if (workspaceRoot && (rollout.model || rollout.effort)) {
    try {
      appendModelAuditObservation(modelAuditSidecarPath(workspaceRoot, env), {
        schemaVersion: 1,
        jobId: record.id,
        engine: "codex",
        model: rollout.model,
        effort: rollout.effort,
        threadId: rollout.threadId,
        turnId: rollout.turnId,
        workspaceRoot,
        repositoryKey: record.repositoryKey ?? fusionRepositoryKey(workspaceRoot),
        source: "rollout-turn-context",
        observedAt: new Date().toISOString()
      });
    } catch {
      void 0;
    }
  }
  const inlineUsage = normalizeCodexTokenUsage(record?.tokenUsage ?? record?.usage ?? record?.result?.tokenUsage ?? record?.result?.usage);
  const tokenUsage = inlineUsage ?? rollout.tokenUsage;
  const availability = tokenUsage ? "available" : "unavailable";
  if (workspaceRoot) {
    try {
      appendTokenUsageObservation(tokenUsageSidecarPath(workspaceRoot, env), {
        schemaVersion: 1,
        jobId: record.id,
        engine: "codex",
        workspaceRoot,
        repositoryKey: record.repositoryKey ?? fusionRepositoryKey(workspaceRoot),
        availability,
        tokenUsage,
        reason: tokenUsage ? null : rollout.reason,
        threadId: rollout.threadId,
        turnId: rollout.turnId,
        source: inlineUsage ? "job-record" : rollout.tokenUsage ? "rollout-turn-delta" : "unavailable",
        observedAt: new Date().toISOString()
      });
    } catch {
      void 0;
    }
  }
  const existingModel = workspaceRoot ? loadModelAuditObservations(modelAuditSidecarPath(workspaceRoot, env)).get(record.id) : null;
  const requestedModel = nonEmptyRequestField(record?.request?.model) ? String(record.request.model).trim() : null;
  const requestedEffort = nonEmptyRequestField(record?.request?.effort) ? String(record.request.effort).trim() : null;
  return {
    model: rollout.model ?? requestedModel ?? existingModel?.model ?? null,
    modelSource: rollout.model ? "rollout-turn-context" : requestedModel ? "job-request" : existingModel?.source ?? null,
    effort: rollout.effort ?? requestedEffort ?? existingModel?.effort ?? null,
    effortSource: rollout.effort ? "rollout-turn-context" : requestedEffort ? "job-request" : existingModel?.source ?? null,
    tokenUsage,
    tokenUsageAvailability: availability
  };
}

function terminalLedgerRecord(record, observations, scopeRoot) {
  const workspaceRoot = record.workspaceRoot ?? scopeRoot;
  return {
    schemaVersion: 1,
    jobId: record.id,
    transportStatus: record.status,
    workspaceRoot,
    repositoryKey: record.repositoryKey ?? fusionRepositoryKey(workspaceRoot),
    sessionId: record.sessionId ?? null,
    kind: record.jobClass ?? record.kind ?? "unknown",
    createdAt: record.createdAt ?? null,
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? record.completedAt ?? record.updatedAt ?? null,
    observedAt: new Date().toISOString(),
    model: observations.model,
    modelSource: observations.modelSource,
    effort: observations.effort,
    effortSource: observations.effortSource,
    tokenUsage: observations.tokenUsage,
    tokenUsageAvailability: observations.tokenUsageAvailability
  };
}

function announcementKey(id, status) {
  return `${id}:${status}`;
}

function workspaceKey(workspaceRoot) {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}

function announcedStatePath(stateRoot, sessionId, workspaceRoot) {
  const sessionPart = sessionId ? `.${sessionId}` : "";
  return path.join(stateRoot, `codex-jobs-monitor-announced${sessionPart}.${workspaceKey(workspaceRoot)}.json`);
}

function quarantineMalformed(file) {
  const quarantine = `${file}.corrupt.${Date.now()}.${process.pid}`;
  try {
    fs.renameSync(file, quarantine);
  } catch {}
  return quarantine;
}

function legacyTerminalRecord(key, workspaceRoot) {
  const separator = key.lastIndexOf(":");
  if (separator <= 0) {
    return null;
  }
  const transportStatus = key.slice(separator + 1);
  if (!TERMINAL_STATUSES.has(transportStatus)) {
    return null;
  }
  return {
    schemaVersion: 1,
    jobId: key.slice(0, separator),
    transportStatus,
    workspaceRoot,
    repositoryKey: fusionRepositoryKey(workspaceRoot),
    sessionId: null,
    kind: "unknown",
    createdAt: null,
    startedAt: null,
    finishedAt: null,
    observedAt: null,
    model: null,
    effort: null,
    tokenUsage: null,
    tokenUsageAvailability: "unavailable"
  };
}

function loadAnnounced(file, workspaceRoot) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { exists: error?.code !== "ENOENT", malformed: false, needsMigration: false, announced: new Set(), records: new Map() };
  }
  try {
    const raw = JSON.parse(text);
    const keys = Array.isArray(raw) ? raw : Array.isArray(raw?.keys) ? raw.keys : null;
    if (!keys) {
      throw new TypeError("invalid announcement state");
    }
    const announced = new Set(keys.filter((key) => typeof key === "string"));
    const records = new Map();
    if (Array.isArray(raw?.records)) {
      for (const record of raw.records) {
        if (!record?.jobId || !TERMINAL_STATUSES.has(record?.transportStatus)) {
          continue;
        }
        records.set(announcementKey(record.jobId, record.transportStatus), {
          ...record,
          repositoryKey: record.repositoryKey ?? fusionRepositoryKey(workspaceRoot)
        });
      }
    }
    for (const key of announced) {
      if (!records.has(key)) {
        const record = legacyTerminalRecord(key, workspaceRoot);
        if (record) {
          records.set(key, record);
        }
      }
    }
    return { exists: true, malformed: false, needsMigration: Array.isArray(raw) || raw?.schemaVersion !== TERMINAL_LEDGER_SCHEMA_VERSION, announced, records };
  } catch {
    quarantineMalformed(file);
    return { exists: true, malformed: true, needsMigration: false, announced: new Set(), records: new Map() };
  }
}

function saveAnnounced(file, announced, records, workspaceRoot) {
  const dir = path.dirname(file);
  if (!fs.statSync(dir).isDirectory()) {
    return;
  }
  const temp = `${file}.${process.pid}.tmp`;
  const state = {
    schemaVersion: TERMINAL_LEDGER_SCHEMA_VERSION,
    engine: "codex",
    workspaceRoot,
    repositoryKey: fusionRepositoryKey(workspaceRoot),
    updatedAt: new Date().toISOString(),
    keys: [...announced].sort(),
    records: [...records.values()].sort((left, right) => `${left.jobId}:${left.transportStatus}`.localeCompare(`${right.jobId}:${right.transportStatus}`))
  };
  fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function pruneAnnounced(announced, liveIds) {
  let dirty = false;
  for (const key of [...announced]) {
    const separator = key.lastIndexOf(":");
    const id = separator > 0 ? key.slice(0, separator) : null;
    const status = separator > 0 ? key.slice(separator + 1) : null;
    if ((!id || !liveIds.has(id)) && status === DEAD_STATUS_KEY) {
      announced.delete(key);
      dirty = true;
    }
  }
  return dirty;
}

function pruneOldStateFiles(stateRoot, currentFile) {
  let entries;
  try {
    entries = fs.readdirSync(stateRoot);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith("codex-jobs-monitor-announced") || path.join(stateRoot, entry) === currentFile) {
      continue;
    }
    const file = path.join(stateRoot, entry);
    try {
      if (now - fs.statSync(file).mtimeMs > RETENTION_MS) {
        fs.rmSync(file, { force: true });
      }
    } catch {}
  }
}

function safeWriteLine(line) {
  try {
    process.stdout.write(`${line}\n`);
  } catch (error) {
    if (error?.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
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
  process.stdout.on("error", (error) => {
    if (error?.code === "EPIPE") {
      clearInterval(timer);
      process.exit(0);
    }
  });
}

function main() {
  const root = resolveStateRoot();
  const cwd = process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const ownSessionId = process.env[SESSION_ID_ENV] || null;
  const stateFile = announcedStatePath(root, ownSessionId, workspaceRoot);
  const loaded = loadAnnounced(stateFile, workspaceRoot);
  const announced = loaded.announced;
  const terminalRecords = loaded.records;
  const inspectedTerminalKeys = new Set();
  const rolloutIndex = { files: [], scannedAt: 0 };
  const repositoryCache = new Map();
  const auditStates = new Map();
  let startupPending = true;

  pruneOldStateFiles(root, stateFile);

  const processSnapshot = (snapshot) => {
    if (!snapshot.available) {
      return;
    }
    const records = snapshot.records;
    const liveIds = new Set(snapshot.recordIds);
    const terminalJobIds = new Set(records.filter((record) => record?.id && TERMINAL_STATUSES.has(record.status)).map((record) => record.id));
    let dirty = false;
    for (const record of records) {
      if (!record?.id) {
        continue;
      }
      liveIds.add(record.id);
      if (TERMINAL_STATUSES.has(record.status)) {
        const key = announcementKey(record.id, record.status);
        if (!inspectedTerminalKeys.has(key)) {
          const observations = terminalObservations(record, process.env, rolloutIndex);
          terminalRecords.set(key, terminalLedgerRecord(record, observations, workspaceRoot));
          inspectedTerminalKeys.add(key);
          dirty = true;
        }
        if (!announced.has(key)) {
          announced.add(key);
          dirty = true;
          if (shouldAnnounceTerminal(record) && !(startupPending && !loaded.exists) && (!ownSessionId || record.sessionId === ownSessionId)) {
            safeWriteLine(formatOutcomeLine(record));
          }
        }
        continue;
      }
      const recordWorkspaceRoot = record.workspaceRoot;
      if (!auditStates.has(recordWorkspaceRoot)) {
        const sidecarPath = modelAuditSidecarPath(recordWorkspaceRoot);
        auditStates.set(recordWorkspaceRoot, {
          sidecarPath,
          seenJobIds: new Set(loadModelAuditObservations(sidecarPath).keys())
        });
      }
      const auditState = auditStates.get(recordWorkspaceRoot);
      maybeCaptureModelAudit(record, auditState.seenJobIds, auditState.sidecarPath);
      if (record.status === "running" && !isPidAlive(record.pid)) {
        if (terminalJobIds.has(record.id)) {
          continue;
        }
        const key = announcementKey(record.id, DEAD_STATUS_KEY);
        if (startupPending && loaded.malformed) {
          if (!announced.has(key)) {
            announced.add(key);
            dirty = true;
          }
          continue;
        }
        if (startupPending && !loaded.exists) {
          continue;
        }
        if (!announced.has(key)) {
          announced.add(key);
          dirty = true;
          if (!ownSessionId || record.sessionId === ownSessionId) {
            safeWriteLine(`codex job ${record.id} appears dead (process gone, status still running)`);
          }
        }
      }
    }
    if (pruneAnnounced(announced, liveIds)) {
      dirty = true;
    }
    if (startupPending && (!loaded.exists || loaded.needsMigration)) {
      dirty = true;
    }
    if (dirty) {
      saveAnnounced(stateFile, announced, terminalRecords, workspaceRoot);
    }
    startupPending = false;
  };

  try {
    const initialSnapshot = readWorkspaceJobsSnapshot(root, workspaceRoot, repositoryCache);
    processSnapshot(initialSnapshot);
    if (!initialSnapshot.available) {
      startupPending = false;
    }
  } catch {}

  const timer = setInterval(() => {
    try {
      processSnapshot(readWorkspaceJobsSnapshot(root, workspaceRoot, repositoryCache));
    } catch {}
  }, resolvePollIntervalMs());

  installExitHandlers(timer);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
