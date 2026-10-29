import fs from "node:fs";
import { BREADTH_ENGINE_IDS, ENGINES, ENGINE_IDS, ENGINE_TERMINAL_STATUSES, engineStateRoots } from "../../lib/engines.mjs";
import { canonicalWorkerAgentType, WORKER_TERMINAL_STATUSES, readWorkerRecords, readWorkerRollups } from "../../lib/worker-state.mjs";
import { FILE_ENGINE_DESCRIPTORS, checkedUsageAddition, codexSku, isSupersededCodexJob, loadAllObservationCandidates, normalizeClaudeWorkerUsage, observationForJob, scopedObservationForJob, summarizeCodexSkuTelemetry, tokenUsageForJob } from "./engine-evidence.mjs";
import { CODEX_ACCEPTANCE_STATES, RESUMABLE_CODEX_FAILURE_KINDS, TOKEN_USAGE_FILENAME, bump, fusionWorkspaceKey, loadTokenUsageObservations, nonEmptyString, normalizeCollectionMethod, readCodexJobEvidence, readWorkspaceJobFiles, resolveCodexJobEffort, resolveCodexJobModel, resolveGitWorkspaceRoot, resolveStateRoot, selectPreferredJobs, workspaceRootsShareRepository } from "./evidence.mjs";
import { buildCoercionLedger, buildFleetUsageStats } from "./fleet.mjs";

function semanticAcceptance(raw, superseded = false) {
  const recorded = raw?.semanticStatus ?? raw?.acceptance;
  if (recorded === "accepted" || recorded === "rejected") {
    return recorded;
  }
  return superseded ? "superseded" : "unverified";
}

function workerInfrastructureKind(record) {
  if (!record) {
    return null;
  }
  const peerKind = nonEmptyString(record.peerFailureKind);
  if (["sandbox", "auth", "setup", "network", "quota"].includes(peerKind)) {
    return peerKind;
  }
  if (record.failureKind === "launch") {
    return "launch";
  }
  if (record.infraFailure !== true) {
    return null;
  }
  const failureKind = nonEmptyString(record.failureKind);
  return peerKind ?? failureKind ?? (record.acceptance === "accepted" && record.transportStatus === "done" ? null : "unknown");
}

function addPeerVerdict(byEngine, engine, ids, verdict, record) {
  const entries = byEngine.get(engine);
  if (!entries) {
    return;
  }
  for (const id of new Set(ids.filter((value) => typeof value === "string" && value.trim()))) {
    entries.set(id, { acceptance: verdict, infrastructureKind: workerInfrastructureKind(record), taskId: record.taskId ?? null });
  }
}

function peerVerdictMap(records) {
  const byEngine = new Map(ENGINE_IDS.map((engine) => [engine, new Map()]));
  for (const record of records) {
    const continuations = Array.isArray(record.continuations) ? record.continuations : [];
    const priorIds = new Set(continuations.flatMap((round) => [...(Array.isArray(round?.peerJobIds) ? round.peerJobIds : []), round?.peerJobId]));
    const currentIds = [...(Array.isArray(record.peerJobIds) ? record.peerJobIds : []), record.peerJobId].filter((id) => !priorIds.has(id));
    addPeerVerdict(byEngine, record.peerEngine, currentIds, record.acceptance, record);
    addPeerVerdict(byEngine, record.expectedPeerEngine, [record.expectedPeerJobId], record.acceptance, record);
    for (const continuation of continuations) {
      addPeerVerdict(byEngine, record.peerEngine, [...(Array.isArray(continuation?.peerJobIds) ? continuation.peerJobIds : []), continuation?.peerJobId], continuation?.acceptance, continuation);
    }
  }
  return byEngine;
}

export function workerSnapshot(env) {
  const records = readWorkerRecords(env);
  return {
    records,
    byTaskId: new Map(records.filter((record) => record.taskId).map((record) => [record.taskId, record])),
    byPeerJobId: peerVerdictMap(records)
  };
}

export function acceptanceGap(raw, joined) {
  return joined ? "unsettled" : "direct";
}

export function emptyAcceptanceGaps() {
  return { unsettled: 0, direct: 0 };
}

