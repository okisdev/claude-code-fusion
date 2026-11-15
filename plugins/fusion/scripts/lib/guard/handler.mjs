import { resolvePosture } from "../posture.mjs";
import { tagMessage } from "../user-messages.mjs";
import { bashWriteEffect } from "./bash-effect.mjs";
import { resolveMode, resolveStateDir } from "./config.mjs";
import { BASH_TOOL, DELEGATION_TOOLS, READ_TOOLS, STATE_UNAVAILABLE_DENY_MESSAGE_SLUG, TASK_CONTROL_TOOLS, WRITE_TOOLS } from "./constants.mjs";
import { handleDispatch, handleTaskControl } from "./dispatch-events.mjs";
import { handleReadStreak } from "./read-streak.mjs";
import { normalizeSessionId, pruneStaleState, stateFile } from "./state.mjs";
import { recordTurn } from "./turn.mjs";
import { extractBashCommand } from "./verification.mjs";
import { handleBash } from "./verification-events.mjs";
import { handleWrite } from "./write-events.mjs";
import { advisoryOutput, denyOutput, extractWritePath, isWorkspaceWritePath } from "./write.mjs";
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

let hookOutputSink = (text) => process.stdout.write(text);

function writeHookText(text) {
  hookOutputSink(text);
}

function runHook(env = process.env, input = readHookInput()) {
  if (!input) {
    return;
  }
  if (isSubagentPayload(input)) {
    return;
  }
  const sessionId = normalizeSessionId(input.session_id);
  const toolName = input.tool_name;
  const cwd = input.cwd;
  if (!sessionId || typeof toolName !== "string" || !toolName) {
    return;
  }

  const stateDir = resolveStateDir(env);
  pruneStaleState(stateDir);
  const file = stateFile(stateDir, sessionId);
  const now = new Date().toISOString();
  const posture = resolvePosture(env);
  const turn = recordTurn(input, env, { sessionId, toolName, file, now, cwd });
  const readContext = handleReadStreak(input, env, { sessionId, toolName, file, now, posture, turn });
  if (readContext && toolName !== BASH_TOOL) {
    writeHookText(`${JSON.stringify(advisoryOutput(readContext))}\n`);
  }

  if (DELEGATION_TOOLS.has(toolName)) {
    handleDispatch(input, env, { sessionId, toolName, file, now, posture, writeHookText });
    return;
  }
  if (TASK_CONTROL_TOOLS.has(toolName)) {
    handleTaskControl(input, env, { sessionId, toolName, file, now, posture, writeHookText });
    return;
  }
  if (toolName === BASH_TOOL) {
    let bashOutput = "";
    const writeEffect = bashWriteEffect(extractBashCommand(input.tool_input), cwd);
    if (writeEffect || input.hook_event_name === "PostToolUse" || input.hook_event_name === "PostToolUseFailure") {
      handleWrite(input, env, { sessionId, toolName, file, now, posture, cwd, writeEffect, writeHookText: (text) => { bashOutput += text; } });
    }
    handleBash(input, env, { sessionId, toolName, file, now, posture, writeHookText: (text) => { bashOutput += text; } });
    if (readContext) {
      const output = bashOutput ? JSON.parse(bashOutput) : advisoryOutput(readContext);
      if (bashOutput) output.hookSpecificOutput.additionalContext = [output.hookSpecificOutput.additionalContext, readContext].filter(Boolean).join("\n");
      writeHookText(`${JSON.stringify(output)}\n`);
    } else if (bashOutput) {
      writeHookText(bashOutput);
    }
    return;
  }
  if (READ_TOOLS.has(toolName)) return;
  handleWrite(input, env, { sessionId, toolName, file, now, posture, cwd, writeHookText });
}

function executeHook(input, env = process.env) {
  try {
    runHook(env, input ?? null);
  } catch {
    const writeEffect = input?.tool_name === BASH_TOOL ? bashWriteEffect(extractBashCommand(input.tool_input), input.cwd) : null;
    const targetPath = writeEffect?.path ?? extractWritePath(input?.tool_input);
    if (resolveMode(env) === "enforce" && input && !isSubagentPayload(input) && (WRITE_TOOLS.has(input.tool_name) || writeEffect) && isWorkspaceWritePath(targetPath, input.cwd)) {
      writeHookText(
        `${JSON.stringify(
          denyOutput(
            tagMessage(STATE_UNAVAILABLE_DENY_MESSAGE_SLUG, "Fusion inline write state is unavailable. Retry after restoring private guard state access.")
          )
        )}\n`
      );
    }
  }
}

function handleInlineDelegationHook(input, env = process.env) {
  let stdout = "";
  const previousSink = hookOutputSink;
  hookOutputSink = (text) => { stdout += text; };
  try {
    executeHook(input, env);
    return { stdout, stderr: "", exitCode: 0 };
  } finally {
    hookOutputSink = previousSink;
  }
}

export { readHookInput, isSubagentPayload, writeHookText, runHook, executeHook, handleInlineDelegationHook };
