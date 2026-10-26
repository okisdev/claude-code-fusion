import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { hostPeerCapacity, hostPeerCapacityDenial, createDispatch, reserveHostPeerCapacity } from "../plugins/fusion/scripts/lib/lifecycle/dispatch.mjs";
import { handlePreToolUse, handlePostToolUse } from "../plugins/fusion/scripts/lib/lifecycle/tools.mjs";
import { buildFusionStats } from "../plugins/fusion/scripts/lib/stats/aggregation.mjs";
import { renderFusionStats } from "../plugins/fusion/scripts/lib/stats/rendering.mjs";
import { messageTag } from "../plugins/fusion/scripts/lib/user-messages.mjs";
import { createWorkerRecord, readPeerCapacityReservations, readWorkerRecord, updateWorkerRecord, withPeerCapacityReservations } from "../plugins/fusion/scripts/lib/worker-state.mjs";

const GiB = 1024 ** 3;

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-capacity-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  return { root, cwd, env: { ...process.env, FUSION_DATA_DIR: path.join(root, "data"), FUSION_WORKER_STATE_DIR: path.join(root, "data", "workers") } };
}

function worker(box, taskId, sessionId, agentType = "codex:codex-rescue", extra = {}) {
  return createWorkerRecord({ taskId, sessionId, agentType, workspaceRoot: box.cwd, limits: { stallMs: 600_000 }, ...extra }, box.env);
}

test("host peer capacity follows total physical memory with a floor of two", () => {
  assert.equal(hostPeerCapacity(0), 2);
  assert.equal(hostPeerCapacity(16 * GiB), 5);
  assert.equal(hostPeerCapacity(64 * GiB), 21);
});

test("host capacity counts live peer wrappers across sessions and ignores stale and Fusion records", (t) => {
  const box = sandbox(t);
  for (let index = 0; index < 5; index += 1) {
    worker(box, `fusion-peer-${index}`, index < 3 ? "session-a" : "session-b", index % 2 ? "grok:grok-rescue" : "codex:codex-rescue");
  }
  worker(box, "fusion-claude", "session-c", "fusion:claude-worker");
  const now = Date.now();
  const denial = hostPeerCapacityDenial(box.env, now, 16 * GiB);
  assert.match(denial, /5 peer wrapper jobs in flight \(capacity 5; total memory 16 GiB\)/);
  assert.ok(denial.endsWith(messageTag("worker-lifecycle.host-capacity-deny")));
  assert.match(denial, /Relaunch after a completion notification/);
  updateWorkerRecord("fusion-peer-0", box.env, (record) => ({ ...record, lastLivenessAt: new Date(now - 600_001).toISOString() }));
  assert.equal(hostPeerCapacityDenial(box.env, now, 16 * GiB), null);
  updateWorkerRecord("fusion-peer-1", box.env, (record) => ({ ...record, transportStatus: "done" }));
  assert.equal(hostPeerCapacityDenial(box.env, now, 16 * GiB), null);
});

function hookOutput(callback) {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => { output += chunk; return true; };
  try {
    callback();
    return output;
  } finally {
    process.stdout.write = original;
  }
}

test("synchronous peer PreToolUse bursts reserve host slots and PostToolUse releases one", (t) => {
  const box = sandbox(t);
  const capacity = hostPeerCapacity(os.totalmem());
  const input = (index) => ({ session_id: "session-a", tool_use_id: `peer-${index}`, tool_name: "Agent", tool_input: { subagent_type: "codex:codex-rescue", prompt: "brief" } });
  for (let index = 0; index < capacity; index += 1) {
    assert.equal(hookOutput(() => handlePreToolUse(input(index), box.env)), "");
  }
  assert.equal(readPeerCapacityReservations(box.env).length, capacity);
  assert.match(hookOutput(() => handlePreToolUse(input(capacity), box.env)), new RegExp(messageTag("worker-lifecycle.host-capacity-deny")));
  hookOutput(() => handlePostToolUse(input(0), box.env));
  assert.equal(readPeerCapacityReservations(box.env).length, capacity - 1);
  assert.equal(hookOutput(() => handlePreToolUse(input(capacity), box.env)), "");
  hookOutput(() => handlePostToolUse(input(1), box.env, true));
  assert.equal(hookOutput(() => handlePreToolUse(input(capacity + 1), box.env)), "");
});

test("stale peer reservations are pruned before capacity is checked", (t) => {
  const box = sandbox(t);
  const input = (index) => ({ session_id: "session-a", tool_use_id: `peer-${index}`, tool_name: "Agent", tool_input: { subagent_type: "codex:codex-rescue" } });
  for (let index = 0; index < 5; index += 1) {
    assert.equal(reserveHostPeerCapacity(input(index), "codex:codex-rescue", box.env, null, Date.now(), 16 * GiB), null);
  }
  assert.match(reserveHostPeerCapacity(input(5), "codex:codex-rescue", box.env, null, Date.now(), 16 * GiB), new RegExp(messageTag("worker-lifecycle.host-capacity-deny")));
  withPeerCapacityReservations(box.env, (reservations) => { reservations[0].at -= 2_400_001; });
  assert.equal(reserveHostPeerCapacity(input(5), "codex:codex-rescue", box.env, null, Date.now(), 16 * GiB), null);
  assert.equal(readPeerCapacityReservations(box.env).length, 5);
});

