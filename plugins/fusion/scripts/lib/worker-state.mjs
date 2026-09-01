import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR_ENV = "FUSION_DATA_DIR";
const WORKER_STATE_ENV = "FUSION_WORKER_STATE_DIR";
const RETENTION_DAYS_ENV = "FUSION_WORKER_RETENTION_DAYS";
const DEFAULT_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECORD_SIDECAR_SUFFIXES = ["final.txt", "brief.txt"];
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10;
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const LOCK_TIMEOUT_ENV = "FUSION_LOCK_TIMEOUT_MS";
const TRANSCRIPT_CHUNK_BYTES = 1024 * 1024;
const TRANSCRIPT_REFRESH_BYTES = 8 * TRANSCRIPT_CHUNK_BYTES;
const TRANSCRIPT_CARRY_BYTES = 256 * 1024;
const TASK_OUTPUT_TRANSCRIPT_MAX_BYTES = 50 * 1024 * 1024;
const TASK_OUTPUT_TRANSCRIPT_CHUNK_BYTES = 64 * 1024;
const TASK_OUTPUT_TRANSCRIPT_MAX_LINE_BYTES = 1024 * 1024;
const TERMINAL_STATUSES = new Set(["done", "incomplete", "failed", "cancelled", "owner_ended"]);
const ACCEPTANCE_STATES = new Set(["accepted", "rejected", "unverified"]);
const SEMANTIC_FAILURE_KINDS = new Set(["intent_override", "scope_rewrite", "wrong_approach", "style_mismatch", "oversized"]);
export const WORKER_COLLECTION_METHODS = Object.freeze({
  SUBAGENT_STOP: "subagent_stop",
  TASK_NOTIFICATION: "task_notification",
  TASK_OUTPUT: "task_output",
  OUTPUT_FILE_READ: "output_file_read",
  AGENT_RESULT: "agent_result",
  TASK_STOP: "task_stop",
  TASK_REAPED: "task_reaped"
});
const COLLECTION_METHODS_BY_KEY = new Map([
  ["subagentstop", WORKER_COLLECTION_METHODS.SUBAGENT_STOP],
  ["tasknotification", WORKER_COLLECTION_METHODS.TASK_NOTIFICATION],
  ["taskoutput", WORKER_COLLECTION_METHODS.TASK_OUTPUT],
  ["read", WORKER_COLLECTION_METHODS.OUTPUT_FILE_READ],
  ["outputfileread", WORKER_COLLECTION_METHODS.OUTPUT_FILE_READ],
  ["agent", WORKER_COLLECTION_METHODS.AGENT_RESULT],
  ["agentresult", WORKER_COLLECTION_METHODS.AGENT_RESULT],
  ["taskstop", WORKER_COLLECTION_METHODS.TASK_STOP],
  ["reaped", WORKER_COLLECTION_METHODS.TASK_REAPED],
  ["taskreaped", WORKER_COLLECTION_METHODS.TASK_REAPED]
]);
const PEER_JOB_FOOTER_AGENT_TYPES = new Set(["codex:codex-rescue", "grok:grok-rescue", "grok:grok-review-runner"]);
const AGENT_TYPES = new Map([
  ["fusion:fast-worker", "fusion:fast-worker"],
  ["fast-worker", "fusion:fast-worker"],
  ["fusion:claude-worker", "fusion:claude-worker"],
  ["claude-worker", "fusion:claude-worker"],
  ["fusion:trivial-worker", "fusion:trivial-worker"],
  ["trivial-worker", "fusion:trivial-worker"],
  ["fusion:deep-reasoner", "fusion:deep-reasoner"],
  ["deep-reasoner", "fusion:deep-reasoner"],
  ["fusion:job-collector", "fusion:job-collector"],
  ["job-collector", "fusion:job-collector"]
]);
let cachedFusionCompanionVersion;

function resolvePluginRoot(env = process.env) {
  if (env.CLAUDE_PLUGIN_ROOT && env.CLAUDE_PLUGIN_ROOT.trim()) {
    return path.resolve(env.CLAUDE_PLUGIN_ROOT.trim());
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function resolveFusionCompanionVersion(env = process.env) {
  if (cachedFusionCompanionVersion !== undefined) {
    return cachedFusionCompanionVersion;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(resolvePluginRoot(env), ".claude-plugin", "plugin.json"), "utf8"));
    cachedFusionCompanionVersion = typeof manifest?.version === "string" ? manifest.version : null;
  } catch {
    cachedFusionCompanionVersion = null;
  }
  return cachedFusionCompanionVersion;
}

