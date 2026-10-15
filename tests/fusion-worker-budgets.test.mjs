import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createWorkerRecord, readWorkerRecord, readWorkerSessionState, updateWorkerRecord } from "../plugins/fusion/scripts/lib/worker-state.mjs";
import { workerBudgetFailure, workerLimits } from "../plugins/fusion/scripts/worker-lifecycle.mjs";

const script = path.join(import.meta.dirname, "..", "plugins", "fusion", "scripts", "worker-lifecycle.mjs");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-budgets-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  const transcript = path.join(root, "parent.jsonl");
  fs.writeFileSync(transcript, "");
  const env = { ...process.env, FUSION_WORKER_STATE_DIR: path.join(root, "state"), FUSION_DATA_DIR: path.join(root, "data") };
  return { root, cwd, transcript, env };
}

function worker(box, suffix, change = {}) {
  const taskId = `fusion-${suffix.repeat(24)}`;
  createWorkerRecord({ taskId, sessionId: "budget-session", agentType: "fusion:claude-worker", workspaceRoot: box.cwd }, box.env);
  return updateWorkerRecord(taskId, box.env, (current) => ({ ...current, ...change }));
}

function stop(box, extra = {}) {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "budget-session", cwd: box.cwd, transcript_path: box.transcript, stop_hook_active: false, background_tasks: [], ...extra }),
    encoding: "utf8",
    env: box.env
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

test("recalibrated worker budgets keep sizing and timing overrides", () => {
  assert.deepEqual(workerLimits("fusion:claude-worker", {}), { wallClockMs: 2_400_000, stallMs: 600_000, maxTurns: 100, maxOutputTokens: 192_000, maxUncachedTokens: 960_000 });
  assert.deepEqual(workerLimits("fusion:deep-reasoner", {}), { wallClockMs: 2_400_000, stallMs: 900_000, maxTurns: 40, maxOutputTokens: 128_000, maxUncachedTokens: 960_000 });
  assert.deepEqual(workerLimits("fusion:trivial-worker", {}, "small"), { wallClockMs: 150_000, stallMs: 60_000, maxTurns: 12, maxOutputTokens: 16_000, maxUncachedTokens: 120_000 });
  assert.deepEqual(workerLimits("fusion:job-collector", {}), { wallClockMs: 660_000, stallMs: 660_000, maxTurns: 6, maxOutputTokens: 8_000, maxUncachedTokens: 30_000 });
  assert.equal(workerLimits("fusion:claude-worker", { FUSION_WORKER_WALL_CLOCK_MS: "5" }, "large").wallClockMs, 5);
});

test("each budget failure identifies the firing limit", () => {
  const now = Date.now();
  const base = { agentType: "fusion:claude-worker", createdAt: new Date(now - 100).toISOString(), lastLivenessAt: new Date(now).toISOString(), limits: { wallClockMs: 1000, stallMs: 1000, maxTurns: 3, maxOutputTokens: 10, maxUncachedTokens: 20 }, turns: 0, usage: { outputTokens: 0, uncachedTokens: 0 } };
  for (const [change, kind, reason] of [
    [{ turns: 3 }, "turns", /turn budget/],
    [{ usage: { outputTokens: 10, uncachedTokens: 0 } }, "output", /output token budget/],
    [{ usage: { outputTokens: 0, uncachedTokens: 20 } }, "uncached", /uncached token budget/],
    [{ createdAt: new Date(now - 1000).toISOString() }, "wall", /wall clock budget/],
    [{ lastLivenessAt: new Date(now - 1000).toISOString() }, "stall", /no-activity budget/]
  ]) {
    const failure = workerBudgetFailure({ ...base, ...change }, now);
    assert.equal(failure.limitKind, kind);
    assert.match(failure.reason, reason);
  }
});

