import { PEER_RESCUE_AGENT_NAMES, PEER_MANAGED_AGENT_NAMES } from "../engines.mjs";
import path from "node:path";
import { ENGINE_ID_ALTERNATION, PEER_JOB_FOOTER_AGENTS, engineDisplayNameList, engineForAgentType } from "../engines.mjs";
import { tagMessage } from "../user-messages.mjs";
import { withEngineHealthRecords } from "../engine-health.mjs";
import { canonicalWorkerAgentType, isFusionWorkerAgent, WORKER_TERMINAL_STATUSES, markWorkerCollected, readPeerCapacityReservations, readWorkerRecord, readWorkerOutputFileTaskIds, readSessionWorkerRecords, refreshWorkerTranscript, reopenWorkerContinuation, WORKER_COLLECTION_METHODS } from "../worker-state.mjs";
import { markBudgetFailure, workerBudgetFailure, workerRoundUsage } from "./budget.mjs";
import { backfillCollectedTelemetry, capturedPeerIdentity, collectedHarnessAsyncDelivery, infraFinishedAt, noTaskFoundError, outputFileFromLaunchResponse, peerIdentityBackfill, settleQueuedVerdict, settleReapedIfActive, settleWrapperApiDeath, toolResultText, terminalCollectedRecord, terminalCollectionPending, withClaudeQuotaFailure, wrapperApiDeathEvidence } from "./collection.mjs";
import { allowAgentWithTaskId, claimParentContextAdvisory, collectorRequestIdentity, createDispatch, engineInfraDenial, injectedPeerDefaults, latestUserRequestedBackground, latestUserText, leadingCompanionOptions, parentContextTokens, prestagePeerPrompt, promptText, releaseHostPeerCapacity, reserveHostPeerCapacity, validateWorkerBrief } from "./dispatch.mjs";
import { reconcileTaskNotifications, taskNotificationTransition } from "./notifications.mjs";
import { denyTool, hookOutput, writeOutput } from "./output.mjs";
import { activeSessionRecords, clearContinuationRequest, findSessionWorkerRecord, isAttributedTranscriptPath, parentTranscriptByteSize, recordForAgent, refreshRecord, sendMessageResumed, updateLifecycleWorkerRecord } from "./records.mjs";
import { canonicalToolResponseUsage } from "./usage.mjs";
import { CODEX_WRITE_SIZING_ADVISORY_BYTES, FINAL_TEXT_MAX_BYTES, HANDBACK_PLACEHOLDER_PATTERN, READ_ONLY_TOOLS, SIZING_ADVISORY_BYTES, SUBAGENT_HANDBACK_TOOL } from "./constants.mjs";

function handlePreToolUse(input, env) {
  return withEngineHealthRecords(() => preToolUse(input, env));
}