test("a peer record and its launch reservation occupy one slot", (t) => {
  const box = sandbox(t);
  const input = (index) => ({ session_id: "session-a", tool_use_id: `peer-${index}`, tool_name: "Agent", tool_input: { subagent_type: "codex:codex-rescue" } });
  assert.equal(reserveHostPeerCapacity(input(0), "codex:codex-rescue", box.env, null, Date.now(), 16 * GiB), null);
  worker(box, "fusion-async-peer", "session-a", "codex:codex-rescue", { dispatchToolUseId: "peer-0" });
  for (let index = 1; index < 5; index += 1) {
    assert.equal(reserveHostPeerCapacity(input(index), "codex:codex-rescue", box.env, null, Date.now(), 16 * GiB), null);
  }
  assert.match(hostPeerCapacityDenial(box.env, Date.now(), 16 * GiB), /5 peer wrapper jobs in flight/);
});

test("reservations without tool ids do not mask unrelated peer records", (t) => {
  const box = sandbox(t);
  worker(box, "fusion-active-peer", "session-a");
  const input = (agentType) => ({ session_id: "session-a", tool_name: "Agent", tool_input: { subagent_type: agentType } });
  assert.equal(reserveHostPeerCapacity(input("codex:codex-rescue"), "codex:codex-rescue", box.env, null, Date.now(), 6 * GiB), null);
  assert.match(reserveHostPeerCapacity(input("grok:grok-rescue"), "grok:grok-rescue", box.env, null, Date.now(), 6 * GiB), /Host peer capacity reached: 2/);
});

test("SendMessage cannot reopen a terminal peer when host capacity is full", (t) => {
  const box = sandbox(t);
  const capacity = hostPeerCapacity(os.totalmem());
  const taskId = "fusion-terminal-peer";
  worker(box, taskId, "session-a");
  updateWorkerRecord(taskId, box.env, (record) => ({ ...record, agentId: "terminal-peer", transportStatus: "done" }));
  const launch = (index) => ({ session_id: "session-b", tool_use_id: `peer-${index}`, tool_name: "Agent", tool_input: { subagent_type: "codex:codex-rescue", prompt: "brief" } });
  for (let index = 0; index < capacity; index += 1) {
    hookOutput(() => handlePreToolUse(launch(index), box.env));
  }
  const message = { session_id: "session-a", tool_use_id: "message-1", tool_name: "SendMessage", tool_input: { to: "terminal-peer", message: "continue" } };
  assert.match(hookOutput(() => handlePreToolUse(message, box.env)), new RegExp(messageTag("worker-lifecycle.host-capacity-deny")));
  assert.equal(readWorkerRecord(taskId, box.env).continuationRequestedAt, undefined);
  hookOutput(() => handlePostToolUse(launch(0), box.env));
  assert.equal(hookOutput(() => handlePreToolUse(message, box.env)), "");
  hookOutput(() => handlePostToolUse(message, box.env, true));
  assert.equal(readPeerCapacityReservations(box.env).length, capacity - 1);
});

test("dispatch stores parent context tokens and stats render median and p90 for measured dispatches", (t) => {
  const box = sandbox(t);
  const transcript = path.join(box.root, "parent.jsonl");
  fs.writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 500, cache_read_input_tokens: 249_000, cache_creation_input_tokens: 500 } } })}\n`);
  const dispatched = createDispatch({ session_id: "session-a", tool_use_id: "tool-context", cwd: box.cwd, transcript_path: transcript, tool_input: { prompt: "peer brief" } }, "codex:codex-rescue", false, box.env);
  assert.equal(dispatched.parentContextTokensAtDispatch, 250_000);
  assert.equal(readWorkerRecord(dispatched.taskId, box.env).parentContextTokensAtDispatch, 250_000);
  for (const [index, tokens] of [100_000, 200_000, 400_000, 900_000].entries()) {
    worker(box, `fusion-measured-${index}`, "session-b", "fusion:claude-worker", { parentContextTokensAtDispatch: tokens });
  }
  worker(box, "fusion-unmeasured", "session-b", "fusion:claude-worker");
  const report = buildFusionStats({ all: true, cwd: box.cwd, env: box.env });
  assert.deepEqual(report.parentContextAtDispatch, { dispatchCount: 5, medianTokens: 250_000, p90Tokens: 900_000 });
  assert.match(renderFusionStats(report), /Parent context at dispatch: 5 measured; median 250000 tokens, p90 900000 tokens/);
  const otherWorkspace = path.join(box.root, "other-repo");
  fs.mkdirSync(otherWorkspace);
  createWorkerRecord({ taskId: "fusion-other-workspace", sessionId: "session-c", agentType: "fusion:claude-worker", workspaceRoot: otherWorkspace, parentContextTokensAtDispatch: 3_000_000 }, box.env);
  assert.deepEqual(buildFusionStats({ cwd: box.cwd, env: box.env }).parentContextAtDispatch, report.parentContextAtDispatch);
  assert.equal(buildFusionStats({ all: true, cwd: box.cwd, env: box.env }).parentContextAtDispatch.p90Tokens, 3_000_000);
});
