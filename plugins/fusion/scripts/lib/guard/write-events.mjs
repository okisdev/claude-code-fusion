import { verificationResponseFailed } from "../verification-command.mjs";
import { recordAuditEvent } from "./audit.mjs";
import { BASH_TOOL, MAIN_LANE, WRITE_TOOLS } from "./constants.mjs";
import { extractToolUseId } from "./dispatch.mjs";
import { resolveReplayBudgetTokens } from "./replay.mjs";
import { normalizeState, readState, withStateLock, writeState } from "./state.mjs";
import { extractAuditWritePath, extractWritePath, isWorkspaceWritePath } from "./write.mjs";

function handleWrite(input, env, { sessionId, toolName, file, now, cwd, writeEffect }) {
  if (!WRITE_TOOLS.has(toolName) && toolName !== BASH_TOOL) {
    return;
  }

  const toolUseId = extractToolUseId(input);
  if (input.hook_event_name === "PostToolUseFailure" || input.hook_event_name === "PostToolUse") {
    if (!toolUseId) return;
    const failed = input.hook_event_name === "PostToolUseFailure" || (toolName === BASH_TOOL && verificationResponseFailed(input.tool_response ?? {}));
    withStateLock(file, () => {
      const state = normalizeState(readState(file), now);
      const index = state.pendingWrites.findIndex((entry) => entry.id === toolUseId && entry.tool === toolName);
      if (index < 0) return;
      const [entry] = state.pendingWrites.splice(index, 1);
      if (failed && toolName !== BASH_TOOL) {
        state.writeCount = Math.max(0, state.writeCount - 1);
        if (entry.epoch === state.dispatchEpoch) {
          if (entry.turn && entry.turn === state.writeTurnKey) {
            state.writeTurnWrites = Math.max(0, state.writeTurnWrites - 1);
            if (state.writeTurnWrites === 0) {
              state.writeReplayTokens = Math.max(0, state.writeReplayTokens - state.writeTurnTokens);
              state.writeTurnKey = null;
              state.writeTurnTokens = 0;
            }
          }
          state.writesSinceDispatch = Math.max(0, state.writesSinceDispatch - 1);
        }
      }
      writeState(file, state);
    });
    return;
  }
  if (input.hook_event_name && input.hook_event_name !== "PreToolUse") return;
  if (toolName === BASH_TOOL && !writeEffect) return;

  const targetPath = writeEffect?.path ?? extractWritePath(input.tool_input);
  if (!isWorkspaceWritePath(targetPath, cwd)) {
    recordAuditEvent({ at: now, session: sessionId, event: "write", lane: MAIN_LANE, tool: toolName }, env);
    return;
  }

  const auditPath = extractAuditWritePath(targetPath, cwd);
  const decision = withStateLock(file, () => {
    const state = normalizeState(readState(file), now);
    if (toolUseId && state.pendingWrites.some((entry) => entry.id === toolUseId && entry.tool === toolName)) return { duplicate: true };
    state.writeCount += 1;
    state.writesSinceDispatch += 1;
    if (state.turn && state.turn.key !== state.writeTurnKey) {
      const before = state.writeReplayTokens;
      state.writeReplayTokens = Math.min(Number.MAX_SAFE_INTEGER, before + state.turn.tokens);
      state.writeTurnKey = state.turn.key;
      state.writeTurnTokens = state.writeReplayTokens - before;
      state.writeTurnWrites = 0;
    }
    state.writeTurnWrites += 1;
    if (toolUseId) state.pendingWrites.push({ id: toolUseId, tool: toolName, epoch: state.dispatchEpoch, turn: state.writeTurnKey });
    writeState(file, state);
    return { writeCount: state.writesSinceDispatch, replayTokens: state.writeReplayTokens };
  });

  if (decision.duplicate) return;
  recordAuditEvent({ at: now, session: sessionId, event: "write", lane: MAIN_LANE, tool: toolName, ...(auditPath ? { path: auditPath } : {}), writeCount: decision.writeCount, replayTokens: decision.replayTokens, budget: resolveReplayBudgetTokens(env) }, env);
}

export { handleWrite };
