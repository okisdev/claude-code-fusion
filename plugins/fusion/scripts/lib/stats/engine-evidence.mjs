import fs from "node:fs";
import path from "node:path";
import { BREADTH_ENGINE_IDS, ENGINES, ENGINE_TERMINAL_STATUSES, engineDataDir } from "../../lib/engines.mjs";
import { readModelRoutingFile, resolveModelRoutingPath } from "../../lib/model-table.mjs";
import { LANE_SIGNAL_MIN_JUDGED_JOBS, LANE_SIGNAL_TRAILING_JOBS, LANE_SIGNAL_WINDOW_MS, LAST_SEVEN_DAYS_MS, RESUMABLE_CODEX_FAILURE_KINDS, fusionRepositoryKey, fusionWorkspaceKey, loadModelAuditObservations, modelAuditSidecarPath, modelObservationRank, nonEmptyString, observationTimestamp, readCodexJobEvidence, readWorkspaceJobFiles, resolveCodexJobEffort, resolveCodexJobModel, resolveFusionDataDir, resolveGitWorkspaceRoot, workspaceKeyMatchesRepository, workspaceRootsShareRepository } from "./evidence.mjs";

export const FILE_ENGINE_DESCRIPTORS = {
  grok: {
    id: "grok",
    displayOrder: 0,
    defaultStateRoot: (env) => path.join(engineDataDir("grok", env), "state"),
    unavailableReason: "grok plugin job state not found; the grok plugin may not be installed",
    note: "read best effort from Grok job state; totals are lower bounds",
    enumerateJobs: readWorkspaceJobFiles,
    requiresJobs: true,
    requiresScopedJobs: true,
    resolveScope: resolveGitWorkspaceRoot,
    matchesWorkspace(raw, cwd, workspaceRoot, repositoryCache) {
      return workspaceRootsShareRepository(raw?.cwd, workspaceRoot, repositoryCache);
    },
    includeByModel: true,
    includeTokenUsage: true,
    dedupeById: true,
    isTerminal: (raw) => ENGINE_TERMINAL_STATUSES.has(raw.status),
    normalizeJob(raw) {
      const finished = raw.finishedAt ?? raw.completedAt ?? raw.updatedAt ?? null;
      let durationSeconds = null;
      if (raw.status === "done" && raw.createdAt && finished) {
        const span = (Date.parse(finished) - Date.parse(raw.createdAt)) / 1000;
        if (Number.isFinite(span) && span >= 0) {
          durationSeconds = span;
        }
      }
      return {
        status: raw.status ?? "unknown",
        kind: raw.role ?? raw.mode ?? raw.jobClass ?? "unknown",
        createdAt: raw.createdAt ?? null,
        durationSeconds,
        evidence: "state"
      };
    },
    resolveModel(raw) {
      return nonEmptyString(raw?.resolvedModel) ?? "unknown";
    },
    resolveEffort(raw) {
      return nonEmptyString(raw?.resolvedEffort);
    },
    resolveMode(raw) {
      return nonEmptyString(raw?.mode) ?? "unknown";
    },
    resolveFailureKind(raw) {
      if (raw?.status !== "error" && raw?.status !== "cancelled") {
        return null;
      }
      return nonEmptyString(raw?.failureKind) ?? (raw.status === "cancelled" ? "cancelled" : "error");
    },
    resolveTokenUsage: grokTokenUsageForJob,
    tokenUsageScope: "terminal jobs only"
  },
  codex: {
    id: "codex",
    displayOrder: 1,
    stateEnvVar: "FUSION_CODEX_STATE",
    defaultStateRoot: (env) => path.join(engineDataDir("codex", env), "state"),
    unavailableReason: "codex plugin job state not found; the codex plugin may not be installed",
    note: "read best effort from Codex job state and retained Fusion terminal ledgers; totals are lower bounds",
    enumerateJobs: readCodexJobEvidence,
    multiRootState: true,
    usesAcceptanceEpoch: true,
    usesSupersededJobs: true,
    usesSkuTelemetry: true,
    exposesTransportStatus: true,
    exposesEvidence: true,
    resolveScope: resolveGitWorkspaceRoot,
    matchesWorkspace(raw, cwd, workspaceRoot, repositoryCache) {
      if (raw?._fusionRepositoryKey) {
        return raw._fusionRepositoryKey === fusionRepositoryKey(workspaceRoot, repositoryCache);
      }
      if (workspaceRootsShareRepository(raw?.workspaceRoot, workspaceRoot, repositoryCache)) {
        return true;
      }
      return raw?._fusionScopeKey && workspaceKeyMatchesRepository(raw._fusionScopeKey, workspaceRoot, repositoryCache);
    },
    includeByModel: true,
    includeTokenUsage: true,
    usesModelAudit: true,
    usesTokenUsageObservations: true,
    tokenUsageScope: "terminal transport jobs only",
    dedupeById: true,
    isTerminal: (raw) => ENGINE_TERMINAL_STATUSES.has(raw.status),
    normalizeJob(raw) {
      const finished = raw.finishedAt ?? raw.completedAt ?? raw.updatedAt ?? null;
      let durationSeconds = null;
      if (ENGINE_TERMINAL_STATUSES.has(raw.status) && raw.startedAt && finished) {
        const span = (Date.parse(finished) - Date.parse(raw.startedAt)) / 1000;
        if (Number.isFinite(span) && span >= 0) {
          durationSeconds = span;
        }
      }
      return {
        status: raw.status ?? "unknown",
        kind: raw.jobClass ?? raw.kind ?? "unknown",
        createdAt: raw.createdAt ?? null,
        durationSeconds,
        evidence: raw._fusionEvidence ?? "state"
      };
    },
    resolveModel(raw, observation) {
      return resolveCodexJobModel(raw, observation);
    },
    resolveEffort(raw, observation) {
      return resolveCodexJobEffort(raw, observation);
    }
  },
  ...Object.fromEntries(BREADTH_ENGINE_IDS.map((id, index) => [id, {
    id,
    displayOrder: index + 2,
    defaultStateRoot: (env) => path.join(engineDataDir(id, env), "state"),
    unavailableReason: `${id} plugin job state not found; the ${id} plugin may not be installed`,
    note: `read best effort from ${ENGINES[id].displayName} job state; totals are lower bounds`,
    enumerateJobs: readWorkspaceJobFiles,
    requiresJobs: true,
    requiresScopedJobs: true,
    resolveScope: resolveGitWorkspaceRoot,
    matchesWorkspace(raw, cwd, workspaceRoot, repositoryCache) {
      return workspaceRootsShareRepository(raw?.cwd, workspaceRoot, repositoryCache);
    },
    includeByModel: true,
    includeTokenUsage: true,
    dedupeById: true,
    isTerminal: (raw) => ENGINE_TERMINAL_STATUSES.has(raw.status),
    normalizeJob(raw) {
      const finished = raw.finishedAt ?? raw.completedAt ?? raw.updatedAt ?? null;
      let durationSeconds = null;
      if (raw.status === "done" && raw.createdAt && finished) {
        const span = (Date.parse(finished) - Date.parse(raw.createdAt)) / 1000;
        if (Number.isFinite(span) && span >= 0) {
          durationSeconds = span;
        }
      }
      return {
        status: raw.status ?? "unknown",
        kind: raw.role ?? raw.mode ?? raw.jobClass ?? "unknown",
        createdAt: raw.createdAt ?? null,
        durationSeconds,
        evidence: "state"
      };
    },
    resolveModel(raw) {
      return nonEmptyString(raw?.resolvedModel) ?? "unknown";
    },
    resolveEffort(raw) {
      return raw?.effortApplied === true ? nonEmptyString(raw?.requestedEffort) : null;
    },
    resolveMode(raw) {
      return nonEmptyString(raw?.mode) ?? "unknown";
    },
    resolveFailureKind(raw) {
      if (raw?.status !== "error" && raw?.status !== "cancelled") {
        return null;
      }
      return nonEmptyString(raw?.failureKind) ?? (raw.status === "cancelled" ? "cancelled" : "error");
    },
    resolveTokenUsage: breadthTokenUsageForJob,
    emptyTokenTotals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
    resolveBillingPool(raw) {
      return nonEmptyString(raw?.billingPool);
    },
    tokenUsageScope: "terminal jobs only"
  }]))
};

