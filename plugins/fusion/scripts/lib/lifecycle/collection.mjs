import { PEER_RESCUE_AGENT_NAMES } from "../engines.mjs";
import fs from "node:fs";
import path from "node:path";
import { engineAcceptanceTransport, recordEngineAcceptance } from "../engine-acceptance.mjs";
import { PEER_JOB_FOOTER_AGENTS, PEER_MANAGED_AGENTS, engineForAgentType, isEngineId } from "../engines.mjs";
import { readEngineJobFailureKind } from "../engine-job-state.mjs";
import { applyQueuedVerdict, backfillWorkerTaskOutputTelemetry, canonicalWorkerAgentType, isSettledWorker, WORKER_TERMINAL_STATUSES, markWorkerCollected, WORKER_COLLECTION_METHODS, workerRecordFile, writePrivateText } from "../worker-state.mjs";
import { updateLifecycleWorkerRecord } from "./records.mjs";
import { FINAL_TEXT_MAX_BYTES, FINAL_TEXT_HEAD_BYTES, FINAL_TEXT_TAIL_BYTES, COLLECTOR_END_MARKER, COLLECTOR_TERMINAL_MARKER, COLLECTOR_OUTCOME_MARKER, TERMINAL_RUNTIME_TASK_STATUSES, ENGINE_JOB_ID_PATTERN, WRAPPER_API_DEATH_PATTERN, WRAPPER_API_DEATH_REASON } from "./constants.mjs";

function completedReport(record, message) {
  const normalized = message.trimEnd();
  if (record.completionContract === "collector" || canonicalWorkerAgentType(record.agentType) === "fusion:job-collector") {
    return COLLECTOR_END_MARKER.test(normalized);
  }
  if (record.completionContract === "transport" || PEER_JOB_FOOTER_AGENTS.has(record.agentType)) {
    return PEER_MANAGED_AGENTS.has(record.agentType) || peerJobIdFromCollectedResult(normalized) != null;
  }
  const lines = normalized.split(/\r?\n/);
  while (lines.length > 0 && /^(?:\s*|\s*(?:`{3,}|~{3,})\s*)$/.test(lines.at(-1))) {
    lines.pop();
  }
  if (lines.filter((line) => /^\s*(?:`{3,}|~{3,})/.test(line)).length % 2 !== 0) {
    return false;
  }
  const markers = new Set();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim().replace(/^\*+|\*+$/g, "").replace(/^`+|`+$/g, "").trim();
    if (/^delivery:[ \t]*complete$/i.test(line)) {
      markers.add("delivery");
    } else if (/^verification:[ \t]*passed(?:[ \t]+.*)?$/i.test(line)) {
      markers.add("verification");
    } else if (/^coverage:[ \t]*complete$/i.test(line)) {
      markers.add("coverage");
    } else {
      break;
    }
  }
  return markers.has("delivery") && markers.has(record.completionContract === "coverage" || canonicalWorkerAgentType(record.agentType) === "fusion:deep-reasoner" ? "coverage" : "verification");
}

function structuredCollectorReport(message) {
  const line = String(message ?? "").trimEnd().split(/\r?\n/).at(-1) ?? "";
  const terminal = line.match(COLLECTOR_TERMINAL_MARKER);
  if (terminal) {
    return {
      kind: "terminal",
      peerTransportStatus: terminal[1].toLowerCase(),
      peerSemanticStatus: terminal[2].toLowerCase(),
      peerEngine: terminal[3].toLowerCase(),
      peerJobId: terminal[4],
      elapsedSeconds: Number.parseInt(terminal[5], 10)
    };
  }
  const outcome = line.match(COLLECTOR_OUTCOME_MARKER);
  if (outcome) {
    return {
      kind: "outcome",
      collectionOutcome: outcome[1].toLowerCase().replace("-", "_"),
      peerEngine: outcome[2].toLowerCase(),
      peerJobId: outcome[3],
      elapsedSeconds: Number.parseInt(outcome[4], 10)
    };
  }
  return null;
}