export function resolveLockTimeoutMs(env = process.env) {
  const raw = env[LOCK_TIMEOUT_ENV];
  if (raw === undefined || raw === null || (typeof raw === "string" && !String(raw).trim())) {
    return DEFAULT_LOCK_TIMEOUT_MS;
  }
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LOCK_TIMEOUT_MS;
}

function waitForLock() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
}

function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(file), 0o700);
  } catch {
    void 0;
  }
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + resolveLockTimeoutMs();
  for (;;) {
    try {
      const descriptor = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeFileSync(descriptor, String(process.pid));
      try {
        fs.fchmodSync(descriptor, 0o600);
      } catch {
        void 0;
      }
      return () => {
        fs.closeSync(descriptor);
        fs.rmSync(lockFile, { force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") {
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for Fusion worker state lock");
      }
      waitForLock();
    }
  }
}

function withLock(file, callback) {
  const release = acquireLock(file);
  try {
    return callback();
  } finally {
    release();
  }
}

export function resolveFusionDataDir(env = process.env) {
  const override = env[DATA_DIR_ENV];
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "fusion-claude-code-fusion");
}

export function resolveWorkerStateDir(env = process.env) {
  const override = env[WORKER_STATE_ENV];
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return path.join(resolveFusionDataDir(env), "workers");
}

export function resolveWorkerRetentionDays(env = process.env) {
  const parsed = Number.parseInt(String(env[RETENTION_DAYS_ENV]), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

function readDirectorySafely(directory) {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

function removeSafely(file) {
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

function expiredBefore(file, cutoffMs) {
  try {
    return fs.statSync(file).mtimeMs < cutoffMs;
  } catch {
    return false;
  }
}

export function pruneExpiredWorkerRecords(env = process.env, nowMs = Date.now()) {
  const retentionDays = resolveWorkerRetentionDays(env);
  const summary = { records: 0, sessions: 0 };
  if (retentionDays === 0) {
    return summary;
  }
  const cutoffMs = nowMs - retentionDays * DAY_MS;
  const root = resolveWorkerStateDir(env);
  const jobsDir = path.join(root, "jobs");
  for (const entry of readDirectorySafely(jobsDir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const file = path.join(jobsDir, entry);
    if (!expiredBefore(file, cutoffMs)) {
      continue;
    }
    const record = readWorkerRecordFile(file);
    if (record && !isTerminalWorkerStatus(record.transportStatus)) {
      continue;
    }
    const taskId = entry.slice(0, -".json".length);
    for (const suffix of RECORD_SIDECAR_SUFFIXES) {
      removeSafely(path.join(jobsDir, `${taskId}.${suffix}`));
    }
    if (removeSafely(file)) {
      summary.records += 1;
    }
  }
  const sessionsDir = path.join(root, "sessions");
  for (const entry of readDirectorySafely(sessionsDir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const file = path.join(sessionsDir, entry);
    if (expiredBefore(file, cutoffMs) && removeSafely(file)) {
      summary.sessions += 1;
    }
  }
  return summary;
}

export function canonicalWorkerAgentType(value) {
  return typeof value === "string" ? AGENT_TYPES.get(value) ?? null : null;
}

export function isFusionWorkerAgent(value) {
  return canonicalWorkerAgentType(value) != null;
}

function workerLane(value) {
  return canonicalWorkerAgentType(value);
}

export function isTerminalWorkerStatus(value) {
  return TERMINAL_STATUSES.has(value);
}

export function workerRecordFile(taskId, env = process.env) {
  if (typeof taskId !== "string" || !/^[a-z0-9][a-z0-9-]{7,79}$/.test(taskId)) {
    throw new TypeError("Fusion worker task id is invalid.");
  }
  return path.join(resolveWorkerStateDir(env), "jobs", `${taskId}.json`);
}

function workerSessionStateFile(sessionId, env = process.env) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)) {
    throw new TypeError("Fusion worker session id is invalid.");
  }
  return path.join(resolveWorkerStateDir(env), "sessions", `${sessionId}.json`);
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    void 0;
  }
}

function writePrivateFile(file, content) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(descriptor, content);
    fs.fchmodSync(descriptor, 0o600);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    void 0;
  }
}

export function writePrivateText(file, text) {
  writePrivateFile(file, text);
}