export function resolvedEngineAcceptance(raw, engine, verdicts, superseded = false) {
  const joined = verdicts.get(engine)?.get(raw?.id);
  const own = [raw?.semanticStatus, raw?.acceptance].find((value) => value === "accepted" || value === "rejected");
  if (own === "accepted" || own === "rejected") {
    return own;
  }
  if (joined?.acceptance === "accepted" || joined?.acceptance === "rejected") {
    return joined.acceptance;
  }
  if (superseded) {
    return "superseded";
  }
  return joined ? "unverified" : "untracked";
}

export function acceptanceSummary() {
  return { accepted: 0, judged: 0, rate: 0 };
}

export function countJudged(summary, acceptance, infrastructureKind) {
  if (!infrastructureKind && (acceptance === "accepted" || acceptance === "rejected")) {
    summary.judged += 1;
    summary.accepted += Number(acceptance === "accepted");
    summary.rate = summary.accepted / summary.judged;
  }
}

function acceptanceProvenance(raw) {
  const acceptanceSource = nonEmptyString(raw?.acceptanceSource);
  const acceptanceRecordedAt = nonEmptyString(raw?.acceptanceRecordedAt);
  return {
    ...(acceptanceSource ? { acceptanceSource } : {}),
    ...(acceptanceRecordedAt ? { acceptanceRecordedAt } : {})
  };
}

function includeWorkspaceJob(job, all, descriptor, cwd, workspaceRoot, repositoryCache) {
  return all || descriptor.matchesWorkspace(job, cwd, workspaceRoot, repositoryCache);
}

