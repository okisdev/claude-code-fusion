import path from "node:path";
import { normalizeGrokSessionId, sandboxProfileForMode, recordedProcessGroupsClean, terminalRecordAttribution, terminateRecordedProcessGroups } from "../grok-exec.mjs";
import { renderCancelReport, renderHistoryReport, renderJobDetail, renderStatusTable, renderTaskResult } from "../render.mjs";
import { jobFilePath, jobLogPath, listAllJobRecords, listJobRecords, markDeliveryCollectedFile, nowIso, readJobRecordFile, readLogTail, resolveDataDir, updateJobRecordFile, updateJobRecordFileWithCurrent } from "../state.mjs";
import { JOB_ID_PATTERN, DEFAULT_HISTORY_LIMIT, HISTORY_STATUSES, HISTORY_MODES, HISTORY_DELIVERIES, HISTORY_DELIVERY_STATUSES, HISTORY_SEMANTIC_STATUSES, HISTORY_FAILURE_KINDS } from "./config.mjs";
import { output, errorWithFailure, failureOutcomeMessage, resolveCwd, findRequestedJobRecord, currentClaudeSessionId, parseHistoryLimit, commandArgs, resolveWaitPollMs, resolveWaitTimeoutMs, delayMs } from "./base.mjs";
import { inputError, jobClassForRecord, memoryEnabledForRecord, terminalJob, sessionMemoryModes } from "./session.mjs";
import { cleanupRequiredPatch, refreshRunningJobRecord, outcomeFields, observableRecord, failureResultPayload, retainedResultPayload } from "./outcome.mjs";

function handleStatus(argv, transport = {}) {
  const { options, positionals } = commandArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  }, transport);

  const dataDir = resolveDataDir();
  const jobId = positionals[0];
  if (jobId) {
    const found = findRequestedJobRecord(dataDir, jobId, options);
    if (!found) {
      throw new Error(`No job record found for ${jobId}.`);
    }
    const { record } = refreshRunningJobRecord(found);
    const logTail =
      record.status === "error" ? readLogTail(jobLogPath(dataDir, record.cwd, record.id), 20) : "";
    const observed = observableRecord(record);
    output(options.json ? observed : renderJobDetail(observed, { logTail }), options.json);
    if (record.cleanupRequired) {
      process.exitCode = 1;
    }
    return;
  }

  const cwd = resolveCwd(options);
  const jobs = listJobRecords(dataDir, cwd).map((record) =>
    refreshRunningJobRecord({ record, file: jobFilePath(dataDir, cwd, record.id) }).record
  );
  output(options.json ? { jobs: jobs.map(observableRecord) } : renderStatusTable(jobs, currentClaudeSessionId()), options.json);
  if (jobs.some((record) => record.cleanupRequired)) {
    process.exitCode = 1;
  }
}

function historyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function historyTimestamp(value) {
  const normalized = historyString(value);
  return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : null;
}

function historyEnum(value, allowed, fallback = "unknown") {
  return allowed.has(value) ? value : fallback;
}

function historyJob(record, claudeSessionId, mixedMemorySessions) {
  const mode = historyEnum(record?.mode, HISTORY_MODES);
  const sessionId = normalizeGrokSessionId(record?.sessionId);
  const jobClass = jobClassForRecord(record);
  const resumable =
    terminalJob(record) &&
    jobClass === "task" &&
    sessionId != null &&
    mode !== "unknown" &&
    record?.request?.sandboxProfile === sandboxProfileForMode(mode) &&
    !mixedMemorySessions.has(sessionId);
  return {
    jobId: JOB_ID_PATTERN.test(String(record?.id ?? "")) ? record.id : null,
    sessionId,
    cwd: typeof record?.cwd === "string" && path.isAbsolute(record.cwd) ? path.normalize(record.cwd) : null,
    status: historyEnum(record?.status, HISTORY_STATUSES),
    jobClass,
    mode,
    background: record?.background === true,
    delivery: historyEnum(record?.delivery, HISTORY_DELIVERIES),
    deliveryStatus: historyEnum(record?.deliveryStatus, HISTORY_DELIVERY_STATUSES),
    semanticStatus: historyEnum(record?.semanticStatus, HISTORY_SEMANTIC_STATUSES),
    cleanupRequired: record?.cleanupRequired === true,
    failureKind: historyEnum(record?.failureKind, HISTORY_FAILURE_KINDS, null),
    resolvedModel: historyString(record?.resolvedModel),
    resolvedEffort: historyString(record?.resolvedEffort),
    memoryEnabled: memoryEnabledForRecord(record),
    createdAt: historyTimestamp(record?.createdAt),
    finishedAt: historyTimestamp(record?.finishedAt),
    resumable,
    resumeMode: resumable ? mode : null,
    ownedByCurrentSession: claudeSessionId == null ? null : record?.claudeSessionId === claudeSessionId
  };
}

