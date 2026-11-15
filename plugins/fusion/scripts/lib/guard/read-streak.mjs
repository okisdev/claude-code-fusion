import { messageCode, tagMessage } from "../user-messages.mjs";
import { recordAuditEvent } from "./audit.mjs";
import { BASH_TOOL, DELEGATION_TOOLS, MAIN_LANE, READ_STREAK_ADVISORY_MESSAGE_SLUG, READ_STREAK_ADVISORY_REASON, WRITE_TOOLS } from "./constants.mjs";
import { crossedBudgetMultiple, formatTokens, resolveReplayBudgetTokens } from "./replay.mjs";
import { normalizeState, readState, withAvailableStateLock, writeState } from "./state.mjs";

function handleReadStreak(input, env, { sessionId, toolName, file, now, posture, turn }) {
  if (Object.hasOwn(input, "agent_id")) return null;
  if (input.hook_event_name && input.hook_event_name !== "PreToolUse") return null;
  if (!turn) return null;
  const isRead = turn.kind === "read";
  const isReset = !isRead && (toolName === BASH_TOOL || WRITE_TOOLS.has(toolName) || DELEGATION_TOOLS.has(toolName));
  if (!isRead && !isReset) return null;
  const budget = resolveReplayBudgetTokens(env);
  const advisory = withAvailableStateLock(file, () => {
    const existing = readState(file);
    if (!isRead && !existing?.readStreakTurns && !existing?.readStreakReplayTokens) return null;
    const state = normalizeState(existing, now);
    const before = state.readStreakReplayTokens;
    if (isReset) {
      state.readStreakTurns = 0;
      state.readStreakReplayTokens = 0;
    } else if (turn.newTurn) {
      state.readStreakTurns = Math.min(Number.MAX_SAFE_INTEGER, state.readStreakTurns + 1);
      state.readStreakReplayTokens = Math.min(Number.MAX_SAFE_INTEGER, before + turn.tokens);
    }
    writeState(file, state);
    return crossedBudgetMultiple(before, state.readStreakReplayTokens, budget) ? { turns: state.readStreakTurns, tokens: state.readStreakReplayTokens } : null;
  });
  if (!advisory) return null;
  const { turns, tokens } = advisory;
  recordAuditEvent({ at: now, session: sessionId, event: "warn", reason: READ_STREAK_ADVISORY_REASON, streakTurns: turns, replayTokens: tokens, budget, posture, messageCode: messageCode(READ_STREAK_ADVISORY_MESSAGE_SLUG), lane: MAIN_LANE, tool: toolName }, env);
  return tagMessage(READ_STREAK_ADVISORY_MESSAGE_SLUG, `${turns} read only ${turns === 1 ? "turn" : "turns"} in a row replayed ${formatTokens(tokens)} tokens of context. Batch independent reads into one message, and send open ended reconnaissance to Explore.`);
}

export { handleReadStreak };
