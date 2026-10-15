import path from "node:path";
import { PEER_JOB_FOOTER_AGENTS } from "../engines.mjs";
import { tagMessage } from "../user-messages.mjs";
import { canonicalWorkerAgentType, isFusionWorkerAgent, isTerminalWorkerStatus, markWorkerCollected, WORKER_COLLECTION_METHODS } from "../worker-state.mjs";
import { workerBudgetFailure } from "./budget.mjs";
import { capturedPeerIdentity, completedReport, finalTextArtifactPath, mergedPeerJobIds, peerIdentityBackfill, retryInstruction, settleQueuedVerdict, settleWrapperApiDeath, statusEvidence, structuredCollectorReport, terminalCollectedRecord, wrapperApiDeathEvidence, writeFinalTextArtifact } from "./collection.mjs";
import { blockStop, hookOutput, writeOutput } from "./output.mjs";
import { pendingDispatchForStart, recordForAgent, refreshRecord, updateLifecycleWorkerRecord } from "./records.mjs";
import { EXECUTION_AGENTS, PEER_WRAPPER_AGENTS } from "./constants.mjs";

function handleSubagentStart(input, env) {
  if (!isFusionWorkerAgent(input.agent_type)) {
    return;
  }
  const pending = recordForAgent(input, env) ?? pendingDispatchForStart(input, env);
  if (!pending) {
    return;
  }
  const now = new Date().toISOString();
  let started = false;
  const record = updateLifecycleWorkerRecord(pending.taskId, env, (current) => {
    if (!current || isTerminalWorkerStatus(current.transportStatus)) {
      return null;
    }
    started = true;
    return {
      ...current,
      agentId: input.agent_id,
      transportStatus: "running",
      startedAt: current.startedAt ?? now,
      lastActivityAt: now,
      lastProgressAt: now
    };
  });
  if (!started) {
    return;
  }
  const limits = record.limits;
  const verdictEnvelope = "Keep the final message to a compact verdict envelope that states changed file paths without diffs, the verification command with pass and fail counts, any environment findings, and the path of a file holding the full report when one is written. Write long unified diffs, full test logs, and long quoted file contents to that file instead of inlining them.";
  const delivery = record.completionContract === "collector"
    ? "Return the collector command output exactly, including its terminal `collector:` marker."
    : record.completionContract === "coverage"
      ? `End the completed analysis with separate lines \`delivery: complete\` and \`coverage: complete\`. ${verdictEnvelope}`
      : `End a successful execution report with separate lines \`delivery: complete\` and \`verification: passed\`. ${verdictEnvelope}`;
  const artifactFirst = EXECUTION_AGENTS.has(canonicalWorkerAgentType(record.agentType))
    ? " Write your deliverable artifact to a file early, before deep work, and keep updating it; your final message names its path, and a budget death must still leave a readable artifact."
    : "";
  writeOutput(hookOutput("SubagentStart", tagMessage("worker-lifecycle.subagent-start-context", `Fusion task id: ${record.taskId}. Work only from the supplied isolated brief. Do not request or reconstruct the parent transcript. Budgets: ${limits.wallClockMs}ms wall clock, ${limits.stallMs}ms without successful tool activity, ${limits.maxTurns} turns, ${limits.maxOutputTokens} output tokens, ${limits.maxUncachedTokens} uncached tokens. Retry at most once. At 85 percent of the output or uncached token budget, stop making tool calls and write the final deliverable; after the token limit, exactly one final Write of the deliverable is permitted.${artifactFirst} ${delivery}`)));
}