export function fileBasedEngineStats(descriptor, { all = false, env = process.env, cwd = process.cwd(), workers = null } = {}) {
  const root = resolveStateRoot(descriptor, env);
  const availableRoots = descriptor.multiRootState ? engineStateRoots(descriptor.id, env) : [root];
  if (!availableRoots.some((candidate) => fs.existsSync(candidate))) {
    return { available: false, reason: descriptor.unavailableReason };
  }
  let jobs;
  try {
    jobs = descriptor.enumerateJobs(root, { all, env, cwd });
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (descriptor.requiresJobs && jobs.length === 0) {
    return { available: false, reason: descriptor.unavailableReason };
  }
  const workspaceRoot = typeof descriptor.resolveScope === "function" ? descriptor.resolveScope(cwd) : cwd;
  const repositoryCache = new Map();
  const candidates = all
    ? jobs
    : jobs.map((job) => includeWorkspaceJob(job, all, descriptor, cwd, workspaceRoot, repositoryCache) && !job?._fusionScopeKey ? { ...job, _fusionScopeKey: fusionWorkspaceKey(workspaceRoot) } : job);
  const scoped = selectPreferredJobs(candidates, descriptor, (job) => includeWorkspaceJob(job, all, descriptor, cwd, workspaceRoot, repositoryCache));
  if (descriptor.requiresScopedJobs && !all && scoped.length === 0) {
    return { available: false, reason: descriptor.unavailableReason };
  }
  const byStatus = {};
  const byKind = {};
  const byModel = {};
  const byEffort = {};
  const byMode = {};
  const byFailureKind = {};
  const byAcceptance = {};
  const infrastructureDeaths = { total: 0, byKind: {} };
  const judgedExcludingInfrastructure = acceptanceSummary();
  const verdicts = (workers ?? workerSnapshot(env)).byPeerJobId;
  const acceptanceGaps = emptyAcceptanceGaps();
  const byEvidence = {};
  const auditCache = new Map();
  const tokenObservations = descriptor.usesTokenUsageObservations ? loadAllObservationCandidates(env, TOKEN_USAGE_FILENAME, loadTokenUsageObservations) : new Map();
  const observationRepositoryCache = new Map();
  let tokenTotals = { ...(descriptor.emptyTokenTotals ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 }) };
  let tokenAggregationOverflow = false;
  let jobsWithTokenUsage = 0;
  let jobsWithIncompleteTokenUsage = 0;
  let jobsWithoutTokenUsage = 0;
  let jobsWithUnreportedTokenUsage = 0;
  let pendingTransportJobs = 0;
  const acceptedWithErrorTransport = [];
  const doneWithoutAcceptance = [];
  const codexSkuTelemetryEntries = [];
  let durationSum = 0;
  let durationCount = 0;
  let earliest = null;
  let latest = null;
  for (const raw of scoped) {
    const job = descriptor.normalizeJob(raw);
    const acceptance = resolvedEngineAcceptance(raw, descriptor.id, verdicts, descriptor.usesSupersededJobs && isSupersededCodexJob(raw, scoped));
    const joined = verdicts.get(descriptor.id)?.get(raw?.id);
    const infrastructureKind = joined?.infrastructureKind ?? null;
    let model = null;
    let effort = null;
    bump(byStatus, job.status);
    bump(byKind, job.kind);
    bump(byEvidence, job.evidence ?? "state");
    if (typeof descriptor.resolveMode === "function") {
      bump(byMode, descriptor.resolveMode(raw, job));
    }
    if (typeof descriptor.resolveFailureKind === "function") {
      const failureKind = descriptor.resolveFailureKind(raw, job);
      if (failureKind) {
        bump(byFailureKind, failureKind);
      }
    }
    if (descriptor.includeByModel && typeof descriptor.resolveModel === "function") {
      const observation = descriptor.usesModelAudit ? observationForJob(raw, env, auditCache) : null;
      model = descriptor.resolveModel(raw, observation);
      effort = typeof descriptor.resolveEffort === "function" ? descriptor.resolveEffort(raw, observation) : null;
      const modelKey = effort ? `${model}@${effort}` : model;
      const billingPool = descriptor.resolveBillingPool?.(raw);
      bump(byModel, billingPool ? `${modelKey} (${billingPool})` : modelKey);
      bump(byEffort, effort ?? "unavailable");
    }
    let codexUsage = null;
    if (descriptor.usesSkuTelemetry) {
      const observation = raw?.id ? scopedObservationForJob(tokenObservations, raw, observationRepositoryCache) : null;
      codexUsage = tokenUsageForJob(raw, observation);
      const createdAtMs = Date.parse(job.createdAt ?? "");
      if (Number.isFinite(createdAtMs)) {
        codexSkuTelemetryEntries.push({
          sku: codexSku(model ?? "unknown", effort),
          model: model ?? "unknown",
          createdAtMs,
          terminal: descriptor.isTerminal(raw),
          acceptance,
          infrastructureKind,
          failureKind: nonEmptyString(raw?.failureKind),
          outputTokens: codexUsage.usage?.outputTokens ?? null,
          durationSeconds: job.durationSeconds,
          timeoutMs: raw?.timeoutMs ?? null
        });
      }
    }
    if (descriptor.isTerminal(raw)) {
      bump(byAcceptance, acceptance);
      if (acceptance === "untracked" || acceptance === "unverified") {
        acceptanceGaps[acceptanceGap(raw, joined)] += 1;
      }
      countJudged(judgedExcludingInfrastructure, acceptance, infrastructureKind);
      if (infrastructureKind) {
        infrastructureDeaths.total += 1;
        bump(infrastructureDeaths.byKind, infrastructureKind);
      }
    } else {
      pendingTransportJobs += 1;
    }
    if (descriptor.usesAcceptanceEpoch) {
      const jobId = nonEmptyString(raw?.id);
      if (jobId && job.status === "error" && acceptance === "accepted" && !RESUMABLE_CODEX_FAILURE_KINDS.has(nonEmptyString(raw?.failureKind))) {
        acceptedWithErrorTransport.push(jobId);
      }
      if (jobId && job.status === "done" && (acceptance === "unverified" || acceptance === "untracked")) {
        doneWithoutAcceptance.push(jobId);
      }
    }
    if (descriptor.includeTokenUsage && descriptor.isTerminal(raw)) {
      const observation = descriptor.usesTokenUsageObservations && raw?.id ? scopedObservationForJob(tokenObservations, raw, observationRepositoryCache) : null;
      const usageResult = codexUsage ?? (typeof descriptor.resolveTokenUsage === "function" ? descriptor.resolveTokenUsage(raw) : tokenUsageForJob(raw, observation));
      if (usageResult.usage) {
          jobsWithTokenUsage += 1;
          if (!tokenAggregationOverflow) {
            const nextTotals = checkedUsageAddition(tokenTotals, usageResult.usage);
            if (nextTotals) {
              tokenTotals = nextTotals;
            } else {
              tokenAggregationOverflow = true;
            }
          }
        } else {
          jobsWithoutTokenUsage += 1;
          if (usageResult.availability === "partial") {
            jobsWithIncompleteTokenUsage += 1;
          } else {
            jobsWithUnreportedTokenUsage += 1;
          }
        }
    }
    if (job.durationSeconds != null) {
      durationSum += job.durationSeconds;
      durationCount += 1;
    }
    const created = job.createdAt;
    if (created) {
      if (!earliest || created < earliest) {
        earliest = created;
      }
      if (!latest || created > latest) {
        latest = created;
      }
    }
  }
  const codexSkuTelemetry = descriptor.usesSkuTelemetry ? summarizeCodexSkuTelemetry(codexSkuTelemetryEntries, env) : null;
  return {
    available: true,
    scope: all ? "all" : workspaceRoot,
    totalJobs: scoped.length,
    byStatus,
    byAcceptance,
    acceptanceGaps,
    infrastructureDeaths,
    judgedExcludingInfrastructure,
    ...(descriptor.usesAcceptanceEpoch
      ? {
          byTransportStatus: { ...byStatus },
          acceptanceScope: "terminal transport jobs only",
          pendingTransportJobs,
          acceptanceAnomalies: {
            acceptedWithErrorTransport,
            doneWithoutAcceptance
          }
        }
      : { acceptanceScope: "terminal transport jobs only", pendingTransportJobs }),
    ...(codexSkuTelemetry?.last7DaysBySku.length ? { last7DaysBySku: codexSkuTelemetry.last7DaysBySku } : {}),
    ...(codexSkuTelemetry?.laneSignalDrift.length ? { laneSignalDrift: codexSkuTelemetry.laneSignalDrift } : {}),
    byKind,
    ...(typeof descriptor.resolveMode === "function" ? { byMode } : {}),
    ...(typeof descriptor.resolveFailureKind === "function" ? { byFailureKind } : {}),
    ...(descriptor.includeByModel ? { byModel } : {}),
    ...(descriptor.includeByModel ? { byEffort } : {}),
    ...(descriptor.includeTokenUsage
      ? {
          tokenUsage: {
            availability: tokenAggregationOverflow ? "overflow" : jobsWithTokenUsage === 0 ? "unavailable" : jobsWithoutTokenUsage === 0 ? "available" : "partial",
            scope: descriptor.tokenUsageScope ?? "terminal jobs only",
            jobsWithUsage: jobsWithTokenUsage,
            jobsWithIncompleteUsage: jobsWithIncompleteTokenUsage,
            jobsWithoutUsage: jobsWithoutTokenUsage,
            jobsWithUnreportedUsage: jobsWithUnreportedTokenUsage,
            totals: jobsWithTokenUsage > 0 && !tokenAggregationOverflow ? tokenTotals : null,
            ...(tokenAggregationOverflow ? { aggregationOverflow: true } : {})
          },
          ...(descriptor.exposesEvidence
            ? {
                evidence: {
                  bySource: byEvidence,
                  recoveredTerminalJobs: byEvidence["terminal-ledger"] ?? 0,
                  isLowerBound: true
                }
              }
            : {})
        }
      : {}),
    meanWallClockSeconds: durationCount > 0 ? Math.round((durationSum / durationCount) * 1000) / 1000 : null,
    earliestCreatedAt: earliest,
    latestCreatedAt: latest,
    note: descriptor.note
  };
}

