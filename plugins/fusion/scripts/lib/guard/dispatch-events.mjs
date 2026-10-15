import { PEER_RESCUE_AGENT_NAMES } from "../engines.mjs";
import { messageCode, tagMessage } from "../user-messages.mjs";
import { isFusionWorkerAgent } from "../worker-state.mjs";
import { recordAuditEvent } from "./audit.mjs";
import { resolveFleetWaveGapMs } from "./config.mjs";
import { DELEGATION_TOOLS, DISPATCH_LOG_LIMIT, MAIN_LANE, MISSING_LAUNCH_RECOVERY_REASON, NARROW_WAVE_ADVISORY_MESSAGE_SLUG, NARROW_WAVE_ADVISORY_REASON, NARROW_WAVE_ADVISORY_SUFFIX, REAPED_WORKER_REDIRECT_AUDIT_DESCRIPTION, REAPED_WORKER_REDIRECT_MESSAGE_SLUG, REAPED_WORKER_TERMINAL_STATUSES, TASK_CONTROL_TOOLS } from "./constants.mjs";
import { deriveInclusiveFleetWaveWidth, extractDispatchDescription, extractSubagentType, extractTaskControlId, extractToolUseId, findLaunchedDispatch, findWorkerRecordForTaskControlId, laneForSubagentType, latestConfirmedDispatchAt, reapedWorkerRedirectReason, sameFleetWave, sanitizeIdentifier } from "./dispatch.mjs";
import { claimAdvisory, normalizeState, readState, resetWriteWindow, stableAdvisorySignature, withStateLock, writeState } from "./state.mjs";
import { hasFleetDeclineAfterLastUserMessage, messageIdForToolUse } from "./verification.mjs";
import { denyOutput, postToolAdvisoryOutput } from "./write.mjs";

