import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import { normalizeCumulativeUsage } from "./codex-usage.mjs";

const DEFAULT_RESULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_ROLLOUT_HEAD_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_ROLLOUT_TAIL_MAX_BYTES = 16 * 1024 * 1024;
const MAX_COMPRESSED_ROLLOUT_BYTES = 64 * 1024 * 1024;
const MAX_ROLLOUT_SCAN_ENTRIES = 50000;
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function observedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function codexHome(env) {
  const configured = observedString(env?.CODEX_HOME);
  return path.resolve(configured ?? path.join(os.homedir(), ".codex"));
}

function recentRolloutDirectories(env) {
  const sessions = path.join(codexHome(env), "sessions");
  const directories = new Set([sessions, path.join(codexHome(env), "archived_sessions")]);
  for (let offset = -2; offset <= 1; offset += 1) {
    const date = new Date(Date.now() + offset * 24 * 60 * 60 * 1000);
    directories.add(path.join(sessions, String(date.getFullYear()).padStart(4, "0"), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")));
    directories.add(path.join(sessions, String(date.getUTCFullYear()).padStart(4, "0"), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")));
  }
  return [...directories];
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function preferredRolloutCandidate(latest, candidate) {
  if (!latest) {
    return candidate;
  }
  if (latest.compressed !== candidate.compressed) {
    return candidate.compressed ? latest : candidate;
  }
  return candidate.mtimeMs > latest.mtimeMs ? candidate : latest;
}

function matchingRolloutInDirectory(directory, namePattern) {
  let latest = null;
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const compressed = entry.name.endsWith(".zst");
      if (!entry.isFile() || !namePattern.test(entry.name) || (compressed && typeof zlib.zstdDecompressSync !== "function")) {
        continue;
      }
      const file = path.join(directory, entry.name);
      const stats = fs.statSync(file);
      latest = preferredRolloutCandidate(latest, { compressed, file, mtimeMs: stats.mtimeMs });
    }
  } catch {}
  return latest;
}

function findRolloutPath(threadId, env, allowHistoricalScan = false) {
  if (!THREAD_ID_PATTERN.test(threadId)) {
    return null;
  }
  const escapedThreadId = escapedRegExp(threadId);
  const namePattern = new RegExp(`^rollout-(?:.*-)?${escapedThreadId}(?:_[0-9a-fA-F-]+)?\\.jsonl(?:\\.zst)?$`);
  let latest = null;
  for (const directory of recentRolloutDirectories(env)) {
    const candidate = matchingRolloutInDirectory(directory, namePattern);
    if (candidate) {
      latest = preferredRolloutCandidate(latest, candidate);
    }
  }
  if (latest || !allowHistoricalScan) {
    return latest?.file ?? null;
  }
  let scanned = 0;
  for (const root of [path.join(codexHome(env), "sessions"), path.join(codexHome(env), "archived_sessions")]) {
    const stack = [root];
    while (stack.length > 0 && scanned < MAX_ROLLOUT_SCAN_ENTRIES) {
      const directory = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => right.name.localeCompare(left.name));
      } catch {
        continue;
      }
      for (const entry of entries) {
        scanned += 1;
        if (scanned > MAX_ROLLOUT_SCAN_ENTRIES) {
          break;
        }
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          stack.push(candidate);
          continue;
        }
        const compressed = entry.name.endsWith(".zst");
        if (!entry.isFile() || !namePattern.test(entry.name) || (compressed && typeof zlib.zstdDecompressSync !== "function")) {
          continue;
        }
        try {
          const stats = fs.statSync(candidate);
          latest = preferredRolloutCandidate(latest, { compressed, file: candidate, mtimeMs: stats.mtimeMs });
        } catch {}
      }
    }
  }
  return latest?.file ?? null;
}

function readFileSlice(descriptor, start, length) {
  const buffer = Buffer.alloc(length);
  const bytesRead = fs.readSync(descriptor, buffer, 0, length, start);
  return buffer.subarray(0, bytesRead);
}

function completeJsonlLines(buffer, { dropLeading = false, dropTrailing = false } = {}) {
  let start = 0;
  let end = buffer.length;
  if (dropLeading) {
    const newline = buffer.indexOf(10);
    start = newline === -1 ? buffer.length : newline + 1;
  }
  if (dropTrailing) {
    const newline = buffer.lastIndexOf(10);
    end = newline === -1 ? 0 : newline;
  }
  return buffer.subarray(start, Math.max(start, end)).toString("utf8").split("\n").filter(Boolean);
}

function boundedObservedText(value, maxBytes) {
  const buffer = Buffer.from(String(value ?? ""));
  return (buffer.length <= maxBytes ? buffer : buffer.subarray(0, maxBytes)).toString("utf8");
}

function boundedRolloutLines(buffer, headMaxBytes, tailMaxBytes) {
  if (buffer.length <= headMaxBytes + tailMaxBytes) {
    return completeJsonlLines(buffer);
  }
  const head = buffer.subarray(0, headMaxBytes);
  const tailStart = Math.max(headMaxBytes, buffer.length - tailMaxBytes);
  const tail = buffer.subarray(tailStart);
  return [
    ...completeJsonlLines(head, { dropTrailing: true }),
    ...completeJsonlLines(tail, { dropLeading: true })
  ];
}