function preToolUse(input, env) {
  if (input.tool_name === SUBAGENT_HANDBACK_TOOL && PEER_RESCUE_AGENT_NAMES.has(input.agent_type) && typeof input.tool_input?.message === "string" && HANDBACK_PLACEHOLDER_PATTERN.test(input.tool_input.message)) {
    writeOutput(denyTool(tagMessage("worker-lifecycle.placeholder-handback-deny", "Keep running the await operation until it returns the real report. Hand back that report only after await completes.")));
    return;
  }
  if (!input.agent_id && input.tool_name === "TaskStop" && typeof input.tool_input?.task_id === "string") {
    const taskId = input.tool_input.task_id;
    const now = new Date().toISOString();
    for (const record of readSessionWorkerRecords(env, input.session_id, { strict: true }).filter((candidate) => !WORKER_TERMINAL_STATUSES.has(candidate.transportStatus) && [candidate.backgroundTaskId, candidate.agentId].includes(taskId))) {
      updateLifecycleWorkerRecord(record.taskId, env, (current) => {
        if (!current || current.sessionId !== input.session_id || WORKER_TERMINAL_STATUSES.has(current.transportStatus) || ![current.backgroundTaskId, current.agentId].includes(taskId)) {
          return null;
        }
        return {
          ...current,
          cancelAttemptCount: (current.cancelAttemptCount ?? 0) + 1,
          lastCancelAttemptAt: now
        };
      });
    }
  }
  if (input.tool_name === "Agent" || input.tool_name === "Task") {
    const agentType = input.tool_input?.subagent_type;
    if (agentType === "Explore" && !Object.hasOwn(input.tool_input, "model")) {
      writeOutput({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input.tool_input, model: "sonnet" } } });
      return;
    }
    if (PEER_RESCUE_AGENT_NAMES.has(agentType)) {
      if (input.tool_input?.run_in_background === true) {
        writeOutput(denyTool(tagMessage("worker-lifecycle.foreground-wrapper-deny", `${engineDisplayNameList()} wrapper Agents use foreground delivery. Keep the Agent foreground; an explicitly requested companion \`--background\` receipt stays inside that foreground wrapper call.`)));
        return;
      }
      reconcileTaskNotifications(input, env);
      const admissionDenial = engineInfraDenial(input.session_id, agentType, latestUserText(input.transcript_path), env, Date.now(), promptText(input.tool_input));
      if (admissionDenial) {
        writeOutput(denyTool(admissionDenial));
        return;
      }
      const capacityDenial = reserveHostPeerCapacity(input, agentType, env);
      if (capacityDenial) {
        writeOutput(denyTool(capacityDenial));
        return;
      }
      const injection = injectedPeerDefaults(input.tool_input?.prompt, agentType, env);
      const finalInput = injection ? { ...input.tool_input, prompt: injection.prompt } : input.tool_input;
      const stagedPrompt = prestagePeerPrompt({ ...input, tool_input: finalInput }, env);
      const advisory = claimParentContextAdvisory(input.session_id, parentContextTokens(input.transcript_path), env);
      const prompt = promptText(input.tool_input);
      const briefBytes = Buffer.byteLength(prompt);
      const codexOptions = engineForAgentType(agentType) === "codex" ? leadingCompanionOptions(prompt).options : [];
      const codexWrite = codexOptions.includes("--write");
      const sizing = codexWrite && briefBytes >= CODEX_WRITE_SIZING_ADVISORY_BYTES
        ? "Sizing advisory: Codex write briefs timed out in 20% of runs at 3 to 5 KB, 24% at 5 to 7 KB, and 59% at 7 KB or more over a measured 7 days, against 3% under 3 KB. Split this package into briefs under 3 KB."
        : !codexWrite && briefBytes > SIZING_ADVISORY_BYTES && !/^sizing:\s*\S/im.test(prompt)
          ? "Sizing advisory: this brief exceeds 8192 bytes without a `sizing:` field. Add `sizing: large` or split the package into smaller briefs."
          : null;
      const effortIndex = codexOptions.indexOf("--effort");
      const maxEffort = codexWrite && (codexOptions.includes("--effort=max") || (effortIndex >= 0 && codexOptions[effortIndex + 1] === "max"))
        ? "Effort advisory: Codex writes at --effort max timed out in 23% of runs over a measured 7 days, against 14% at xhigh. Use xhigh unless the package needs max."
        : null;
      const advisories = [sizing, maxEffort].filter(Boolean);
      const additionalContext = [injection?.context, ...advisories.map((text) => tagMessage("worker-lifecycle.dispatch-advisory", text))].filter(Boolean).join("\n\n");
      if (stagedPrompt || injection || advisory || advisories.length) {
        writeOutput({ ...(stagedPrompt || injection || advisories.length ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...finalInput, ...(stagedPrompt ? { prompt: stagedPrompt } : {}) }, ...(additionalContext ? { additionalContext } : {}) } } : {}), ...(advisory ? { systemMessage: advisory } : {}) });
      }
      return;
    }
    if (PEER_MANAGED_AGENT_NAMES.has(agentType)) {
      return;
    }
    if (!isFusionWorkerAgent(agentType)) {
      return;
    }
    if (canonicalWorkerAgentType(agentType) === "fusion:job-collector" && !collectorRequestIdentity(promptText(input.tool_input))) {
      writeOutput(denyTool(tagMessage("worker-lifecycle.collector-request-deny", `Fusion collector requests must contain exactly one \`engine: ${ENGINE_ID_ALTERNATION}\` line and one \`job: <32 lowercase hexadecimal characters>\` line.`)));
      return;
    }
    const validation = validateWorkerBrief(promptText(input.tool_input), agentType, env);
    if (!validation.ok) {
      writeOutput(denyTool(tagMessage("worker-lifecycle.brief-validation-deny", validation.reason)));
      return;
    }
    const requestsBackground = input.tool_input?.run_in_background === true;
    const userBackgroundAuthorized = requestsBackground && latestUserRequestedBackground(input.transcript_path);
    if (requestsBackground && !userBackgroundAuthorized) {
      writeOutput(denyTool(tagMessage("worker-lifecycle.background-authorization-deny", "Fusion workers may detach only when the latest user message explicitly contains `--background`. Remove background mode and collect the result in this turn.")));
      return;
    }
    reconcileTaskNotifications(input, env);
    const admissionDenial = engineInfraDenial(input.session_id, agentType, latestUserText(input.transcript_path), env, Date.now(), promptText(input.tool_input), input.tool_input?.model);
    if (admissionDenial) {
      writeOutput(denyTool(admissionDenial));
      return;
    }
    const record = createDispatch(input, agentType, userBackgroundAuthorized, env, validation);
    const parentAdvisory = claimParentContextAdvisory(record.sessionId, record.parentContextTokensAtDispatch, env);
    const additionalContext = (validation.advisories ?? []).join("\n\n");
    writeOutput({ ...allowAgentWithTaskId(input.tool_input, record.taskId, additionalContext ? tagMessage("worker-lifecycle.dispatch-advisory", additionalContext) : null), ...(parentAdvisory ? { systemMessage: parentAdvisory } : {}) });
    return;
  }
  if (input.tool_name === "SendMessage" && typeof input.tool_input?.to === "string") {
    const recipient = input.tool_input.to;
    let record = findSessionWorkerRecord((candidate) => (PEER_RESCUE_AGENT_NAMES.has(candidate.agentType) || isFusionWorkerAgent(candidate.agentType)) && [candidate.agentId, candidate.backgroundTaskId].includes(recipient), input.session_id, env);
    if (isFusionWorkerAgent(record?.agentType)) {
      reconcileTaskNotifications(input, env);
      record = readWorkerRecord(record.taskId, env);
    }
    if (record) {
      const admissionDenial = engineInfraDenial(input.session_id, record.agentType, latestUserText(input.transcript_path), env, Date.now(), "", null, record);
      if (admissionDenial) {
        writeOutput(denyTool(admissionDenial));
        return;
      }
      if (PEER_RESCUE_AGENT_NAMES.has(record.agentType) && WORKER_TERMINAL_STATUSES.has(record.transportStatus)) {
        const capacityDenial = reserveHostPeerCapacity(input, record.agentType, env, record.taskId);
        if (capacityDenial) {
          writeOutput(denyTool(capacityDenial));
          return;
        }
      }
      updateLifecycleWorkerRecord(record.taskId, env, (current) => {
        if (!current || current.sessionId !== input.session_id || ![current.agentId, current.backgroundTaskId].includes(recipient)) {
          return null;
        }
        const finishedAt = Date.parse(current.finishedAt ?? "");
        const lastContinuedAt = Date.parse(current.lastContinuedAt ?? "");
        const requestedAt = new Date(Math.max(Date.now(), Number.isFinite(finishedAt) ? finishedAt + 1 : 0, Number.isFinite(lastContinuedAt) ? lastContinuedAt + 1 : 0)).toISOString();
        return { ...current, continuationRequestedAt: requestedAt, continuationRequestedTranscriptBytes: parentTranscriptByteSize(current, input), continuationRequestedStatus: current.transportStatus };
      });
      const injection = PEER_RESCUE_AGENT_NAMES.has(record.agentType) ? injectedPeerDefaults(input.tool_input?.message, record.agentType, env) : null;
      if (injection) {
        writeOutput({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input.tool_input, message: injection.prompt }, additionalContext: injection.context } });
      }
      return;
    }
  }
  if (!isFusionWorkerAgent(input.agent_type)) {
    return;
  }
  const record = recordForAgent(input, env);
  if (!record) {
    return;
  }
  const refreshed = refreshRecord(record, input, env);
  if (WORKER_TERMINAL_STATUSES.has(refreshed.transportStatus)) {
    return;
  }
  const failure = workerBudgetFailure(refreshed);
  if (failure?.failureKind === "stall") {
    const now = new Date().toISOString();
    updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => {
      if (!current || WORKER_TERMINAL_STATUSES.has(current.transportStatus)) {
        return null;
      }
      return { ...current, lastLivenessAt: now, lastActivityAt: now, inFlightSince: now };
    });
    return;
  }
  if (failure) {
    markBudgetFailure(refreshed, failure, env);
    if (failure.failureKind === "token_limit" && input.tool_name === "Write" && !refreshed.terminalWriteGraceUsedAt) {
      const now = new Date().toISOString();
      let terminalWriteGraceUsed = false;
      updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => {
        if (!current || WORKER_TERMINAL_STATUSES.has(current.transportStatus) || current.terminalWriteGraceUsedAt) {
          return null;
        }
        terminalWriteGraceUsed = true;
        return { ...current, terminalWriteGraceUsedAt: now };
      });
      if (terminalWriteGraceUsed) {
        writeOutput({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", additionalContext: tagMessage("worker-lifecycle.final-deliverable-allow", "Final deliverable write permitted; every further tool call will be denied.") } });
        return;
      }
    }
    const terminalWriteHint = failure.failureKind === "token_limit" ? " If the deliverable file is not yet written, one final Write is permitted." : "";
    writeOutput(denyTool(tagMessage("worker-lifecycle.worker-stop-deny", `Fusion worker ${refreshed.taskId} must stop: ${failure.reason}. Return a concise partial result now; do not retry or call more tools.${terminalWriteHint}`)));
    return;
  }
  const now = new Date().toISOString();
  updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => {
    if (!current || WORKER_TERMINAL_STATUSES.has(current.transportStatus)) {
      return null;
    }
    return { ...current, lastActivityAt: now, inFlightSince: now };
  });
}

