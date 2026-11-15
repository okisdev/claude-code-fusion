import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { normalizeAuditEvent } from "../plugins/fusion/scripts/lib/guard/audit.mjs";
import {
  DEFAULT_REPLAY_BUDGET_TOKENS,
  NOMINAL_CONTEXT_TOKENS,
  crossedBudgetMultiple,
  formatTokens,
  isNewTurn,
  outranksReplayKind,
  readTurn,
  resolveReplayBudgetTokens,
  turnReplayTokens
} from "../plugins/fusion/scripts/lib/guard/replay.mjs";

function transcript(t, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return file;
}

function assistant(id, usage, toolUseIds = [], extra = {}) {
  return { type: "assistant", message: { id, usage, content: toolUseIds.map((toolUseId) => ({ type: "tool_use", id: toolUseId })) }, ...extra };
}

test("the replay budget defaults to two million tokens and accepts a positive integer override", () => {
  assert.strictEqual(DEFAULT_REPLAY_BUDGET_TOKENS, 2_000_000);
  assert.strictEqual(DEFAULT_REPLAY_BUDGET_TOKENS / NOMINAL_CONTEXT_TOKENS, 5);
  assert.strictEqual(resolveReplayBudgetTokens({}), 2_000_000);
  assert.strictEqual(resolveReplayBudgetTokens({ FUSION_INLINE_REPLAY_BUDGET_TOKENS: "500000" }), 500_000);
  assert.strictEqual(resolveReplayBudgetTokens({ FUSION_INLINE_REPLAY_BUDGET_TOKENS: 750_000 }), 750_000);
  for (const value of ["", " ", "0", "-1", "1.5", "many"]) {
    assert.strictEqual(resolveReplayBudgetTokens({ FUSION_INLINE_REPLAY_BUDGET_TOKENS: value }), 2_000_000, value);
  }
});

test("a turn is the assistant message that holds the tool call, priced at its context", (t) => {
  const file = transcript(t, [
    assistant("msg_old", { input_tokens: 2, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 8 }, ["tool-old"]),
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-old" }] } },
    assistant("msg_side", { input_tokens: 1, cache_read_input_tokens: 999_000 }, ["tool-side"], { isSidechain: true }),
    assistant("msg_new", { input_tokens: 3, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 20_000 }, ["tool-a"]),
    assistant("msg_new", { input_tokens: 3, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 20_000 }, ["tool-b"])
  ]);
  assert.deepStrictEqual(readTurn(file, "tool-a"), { id: "msg_new", contextTokens: 420_003 });
  assert.deepStrictEqual(readTurn(file, "tool-b"), { id: "msg_new", contextTokens: 420_003 });
  assert.deepStrictEqual(readTurn(file, "tool-old"), { id: "msg_old", contextTokens: 90_010 });
  assert.deepStrictEqual(readTurn(file, "tool-not-flushed"), { id: null, contextTokens: 420_003 });
  assert.deepStrictEqual(readTurn(file, "tool-side"), { id: null, contextTokens: 420_003 });
  assert.deepStrictEqual(readTurn(file, null), { id: null, contextTokens: 420_003 });
});

test("an unreadable transcript prices a turn at the nominal context", (t) => {
  assert.deepStrictEqual(readTurn(null, "tool-a"), { id: null, contextTokens: null });
  assert.deepStrictEqual(readTurn(path.join(os.tmpdir(), "replay-test-missing.jsonl"), "tool-a"), { id: null, contextTokens: null });
  const file = transcript(t, [assistant("msg_1", { input_tokens: "many" }, ["tool-a"])]);
  assert.deepStrictEqual(readTurn(file, "tool-a"), { id: "msg_1", contextTokens: null });
  assert.strictEqual(turnReplayTokens({ id: null, contextTokens: null }), NOMINAL_CONTEXT_TOKENS);
  assert.strictEqual(turnReplayTokens(null), NOMINAL_CONTEXT_TOKENS);
  assert.strictEqual(turnReplayTokens({ id: "msg_1", contextTokens: 80_000 }), 80_000);
});

