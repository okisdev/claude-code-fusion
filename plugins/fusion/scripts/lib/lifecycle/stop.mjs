import { engineResultCommand, isEngineId } from "../engines.mjs";
import { tagMessage } from "../user-messages.mjs";
import { canonicalWorkerAgentType, isPendingSettlement, isSettledWorker, isTerminalWorkerStatus, readWorkerRecord, readSessionWorkerRecords, updateWorkerSessionState } from "../worker-state.mjs";
import { workerBudgetFailure } from "./budget.mjs";
import { isAutoSettledWrapperApiDeath, regularFileExists, runtimeTaskIsTerminal, settleQueuedVerdict, settleReapedIfActive, settleWrapperApiDeath, statusEvidence, terminalCollectedRecord, terminalCollectionPending, terminalTransportObserved, wrapperApiDeathEvidence, writeFinalTextArtifact } from "./collection.mjs";
import { finalAssistantTextFromTranscript, reconcileTaskNotifications } from "./notifications.mjs";
import { blockStop, hookOutput, writeOutput } from "./output.mjs";
import { activeSessionRecords, sessionRecords, updateLifecycleWorkerRecord } from "./records.mjs";
import { SETTLE_DEMAND_STALE_MS_ENV, DEFAULT_SETTLE_DEMAND_STALE_MS, FAILED_TASK_NOTIFICATION_STATUSES } from "./constants.mjs";

function stopGateLifecycle(records) {
  return JSON.stringify(records.map((record) => {
    const { updatedAt, stopBlockCount, failureStopBlockCount, awaitingCollection, awaitingCollectionArmedAt, ...lifecycle } = record;
    return lifecycle;
  }).sort((left, right) => left.taskId.localeCompare(right.taskId)));
}

function writeStopGateBlock(input, env, code, message, pendingRecords) {
  const ids = taskSetSignature(pendingRecords);
  const signature = `${code}:${ids}`;
  const lifecycle = stopGateLifecycle(sessionRecords(input.session_id, env));
  let released = false;
  let newlyReleased = false;
  updateWorkerSessionState(input.session_id, env, (current) => {
    const prior = current?.stopGate;
    const same = prior?.signature === signature && prior.lifecycle === lifecycle;
    const count = same ? prior.count + 1 : 1;
    released = count >= 3;
    newlyReleased = released && !(same && prior.released);
    const at = new Date().toISOString();
    return {
      ...(current ?? {}),
      stopGate: { signature, lifecycle, count, released },
      ...(newlyReleased ? { events: [...(current?.events ?? []), { type: "stop-gate-released", at, code, taskIds: ids ? ids.split(",") : [] }] } : {})
    };
  });
  if (newlyReleased) {
    writeOutput(hookOutput("Stop", tagMessage(code, `Fusion Stop gate released after repeated blocks. Still pending: ${ids || "unknown Fusion tasks"}.`)));
  } else if (!released) {
    writeOutput(blockStop(tagMessage(code, message)));
  }
}

function clearStopGate(sessionId, env) {
  updateWorkerSessionState(sessionId, env, (current) => {
    if (!current?.stopGate) {
      return null;
    }
    const { stopGate, ...rest } = current;
    return rest;
  });
}

function runtimeTaskForRecord(record, tasks) {
  const runtimeIds = [record.backgroundTaskId, record.agentId].filter(Boolean);
  return tasks.find((task) => runtimeIds.includes(task?.id))
    ?? (!record.backgroundTaskId && !record.agentId
      ? tasks.find((task) => task?.type === "subagent" && canonicalWorkerAgentType(task.agent_type) === canonicalWorkerAgentType(record.agentType))
      : null);
}

function runtimeTaskSucceeded(task) {
  return typeof task?.status === "string" && ["completed", "complete", "done"].includes(task.status.trim().toLowerCase());
}

function runtimeTaskFailed(task) {
  return typeof task?.status === "string" && FAILED_TASK_NOTIFICATION_STATUSES.has(task.status.trim().toLowerCase());
}