function handleHistory(argv, transport = {}) {
  const { options, positionals } = commandArgs(argv, {
    valueOptions: ["limit", "cwd"],
    booleanOptions: ["all", "json"]
  }, transport);
  if (positionals.length > 0) {
    throw inputError("History accepts only --all, --limit, --cwd, and --json.");
  }

  const dataDir = resolveDataDir();
  const cwd = options.all ? null : resolveCwd(options);
  const limit = options.limit === undefined ? DEFAULT_HISTORY_LIMIT : parseHistoryLimit(options.limit);
  const entries = options.all
    ? listAllJobRecords(dataDir)
    : listJobRecords(dataDir, cwd).map((record) => ({
        record,
        file: jobFilePath(dataDir, cwd, record.id)
      }));
  const totalJobs = entries.length;
  const selected = entries.slice(0, limit);
  const claudeSessionId = currentClaudeSessionId();
  const mixedMemorySessions = new Set(
    [...sessionMemoryModes(entries.map((entry) => entry.record))]
      .filter(([, modes]) => modes.size > 1)
      .map(([sessionId]) => sessionId)
  );
  const jobs = selected.map((entry) =>
    historyJob(refreshRunningJobRecord(entry).record, claudeSessionId, mixedMemorySessions)
  );
  const report = {
    source: "canonical",
    scope: options.all ? "all" : "workspace",
    cwd,
    limit,
    totalJobs,
    returnedJobs: jobs.length,
    truncated: totalJobs > jobs.length,
    jobs
  };
  output(options.json ? report : renderHistoryReport(report), options.json);
}