function workspaceRootsForJob(raw) {
  return [...new Set([...(Array.isArray(raw?._fusionWorkspaceRoots) ? raw._fusionWorkspaceRoots : []), raw?.workspaceRoot].filter((value) => typeof value === "string" && value.trim()).map((value) => path.resolve(value)))];
}

function sameCodexWorkspace(left, right) {
  const rightRoots = new Set(workspaceRootsForJob(right));
  return workspaceRootsForJob(left).some((workspaceRoot) => rightRoots.has(workspaceRoot));
}

export function isSupersededCodexJob(raw, jobs) {
  if (raw?.status !== "error" || !RESUMABLE_CODEX_FAILURE_KINDS.has(nonEmptyString(raw?.failureKind))) {
    return false;
  }
  const threadId = nonEmptyString(raw?.threadId);
  const createdAt = Date.parse(raw?.createdAt ?? "");
  const recorded = raw?.semanticStatus ?? raw?.acceptance;
  if (!threadId || !Number.isFinite(createdAt) || recorded === "accepted" || recorded === "rejected") {
    return false;
  }
  return jobs.some((candidate) => {
    const resumeThreadId = nonEmptyString(candidate?.request?.resumeThreadId);
    const resumedAt = Date.parse(candidate?.createdAt ?? "");
    return candidate !== raw && resumeThreadId === threadId && Number.isFinite(resumedAt) && resumedAt > createdAt && sameCodexWorkspace(raw, candidate);
  });
}