function armInFlightRecords(records, tasks, env) {
  const inFlight = records.filter((record) => !terminalTransportObserved(record, runtimeTaskForRecord(record, tasks)));
  const armedAt = new Date().toISOString();
  const armed = [];
  for (const record of inFlight) {
    const updated = updateLifecycleWorkerRecord(record.taskId, env, (current) => {
      if (!current || terminalTransportObserved(current, runtimeTaskForRecord(current, tasks))) {
        return null;
      }
      return {
        ...current,
        awaitingCollection: true,
        awaitingCollectionArmedAt: current.awaitingCollectionArmedAt ?? armedAt
      };
    });
    if (updated && !terminalTransportObserved(updated, runtimeTaskForRecord(updated, tasks))) {
      armed.push(updated);
    }
  }
  return armed;
}

function unjudgedPeerCollections(sessionId, env) {
  return readSessionWorkerRecords(env, sessionId, { strict: true }).filter((record) => record.completionContract === "collector" && record.peerJobId && record.peerTransportStatus && !isSettledWorker(record));
}

function unreportedCollectorFailures(sessionId, env) {
  return readSessionWorkerRecords(env, sessionId, { strict: true }).filter((record) => isTerminalWorkerStatus(record.transportStatus) && record.completionContract === "collector" && record.failureKind && !record.failureReportedAt);
}

function collectorResultCommand(record) {
  const engine = record.peerEngine ?? record.expectedPeerEngine;
  const jobId = record.peerJobId ?? record.expectedPeerJobId;
  return isEngineId(engine) && /^[a-f0-9]{32}$/.test(jobId ?? "") ? engineResultCommand(engine, jobId) : null;
}

function settlementCommand(records) {
  return `/fusion:stats --record ${records.map((record) => `${record.taskId}=accepted|rejected|unverified`).join(" --record ")}`;
}

function collectorStopGate(input, env) {
  const finalMessage = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
  const collectorFailures = unreportedCollectorFailures(input.session_id, env);
  const missingFailureReports = [];
  for (const record of collectorFailures) {
    const jobId = record.peerJobId ?? record.expectedPeerJobId;
    const resultCommand = collectorResultCommand(record);
    const acknowledged = finalMessage.includes(record.taskId) && (!jobId || finalMessage.includes(jobId)) && /\buncollected\b/i.test(finalMessage) && (!resultCommand || finalMessage.includes(resultCommand));
    if (acknowledged) {
      const reportedAt = new Date().toISOString();
      updateLifecycleWorkerRecord(record.taskId, env, (current) => ({
        ...current,
        failureReportedAt: reportedAt,
        ...(current.failureKind === "collection_protocol" ? { protocolReportedAt: reportedAt } : {})
      }));
    } else {
      updateLifecycleWorkerRecord(record.taskId, env, (current) => ({ ...current, failureStopBlockCount: (current.failureStopBlockCount ?? 0) + 1 }));
      missingFailureReports.push(record);
    }
  }
  if (missingFailureReports.length > 0) {
    const commands = missingFailureReports.map(collectorResultCommand).filter(Boolean);
    const commandInstruction = commands.length > 0 ? ` Include ${commands.join(" or ")}.` : "";
    writeStopGateBlock(input, env, "worker-lifecycle.collector-reporting-block", `Collector failure reporting is incomplete for ${missingFailureReports.map((record) => {
      const engine = record.peerEngine ?? record.expectedPeerEngine;
      const jobId = record.peerJobId ?? record.expectedPeerJobId;
      const identity = engine && jobId ? `${engine}:${jobId}` : jobId ? `job=${jobId}` : "peer identity unavailable";
      return `${record.taskId} (${record.failureKind}, ${identity})`;
    }).join(", ")}. Report each Fusion task id and every available peer job id, and state explicitly that the peer result remains uncollected.${commandInstruction}`, missingFailureReports);
    return true;
  }
  const unjudged = unjudgedPeerCollections(input.session_id, env);
  if (unjudged.length > 0) {
    const settlementRecords = unjudged.filter((record) => isEngineId(record.peerEngine));
    const manualRecords = unjudged.filter((record) => !isEngineId(record.peerEngine));
    const instructions = [
      settlementRecords.length > 0 ? `record the judgments in one command: ${settlementCommand(settlementRecords)}` : null,
      ...manualRecords.map((record) => `complete a manual resolution because the collection for Fusion task ${record.taskId} needs manual resolution`)
    ].filter(Boolean);
    writeStopGateBlock(input, env, "worker-lifecycle.semantic-judgment-block", `Collected peer transport results still require an explicit semantic judgment before finishing: ${unjudged.map((record) => `${record.peerEngine}:${record.peerJobId} (task=${record.taskId}, transport=${record.peerTransportStatus}, semantic=${record.peerSemanticStatus ?? "unverified"})`).join(", ")}. After checking the requested completion criteria, ${instructions.join("; ")}.`, unjudged);
    return true;
  }
  return false;
}