function writePrivateJson(file, value) {
  writePrivateFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function canonicalCollectionMethod(value) {
  return typeof value === "string" ? COLLECTION_METHODS_BY_KEY.get(value.replace(/[^a-z0-9]/gi, "").toLowerCase()) ?? null : null;
}

function normalizeWorkerRecord(value) {
  let normalized = value;
  if (Object.hasOwn(normalized, "collectionMethod")) {
    const collectionMethod = canonicalCollectionMethod(normalized.collectionMethod);
    if (collectionMethod !== normalized.collectionMethod) {
      normalized = { ...normalized, collectionMethod };
    }
  }
  if (typeof normalized.taskId === "string" && !Object.hasOwn(normalized, "peerFailureKind")) {
    normalized = { ...normalized, peerFailureKind: null };
  }
  return normalized;
}

function readWorkerRecordFile(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? normalizeWorkerRecord(value) : null;
  } catch {
    return null;
  }
}

export function readWorkerRecord(taskId, env = process.env) {
  return readWorkerRecordFile(workerRecordFile(taskId, env));
}

export function readWorkerSessionState(sessionId, env = process.env) {
  return readWorkerRecordFile(workerSessionStateFile(sessionId, env));
}

export function updateWorkerSessionState(sessionId, env, updater) {
  const file = workerSessionStateFile(sessionId, env);
  return withLock(file, () => {
    const current = readWorkerRecordFile(file);
    const next = updater(current);
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      return current;
    }
    writePrivateJson(file, next);
    return next;
  });
}

export function updateWorkerRecord(taskId, env, updater) {
  const file = workerRecordFile(taskId, env);
  return withLock(file, () => {
    const current = readWorkerRecordFile(file);
    const next = updater(current);
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      return current;
    }
    const updated = normalizeWorkerRecord({ ...next, updatedAt: new Date().toISOString() });
    writePrivateJson(file, updated);
    return updated;
  });
}

export function markWorkerCollected(record, method, collectedAt = new Date().toISOString()) {
  const awaitingVerdict = record.acceptance === "unverified" && record.acceptanceRecordedAt == null && (record.awaitingVerdict === true || !record.collectedAt);
  const collectionMethod = canonicalCollectionMethod(record.collectionMethod) ?? canonicalCollectionMethod(method);
  if (!collectionMethod) {
    throw new TypeError("Fusion worker collection method is invalid.");
  }
  return {
    ...record,
    collectionMethod,
    collectedAt: record.collectedAt ?? collectedAt,
    awaitingCollection: false,
    awaitingCollectionArmedAt: null,
    ...(awaitingVerdict ? {
      awaitingVerdict: true,
      awaitingVerdictArmedAt: record.awaitingVerdictArmedAt ?? collectedAt
    } : {
      awaitingVerdict: false,
      awaitingVerdictArmedAt: null
    })
  };
}

export function createWorkerTaskId(sessionId, toolUseId) {
  const entropy = `${sessionId ?? "unknown"}\0${toolUseId ?? randomUUID()}\0${Date.now()}\0${randomUUID()}`;
  return `fusion-${createHash("sha256").update(entropy).digest("hex").slice(0, 24)}`;
}

export function createWorkerRecord(record, env = process.env) {
  const file = workerRecordFile(record.taskId, env);
  try {
    pruneExpiredWorkerRecords(env);
  } catch {
    void 0;
  }
  return withLock(file, () => {
    if (readWorkerRecordFile(file)) {
      throw new Error(`Fusion worker task ${record.taskId} already exists.`);
    }
    const now = new Date().toISOString();
    const value = {
      schemaVersion: 1,
      companionVersion: resolveFusionCompanionVersion(env),
      taskId: record.taskId,
      sessionId: record.sessionId,
      dispatchToolUseId: record.dispatchToolUseId ?? null,
      agentId: null,
      backgroundTaskId: null,
      agentType: canonicalWorkerAgentType(record.agentType) ?? record.agentType,
      lane: workerLane(record.agentType) ?? record.agentType,
      description: record.description ?? null,
      workspaceRoot: path.resolve(record.workspaceRoot),
      expectedDelivery: record.expectedDelivery ?? "foreground",
      userBackgroundAuthorized: record.userBackgroundAuthorized === true,
      transportStatus: "dispatching",
      acceptance: "unverified",
      acceptanceFailureKind: record.acceptanceFailureKind ?? null,
      ...(PEER_JOB_FOOTER_AGENT_TYPES.has(record.agentType) ? { peerJobId: null } : {}),
      peerFailureKind: null,
      failureKind: null,
      deliveryMode: null,
      collectionMethod: null,
      collectedAt: null,
      awaitingCollection: false,
      awaitingCollectionArmedAt: null,
      awaitingVerdict: false,
      awaitingVerdictArmedAt: null,
      retryCount: 0,
      stopBlockCount: 0,
      turns: 0,
      toolCalls: 0,
      progressEvents: 0,
      usage: {
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        uncachedTokens: 0
      },
      usageMessages: {},
      turnIds: [],
      toolUseIds: [],
      transcriptPath: null,
      outputFile: record.outputFile ?? null,
      transcriptOffset: 0,
      transcriptCarry: "",
      transcriptSkippingLine: false,
      transcriptBacklogBytes: 0,
      usageAvailability: "unreported",
      parentTranscriptPath: record.parentTranscriptPath ?? null,
      parentTranscriptBytesAtDispatch: Number.isSafeInteger(record.parentTranscriptBytesAtDispatch) ? record.parentTranscriptBytesAtDispatch : null,
      packageType: record.packageType ?? "consult",
      briefBytes: Number.isSafeInteger(record.briefBytes) ? record.briefBytes : null,
      briefFile: record.briefFile ?? null,
      completionContract: record.completionContract ?? "verification",
      ...(record.expectedPeerEngine && record.expectedPeerJobId ? { expectedPeerEngine: record.expectedPeerEngine, expectedPeerJobId: record.expectedPeerJobId } : {}),
      createdAt: record.createdAt ?? now,
      startedAt: null,
      lastActivityAt: null,
      lastProgressAt: null,
      lastLivenessAt: null,
      finishedAt: null,
      updatedAt: now,
      limits: record.limits ?? null
    };
    writePrivateJson(file, value);
    return value;
  });
}

