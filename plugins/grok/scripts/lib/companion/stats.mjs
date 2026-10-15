import { renderStatsReport } from "../render.mjs";
import { jobFilePath, listAllJobRecords, listJobRecords, resolveDataDir } from "../state.mjs";
import { output, resolveCwd, commandArgs } from "./base.mjs";
import { refreshRunningJobRecord, TOKEN_USAGE_METRICS, optionalBoolean, tokenUsageObservation } from "./outcome.mjs";

function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function addTokenUsage(target, usage) {
  const next = {};
  for (const metric of TOKEN_USAGE_METRICS) {
    next[metric] = target[metric] + usage[metric];
    if (!Number.isSafeInteger(next[metric])) {
      return false;
    }
  }
  for (const metric of TOKEN_USAGE_METRICS) {
    target[metric] = next[metric];
  }
  return true;
}

function tokenUsageForRecord(record) {
  const usageIsIncomplete = record.usageIsIncomplete === true;
  const modelUsageIsIncomplete = optionalBoolean(record.modelUsageIsIncomplete);
  const direct = tokenUsageObservation(record.usage, {
    allowFullInput: Boolean(record.usage) && !Object.hasOwn(record.usage, "input_tokens") && Object.hasOwn(record.usage, "inputTokens")
  });
  if (direct.coverage === "complete" && !usageIsIncomplete) {
    return direct;
  }
  return usageIsIncomplete || modelUsageIsIncomplete === true || direct.coverage === "incomplete"
    ? { coverage: "incomplete", usage: null }
    : { coverage: "unreported", usage: null };
}

function modelNamesForRecord(record) {
  if (record.modelUsage && typeof record.modelUsage === "object" && !Array.isArray(record.modelUsage)) {
    const names = Object.keys(record.modelUsage).filter((name) => name.trim());
    if (names.length > 0) {
      return names;
    }
  }
  if (typeof record.resolvedModel === "string" && record.resolvedModel.trim()) {
    return [record.resolvedModel.trim()];
  }
  const requested = record.request?.model;
  return typeof requested === "string" && requested.trim() ? [requested.trim()] : ["unknown"];
}

function resolvedModelForRecord(record) {
  if (typeof record.resolvedModel === "string" && record.resolvedModel.trim()) {
    return record.resolvedModel.trim();
  }
  if (record.modelUsage && typeof record.modelUsage === "object" && !Array.isArray(record.modelUsage)) {
    const names = Object.keys(record.modelUsage).filter((name) => name.trim());
    if (names.length === 1) {
      return names[0];
    }
  }
  return "unknown";
}

const USD_TICKS = 10_000_000_000;

function exactCostTicksForRecord(record) {
  const costIsPartial = record.costIsPartial === true;
  const usageIsIncomplete = record.usageIsIncomplete === true;
  const modelUsageIsIncomplete = record.modelUsageIsIncomplete === true;
  const totalCostUsdTicks = record.totalCostUsdTicks;
  const totalCostUsd = record.totalCostUsd;
  if (
    costIsPartial ||
    usageIsIncomplete ||
    modelUsageIsIncomplete ||
    !Number.isSafeInteger(totalCostUsdTicks) ||
    totalCostUsdTicks <= 0 ||
    !Number.isFinite(totalCostUsd) ||
    totalCostUsd <= 0
  ) {
    return null;
  }
  const derivedUsd = totalCostUsdTicks / USD_TICKS;
  const tolerance = Math.max(1e-12, Math.abs(derivedUsd) * Number.EPSILON * 8);
  return Math.abs(totalCostUsd - derivedUsd) <= tolerance ? totalCostUsdTicks : null;
}