function writeAcceptanceAdvisory(records, env) {
  const unverified = settleOnlyRecords(rereadPendingRecords(records, isPendingSettlement, env));
  if (unverified.length === 0) {
    return;
  }
  const workers = unverified.map((record) => `${record.taskId} (${[record.agentType, record.description].filter((value) => typeof value === "string" && value.trim()).join(", ")})`);
  writeOutput(hookOutput("Stop", tagMessage("worker-lifecycle.acceptance-advisory", `Acceptance remains unverified for ${unverified.length} collected Fusion worker${unverified.length === 1 ? "" : "s"}: ${workers.join("; ")}. Settle the pending wave in one command: ${settlementCommand(unverified)}. pairs are <id>=<verdict> with id either a fusion task id (fusion- plus 24 lowercase hex) or an engine job id (32 lowercase hex), verdict one of accepted|rejected|unverified.`)));
}

function terminalCollectionInstruction(record, env) {
  const collectId = record.backgroundTaskId ?? record.agentId;
  const identity = [record.agentType, record.description].filter((value) => typeof value === "string" && value.trim()).join(", ");
  const worker = `${record.taskId}${identity ? ` (${identity})` : ""}`;
  let finalTextFile = regularFileExists(record.outputFile) ? record.outputFile : null;
  if (!finalTextFile) {
    const finalText = finalAssistantTextFromTranscript(record.transcriptPath);
    if (finalText) {
      try {
        finalTextFile = writeFinalTextArtifact(record, finalText, env);
        updateLifecycleWorkerRecord(record.taskId, env, (current) => current && terminalCollectionPending(current) ? { ...current, outputFile: finalTextFile } : null);
      } catch {
        finalTextFile = null;
      }
    }
  }
  return finalTextFile
    ? `Call Read with file_path=${finalTextFile} to collect the terminal output for Fusion task ${worker} before finishing.`
    : collectId ? `Call TaskOutput with block=true for terminal owned task ${collectId} and collect Fusion task ${worker} before finishing.` : `Collect terminal owned task ${worker} before finishing.`;
}

function settleOnlyRecords(records) {
  return records.filter(isPendingSettlement);
}

function rereadPendingRecords(records, predicate, env) {
  return records.map((record) => readWorkerRecord(record.taskId, env)).filter((record) => record && predicate(record));
}

function settleDemandStaleMs(env) {
  const raw = env[SETTLE_DEMAND_STALE_MS_ENV];
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
    return DEFAULT_SETTLE_DEMAND_STALE_MS;
  }
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_SETTLE_DEMAND_STALE_MS;
}

function hasStaleSettlement(records, env, now = Date.now()) {
  const oldestCollectedAt = Math.min(...records.map((record) => Date.parse(record.collectedAt ?? "")).filter(Number.isFinite));
  return Number.isFinite(oldestCollectedAt) && now - oldestCollectedAt > settleDemandStaleMs(env);
}

function writeSettlementDemand(input, records, env) {
  const current = rereadPendingRecords(records, isPendingSettlement, env);
  if (current.length === 0) {
    return false;
  }
  writeStopGateBlock(input, env, "worker-lifecycle.acceptance-required-block", `Collected Fusion worker results still require explicit acceptance before finishing. Settle the pending wave in one command: ${settlementCommand(current)}.`, current);
  return true;
}