function retryInstruction(record) {
  if (record.completionContract === "collector" || canonicalWorkerAgentType(record.agentType) === "fusion:job-collector") {
    return "Return the exact collector command output, including its terminal `collector:` marker. This is the only retry.";
  }
  if (record.completionContract === "transport" || PEER_JOB_FOOTER_AGENTS.has(record.agentType)) {
    return "The transport relay is incomplete. Return the companion output verbatim, including its `job:` and `state:` footer lines. This is the only retry.";
  }
  if (record.completionContract === "coverage" || canonicalWorkerAgentType(record.agentType) === "fusion:deep-reasoner") {
    return "The task is not deliverable yet. Complete the requested coverage check and return the actual result. End with `delivery: complete` plus `coverage: complete`. This is the only retry.";
  }
  return "The task is not deliverable yet. Complete the requested verification and return the actual result. End with `delivery: complete` plus `verification: passed`. This is the only retry.";
}

function noTaskFoundError(input, failed) {
  const response = input.tool_response;
  const isError = failed || response?.is_error === true || response?.isError === true || response?.status === "error" || typeof response?.error === "string";
  if (!isError) {
    return false;
  }
  const text = [input.error, response].flatMap((value) => {
    if (typeof value === "string") {
      return [value];
    }
    if (!value) {
      return [];
    }
    try {
      return [JSON.stringify(value)];
    } catch {
      return [];
    }
  }).join("\n");
  return /No task found/i.test(text);
}

function taskOutputTranscriptPaths(input, record) {
  const response = input.tool_response && typeof input.tool_response === "object" ? input.tool_response : {};
  const nested = response.toolUseResult && typeof response.toolUseResult === "object" ? response.toolUseResult : {};
  const runtimeId = typeof record.backgroundTaskId === "string" && record.backgroundTaskId
    ? record.backgroundTaskId
    : typeof record.agentId === "string" && record.agentId
      ? record.agentId
      : null;
  const direct = [
    input.agent_transcript_path,
    input.task_output_path,
    input.task_output_file,
    input.output_file,
    response.agentTranscriptPath,
    response.agent_transcript_path,
    response.transcriptPath,
    response.transcript_path,
    response.outputFile,
    nested.agentTranscriptPath,
    nested.agent_transcript_path,
    nested.transcriptPath,
    nested.transcript_path,
    nested.outputFile,
    record.transcriptPath
  ];
  const parents = [input.transcript_path, record.parentTranscriptPath]
    .filter((value) => typeof value === "string" && path.isAbsolute(value));
  if (runtimeId) {
    const safeRuntimeId = path.basename(runtimeId);
    for (const parent of parents) {
      direct.push(path.join(path.dirname(parent), "subagents", `agent-${safeRuntimeId}.jsonl`));
      direct.push(path.join(path.dirname(parent), "subagents", `${safeRuntimeId}.jsonl`));
      const sessionDirectory = path.join(path.dirname(parent), path.basename(parent, path.extname(parent)));
      direct.push(path.join(sessionDirectory, "subagents", `agent-${safeRuntimeId}.jsonl`));
      direct.push(path.join(sessionDirectory, "subagents", `${safeRuntimeId}.jsonl`));
    }
  }
  return [...new Set(direct.filter((value) => typeof value === "string" && path.isAbsolute(value) && path.extname(value) === ".jsonl").map((value) => path.resolve(value)))];
}

function collectedHarnessAsyncDelivery(record, transportStatus) {
  return record.runtimeAsync === true && record.failureKind === "unexpected_async" && transportStatus === "done";
}

function resultTextParts(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(resultTextParts);
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return ["text", "content", "output", "result", "toolUseResult", "file"].flatMap((key) => resultTextParts(value[key]));
}

function documentedTaskOutputText(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && value.type === "text" && typeof value.text === "string") {
    return value.text;
  }
  const content = Array.isArray(value) ? value : value?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content.flatMap((block) => block?.type === "text" && typeof block.text === "string" ? [block.text] : []);
  return text.length > 0 ? text.join("\n") : null;
}