function aggregateJobStats(records) {
  const byStatus = {};
  const byMode = {};
  const byFailureKind = {};
  const byModel = {};
  const byResolvedModel = {};
  const byResolvedEffort = {};
  const usage = {
    reportedJobs: 0,
    inputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  };
  const usageCoverage = {
    completeJobs: 0,
    incompleteJobs: 0,
    unreportedJobs: 0
  };
  const headlessMetrics = {
    turnsReportedJobs: 0,
    totalTurns: 0,
    exactCostJobs: 0,
    partialCostJobs: 0,
    unreportedCostJobs: 0,
    totalCostUsdTicks: 0
  };
  let usageAggregationOverflow = false;
  let turnAggregationOverflow = false;
  let costAggregationOverflow = false;
  const doneDurations = [];
  let earliest = null;
  let latest = null;

  for (const record of records) {
    increment(byStatus, record.status ?? "unknown");
    increment(byMode, record.mode ?? "unknown");
    for (const model of modelNamesForRecord(record)) {
      increment(byModel, model);
    }
    increment(byResolvedModel, resolvedModelForRecord(record));
    increment(byResolvedEffort, typeof record.resolvedEffort === "string" && record.resolvedEffort.trim() ? record.resolvedEffort.trim() : "unknown");
    const recordUsage = tokenUsageForRecord(record);
    if (recordUsage.coverage === "complete") {
      if (!usageAggregationOverflow && !addTokenUsage(usage, recordUsage.usage)) {
        usageAggregationOverflow = true;
      }
      usage.reportedJobs += 1;
      usageCoverage.completeJobs += 1;
    } else if (recordUsage.coverage === "incomplete") {
      usageCoverage.incompleteJobs += 1;
    } else {
      usageCoverage.unreportedJobs += 1;
    }
    const numTurns = record.numTurns;
    if (Number.isSafeInteger(numTurns) && numTurns >= 0) {
      headlessMetrics.turnsReportedJobs += 1;
      const totalTurns = headlessMetrics.totalTurns + numTurns;
      if (Number.isSafeInteger(totalTurns)) {
        headlessMetrics.totalTurns = totalTurns;
      } else {
        turnAggregationOverflow = true;
      }
    }
    const costTicks = exactCostTicksForRecord(record);
    const costIsPartial = record.costIsPartial === true;
    const usageIsIncomplete = record.usageIsIncomplete === true;
    const modelUsageIsIncomplete = record.modelUsageIsIncomplete === true;
    const hasAnyCost = record.totalCostUsd != null || record.totalCostUsdTicks != null;
    if (costTicks != null) {
      headlessMetrics.exactCostJobs += 1;
      const totalCostUsdTicks = headlessMetrics.totalCostUsdTicks + costTicks;
      if (Number.isSafeInteger(totalCostUsdTicks)) {
        headlessMetrics.totalCostUsdTicks = totalCostUsdTicks;
      } else {
        costAggregationOverflow = true;
      }
    } else if (costIsPartial || usageIsIncomplete || modelUsageIsIncomplete || hasAnyCost) {
      headlessMetrics.partialCostJobs += 1;
    } else {
      headlessMetrics.unreportedCostJobs += 1;
    }
    if (record.status === "error" || record.status === "cancelled") {
      increment(byFailureKind, record.status === "cancelled" ? record.failureKind ?? "cancelled" : record.failureKind ?? "error");
    }
    const created = Date.parse(record.createdAt ?? "");
    if (Number.isFinite(created)) {
      if (earliest == null || record.createdAt < earliest) {
        earliest = record.createdAt;
      }
      if (latest == null || record.createdAt > latest) {
        latest = record.createdAt;
      }
    }
    if (record.status === "done") {
      const finished = Date.parse(record.finishedAt ?? "");
      if (Number.isFinite(created) && Number.isFinite(finished) && finished >= created) {
        doneDurations.push((finished - created) / 1000);
      }
    }
  }

  const meanWallClockSeconds =
    doneDurations.length > 0
      ? Math.round((doneDurations.reduce((sum, value) => sum + value, 0) / doneDurations.length) * 1000) / 1000
      : null;

  return {
    totalJobs: records.length,
    byStatus,
    byMode,
    byFailureKind,
    byModel,
    byResolvedModel,
    byResolvedEffort,
    usage: usage.reportedJobs > 0 && !usageAggregationOverflow ? usage : null,
    usageCoverage: {
      availability:
        usageAggregationOverflow
          ? "overflow"
          : usageCoverage.completeJobs === 0
          ? "unavailable"
          : usageCoverage.completeJobs === records.length
            ? "available"
            : "partial",
      ...usageCoverage,
      ...(usageAggregationOverflow ? { aggregationOverflow: true } : {})
    },
    headlessMetrics: {
      ...headlessMetrics,
      ...(turnAggregationOverflow ? { totalTurns: null, turnAggregationOverflow: true } : {}),
      ...(costAggregationOverflow
        ? { totalCostUsd: null, totalCostUsdTicks: null, costAggregationOverflow: true }
        : { totalCostUsd: Math.round((headlessMetrics.totalCostUsdTicks / USD_TICKS) * 1e12) / 1e12 })
    },
    meanWallClockSeconds,
    earliestCreatedAt: earliest,
    latestCreatedAt: latest
  };
}

function handleStats(argv, transport = {}) {
  const { options } = commandArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["all", "json"]
  }, transport);

  const dataDir = resolveDataDir();
  const cwd = resolveCwd(options);
  const records = options.all
    ? listAllJobRecords(dataDir).map((entry) => refreshRunningJobRecord(entry).record)
    : listJobRecords(dataDir, cwd).map((record) =>
        refreshRunningJobRecord({ record, file: jobFilePath(dataDir, cwd, record.id) }).record
      );
  const stats = {
    scope: options.all ? "all" : "workspace",
    cwd: options.all ? null : cwd,
    ...aggregateJobStats(records)
  };
  output(options.json ? stats : renderStatsReport(stats), options.json);
}

export { increment, addTokenUsage, tokenUsageForRecord, modelNamesForRecord, resolvedModelForRecord, USD_TICKS, exactCostTicksForRecord, aggregateJobStats, handleStats };