export function codexStats(options = {}) {
  return fileBasedEngineStats(FILE_ENGINE_DESCRIPTORS.codex, options);
}

export function claudeWorkerStats({ all = false, env = process.env, cwd = process.cwd(), sessionId = null, workers = null } = {}) {
  const workspaceRoot = resolveGitWorkspaceRoot(cwd);
  const repositoryCache = new Map();
  const records = (workers ?? workerSnapshot(env)).records.filter((record) => {
    const agentType = canonicalWorkerAgentType(record.agentType);
    if (!agentType || agentType === "fusion:job-collector") {
      return false;
    }
    if (sessionId && record.sessionId !== sessionId) {
      return false;
    }
    return all || workspaceRootsShareRepository(record.workspaceRoot, workspaceRoot, repositoryCache);
  });
  const byStatus = {};
  const byAcceptance = {};
  const byAgent = {};
  const infrastructureDeaths = { total: 0, byKind: {} };
  const judgedExcludingInfrastructure = acceptanceSummary();
  const byFailureKind = {};
  const byDelivery = {};
  const byModel = {};
  const byCollectionMethod = {};
  let usage = { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, totalTokens: 0, uncachedTokens: 0 };
  let usageAggregationOverflow = false;
  let pendingTransportJobs = 0;
  let harnessAsyncDeliveries = 0;
  let completeUsage = 0;
  let partialUsage = 0;
  let unreportedUsage = 0;
  let durationSum = 0;
  let durationCount = 0;
  let earliest = null;
  let latest = null;
  for (const record of records) {
    const status = nonEmptyString(record.transportStatus) ?? "unknown";
    bump(byStatus, status);
    bump(byAgent, nonEmptyString(record.agentType) ?? "unknown");
    bump(byDelivery, nonEmptyString(record.expectedDelivery) ?? "unknown");
    const collectionMethod = normalizeCollectionMethod(record.collectionMethod);
    if (collectionMethod) {
      bump(byCollectionMethod, collectionMethod);
    }
    if (record.resolvedModel) {
      bump(byModel, record.resolvedModel);
    }
    if (record.deliveryMode === "harness_async") {
      harnessAsyncDeliveries += 1;
    }
    if (record.failureKind) {
      bump(byFailureKind, record.failureKind);
    }
    if (WORKER_TERMINAL_STATUSES.has(status)) {
      const acceptance = CODEX_ACCEPTANCE_STATES.has(record.acceptance) ? record.acceptance : "unverified";
      const infrastructureKind = workerInfrastructureKind(record);
      bump(byAcceptance, acceptance);
      countJudged(judgedExcludingInfrastructure, acceptance, infrastructureKind);
      if (infrastructureKind) {
        infrastructureDeaths.total += 1;
        bump(infrastructureDeaths.byKind, infrastructureKind);
      }
    } else {
      pendingTransportJobs += 1;
    }
    if (record.usageAvailability === "available") {
      const normalizedUsage = normalizeClaudeWorkerUsage(record.usage);
      if (normalizedUsage) {
        completeUsage += 1;
        if (!usageAggregationOverflow) {
          const nextUsage = checkedUsageAddition(usage, normalizedUsage);
          if (nextUsage) {
            usage = nextUsage;
          } else {
            usageAggregationOverflow = true;
          }
        }
      } else {
        partialUsage += 1;
      }
    } else if (record.usageAvailability === "partial") {
      partialUsage += 1;
    } else {
      unreportedUsage += 1;
    }
    const started = Date.parse(record.startedAt ?? "");
    const finished = Date.parse(record.finishedAt ?? "");
    if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
      durationSum += (finished - started) / 1000;
      durationCount += 1;
    }
    const created = Date.parse(record.createdAt ?? "");
    if (Number.isFinite(created)) {
      earliest = earliest == null || created < earliest ? created : earliest;
      latest = latest == null || created > latest ? created : latest;
    }
  }
  const identities = records
    .slice()
    .sort((left, right) => Date.parse(right.createdAt ?? "") - Date.parse(left.createdAt ?? ""))
    .slice(0, 100)
    .map((record) => {
      const collectionMethod = normalizeCollectionMethod(record.collectionMethod);
      return {
        taskId: record.taskId,
        sessionId: record.sessionId ?? null,
        agentId: record.agentId ?? null,
        backgroundTaskId: record.backgroundTaskId ?? null,
        agentType: record.agentType,
        transportStatus: record.transportStatus,
        acceptance: record.acceptance ?? "unverified",
        ...(collectionMethod ? { collectionMethod } : {}),
        ...acceptanceProvenance(record)
      };
    });
  return {
    available: true,
    totalJobs: records.length,
    byTransportStatus: byStatus,
    byAcceptance,
    infrastructureDeaths,
    judgedExcludingInfrastructure,
    acceptanceScope: "terminal transport jobs only",
    pendingTransportJobs,
    byAgent,
    byFailureKind,
    harnessAsyncDeliveries,
    byDelivery,
    byModel,
    byCollectionMethod,
    usage: usageAggregationOverflow ? null : usage,
    usageCoverage: {
      availability: usageAggregationOverflow ? "overflow" : records.length > 0 && completeUsage === records.length ? "available" : completeUsage > 0 ? "partial" : "unavailable",
      completeJobs: completeUsage,
      incompleteJobs: partialUsage,
      unreportedJobs: unreportedUsage,
      ...(usageAggregationOverflow ? { aggregationOverflow: true } : {})
    },
    meanWallClockSeconds: durationCount > 0 ? Math.round((durationSum / durationCount) * 1000) / 1000 : null,
    earliestCreatedAt: earliest == null ? null : new Date(earliest).toISOString(),
    latestCreatedAt: latest == null ? null : new Date(latest).toISOString(),
    identities
  };
}

