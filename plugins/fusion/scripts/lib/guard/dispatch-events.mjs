import { PEER_RESCUE_AGENT_NAMES } from "../engines.mjs";
import { messageCode, tagMessage } from "../user-messages.mjs";
import { isFusionWorkerAgent } from "../worker-state.mjs";
import { recordAuditEvent } from "./audit.mjs";
import { DELEGATION_TOOLS, DISPATCH_LOG_LIMIT, MAIN_LANE, MISSING_LAUNCH_RECOVERY_REASON, REAPED_WORKER_REDIRECT_AUDIT_DESCRIPTION, REAPED_WORKER_REDIRECT_MESSAGE_SLUG, REAPED_WORKER_TERMINAL_STATUSES, TASK_CONTROL_TOOLS } from "./constants.mjs";
import { extractDispatchDescription, extractSubagentType, extractTaskControlId, extractToolUseId, findLaunchedDispatch, findWorkerRecordForTaskControlId, laneForSubagentType, latestConfirmedDispatchAt, reapedWorkerRedirectReason, sanitizeIdentifier } from "./dispatch.mjs";
import { normalizeState, readState, resetWriteWindow, withStateLock, writeState } from "./state.mjs";
import { messageIdForToolUse } from "./verification.mjs";
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
    const genericAgent = toolName === "Agent" && !input.agent_id && (subagentType == null || ["fork", "general-purpose", "claude"].includes(subagentType));
    const safeSubagentType = sanitizeIdentifier(subagentType);
    const lane = laneForSubagentType(subagentType);
    const description = extractDispatchDescription(input.tool_input);
    const toolUseId = extractToolUseId(input);
    const messageId = input.hook_event_name === "PreToolUse" ? null : messageIdForToolUse(input.transcript_path, input.tool_use_id);

    if (input.hook_event_name === "PreToolUse") {
      withStateLock(file, () => {
        const state = normalizeState(readState(file), now);
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
      const state = normalizeState(readState(file), now);
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
      state.dispatches[launched.lane] = (state.dispatches[launched.lane] ?? 0) + 1;
      state.dispatchEpoch += 1;
      state.lastDispatchAt = latestConfirmedDispatchAt(state.dispatchLog);
      resetWriteWindow(state);
      writeState(file, state);
      return {
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
    if (genericAgent) {
      writeHookText(`${JSON.stringify(postToolAdvisoryOutput(tagMessage("inline-guard.generic-agent-advisory", "This Agent runs a work package outside Fusion collection and settlement. Use codex:codex-rescue or fusion:claude-worker for tracked work, and Explore for read only search.")))}\n`);
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