test("tool calls share a turn when either the message id or a 1500 ms gap says so", () => {
  const at = "2026-07-21T00:00:00.000Z";
  const later = (ms) => new Date(Date.parse(at) + ms).toISOString();
  assert.strictEqual(isNewTurn(null, { id: "msg_1" }, at), true);
  assert.strictEqual(isNewTurn({ id: "msg_1", at }, { id: "msg_1" }, later(600_000)), false);
  assert.strictEqual(isNewTurn({ id: "msg_1", at }, { id: "msg_2" }, later(1500)), false);
  assert.strictEqual(isNewTurn({ id: "msg_1", at }, { id: "msg_2" }, later(1501)), true);
  assert.strictEqual(isNewTurn({ id: null, at }, { id: "msg_2" }, later(1500)), false);
  assert.strictEqual(isNewTurn({ id: null, at }, { id: null }, later(1501)), true);
  assert.strictEqual(isNewTurn({ id: "msg_1", at }, { id: null }, later(-1)), true);
  assert.strictEqual(isNewTurn({ id: "msg_1", at: null }, { id: "msg_2" }, at), true);
});

test("an advisory is due when replay crosses the budget and each doubling of it", () => {
  const budget = 2_000_000;
  assert.strictEqual(crossedBudgetMultiple(0, 1_999_999, budget), 0);
  assert.strictEqual(crossedBudgetMultiple(1_600_000, 2_000_000, budget), 1);
  assert.strictEqual(crossedBudgetMultiple(1_600_000, 2_400_000, budget), 1);
  assert.strictEqual(crossedBudgetMultiple(2_400_000, 3_200_000, budget), 0);
  assert.strictEqual(crossedBudgetMultiple(3_600_000, 4_400_000, budget), 2);
  assert.strictEqual(crossedBudgetMultiple(4_400_000, 7_900_000, budget), 0);
  assert.strictEqual(crossedBudgetMultiple(7_900_000, 8_700_000, budget), 4);
  assert.strictEqual(crossedBudgetMultiple(0, 9_000_000, budget), 4);
  assert.strictEqual(crossedBudgetMultiple(2_000_000, 2_000_000, budget), 0);
  assert.strictEqual(crossedBudgetMultiple(0, 2_000_000, 0), 0);
  const turns = [];
  for (let turn = 1, total = 0; turn <= 20; turn += 1) {
    const before = total;
    total += NOMINAL_CONTEXT_TOKENS;
    if (crossedBudgetMultiple(before, total, budget)) turns.push(turn);
  }
  assert.deepStrictEqual(turns, [5, 10, 20]);
});

test("a turn takes the kind of its highest ranked tool call", () => {
  assert.strictEqual(outranksReplayKind("read", null), true);
  assert.strictEqual(outranksReplayKind("other", "read"), true);
  assert.strictEqual(outranksReplayKind("write", "verify"), true);
  assert.strictEqual(outranksReplayKind("dispatch", "write"), true);
  assert.strictEqual(outranksReplayKind("read", "other"), false);
  assert.strictEqual(outranksReplayKind("settle", "verify"), false);
  assert.strictEqual(outranksReplayKind("write", "write"), false);
  assert.strictEqual(outranksReplayKind("unknown", null), false);
});

test("token counts print in thousands below a million and in millions above", () => {
  assert.strictEqual(formatTokens(80_400), "80k");
  assert.strictEqual(formatTokens(999_499), "999k");
  assert.strictEqual(formatTokens(2_000_000), "2.0M");
  assert.strictEqual(formatTokens(7_449_000), "7.4M");
});

test("the audit log keeps one replay event per priced tool call", () => {
  const event = { at: "2026-07-21T00:00:00.000Z", session: "session-1", event: "replay", lane: "main", tool: "Bash", turn: "msg_01AbC-d", kind: "read", tokens: 420_003, measured: true };
  assert.deepStrictEqual(normalizeAuditEvent({ ...event, command: "cat secret" }), { schemaVersion: 1, ...event });
  assert.deepStrictEqual(normalizeAuditEvent({ ...event, turn: "t:1784592000000", tokens: 400_000, measured: false }), { schemaVersion: 1, ...event, turn: "t:1784592000000", tokens: 400_000, measured: false });
  for (const change of [{ kind: "think" }, { tokens: 0 }, { tokens: 1.5 }, { turn: "" }, { turn: "a b" }, { measured: "yes" }, { lane: "builtin" }, { tool: "" }]) {
    assert.strictEqual(normalizeAuditEvent({ ...event, ...change }), null, JSON.stringify(change));
  }
});