function taskOutputResultText(input) {
  const text = documentedTaskOutputText(input.tool_response) ?? resultTextParts(input.tool_response).join("\n");
  if (!text) {
    return null;
  }
  const outputSections = [...text.matchAll(/<output>([\s\S]*?)<\/output>/gi)].map((match) => match[1]);
  return outputSections.length > 0 ? outputSections.join("\n") : text;
}

function absoluteOutputFile(value) {
  return typeof value === "string" && path.isAbsolute(value) ? path.resolve(value) : null;
}

function regularFileExists(file) {
  try {
    return typeof file === "string" && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function durableSubagentTranscript(record) {
  const transcriptPath = typeof record.transcriptPath === "string" && path.isAbsolute(record.transcriptPath) ? path.resolve(record.transcriptPath) : null;
  const parentTranscriptPath = typeof record.parentTranscriptPath === "string" && path.isAbsolute(record.parentTranscriptPath) ? path.resolve(record.parentTranscriptPath) : null;
  const agentId = typeof record.agentId === "string" && record.agentId ? path.basename(record.agentId) : null;
  if (!transcriptPath || !parentTranscriptPath || !agentId || path.basename(path.dirname(transcriptPath)) !== "tasks") {
    return transcriptPath;
  }
  const durablePath = path.join(path.dirname(parentTranscriptPath), "subagents", `agent-${agentId}.jsonl`);
  return regularFileExists(durablePath) ? durablePath : transcriptPath;
}

function withDurableCancellationTranscript(record) {
  if (record.transportStatus !== "cancelled") {
    return record;
  }
  const transcriptPath = durableSubagentTranscript(record);
  return transcriptPath && transcriptPath !== record.transcriptPath ? { ...record, transcriptPath } : record;
}

function withPeerFailureKind(record, env) {
  if (record.peerFailureKind != null || !isEngineId(record.peerEngine) || !ENGINE_JOB_ID_PATTERN.test(record.peerJobId ?? "")) {
    return record;
  }
  const peerFailureKind = readEngineJobFailureKind(record.peerEngine, record.peerJobId, env);
  return peerFailureKind == null ? record : { ...record, peerFailureKind };
}

function outputFileFromLaunchResponse(response, nested) {
  const direct = [response.outputFile, response.output_file, nested.outputFile, nested.output_file].map(absoluteOutputFile).find(Boolean);
  if (direct) {
    return direct;
  }
  for (const value of [response, nested]) {
    const text = taskOutputResultText({ tool_response: value });
    for (const line of String(text ?? "").split(/\r?\n/)) {
      const match = line.match(/^\s*output_file:\s*(.+?)\s*$/i);
      const outputFile = absoluteOutputFile(match?.[1]);
      if (outputFile) {
        return outputFile;
      }
    }
  }
  return null;
}

function finalTextArtifactPath(record, env) {
  return path.join(path.dirname(workerRecordFile(record.taskId, env)), `${record.taskId}.final.txt`);
}

function boundedFinalText(message) {
  const text = Buffer.from(message, "utf8");
  if (text.length <= FINAL_TEXT_MAX_BYTES) {
    return text;
  }
  const omitted = text.length - FINAL_TEXT_HEAD_BYTES - FINAL_TEXT_TAIL_BYTES;
  return Buffer.concat([
    text.subarray(0, FINAL_TEXT_HEAD_BYTES),
    Buffer.from(`\n[fusion: truncated ${omitted} bytes]\n`, "utf8"),
    text.subarray(text.length - FINAL_TEXT_TAIL_BYTES)
  ]);
}

function writeFinalTextArtifact(record, message, env) {
  const file = finalTextArtifactPath(record, env);
  writePrivateText(file, boundedFinalText(message));
  return file;
}

function peerJobIdsFromCollectedResult(text) {
  let peerJobId = null;
  const peerJobIds = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = line.match(/^(job|resumed-from): ([0-9a-f]{32})$/);
    if (match) {
      if (!peerJobIds.includes(match[2])) {
        peerJobIds.push(match[2]);
      }
      if (match[1] === "job") {
        peerJobId = match[2];
      }
    }
  }
  return { peerJobId, peerJobIds };
}

function peerJobIdFromCollectedResult(text) {
  return peerJobIdsFromCollectedResult(text).peerJobId;
}

function mergedPeerJobIds(record, ids) {
  return [...new Set([...(Array.isArray(record.peerJobIds) ? record.peerJobIds : []), record.peerJobId, ...ids].filter((id) => typeof id === "string" && ENGINE_JOB_ID_PATTERN.test(id)))];
}

function capturedPeerIdentity(agentType, text, peerEngine, record) {
  const { peerJobId, peerJobIds } = peerJobIdsFromCollectedResult(text);
  const derivedPeerEngine = engineForAgentType(agentType);
  return peerJobIds.length > 0
    ? {
        ...(peerJobId ? { peerJobId } : {}),
        peerJobIds: mergedPeerJobIds(record, peerJobIds),
        ...(peerEngine == null && derivedPeerEngine ? { peerEngine: derivedPeerEngine } : {})
      }
    : {};
}

function backfillCollectedTaskOutput(record, input) {
  for (const transcriptPath of taskOutputTranscriptPaths(input, record)) {
    const backfilled = backfillWorkerTaskOutputTelemetry(record, transcriptPath);
    if (backfilled !== record) {
      return backfilled;
    }
  }
  return record;
}

function settleQueuedVerdict(record, now, env) {
  const prepared = withPeerFailureKind(withDurableCancellationTranscript(record), env);
  const pendingVerdict = prepared.pendingVerdict;
  const settled = applyQueuedVerdict(prepared, now);
  if (!pendingVerdict || settled.pendingVerdict || settled.acceptanceRecordedAt == null) {
    return settled;
  }
  const previousJobIds = new Set((Array.isArray(settled.continuations) ? settled.continuations : []).flatMap((round) => Array.isArray(round.peerJobIds) ? round.peerJobIds : []));
  const peerJobIds = [...new Set([...(Array.isArray(settled.peerJobIds) ? settled.peerJobIds : []), settled.peerJobId].filter((id) => typeof id === "string" && ENGINE_JOB_ID_PATTERN.test(id) && !previousJobIds.has(id)))];
  const peerEngine = isEngineId(settled.peerEngine) ? settled.peerEngine : null;
  if (peerJobIds.length === 0 || !peerEngine) {
    return settled;
  }
  const errors = [];
  for (const jobId of peerJobIds) {
    try {
      const transport = engineAcceptanceTransport({ engine: peerEngine, jobId, acceptance: settled.acceptance, acceptFailedTransport: pendingVerdict.acceptFailedTransport === true, env });
      recordEngineAcceptance({
        engine: peerEngine,
        jobId,
        acceptance: settled.acceptance,
        source: pendingVerdict.source,
        reason: settled.acceptanceReason,
        failureKind: settled.acceptanceFailureKind ?? null,
        acceptFailedTransport: transport.acceptFailedTransport,
        workspaceRoot: typeof settled.workspaceRoot === "string" ? settled.workspaceRoot : process.cwd(),
        env
      });
    } catch (error) {
      errors.push(`${jobId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length === 0) {
    const { engineSettlementError: _engineSettlementError, ...withoutEngineSettlementError } = settled;
    return withoutEngineSettlementError;
  }
  return { ...settled, engineSettlementError: errors.join("; ") };
}

function wrapperApiDeathEvidence(record, evidence) {
  const texts = [evidence, record.notificationSummary, record.statusDetail, record.finalText].filter((value) => typeof value === "string");
  const finalText = texts.join("\n");
  return PEER_RESCUE_AGENT_NAMES.has(record.agentType)
    && !record.peerJobId
    && !/^job: [0-9a-f]{32}\r?$/m.test(finalText)
    && WRAPPER_API_DEATH_PATTERN.test(finalText);
}

function settleWrapperApiDeath(record, evidence, now, env) {
  if (!wrapperApiDeathEvidence(record, evidence)) {
    return record;
  }
  return settleQueuedVerdict({
    ...record,
    transportStatus: "failed",
    failureKind: "delivery",
    infraFailure: true,
    pendingVerdict: {
      acceptance: "rejected",
      source: "lifecycle",
      reason: WRAPPER_API_DEATH_REASON,
      failureKind: null,
      queuedAt: now
    },
    finishedAt: record.finishedAt ?? now,
    lastActivityAt: now
  }, now, env);
}

function isAutoSettledWrapperApiDeath(record) {
  return record?.acceptance === "rejected" && record.acceptanceSource === "lifecycle" && record.acceptanceReason === WRAPPER_API_DEATH_REASON;
}

function statusEvidence(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  return [value.notificationSummary, value.notification_summary, value.summary, value.statusDetail, value.status_detail, value.detail, value.error]
    .filter((part) => typeof part === "string")
    .join("\n");
}

function settleReapedWorker(current, now, env) {
  return settleQueuedVerdict({
    ...markWorkerCollected(current, WORKER_COLLECTION_METHODS.TASK_REAPED, now),
    transportStatus: "failed",
    failureKind: "task_reaped",
    finishedAt: now,
    lastActivityAt: now
  }, now, env);
}

function settleReapedIfActive(taskId, now, env, extraGuard) {
  let settled = false;
  updateLifecycleWorkerRecord(taskId, env, (current) => {
    if (!current || WORKER_TERMINAL_STATUSES.has(current.transportStatus) || !extraGuard(current)) {
      return null;
    }
    settled = true;
    return settleReapedWorker(current, now, env);
  });
  return settled;
}

function runtimeTaskIsTerminal(task) {
  return typeof task?.status === "string" && TERMINAL_RUNTIME_TASK_STATUSES.has(task.status.trim().toLowerCase());
}

function terminalTransportObserved(record, task) {
  return WORKER_TERMINAL_STATUSES.has(record.transportStatus)
    || ["ready_uncollected", "ready_background"].includes(record.transportStatus)
    || runtimeTaskIsTerminal(task);
}

function terminalCollectionPending(record) {
  return ["ready_uncollected", "ready_background"].includes(record.transportStatus)
    || (record.runtimeAsync === true && WORKER_TERMINAL_STATUSES.has(record.transportStatus) && !record.collectedAt && !isAutoSettledWrapperApiDeath(record));
}

function terminalCollectedRecord(record) {
  return Boolean(record) && WORKER_TERMINAL_STATUSES.has(record.transportStatus) && Boolean(record.collectedAt) && (isSettledWorker(record) || record.awaitingVerdict === true || record.acceptance === "unverified");
}

function peerIdentityBackfill(record, identity, env) {
  const additions = Object.fromEntries(Object.entries(identity).filter(([key, value]) => key !== "peerJobIds" && value != null && record[key] == null));
  if (identity.peerJobIds?.length > 0) {
    const peerJobIds = mergedPeerJobIds(record, identity.peerJobIds);
    if (peerJobIds.some((id, index) => id !== record.peerJobIds?.[index]) || peerJobIds.length !== record.peerJobIds?.length) {
      additions.peerJobIds = peerJobIds;
    }
  }
  if (Object.keys(additions).length === 0) {
    return null;
  }
  return withPeerFailureKind({ ...record, ...additions }, env);
}


export { completedReport, structuredCollectorReport, retryInstruction, noTaskFoundError, taskOutputTranscriptPaths, collectedHarnessAsyncDelivery, resultTextParts, documentedTaskOutputText, taskOutputResultText, absoluteOutputFile, regularFileExists, durableSubagentTranscript, withDurableCancellationTranscript, withPeerFailureKind, outputFileFromLaunchResponse, finalTextArtifactPath, boundedFinalText, writeFinalTextArtifact, peerJobIdsFromCollectedResult, peerJobIdFromCollectedResult, mergedPeerJobIds, capturedPeerIdentity, backfillCollectedTaskOutput, settleQueuedVerdict, wrapperApiDeathEvidence, settleWrapperApiDeath, isAutoSettledWrapperApiDeath, statusEvidence, settleReapedWorker, settleReapedIfActive, runtimeTaskIsTerminal, terminalTransportObserved, terminalCollectionPending, terminalCollectedRecord, peerIdentityBackfill };
