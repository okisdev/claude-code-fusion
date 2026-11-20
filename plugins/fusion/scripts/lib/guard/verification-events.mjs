import { ENGINES } from "../engines.mjs";
import { engineHealth } from "../engine-health.mjs";
import { readRoutingDefaults } from "../model-table.mjs";
import { messageCode, tagMessage } from "../user-messages.mjs";
import { appendToolResponseText, verificationEvidence, verificationResponseFailed } from "../verification-command.mjs";
import { readWorkerRecord } from "../worker-state.mjs";
import { recordAuditEvent } from "./audit.mjs";
import { BASH_TOOL, MAIN_LANE, NO_OP_BASH_COMMANDS, NO_OP_HEARTBEAT_DENY_MESSAGE_SLUG, NO_OP_HEARTBEAT_REASON } from "./constants.mjs";
import { inFlightWorkerTaskSignature, totalDispatches } from "./dispatch.mjs";
import { resolveReplayBudgetTokens } from "./replay.mjs";
import { normalizeState, readState, resetWriteWindow, withStateLock, writeState } from "./state.mjs";
import { extractBashCommand } from "./verification.mjs";
import { denyOutput, postToolAdvisoryOutput } from "./write.mjs";

const SETTLE_COMMAND_PATTERN = /(?:^|[\s/'"])fusion-stats\.mjs(?=[\s'"]|$)/;
const SETTLE_RECORD_PATTERN = /(?:^|\s)--record(?=[=\s]|$)/;
const ACCEPTED_TASK_ID_PATTERN = /(?:^|[\s'"])(fusion-[0-9a-f]{24})=accepted(?::accept-failed-transport)?(?=[\s'";|&)]|$)/g;
const SETTLED_ACCEPTANCE_PATTERN = /\bRecorded accepted\b|"acceptance"\s*:\s*"accepted"/;
const WAVE_REVIEW_SUGGESTION_MS = 30 * 60 * 1000;

function settledAcceptedImplementationTaskId(command, toolResponse, env) {
  if (!SETTLE_COMMAND_PATTERN.test(command) || !SETTLE_RECORD_PATTERN.test(command) || verificationResponseFailed(toolResponse ?? {})) {
    return null;
  }
  const parts = [];
  appendToolResponseText(toolResponse, parts);
  if (!SETTLED_ACCEPTANCE_PATTERN.test(parts.join("\n"))) {
    return null;
  }
  for (const match of command.matchAll(ACCEPTED_TASK_ID_PATTERN)) {
    if (readWorkerRecord(match[1], env)?.packageType === "implementation") {
      return match[1];
    }
  }
  return null;
}

function waveReviewSuggestion(env, sessionId, nowMs) {
  const breadth = readRoutingDefaults(env, { warn: null }).breadth;
  const consultHealthy = engineHealth(breadth, "consult", null, { env, now: nowMs, sessionId }).healthy;
  const engine = consultHealthy ? breadth : "agy";
  const role = consultHealthy ? "diversity" : "independence";
  return `Wave settled. Dispatch one cross family review of the working tree diff now, in the same message as your next work: ${ENGINES[engine].rescueAgent} with header \`${engine}-role: ${role} | operation: review | acceptance: findings cite file:line\`.`;
}

function suggestSettledWaveReview(env, { sessionId, command, toolResponse, file, now, writeHookText }) {
  if (settledAcceptedImplementationTaskId(command, toolResponse, env) === null) {
    return;
  }
  const context = waveReviewSuggestion(env, sessionId, Date.parse(now));
  const claimed = withStateLock(file, () => {
    const state = normalizeState(readState(file), now);
    const lastMs = Date.parse(state.reviewSuggestedAt ?? "");
    if (Number.isFinite(lastMs) && Date.parse(now) - lastMs < WAVE_REVIEW_SUGGESTION_MS) {
      return false;
    }
    state.reviewSuggestedAt = now;
    writeState(file, state);
    return true;
  });
  if (claimed) {
    writeHookText(JSON.stringify(postToolAdvisoryOutput(context)));
  }
}

function handleBash(input, env, { sessionId, toolName, file, now, writeHookText }) {
  if (toolName === BASH_TOOL) {
    const command = extractBashCommand(input.tool_input);
    if (input.hook_event_name === "PostToolUse") {
      const toolResponse = input.tool_response;
      if (command === null) {
        return;
      }
      suggestSettledWaveReview(env, { sessionId, command, toolResponse, file, now, writeHookText });
      const evidence = verificationEvidence(command, toolResponse, env);
      if (!evidence) {
        return;
      }
      const verification = withStateLock(file, () => {
        const state = normalizeState(readState(file), now);
        const writeCount = state.writesSinceDispatch;
        const replayTokens = state.writeReplayTokens;
        const dispatchCount = totalDispatches(state.dispatches);
        resetWriteWindow(state);
        writeState(file, state);
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
        messageCode: messageCode(NO_OP_HEARTBEAT_DENY_MESSAGE_SLUG)
      },
      env
    );
    writeHookText(`${JSON.stringify(denyOutput(tagMessage(NO_OP_HEARTBEAT_DENY_MESSAGE_SLUG, NO_OP_HEARTBEAT_REASON)))}\n`);
    return;
  }
}

export { handleBash };