export function observationForJob(raw, env, auditCache) {
  const workspaceRoots = workspaceRootsForJob(raw);
  if (workspaceRoots.length === 0) {
    return null;
  }
  const jobId = typeof raw?.id === "string" ? raw.id : null;
  if (!jobId) {
    return null;
  }
  let selected = null;
  for (const workspaceRoot of workspaceRoots) {
    if (!auditCache.has(workspaceRoot)) {
      auditCache.set(workspaceRoot, loadModelAuditObservations(modelAuditSidecarPath(workspaceRoot, env)));
    }
    const candidate = auditCache.get(workspaceRoot).get(jobId);
    if (candidate && (!selected || modelObservationRank(candidate) > modelObservationRank(selected) || (modelObservationRank(candidate) === modelObservationRank(selected) && observationTimestamp(candidate) > observationTimestamp(selected)))) {
      selected = candidate;
    }
  }
  return selected;
}

export function loadAllObservationCandidates(env, filename, loader) {
  const observations = new Map();
  const root = path.join(resolveFusionDataDir(env), "observations");
  let workspaces;
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return observations;
  }
  for (const workspace of workspaces) {
    for (const [jobId, candidate] of loader(path.join(root, workspace.name, filename))) {
      const candidates = observations.get(jobId) ?? [];
      candidates.push({ ...candidate, _fusionObservationScopeKey: workspace.name });
      observations.set(jobId, candidates);
    }
  }
  return observations;
}

function observationMatchesJobScope(observation, raw, repositoryCache) {
  const roots = workspaceRootsForJob(raw);
  const observationRepositoryKey = nonEmptyString(observation?.repositoryKey);
  const jobRepositoryKey = nonEmptyString(raw?._fusionRepositoryKey);
  if (observationRepositoryKey && jobRepositoryKey) {
    return observationRepositoryKey === jobRepositoryKey;
  }
  if (observationRepositoryKey && roots.length > 0) {
    return roots.some((root) => observationRepositoryKey === fusionRepositoryKey(root, repositoryCache));
  }
  const observationRoot = nonEmptyString(observation?.workspaceRoot);
  if (jobRepositoryKey && observationRoot) {
    return jobRepositoryKey === fusionRepositoryKey(observationRoot, repositoryCache);
  }
  const scopeKey = nonEmptyString(observation?._fusionObservationScopeKey);
  if (!observationRepositoryKey && !observationRoot && scopeKey && (scopeKey === raw?._fusionScopeKey || roots.some((root) => fusionWorkspaceKey(root) === scopeKey))) {
    return true;
  }
  if (jobRepositoryKey || observationRepositoryKey) {
    return false;
  }
  if (observationRoot && roots.some((root) => workspaceRootsShareRepository(observationRoot, root, repositoryCache))) {
    return true;
  }
  return Boolean(scopeKey) && (scopeKey === raw?._fusionScopeKey || roots.some((root) => fusionWorkspaceKey(root) === scopeKey));
}