test("Stop records the limit kind and cancel reason on cancellation", (t) => {
  const box = fixture(t);
  const current = worker(box, "a", { agentId: "runtime-a", backgroundTaskId: "runtime-a", transportStatus: "pending_async", turns: 100, limits: workerLimits("fusion:claude-worker", {}) });
  const output = stop(box, { background_tasks: [{ id: "runtime-a", status: "running", type: "subagent" }] });
  assert.equal(output.decision, "block");
  const updated = readWorkerRecord(current.taskId, box.env);
  assert.equal(updated.limitKind, "turns");
  assert.equal(updated.cancelReason, "turn budget reached (100)");
});

test("worker tool denial records output limit kind and reason", (t) => {
  const box = fixture(t);
  const current = worker(box, "b", {
    agentId: "runtime-b",
    transportStatus: "running",
    startedAt: new Date().toISOString(),
    limits: workerLimits("fusion:claude-worker", {}),
    usage: { outputTokens: 192_000, uncachedTokens: 192_000 }
  });
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "budget-session", cwd: box.cwd, transcript_path: box.transcript, agent_id: "runtime-b", agent_type: "fusion:claude-worker", tool_name: "Read", tool_input: { file_path: "x" } }),
    encoding: "utf8",
    env: box.env
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
  const updated = readWorkerRecord(current.taskId, box.env);
  assert.equal(updated.limitKind, "output");
  assert.equal(updated.cancelReason, "output token budget reached (192000)");
});

test("third identical Stop block releases once and a lifecycle change resets the count", (t) => {
  const box = fixture(t);
  const first = worker(box, "1", { transportStatus: "done", collectedAt: new Date().toISOString(), awaitingVerdict: true });
  worker(box, "2", { transportStatus: "done", collectedAt: new Date().toISOString(), awaitingVerdict: true });
  assert.equal(stop(box).decision, "block");
  assert.equal(readWorkerSessionState("budget-session", box.env).stopGate.count, 1);
  assert.equal(stop(box).decision, "block");
  assert.equal(readWorkerSessionState("budget-session", box.env).stopGate.count, 2);
  const released = stop(box);
  assert.equal(released.decision, undefined, JSON.stringify({ released, gate: readWorkerSessionState("budget-session", box.env).stopGate }));
  assert.match(released.hookSpecificOutput.additionalContext, new RegExp(first.taskId));
  assert.equal(readWorkerSessionState("budget-session", box.env).events.at(-1).type, "stop-gate-released");
  assert.equal(stop(box), null);
  updateWorkerRecord(first.taskId, box.env, (current) => ({ ...current, progressEvents: (current.progressEvents ?? 0) + 1 }));
  assert.equal(stop(box).decision, "block");
  updateWorkerRecord(first.taskId, box.env, (current) => ({ ...current, description: "new lifecycle detail" }));
  assert.equal(stop(box).decision, "block");
  assert.equal(stop(box).decision, "block");
  assert.match(stop(box).hookSpecificOutput.additionalContext, /Stop gate released/);
  assert.equal(readWorkerSessionState("budget-session", box.env).events.length, 2);
});

test("Stop suppresses acceptance advice in flight and repeats in-flight advice only for changed task ids", (t) => {
  const box = fixture(t);
  worker(box, "3", { transportStatus: "done", collectedAt: new Date().toISOString(), awaitingVerdict: true });
  const active = worker(box, "4", { agentId: "active-4", backgroundTaskId: "active-4", transportStatus: "pending_async" });
  const first = stop(box, { background_tasks: [{ id: "active-4", status: "running", type: "subagent" }] });
  assert.match(first.hookSpecificOutput.additionalContext, /still in flight/);
  assert.doesNotMatch(first.hookSpecificOutput.additionalContext, /Acceptance remains unverified/);
  assert.equal(stop(box, { background_tasks: [{ id: "active-4", status: "running", type: "subagent" }] }), null);
  const next = worker(box, "5", { agentId: "active-5", backgroundTaskId: "active-5", transportStatus: "pending_async" });
  const changed = stop(box, { background_tasks: [{ id: "active-4", status: "running", type: "subagent" }, { id: "active-5", status: "running", type: "subagent" }] });
  assert.match(changed.hookSpecificOutput.additionalContext, new RegExp(active.taskId));
  assert.match(changed.hookSpecificOutput.additionalContext, new RegExp(next.taskId));
});
