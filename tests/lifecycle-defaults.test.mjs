import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { workerBudgetFailure } from "../plugins/fusion/scripts/lib/lifecycle/budget.mjs";
import { injectedPeerDefaults } from "../plugins/fusion/scripts/lib/lifecycle/dispatch.mjs";
import { reopenWorkerContinuation } from "../plugins/fusion/scripts/lib/worker-state.mjs";

test("continued peer wrappers get a fresh wall clock and usage budget", () => {
  const at = "2026-09-27T01:00:00.000Z";
  const wallClockMs = 2_400_000;
  const prior = {
    agentType: "codex:codex-rescue",
    transportStatus: "done",
    startedAt: "2026-09-27T00:00:00.000Z",
    limits: { wallClockMs, stallMs: 600_000, maxTurns: 100, maxOutputTokens: 192_000, maxUncachedTokens: 960_000 },
    turns: 103,
    toolCalls: 9,
    usage: { inputTokens: 7, outputTokens: 195_000, uncachedTokens: 965_000 }
  };
  const reopened = reopenWorkerContinuation(prior, at);

  assert.deepStrictEqual(reopened.budgetBaseline, {
    at,
    turns: 103,
    outputTokens: 195_000,
    uncachedTokens: 965_000,
    toolCalls: 9,
    usage: { inputTokens: 7, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 195_000, totalTokens: 0, uncachedTokens: 965_000 }
  });
  assert.strictEqual(workerBudgetFailure(reopened, Date.parse(at)), null);
  assert.strictEqual(workerBudgetFailure(reopened, Date.parse(at) + wallClockMs - 1), null);
  assert.deepStrictEqual(workerBudgetFailure(reopened, Date.parse(at) + wallClockMs), { failureKind: "timeout", limitKind: "wall", reason: `wall clock budget reached (${wallClockMs}ms)` });
});

test("Grok injects the selected role's effort when roles share a model", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-lifecycle-defaults-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { FUSION_MODEL_ROUTING: path.join(directory, "missing.json") };

  for (const [role, effort] of [["independence", "high"], ["live-web", "high"], ["burst", "low"]]) {
    const prompt = `grok-role: ${role}\ngoal: review`;
    assert.strictEqual(injectedPeerDefaults(prompt, "grok:grok-rescue", env)?.prompt, `--model grok-4.7-build-fast --effort ${effort} -- ${prompt}`);
    assert.strictEqual(injectedPeerDefaults(`--model grok-4.7-build-fast -- ${prompt}`, "grok:grok-rescue", env)?.prompt, `--effort ${effort} --model grok-4.7-build-fast -- ${prompt}`);
  }

  const otherModel = "--model grok-4.6 -- grok-role: independence";
  assert.strictEqual(injectedPeerDefaults(otherModel, "grok:grok-rescue", env)?.prompt, `--effort medium ${otherModel}`);
});

test("Cursor role fields with middle dot, comma, and semicolon separators get defaults", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-lifecycle-defaults-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { FUSION_MODEL_ROUTING: path.join(directory, "missing.json") };

  for (const header of ["cursor · cursor-role: diversity · acceptance: cited lines", "cursor·cursor-role:diversity·acceptance: cited lines", "cursor, cursor-role: diversity, acceptance: cited lines", "cursor; cursor-role: diversity; acceptance: cited lines"]) {
    const prompt = `${header}\ngoal: consult`;
    assert.strictEqual(injectedPeerDefaults(prompt, "cursor:cursor-rescue", env)?.prompt, `--model muse-spark-1.3 --effort xhigh -- ${prompt}`);
  }
});