export function scopedObservationForJob(observations, raw, repositoryCache) {
  const jobId = nonEmptyString(raw?.id);
  if (!jobId) {
    return null;
  }
  let selected = null;
  for (const candidate of observations.get(jobId) ?? []) {
    if (observationMatchesJobScope(candidate, raw, repositoryCache) && (!selected || observationTimestamp(candidate) >= observationTimestamp(selected))) {
      selected = candidate;
    }
  }
  return selected;
}

function integerTokenField(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function checkedUsageAddition(totals, usage) {
  const next = {};
  for (const key of Object.keys(totals)) {
    const total = totals[key] + usage[key];
    if (!Number.isSafeInteger(total)) {
      return null;
    }
    next[key] = total;
  }
  return next;
}

export function normalizeCodexTokenUsage(value) {
  const raw = value?.total_token_usage ?? value?.totalTokenUsage ?? value;
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const usage = {
    inputTokens: integerTokenField(raw.inputTokens ?? raw.input_tokens),
    cachedInputTokens: integerTokenField(raw.cachedInputTokens ?? raw.cached_input_tokens),
    outputTokens: integerTokenField(raw.outputTokens ?? raw.output_tokens),
    reasoningOutputTokens: integerTokenField(raw.reasoningOutputTokens ?? raw.reasoning_output_tokens),
    totalTokens: integerTokenField(raw.totalTokens ?? raw.total_tokens)
  };
  if (Object.values(usage).some((field) => field == null)) {
    return null;
  }
  if (usage.cachedInputTokens > usage.inputTokens || usage.reasoningOutputTokens > usage.outputTokens) {
    return null;
  }
  return BigInt(usage.totalTokens) === BigInt(usage.inputTokens) + BigInt(usage.outputTokens) ? usage : null;
}

function grokTokenField(value, names) {
  const observed = names.filter((name) => Object.hasOwn(value, name)).map((name) => value[name]);
  if (observed.length === 0 || observed.some((candidate) => candidate !== observed[0])) {
    return null;
  }
  return integerTokenField(observed[0]);
}

function normalizeGrokTokenUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const inputTokens = grokTokenField(value, ["input_tokens", "inputTokens"]);
  const cachedInputTokens = grokTokenField(value, ["cache_read_input_tokens", "cacheReadInputTokens", "cachedReadTokens", "cacheReadTokens"]);
  const outputTokens = grokTokenField(value, ["output_tokens", "outputTokens"]);
  const reasoningOutputTokens = grokTokenField(value, ["reasoning_tokens", "reasoningTokens"]);
  const totalTokens = grokTokenField(value, ["total_tokens", "totalTokens"]);
  if ([inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens].some((field) => field == null) || reasoningOutputTokens > outputTokens) {
    return null;
  }
  const uncachedTotal = BigInt(inputTokens) + BigInt(cachedInputTokens) + BigInt(outputTokens);
  const fullInputTotal = BigInt(inputTokens) + BigInt(outputTokens);
  if (BigInt(totalTokens) !== uncachedTotal && BigInt(totalTokens) !== fullInputTotal) {
    return null;
  }
  return {
    inputTokens: Number(BigInt(totalTokens) === fullInputTotal ? BigInt(inputTokens) : BigInt(inputTokens) + BigInt(cachedInputTokens)),
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  };
}

function grokTokenUsageFromModels(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entries = Object.values(value);
  if (entries.length === 0) {
    return null;
  }
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const input = grokTokenField(entry, ["input_tokens", "inputTokens"]);
    const cached = grokTokenField(entry, ["cache_read_input_tokens", "cacheReadInputTokens", "cachedReadTokens", "cacheReadTokens"]);
    const output = grokTokenField(entry, ["output_tokens", "outputTokens"]);
    if (input == null || cached == null || output == null) {
      return null;
    }
    const next = checkedUsageAddition(
      { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens: 0, totalTokens: inputTokens + outputTokens },
      { inputTokens: input + cached, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: 0, totalTokens: input + cached + output }
    );
    if (!next) {
      return null;
    }
    ({ inputTokens, cachedInputTokens, outputTokens } = next);
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens
  };
}

