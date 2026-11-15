import { JUDGMENT_POSTURE } from "../posture.mjs";
import { messageCode, tagMessage } from "../user-messages.mjs";
import { verificationEvidence } from "../verification-command.mjs";
import { recordAuditEvent } from "./audit.mjs";
import { resolveMode } from "./config.mjs";
import { BASH_TOOL, MAIN_LANE, NO_OP_BASH_COMMANDS, NO_OP_HEARTBEAT_DENY_MESSAGE_SLUG, NO_OP_HEARTBEAT_REASON } from "./constants.mjs";
import { inFlightWorkerTaskSignature, totalDispatches } from "./dispatch.mjs";
import { resolveReplayBudgetTokens } from "./replay.mjs";
import { normalizeState, readState, resetWriteWindow, withStateLock, writeState } from "./state.mjs";
import { extractBashCommand } from "./verification.mjs";
import { denyOutput } from "./write.mjs";

function handleBash(input, env, { sessionId, toolName, file, now, posture, writeHookText }) {
  if (toolName === BASH_TOOL) {
    const command = extractBashCommand(input.tool_input);
    if (input.hook_event_name === "PostToolUse") {
      const toolResponse = input.tool_response;
      if (command === null) {
        return;
      }
      const evidence = verificationEvidence(command, toolResponse, env);
      if (!evidence) {
        return;
      }
      const verification = withStateLock(file, () => {
        const state = normalizeState(readState(file), now);
        const writeCount = state.writesSinceDispatch;
        const replayTokens = state.writeReplayTokens;
        const dispatchCount = totalDispatches(state.dispatches);
        if (posture === JUDGMENT_POSTURE && writeCount > 0) {
          resetWriteWindow(state);
          writeState(file, state);
        }
        return { writeCount, replayTokens, dispatchCount };
      });
      recordAuditEvent(
        {
          at: now,
          session: sessionId,
          event: "verification",
          lane: MAIN_LANE,
          tool: BASH_TOOL,
          writeCount: verification.writeCount,
          replayTokens: verification.replayTokens,
          dispatchCount: verification.dispatchCount,
          budget: resolveReplayBudgetTokens(env),
          mode: resolveMode(env),
          posture,
          evidence
        },
        env
      );
      return;
    }
    if (input.hook_event_name && input.hook_event_name !== "PreToolUse") {
      return;
    }
    if (command === null || !NO_OP_BASH_COMMANDS.has(command)) {
      return;
    }
    const inFlightSignature = sessionId ? inFlightWorkerTaskSignature(sessionId, env) : null;
    if (!inFlightSignature) {
      return;
    }
    const budget = resolveReplayBudgetTokens(env);
    let writeCount = 0;
    let replayTokens = 0;
    let dispatchCount = 0;
    try {
      const snapshot = withStateLock(file, () => normalizeState(readState(file), now));
      writeCount = snapshot.writesSinceDispatch;
      replayTokens = snapshot.writeReplayTokens;
      dispatchCount = totalDispatches(snapshot.dispatches);
    } catch {
      void 0;
    }
    recordAuditEvent(
      {
        at: now,
        session: sessionId,
        event: "deny",
        lane: MAIN_LANE,
        tool: BASH_TOOL,
        writeCount,
        replayTokens,
        dispatchCount,
        budget,
        mode: "enforce",
        posture,
        messageCode: messageCode(NO_OP_HEARTBEAT_DENY_MESSAGE_SLUG)
      },
      env
    );
    writeHookText(`${JSON.stringify(denyOutput(tagMessage(NO_OP_HEARTBEAT_DENY_MESSAGE_SLUG, NO_OP_HEARTBEAT_REASON)))}\n`);
    return;
  }
}

export { handleBash };