function handlePostToolUse(input, env, failed = false) {
  if (input.tool_name === "SendMessage" && typeof input.tool_input?.to === "string") {
    const recipient = input.tool_input.to;
    const record = findSessionWorkerRecord((candidate) => (PEER_RESCUE_AGENT_NAMES.has(candidate.agentType) || isFusionWorkerAgent(candidate.agentType)) && [candidate.agentId, candidate.backgroundTaskId].includes(recipient), input.session_id, env);
    if (record) {
      const at = new Date().toISOString();
      const reservedCwd = PEER_RESCUE_AGENT_NAMES.has(record.agentType) ? readPeerCapacityReservations(env).find((reservation) => reservation.taskId === record.taskId)?.companionCwd : null;
      updateLifecycleWorkerRecord(record.taskId, env, (current) => {
        if (!current || current.sessionId !== input.session_id || ![current.agentId, current.backgroundTaskId].includes(recipient)) {
          return null;
        }
        if (failed || !sendMessageResumed(input.tool_response, current.continuationRequestedStatus)) {
          return current.continuationRequestedAt ? clearContinuationRequest(current) : null;
        }
        const requestAt = Date.parse(current.continuationRequestedAt ?? "");
        const alreadyReopened = Number.isFinite(requestAt) && Date.parse(current.lastContinuedAt ?? "") >= requestAt;
        const collected = current.transportStatus === "ready_uncollected"
          ? taskNotificationTransition(current, { status: "completed" }, at, env)
          : current;
        const next = WORKER_TERMINAL_STATUSES.has(collected.transportStatus) && !alreadyReopened
          ? reopenWorkerContinuation(collected, at, current.continuationRequestedTranscriptBytes ?? parentTranscriptByteSize(current, input))
          : collected;
        const continued = next !== collected && reservedCwd ? { ...next, companionCwd: reservedCwd } : next;
        return current.continuationRequestedAt ? clearContinuationRequest(continued) : continued === current ? null : continued;
      });
    }
    releaseHostPeerCapacity(input, env);
    if (!failed) {
      reconcileTaskNotifications(input, env);
    }
    return;
  }
  if (failed && ["Agent", "Task"].includes(input.tool_name) && PEER_RESCUE_AGENT_NAMES.has(input.tool_input?.subagent_type)) {
    releaseHostPeerCapacity(input, env);
  }
  if (failed && ["Agent", "Task"].includes(input.tool_name)) {
    const failureText = [input.error, input.tool_response].flatMap((value) => {
      if (typeof value === "string") {
        return [value];
      }
      try {
        return value == null ? [] : [JSON.stringify(value)];
      } catch {
        return [];
      }
    }).join("\n");
    if (/Concurrent subagent limit reached/i.test(failureText)) {
      const pending = typeof input.tool_use_id === "string"
        ? findSessionWorkerRecord((record) => record.dispatchToolUseId === input.tool_use_id, input.session_id, env)
        : null;
      if (pending) {
        const now = new Date().toISOString();
        updateLifecycleWorkerRecord(pending.taskId, env, (current) => current && !WORKER_TERMINAL_STATUSES.has(current.transportStatus)
          ? settleQueuedVerdict({
              ...current,
              transportStatus: "failed",
              failureKind: "launch",
              infraFailure: true,
              pendingVerdict: {
                acceptance: "rejected",
                source: "lifecycle",
                reason: "launch refused by the concurrent subagent cap; nothing ran",
                failureKind: null,
                queuedAt: now
              },
              finishedAt: now
            }, now, env)
          : null);
      }
      const configuredCap = String(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS ?? "").trim();
      const maxConcurrent = /^\d+$/.test(configuredCap) && Number.isSafeInteger(Number(configuredCap)) && Number(configuredCap) > 0 ? Number(configuredCap) : 20;
      const inFlight = activeSessionRecords(input.session_id, env).length;
      writeOutput(hookOutput("PostToolUseFailure", tagMessage("worker-lifecycle.launch-cap-advisory", `The harness refused this launch: at most ${maxConcurrent} subagents run at once (CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, default 20) and ${inFlight} Fusion tasks are in flight in this session. Relaunch after a completion notification instead of retrying now.`)));
      return;
    }
  }
  if (!input.agent_id && ["Read", "TaskStop"].includes(input.tool_name)) {
    const taskId = typeof input.tool_input?.task_id === "string" ? input.tool_input.task_id : null;
    const readPath = typeof input.tool_input?.file_path === "string" ? path.resolve(input.cwd, input.tool_input.file_path) : null;
    const records = input.tool_name === "Read"
      ? (readPath ? readWorkerOutputFileTaskIds(input.session_id, readPath, env).map((id) => readWorkerRecord(id, env)).filter(Boolean) : [])
      : readSessionWorkerRecords(env, input.session_id, { strict: true });
    if (input.tool_name === "TaskStop" && taskId && noTaskFoundError(input, failed)) {
      const now = new Date().toISOString();
      for (const record of records.filter((candidate) => candidate.sessionId === input.session_id && !WORKER_TERMINAL_STATUSES.has(candidate.transportStatus) && [candidate.backgroundTaskId, candidate.agentId].includes(taskId))) {
        settleReapedIfActive(record.taskId, now, env, (current) => current.sessionId === input.session_id && [current.backgroundTaskId, current.agentId].includes(taskId));
      }
      return;
    }
    const matches = records.filter((record) => {
      if (record.sessionId !== input.session_id) {
        return false;
      }
      if (input.tool_name === "Read") {
        return terminalCollectionPending(record) && [record.outputFile, record.transcriptPath].some((collectionPath) => typeof collectionPath === "string" && path.resolve(collectionPath) === readPath);
      }
      return taskId && [record.backgroundTaskId, record.agentId, record.taskId].includes(taskId);
    });
    if (!failed && input.tool_response?.is_error !== true && input.tool_response?.isError !== true) {
      const now = new Date().toISOString();
      const collectedResultText = input.tool_name === "Read" ? toolResultText(input) : null;
      if (input.tool_name !== "TaskStop" && !collectedResultText?.trim()) {
        return;
      }
      for (const record of matches) {
        updateLifecycleWorkerRecord(record.taskId, env, (current) => {
          if (!current || current.sessionId !== input.session_id) {
            return null;
          }
          const worker = current;
          const peerIdentity = input.tool_name === "Read" && PEER_JOB_FOOTER_AGENTS.has(worker.agentType)
            ? capturedPeerIdentity(worker.agentType, collectedResultText, worker.peerEngine, worker)
            : {};
          if (terminalCollectedRecord(worker)) {
            return peerIdentityBackfill(worker, peerIdentity, env);
          }
          const transportStatus = input.tool_name === "TaskStop" ? "cancelled" : "done";
          const collectionMethod = input.tool_name === "Read"
            ? WORKER_COLLECTION_METHODS.OUTPUT_FILE_READ
            : WORKER_COLLECTION_METHODS.TASK_STOP;
          if (input.tool_name !== "TaskStop" && wrapperApiDeathEvidence(worker, collectedResultText)) {
            return backfillCollectedTelemetry(settleWrapperApiDeath(markWorkerCollected(worker, collectionMethod, now), collectedResultText, now, env), input);
          }
          const classified = input.tool_name === "TaskStop" ? worker : withClaudeQuotaFailure(worker, collectedResultText, now);
          if (classified !== worker) {
            return backfillCollectedTelemetry(settleQueuedVerdict({ ...markWorkerCollected(classified, collectionMethod, now), transportStatus: "failed", finishedAt: infraFinishedAt(worker, now), lastActivityAt: now }, now, env), input);
          }
          const harnessAsyncDelivery = collectedHarnessAsyncDelivery(worker, transportStatus);
          const updated = settleQueuedVerdict({
            ...markWorkerCollected(worker, collectionMethod, now),
            transportStatus,
            awaitingBackgroundCommand: undefined,
            failureKind: input.tool_name === "TaskStop" ? worker.failureKind ?? "cancelled" : harnessAsyncDelivery ? null : worker.failureKind,
            ...(harnessAsyncDelivery ? { deliveryMode: "harness_async" } : {}),
            ...peerIdentity,
            finishedAt: worker.finishedAt ?? now,
            lastActivityAt: now
          }, now, env);
          return input.tool_name === "Read" ? backfillCollectedTelemetry(updated, input) : updated;
        });
      }
    }
    return;
  }
  if ((input.tool_name === "Agent" || input.tool_name === "Task") && !input.agent_id) {
    const agentType = input.tool_input?.subagent_type;
    if (PEER_RESCUE_AGENT_NAMES.has(agentType)) {
      if (failed) {
        return;
      }
      try {
        const response = input.tool_response && typeof input.tool_response === "object" ? input.tool_response : {};
        const nested = response.toolUseResult && typeof response.toolUseResult === "object" ? response.toolUseResult : {};
        const isAsync = response.isAsync === true || nested.isAsync === true || response.status === "async_launched" || nested.status === "async_launched";
        if (!isAsync) {
          return;
        }
        const agentId = typeof response.agentId === "string" ? response.agentId : typeof nested.agentId === "string" ? nested.agentId : null;
        const outputFile = outputFileFromLaunchResponse(response, nested);
        const now = new Date().toISOString();
        const record = createDispatch(input, agentType, false, env);
        updateLifecycleWorkerRecord(record.taskId, env, (current) => ({
          ...current,
          ...(agentId ? { agentId, backgroundTaskId: agentId } : {}),
          ...(outputFile ? { transcriptPath: outputFile } : {}),
          transportStatus: "pending_async",
          runtimeAsync: true,
          failureKind: "unexpected_async",
          startedAt: current.startedAt ?? now
        }));
      } finally {
        releaseHostPeerCapacity(input, env);
      }
      return;
    }
    if (!isFusionWorkerAgent(agentType)) {
      return;
    }
    const pending = findSessionWorkerRecord((record) => record.dispatchToolUseId === input.tool_use_id, input.session_id, env);
    if (pending) {
      const response = input.tool_response && typeof input.tool_response === "object" ? input.tool_response : {};
      const nested = response.toolUseResult && typeof response.toolUseResult === "object" ? response.toolUseResult : {};
      const agentId = typeof response.agentId === "string" ? response.agentId : typeof nested.agentId === "string" ? nested.agentId : null;
      const outputFile = outputFileFromLaunchResponse(response, nested);
      const isAsync = response.isAsync === true || nested.isAsync === true || response.status === "async_launched" || nested.status === "async_launched";
      const resolvedModel = typeof response.resolvedModel === "string" ? response.resolvedModel : typeof nested.resolvedModel === "string" ? nested.resolvedModel : null;
      const usageResponse = response.usage || response.totalTokens != null ? response : nested;
      const directUsage = canonicalToolResponseUsage(usageResponse);
      const completed = response.status === "completed" || nested.status === "completed";
      const totalToolUseCount = response.totalToolUseCount ?? nested.totalToolUseCount;
      const now = new Date().toISOString();
      updateLifecycleWorkerRecord(pending.taskId, env, (current) => {
        if (!current || terminalCollectedRecord(current)) {
          return null;
        }
        const worker = current;
        const transportStatus = failed ? "failed" : isAsync ? "pending_async" : completed && !WORKER_TERMINAL_STATUSES.has(worker.transportStatus) ? "done" : worker.transportStatus === "dispatching" ? "running" : worker.transportStatus;
        const updated = {
          ...(!failed && completed ? markWorkerCollected(worker, WORKER_COLLECTION_METHODS.AGENT_RESULT, now) : worker),
          ...(agentId ? { agentId, backgroundTaskId: isAsync ? agentId : worker.backgroundTaskId } : {}),
          ...(outputFile ? { transcriptPath: outputFile } : {}),
          ...(resolvedModel ? { resolvedModel } : {}),
          ...(directUsage?.usage ? { usage: directUsage.usage, usageSource: "tool-response" } : {}),
          ...(directUsage ? { usageAvailability: directUsage.availability, reportedTotalTokens: directUsage.reportedTotalTokens } : {}),
          ...(Number.isFinite(response.totalDurationMs ?? nested.totalDurationMs) ? { durationMs: response.totalDurationMs ?? nested.totalDurationMs } : {}),
          ...(Number.isSafeInteger(totalToolUseCount) ? { toolCalls: totalToolUseCount, toolCallsSource: "tool-response" } : {}),
          transportStatus,
          failureKind: failed ? "launch" : worker.failureKind,
          finishedAt: failed || completed ? now : worker.finishedAt,
          runtimeAsync: isAsync,
          ...(isAsync ? { startedAt: worker.startedAt ?? now } : {})
        };
        return WORKER_TERMINAL_STATUSES.has(transportStatus) ? settleQueuedVerdict(updated, now, env) : updated;
      });
    }
    return;
  }
  if (!isFusionWorkerAgent(input.agent_type) && !PEER_JOB_FOOTER_AGENTS.has(input.agent_type)) {
    return;
  }
  const record = recordForAgent(input, env);
  if (!record) {
    return;
  }
  const now = new Date().toISOString();
  const handbackMessage = !failed && input.tool_name === SUBAGENT_HANDBACK_TOOL && typeof input.tool_input?.message === "string" && input.tool_input.message.trim() && !HANDBACK_PLACEHOLDER_PATTERN.test(input.tool_input.message) ? input.tool_input.message.slice(-FINAL_TEXT_MAX_BYTES) : null;
  let emitTurnWindDown = false;
  let emitTokenWindDown = false;
  let emitUncachedWindDown = false;
  updateLifecycleWorkerRecord(record.taskId, env, (current) => {
    if (!current || WORKER_TERMINAL_STATUSES.has(current.transportStatus)) {
      return null;
    }
    const selectedTranscript = isAttributedTranscriptPath(input.transcript_path, record) ? input.transcript_path : null;
    const refreshed = selectedTranscript ? refreshWorkerTranscript(current, selectedTranscript) : current;
    const progress = !failed && !READ_ONLY_TOOLS.has(input.tool_name);
    const turnWindDownThreshold = Math.max(0, (refreshed.limits?.maxTurns ?? Number.POSITIVE_INFINITY) - 2);
    const tokenWindDownThreshold = (refreshed.limits?.maxOutputTokens ?? Number.POSITIVE_INFINITY) * 0.85;
    const uncachedWindDownThreshold = (refreshed.limits?.maxUncachedTokens ?? Number.POSITIVE_INFINITY) * 0.85;
    const usage = workerRoundUsage(refreshed);
    emitTokenWindDown = !WORKER_TERMINAL_STATUSES.has(refreshed.transportStatus) && refreshed.tokenWindDownSentAt == null && usage.outputTokens >= tokenWindDownThreshold;
    emitUncachedWindDown = !emitTokenWindDown && !WORKER_TERMINAL_STATUSES.has(refreshed.transportStatus) && refreshed.uncachedWindDownSentAt == null && usage.uncachedTokens >= uncachedWindDownThreshold;
    emitTurnWindDown = !emitTokenWindDown && !emitUncachedWindDown && !WORKER_TERMINAL_STATUSES.has(refreshed.transportStatus) && refreshed.windDownContextSentAt == null && usage.turns >= turnWindDownThreshold;
    return {
      ...refreshed,
      lastActivityAt: now,
      inFlightSince: undefined,
      ...(!failed ? { lastLivenessAt: now } : {}),
      ...(progress ? { lastProgressAt: now, progressEvents: (refreshed.progressEvents ?? 0) + 1 } : {}),
      ...(handbackMessage ? { handbackReport: handbackMessage } : {}),
      ...(emitTurnWindDown ? { windDownContextSentAt: now } : {}),
      ...(emitTokenWindDown ? { tokenWindDownSentAt: now } : {}),
      ...(emitUncachedWindDown ? { uncachedWindDownSentAt: now } : {})
    };
  });
  if (emitTokenWindDown) {
    writeOutput(hookOutput(input.hook_event_name, tagMessage("worker-lifecycle.budget-wind-down", "Token budget wind-down: stop making tool calls and write your final deliverable now.")));
  } else if (emitUncachedWindDown) {
    writeOutput(hookOutput(input.hook_event_name, tagMessage("worker-lifecycle.budget-wind-down", "Uncached token budget wind-down: stop making tool calls and write your final deliverable now.")));
  } else if (emitTurnWindDown) {
    writeOutput(hookOutput(input.hook_event_name, tagMessage("worker-lifecycle.budget-wind-down", "Turn budget wind-down: stop making tool calls and write your final deliverable now.")));
  }
}


export { handlePreToolUse, handlePostToolUse };