function grokTokenUsageForJob(raw) {
  if (raw?.usageIsIncomplete === true || raw?.usage_is_incomplete === true || raw?.modelUsageIsIncomplete === true) {
    return { availability: "partial", usage: null };
  }
  const direct = normalizeGrokTokenUsage(raw?.usage);
  if (direct) {
    return { availability: "available", usage: direct };
  }
  const byModel = grokTokenUsageFromModels(raw?.modelUsage);
  if (byModel) {
    return { availability: "available", usage: byModel };
  }
  return { availability: raw?.usage != null || raw?.modelUsage != null ? "partial" : "unavailable", usage: null };
}

function breadthTokenUsageForJob(raw) {
  const value = raw?.usage;
  if (value == null) {
    return { availability: "unavailable", usage: null };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { availability: "partial", usage: null };
  }
  if (Object.hasOwn(value, "totalTokens")) {
    const input = integerTokenField(value.inputTokens);
    const output = integerTokenField(value.outputTokens);
    const cachedRead = integerTokenField(value.cachedReadTokens);
    const total = integerTokenField(value.totalTokens);
    if ([input, output, cachedRead, total].some((field) => field == null) || cachedRead > input || BigInt(input) + BigInt(output) !== BigInt(total)) {
      return { availability: "partial", usage: null };
    }
    return {
      availability: "available",
      usage: { inputTokens: input - cachedRead, outputTokens: output, cacheReadTokens: cachedRead, cacheWriteTokens: 0, totalTokens: total }
    };
  }
  const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].map((field) => integerTokenField(value[field]));
  if (fields.some((field) => field == null)) {
    return { availability: "partial", usage: null };
  }
  const [input, output, cacheRead, cacheWrite] = fields;
  const fullInput = BigInt(input) + BigInt(cacheRead) + BigInt(cacheWrite);
  const total = fullInput + BigInt(output);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { availability: "partial", usage: null };
  }
  return {
    availability: "available",
    usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, totalTokens: Number(total) }
  };
}

export function normalizeClaudeWorkerUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const usage = {
    inputTokens: integerTokenField(value.inputTokens),
    cacheCreationInputTokens: integerTokenField(value.cacheCreationInputTokens),
    cacheReadInputTokens: integerTokenField(value.cacheReadInputTokens),
    outputTokens: integerTokenField(value.outputTokens),
    totalTokens: integerTokenField(value.totalTokens),
    uncachedTokens: integerTokenField(value.uncachedTokens)
  };
  if (Object.values(usage).some((field) => field == null)) {
    return null;
  }
  const totalTokens = BigInt(usage.inputTokens) + BigInt(usage.cacheCreationInputTokens) + BigInt(usage.cacheReadInputTokens) + BigInt(usage.outputTokens);
  const uncachedTokens = BigInt(usage.inputTokens) + BigInt(usage.cacheCreationInputTokens) + BigInt(usage.outputTokens);
  return BigInt(usage.totalTokens) === totalTokens && BigInt(usage.uncachedTokens) === uncachedTokens ? usage : null;
}

export function tokenUsageForJob(raw, observation) {
  const candidates = [
    { value: raw?.tokenUsage, availability: raw?.tokenUsageAvailability },
    { value: raw?.usage, availability: raw?.tokenUsageAvailability ?? raw?.usageAvailability },
    { value: raw?.result?.tokenUsage, availability: raw?.result?.tokenUsageAvailability ?? raw?.result?.usageAvailability },
    { value: raw?.result?.usage, availability: raw?.result?.tokenUsageAvailability ?? raw?.result?.usageAvailability },
    { value: observation?.tokenUsage, availability: observation?.availability },
    { value: observation?.usage, availability: observation?.availability }
  ];
  let incomplete = false;
  for (const candidate of candidates) {
    if (candidate.availability === "partial" || candidate.availability === "incomplete") {
      incomplete = true;
      continue;
    }
    const normalized = normalizeCodexTokenUsage(candidate.value);
    if (!normalized) {
      incomplete ||= candidate.value != null || candidate.availability === "available";
      continue;
    }
    if (candidate.availability === "unavailable" || candidate.availability === "unreported") {
      continue;
    }
    if (candidate.availability != null && candidate.availability !== "available") {
      continue;
    }
    return { availability: "available", usage: normalized };
  }
  return { availability: incomplete ? "partial" : "unavailable", usage: null };
}