export function readWorkerRecords(env = process.env, { strict = false } = {}) {
  const directory = path.join(resolveWorkerStateDir(env), "jobs");
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (strict && error?.code !== "ENOENT") {
      throw error;
    }
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .flatMap((entry) => {
      const record = readWorkerRecordFile(path.join(directory, entry.name));
      if (!record && strict) {
        throw new Error(`Fusion worker record ${entry.name} is unreadable.`);
      }
      return record ? [record] : [];
    });
}

export function findWorkerRecord(predicate, env = process.env, options = {}) {
  const matches = readWorkerRecords(env, options).filter(predicate);
  matches.sort((left, right) => Date.parse(right.updatedAt ?? right.createdAt ?? "") - Date.parse(left.updatedAt ?? left.createdAt ?? ""));
  return matches[0] ?? null;
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizedUsage(value) {
  const inputTokens = integer(value?.input_tokens ?? value?.inputTokens);
  const cacheCreationInputTokens = integer(value?.cache_creation_input_tokens ?? value?.cacheCreationInputTokens);
  const cacheReadInputTokens = integer(value?.cache_read_input_tokens ?? value?.cacheReadInputTokens);
  const outputTokens = integer(value?.output_tokens ?? value?.outputTokens);
  return {
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens,
    totalTokens: inputTokens + cacheCreationInputTokens + cacheReadInputTokens + outputTokens,
    uncachedTokens: inputTokens + cacheCreationInputTokens + outputTokens
  };
}

function mergeTranscriptEntry(snapshot, entry) {
  const timestamp = typeof entry?.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp)) ? entry.timestamp : null;
  if (timestamp) {
    snapshot.lastActivityAt = timestamp;
  }
  if (entry?.type !== "assistant" || !entry.message || typeof entry.message !== "object") {
    return;
  }
  const messageId = String(entry.message.id ?? entry.requestId ?? entry.uuid ?? "").trim();
  if (messageId && entry.message.usage && typeof entry.message.usage === "object") {
    snapshot.usageMessages[messageId] = normalizedUsage(entry.message.usage);
  }
  const turnId = String(entry.requestId ?? entry.message.id ?? "").trim();
  if (turnId && !snapshot.turnIds.includes(turnId)) {
    snapshot.turnIds.push(turnId);
  }
  const content = Array.isArray(entry.message.content) ? entry.message.content : [];
  for (const block of content) {
    if (block?.type !== "tool_use") {
      continue;
    }
    const toolUseId = String(block.id ?? "").trim();
    if (toolUseId && !snapshot.toolUseIds.includes(toolUseId)) {
      snapshot.toolUseIds.push(toolUseId);
    }
  }
}

