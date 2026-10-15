import { ENGINE_IDS, isEngineId } from "../engines.mjs";
import { tagMessage } from "../user-messages.mjs";
import { readSessionWorkerRecords } from "../worker-state.mjs";
import { AUDIT_PATH_MAX_LENGTH, BUILTIN_LANE, DESCRIPTION_MAX_LENGTH, DISPATCH_LOG_LIMIT, LAUNCHED_DISPATCH_TTL_MS, REAPED_WORKER_REDIRECT_MESSAGE_SLUG, REAPED_WORKER_TERMINAL_STATUSES, WORKER_TERMINAL_STATUSES } from "./constants.mjs";
import { normalizeMessageId } from "./verification.mjs";
import path from "node:path";

function inFlightWorkerTaskSignature(sessionId, env = process.env) {
  const workers = readSessionWorkerRecords(env, sessionId)
    .filter((record) => typeof record.transportStatus === "string" && !WORKER_TERMINAL_STATUSES.has(record.transportStatus))
    .map((record) => `${record.taskId}:${record.transportStatus}`);
  return workers.length > 0 ? workers.sort().join(",") : null;
}

function extractTaskControlId(toolInput) {
  if (!toolInput || typeof toolInput !== "object") {
    return null;
  }
  return typeof toolInput.task_id === "string" && toolInput.task_id.length > 0 ? toolInput.task_id : null;
}

function findWorkerRecordForTaskControlId(taskId, env = process.env, sessionId) {
  const matches = readSessionWorkerRecords(env, sessionId)
    .filter((record) => record.backgroundTaskId === taskId || record.agentId === taskId);
  return matches.find((record) => !REAPED_WORKER_TERMINAL_STATUSES.has(record.transportStatus)) ?? matches[0] ?? null;
}

function reapedWorkerRedirectReason(record, taskId) {
  const settlementTaskId = typeof record.taskId === "string" && record.taskId.length > 0 ? record.taskId : taskId;
  const settlement = `/fusion:stats --record ${settlementTaskId}=<verdict>`;
  if (typeof record.outputFile === "string" && record.outputFile.length > 0) {
    return tagMessage(
      REAPED_WORKER_REDIRECT_MESSAGE_SLUG,
      `This worker already completed and was reaped; its result is at ${record.outputFile}; Read that file and settle via ${settlement} instead of probing the reaped agent.`
    );
  }
  if (typeof record.transcriptPath === "string" && record.transcriptPath.length > 0) {
    return tagMessage(
      REAPED_WORKER_REDIRECT_MESSAGE_SLUG,
      `This worker already completed and was reaped; its transcript is at ${record.transcriptPath}; Read that file and settle via ${settlement} instead of probing the reaped agent.`
    );
  }
  return tagMessage(
    REAPED_WORKER_REDIRECT_MESSAGE_SLUG,
    `This worker already completed and was reaped; settle via ${settlement} instead of probing the reaped agent.`
  );
}

function laneForSubagentType(subagentType) {
  if (typeof subagentType !== "string" || subagentType.length === 0) {
    return BUILTIN_LANE;
  }
  for (const engineId of ENGINE_IDS) {
    if (subagentType.startsWith(`${engineId}:`)) {
      return engineId;
    }
  }
  if (subagentType.startsWith("fusion:")) {
    return normalizeLane(subagentType) ?? BUILTIN_LANE;
  }
  return BUILTIN_LANE;
}

function extractSubagentType(toolInput) {
  if (!toolInput || typeof toolInput !== "object") {
    return null;
  }
  const raw = toolInput.subagent_type ?? null;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function sanitizeIdentifier(value, maxLength = DESCRIPTION_MAX_LENGTH) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    !/^[A-Za-z0-9:_./-]+$/.test(value) ||
    /(?:^|[:._/-])(?:api[_-]?key|token|secret|password)(?:[:._/-]|$)/i.test(value) ||
    /(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}/.test(value) ||
    /[A-Za-z0-9_]{48,}/.test(value)
  ) {
    return null;
  }
  return value;
}

function normalizeLane(value) {
  if (value === BUILTIN_LANE || isEngineId(value)) {
    return value;
  }
  return typeof value === "string" && value.startsWith("fusion:") ? sanitizeIdentifier(value, 80) : null;
}

function sanitizeAuditText(value, maxLength = DESCRIPTION_MAX_LENGTH) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  let sanitized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  sanitized = sanitized.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  sanitized = sanitized.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@");
  sanitized = sanitized.replace(/\b(api[_-]?key|access[_-]?token|authorization|password|passwd|secret|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]");
  sanitized = sanitized.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,})\b/g, "[redacted]");
  sanitized = sanitized.replace(/\b[A-Za-z0-9+/_=-]{64,}\b/g, "[redacted]");
  return sanitized ? sanitized.slice(0, maxLength) : null;
}

function sanitizeAuditPath(value) {
  if (typeof value !== "string" || /(?:^|[:._/-])(?:api[_-]?key|access[_-]?token|authorization|password|passwd|secret|token)(?:[:._/-]|$)/i.test(value)) {
    return null;
  }
  const sanitized = sanitizeAuditText(value, AUDIT_PATH_MAX_LENGTH)?.replace(/\\/g, "/");
  if (!sanitized || sanitized.includes("[redacted]") || path.posix.isAbsolute(sanitized) || sanitized.split("/").includes("..")) {
    return null;
  }
  return sanitized;
}