function writeTerminalCollectionPending(input, records, env) {
  const terminalUncollected = rereadPendingRecords(records, terminalCollectionPending, env);
  if (terminalUncollected.length === 0) {
    return false;
  }
  const instructions = terminalUncollected.map((record) => terminalCollectionInstruction(record, env));
  instructions.push(
    "Transport completion remains unverified until the result and verification evidence are reviewed. Record accepted or rejected explicitly through /fusion:stats."
  );
  writeStopGateBlock(input, env, "worker-lifecycle.terminal-collection-block", instructions.join(" "), terminalUncollected);
  return true;
}

function taskSetSignature(records) {
  return records.map((record) => record.taskId).sort().join(",");
}

function reverifyInFlightRecords(records, tasks, env = process.env) {
  return records
    .map((record) => readWorkerRecord(record.taskId, env))
    .filter((record) => record && !terminalCollectedRecord(record) && !terminalTransportObserved(record, runtimeTaskForRecord(record, tasks)));
}

function runtimeTaskMissing(record, hasBackgroundTasks, tasks) {
  return hasBackgroundTasks ? !runtimeTaskForRecord(record, tasks) : (record.cancelAttemptCount ?? 0) >= 2;
}

function needsCancellation(record) {
  return record.transportStatus === "cancel_requested" || (!record.userBackgroundAuthorized && !["ready_uncollected", "ready_background"].includes(record.transportStatus) && (record.stopBlockCount ?? 0) >= 6);
}

function reverifyCancellationRecords(records, env = process.env) {
  return records
    .map((record) => readWorkerRecord(record.taskId, env))
    .filter((record) => record && !terminalCollectedRecord(record) && needsCancellation(record));
}

function claimStopAdvisory(sessionId, kind, signature, env) {
  let claimed = false;
  updateWorkerSessionState(sessionId, env, (current) => {
    if (current?.stopAdvisorySignatures?.[kind] === signature) {
      return null;
    }
    claimed = true;
    return {
      ...(current ?? {}),
      stopAdvisorySignatures: { ...(current?.stopAdvisorySignatures ?? {}), [kind]: signature }
    };
  });
  return claimed;
}

function claimSettleOnlyAdvisory(sessionId, signature, env) {
  let claimed = false;
  updateWorkerSessionState(sessionId, env, (current) => {
    if (current?.settleOnlyAdvisorySignature === signature) {
      return null;
    }
    claimed = true;
    return { ...(current ?? {}), settleOnlyAdvisorySignature: signature };
  });
  return claimed;
}

function clearSettleOnlyAdvisory(sessionId, env) {
  updateWorkerSessionState(sessionId, env, (current) => {
    if (!current || !("settleOnlyAdvisorySignature" in current)) {
      return null;
    }
    const { settleOnlyAdvisorySignature, ...next } = current;
    return next;
  });
}

function writeWrapperApiDeathRedispatchAdvisory(sessionId, env) {
  const records = sessionRecords(sessionId, env).filter((record) => isAutoSettledWrapperApiDeath(record) && typeof record.briefFile === "string" && !record.redispatchAdvisoryAt);
  if (records.length === 0) {
    return false;
  }
  const advisedAt = new Date().toISOString();
  const advised = [];
  for (const record of records) {
    const updated = updateLifecycleWorkerRecord(record.taskId, env, (current) => current && isAutoSettledWrapperApiDeath(current) && !current.redispatchAdvisoryAt
      ? { ...current, redispatchAdvisoryAt: advisedAt }
      : null);
    if (updated?.redispatchAdvisoryAt === advisedAt) {
      advised.push(updated);
    }
  }
  if (advised.length === 0) {
    return false;
  }
  writeOutput(hookOutput("Stop", tagMessage("worker-lifecycle.wrapper-death-context", `Fusion wrapper API death: redispatch ${advised.map((record) => `${record.taskId} from ${record.briefFile}`).join("; ")}.`)));
  return true;
}