function renderFailedResult(record, dataDir) {
  const tail = readLogTail(jobLogPath(dataDir, record.cwd, record.id), 20) || record.errorTail || "";
  const lines = [`Job ${record.id} failed${record.exitCode != null ? ` with exit code ${record.exitCode}` : ""}.`];
  if (tail) {
    lines.push("", "Log tail:", "", "```text", tail, "```");
  }
  lines.push("", `job: ${record.id}`, `sandbox: ${record.cwd}`, `delivery: ${record.delivery}`, `semantic: ${record.semanticStatus}`, "state: error");
  if (record.failureKind) {
    lines.push(`failure: ${record.failureKind}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderRunningWaitResult(record) {
  if (record.cleanupRequired) {
    const lines = [`Job ${record.id}`, "", "Status: cleanup required"];
    if (record.errorMessage) {
      lines.push("", record.errorMessage);
    }
    lines.push("phase: cleanup-required", "", `job: ${record.id}`, `sandbox: ${record.cwd}`, `delivery: ${record.delivery}`, `semantic: ${record.semanticStatus}`, "state: running");
    if (record.failureKind) {
      lines.push(`failure: ${record.failureKind}`);
    }
    return `${lines.join("\n")}\n`;
  }
  return [`Job ${record.id}`, "", "Status: running", "", `job: ${record.id}`, `sandbox: ${record.cwd}`, `delivery: ${record.delivery}`, `semantic: ${record.semanticStatus}`, "state: running"].join("\n") + "\n";
}

function renderNotRunningReport(record) {
  const lines = [
    `Job ${record.id} is not running (status: ${record.status}).`,
    "",
    `job: ${record.id}`,
    `sandbox: ${record.cwd}`,
    `delivery: ${record.delivery}`,
    `semantic: ${record.semanticStatus}`,
    `state: ${record.status}`
  ];
  if (record.failureKind) {
    lines.push(`failure: ${record.failureKind}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderResultRecord(record, dataDir) {
  if (record.status === "running") {
    if (record.cleanupRequired) {
      return renderRunningWaitResult(record);
    }
    return `Job ${record.id} is still running. Check /grok:status ${record.id} for progress.\n`;
  }

  if (record.status === "error") {
    return renderFailedResult(record, dataDir);
  }

  if (record.status === "cancelled") {
    const lines = [`Job ${record.id} was cancelled.`, "", `job: ${record.id}`, `sandbox: ${record.cwd}`, `delivery: ${record.delivery}`, `semantic: ${record.semanticStatus}`, "state: cancelled"];
    if (record.failureKind) {
      lines.push(`failure: ${record.failureKind}`);
    }
    return `${lines.join("\n")}\n`;
  }

  return renderTaskResult({
    text: record.resultText ?? "",
    structuredOutput: record.structuredOutput,
    structuredOutputError: record.structuredOutputError,
    schemaRequested: record.request?.jsonSchema != null,
    sessionId: record.sessionId,
    jobId: record.id,
    cwd: record.cwd,
    delivery: record.delivery,
    semanticStatus: record.semanticStatus
  });
}

function jsonResultPayload(record, options = {}) {
  const deliveryView = observableRecord(
    options.collecting ? { ...record, deliveryCollectedAt: nowIso() } : record
  );
  if (!record.request?.outputJson || record.status === "running") {
    return deliveryView;
  }
  if (record.resultPayload) {
    return {
      ...record.resultPayload,
      ...outcomeFields(deliveryView, record.status),
      resolvedModel: record.resolvedModel ?? null,
      resolvedEffort: record.resolvedEffort ?? null
    };
  }
  return deliveryView;
}

async function waitForResultRecord(found, options) {
  const timeoutMs = resolveWaitTimeoutMs(options);
  const pollMs = resolveWaitPollMs();
  const deadline = Date.now() + timeoutMs;
  let record = found.record;

  for (;;) {
    const current = readJobRecordFile(found.file) ?? record;
    record = refreshRunningJobRecord({ record: current, file: found.file }).record;
    if (record.status !== "running" || record.cleanupRequired) {
      return record;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return record;
    }
    await delayMs(Math.min(pollMs, remaining));
  }
}

async function handleResult(argv, transport = {}) {
  const { options, positionals } = commandArgs(argv, {
    valueOptions: ["cwd", "wait-timeout-ms"],
    booleanOptions: ["json", "wait"]
  }, transport);

  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("Provide a job id, for example /grok:result <job-id>.");
  }

  const dataDir = resolveDataDir();
  const found = findRequestedJobRecord(dataDir, jobId, options);
  if (!found) {
    throw new Error(`No job record found for ${jobId}.`);
  }

  const record = options.wait ? await waitForResultRecord(found, options) : refreshRunningJobRecord(found).record;
  const markCollected = record.status !== "running" && record.delivery !== "foreground";
  if (record.cleanupRequired) {
    process.exitCode = 1;
  }
  if (options.json) {
    output(jsonResultPayload(record, { collecting: markCollected }), true);
    if (markCollected) {
      markDeliveryCollectedFile(found.file);
    }
    return;
  }

  if (options.wait && record.status === "running") {
    output(renderRunningWaitResult(record), false);
    return;
  }

  output(renderResultRecord(record, dataDir), false);
  if (markCollected) {
    markDeliveryCollectedFile(found.file);
  }
}

async function handleCancel(argv, transport = {}) {
  const { options, positionals } = commandArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  }, transport);

  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("Provide a job id, for example /grok:cancel <job-id>.");
  }

  const dataDir = resolveDataDir();
  const found = findRequestedJobRecord(dataDir, jobId, options);
  if (!found) {
    throw new Error(`No job record found for ${jobId}.`);
  }

  const record = readJobRecordFile(found.file) ?? found.record;
  if (record.status !== "running") {
    output(options.json ? record : renderNotRunningReport(record), options.json);
    return;
  }
  const requested = updateJobRecordFile(found.file, { cancelRequestedAt: nowIso() });
  if (requested.status !== "running") {
    output(
      options.json ? requested : renderNotRunningReport(requested),
      options.json
    );
    return;
  }

  const terminated = await terminateRecordedProcessGroups(requested);
  const cleanupMessage = "Cancellation was requested, but verified process cleanup did not complete. The process identifiers were retained for retry.";
  const next = updateJobRecordFileWithCurrent(found.file, (current) => {
    if (current.status !== "running") {
      return current;
    }
    if (!terminated || !recordedProcessGroupsClean(current)) {
      return cleanupRequiredPatch(current, "cancelled", cleanupMessage);
    }
    return {
      ...current,
      ...terminalRecordAttribution(current),
      status: "cancelled",
      finishedAt: nowIso(),
      resultPayload: retainedResultPayload(
        current,
        failureResultPayload(current, {
          status: "cancelled",
          failureKind: "cancelled",
          message: failureOutcomeMessage({
            message: "The Grok job was cancelled.",
            record: current,
            status: "cancelled",
            failureKind: "cancelled"
          })
        })
      ),
      failureKind: "cancelled",
      cancelRequestedAt: null
    };
  });
  if (next.status === "running" && next.cleanupRequired) {
    throw errorWithFailure(failureOutcomeMessage({ message: cleanupMessage, record: next, status: "running", failureKind: "cancelled" }), "cancelled");
  }
  if (next.status !== "cancelled") {
    output(options.json ? next : renderNotRunningReport(next), options.json);
    return;
  }
  output(options.json ? next : renderCancelReport(next), options.json);
}

export { handleStatus, historyString, historyTimestamp, historyEnum, historyJob, handleHistory, renderFailedResult, renderRunningWaitResult, renderNotRunningReport, renderResultRecord, jsonResultPayload, waitForResultRecord, handleResult, handleCancel };