function transcriptChunk(file, offset, carry, skippingLine) {
  let descriptor;
  try {
    const stat = fs.statSync(file);
    const start = offset >= 0 && offset <= stat.size ? offset : 0;
    if (stat.size === start) {
      return { text: "", nextOffset: start, carry, skippingLine, partial: false, backlogBytes: 0 };
    }
    descriptor = fs.openSync(file, "r");
    const buffer = Buffer.allocUnsafe(Math.min(TRANSCRIPT_CHUNK_BYTES, stat.size - start));
    fs.readSync(descriptor, buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    let nextSkippingLine = skippingLine;
    let partial = false;
    if (nextSkippingLine) {
      const newline = text.indexOf("\n");
      if (newline === -1) {
        return { text: "", nextOffset: start + buffer.length, carry: "", skippingLine: true, partial: true, backlogBytes: stat.size - start - buffer.length };
      }
      text = text.slice(newline + 1);
      nextSkippingLine = false;
      partial = true;
    } else if (carry) {
      text = `${carry}${text}`;
    }
    const finalNewline = text.lastIndexOf("\n");
    if (finalNewline === -1) {
      if (Buffer.byteLength(text) > TRANSCRIPT_CARRY_BYTES) {
        return { text: "", nextOffset: start + buffer.length, carry: "", skippingLine: true, partial: true, backlogBytes: stat.size - start - buffer.length };
      }
      return { text: "", nextOffset: start + buffer.length, carry: text, skippingLine: nextSkippingLine, partial, backlogBytes: stat.size - start - buffer.length };
    }
    const nextCarry = text.slice(finalNewline + 1);
    if (Buffer.byteLength(nextCarry) > TRANSCRIPT_CARRY_BYTES) {
      return { text: text.slice(0, finalNewline), nextOffset: start + buffer.length, carry: "", skippingLine: true, partial: true, backlogBytes: stat.size - start - buffer.length };
    }
    return { text: text.slice(0, finalNewline), nextOffset: start + buffer.length, carry: nextCarry, skippingLine: nextSkippingLine, partial, backlogBytes: stat.size - start - buffer.length };
  } catch {
    return { text: "", nextOffset: offset, carry, skippingLine, partial: false, backlogBytes: 0 };
  } finally {
    if (descriptor != null) {
      fs.closeSync(descriptor);
    }
  }
}

export function refreshWorkerTranscript(record, transcriptPath) {
  const selectedPath = typeof transcriptPath === "string" && transcriptPath ? transcriptPath : record.transcriptPath;
  if (!selectedPath) {
    return record;
  }
  const sameTranscript = selectedPath === record.transcriptPath;
  const snapshot = {
    ...record,
    transcriptPath: selectedPath,
    transcriptOffset: sameTranscript ? integer(record.transcriptOffset) : 0,
    transcriptCarry: sameTranscript && typeof record.transcriptCarry === "string" ? record.transcriptCarry : "",
    transcriptSkippingLine: sameTranscript && record.transcriptSkippingLine === true,
    transcriptBacklogBytes: 0,
    usageAvailability: sameTranscript ? record.usageAvailability ?? "unreported" : "unreported",
    usageMessages: record.usageMessages && typeof record.usageMessages === "object" ? { ...record.usageMessages } : {},
    turnIds: Array.isArray(record.turnIds) ? [...record.turnIds] : [],
    toolUseIds: Array.isArray(record.toolUseIds) ? [...record.toolUseIds] : []
  };
  let refreshedBytes = 0;
  let partial = snapshot.usageAvailability === "partial";
  for (;;) {
    const previousOffset = snapshot.transcriptOffset;
    const chunk = transcriptChunk(selectedPath, snapshot.transcriptOffset, snapshot.transcriptCarry, snapshot.transcriptSkippingLine);
    for (const line of chunk.text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        mergeTranscriptEntry(snapshot, JSON.parse(line));
      } catch {
        partial = true;
      }
    }
    snapshot.transcriptOffset = chunk.nextOffset;
    snapshot.transcriptCarry = chunk.carry;
    snapshot.transcriptSkippingLine = chunk.skippingLine;
    snapshot.transcriptBacklogBytes = chunk.backlogBytes;
    partial ||= chunk.partial;
    refreshedBytes += Math.max(0, chunk.nextOffset - previousOffset);
    if (chunk.nextOffset === previousOffset || chunk.backlogBytes === 0 || refreshedBytes >= TRANSCRIPT_REFRESH_BYTES) {
      break;
    }
  }
  snapshot.turnIds = snapshot.turnIds.slice(-512);
  snapshot.toolUseIds = snapshot.toolUseIds.slice(-2048);
  const usageEntries = Object.entries(snapshot.usageMessages).slice(-512);
  snapshot.usageMessages = Object.fromEntries(usageEntries);
  snapshot.turns = Math.max(integer(record.turns), snapshot.turnIds.length);
  if (record.toolCallsSource !== "tool-response") {
    snapshot.toolCalls = snapshot.toolUseIds.length;
    snapshot.toolCallsSource = snapshot.toolUseIds.length > 0 ? "agent-transcript" : record.toolCallsSource;
  }
  const transcriptUsage = usageEntries.reduce(
    (totals, [, usage]) => {
      for (const key of Object.keys(totals)) {
        totals[key] += integer(usage?.[key]);
      }
      return totals;
    },
    { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, totalTokens: 0, uncachedTokens: 0 }
  );
  if (record.usageSource !== "tool-response") {
    snapshot.usage = transcriptUsage;
    snapshot.usageSource = usageEntries.length > 0 ? "agent-transcript" : record.usageSource;
    snapshot.usageAvailability = partial || snapshot.transcriptBacklogBytes > 0 || snapshot.transcriptSkippingLine ? "partial" : usageEntries.length > 0 ? "available" : "unreported";
  }
  return snapshot;
}

