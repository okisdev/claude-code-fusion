import { canonicalWorkerAgentType, WORKER_TERMINAL_STATUSES } from "../worker-state.mjs";
import { updateLifecycleWorkerRecord } from "./records.mjs";
import { WALL_CLOCK_MS_ENV, STALL_MS_ENV, EXECUTION_AGENTS } from "./constants.mjs";

function positiveInteger(env, name, fallback) {
  const parsed = Number.parseInt(String(env[name] ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function workerLimits(agentType, env = process.env, sizing) {
  const canonical = canonicalWorkerAgentType(agentType);
  const defaults = canonical === "fusion:trivial-worker"
    ? { wallClockMs: 300_000, stallMs: 120_000, maxTurns: 24, maxOutputTokens: 32_000, maxUncachedTokens: 240_000 }
    : canonical === "fusion:job-collector"
      ? { wallClockMs: 660_000, stallMs: 660_000, maxTurns: 6, maxOutputTokens: 8_000, maxUncachedTokens: 30_000 }
      : canonical === "fusion:deep-reasoner"
        ? { wallClockMs: 2_400_000, stallMs: 900_000, maxTurns: 40, maxOutputTokens: 128_000, maxUncachedTokens: 960_000 }
        : { wallClockMs: 2_400_000, stallMs: 600_000, maxTurns: 100, maxOutputTokens: 192_000, maxUncachedTokens: 960_000 };
  const multiplier = sizing === "small" ? 0.5 : sizing === "large" ? 2 : 1;
  const scaled = Object.fromEntries(Object.entries(defaults).map(([name, value]) => [name, Math.round(value * multiplier)]));
  return {
    wallClockMs: positiveInteger(env, WALL_CLOCK_MS_ENV, scaled.wallClockMs),
    stallMs: positiveInteger(env, STALL_MS_ENV, scaled.stallMs),
    maxTurns: scaled.maxTurns,
    maxOutputTokens: scaled.maxOutputTokens,
    maxUncachedTokens: scaled.maxUncachedTokens
  };
}

function workerBudgetFailure(record, now = Date.now()) {
  const limits = record?.limits;
  if (!limits) {
    return null;
  }
  const startedAt = Date.parse(record.budgetBaseline?.at ?? record.startedAt ?? record.createdAt ?? "");
  if (Number.isFinite(startedAt) && now - startedAt >= limits.wallClockMs) {
    return { failureKind: "timeout", limitKind: "wall", reason: `wall clock budget reached (${limits.wallClockMs}ms)` };
  }
  if (EXECUTION_AGENTS.has(canonicalWorkerAgentType(record.agentType)) && !record.inFlightSince) {
    const livenessAt = Date.parse(record.lastLivenessAt ?? record.startedAt ?? record.createdAt ?? "");
    if (Number.isFinite(livenessAt) && now - livenessAt >= limits.stallMs) {
      return { failureKind: "stall", limitKind: "stall", reason: `no-activity budget reached (${limits.stallMs}ms)` };
    }
  }
  const usage = workerRoundUsage(record);
  if (usage.turns >= limits.maxTurns) {
    return { failureKind: "turn_limit", limitKind: "turns", reason: `turn budget reached (${limits.maxTurns})` };
  }
  if (usage.outputTokens >= limits.maxOutputTokens) {
    return { failureKind: "token_limit", limitKind: "output", reason: `output token budget reached (${limits.maxOutputTokens})` };
  }
  if (usage.uncachedTokens >= limits.maxUncachedTokens) {
    return { failureKind: "token_limit", limitKind: "uncached", reason: `uncached token budget reached (${limits.maxUncachedTokens})` };
  }
  return null;
}

function workerRoundUsage(record) {
  return {
    turns: Math.max(0, (record.turns ?? 0) - (record.budgetBaseline?.turns ?? 0)),
    outputTokens: Math.max(0, (record.usage?.outputTokens ?? 0) - (record.budgetBaseline?.outputTokens ?? 0)),
    uncachedTokens: Math.max(0, (record.usage?.uncachedTokens ?? 0) - (record.budgetBaseline?.uncachedTokens ?? 0))
  };
}

function markBudgetFailure(record, failure, env) {
  return updateLifecycleWorkerRecord(record.taskId, env, (current) => {
    if (!current || WORKER_TERMINAL_STATUSES.has(current.transportStatus)) {
      return null;
    }
    return {
      ...current,
      transportStatus: "cancel_requested",
      failureKind: failure.failureKind,
      limitKind: failure.limitKind,
      cancelReason: failure.reason,
      cancelRequestedAt: new Date().toISOString()
    };
  });
}


export { positiveInteger, workerLimits, workerBudgetFailure, workerRoundUsage, markBudgetFailure };
