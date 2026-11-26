import { normalizeMessageId, transcriptEntryContent } from "./verification.mjs";
import { TRANSCRIPT_TAIL_MAX_BYTES } from "./constants.mjs";
import { CONTEXT_SCAN_BYTES, assistantPages, readTranscript, usageContextTokens } from "./transcript.mjs";

const REPLAY_BUDGET_TOKENS_ENV = "FUSION_INLINE_REPLAY_BUDGET_TOKENS";
const DEFAULT_REPLAY_BUDGET_TOKENS = 2_000_000;
const INITIAL_CONTEXT_TOKENS = 20_000;
const SAME_TURN_MS = 1500;
const REPLAY_KINDS = ["dispatch", "write", "verify", "settle", "other", "read"];

function resolveReplayBudgetTokens(env = process.env) {
  const raw = env[REPLAY_BUDGET_TOKENS_ENV];
  const parsed = typeof raw === "number" ? raw : Number(String(raw ?? "").trim() || Number.NaN);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REPLAY_BUDGET_TOKENS;
}

function readTurn(transcriptPath, toolUseId, lastMeasuredTokens = null) {
  return readTranscript(transcriptPath, (fd, size) => {
    let id = null;
    for (const entries of assistantPages(fd, size)) {
      let latest = null;
      for (const { entry } of entries) {
        const tokens = usageContextTokens(entry.message?.usage) || null;
        latest ??= tokens;
        if (toolUseId && transcriptEntryContent(entry).some((block) => block?.type === "tool_use" && block.id === toolUseId)) {
          id = normalizeMessageId(entry.message?.id);
          if (tokens !== null) return { id, contextTokens: tokens };
        }
      }
      if (latest !== null) return { id, contextTokens: latest };
    }
    if (lastMeasuredTokens === null && size > CONTEXT_SCAN_BYTES) {
      for (const entries of assistantPages(fd, TRANSCRIPT_TAIL_MAX_BYTES)) {
        for (const { entry } of entries.reverse()) {
          const tokens = usageContextTokens(entry.message?.usage);
          if (tokens) return { id, contextTokens: tokens };
        }
      }
    }
    return { id, contextTokens: lastMeasuredTokens };
  }) ?? { id: null, contextTokens: lastMeasuredTokens };
}

function turnReplayTokens(turn) {
  return turn?.contextTokens ?? INITIAL_CONTEXT_TOKENS;
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

export { REPLAY_BUDGET_TOKENS_ENV, DEFAULT_REPLAY_BUDGET_TOKENS, INITIAL_CONTEXT_TOKENS, SAME_TURN_MS, REPLAY_KINDS, resolveReplayBudgetTokens, readTurn, turnReplayTokens, isNewTurn, crossedBudgetMultiple, outranksReplayKind, formatTokens };