const USAGE_KEYS = ["inputTokens", "cacheCreationInputTokens", "cacheReadInputTokens", "outputTokens", "totalTokens", "uncachedTokens"];

function emptyWorkerUsage() {
  return { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, totalTokens: 0, uncachedTokens: 0 };
}

function hasZeroWorkerUsage(record) {
  return USAGE_KEYS.every((key) => {
    const value = record?.usage?.[key];
    return value == null || (Number.isSafeInteger(value) && value === 0);
  });
}

function taskOutputMessageUsage(value) {
  if (value == null) {
    return emptyWorkerUsage();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const fields = [
    value.input_tokens ?? value.inputTokens,
    value.cache_creation_input_tokens ?? value.cacheCreationInputTokens,
    value.cache_read_input_tokens ?? value.cacheReadInputTokens,
    value.output_tokens ?? value.outputTokens
  ];
  if (fields.some((field) => field != null && (!Number.isSafeInteger(field) || field < 0))) {
    return null;
  }
  const [inputTokens = 0, cacheCreationInputTokens = 0, cacheReadInputTokens = 0, outputTokens = 0] = fields;
  const totalTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens + outputTokens;
  const uncachedTokens = inputTokens + cacheCreationInputTokens + outputTokens;
  return Number.isSafeInteger(totalTokens) && Number.isSafeInteger(uncachedTokens)
    ? { inputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens, totalTokens, uncachedTokens }
    : null;
}

function addWorkerUsage(totals, usage) {
  const next = {};
  for (const key of USAGE_KEYS) {
    const value = totals[key] + usage[key];
    if (!Number.isSafeInteger(value)) {
      return null;
    }
    next[key] = value;
  }
  return next;
}

function taskOutputTelemetryLine(line, telemetry) {
  const entry = JSON.parse(line);
  if (entry?.type !== "assistant" || !entry.message || typeof entry.message !== "object") {
    return telemetry;
  }
  const usage = taskOutputMessageUsage(entry.message.usage);
  if (!usage) {
    return null;
  }
  const nextUsage = addWorkerUsage(telemetry.usage, usage);
  if (!nextUsage) {
    return null;
  }
  const content = Array.isArray(entry.message.content) ? entry.message.content : [];
  const toolCalls = content.filter((block) => block?.type === "tool_use").length;
  if (!Number.isSafeInteger(telemetry.turns + 1) || !Number.isSafeInteger(telemetry.toolCalls + toolCalls)) {
    return null;
  }
  return { turns: telemetry.turns + 1, toolCalls: telemetry.toolCalls + toolCalls, usage: nextUsage };
}

function taskOutputTelemetry(transcriptPath) {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) {
    return null;
  }
  let descriptor;
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile() || stat.size > TASK_OUTPUT_TRANSCRIPT_MAX_BYTES) {
      return null;
    }
    descriptor = fs.openSync(transcriptPath, "r");
    let offset = 0;
    let carry = "";
    let telemetry = { turns: 0, toolCalls: 0, usage: emptyWorkerUsage() };
    while (offset < stat.size) {
      const buffer = Buffer.allocUnsafe(Math.min(TASK_OUTPUT_TRANSCRIPT_CHUNK_BYTES, stat.size - offset));
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
      if (read === 0) {
        break;
      }
      offset += read;
      const text = `${carry}${buffer.subarray(0, read).toString("utf8")}`;
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      if (Buffer.byteLength(carry) > TASK_OUTPUT_TRANSCRIPT_MAX_LINE_BYTES) {
        return null;
      }
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        telemetry = taskOutputTelemetryLine(line, telemetry);
        if (!telemetry) {
          return null;
        }
      }
    }
    if (carry.trim()) {
      telemetry = taskOutputTelemetryLine(carry, telemetry);
    }
    return telemetry;
  } catch {
    return null;
  } finally {
    if (descriptor != null) {
      fs.closeSync(descriptor);
    }
  }
}

