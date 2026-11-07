import { messageCode, tagMessage } from "../user-messages.mjs";
import { recordAuditEvent } from "./audit.mjs";
import { BASH_TOOL, DELEGATION_TOOLS, MAIN_LANE, READ_STREAK_ADVISORY_MESSAGE_SLUG, READ_STREAK_ADVISORY_REASON, WRITE_TOOLS } from "./constants.mjs";
import { normalizeState, readState, withAvailableStateLock, writeState } from "./state.mjs";

const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const READ_COMMANDS = new Set(["cd", "cat", "grep", "rg", "head", "tail", "ls", "wc", "awk", "nl", "jq", "tree"]);

function splitReadSegments(command) {
  if (typeof command !== "string" || !command.trim()) return null;
  const segments = [];
  let segment = "";
  let quote = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      segment += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      segment += char;
      continue;
    }
    if (quote) {
      if (quote === '"' && (char === "`" || (char === "$" && command[index + 1] === "("))) return null;
      if (char === quote) quote = null;
      segment += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      segment += char;
      continue;
    }
    if (char === ">" && /(?:^|\s)2$/.test(segment) && /^(?:\/dev\/null|&1)(?=\s|$)/.test(command.slice(index + 1))) {
      const target = /^(?:\/dev\/null|&1)/.exec(command.slice(index + 1))[0];
      segment += `>${target}`;
      index += target.length;
      continue;
    }
    if (char === ">" || char === "`" || char === "\n" || char === "\r" || (char === "$" && command[index + 1] === "(") ||
      (char === "&" && command[index + 1] !== "&") || (char === "|" && command[index + 1] === "|")) return null;
    if (char === ";" || char === "|" || (char === "&" && command[index + 1] === "&")) {
      if (!segment.trim()) return null;
      segments.push(segment.trim());
      segment = "";
      if (char === "&") index += 1;
      continue;
    }
    segment += char;
  }
  if (quote || escaped || !segment.trim()) return null;
  segments.push(segment.trim());
  return segments;
}

function isReadOnlyBash(command) {
  const segments = splitReadSegments(command);
  if (!segments) return false;
  return segments.every((segment) => {
    const [name, ...rawArgs] = segment.split(/\s+/);
    const args = rawArgs.map((arg) => arg.replace(/^['"]|['"]$/g, ""));
    if (name === "awk") return !args.some((arg) => /[>|]|\bsystem\b/.test(arg));
    if (READ_COMMANDS.has(name)) return true;
    if (name === "sed") return !args.some((arg) => /^-[^-]*i/.test(arg) || arg.startsWith("--in-place") || /(?:^|[;{]|\d)\s*w(?:\s|$)|\/w(?:\s|$)/.test(arg));
    if (name === "find") return !args.some((arg) => /^-(?:delete|exec(?:dir)?|ok(?:dir)?|fprint|fprintf|fls)$/.test(arg));
    if (name === "git") return ["diff", "show", "log", "status", "grep", "blame"].includes(args[0]);
    if (name === "gh") return ["pr:view", "pr:diff", "issue:view", "run:view"].includes(`${args[0]}:${args[1]}`);
    return false;
  });
}

function isAdvisoryTurn(turns) {
  return turns >= 5 && Number.isInteger(Math.log2(turns / 5));
}

function handleReadStreak(input, env, { sessionId, toolName, file, now, posture }) {
  if (Object.hasOwn(input, "agent_id")) return null;
  if (input.hook_event_name && input.hook_event_name !== "PreToolUse") return null;
  const isRead = READ_TOOLS.has(toolName) || (toolName === BASH_TOOL && isReadOnlyBash(input.tool_input?.command));
  const isReset = !isRead && (toolName === BASH_TOOL || WRITE_TOOLS.has(toolName) || DELEGATION_TOOLS.has(toolName));
  if (!isRead && !isReset) return null;
  const turns = withAvailableStateLock(file, () => {
    const existing = readState(file);
    if (!isRead && !existing?.readStreakTurns) return 0;
    const state = normalizeState(existing, now);
    let newTurn = false;
    if (isReset) {
      state.readStreakTurns = 0;
      state.lastReadAt = null;
    } else {
      const elapsed = Date.parse(now) - Date.parse(state.lastReadAt);
      newTurn = !(elapsed >= 0 && elapsed <= 1500);
      if (newTurn) state.readStreakTurns += 1;
      state.lastReadAt = now;
    }
    writeState(file, state);
    return newTurn && isAdvisoryTurn(state.readStreakTurns) ? state.readStreakTurns : 0;
  });
  if (!turns) return null;
  recordAuditEvent({ at: now, session: sessionId, event: "warn", reason: READ_STREAK_ADVISORY_REASON, streakTurns: turns, posture, messageCode: messageCode(READ_STREAK_ADVISORY_MESSAGE_SLUG), lane: MAIN_LANE, tool: toolName }, env);
  return tagMessage(READ_STREAK_ADVISORY_MESSAGE_SLUG, `${turns} read only turns in a row, and every turn replays the whole context. Batch independent reads into one message, and send open ended reconnaissance to Explore.`);
}

export { isReadOnlyBash, handleReadStreak };