function handleStop(input, env) {
  const hasBackgroundTasks = Array.isArray(input.background_tasks);
  const tasks = hasBackgroundTasks ? input.background_tasks : [];
  reconcileTaskNotifications(input, env);
  const initialRecords = sessionRecords(input.session_id, env);
  if (initialRecords.every((record) => !terminalCollectionPending(record)) && collectorStopGate(input, env)) {
    armInFlightRecords(initialRecords, tasks, env);
    return;
  }
  const pending = [];
  for (const record of activeSessionRecords(input.session_id, env)) {
    const task = runtimeTaskForRecord(record, tasks);
    const observedTerminal = terminalTransportObserved(record, task);
    const failure = observedTerminal ? null : workerBudgetFailure(record);
    const now = new Date().toISOString();
    const updated = updateLifecycleWorkerRecord(record.taskId, env, (current) => {
      if (!current || isTerminalWorkerStatus(current.transportStatus)) {
        return null;
      }
      const worker = current;
      const wrapperApiDeath = runtimeTaskFailed(task) && wrapperApiDeathEvidence(worker, statusEvidence(task));
      const transportStatus = wrapperApiDeath ? "failed" : failure ? "cancel_requested" : runtimeTaskIsTerminal(task) ? "ready_uncollected" : ["ready_uncollected", "ready_background", "cancel_requested"].includes(worker.transportStatus) ? worker.transportStatus : "pending_async";
      const advisoryRound = !failure && transportStatus === "pending_async";
      const successfulTerminal = !failure && worker.failureKind !== "unexpected_async" && runtimeTaskSucceeded(task);
      const transitioned = {
        ...worker,
        ...(task?.id ? { backgroundTaskId: task.id } : {}),
        transportStatus,
        failureKind: wrapperApiDeath ? "delivery" : failure?.failureKind ?? (successfulTerminal ? null : worker.failureKind),
        ...(failure ? { limitKind: failure.limitKind } : {}),
        ...(successfulTerminal && worker.failureKind ? { recoveredFailureKind: worker.failureKind } : {}),
        cancelReason: failure?.reason ?? worker.cancelReason,
        stopBlockCount: advisoryRound ? worker.stopBlockCount ?? 0 : (worker.stopBlockCount ?? 0) + 1,
        ...(wrapperApiDeath ? { finishedAt: worker.finishedAt ?? now, lastActivityAt: now } : {})
      };
      return wrapperApiDeath ? settleWrapperApiDeath(transitioned, statusEvidence(task), now, env) : transitioned;
    });
    pending.push(updated);
  }
  const cancellations = pending.filter(needsCancellation);
  const verifiedCancellations = reverifyCancellationRecords(cancellations, env);
  if (verifiedCancellations.length > 0) {
    const now = new Date().toISOString();
    const missingRuntimeIds = verifiedCancellations.filter((record) => !record.backgroundTaskId && !record.agentId);
    for (const record of missingRuntimeIds) {
      updateLifecycleWorkerRecord(record.taskId, env, (current) => {
        if (!current || isTerminalWorkerStatus(current.transportStatus)) {
          return null;
        }
        return settleQueuedVerdict({ ...current, transportStatus: "failed", failureKind: current.failureKind ?? "owner_lost", finishedAt: now }, now, env);
      });
    }
    const reapedTaskIds = [];
    for (const record of verifiedCancellations.filter((candidate) => candidate.backgroundTaskId || candidate.agentId)) {
      if (!runtimeTaskMissing(record, hasBackgroundTasks, tasks)) {
        continue;
      }
      const settled = settleReapedIfActive(record.taskId, now, env, () => true);
      if (settled) {
        reapedTaskIds.push(record.taskId);
      }
    }
    const reapedSentence = reapedTaskIds.length > 0 ? `Fusion task IDs ${reapedTaskIds.join(", ")} were settled as task_reaped because the harness no longer tracks their runtime tasks.` : "";
    const reapedSuffix = reapedSentence ? ` ${reapedSentence}` : "";
    const cancelIds = verifiedCancellations.filter((record) => !reapedTaskIds.includes(record.taskId)).map((record) => record.backgroundTaskId ?? record.agentId).filter(Boolean);
    if (cancelIds.length > 0) {
      writeStopGateBlock(input, env, "worker-lifecycle.over-budget-stop-block", `Call TaskStop for over-budget task${cancelIds.length === 1 ? "" : "s"} ${cancelIds.join(", ")} and report the cancellation before finishing.${reapedSuffix} TaskStop is a deferred tool; load it with ToolSearch (select:TaskStop) first if it is not available.`, verifiedCancellations.filter((record) => !reapedTaskIds.includes(record.taskId)));
      return;
    }
    if (missingRuntimeIds.length > 0) {
      writeStopGateBlock(input, env, "worker-lifecycle.pre-runtime-failure-block", `Fusion task${missingRuntimeIds.length === 1 ? "" : "s"} ${missingRuntimeIds.map((record) => record.taskId).join(", ")} failed before a runtime task id was available. Report the failure before finishing.${reapedSuffix}`, missingRuntimeIds);
      return;
    }
    if (reapedSentence) {
      clearStopGate(input.session_id, env);
      writeOutput(hookOutput("Stop", tagMessage("worker-lifecycle.task-reaped-context", reapedSentence)));
      return;
    }
  }
  const currentRecords = sessionRecords(input.session_id, env);
  const inFlight = armInFlightRecords(currentRecords, tasks, env);
  const terminalUncollected = currentRecords.filter(terminalCollectionPending);
  const settleOnly = settleOnlyRecords(currentRecords);
  const settleOnlySignature = settleOnly.length > 0 ? taskSetSignature(settleOnly) : null;
  if (!settleOnlySignature) {
    clearSettleOnlyAdvisory(input.session_id, env);
  }
  if (terminalUncollected.length > 0) {
    writeTerminalCollectionPending(input, terminalUncollected, env);
    return;
  }
  if (settleOnly.length > 0) {
    const hasInFlightSibling = currentRecords.some((record) => !isTerminalWorkerStatus(record.transportStatus));
    if ((!hasInFlightSibling && settleOnly.length > 1) || hasStaleSettlement(settleOnly, env)) {
      writeSettlementDemand(input, settleOnly, env);
      return;
    }
    if (!hasInFlightSibling && !input.stop_hook_active && claimSettleOnlyAdvisory(input.session_id, settleOnlySignature, env)) {
      writeAcceptanceAdvisory(settleOnly, env);
    }
    if (!hasInFlightSibling) {
      clearStopGate(input.session_id, env);
      return;
    }
  }
  if (inFlight.length > 0) {
    const verifiedInFlight = reverifyInFlightRecords(inFlight, tasks, env);
    if (verifiedInFlight.length === 0) {
      clearStopGate(input.session_id, env);
      return;
    }
    const signature = taskSetSignature(verifiedInFlight);
    if (!input.stop_hook_active && claimStopAdvisory(input.session_id, "in-flight", signature, env)) {
      writeOutput(hookOutput("Stop", tagMessage("worker-lifecycle.in-flight-context", `Fusion task${verifiedInFlight.length === 1 ? "" : "s"} ${verifiedInFlight.map((record) => record.taskId).join(", ")} ${verifiedInFlight.length === 1 ? "is" : "are"} still in flight. Collection is armed and will be required after terminal notification.`)));
    }
    clearStopGate(input.session_id, env);
    return;
  }
  clearStopGate(input.session_id, env);
  writeWrapperApiDeathRedispatchAdvisory(input.session_id, env);
}


export { stopGateLifecycle, writeStopGateBlock, clearStopGate, runtimeTaskForRecord, runtimeTaskSucceeded, runtimeTaskFailed, armInFlightRecords, unjudgedPeerCollections, unreportedCollectorFailures, collectorResultCommand, settlementCommand, collectorStopGate, writeAcceptanceAdvisory, terminalCollectionInstruction, settleOnlyRecords, rereadPendingRecords, settleDemandStaleMs, hasStaleSettlement, writeSettlementDemand, writeTerminalCollectionPending, taskSetSignature, reverifyInFlightRecords, runtimeTaskMissing, needsCancellation, reverifyCancellationRecords, claimStopAdvisory, claimSettleOnlyAdvisory, clearSettleOnlyAdvisory, writeWrapperApiDeathRedispatchAdvisory, handleStop };
