import path from "node:path";
import { appendTokenUsageObservation, fusionRepositoryKey } from "../../fusion-stats.mjs";
import { isTerminalWorkerStatus, resolveFusionDataDir } from "../worker-state.mjs";

function observedWorkerTokenUsage(usage) {
  return {
    inputTokens: nonNegativeInteger(usage?.inputTokens),
    cachedInputTokens: nonNegativeInteger(usage?.cacheReadInputTokens),
    outputTokens: nonNegativeInteger(usage?.outputTokens),
    reasoningOutputTokens: null,
    totalTokens: nonNegativeInteger(usage?.totalTokens)
  };
}

function observeTerminalTokenUsage(record, env) {
  if (!record || !isTerminalWorkerStatus(record.transportStatus) || record.usageAvailability !== "available" || typeof record.workspaceRoot !== "string" || !record.workspaceRoot) {
    return;
  }
  try {
    const repositoryKey = fusionRepositoryKey(record.workspaceRoot);
    if (!repositoryKey) {
      return;
    }
    appendTokenUsageObservation(path.join(resolveFusionDataDir(env), "observations", repositoryKey, "token-usage.jsonl"), {
      schemaVersion: 1,
      jobId: record.taskId,
      engine: "claude",
      workspaceRoot: record.workspaceRoot,
      repositoryKey,
      availability: record.usageAvailability,
      tokenUsage: observedWorkerTokenUsage(record.usage),
      reason: null,
      threadId: null,
      turnId: null,
      source: "worker-record",
      observedAt: new Date().toISOString()
    });
  } catch {
    void 0;
  }
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function canonicalToolResponseUsage(response) {
  const usage = response?.usage && typeof response.usage === "object" ? response.usage : null;
  if (!usage) {
    const totalTokens = nonNegativeInteger(response?.totalTokens);
    return totalTokens > 0 ? { availability: "partial", reportedTotalTokens: totalTokens, usage: null } : null;
  }
  const inputTokens = nonNegativeInteger(usage.input_tokens ?? usage.inputTokens);
  const cacheCreationInputTokens = nonNegativeInteger(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens);
  const cacheReadInputTokens = nonNegativeInteger(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens);
  const outputTokens = nonNegativeInteger(usage.output_tokens ?? usage.outputTokens);
  const totalTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens + outputTokens;
  return {
    availability: "available",
    reportedTotalTokens: nonNegativeInteger(response.totalTokens) || totalTokens,
    usage: {
      inputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      outputTokens,
      totalTokens,
      uncachedTokens: inputTokens + cacheCreationInputTokens + outputTokens
    }
  };
}


export { observedWorkerTokenUsage, observeTerminalTokenUsage, nonNegativeInteger, canonicalToolResponseUsage };
