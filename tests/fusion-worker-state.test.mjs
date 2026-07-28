import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKER_COLLECTION_METHODS, applyQueuedVerdict, createWorkerRecord, isPendingSettlement, isSettledWorker, markWorkerCollected, recordWorkerAcceptance, updateWorkerRecord } from "../plugins/fusion/scripts/lib/worker-state.mjs";

function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-worker-state-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function unverifiedRecord(overrides = {}) {
  return {
    taskId: "fusion-state-seam",
    completionContract: "analysis",
    transportStatus: "done",
    collectedAt: "2026-07-22T00:00:00.000Z",
    acceptance: "unverified",
    acceptanceRecordedAt: null,
    awaitingVerdict: true,
    awaitingVerdictArmedAt: "2026-07-22T00:00:00.000Z",
    ...overrides
  };
}

test("settlement seam identifies pending and settled worker records", () => {
  const pending = unverifiedRecord();
  const settled = unverifiedRecord({ acceptance: "accepted", acceptanceRecordedAt: "2026-07-22T00:01:00.000Z", awaitingVerdict: false, awaitingVerdictArmedAt: null });

  assert.strictEqual(isPendingSettlement(pending), true);
  assert.strictEqual(isSettledWorker(pending), false);
  assert.strictEqual(isPendingSettlement(settled), false);
  assert.strictEqual(isSettledWorker(settled), true);
});

test("created worker records stamp the Fusion companion version", (t) => {
  const directory = sandbox(t);
  const env = { FUSION_WORKER_STATE_DIR: path.join(directory, "worker-state") };
  const expectedVersion = JSON.parse(fs.readFileSync(new URL("../plugins/fusion/.claude-plugin/plugin.json", import.meta.url), "utf8")).version;
  const record = createWorkerRecord({ taskId: "fusion-version-stamp", sessionId: "session-version", dispatchToolUseId: "tool-version", agentType: "fusion:fast-worker", workspaceRoot: directory, limits: {} }, env);

  assert.strictEqual(typeof record.companionVersion, "string");
  assert.strictEqual(record.companionVersion, expectedVersion);
});

test("markWorkerCollected preserves an already settled acceptance", () => {
  const settled = markWorkerCollected(
    unverifiedRecord({ collectedAt: null, acceptance: "rejected", acceptanceRecordedAt: "2026-07-22T00:01:00.000Z", acceptanceSource: "main-loop", awaitingVerdict: false, awaitingVerdictArmedAt: null }),
    WORKER_COLLECTION_METHODS.TASK_NOTIFICATION,
    "2026-07-22T00:02:00.000Z"
  );

  assert.strictEqual(settled.acceptance, "rejected");
  assert.strictEqual(settled.acceptanceRecordedAt, "2026-07-22T00:01:00.000Z");
  assert.strictEqual(settled.awaitingVerdict, false);
  assert.strictEqual(isSettledWorker(settled), true);
});

test("applyQueuedVerdict settles queued accepted only after a done terminal", () => {
  const queued = unverifiedRecord({
    pendingVerdict: {
      acceptance: "accepted",
      source: "main-loop",
      reason: "verified",
      queuedAt: "2026-07-22T00:00:00.000Z"
    }
  });
  const settled = applyQueuedVerdict(queued, "2026-07-22T00:03:00.000Z");
  assert.strictEqual(settled.acceptance, "accepted");
  assert.strictEqual(settled.acceptanceRecordedAt, "2026-07-22T00:03:00.000Z");
  assert.strictEqual(settled.awaitingVerdict, false);
  assert.strictEqual(settled.pendingVerdict, undefined);

  for (const transportStatus of ["cancelled", "incomplete"]) {
    const blocked = applyQueuedVerdict({ ...queued, transportStatus }, "2026-07-22T00:03:00.000Z");
    assert.strictEqual(blocked.acceptance, "unverified");
    assert.strictEqual(blocked.acceptanceRecordedAt, null);
    assert.strictEqual(blocked.awaitingVerdict, true);
    assert.strictEqual(blocked.awaitingVerdictArmedAt, "2026-07-22T00:03:00.000Z");
    assert.strictEqual(blocked.pendingVerdict, undefined);
    assert.match(blocked.pendingVerdictError, new RegExp(`transport status is ${transportStatus}`));
    assert.strictEqual(isPendingSettlement(blocked), true);
  }
});