export function listWorkspaceEntries(stateRoot) {
  if (!fs.existsSync(stateRoot)) {
    return [];
  }
  return fs
    .readdirSync(stateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export const WORKSPACE_ENGINE_DESCRIPTORS = [
  {
    id: "grok",
    displayName: ENGINES.grok.displayName,
    unavailableReason: FILE_ENGINE_DESCRIPTORS.grok.unavailableReason,
    resolveRoot: (env) => engineStateRoots("grok", env)[0],
    enumerateJobs: readWorkspaceJobFiles,
    traceModel: (raw) => nonEmptyString(raw?.request?.model),
    traceEffort: (raw) => nonEmptyString(raw?.request?.effort),
    cwdOf: (raw) => (typeof raw.cwd === "string" ? raw.cwd : null),
    sessionOf: (raw) => (typeof raw.claudeSessionId === "string" ? raw.claudeSessionId : null),
    isLive: (raw) => !ENGINE_TERMINAL_STATUSES.has(raw.status)
  },
  {
    id: "codex",
    displayName: ENGINES.codex.displayName,
    unavailableReason: FILE_ENGINE_DESCRIPTORS.codex.unavailableReason,
    resolveRoot: (env) => engineStateRoots("codex", env)[0],
    enumerateJobs: readCodexJobEvidence,
    multiRootState: true,
    usesSupersededJobs: true,
    exposesTransportStatus: true,
    traceApproximate: true,
    traceModel: (raw, env, auditCache) => resolveCodexJobModel(raw, observationForJob(raw, env, auditCache)),
    traceEffort: (raw, env, auditCache) => resolveCodexJobEffort(raw, observationForJob(raw, env, auditCache)),
    cwdOf: (raw) => (typeof raw.workspaceRoot === "string" ? raw.workspaceRoot : null),
    sessionOf: (raw) => nonEmptyString(raw?.sessionId) ?? nonEmptyString(raw?.claudeSessionId),
    isLive: (raw) => !ENGINE_TERMINAL_STATUSES.has(raw.status),
    dedupeById: true,
    isTerminal: (raw) => ENGINE_TERMINAL_STATUSES.has(raw.status)
  },
  ...BREADTH_ENGINE_IDS.map((id) => ({
    id,
    displayName: ENGINES[id].displayName,
    unavailableReason: FILE_ENGINE_DESCRIPTORS[id].unavailableReason,
    resolveRoot: (env) => engineStateRoots(id, env)[0],
    enumerateJobs: readWorkspaceJobFiles,
    traceModel: (raw) => nonEmptyString(raw?.resolvedModel),
    traceEffort: (raw) => raw?.effortApplied === true ? nonEmptyString(raw?.requestedEffort) : null,
    cwdOf: (raw) => (typeof raw.cwd === "string" ? raw.cwd : null),
    sessionOf: (raw) => (typeof raw.claudeSessionId === "string" ? raw.claudeSessionId : null),
    isLive: (raw) => !ENGINE_TERMINAL_STATUSES.has(raw.status)
  }))
];

export const STATS_PROVIDER_REGISTRY = [
  {
    id: "claudeWorkers",
    displayName: "Claude workers",
    collect: (options) => claudeWorkerStats(options)
  },
  ...ENGINE_IDS.map((id) => ({
    id,
    displayName: ENGINES[id].displayName,
    collect: (options) => fileBasedEngineStats(FILE_ENGINE_DESCRIPTORS[id], options)
  })).sort((left, right) => FILE_ENGINE_DESCRIPTORS[left.id].displayOrder - FILE_ENGINE_DESCRIPTORS[right.id].displayOrder)
];

function retiredWorkerStats(env) {
  const stats = {
    totalJobs: 0,
    byAgent: {},
    byAcceptance: {},
    byFailureKind: {},
    tokenSums: { outputTokens: 0, uncachedTokens: 0, cacheReadInputTokens: 0 }
  };
  for (const row of readWorkerRollups(env)) {
    if (row.schemaVersion !== 1 || !Number.isSafeInteger(row.count) || row.count < 0) {
      continue;
    }
    stats.totalJobs += row.count;
    stats.byAgent[row.agentType ?? "unknown"] = (stats.byAgent[row.agentType ?? "unknown"] ?? 0) + row.count;
    stats.byAcceptance[row.acceptance ?? "unknown"] = (stats.byAcceptance[row.acceptance ?? "unknown"] ?? 0) + row.count;
    stats.byFailureKind[row.failureKind ?? "none"] = (stats.byFailureKind[row.failureKind ?? "none"] ?? 0) + row.count;
    stats.tokenSums.outputTokens += row.outputTokensSum ?? 0;
    stats.tokenSums.uncachedTokens += row.uncachedTokensSum ?? 0;
    stats.tokenSums.cacheReadInputTokens += row.cacheReadInputTokensSum ?? 0;
  }
  return stats;
}

function parentContextAtDispatch(records, all, workspaceRoot) {
  const repositoryCache = new Map();
  const values = records
    .filter((record) => all || workspaceRootsShareRepository(record.workspaceRoot, workspaceRoot, repositoryCache))
    .map((record) => record.parentContextTokensAtDispatch)
    .filter((value) => Number.isSafeInteger(value) && value >= 0)
    .sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  return {
    dispatchCount: values.length,
    medianTokens: values.length ? (values[middle] + values[Math.floor((values.length - 1) / 2)]) / 2 : null,
    p90Tokens: values.length ? values[Math.ceil(values.length * 0.9) - 1] : null
  };
}

export function buildFusionStats({ all = false, env = process.env, cwd = process.cwd() } = {}) {
  const workers = workerSnapshot(env);
  const workspaceRoot = resolveGitWorkspaceRoot(cwd);
  const options = { all, env, cwd, workers };
  const engines = {};
  for (const provider of STATS_PROVIDER_REGISTRY) {
    engines[provider.id] = provider.collect(options);
  }
  const fleet = buildFleetUsageStats({ env });
  const parentContext = parentContextAtDispatch(workers.records, all, workspaceRoot);
  return {
    scope: all ? "all" : workspaceRoot,
    ...(parentContext.dispatchCount > 0 ? { parentContextAtDispatch: parentContext } : {}),
    ...engines,
    ...(all ? { retiredWorkers: retiredWorkerStats(env) } : {}),
    fleet,
    coercionLedger: buildCoercionLedger({ env, fleet })
  };
}

function unsettledFinishedAt(raw) {
  return nonEmptyString(raw?.finishedAt ?? raw?.completedAt ?? raw?.updatedAt);
}

function unsettledTimestamp(entry) {
  const timestamp = Date.parse(entry.finishedAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function unsettledWorkerEntries(env) {
  return readWorkerRecords(env)
    .filter((record) => WORKER_TERMINAL_STATUSES.has(record.transportStatus) && semanticAcceptance(record) === "unverified")
    .map((record) => ({
      engine: "fusion",
      id: nonEmptyString(record.taskId) ?? "unknown",
      description: nonEmptyString(record.description) ?? nonEmptyString(record.agentType) ?? "unknown",
      finishedAt: unsettledFinishedAt(record),
      acceptance: "unverified"
    }));
}

function unsettledEngineEntries(descriptor, env) {
  const root = resolveStateRoot(descriptor, env);
  let jobs;
  try {
    jobs = descriptor.enumerateJobs(root, { all: true, env });
  } catch {
    return [];
  }
  const scoped = selectPreferredJobs(jobs, descriptor, () => true);
  return scoped.flatMap((raw) => {
    if (!descriptor.isTerminal(raw)) {
      return [];
    }
    const acceptance = semanticAcceptance(raw, descriptor.usesSupersededJobs && isSupersededCodexJob(raw, scoped));
    if (acceptance !== "unverified") {
      return [];
    }
    const id = nonEmptyString(raw?.id);
    if (!id) {
      return [];
    }
    return [{
      engine: descriptor.id,
      id,
      kind: descriptor.normalizeJob(raw).kind,
      finishedAt: unsettledFinishedAt(raw),
      acceptance: "unverified",
      ...(descriptor.usesSupersededJobs ? acceptanceProvenance(raw) : {})
    }];
  });
}

export function buildUnsettledReport({ env = process.env } = {}) {
  const unsettled = [
    ...unsettledWorkerEntries(env),
    ...ENGINE_IDS.flatMap((id) => unsettledEngineEntries(FILE_ENGINE_DESCRIPTORS[id], env))
  ].sort((left, right) => unsettledTimestamp(right) - unsettledTimestamp(left));
  return { unsettled };
}
