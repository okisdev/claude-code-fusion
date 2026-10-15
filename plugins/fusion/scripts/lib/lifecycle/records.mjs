import fs from "node:fs";
import path from "node:path";
import { canonicalWorkerAgentType, isFusionWorkerAgent, WORKER_TERMINAL_STATUSES, readSessionWorkerRecords, refreshWorkerTranscript, reopenWorkerContinuation, updateWorkerRecord } from "../worker-state.mjs";
import { observeTerminalTokenUsage } from "./usage.mjs";

function updateLifecycleWorkerRecord(taskId, env, updater) {
  const updated = updateWorkerRecord(taskId, env, updater);
  observeTerminalTokenUsage(updated, env);
  return updated;
}

function pendingDispatchForStart(input, env) {
  const canonical = canonicalWorkerAgentType(input.agent_type);
  const pending = readSessionWorkerRecords(env, input.session_id, { strict: true }).filter((record) => canonicalWorkerAgentType(record.agentType) === canonical && !WORKER_TERMINAL_STATUSES.has(record.transportStatus) && !record.agentId);
  return pending.length === 1 ? pending[0] : null;
}

function recordForAgent(input, env) {
  if (typeof input.agent_id !== "string" || !input.agent_id) {
    return null;
  }
  const taskId = attributedTaskId(input, env);
  let record = null;
  if (taskId) {
    const exact = readSessionWorkerRecords(env, input.session_id, { strict: true }).find((record) => record.taskId === taskId && canonicalWorkerAgentType(record.agentType) === canonicalWorkerAgentType(input.agent_type));
    if (exact) {
      record = updateLifecycleWorkerRecord(exact.taskId, env, (current) => ({ ...current, agentId: input.agent_id }));
    }
  }
  record ??= findSessionWorkerRecord((candidate) => candidate.agentId === input.agent_id, input.session_id, env);
  if (!record || !isFusionWorkerAgent(input.agent_type) || !WORKER_TERMINAL_STATUSES.has(record.transportStatus)) {
    return record;
  }
  return updateLifecycleWorkerRecord(record.taskId, env, (current) => {
    if (!current || current.sessionId !== input.session_id || current.agentId !== input.agent_id || !WORKER_TERMINAL_STATUSES.has(current.transportStatus) || !continuationRequestIsNewer(current)) {
      return null;
    }
    return reopenWorkerContinuation(current, new Date(Math.max(Date.now(), Date.parse(current.continuationRequestedAt))).toISOString(), current.continuationRequestedTranscriptBytes);
  });
}

function continuationRequestIsNewer(record) {
  const requestedAt = Date.parse(record.continuationRequestedAt ?? "");
  const finishedAt = Date.parse(record.finishedAt ?? "");
  const lastContinuedAt = Date.parse(record.lastContinuedAt ?? "");
  return Number.isFinite(requestedAt) && (!Number.isFinite(lastContinuedAt) || lastContinuedAt < requestedAt) && (!Number.isFinite(finishedAt) || requestedAt > finishedAt);
}

function parentTranscriptByteSize(record, input) {
  const transcriptPath = record.parentTranscriptPath ?? input.transcript_path;
  try {
    return typeof transcriptPath === "string" && path.isAbsolute(transcriptPath) ? fs.statSync(transcriptPath).size : 0;
  } catch {
    return 0;
  }
}

function clearContinuationRequest(record) {
  const { continuationRequestedAt, continuationRequestedTranscriptBytes, continuationRequestedStatus, ...rest } = record;
  return rest;
}

function sendMessageResumed(response, recordedStatus) {
  if (typeof response === "string") {
    try {
      response = JSON.parse(response);
    } catch {
      response = null;
    }
  }
  if (response && typeof response === "object") {
    if (typeof response.resumedAgentId === "string" && response.resumedAgentId) {
      return true;
    }
    if (typeof response.message === "string") {
      if (/^(?:Resuming agent|Resumed agent)/.test(response.message)) {
        return true;
      }
      if (response.message.startsWith("Message queued")) {
        return false;
      }
    }
  }
  return WORKER_TERMINAL_STATUSES.has(recordedStatus) || recordedStatus === "ready_uncollected";
}

function findSessionWorkerRecord(predicate, sessionId, env) {
  const matches = readSessionWorkerRecords(env, sessionId, { strict: true }).filter(predicate);
  matches.sort((left, right) => Date.parse(right.updatedAt ?? right.createdAt ?? "") - Date.parse(left.updatedAt ?? left.createdAt ?? ""));
  return matches[0] ?? null;
}

function attributedTaskId(input, env) {
  const records = readSessionWorkerRecords(env, input.session_id, { strict: true });
  const parentPaths = new Set(records.map((record) => record.parentTranscriptPath).filter(Boolean).map((value) => path.resolve(value)));
  const candidate = [input.agent_transcript_path, input.transcript_path].find((value) => typeof value === "string" && path.isAbsolute(value) && !parentPaths.has(path.resolve(value)) && path.basename(value).includes(input.agent_id));
  if (!candidate) {
    return null;
  }
  let descriptor;
  try {
    const size = Math.min(fs.statSync(candidate).size, 256 * 1024);
    descriptor = fs.openSync(candidate, "r");
    const buffer = Buffer.allocUnsafe(size);
    fs.readSync(descriptor, buffer, 0, size, 0);
    return /fusion-task-id:\s*(fusion-[a-f0-9]{24})/.exec(buffer.toString("utf8"))?.[1] ?? null;
  } catch {
    return null;
  } finally {
    if (descriptor != null) {
      fs.closeSync(descriptor);
    }
  }
}

function isAttributedTranscriptPath(candidate, record) {
  return typeof candidate === "string" && path.isAbsolute(candidate) && candidate !== record.parentTranscriptPath && (!record.agentId || path.basename(candidate).includes(record.agentId));
}

function refreshRecord(record, input, env) {
  const candidates = [input.agent_transcript_path, input.transcript_path, record.transcriptPath];
  const transcriptPath = candidates.find((candidate) => isAttributedTranscriptPath(candidate, record)) ?? null;
  if (!transcriptPath) {
    return record;
  }
  return updateLifecycleWorkerRecord(record.taskId, env, (current) => refreshWorkerTranscript(current ?? record, transcriptPath));
}

function activeSessionRecords(sessionId, env) {
  return readSessionWorkerRecords(env, sessionId, { strict: true }).filter((record) => !WORKER_TERMINAL_STATUSES.has(record.transportStatus));
}

function sessionRecords(sessionId, env) {
  return readSessionWorkerRecords(env, sessionId, { strict: true });
}


export { updateLifecycleWorkerRecord, pendingDispatchForStart, recordForAgent, continuationRequestIsNewer, parentTranscriptByteSize, clearContinuationRequest, sendMessageResumed, findSessionWorkerRecord, attributedTaskId, isAttributedTranscriptPath, refreshRecord, activeSessionRecords, sessionRecords };