test("applyQueuedVerdict settles queued rejected on a failed terminal", () => {
  const settled = applyQueuedVerdict(unverifiedRecord({
    transportStatus: "failed",
    pendingVerdict: {
      acceptance: "rejected",
      source: "main-loop",
      reason: "verification failed",
      failureKind: "style_mismatch",
      queuedAt: "2026-07-22T00:00:00.000Z"
    }
  }), "2026-07-22T00:03:00.000Z");

  assert.strictEqual(settled.acceptance, "rejected");
  assert.strictEqual(settled.acceptanceFailureKind, "style_mismatch");
  assert.strictEqual(settled.acceptanceRecordedAt, "2026-07-22T00:03:00.000Z");
  assert.strictEqual(settled.awaitingVerdict, false);
  assert.strictEqual(settled.pendingVerdict, undefined);
});

test("worker acceptance preserves semantic failure kinds through settlement and queued verdicts", (t) => {
  const directory = sandbox(t);
  const env = { FUSION_WORKER_STATE_DIR: path.join(directory, "worker-state") };
  const settledTaskId = "fusion-semantic-settled";
  const queuedTaskId = "fusion-semantic-queued";
  const baseline = createWorkerRecord({ taskId: settledTaskId, sessionId: "session-semantic", dispatchToolUseId: "tool-semantic", agentType: "fusion:fast-worker", workspaceRoot: directory, limits: {} }, env);
  assert.strictEqual(baseline.acceptanceFailureKind, null);
  updateWorkerRecord(settledTaskId, env, (record) => ({ ...record, transportStatus: "done" }));

  const settled = recordWorkerAcceptance({ taskId: settledTaskId, acceptance: "rejected", env, failureKind: "intent_override" });
  assert.strictEqual(settled.record.acceptanceFailureKind, "intent_override");

  createWorkerRecord({ taskId: queuedTaskId, sessionId: "session-semantic", dispatchToolUseId: "tool-semantic-queued", agentType: "fusion:fast-worker", workspaceRoot: directory, limits: {} }, env);
  const queued = recordWorkerAcceptance({ taskId: queuedTaskId, acceptance: "rejected", env, failureKind: "scope_rewrite" });
  assert.strictEqual(queued.queued, true);
  assert.strictEqual(queued.record.pendingVerdict.failureKind, "scope_rewrite");

  const applied = updateWorkerRecord(queuedTaskId, env, (record) => applyQueuedVerdict({ ...record, transportStatus: "done" }, "2026-07-22T00:05:00.000Z"));
  assert.strictEqual(applied.acceptanceFailureKind, "scope_rewrite");
  assert.strictEqual(applied.pendingVerdict, undefined);
});

test("pending settlement clears after recordWorkerAcceptance and applyQueuedVerdict", (t) => {
  const directory = sandbox(t);
  const env = { FUSION_WORKER_STATE_DIR: path.join(directory, "worker-state") };
  const taskId = "fusion-contract-anchor";
  createWorkerRecord({ taskId, sessionId: "session-anchor", dispatchToolUseId: "tool-anchor", agentType: "fusion:fast-worker", workspaceRoot: directory, limits: {} }, env);
  updateWorkerRecord(taskId, env, (record) => markWorkerCollected({ ...record, transportStatus: "done" }, WORKER_COLLECTION_METHODS.TASK_NOTIFICATION, "2026-07-22T00:00:00.000Z"));
  const pending = updateWorkerRecord(taskId, env, (record) => record);

  assert.strictEqual(isPendingSettlement(pending), true);
  const acceptance = recordWorkerAcceptance({ taskId, acceptance: "accepted", env });
  assert.strictEqual(acceptance.queued, false);
  assert.strictEqual(isPendingSettlement(acceptance.record), false);

  const queued = unverifiedRecord({
    pendingVerdict: {
      acceptance: "rejected",
      source: "main-loop",
      reason: null,
      queuedAt: "2026-07-22T00:00:00.000Z"
    }
  });
  assert.strictEqual(isPendingSettlement(applyQueuedVerdict(queued, "2026-07-22T00:04:00.000Z")), false);
});