function handleSubagentStop(input, env) {
  if (!isFusionWorkerAgent(input.agent_type) && !PEER_JOB_FOOTER_AGENTS.has(input.agent_type)) {
    return;
  }
  const record = recordForAgent(input, env);
  if (!record) {
    return;
  }
  const refreshed = refreshRecord(record, input, env);
  const message = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
  const footerMissing = PEER_WRAPPER_AGENTS.has(refreshed.agentType) && !message.split(/\r?\n/).filter((line) => line.trim()).slice(-15).some((line) => /^\s*state:\s*\S+/i.test(line));
  if (footerMissing) {
    updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => current ? { ...current, relayFooterMissing: true } : null);
  }
  if (terminalCollectedRecord(refreshed)) {
    const peerIdentity = PEER_JOB_FOOTER_AGENTS.has(refreshed.agentType) ? capturedPeerIdentity(refreshed.agentType, message, refreshed.peerEngine, refreshed) : {};
    updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => current && terminalCollectedRecord(current) ? peerIdentityBackfill(current, peerIdentity, env) : null);
    return;
  }
  const failure = workerBudgetFailure(refreshed);
  let finalTextFile = isFusionWorkerAgent(refreshed.agentType) && message.length > 0 ? finalTextArtifactPath(refreshed, env) : null;
  if (finalTextFile) {
    try {
      finalTextFile = writeFinalTextArtifact(refreshed, message, env);
      updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => ({ ...(current ?? refreshed), outputFile: finalTextFile }));
    } catch {
      finalTextFile = null;
    }
  }
  if (wrapperApiDeathEvidence(refreshed, [message, statusEvidence(input)].join("\n"))) {
    const now = new Date().toISOString();
    updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => current && !isTerminalWorkerStatus(current.transportStatus)
      ? settleWrapperApiDeath(current, [message, statusEvidence(input)].join("\n"), now, env)
      : null);
    return;
  }
  const complete = completedReport(refreshed, message);
  const collectorContract = refreshed.completionContract === "collector" || canonicalWorkerAgentType(refreshed.agentType) === "fusion:job-collector";
  const collectorReport = collectorContract ? structuredCollectorReport(message) : null;
  const collectorIdentityMismatch = collectorContract && collectorReport && (collectorReport.peerEngine !== refreshed.expectedPeerEngine || collectorReport.peerJobId !== refreshed.expectedPeerJobId);
  const trustedCollectorReport = collectorIdentityMismatch ? null : collectorReport;
  const collectorProtocolFailure = (collectorContract && complete && !collectorReport) || collectorIdentityMismatch;
  if (collectorProtocolFailure && !failure && (refreshed.retryCount ?? 0) < 1 && !input.stop_hook_active) {
    updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => ({ ...current, retryCount: (current.retryCount ?? 0) + 1 }));
    const expected = refreshed.expectedPeerEngine && refreshed.expectedPeerJobId
      ? ` Repeat collection for exactly engine=${refreshed.expectedPeerEngine} job=${refreshed.expectedPeerJobId}.`
      : "";
    writeOutput(blockStop(tagMessage("worker-lifecycle.collector-marker-block", `The collector returned an invalid or mismatched terminal marker.${expected} Return the exact collector command output with its terminal marker. This is the only retry.`)));
    return;
  }
  if (!complete && !failure && (refreshed.retryCount ?? 0) < 1 && !input.stop_hook_active) {
    updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => ({ ...current, retryCount: (current.retryCount ?? 0) + 1 }));
    writeOutput(blockStop(tagMessage("worker-lifecycle.deliverable-retry-block", retryInstruction(refreshed))));
    return;
  }
  const now = new Date().toISOString();
  updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => {
    if (!current) {
      return null;
    }
    const worker = current;
    const peerIdentity = PEER_JOB_FOOTER_AGENTS.has(worker.agentType) ? capturedPeerIdentity(worker.agentType, message, worker.peerEngine, worker) : {};
    if (terminalCollectedRecord(worker)) {
      return peerIdentityBackfill(worker, peerIdentity, env);
    }
    const runtimeAsync = worker.runtimeAsync === true;
    const successfulCompletion = complete && !failure && trustedCollectorReport?.kind !== "outcome" && !collectorProtocolFailure;
    const subagentStopCollected = successfulCompletion && finalTextFile != null && !collectorContract;
    return settleQueuedVerdict({
      ...(runtimeAsync && !subagentStopCollected ? worker : markWorkerCollected(worker, WORKER_COLLECTION_METHODS.SUBAGENT_STOP, now)),
      transportStatus: complete && (trustedCollectorReport?.kind === "outcome" || collectorProtocolFailure) ? "incomplete" : complete ? runtimeAsync && !subagentStopCollected ? "ready_uncollected" : "done" : failure ? "failed" : "incomplete",
      failureKind: failure?.failureKind ?? (trustedCollectorReport?.kind === "outcome" ? `collection_${trustedCollectorReport.collectionOutcome}` : collectorProtocolFailure ? "collection_protocol" : complete ? null : "delivery"),
      ...(failure ? { limitKind: failure.limitKind, cancelReason: failure.reason } : {}),
      inFlightSince: undefined,
      ...(successfulCompletion && worker.failureKind && worker.failureKind !== "unexpected_async" ? { recoveredFailureKind: worker.failureKind } : {}),
      ...(complete && !failure && !collectorProtocolFailure && runtimeAsync && worker.failureKind === "unexpected_async" ? { deliveryMode: "harness_async" } : {}),
      ...(finalTextFile ? { outputFile: finalTextFile } : {}),
      ...peerIdentity,
      ...(trustedCollectorReport?.peerEngine ? { peerEngine: trustedCollectorReport.peerEngine } : {}),
      ...(trustedCollectorReport?.peerJobId ? { peerJobId: trustedCollectorReport.peerJobId, peerJobIds: mergedPeerJobIds(worker, [...(peerIdentity.peerJobIds ?? []), trustedCollectorReport.peerJobId]) } : {}),
      ...(trustedCollectorReport?.peerTransportStatus ? { peerTransportStatus: trustedCollectorReport.peerTransportStatus } : {}),
      ...(trustedCollectorReport?.peerSemanticStatus ? { peerSemanticStatus: trustedCollectorReport.peerSemanticStatus } : {}),
      ...(trustedCollectorReport?.collectionOutcome ? { collectionOutcome: trustedCollectorReport.collectionOutcome } : {}),
      ...(Number.isSafeInteger(trustedCollectorReport?.elapsedSeconds) ? { collectionElapsedSeconds: trustedCollectorReport.elapsedSeconds } : {}),
      finishedAt: now,
      lastActivityAt: now
    }, now, env);
  });
}


export { handleSubagentStart, handleSubagentStop };
