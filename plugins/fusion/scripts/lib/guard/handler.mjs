import { resolvePosture } from "../posture.mjs";
import { tagMessage } from "../user-messages.mjs";
import { resolveMode, resolveStateDir } from "./config.mjs";
import { ALLOW_RETIRED_NOTICE_MESSAGE_SLUG, BASH_TOOL, DELEGATION_TOOLS, STATE_UNAVAILABLE_DENY_MESSAGE_SLUG, TASK_CONTROL_TOOLS, WRITE_TOOLS } from "./constants.mjs";
import { handleDispatch, handleTaskControl } from "./dispatch-events.mjs";
import { normalizeSessionId, pruneStaleState, stateFile } from "./state.mjs";
import { handleBash } from "./verification-events.mjs";
import { handleWrite } from "./write-events.mjs";
import { denyOutput, extractWritePath, isWorkspaceWritePath } from "./write.mjs";
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

function runAllowCommand() {
  process.stdout.write(
    `${tagMessage(
      ALLOW_RETIRED_NOTICE_MESSAGE_SLUG,
      "fusion inline delegation guard: the allow escape hatch is retired; judgment posture never denies a main-loop write, and strict posture opens the next write window with a dispatch; /fusion:config set-posture judgment restores the advisory default"
    )}\n`
  );
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

  if (DELEGATION_TOOLS.has(toolName)) {
    handleDispatch(input, env, { sessionId, toolName, file, now, posture, writeHookText });
    return;
  }
  if (TASK_CONTROL_TOOLS.has(toolName)) {
    handleTaskControl(input, env, { sessionId, toolName, file, now, posture, writeHookText });
    return;
  }
  if (toolName === BASH_TOOL) {
    handleBash(input, env, { sessionId, toolName, file, now, posture, writeHookText });
    return;
  }
  handleWrite(input, env, { sessionId, toolName, file, now, posture, cwd, writeHookText });
}

function executeHook(input, env = process.env) {
  try {
    runHook(env, input ?? null);
  } catch {
    const targetPath = extractWritePath(input?.tool_input);
    if (resolveMode(env) === "enforce" && input && !isSubagentPayload(input) && WRITE_TOOLS.has(input.tool_name) && isWorkspaceWritePath(targetPath, input.cwd)) {
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

export { readHookInput, isSubagentPayload, runAllowCommand, writeHookText, runHook, executeHook, handleInlineDelegationHook };
