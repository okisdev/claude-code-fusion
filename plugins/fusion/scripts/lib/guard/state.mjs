import { readJsonFile, withFileLock as withStateLock, writeFileAtomic } from "../storage.mjs";
import { SESSION_ID_PATTERN, STALE_MS } from "./constants.mjs";
import { normalizeDispatchLog, normalizeDispatches, pruneExpiredLaunchedDispatches, sanitizeIdentifier, totalDispatches } from "./dispatch.mjs";
import { REPLAY_KINDS } from "./replay.mjs";
import { normalizeMessageId } from "./verification.mjs";
import fs from "node:fs";
import path from "node:path";

const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

function normalizeSessionId(value) {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value) ? value : null;
}

function stateFile(stateDir, sessionId) {
  return path.join(stateDir, `${sessionId}.json`);
}

function readState(file) {
  const missing = Symbol();
  const parsed = readJsonFile(file, missing);
  if (parsed === missing) return null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Fusion inline write state must be a JSON object.");
  }
  return parsed;
}

function writeState(file, state) {
  writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}

function withAvailableStateLock(file, callback) {
  let acquired = false;
  try {
    return withStateLock(file, () => {
      acquired = true;
      return callback();
    }, { timeoutMs: 0 });
  } catch (error) {
    if (!acquired && (error?.code === "ETIMEDOUT" || error?.code === "ENOENT")) return;
    throw error;
  }
}

function pruneStaleState(stateDir) {
  const now = Date.now();
  const marker = path.join(stateDir, ".prune");
  const isDue = () => {
    try {
      const last = readJsonFile(marker, null);
      return !Number.isFinite(last) || now - last >= PRUNE_INTERVAL_MS;
    } catch {
      return true;
    }
  };
  if (!isDue()) return;
  try {
    withAvailableStateLock(marker, () => {
      if (!isDue()) return;
      writeFileAtomic(marker, `${now}\n`);
      for (const entry of fs.readdirSync(stateDir)) {
        if (!entry.endsWith(".json")) continue;
        const file = path.join(stateDir, entry);
        try {
          withAvailableStateLock(file, () => {
            const stat = fs.statSync(file);
            if (now - stat.mtimeMs > STALE_MS) fs.rmSync(file, { force: true });
          });
        } catch {
          void 0;
        }
      }
    });
  } catch {
    void 0;
  }
}

function defaultState(now) {
  return {
    writeCount: 0,
    writesSinceDispatch: 0,
    writeReplayTokens: 0,
    writeTurnKey: null,
    writeTurnTokens: 0,
    writeTurnWrites: 0,
    dispatchEpoch: 0,
    lastDispatchAt: null,
    readStreakTurns: 0,
    readStreakReplayTokens: 0,
    reviewSuggestedAt: null,
    turn: null,
    lastMeasuredTokens: null,
    lastStopTurn: null,
    replayTools: [],
    pendingWrites: [],
    dispatches: {},
    dispatchLog: [],
    confirmedDispatchIds: [],
    createdAt: now,
    updatedAt: now
  };
}

function normalizeTurn(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    (value.id !== null && normalizeMessageId(value.id) === null) ||
    typeof value.key !== "string" || !/^[A-Za-z0-9_:-]{1,160}$/.test(value.key) ||
    typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) || !REPLAY_KINDS.includes(value.kind) ||
    !Number.isSafeInteger(value.tokens) || value.tokens <= 0 || typeof value.measured !== "boolean") return null;
  return { id: value.id, key: value.key, at: new Date(value.at).toISOString(), kind: value.kind, tokens: value.tokens, measured: value.measured };
}

