import { ENGINES } from "../engines.mjs";
import { engineHealth } from "../engine-health.mjs";
import { readRoutingDefaults } from "../model-table.mjs";
import { readSessionWorkerRecords, readWorkerSessionState, updateWorkerSessionState, WORKER_TERMINAL_STATUSES } from "../worker-state.mjs";
import { resolveStateDir } from "../guard/config.mjs";
import { normalizeSessionId, normalizeState, readState, stateFile, withStateLock, writeState } from "../guard/state.mjs";
import { terminalCollectionPending } from "./collection.mjs";

const WAVE_REVIEW_SUGGESTION_MS = 30 * 60 * 1000;

function awaitingCollection(record) {
  return !WORKER_TERMINAL_STATUSES.has(record.transportStatus) || terminalCollectionPending(record);
}

function waveReviewSuggestion(env, sessionId, nowMs) {
  const agyHealthy = engineHealth("agy", "consult", null, { env, now: nowMs, sessionId }).healthy;
  const engine = agyHealthy ? "agy" : readRoutingDefaults(env, { warn: null }).breadth;
  const role = agyHealthy ? "independence" : "diversity";
  return `Wave settled. Dispatch one cross family read only review of this wave's changed files now, in the same message as your next work: ${ENGINES[engine].rescueAgent} with header \`${engine}-role: ${role} | read only | acceptance: findings cite file:line\`, naming the changed files in the brief.`;
}

function collectionWave(implementation, collected) {
  const rounds = implementation.map((record) => ({
    record,
    startedAt: Date.parse(record.lastContinuedAt ?? record.createdAt),
    endedAt: Date.parse(record.collectedAt ?? record.finishedAt)
  })).filter(({ startedAt, endedAt }) => Number.isFinite(startedAt) && endedAt >= startedAt)
    .sort((left, right) => left.startedAt - right.startedAt);
  let wave = [];
  let through = -Infinity;
  let includesCollection = false;
  for (const { record, startedAt, endedAt } of rounds) {
    if (startedAt > through) {
      if (includesCollection) return wave;
      wave = [];
    }
    wave.push(record);
    through = Math.max(through, endedAt);
    includesCollection ||= record.taskId === collected.taskId && record.collectedAt === collected.collectedAt;
  }
  return includesCollection ? wave : [];
}

function throttled(state, review, nowMs) {
  return [state.reviewSuggestedAt, review?.suggestedAt].some((at) => nowMs - Date.parse(at) < WAVE_REVIEW_SUGGESTION_MS);
}

function queueCollectionWaveReview(env, collected) {
  const sessionId = normalizeSessionId(collected.sessionId);
  if (!sessionId) return;
  const file = stateFile(resolveStateDir(env), sessionId);
  withStateLock(file, () => {
    const now = new Date().toISOString();
    const state = normalizeState(readState(file), now);
    const review = readWorkerSessionState(sessionId, env)?.waveReview;
    const collections = review?.collections ?? {};
    if (throttled(state, review, Date.parse(now)) || collections[collected.taskId] === collected.collectedAt) return;
    const implementation = readSessionWorkerRecords(env, sessionId, { strict: true }).filter((record) => record.packageType === "implementation");
    if (implementation.some(awaitingCollection)) return;
    const wave = collectionWave(implementation, collected).filter((record) => record.collectedAt);
    if (!wave.some((record) => record.transportStatus === "done")) return;
    updateWorkerSessionState(sessionId, env, (current) => ({
      ...current,
      waveReview: {
        ...review,
        collections: { ...collections, ...Object.fromEntries(wave.map((record) => [record.taskId, record.collectedAt])) },
        pending: true
      }
    }));
  });
}

function claimSettlementWaveReview(env, sessionId, now, settled) {
  const file = stateFile(resolveStateDir(env), sessionId);
  return withStateLock(file, () => {
    const state = normalizeState(readState(file), now);
    const session = readWorkerSessionState(sessionId, env);
    const review = session?.waveReview;
    const nowMs = Date.parse(now);
    if (throttled(state, review, nowMs)) return null;
    if (review?.pending) {
      const context = waveReviewSuggestion(env, sessionId, nowMs);
      updateWorkerSessionState(sessionId, env, (current) => ({
        ...current, waveReview: { ...review, pending: false, suggestedAt: now }
      }));
      return context;
    }
    const collections = review?.collections ?? {};
    const candidates = settled.filter((record) => record.sessionId === sessionId &&
      collections[record.taskId] !== record.collectedAt);
    if (!candidates.length) return null;
    if (Array.isArray(session?.taskIds) && candidates.every((record) => record.collectedAt)) {
      const inFlight = readSessionWorkerRecords(env, sessionId).filter((record) =>
        record.packageType === "implementation" && awaitingCollection(record));
      if (candidates.every((record) => inFlight.some((worker) =>
        Date.parse(worker.lastContinuedAt ?? worker.createdAt) <= Date.parse(record.collectedAt)))) return null;
    }
    const context = waveReviewSuggestion(env, sessionId, nowMs);
    state.reviewSuggestedAt = now;
    writeState(file, state);
    return context;
  });
}

function claimPendingWaveReview(input, env) {
  if (input.agent_id || !["PostToolUse", "Stop", "UserPromptSubmit"].includes(input.hook_event_name)) return null;
  const sessionId = normalizeSessionId(input.session_id);
  try {
    if (sessionId && readWorkerSessionState(sessionId, env)?.waveReview?.pending) {
      return claimSettlementWaveReview(env, sessionId, new Date().toISOString(), []);
    }
  } catch {}
  return null;
}

export { queueCollectionWaveReview, claimPendingWaveReview, claimSettlementWaveReview };
