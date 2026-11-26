import { createHash } from "node:crypto";
import { isVerificationCommand } from "../verification-command.mjs";
import { appendAuditEvent, recordAuditEvent } from "./audit.mjs";
import { bashWriteEffect, isReadOnlyBash } from "./bash-effect.mjs";
import { BASH_TOOL, DELEGATION_TOOLS, MAIN_LANE, READ_TOOLS, WRITE_TOOLS } from "./constants.mjs";
import { updateReadStreak } from "./read-streak.mjs";
import { isNewTurn, outranksReplayKind, readTurn, turnReplayTokens } from "./replay.mjs";
import { normalizeSessionId, normalizeState, readState, stateFile, withAvailableStateLock, withStateLock, writeState } from "./state.mjs";
import { resolveStateDir } from "./config.mjs";
import { assistantPages, readTranscript, usageContextTokens } from "./transcript.mjs";
import { normalizeMessageId, transcriptEntryContent, extractBashCommand } from "./verification.mjs";
import { extractWritePath, isWorkspaceWritePath } from "./write.mjs";

function replayKind(toolName, toolInput, cwd, env) {
  const command = toolName === BASH_TOOL ? extractBashCommand(toolInput) : null;
  return DELEGATION_TOOLS.has(toolName) ? "dispatch" :
    (WRITE_TOOLS.has(toolName) && isWorkspaceWritePath(extractWritePath(toolInput), cwd)) ||
      (toolName === BASH_TOOL && bashWriteEffect(command, cwd) !== null) ? "write" :
    toolName === BASH_TOOL && isVerificationCommand(command, env) ? "verify" :
    toolName === BASH_TOOL && /(?:^|[\s/'"])fusion-stats\.mjs(?=[\s'"]|$)/.test(command) && /(?:^|\s)--record(?=[=\s]|$)/.test(command) ? "settle" :
    READ_TOOLS.has(toolName) || (toolName === BASH_TOOL && isReadOnlyBash(command)) ? "read" : "other";
}

function toolSignature(name, input) {
  const call = JSON.stringify([name, input ?? {}], (_, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
  return createHash("sha256").update(call).digest("hex");
}

function recordTurn(input, env, { sessionId, toolName, file, now, cwd }) {
  if (Object.hasOwn(input, "agent_id")) return null;
  if (input.hook_event_name && input.hook_event_name !== "PreToolUse") return null;
  const kind = replayKind(toolName, input.tool_input, cwd, env);
  const lock = kind === "read" ? withAvailableStateLock : withStateLock;
  return lock(file, () => {
    const state = normalizeState(readState(file), now);
    const turn = readTurn(input.transcript_path, input.tool_use_id, state.lastMeasuredTokens);
    state.lastMeasuredTokens = turn.contextTokens;
    const newTurn = isNewTurn(state.turn, turn, now);
    const raisedKind = !newTurn && outranksReplayKind(kind, state.turn.kind);
    if (newTurn) {
      state.turn = { id: turn.id, key: turn.id ?? "t:" + Date.parse(now), at: now, kind, tokens: turnReplayTokens(turn), measured: turn.contextTokens != null };
    } else {
      state.turn.at = now;
      state.turn.id ??= turn.id;
      if (raisedKind) state.turn.kind = kind;
    }
    const id = normalizeMessageId(input.tool_use_id);
    if (!id || !state.replayTools.some((tool) => tool.id === id)) {
      state.replayTools.push({
        id, key: state.turn.key, measured: state.turn.measured,
        ...(id ? {} : { signature: toolSignature(toolName, input.tool_input) })
      });
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

function stoppedMessages(fd, size, input, state, env) {
  const messages = new Map();
  const priced = new Map(state.replayTools.filter((tool) => tool.id).map((tool) => [tool.id, tool]));
  const anonymous = Map.groupBy(state.replayTools.filter((tool) => !tool.id), (tool) => tool.signature);
  const since = state.lastStopTurn?.startsWith("t:") ? Number(state.lastStopTurn.slice(2)) : null;
  scan: for (const entries of assistantPages(fd, size, Infinity)) {
    for (const { entry, offset } of entries) {
      const id = normalizeMessageId(entry.message?.id) ?? normalizeMessageId(entry.requestId) ?? normalizeMessageId(entry.uuid) ?? `line:${offset}`;
      const time = Date.parse(entry.timestamp);
      if (id === state.lastStopTurn || (since !== null && time <= since)) break scan;
      if (state.lastStopTurn && !Number.isFinite(time)) continue;
      const message = messages.get(id) ?? { id, at: entry.timestamp, tokens: null, tool: "Stop", kind: null, priced: new Set() };
      message.tokens ??= usageContextTokens(entry.message?.usage) || null;
      for (const block of transcriptEntryContent(entry)) {
        if (block?.type !== "tool_use") continue;
        let prior = priced.get(block.id);
        if (!prior && anonymous.size) {
          const signature = toolSignature(block.name, block.input);
          const calls = anonymous.get(signature);
          prior = calls?.pop();
          if (calls?.length === 0) anonymous.delete(signature);
          if (prior && block.id) priced.set(block.id, prior);
        }
        if (prior) message.priced.add(prior);
        const kind = replayKind(block.name, block.input, input.cwd, env);
        if (outranksReplayKind(kind, message.kind)) {
          message.tool = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(block.name ?? "") ? block.name : "Stop";
          message.kind = kind;
        }
      }
      messages.set(id, message);
    }
  }
  return [...messages.values()].reverse();
}

function recordStoppedTurns(input, env) {
  const session = normalizeSessionId(input.session_id);
  if (!session || !input.transcript_path || Object.hasOwn(input, "agent_id")) return;
  const file = stateFile(resolveStateDir(env), session);
  withStateLock(file, () => {
    const now = new Date().toISOString();
    const state = normalizeState(readState(file), now);
    const messages = readTranscript(input.transcript_path, (fd, size) => stoppedMessages(fd, size, input, state, env));
    if (!messages?.length) return;
    const matched = new Set();
    try {
      for (const { id, at, tokens, tool, kind, priced } of messages) {
        const prior = [...priced].filter((entry) => !matched.has(entry.key));
        if (!prior.some((entry) => entry.measured)) {
          if (!tokens) continue;
          appendAuditEvent({
            at: Number.isFinite(Date.parse(at)) ? at : now, session, event: "replay", lane: MAIN_LANE,
            tool: prior.length ? "Stop" : tool, turn: prior[0]?.key ?? id, kind: kind ?? "other", tokens, measured: true
          }, env);
        }
        for (const entry of prior) matched.add(entry.key);
        if (tokens) state.lastMeasuredTokens = tokens;
        state.lastStopTurn = id;
      }
    } finally {
      if (matched.has(state.turn?.key)) state.turn = null;
      state.replayTools = state.replayTools.filter((tool) => !matched.has(tool.key));
      writeState(file, state);
    }
  });
}

export { recordTurn, recordStoppedTurns };
