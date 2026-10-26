import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { hostPeerCapacity, hostPeerCapacityDenial, createDispatch } from "../plugins/fusion/scripts/lib/lifecycle/dispatch.mjs";
import { buildFusionStats } from "../plugins/fusion/scripts/lib/stats/aggregation.mjs";
import { renderFusionStats } from "../plugins/fusion/scripts/lib/stats/rendering.mjs";
import { messageTag } from "../plugins/fusion/scripts/lib/user-messages.mjs";
import { createWorkerRecord, readWorkerRecord, updateWorkerRecord } from "../plugins/fusion/scripts/lib/worker-state.mjs";

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