function normalizeState(existing, now) {
  if (!existing || typeof existing !== "object") {
    return defaultState(now);
  }
  const writeCount = Number.isFinite(existing.writeCount) && existing.writeCount >= 0 ? Math.floor(existing.writeCount) : 0;
  const dispatches = normalizeDispatches(existing.dispatches);
  const dispatchCount = totalDispatches(dispatches);
  const writesSinceDispatch = Number.isFinite(existing.writesSinceDispatch) && existing.writesSinceDispatch >= 0 ? Math.floor(existing.writesSinceDispatch) : 0;
  const dispatchLog = pruneExpiredLaunchedDispatches(normalizeDispatchLog(existing.dispatchLog), now);
  const createdAtMs = Date.parse(existing.createdAt);
  const lastDispatchAtMs = Date.parse(existing.lastDispatchAt);
  const pendingWrites = Array.isArray(existing.pendingWrites) ? existing.pendingWrites.filter((entry) =>
    entry && typeof entry.id === "string" && Number.isInteger(entry.epoch)).map((entry) => ({
      id: entry.id, tool: entry.tool, epoch: entry.epoch,
      turn: typeof entry.turn === "string" && /^[A-Za-z0-9_:-]{1,160}$/.test(entry.turn) ? entry.turn : null
    })) : [];
  const turn = normalizeTurn(existing.turn);
  const turnTime = turn ? `t:${Date.parse(turn.at)}` : null;
  let lastStopTurn = Object.hasOwn(existing, "lastStopTurn") ? existing.lastStopTurn : turn?.id ?? turnTime;
  if (turn?.id && (lastStopTurn === turn.key || lastStopTurn === turnTime)) lastStopTurn = turn.id;
  return {
    writeCount,
    writesSinceDispatch,
    writeReplayTokens: Number.isSafeInteger(existing.writeReplayTokens) && existing.writeReplayTokens >= 0 ? existing.writeReplayTokens : 0,
    writeTurnKey: typeof existing.writeTurnKey === "string" && /^[A-Za-z0-9_:-]{1,160}$/.test(existing.writeTurnKey) ? existing.writeTurnKey : null,
    writeTurnTokens: Number.isSafeInteger(existing.writeTurnTokens) && existing.writeTurnTokens >= 0 ? existing.writeTurnTokens : 0,
    writeTurnWrites: Number.isSafeInteger(existing.writeTurnWrites) && existing.writeTurnWrites >= 0 ? existing.writeTurnWrites : 0,
    dispatchEpoch: Number.isInteger(existing.dispatchEpoch) && existing.dispatchEpoch >= 0 ? existing.dispatchEpoch : dispatchCount,
    lastDispatchAt: Number.isFinite(lastDispatchAtMs) ? new Date(lastDispatchAtMs).toISOString() : null,
    readStreakTurns: Number.isSafeInteger(existing.readStreakTurns) && existing.readStreakTurns >= 0 ? existing.readStreakTurns : 0,
    readStreakReplayTokens: Number.isSafeInteger(existing.readStreakReplayTokens) && existing.readStreakReplayTokens >= 0 ? existing.readStreakReplayTokens : 0,
    reviewSuggestedAt: Number.isFinite(Date.parse(existing.reviewSuggestedAt)) ? new Date(existing.reviewSuggestedAt).toISOString() : null,
    turn,
    lastMeasuredTokens: Number.isSafeInteger(existing.lastMeasuredTokens) && existing.lastMeasuredTokens > 0 ? existing.lastMeasuredTokens : turn?.measured ? turn.tokens : null,
    lastStopTurn: typeof lastStopTurn === "string" && /^[A-Za-z0-9_:-]{1,160}$/.test(lastStopTurn) ? lastStopTurn : null,
    replayTools: Array.isArray(existing.replayTools) ? existing.replayTools.filter((tool) =>
      (normalizeMessageId(tool?.id) || (tool?.id === null && typeof tool.signature === "string" && /^[a-f0-9]{64}$/.test(tool.signature))) &&
      typeof tool.key === "string" && /^[A-Za-z0-9_:-]{1,160}$/.test(tool.key) && typeof tool.measured === "boolean") : [],
    pendingWrites,
    dispatches,
    dispatchLog,
    confirmedDispatchIds: [...new Set([
      ...(Array.isArray(existing.confirmedDispatchIds) ? existing.confirmedDispatchIds.map((id) => sanitizeIdentifier(id, 200)).filter(Boolean) : []),
      ...dispatchLog.filter((entry) => entry.phase === "confirmed" && entry.toolUseId).map((entry) => entry.toolUseId)
    ])],
    createdAt: Number.isFinite(createdAtMs) ? new Date(createdAtMs).toISOString() : now,
    updatedAt: now
  };
}

function resetWriteWindow(state) {
  state.writesSinceDispatch = 0;
  state.writeReplayTokens = 0;
  state.writeTurnKey = null;
  state.writeTurnTokens = 0;
  state.writeTurnWrites = 0;
  for (const entry of state.pendingWrites) entry.turn = null;
}

export { normalizeSessionId, stateFile, readState, writeState, withStateLock, withAvailableStateLock, pruneStaleState, defaultState, normalizeState, resetWriteWindow };