export function backfillWorkerTaskOutputTelemetry(record, transcriptPath) {
  if (!hasZeroWorkerUsage(record)) {
    return record;
  }
  const telemetry = taskOutputTelemetry(transcriptPath);
  if (!telemetry) {
    return record;
  }
  return {
    ...record,
    turns: telemetry.turns,
    toolCalls: telemetry.toolCalls,
    toolCallsSource: "harness-task-transcript",
    usage: telemetry.usage,
    usageSource: "harness-task-transcript",
    usageAvailability: "available"
  };
}

function validatedAcceptanceFields(acceptance, source, reason, failureKind) {
  if (!ACCEPTANCE_STATES.has(acceptance)) {
    throw new TypeError("Fusion worker acceptance must be accepted, rejected, or unverified.");
  }
  if (typeof source !== "string" || !/^[a-z][a-z0-9._-]{0,31}$/.test(source)) {
    throw new TypeError("Fusion worker acceptance source is invalid.");
  }
  const safeReason = typeof reason === "string" && reason.trim()
    ? reason
        .replace(/[\r\n\u0000-\u001f\u007f]+/g, " ")
        .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[redacted]")
        .replace(/(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{20,}/g, "[redacted]")
        .replace(/xai-[A-Za-z0-9]{16,}/g, "[redacted]")
        .replace(/Bearer\s+\S{20,}/gi, "Bearer [redacted]")
        .trim()
        .slice(0, 240)
    : null;
  if (failureKind != null && !SEMANTIC_FAILURE_KINDS.has(failureKind)) {
    throw new TypeError("Fusion worker acceptance failure kind must be one of intent_override, scope_rewrite, wrong_approach, style_mismatch, oversized.");
  }
  if (failureKind != null && acceptance !== "rejected") {
    throw new TypeError("Fusion worker acceptance failure kind applies only to rejected acceptance.");
  }
  return { safeReason, safeFailureKind: failureKind ?? null };
}

function workerAcceptanceGate(record, taskId, acceptance, acceptFailedTransport) {
  const collector = canonicalWorkerAgentType(record.agentType) === "fusion:job-collector" || record.completionContract === "collector";
  if (collector && record.peerEngine === "codex") {
    throw new Error(`Fusion collector task ${taskId} acceptance must be recorded through the Codex acceptance ledger.`);
  }
  if (collector && (record.peerEngine !== "grok" || !/^[a-f0-9]{32}$/.test(record.peerJobId ?? "") || !record.peerTransportStatus)) {
    throw new Error(`Fusion collector task ${taskId} does not contain a verified Grok collection identity.`);
  }
  if (acceptance === "accepted" && record.transportStatus === "failed" && !acceptFailedTransport) {
    throw new Error(`Fusion worker task ${taskId} has transport status failed. Pass --accept-failed-transport to record accepted.`);
  }
}

function acceptanceRecordedAt(now) {
  return now instanceof Date ? now.toISOString() : typeof now === "string" && !Number.isNaN(Date.parse(now)) ? now : new Date().toISOString();
}

function settleWorkerAcceptance(record, { acceptance, source, reason, failureKind }, now) {
  const { pendingVerdict: _pendingVerdict, pendingVerdictError: _pendingVerdictError, ...settled } = record;
  return {
    ...settled,
    acceptance,
    acceptanceSource: source,
    acceptanceReason: reason,
    acceptanceFailureKind: failureKind,
    acceptanceRecordedAt: acceptanceRecordedAt(now),
    awaitingVerdict: false,
    awaitingVerdictArmedAt: null
  };
}

function workerAcceptanceResult(record, queued) {
  const result = { record, queued };
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(result, key)) {
      Object.defineProperty(result, key, { enumerable: false, get: () => record[key] });
    }
  }
  return result;
}

