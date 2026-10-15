import { resolveGrokBin, recordedProcessGroupsClean, runningJobLiveness, terminalRecordAttribution, terminateRecordedProcessGroupsSync } from "../grok-exec.mjs";
import { nowIso, readJobRecordFile, readLogTail, updateJobRecordFile, updateJobRecordFileWithCurrent, appendJobLog } from "../state.mjs";
import { output, errorWithFailure, oneLineSummary, boundedTextTail, failureOutcomeMessage } from "./base.mjs";
import { jobClassForRecord, memoryEnabledForRecord } from "./session.mjs";
import { grokFailureMessage, classifyFailure, finishJobRecord, failureTail } from "./execution.mjs";

function deadProcessMessage(deadPids) {
  if (deadPids.length === 0) {
    return "No process id was recorded before the launch grace window elapsed.";
  }
  const label = deadPids.length === 1 ? "pid" : "pids";
  return `Recorded ${label} ${deadPids.join(", ")} exited without recording an outcome.`;
}

function cleanupRequiredPatch(current, failureKind, message) {
  return {
    ...current,
    ...terminalRecordAttribution(current),
    cleanupRequired: true,
    errorMessage: message,
    errorTail: message,
    failureKind
  };
}

function finishDiedJobRecord(file) {
  const observed = readJobRecordFile(file);
  if (!observed || observed.status !== "running") {
    return observed;
  }
  const observedLiveness = runningJobLiveness(observed);
  if (observedLiveness.alive && !observed.cleanupRequired) {
    return observed;
  }
  const terminated = terminateRecordedProcessGroupsSync(observed);
  return updateJobRecordFileWithCurrent(file, (current) => {
    if (current.status !== "running") {
      return current;
    }
    const liveness = runningJobLiveness(current);
    if (liveness.alive && !current.cleanupRequired) {
      return current;
    }
    if (!terminated || !recordedProcessGroupsClean(current)) {
      return cleanupRequiredPatch(current, current.cancelRequestedAt ? "cancelled" : "died", "The recorded processes exited without a terminal outcome, but verified process cleanup did not complete.");
    }
    const cancelled = current.cancelRequestedAt != null;
    const message = cancelled ? current.errorMessage ?? "The Grok job was cancelled." : deadProcessMessage(liveness.deadPids);
    const status = cancelled ? "cancelled" : "error";
    const failureKind = cancelled ? "cancelled" : "died";
    return {
      ...current,
      ...terminalRecordAttribution(current),
      status,
      finishedAt: nowIso(),
      resultPayload: retainedResultPayload(
        current,
        failureResultPayload(current, {
          status,
          failureKind,
          message: failureOutcomeMessage({ message, jobId: current.id, cwd: current.cwd, status, failureKind })
        })
      ),
      errorMessage: message,
      errorTail: message,
      failureKind,
      cancelRequestedAt: null
    };
  });
}

function refreshRunningJobRecord({ record, file }) {
  const current = readJobRecordFile(file) ?? record;
  const liveness = runningJobLiveness(current);
  if (liveness.alive) {
    return { record: current, changed: false };
  }
  const next = finishDiedJobRecord(file);
  return { record: next, changed: next?.status !== "running" };
}

const TOKEN_USAGE_FIELDS = {
  inputTokens: ["input_tokens", "inputTokens"],
  cacheReadInputTokens: ["cache_read_input_tokens", "cacheReadInputTokens", "cachedReadTokens", "cacheReadTokens"],
  outputTokens: ["output_tokens", "outputTokens"],
  reasoningTokens: ["reasoning_tokens", "reasoningTokens"],
  totalTokens: ["total_tokens", "totalTokens"]
};
const TOKEN_USAGE_METRICS = Object.keys(TOKEN_USAGE_FIELDS);
const MODEL_USAGE_FIELDS = {
  inputTokens: ["inputTokens", "input_tokens"],
  cacheReadInputTokens: ["cacheReadInputTokens", "cachedReadTokens", "cache_read_input_tokens"],
  outputTokens: ["outputTokens", "output_tokens"],
  modelCalls: ["modelCalls", "model_calls"]
};

function optionalBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function finiteTokenField(value, names) {
  const observed = [];
  for (const name of names) {
    if (value && Object.hasOwn(value, name)) {
      observed.push(value[name]);
    }
  }
  if (observed.length === 0 || observed.slice(1).some((candidate) => candidate !== observed[0])) {
    return null;
  }
  return Number.isSafeInteger(observed[0]) && observed[0] >= 0 ? observed[0] : null;
}

