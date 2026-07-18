import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR_ENV = "FUSION_DATA_DIR";
const WORKER_STATE_ENV = "FUSION_WORKER_STATE_DIR";
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 2_000;
const TRANSCRIPT_CHUNK_BYTES = 1024 * 1024;
const TRANSCRIPT_REFRESH_BYTES = 8 * TRANSCRIPT_CHUNK_BYTES;
const TRANSCRIPT_CARRY_BYTES = 256 * 1024;
const TERMINAL_STATUSES = new Set(["done", "incomplete", "failed", "cancelled", "owner_ended"]);
const ACCEPTANCE_STATES = new Set(["accepted", "rejected", "unverified"]);
const AGENT_TYPES = new Map([
  ["fusion:fast-worker", "fusion:fast-worker"],
  ["fast-worker", "fusion:fast-worker"],
  ["fusion:trivial-worker", "fusion:trivial-worker"],
  ["trivial-worker", "fusion:trivial-worker"],
  ["fusion:deep-reasoner", "fusion:deep-reasoner"],
  ["deep-reasoner", "fusion:deep-reasoner"],
  ["fusion:job-collector", "fusion:job-collector"],
  ["job-collector", "fusion:job-collector"]
]);

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
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
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

export function canonicalWorkerAgentType(value) {
  return typeof value === "string" ? AGENT_TYPES.get(value) ?? null : null;
}

export function isFusionWorkerAgent(value) {
  return canonicalWorkerAgentType(value) != null;
}

export function workerLane(value) {
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

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    void 0;
  }
}

export function writePrivateJson(file, value) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

export function readWorkerRecordFile(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function readWorkerRecord(taskId, env = process.env) {
  return readWorkerRecordFile(workerRecordFile(taskId, env));
}

export function updateWorkerRecord(taskId, env, updater) {
  const file = workerRecordFile(taskId, env);
  return withLock(file, () => {
    const current = readWorkerRecordFile(file);
    const next = updater(current);
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      return current;
    }
    const updated = { ...next, updatedAt: new Date().toISOString() };
    writePrivateJson(file, updated);
    return updated;
  });
}

export function markWorkerCollected(record, method, collectedAt = new Date().toISOString()) {
  return {
    ...record,
    collectionMethod: record.collectionMethod ?? method,
    collectedAt: record.collectedAt ?? collectedAt
  };
}

export function createWorkerTaskId(sessionId, toolUseId) {
  const entropy = `${sessionId ?? "unknown"}\0${toolUseId ?? randomUUID()}\0${Date.now()}\0${randomUUID()}`;
  return `fusion-${createHash("sha256").update(entropy).digest("hex").slice(0, 24)}`;
}

export function createWorkerRecord(record, env = process.env) {
  const file = workerRecordFile(record.taskId, env);
  return withLock(file, () => {
    if (readWorkerRecordFile(file)) {
      throw new Error(`Fusion worker task ${record.taskId} already exists.`);
    }
    const now = new Date().toISOString();
    const value = {
      schemaVersion: 1,
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
      failureKind: null,
      collectionMethod: null,
      collectedAt: null,
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
      transcriptOffset: 0,
      transcriptCarry: "",
      transcriptSkippingLine: false,
      transcriptBacklogBytes: 0,
      usageAvailability: "unreported",
      parentTranscriptPath: record.parentTranscriptPath ?? null,
      parentTranscriptBytesAtDispatch: Number.isSafeInteger(record.parentTranscriptBytesAtDispatch) ? record.parentTranscriptBytesAtDispatch : null,
      completionContract: record.completionContract ?? "verification",
      ...(record.expectedPeerEngine && record.expectedPeerJobId ? { expectedPeerEngine: record.expectedPeerEngine, expectedPeerJobId: record.expectedPeerJobId } : {}),
      createdAt: record.createdAt ?? now,
      startedAt: null,
      lastActivityAt: null,
      lastProgressAt: null,
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
  snapshot.turns = snapshot.turnIds.length;
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

function validatedAcceptanceFields(acceptance, source, reason) {
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
  return { safeReason };
}

function updateWorkerAcceptance({ taskId, acceptance, env, source, safeReason, validateRecord }) {
  const updated = updateWorkerRecord(taskId, env, (record) => {
    if (!record) {
      throw new Error(`Fusion worker task ${taskId} was not found.`);
    }
    if (!isTerminalWorkerStatus(record.transportStatus)) {
      throw new Error(`Fusion worker task ${taskId} is not terminal.`);
    }
    validateRecord(record);
    return {
      ...record,
      acceptance,
      acceptanceSource: source,
      acceptanceReason: safeReason,
      acceptanceRecordedAt: new Date().toISOString()
    };
  });
  return updated;
}

export function recordWorkerAcceptance({ taskId, acceptance, env = process.env, source = "main-loop", reason = null, acceptFailedTransport = process.argv.includes("--record-worker-acceptance") && process.argv.includes("--accept-failed-transport") }) {
  const { safeReason } = validatedAcceptanceFields(acceptance, source, reason);
  return updateWorkerAcceptance({
    taskId,
    acceptance,
    env,
    source,
    safeReason,
    validateRecord(record) {
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
  });
}

export function recordCodexCollectorAcceptance({ taskId, jobId, sessionId, acceptance, env = process.env, source = "main-loop", reason = null }) {
  if (typeof jobId !== "string" || !/^[a-f0-9]{32}$/.test(jobId)) {
    throw new TypeError("Codex collector job id is invalid.");
  }
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)) {
    throw new TypeError("Codex collector session id is invalid.");
  }
  const { safeReason } = validatedAcceptanceFields(acceptance, source, reason);
  return updateWorkerAcceptance({
    taskId,
    acceptance,
    env,
    source,
    safeReason,
    validateRecord(record) {
      if (canonicalWorkerAgentType(record.agentType) !== "fusion:job-collector" || record.completionContract !== "collector") {
        throw new Error(`Fusion worker task ${taskId} is not a Codex collector.`);
      }
      if (record.sessionId !== sessionId || record.peerEngine !== "codex" || record.peerJobId !== jobId) {
        throw new Error(`Fusion collector task ${taskId} does not match the Codex acceptance identity.`);
      }
    }
  });
}