export function applyQueuedVerdict(record, now) {
  if (!record?.pendingVerdict || !isTerminalWorkerStatus(record.transportStatus)) {
    return record;
  }
  const { acceptance, source, reason, failureKind, acceptFailedTransport = false } = record.pendingVerdict;
  if (acceptance === "accepted" && record.transportStatus !== "done") {
    const { pendingVerdict: _pendingVerdict, ...unsettled } = record;
    return {
      ...unsettled,
      awaitingVerdict: true,
      awaitingVerdictArmedAt: acceptanceRecordedAt(now),
      pendingVerdictError: `Queued accepted verdict was not applied because transport status is ${record.transportStatus}.`
    };
  }
  try {
    const { safeReason, safeFailureKind } = validatedAcceptanceFields(acceptance, source, reason, failureKind);
    workerAcceptanceGate(record, record.taskId, acceptance, acceptFailedTransport);
    return settleWorkerAcceptance(record, { acceptance, source, reason: safeReason, failureKind: safeFailureKind }, now);
  } catch (error) {
    return {
      ...record,
      pendingVerdictError: error instanceof Error ? error.message : String(error)
    };
  }
}

export function isPendingSettlement(record) {
  return record.completionContract !== "collector" && isTerminalWorkerStatus(record.transportStatus) && Boolean(record.collectedAt) && record.awaitingVerdict === true;
}

export function isSettledWorker(record) {
  return record.acceptanceRecordedAt != null && record.awaitingVerdict !== true;
}

function updateWorkerAcceptance({ taskId, acceptance, env, source, safeReason, safeFailureKind, validateRecord, acceptFailedTransport = false, queueIfNonTerminal = false }) {
  let queued = false;
  const updated = updateWorkerRecord(taskId, env, (record) => {
    if (!record) {
      throw new Error(`Fusion worker task ${taskId} was not found.`);
    }
    if (!isTerminalWorkerStatus(record.transportStatus)) {
      if (!queueIfNonTerminal) {
        throw new Error(`Fusion worker task ${taskId} is not terminal.`);
      }
      queued = true;
      const { pendingVerdictError: _pendingVerdictError, ...queuedRecord } = record;
      return {
        ...queuedRecord,
        pendingVerdict: {
          acceptance,
          source,
          reason: safeReason,
          failureKind: safeFailureKind,
          queuedAt: new Date().toISOString(),
          ...(acceptFailedTransport ? { acceptFailedTransport: true } : {})
        }
      };
    }
    validateRecord(record);
    return settleWorkerAcceptance(record, { acceptance, source, reason: safeReason, failureKind: safeFailureKind });
  });
  return { record: updated, queued };
}

export function validateWorkerAcceptance({ record, taskId, acceptance, source = "main-loop", reason = null, failureKind = null, acceptFailedTransport = false }) {
  const { safeReason, safeFailureKind } = validatedAcceptanceFields(acceptance, source, reason, failureKind);
  if (!record) {
    throw new Error(`Fusion worker task ${taskId} was not found.`);
  }
  workerAcceptanceGate(record, taskId, acceptance, acceptFailedTransport);
  return { safeReason, safeFailureKind };
}

export function recordWorkerAcceptance({ taskId, acceptance, env = process.env, source = "main-loop", reason = null, failureKind = null, acceptFailedTransport = false }) {
  const { safeReason, safeFailureKind } = validatedAcceptanceFields(acceptance, source, reason, failureKind);
  const result = updateWorkerAcceptance({
    taskId,
    acceptance,
    env,
    source,
    safeReason,
    safeFailureKind,
    acceptFailedTransport,
    queueIfNonTerminal: true,
    validateRecord(record) {
      workerAcceptanceGate(record, taskId, acceptance, acceptFailedTransport);
    }
  });
  return workerAcceptanceResult(result.record, result.queued);
}

function recordCodexCollectorAcceptance({ taskId, jobId, sessionId, acceptance, env = process.env, source = "main-loop", reason = null, failureKind = null }) {
  if (typeof jobId !== "string" || !/^[a-f0-9]{32}$/.test(jobId)) {
    throw new TypeError("Codex collector job id is invalid.");
  }
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)) {
    throw new TypeError("Codex collector session id is invalid.");
  }
  const { safeReason, safeFailureKind } = validatedAcceptanceFields(acceptance, source, reason, failureKind);
  return updateWorkerAcceptance({
    taskId,
    acceptance,
    env,
    source,
    safeReason,
    safeFailureKind,
    validateRecord(record) {
      if (canonicalWorkerAgentType(record.agentType) !== "fusion:job-collector" || record.completionContract !== "collector") {
        throw new Error(`Fusion worker task ${taskId} is not a Codex collector.`);
      }
      if (record.sessionId !== sessionId || record.peerEngine !== "codex" || record.peerJobId !== jobId) {
        throw new Error(`Fusion collector task ${taskId} does not match the Codex acceptance identity.`);
      }
    }
  }).record;
}