export function codexSku(model, effort) {
  return `${model}@${effort ?? "unavailable"}`;
}

function configuredCodexModels(env) {
  const routing = readModelRoutingFile(resolveModelRoutingPath(env));
  if (!routing.ok) {
    return new Set();
  }
  return new Set([
    ...routing.data.models.filter((row) => row.lane === "codex").map((row) => row.id),
    ...Object.values(routing.data.defaults?.codex ?? {}).map((choice) => choice.model)
  ]);
}

export function summarizeCodexSkuTelemetry(entries, env) {
  const newestCreatedAt = entries.reduce((latest, entry) => Math.max(latest, entry.createdAtMs), Number.NEGATIVE_INFINITY);
  const trendRows = new Map();
  if (Number.isFinite(newestCreatedAt)) {
    const cutoff = newestCreatedAt - LAST_SEVEN_DAYS_MS;
    for (const entry of entries) {
      if (entry.createdAtMs < cutoff) {
        continue;
      }
      const row = trendRows.get(entry.sku) ?? { sku: entry.sku, jobs: 0, outputTokens: 0, outputTokenOverflow: false, timeouts: 0, salvagedTimeouts: 0, nearCap: 0 };
      row.jobs += 1;
      if (entry.failureKind === "timeout") {
        row.timeouts += 1;
        if (entry.acceptance === "accepted") {
          row.salvagedTimeouts += 1;
        }
      }
      if (entry.failureKind === "timeout" || (entry.durationSeconds != null && entry.timeoutMs != null && entry.timeoutMs / 1000 - entry.durationSeconds <= 30)) {
        row.nearCap += 1;
      }
      if (entry.outputTokens != null && !row.outputTokenOverflow) {
        const outputTokens = row.outputTokens + entry.outputTokens;
        if (Number.isSafeInteger(outputTokens)) {
          row.outputTokens = outputTokens;
        } else {
          row.outputTokenOverflow = true;
        }
      }
      trendRows.set(entry.sku, row);
    }
  }
  const terminalBySku = new Map();
  const configuredModels = configuredCodexModels(env);
  const now = Date.now();
  const driftCutoff = now - LANE_SIGNAL_WINDOW_MS;
  for (const entry of entries) {
    if (!entry.terminal || entry.createdAtMs < driftCutoff || entry.createdAtMs > now || !configuredModels.has(entry.model)) {
      continue;
    }
    const terminalEntries = terminalBySku.get(entry.sku) ?? [];
    terminalEntries.push(entry);
    terminalBySku.set(entry.sku, terminalEntries);
  }
  const laneSignalDrift = [];
  for (const [sku, terminalEntries] of terminalBySku) {
    const trailing = terminalEntries.filter((entry) => !entry.infrastructureKind).sort((left, right) => right.createdAtMs - left.createdAtMs).slice(0, LANE_SIGNAL_TRAILING_JOBS);
    const judged = trailing.filter((entry) => entry.acceptance === "accepted" || entry.acceptance === "rejected");
    if (judged.length < LANE_SIGNAL_MIN_JUDGED_JOBS) {
      continue;
    }
    const accepted = judged.filter((entry) => entry.acceptance === "accepted").length;
    const acceptanceRate = accepted / judged.length;
    const timeoutShare = trailing.filter((entry) => entry.failureKind === "timeout").length / trailing.length;
    if (acceptanceRate < 0.7 || timeoutShare > 0.2) {
      laneSignalDrift.push({ sku, acceptanceRate, timeoutShare });
    }
  }
  return {
    last7DaysBySku: [...trendRows.values()]
      .sort((left, right) => left.sku.localeCompare(right.sku))
      .map((row) => ({ ...row, timeoutShare: row.timeouts / row.jobs, nearCapShare: row.nearCap / row.jobs })),
    laneSignalDrift: laneSignalDrift.sort((left, right) => left.sku.localeCompare(right.sku))
  };
}
