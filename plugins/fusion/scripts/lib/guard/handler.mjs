import { bashWriteEffect } from "./bash-effect.mjs";
import { hookResult, mergeHookResults } from "../lifecycle/output.mjs";
import { claimPendingWaveReview } from "../lifecycle/wave-review.mjs";
import { resolveStateDir } from "./config.mjs";
import { BASH_TOOL, DELEGATION_TOOLS, READ_TOOLS, TASK_CONTROL_TOOLS } from "./constants.mjs";
import { handleDispatch, handleTaskControl } from "./dispatch-events.mjs";
import { handleReadStreak } from "./read-streak.mjs";
import { normalizeSessionId, pruneStaleState, stateFile } from "./state.mjs";
import { recordTurn } from "./turn.mjs";
import { extractBashCommand } from "./verification.mjs";
import { handleBash } from "./verification-events.mjs";
import { handleWrite } from "./write-events.mjs";
import fs from "node:fs";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isSubagentPayload(input) {
  return typeof input.agent_id === "string" && input.agent_id.length > 0;
}

function runHook(env = process.env, input = readHookInput()) {
  if (!input) {
    return {};
  }
  if (isSubagentPayload(input)) {
    return {};
  }
  const sessionId = normalizeSessionId(input.session_id);
  const toolName = input.tool_name;
  const cwd = input.cwd;
  if (!sessionId || typeof toolName !== "string" || !toolName) {
    return {};
  }

  const stateDir = resolveStateDir(env);
  pruneStaleState(stateDir);
  const file = stateFile(stateDir, sessionId);
  const now = new Date().toISOString();
  const turn = recordTurn(input, env, { sessionId, toolName, file, now, cwd });
  const readContext = handleReadStreak(env, { sessionId, toolName, now, turn });
  const result = readContext ? { additionalContext: readContext } : {};

  if (DELEGATION_TOOLS.has(toolName)) {
    return mergeHookResults(result, handleDispatch(input, env, { sessionId, toolName, file, now }));
  }
  if (TASK_CONTROL_TOOLS.has(toolName)) {
    return mergeHookResults(result, handleTaskControl(input, env, { sessionId, toolName, file, now }));
  }
  if (toolName === BASH_TOOL) {
    let bashResult = {};
    const writeEffect = bashWriteEffect(extractBashCommand(input.tool_input), cwd);
    if (writeEffect || input.hook_event_name === "PostToolUse" || input.hook_event_name === "PostToolUseFailure") {
      handleWrite(input, env, { sessionId, toolName, file, now, cwd, writeEffect });
    }
    handleBash(input, env, { sessionId, toolName, file, now, writeHookText: (text) => { bashResult = mergeHookResults(bashResult, hookResult(JSON.parse(text))); } });
    return mergeHookResults(bashResult, result);
  }
  if (READ_TOOLS.has(toolName)) return result;
  handleWrite(input, env, { sessionId, toolName, file, now, cwd });
  return result;
}

function executeHook(input, env = process.env) {
  try {
    const result = runHook(env, input ?? null);
    const review = input?.hook_event_name === "PostToolUse" && claimPendingWaveReview(input, env);
    return review ? mergeHookResults(result, { additionalContext: review }) : result;
  } catch {
    return {};
  }
}

function handleInlineDelegationHook(input, env = process.env) {
  return executeHook(input, env);
}

export { readHookInput, isSubagentPayload, runHook, executeHook, handleInlineDelegationHook };