function tokenUsageObservation(value, { allowFullInput = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { coverage: "unreported", usage: null };
  }
  const usage = {};
  let observedFields = 0;
  for (const [metric, names] of Object.entries(TOKEN_USAGE_FIELDS)) {
    const field = finiteTokenField(value, names);
    if (field != null) {
      usage[metric] = field;
      observedFields += 1;
    }
  }
  if (observedFields === 0) {
    return { coverage: "unreported", usage: null };
  }
  if (usage.reasoningTokens != null && usage.outputTokens != null && usage.reasoningTokens > usage.outputTokens) {
    return { coverage: "incomplete", usage };
  }
  if (observedFields === TOKEN_USAGE_METRICS.length) {
    const uncachedTotal = BigInt(usage.inputTokens) + BigInt(usage.cacheReadInputTokens) + BigInt(usage.outputTokens);
    const fullInputTotal = BigInt(usage.inputTokens) + BigInt(usage.outputTokens);
    const reportedTotal = BigInt(usage.totalTokens);
    if (reportedTotal !== uncachedTotal && (!allowFullInput || reportedTotal !== fullInputTotal)) {
      return { coverage: "incomplete", usage };
    }
  }
  return {
    coverage: observedFields === TOKEN_USAGE_METRICS.length ? "complete" : "incomplete",
    usage
  };
}

function spendObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

function modelUsageObservation(value) {
  if (!spendObject(value)) {
    return { coverage: "unreported" };
  }
  const entries = Object.values(value);
  return {
    coverage: entries.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        Object.values(MODEL_USAGE_FIELDS).every((names) => finiteTokenField(entry, names) != null)
    )
      ? "complete"
      : "incomplete"
  };
}

function observedChannelIncomplete(explicitIncomplete, coverage) {
  if (explicitIncomplete === true || coverage === "incomplete") {
    return true;
  }
  if (coverage === "complete") {
    return false;
  }
  return explicitIncomplete;
}

function resultSpendPatch(result) {
  const explicitUsageIncomplete = optionalBoolean(result?.usageIsIncomplete);
  const usageIsIncomplete = observedChannelIncomplete(
    explicitUsageIncomplete,
    tokenUsageObservation(result?.usage).coverage
  );
  const modelUsageIsIncomplete = observedChannelIncomplete(
    null,
    modelUsageObservation(result?.modelUsage).coverage
  );
  return {
    requestId: result?.requestId ?? null,
    stopReason: result?.stopReason ?? null,
    numTurns: result?.numTurns ?? null,
    totalCostUsd: result?.totalCostUsd ?? null,
    totalCostUsdTicks: result?.totalCostUsdTicks ?? null,
    costIsPartial: optionalBoolean(result?.costIsPartial),
    resolvedModel: result?.resolvedModel ?? null,
    resolvedEffort: result?.resolvedEffort ?? null,
    usage: result?.usage ?? null,
    modelUsage: result?.modelUsage ?? null,
    usageIsIncomplete,
    modelUsageIsIncomplete,
    structuredOutput: result?.structuredOutput,
    structuredOutputError: result?.structuredOutputError,
    ...(result?.authRefresh ? { authRefresh: result.authRefresh } : {}),
    ...(result?.authRetry ? { authRetry: true } : {})
  };
}

function outcomeFields(record, status) {
  const deliveryStatus = record?.deliveryCollectedAt
    ? "collected"
    : record?.delivery === "foreground" && status !== "running"
      ? "delivered"
      : "pending";
  return {
    transportStatus: status,
    semanticStatus: record?.semanticStatus ?? "unverified",
    delivery: record?.delivery ?? (record?.background ? "manual" : "foreground"),
    deliveryStatus
  };
}

function observableRecord(record) {
  return {
    ...record,
    jobClass: jobClassForRecord(record),
    memoryEnabled: memoryEnabledForRecord(record)
  };
}

function taskSuccessPayload(record, result) {
  return {
    jobId: record.id,
    status: "done",
    ...outcomeFields(record, "done"),
    jobClass: jobClassForRecord(record),
    mode: record.mode,
    background: record.background,
    memoryEnabled: memoryEnabledForRecord(record),
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    stopReason: result.stopReason,
    ...resultSpendPatch(result),
    failureKind: null,
    text: result.text
  };
}

function failureResultPayload(record, { status, failureKind, message, result = null }) {
  return {
    jobId: record?.id ?? null,
    status,
    ...outcomeFields(record, status),
    jobClass: jobClassForRecord(record),
    mode: record?.mode ?? null,
    background: Boolean(record?.background),
    memoryEnabled: memoryEnabledForRecord(record),
    exitCode: result?.exitCode ?? null,
    sessionId: result?.sessionId ?? null,
    ...(result ? resultSpendPatch(result) : {}),
    failureKind,
    message
  };
}

function retainedResultPayload(record, payload) {
  return record?.request?.outputJson ? payload : null;
}

