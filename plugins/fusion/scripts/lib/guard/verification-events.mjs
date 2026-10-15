import { JUDGMENT_POSTURE } from "../posture.mjs";
import { messageCode, tagMessage } from "../user-messages.mjs";
import { recordAuditEvent } from "./audit.mjs";
import { resolveBudget, resolveFleetWaveGapMs, resolveMode } from "./config.mjs";
import { BASH_TOOL, MAIN_LANE, NO_OP_BASH_COMMANDS, NO_OP_HEARTBEAT_DENY_MESSAGE_SLUG, NO_OP_HEARTBEAT_REASON } from "./constants.mjs";
import { inFlightWorkerTaskSignature, totalDispatches } from "./dispatch.mjs";
import { normalizeState, readState, resetWriteWindow, withStateLock, writeState } from "./state.mjs";
import { extractBashCommand, verificationCommand, verificationOutputPasses, verificationResponseFailed } from "./verification.mjs";
import { denyOutput } from "./write.mjs";

function handleBash(input, env, { sessionId, toolName, file, now, posture, writeHookText }) {
  if (toolName === BASH_TOOL) {
    const command = extractBashCommand(input.tool_input);
    if (input.hook_event_name === "PostToolUse") {
      const toolResponse = input.tool_response;
      const recognizedVerification = command === null ? null : verificationCommand(command, env);
      if (
        posture !== JUDGMENT_POSTURE ||
        command === null ||
        !recognizedVerification.recognized ||
        !toolResponse ||
        typeof toolResponse !== "object" ||
        Array.isArray(toolResponse) ||
        verificationResponseFailed(toolResponse)
      ) {
        return;
      }
      const evidence = recognizedVerification.observable ? "exit-status" : verificationOutputPasses(toolResponse) ? "output-summary" : null;
      if (!evidence) {
        return;
      }
      const verification = withStateLock(file, () => {
        const state = normalizeState(readState(file), now, resolveFleetWaveGapMs(env));
        if (state.writesSinceDispatch === 0) {
          return null;
        }
        const writeCount = state.writesSinceDispatch;
        const dispatchCount = totalDispatches(state.dispatches);
        resetWriteWindow(state);
        writeState(file, state);
        return { writeCount, dispatchCount };
      });
      if (verification) {
        recordAuditEvent(
          {
            at: now,
            session: sessionId,
            event: "verification",
            lane: MAIN_LANE,
            tool: BASH_TOOL,
            writeCount: verification.writeCount,
            dispatchCount: verification.dispatchCount,
            budget: resolveBudget(env),
            mode: resolveMode(env),
            posture,
            evidence
          },
          env
        );
      }
      return;
    }
    if (input.hook_event_name && input.hook_event_name !== "PreToolUse") {
      return;
    }
    const inFlightSignature = sessionId ? inFlightWorkerTaskSignature(sessionId, env) : null;
    if (command === null || !NO_OP_BASH_COMMANDS.has(command) || !inFlightSignature) {
      return;
    }
    const budget = resolveBudget(env);
    let writeCount = 0;
    let dispatchCount = 0;
    try {
      const snapshot = withStateLock(file, () => normalizeState(readState(file), now, resolveFleetWaveGapMs(env)));
      writeCount = snapshot.writesSinceDispatch;
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
