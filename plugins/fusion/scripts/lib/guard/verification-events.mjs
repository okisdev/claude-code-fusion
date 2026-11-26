import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINES } from "../engines.mjs";
import { engineHealth } from "../engine-health.mjs";
import { readRoutingDefaults } from "../model-table.mjs";
import { acceptVerifiedWorker } from "../stats/settlement.mjs";
import { messageCode, tagMessage } from "../user-messages.mjs";
import { appendToolResponseText, commandSegments, isVerificationCommand, verificationEvidence, verificationResponseFailed } from "../verification-command.mjs";
import { isPendingSettlement, readSessionWorkerRecords, readWorkerRecord } from "../worker-state.mjs";
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
const LITERAL_CD = /^cd\s+(?:--\s+)?(?:'([^']+)'|"([^"\\$`]+)"|((?:\\.|[^\s"'\\;&|$`~*?\[\]{}<>()#!])+))$/;

function verificationSteps(command) {
  const segments = commandSegments(command);
  let directory = null;
  if (/^cd(?:\s|$)/.test(segments[0]?.command) && segments[1]?.separator === "&&") {
    const cd = segments.shift().command.match(LITERAL_CD);
    if (!cd) return null;
    directory = cd[1] ?? cd[2] ?? cd[3].replace(/\\(.)/g, "$1");
    if (directory === "-") return null;
  }
  const pipelines = [];
  for (const segment of segments) {
    if (!segment.command || /^(?:cd|pushd|popd)(?:\s|$)/.test(segment.command)) return null;
    if (segment.separator === "|" && pipelines.length) {
      pipelines.at(-1).push(segment.command);
    } else if (segment.separator === null || segment.separator === "&&") {
      pipelines.push([segment.command]);
    } else {
      return null;
    }
  }
  const steps = pipelines.map((pipeline) => {
    while (pipeline.length > 1 && /^(?:tail|head|grep)(?:\s|$)/.test(pipeline.at(-1))) pipeline.pop();
    return pipeline.join(" | ").replace(/\s+2>&1$/, "").replace(/\s+/g, " ");
  });
  return steps.length ? { steps, directory } : null;
}

function bashVerificationStart(input, file, now) {
  const id = input.tool_use_id;
  if (typeof id !== "string" || !id) return null;
  const key = createHash("sha256").update(file).update("\0").update(id).digest("hex");
  const startFile = path.join(path.dirname(file), `.bash-${key}.json`);
  try {
    return withStateLock(startFile, () => {
      const start = readState(startFile);
      if (input.hook_event_name === "PreToolUse") {
        if (!start) writeState(startFile, { at: now });
      } else if (start) {
        fs.unlinkSync(startFile);
        return Date.parse(start.at);
      }
      return null;
    });
  } catch {
    return null;
  }
}

function settleVerifiedPackages(env, { sessionId, command, cwd, startedAt, file, now, writeHookText }) {
  if (!Number.isFinite(startedAt) || typeof cwd !== "string" || !path.isAbsolute(cwd)) return;
  const executed = verificationSteps(command);
  if (!executed) return;
  const directory = fs.realpathSync(path.resolve(cwd, executed.directory ?? "."));
  const deadline = Date.now() + 2000;
  const settled = [];
  const pendingDelivery = [];
  for (const record of readSessionWorkerRecords(env, sessionId)) {
    if (!isPendingSettlement(record) || record.packageType !== "implementation" || record.transportStatus !== "done") continue;
    if (record.peerTransportStatus && !["done", "completed"].includes(record.peerTransportStatus)) continue;
    if (!(Date.parse(record.collectedAt) < startedAt && Date.parse(record.finishedAt) < startedAt)) continue;
    if (!isVerificationCommand(record.verificationCommand, env)) continue;
    const required = verificationSteps(record.verificationCommand);
    if (!required || !required.steps.every((step) => executed.steps.includes(step))) continue;
    try {
      if (directory !== fs.realpathSync(record.companionCwd ?? record.workspaceRoot)) continue;
      if (required.directory && directory !== fs.realpathSync(path.resolve(cwd, required.directory))) continue;
      const worker = acceptVerifiedWorker(record, env, deadline);
      if (worker?.acceptance !== "accepted") continue;
      settled.push(worker.taskId);
      if (["pending", "failed"].includes(worker.engineAcceptanceDelivery?.status)) pendingDelivery.push(worker.taskId);
    } catch {
      continue;
    }
  }
  if (settled.length === 0) return;
  try {
    suggestSettledWaveReview(env, { sessionId, file, now, writeHookText });
  } catch {}
  const script = fileURLToPath(new URL("../../fusion-stats.mjs", import.meta.url));
  const pairs = settled.map((id) => `${id}=rejected`).join(" ");
  const delivery = pendingDelivery.length ? ` Peer acceptance delivery is pending for ${pendingDelivery.join(", ")}.` : "";
  writeHookText(JSON.stringify(postToolAdvisoryOutput(`Verification passed. Automatically accepted ${settled.join(", ")}.${delivery} To override, run: node "${script}" --record ${pairs} --reason "explain the rejection"`)));
}

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
  const agyHealthy = engineHealth("agy", "consult", null, { env, now: nowMs, sessionId }).healthy;
  const engine = agyHealthy ? "agy" : readRoutingDefaults(env, { warn: null }).breadth;
  const role = agyHealthy ? "independence" : "diversity";
  return `Wave settled. Dispatch one cross family read only review of this wave's changed files now, in the same message as your next work: ${ENGINES[engine].rescueAgent} with header \`${engine}-role: ${role} | read only | acceptance: findings cite file:line\`, naming the changed files in the brief.`;
}

function suggestSettledWaveReview(env, { sessionId, file, now, writeHookText }) {
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
    const foregroundVerification = !input.tool_input?.run_in_background && isVerificationCommand(command, env);
    const startedAt = foregroundVerification && ["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(input.hook_event_name)
      ? bashVerificationStart(input, file, now) : null;
    if (input.hook_event_name === "PostToolUse") {
      const toolResponse = input.tool_response;
      if (command === null) {
        return;
      }
      if (settledAcceptedImplementationTaskId(command, toolResponse, env) !== null) {
        suggestSettledWaveReview(env, { sessionId, file, now, writeHookText });
      }
      if (!foregroundVerification) return;
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
      try {
        settleVerifiedPackages(env, { sessionId, command, cwd: input.cwd, startedAt, file, now, writeHookText });
      } catch {}
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