function failJob(jobFile, logFile, result, timeoutMs) {
  const tail = failureTail(logFile, result);
  const current = readJobRecordFile(jobFile);
  const failureKind =
    current?.status === "cancelled" || current?.cancelRequestedAt
      ? "cancelled"
      : classifyFailure({ result, logTail: tail });
  const message = grokFailureMessage(result, timeoutMs, failureKind, tail);
  const status = failureKind === "cancelled" ? "cancelled" : "error";
  const renderedMessage = failureOutcomeMessage({ message, detail: tail, jobId: current?.id, cwd: current?.cwd, status, failureKind });
  finishJobRecord(jobFile, {
    status,
    pid: null,
    grokPid: null,
    finishedAt: nowIso(),
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    resultText: result.text ?? null,
    resultPayload: retainedResultPayload(
      current,
      failureResultPayload(current, { status, failureKind, message: renderedMessage, result })
    ),
    ...resultSpendPatch(result),
    errorMessage: oneLineSummary(message),
    errorTail: tail || message,
    failureKind,
    cancelRequestedAt: null
  });
  throw new Error(renderedMessage);
}

function finishTaskStructuredFailure(jobFile, result, evaluation) {
  const current = readJobRecordFile(jobFile);
  const message = `Grok task output failed validation: ${evaluation.error}`;
  const detail = boundedTextTail(result?.text);
  const renderedMessage = failureOutcomeMessage({
    message,
    detail,
    jobId: current?.id,
    cwd: current?.cwd,
    status: "error",
    failureKind: "error"
  });
  finishJobRecord(jobFile, {
    status: "error",
    pid: null,
    grokPid: null,
    finishedAt: nowIso(),
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    resultText: result.text ?? null,
    resultPayload: retainedResultPayload(
      current,
      failureResultPayload(current, { status: "error", failureKind: "error", message: renderedMessage, result })
    ),
    ...resultSpendPatch(result),
    errorMessage: oneLineSummary(message),
    errorTail: detail || message,
    failureKind: "error",
    cancelRequestedAt: null
  });
  return renderedMessage;
}

function describeLaunchFailure(error) {
  if (error?.code === "ENOENT") {
    return `The grok CLI (${resolveGrokBin()}) was not found on PATH. Install and authenticate it, then run /grok:setup to verify.`;
  }
  return error instanceof Error ? error.message : String(error);
}

function launchFailureError(error, jobId, cwd) {
  const failureKind = classifyFailure({ spawnError: error });
  const status = error?.cleanupRequired ? "running" : failureKind === "cancelled" ? "cancelled" : "error";
  const wrapped = errorWithFailure(
    failureOutcomeMessage({
      message: describeLaunchFailure(error),
      jobId,
      cwd,
      status,
      failureKind
    }),
    failureKind
  );
  if (error?.cleanupRequired) {
    wrapped.cleanupRequired = true;
    wrapped.processRole = error.processRole ?? null;
    wrapped.pid = error.pid ?? null;
    wrapped.pidIdentity = error.pidIdentity ?? null;
  }
  return wrapped;
}

function appendFailureLog(logFile, message) {
  try {
    appendJobLog(logFile, message);
    return readLogTail(logFile, 20) || message;
  } catch {
    return message;
  }
}

function recordSpawnFailure(jobFile, error, context = {}) {
  const message = describeLaunchFailure(error);
  try {
    const current = readJobRecordFile(jobFile);
    const failureKind = classifyFailure({ spawnError: error });
    if (error?.cleanupRequired || current?.cleanupRequired) {
      const processPatch = error.processRole === "worker"
        ? { pid: error.pid ?? current?.pid ?? null, pidIdentity: error.pidIdentity ?? current?.pidIdentity ?? null }
        : { grokPid: error.pid ?? current?.grokPid ?? null, grokPidIdentity: error.pidIdentity ?? current?.grokPidIdentity ?? null };
      updateJobRecordFile(jobFile, {
        ...context,
        ...processPatch,
        ...terminalRecordAttribution(current),
        cleanupRequired: true,
        errorMessage: oneLineSummary(message),
        errorTail: message,
        failureKind
      });
      return;
    }
    const status = failureKind === "cancelled" ? "cancelled" : "error";
    finishJobRecord(jobFile, {
      ...context,
      status,
      pid: null,
      grokPid: null,
      finishedAt: nowIso(),
      resultPayload: retainedResultPayload(
        current,
        failureResultPayload(current, { status, failureKind, message })
      ),
      errorMessage: oneLineSummary(message),
      errorTail: message,
      failureKind,
      cancelRequestedAt: null
    });
  } catch {
    return;
  }
}

export { deadProcessMessage, cleanupRequiredPatch, finishDiedJobRecord, refreshRunningJobRecord, TOKEN_USAGE_FIELDS, TOKEN_USAGE_METRICS, MODEL_USAGE_FIELDS, optionalBoolean, finiteTokenField, tokenUsageObservation, spendObject, modelUsageObservation, observedChannelIncomplete, resultSpendPatch, outcomeFields, observableRecord, taskSuccessPayload, failureResultPayload, retainedResultPayload, failJob, finishTaskStructuredFailure, describeLaunchFailure, launchFailureError, appendFailureLog, recordSpawnFailure };