function extractDispatchDescription(toolInput) {
  if (!toolInput || typeof toolInput !== "object") {
    return null;
  }
  return sanitizeAuditText(toolInput.description ?? null);
}

function totalDispatches(dispatches) {
  return Object.values(dispatches ?? {}).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

function normalizeDispatches(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const dispatches = {};
  for (const [lane, count] of Object.entries(value)) {
    const safeLane = normalizeLane(lane) ?? BUILTIN_LANE;
    if (Number.isFinite(count) && count >= 0) {
      dispatches[safeLane] = (dispatches[safeLane] ?? 0) + Math.floor(count);
    }
  }
  return dispatches;
}

function normalizeDispatchLog(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries = [];
  for (const raw of value.slice(-DISPATCH_LOG_LIMIT)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const atMs = Date.parse(raw.at);
    const lane = normalizeLane(raw.lane) ?? BUILTIN_LANE;
    const subagentType = sanitizeIdentifier(raw.subagentType);
    const description = sanitizeAuditText(raw.description);
    const toolUseId = sanitizeIdentifier(raw.toolUseId, 200);
    const messageId = normalizeMessageId(raw.messageId);
    const phase = raw.phase === "launched" ? "launched" : "confirmed";
    entries.push({
      at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : null,
      lane,
      phase,
      ...(toolUseId ? { toolUseId } : {}),
      ...(messageId ? { messageId } : {}),
      ...(subagentType ? { subagentType } : {}),
      ...(description ? { description } : {})
    });
  }
  return entries;
}

function pruneExpiredLaunchedDispatches(dispatchLog, now) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    return dispatchLog;
  }
  return dispatchLog.filter((entry) => {
    if (entry.phase === "confirmed") {
      return true;
    }
    const launchedAtMs = Date.parse(entry.at);
    return Number.isFinite(launchedAtMs) && nowMs - launchedAtMs <= LAUNCHED_DISPATCH_TTL_MS;
  });
}

function extractToolUseId(input) {
  return sanitizeIdentifier(input?.tool_use_id, 200);
}

function latestConfirmedDispatchAt(dispatchLog) {
  let latestAtMs = null;
  for (const entry of dispatchLog) {
    if (entry.phase !== "confirmed") {
      continue;
    }
    const atMs = Date.parse(entry.at);
    if (Number.isFinite(atMs) && (latestAtMs === null || atMs > latestAtMs)) {
      latestAtMs = atMs;
    }
  }
  return latestAtMs === null ? null : new Date(latestAtMs).toISOString();
}

function findLaunchedDispatch(dispatchLog, toolUseId, lane) {
  if (toolUseId) {
    const byToolUseId = dispatchLog.findLast((entry) => entry.phase === "launched" && entry.toolUseId === toolUseId);
    if (byToolUseId) {
      return byToolUseId;
    }
  }
  return dispatchLog.findLast((entry) => entry.phase === "launched" && entry.lane === lane) ?? null;
}

function sameFleetWave(left, right, waveGapMs) {
  if (left.messageId && right.messageId) {
    return left.messageId === right.messageId;
  }
  return Math.abs(Date.parse(left.at) - Date.parse(right.at)) <= waveGapMs;
}

function deriveFleetWaveState(dispatchLog, waveGapMs) {
  let fleetWaveWidth = 0;
  let consecutiveNarrowWaves = 0;
  let previousDispatch = null;
  const confirmed = dispatchLog.filter((entry) => entry.phase === "confirmed" && Number.isFinite(Date.parse(entry.at))).sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  for (const entry of confirmed) {
    if (previousDispatch && sameFleetWave(previousDispatch, entry, waveGapMs)) {
      fleetWaveWidth += 1;
    } else {
      if (fleetWaveWidth > 0) {
        consecutiveNarrowWaves = fleetWaveWidth <= 2 ? consecutiveNarrowWaves + 1 : 0;
      }
      fleetWaveWidth = 1;
    }
    previousDispatch = entry;
  }
  return { fleetWaveWidth, consecutiveNarrowWaves };
}

function deriveInclusiveFleetWaveWidth(dispatchLog, waveGapMs, currentEntry) {
  const entries = dispatchLog.filter((entry) => {
    if (entry.phase !== "confirmed" && entry.phase !== "launched") {
      return false;
    }
    return Number.isFinite(Date.parse(entry.at));
  }).sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const currentIndex = entries.indexOf(currentEntry);
  if (currentIndex < 0) {
    return 0;
  }

  let firstIndex = currentIndex;
  while (firstIndex > 0 && sameFleetWave(entries[firstIndex - 1], entries[firstIndex], waveGapMs)) {
    firstIndex -= 1;
  }

  let lastIndex = currentIndex;
  while (lastIndex < entries.length - 1 && sameFleetWave(entries[lastIndex], entries[lastIndex + 1], waveGapMs)) {
    lastIndex += 1;
  }

  return lastIndex - firstIndex + 1;
}

export { inFlightWorkerTaskSignature, extractTaskControlId, findWorkerRecordForTaskControlId, reapedWorkerRedirectReason, laneForSubagentType, extractSubagentType, sanitizeIdentifier, normalizeLane, sanitizeAuditText, sanitizeAuditPath, extractDispatchDescription, totalDispatches, normalizeDispatches, normalizeDispatchLog, pruneExpiredLaunchedDispatches, extractToolUseId, latestConfirmedDispatchAt, findLaunchedDispatch, sameFleetWave, deriveFleetWaveState, deriveInclusiveFleetWaveWidth };
