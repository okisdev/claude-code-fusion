import { isVerificationCommand } from "../verification-command.mjs";
import { recordAuditEvent } from "./audit.mjs";
import { bashWriteEffect, isReadOnlyBash } from "./bash-effect.mjs";
import { BASH_TOOL, DELEGATION_TOOLS, MAIN_LANE, READ_TOOLS, WRITE_TOOLS } from "./constants.mjs";
import { updateReadStreak } from "./read-streak.mjs";
import { isNewTurn, outranksReplayKind, readTurn, turnReplayTokens } from "./replay.mjs";
import { normalizeState, readState, withAvailableStateLock, withStateLock, writeState } from "./state.mjs";
import { extractBashCommand } from "./verification.mjs";
import { extractWritePath, isWorkspaceWritePath } from "./write.mjs";

function recordTurn(input, env, { sessionId, toolName, file, now, cwd }) {
  if (Object.hasOwn(input, "agent_id")) return null;
  if (input.hook_event_name && input.hook_event_name !== "PreToolUse") return null;
  const command = toolName === BASH_TOOL ? extractBashCommand(input.tool_input) : null;
  const kind = DELEGATION_TOOLS.has(toolName) ? "dispatch" :
    (WRITE_TOOLS.has(toolName) && isWorkspaceWritePath(extractWritePath(input.tool_input), cwd)) ||
      (toolName === BASH_TOOL && bashWriteEffect(command, cwd) !== null) ? "write" :
    toolName === BASH_TOOL && isVerificationCommand(command, env) ? "verify" :
    toolName === BASH_TOOL && /(?:^|[\s/'"])fusion-stats\.mjs(?=[\s'"]|$)/.test(command) && /(?:^|\s)--record(?=[=\s]|$)/.test(command) ? "settle" :
    READ_TOOLS.has(toolName) || (toolName === BASH_TOOL && isReadOnlyBash(command)) ? "read" : "other";
  const turn = readTurn(input.transcript_path, input.tool_use_id);
  const lock = kind === "read" ? withAvailableStateLock : withStateLock;
  return lock(file, () => {
    const state = normalizeState(readState(file), now);
    const newTurn = isNewTurn(state.turn, turn, now);
    const raisedKind = !newTurn && outranksReplayKind(kind, state.turn.kind);
    if (newTurn) {
      state.turn = { id: turn.id, key: turn.id ?? "t:" + Date.parse(now), at: now, kind, tokens: turnReplayTokens(turn), measured: turn.contextTokens != null };
    } else {
      state.turn.at = now;
      state.turn.id ??= turn.id;
      if (raisedKind) state.turn.kind = kind;
    }
    const result = { newTurn, kind, tokens: state.turn.tokens };
    result.readStreak = updateReadStreak(state, env, { toolName, turn: result });
    writeState(file, state);
    if (newTurn || raisedKind) {
      recordAuditEvent({ at: now, session: sessionId, event: "replay", lane: MAIN_LANE, tool: toolName, turn: state.turn.key, kind: state.turn.kind, tokens: state.turn.tokens, measured: state.turn.measured }, env);
    }
    return result;
  });
}

export { recordTurn };
