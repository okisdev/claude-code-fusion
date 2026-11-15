import { messageCode, tagMessage } from "../user-messages.mjs";
import { recordAuditEvent } from "./audit.mjs";
import { BASH_TOOL, DELEGATION_TOOLS, MAIN_LANE, READ_STREAK_ADVISORY_MESSAGE_SLUG, READ_STREAK_ADVISORY_REASON, WRITE_TOOLS } from "./constants.mjs";
import { crossedBudgetMultiple, formatTokens, resolveReplayBudgetTokens } from "./replay.mjs";

function updateReadStreak(state, env, { toolName, turn }) {
  const isRead = turn.kind === "read";
  const isReset = !isRead && (toolName === BASH_TOOL || WRITE_TOOLS.has(toolName) || DELEGATION_TOOLS.has(toolName));
  if (!isRead && !isReset) return null;
  const budget = resolveReplayBudgetTokens(env);
  const before = state.readStreakReplayTokens;
  if (isReset) {
    state.readStreakTurns = 0;
    state.readStreakReplayTokens = 0;
  } else if (turn.newTurn) {
    state.readStreakTurns = Math.min(Number.MAX_SAFE_INTEGER, state.readStreakTurns + 1);
    state.readStreakReplayTokens = Math.min(Number.MAX_SAFE_INTEGER, before + turn.tokens);
  }
  return crossedBudgetMultiple(before, state.readStreakReplayTokens, budget) ? { turns: state.readStreakTurns, tokens: state.readStreakReplayTokens, budget } : null;
}

function handleReadStreak(env, { sessionId, toolName, now, turn }) {
  const advisory = turn?.readStreak;
  if (!advisory) return null;
  const { turns, tokens, budget } = advisory;
  recordAuditEvent({ at: now, session: sessionId, event: "warn", reason: READ_STREAK_ADVISORY_REASON, replayTokens: tokens, budget, messageCode: messageCode(READ_STREAK_ADVISORY_MESSAGE_SLUG), lane: MAIN_LANE, tool: toolName }, env);
  return tagMessage(READ_STREAK_ADVISORY_MESSAGE_SLUG, `${turns} read only ${turns === 1 ? "turn" : "turns"} in a row replayed ${formatTokens(tokens)} tokens of context. Batch independent reads into one message, and send open ended reconnaissance to Explore.`);
}

export { handleReadStreak, updateReadStreak };