function handleDispatch(input, env, { sessionId, toolName, file, now, posture, writeHookText }) {
  if (DELEGATION_TOOLS.has(toolName)) {
    if (input.hook_event_name && input.hook_event_name !== "PreToolUse" && input.hook_event_name !== "PostToolUse") {
      return;
    }
    const recipient = toolName === "SendMessage" ? input.tool_input?.to : null;
    const record = typeof recipient === "string" && recipient ? findWorkerRecordForTaskControlId(recipient, env, sessionId) : null;
    if (toolName === "SendMessage" && (record?.sessionId !== sessionId || !(PEER_RESCUE_AGENT_NAMES.has(record.agentType) || isFusionWorkerAgent(record.agentType)))) {
      return;
    }
    const subagentType = toolName === "SendMessage" ? record.agentType : extractSubagentType(input.tool_input);
    const safeSubagentType = sanitizeIdentifier(subagentType);
    const lane = laneForSubagentType(subagentType);
    const description = extractDispatchDescription(input.tool_input);
    const toolUseId = extractToolUseId(input);
    const messageId = input.hook_event_name === "PreToolUse" ? null : messageIdForToolUse(input.transcript_path, input.tool_use_id);
    const waveGapMs = resolveFleetWaveGapMs(env);

    if (input.hook_event_name === "PreToolUse") {
      withStateLock(file, () => {
        const state = normalizeState(readState(file), now, waveGapMs);
        state.dispatchLog.push({
          at: now,
          lane,
          phase: "launched",
          ...(toolUseId ? { toolUseId } : {}),
          ...(safeSubagentType ? { subagentType: safeSubagentType } : {}),
          ...(description ? { description } : {})
        });
        if (state.dispatchLog.length > DISPATCH_LOG_LIMIT) {
          state.dispatchLog.splice(0, state.dispatchLog.length - DISPATCH_LOG_LIMIT);
        }
        writeState(file, state);
      });
      return;
    }

    const confirmation = withStateLock(file, () => {
      const state = normalizeState(readState(file), now, waveGapMs);
      let launched = findLaunchedDispatch(state.dispatchLog, toolUseId, lane);
      const recoveredMissingLaunch = launched === null;
      if (recoveredMissingLaunch) {
        launched = {
          at: now,
          lane,
          phase: "confirmed",
          ...(toolUseId ? { toolUseId } : {}),
          ...(messageId ? { messageId } : {}),
          ...(safeSubagentType ? { subagentType: safeSubagentType } : {}),
          ...(description ? { description } : {})
        };
        state.dispatchLog.push(launched);
        if (state.dispatchLog.length > DISPATCH_LOG_LIMIT) {
          state.dispatchLog.splice(0, state.dispatchLog.length - DISPATCH_LOG_LIMIT);
        }
      } else {
        launched.phase = "confirmed";
        if (messageId) {
          launched.messageId = messageId;
        }
        if (description) {
          launched.description = description;
        }
      }
      const pendingIncludedWidth = deriveInclusiveFleetWaveWidth(state.dispatchLog, waveGapMs, launched) || state.fleetWaveWidth;
      const previousDispatch = state.dispatchLog.findLast((entry) => entry !== launched && entry.phase === "confirmed");
      const sameWave = previousDispatch && sameFleetWave(previousDispatch, launched, waveGapMs);
      const previousFleetWaveWidth = state.fleetWaveWidth;
      state.fleetWaveWidth = pendingIncludedWidth;
      if (pendingIncludedWidth > 2) {
        state.consecutiveNarrowWaves = 0;
      } else if (pendingIncludedWidth === 1 && !sameWave) {
        state.consecutiveNarrowWaves = previousFleetWaveWidth > 0 && previousFleetWaveWidth <= 2 ? state.consecutiveNarrowWaves + 1 : 0;
      }
      if (state.consecutiveNarrowWaves === 0) {
        state.lastAdvisedNarrowWaveStreak = 0;
      }
      const narrowSignature = stableAdvisorySignature([state.consecutiveNarrowWaves, state.fleetWaveWidth]);
      const shouldAdvise =
        state.consecutiveNarrowWaves > 0 &&
        state.consecutiveNarrowWaves % 2 === 0 &&
        !state.advisedNarrowWaveSignatures.includes(narrowSignature);
      if (shouldAdvise) {
        state.lastAdvisedNarrowWaveStreak = state.consecutiveNarrowWaves;
        state.advisedNarrowWaveSignatures.push(narrowSignature);
      }
      state.dispatches[launched.lane] = (state.dispatches[launched.lane] ?? 0) + 1;
      state.dispatchEpoch += 1;
      state.lastDispatchAt = latestConfirmedDispatchAt(state.dispatchLog);
      resetWriteWindow(state);
      writeState(file, state);
      return {
        shouldAdvise,
        streak: state.consecutiveNarrowWaves,
        fleetWaveWidth: state.fleetWaveWidth,
        pendingIncludedWidth,
        dispatchEpoch: state.dispatchEpoch,
        lane: launched.lane,
        messageId: launched.messageId,
        description: launched.description ?? description,
        recoveredMissingLaunch
      };
    });
    if (confirmation.recoveredMissingLaunch) {
      recordAuditEvent(
        { at: now, session: sessionId, event: "warn", lane: confirmation.lane, tool: toolName, reason: MISSING_LAUNCH_RECOVERY_REASON, posture },
        env
      );
    }
    recordAuditEvent(
      { at: now, session: sessionId, event: "dispatch", lane: confirmation.lane, tool: toolName, ...(confirmation.messageId ? { messageId: confirmation.messageId } : {}), ...(confirmation.description ? { description: confirmation.description } : {}) },
      env
    );
    if (confirmation.shouldAdvise) {
      const declineStated = hasFleetDeclineAfterLastUserMessage(input.transcript_path);
      const advisory = claimAdvisory(
        file,
        "narrow-wave",
        stableAdvisorySignature([confirmation.streak, confirmation.fleetWaveWidth]),
        now,
        waveGapMs,
        (state) => state.dispatchEpoch === confirmation.dispatchEpoch && state.consecutiveNarrowWaves === confirmation.streak
      );
      if (!advisory.skipped) {
        recordAuditEvent(
          {
            at: now,
            session: sessionId,
            event: "warn",
            lane: confirmation.lane,
            tool: toolName,
            reason: NARROW_WAVE_ADVISORY_REASON,
            posture,
            messageCode: messageCode(NARROW_WAVE_ADVISORY_MESSAGE_SLUG),
            pendingIncludedWidth: confirmation.pendingIncludedWidth,
            ...(declineStated ? { declineStated: true } : {}),
            ...(advisory.suppressed ? { suppressed: true } : {})
          },
          env
        );
        if (!advisory.suppressed && !declineStated) {
          writeHookText(
            `${JSON.stringify(postToolAdvisoryOutput(tagMessage(NARROW_WAVE_ADVISORY_MESSAGE_SLUG, `${confirmation.streak} ${NARROW_WAVE_ADVISORY_SUFFIX}`)))}\n`
          );
        }
      }
    }
    return;
  }
}

function handleTaskControl(input, env, { sessionId, toolName, file, now, posture, writeHookText }) {
  if (TASK_CONTROL_TOOLS.has(toolName)) {
    if (input.hook_event_name && input.hook_event_name !== "PreToolUse") {
      return;
    }
    const taskId = extractTaskControlId(input.tool_input);
    const record = taskId ? findWorkerRecordForTaskControlId(taskId, env, sessionId) : null;
    if (!record || !REAPED_WORKER_TERMINAL_STATUSES.has(record.transportStatus)) {
      return;
    }
    recordAuditEvent(
      {
        at: now,
        session: sessionId,
        event: "deny",
        lane: MAIN_LANE,
        tool: toolName,
        description: REAPED_WORKER_REDIRECT_AUDIT_DESCRIPTION,
        mode: "enforce",
        posture,
        messageCode: messageCode(REAPED_WORKER_REDIRECT_MESSAGE_SLUG)
      },
      env
    );
    writeHookText(`${JSON.stringify(denyOutput(reapedWorkerRedirectReason(record, taskId)))}\n`);
    return;
  }
}

export { handleDispatch, handleTaskControl };
