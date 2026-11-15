import { normalizeMessageId, readTranscriptTail, transcriptEntryContent } from "./verification.mjs";

const REPLAY_BUDGET_TOKENS_ENV = "FUSION_INLINE_REPLAY_BUDGET_TOKENS";
const DEFAULT_REPLAY_BUDGET_TOKENS = 2_000_000;
const NOMINAL_CONTEXT_TOKENS = 400_000;
const SAME_TURN_MS = 1500;
const REPLAY_KINDS = ["dispatch", "write", "verify", "settle", "other", "read"];

function resolveReplayBudgetTokens(env = process.env) {
  const raw = env[REPLAY_BUDGET_TOKENS_ENV];
  const parsed = typeof raw === "number" ? raw : Number(String(raw ?? "").trim() || Number.NaN);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REPLAY_BUDGET_TOKENS;
}

function usageContextTokens(usage) {
  const counts = [usage?.input_tokens, usage?.cache_read_input_tokens ?? 0, usage?.cache_creation_input_tokens ?? 0];
  if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const tokens = counts.reduce((total, value) => total + value, 0);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
}

function readTurn(transcriptPath, toolUseId) {
  let latest = null;
  for (const entry of readTranscriptTail(transcriptPath).toReversed()) {
    if (entry?.type !== "assistant" || entry.isSidechain === true || entry.isMeta === true) continue;
    const contextTokens = usageContextTokens(entry.message?.usage);
    if (toolUseId && transcriptEntryContent(entry).some((block) => block?.type === "tool_use" && block.id === toolUseId)) {
      return { id: normalizeMessageId(entry.message?.id), contextTokens: contextTokens ?? latest };
    }
    latest ??= contextTokens;
  }
  return { id: null, contextTokens: latest };
}

function turnReplayTokens(turn) {
  return turn?.contextTokens ?? NOMINAL_CONTEXT_TOKENS;
}

function isNewTurn(previous, turn, now) {
  if (!previous) return true;
  if (previous.id && turn?.id) return previous.id !== turn.id;
  const elapsed = Date.parse(now) - Date.parse(previous.at);
  return !(elapsed >= 0 && elapsed <= SAME_TURN_MS);
}

function crossedBudgetMultiple(before, after, budget) {
  if (!(budget > 0) || !(after >= budget) || !(after > before)) return 0;
  const multiple = 2 ** Math.floor(Math.log2(after / budget));
  return multiple * budget > before ? multiple : 0;
}

function outranksReplayKind(candidate, current) {
  const rank = REPLAY_KINDS.indexOf(candidate);
  return rank >= 0 && (current == null || rank < REPLAY_KINDS.indexOf(current));
}

function formatTokens(tokens) {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`;
}

export { REPLAY_BUDGET_TOKENS_ENV, DEFAULT_REPLAY_BUDGET_TOKENS, NOMINAL_CONTEXT_TOKENS, SAME_TURN_MS, REPLAY_KINDS, resolveReplayBudgetTokens, readTurn, turnReplayTokens, isNewTurn, crossedBudgetMultiple, outranksReplayKind, formatTokens };