function rolloutLines(file, options = {}) {
  const headMaxBytes = options.headMaxBytes ?? DEFAULT_ROLLOUT_HEAD_MAX_BYTES;
  const tailMaxBytes = options.tailMaxBytes ?? DEFAULT_ROLLOUT_TAIL_MAX_BYTES;
  if (file.endsWith(".zst")) {
    if (typeof zlib.zstdDecompressSync !== "function") {
      return null;
    }
    try {
      if (fs.statSync(file).size > MAX_COMPRESSED_ROLLOUT_BYTES) {
        return null;
      }
      const buffer = zlib.zstdDecompressSync(fs.readFileSync(file));
      return { compressed: true, lines: boundedRolloutLines(buffer, headMaxBytes, tailMaxBytes) };
    } catch {
      return null;
    }
  }
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const size = fs.fstatSync(descriptor).size;
    if (size <= headMaxBytes + tailMaxBytes) {
      return { compressed: false, lines: completeJsonlLines(readFileSlice(descriptor, 0, size)) };
    }
    const head = readFileSlice(descriptor, 0, headMaxBytes);
    const tailStart = Math.max(headMaxBytes, size - tailMaxBytes);
    const tail = readFileSlice(descriptor, tailStart, size - tailStart);
    return {
      compressed: false,
      lines: [
        ...completeJsonlLines(head, { dropTrailing: true }),
        ...completeJsonlLines(tail, { dropLeading: true })
      ]
    };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

export function recoverRolloutObservation(threadId, options = {}) {
  const result = {
    collaborationTool: null,
    cumulativeTokenUsage: null,
    found: false,
    matchedTurn: false,
    partialResultText: null,
    resolvedEffort: null,
    resolvedModel: null,
    source: null
  };
  const file = options.file ?? findRolloutPath(threadId, options.env ?? process.env, options.allowHistoricalScan === true);
  if (!file) {
    return result;
  }
  result.found = true;
  const rollout = rolloutLines(file, options);
  if (!rollout) {
    return result;
  }
  result.source = rollout.compressed ? "local_rollout_zst" : "local_rollout";
  for (const line of rollout.lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry?.payload;
    const timestamp = Date.parse(entry?.timestamp ?? "");
    const belongsToExecution = options.notBeforeMs == null || (Number.isFinite(timestamp) && timestamp >= options.notBeforeMs - 5000);
    if (!belongsToExecution) {
      continue;
    }
    if (entry?.type === "turn_context" && payload && typeof payload === "object") {
      result.matchedTurn = true;
      result.resolvedModel = observedString(payload.model) ?? result.resolvedModel;
      result.resolvedEffort = observedString(payload.collaboration_mode?.settings?.reasoning_effort ?? payload.effort ?? payload.reasoning_effort ?? payload.model_reasoning_effort) ?? result.resolvedEffort;
    }
    if (entry?.type === "event_msg" && payload?.type === "token_count") {
      result.matchedTurn = true;
      result.cumulativeTokenUsage = normalizeCumulativeUsage(payload.info?.total_token_usage) ?? result.cumulativeTokenUsage;
    }
    if (entry?.type === "event_msg" && payload?.type === "agent_message" && typeof payload.message === "string") {
      result.matchedTurn = true;
      result.partialResultText = boundedObservedText(payload.message, options.resultMaxBytes ?? DEFAULT_RESULT_MAX_BYTES);
    }
    if (entry?.type === "response_item" && payload?.type === "message" && payload.role === "assistant" && Array.isArray(payload.content)) {
      const text = payload.content.filter((item) => item?.type === "output_text" && typeof item.text === "string").map((item) => item.text).join("");
      if (text) {
        result.matchedTurn = true;
        result.partialResultText = boundedObservedText(text, options.resultMaxBytes ?? DEFAULT_RESULT_MAX_BYTES);
      }
    }
    if (entry?.type === "response_item" && ["custom_tool_call", "function_call"].includes(payload?.type) && ["spawn_agent", "spawn_agents_on_csv"].includes(payload?.name)) {
      result.matchedTurn = true;
      result.collaborationTool = payload.name;
    }
  }
  return result;
}

export function applyRolloutRecovery(state, { options, env, executionStartedAtMs, resultMaxBytes }) {
  if (state.threadId) {
    const recovered = recoverRolloutObservation(state.threadId, {
      allowHistoricalScan: options.resumeThreadId != null,
      env,
      notBeforeMs: executionStartedAtMs,
      resultMaxBytes
    });
    state.rolloutRecoveryStatus = recovered.matchedTurn ? "recovered" : recovered.found ? "stale" : "not_found";
    state.resolvedModel = recovered.resolvedModel;
    state.resolvedEffort = recovered.resolvedEffort;
    if (!state.policyViolation && state.resolvedEffort?.trim().toLowerCase() === "persistent") {
      state.policyViolation = "Delegated Codex execution ran in the persistent reasoning mode.";
    }
    if (recovered.cumulativeTokenUsage && (!state.cumulativeTokenUsage || state.timedOut || state.cancelled)) {
      state.cumulativeTokenUsage = recovered.cumulativeTokenUsage;
      state.cumulativeUsageUnavailableReason = null;
    }
    if (!state.finalResponse && (state.timedOut || state.cancelled) && recovered.partialResultText) {
      state.finalResponse = recovered.partialResultText;
      state.resultSource = "rollout_partial";
    }
    if (!state.policyViolation && recovered.collaborationTool) {
      state.policyViolation = `Delegated Codex execution attempted the disabled ${recovered.collaborationTool} tool.`;
    }
  }
}
