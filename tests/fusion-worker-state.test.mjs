import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WORKER_COLLECTION_METHODS,
  applyQueuedVerdict,
  canonicalWorkerAgentType,
  createWorkerRecord,
  isPendingSettlement,
  isSettledWorker,
  markWorkerCollected,
  pruneExpiredWorkerRecords,
  readWorkerRecord,
  readWorkerSessionState,
  readSessionWorkerRecords,
  reopenWorkerContinuation,
  recordWorkerAcceptance,
  resolveWorkerRetentionDays,
  updateWorkerRecord
} from "../plugins/fusion/scripts/lib/worker-state.mjs";

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

test("session index records each created task once and isolates strict reads", (t) => {
  const directory = sandbox(t);
  const env = { FUSION_WORKER_STATE_DIR: path.join(directory, "workers") };
  const first = createWorkerRecord({ taskId: "fusion-session-first", sessionId: "session-a", agentType: "fusion:claude-worker", workspaceRoot: directory }, env);
  const second = createWorkerRecord({ taskId: "fusion-session-second", sessionId: "session-a", agentType: "fusion:claude-worker", workspaceRoot: directory }, env);
  createWorkerRecord({ taskId: "fusion-other-session", sessionId: "session-b", agentType: "fusion:claude-worker", workspaceRoot: directory }, env);
  assert.deepStrictEqual(readWorkerSessionState("session-a", env).taskIds, [first.taskId, second.taskId]);
  fs.writeFileSync(path.join(env.FUSION_WORKER_STATE_DIR, "jobs", "fusion-other-session.json"), "not json");
  assert.deepStrictEqual(readSessionWorkerRecords(env, "session-a", { strict: true }).map((record) => record.taskId), [first.taskId, second.taskId]);
  fs.rmSync(path.join(env.FUSION_WORKER_STATE_DIR, "jobs", `${second.taskId}.json`));
  assert.deepStrictEqual(readSessionWorkerRecords(env, "session-a", { strict: true }).map((record) => record.taskId), [first.taskId]);
  fs.writeFileSync(path.join(env.FUSION_WORKER_STATE_DIR, "jobs", `${first.taskId}.json`), "not json");
  assert.throws(() => readSessionWorkerRecords(env, "session-a", { strict: true }), /unreadable/);
});

test("worker creation indexes the task before publishing its record", (t) => {
  const directory = sandbox(t);
  const env = { FUSION_WORKER_STATE_DIR: path.join(directory, "workers") };
  const taskId = "fusion-index-before-record";
  const originalRename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === path.join(env.FUSION_WORKER_STATE_DIR, "jobs", `${taskId}.json`)) {
      assert.deepStrictEqual(readWorkerSessionState("session-order", env).taskIds, [taskId]);
      throw new Error("simulated crash before record publication");
    }
    return originalRename(source, target);
  };
  try {
    assert.throws(() => createWorkerRecord({ taskId, sessionId: "session-order", agentType: "fusion:claude-worker", workspaceRoot: directory }, env), /simulated crash/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.strictEqual(readWorkerRecord(taskId, env), null);
  assert.deepStrictEqual(readSessionWorkerRecords(env, "session-order", { strict: true }), []);
});

test("session read scans legacy records once and backfills the index", (t) => {
  const directory = sandbox(t);
  const env = { FUSION_WORKER_STATE_DIR: path.join(directory, "workers") };
  const first = createWorkerRecord({ taskId: "fusion-legacy-first", sessionId: "session-legacy", agentType: "fusion:claude-worker", workspaceRoot: directory }, env);
  createWorkerRecord({ taskId: "fusion-legacy-other", sessionId: "session-other", agentType: "fusion:claude-worker", workspaceRoot: directory }, env);
  const sessionFile = path.join(env.FUSION_WORKER_STATE_DIR, "sessions", "session-legacy.json");
  fs.writeFileSync(sessionFile, JSON.stringify({ parentContextAdvisorySent: true }));
  assert.deepStrictEqual(readSessionWorkerRecords(env, "session-legacy").map((record) => record.taskId), [first.taskId]);
  assert.deepStrictEqual(readWorkerSessionState("session-legacy", env), { parentContextAdvisorySent: true, taskIds: [first.taskId] });
  fs.writeFileSync(path.join(env.FUSION_WORKER_STATE_DIR, "jobs", "fusion-legacy-other.json"), "not json");
  assert.deepStrictEqual(readSessionWorkerRecords(env, "session-legacy", { strict: true }).map((record) => record.taskId), [first.taskId]);
});

test("new dispatch preserves older records when a session index needs migration", (t) => {
  const directory = sandbox(t);
  const env = { FUSION_WORKER_STATE_DIR: path.join(directory, "workers") };
  const first = createWorkerRecord({ taskId: "fusion-before-index", sessionId: "session-legacy", agentType: "fusion:claude-worker", workspaceRoot: directory }, env);
  fs.writeFileSync(path.join(env.FUSION_WORKER_STATE_DIR, "sessions", "session-legacy.json"), "{}");
  const second = createWorkerRecord({ taskId: "fusion-after-index", sessionId: "session-legacy", agentType: "fusion:claude-worker", workspaceRoot: directory }, env);
  assert.deepStrictEqual(readWorkerSessionState("session-legacy", env).taskIds, [first.taskId, second.taskId]);
  assert.deepStrictEqual(readSessionWorkerRecords(env, "session-legacy", { strict: true }).map((record) => record.taskId), [first.taskId, second.taskId]);
});

test("retired agent types still canonicalize so historical ledger records stay readable", () => {
  assert.strictEqual(canonicalWorkerAgentType("fusion:fast-worker"), "fusion:fast-worker");
  assert.strictEqual(canonicalWorkerAgentType("fast-worker"), "fusion:fast-worker");
  assert.strictEqual(canonicalWorkerAgentType("fusion:claude-worker"), "fusion:claude-worker");
});

test("worker record retention defaults to ninety days and accepts a zero opt out", () => {
  assert.strictEqual(resolveWorkerRetentionDays({}), 90);
  assert.strictEqual(resolveWorkerRetentionDays({ FUSION_WORKER_RETENTION_DAYS: "30" }), 30);
  assert.strictEqual(resolveWorkerRetentionDays({ FUSION_WORKER_RETENTION_DAYS: "0" }), 0);
  assert.strictEqual(resolveWorkerRetentionDays({ FUSION_WORKER_RETENTION_DAYS: "not-a-number" }), 90);
});

test("retention removes expired terminal records with their sidecars and keeps live work", (t) => {
  const directory = sandbox(t);
  const stateDir = path.join(directory, "worker-state");
  const env = { FUSION_WORKER_STATE_DIR: stateDir, FUSION_WORKER_RETENTION_DAYS: "30" };
  const jobsDir = path.join(stateDir, "jobs");
  const sessionsDir = path.join(stateDir, "sessions");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  const now = Date.parse("2026-07-31T00:00:00.000Z");
  const expiredMs = now - 40 * 24 * 60 * 60 * 1000;
  const freshMs = now - 5 * 24 * 60 * 60 * 1000;
  const write = (name, value, mtimeMs) => {
    const file = path.join(jobsDir, name);
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
  };

  write("fusion-aaaaaaaaaaaaaaaaaaaaaaaa.json", { taskId: "fusion-aaaaaaaaaaaaaaaaaaaaaaaa", transportStatus: "done" }, expiredMs);
  write("fusion-aaaaaaaaaaaaaaaaaaaaaaaa.final.txt", "collected result", expiredMs);
  write("fusion-bbbbbbbbbbbbbbbbbbbbbbbb.json", { taskId: "fusion-bbbbbbbbbbbbbbbbbbbbbbbb", transportStatus: "pending_async" }, expiredMs);
  write("fusion-cccccccccccccccccccccccc.json", { taskId: "fusion-cccccccccccccccccccccccc", transportStatus: "done" }, freshMs);
  const expiredSession = path.join(sessionsDir, "session-old.json");
  fs.writeFileSync(expiredSession, "{}");
  fs.utimesSync(expiredSession, expiredMs / 1000, expiredMs / 1000);

  const summary = pruneExpiredWorkerRecords(env, now);

  assert.deepStrictEqual(summary, { records: 1, sessions: 1 });
  assert.strictEqual(fs.existsSync(path.join(jobsDir, "fusion-aaaaaaaaaaaaaaaaaaaaaaaa.json")), false);
  assert.strictEqual(fs.existsSync(path.join(jobsDir, "fusion-aaaaaaaaaaaaaaaaaaaaaaaa.final.txt")), false);
  assert.strictEqual(fs.existsSync(path.join(jobsDir, "fusion-bbbbbbbbbbbbbbbbbbbbbbbb.json")), true);
  assert.strictEqual(fs.existsSync(path.join(jobsDir, "fusion-cccccccccccccccccccccccc.json")), true);
  assert.strictEqual(fs.existsSync(expiredSession), false);
});

test("retention set to zero removes nothing", (t) => {
  const directory = sandbox(t);
  const stateDir = path.join(directory, "worker-state");
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const file = path.join(jobsDir, "fusion-dddddddddddddddddddddddd.json");
  fs.writeFileSync(file, JSON.stringify({ taskId: "fusion-dddddddddddddddddddddddd", transportStatus: "done" }));
  const ancient = Date.parse("2020-01-01T00:00:00.000Z") / 1000;
  fs.utimesSync(file, ancient, ancient);

  const summary = pruneExpiredWorkerRecords({ FUSION_WORKER_STATE_DIR: stateDir, FUSION_WORKER_RETENTION_DAYS: "0" }, Date.now());

  assert.deepStrictEqual(summary, { records: 0, sessions: 0 });
  assert.strictEqual(fs.existsSync(file), true);
});

test("settlement seam identifies pending and settled worker records", () => {
  const pending = unverifiedRecord();
  const settled = unverifiedRecord({ acceptance: "accepted", acceptanceRecordedAt: "2026-07-22T00:01:00.000Z", awaitingVerdict: false, awaitingVerdictArmedAt: null });

  assert.strictEqual(isPendingSettlement(pending), true);
  assert.strictEqual(isSettledWorker(pending), false);
  assert.strictEqual(isPendingSettlement(settled), false);
  assert.strictEqual(isSettledWorker(settled), true);
});

test("continuation snapshots keep each round's job ids and verdict separate", () => {
  const firstId = "a".repeat(32);
  const secondId = "b".repeat(32);
  const first = reopenWorkerContinuation(unverifiedRecord({ peerJobId: firstId, peerJobIds: [firstId], acceptance: "accepted", acceptanceRecordedAt: "2026-09-27T00:00:00.000Z" }), "2026-09-27T00:01:00.000Z");
  assert.deepStrictEqual(first.continuations[0].peerJobIds, [firstId]);
  assert.deepStrictEqual(first.peerJobIds, [firstId]);
  assert.strictEqual(first.peerJobId, null);
  const second = reopenWorkerContinuation({ ...first, transportStatus: "done", peerJobId: secondId, peerJobIds: [firstId, secondId], acceptance: "rejected", acceptanceRecordedAt: "2026-09-27T00:02:00.000Z" }, "2026-09-27T00:03:00.000Z");
  assert.deepStrictEqual(second.continuations.map((round) => round.peerJobIds), [[firstId], [secondId]]);
  assert.deepStrictEqual(second.continuations.map((round) => round.acceptance), ["accepted", "rejected"]);
  assert.deepStrictEqual(second.peerJobIds, [firstId, secondId]);
  assert.strictEqual(second.continuationCount, 2);
});

test("Fusion worker continuation resets round state and records its budget baseline", () => {
  const at = "2026-09-27T00:01:00.000Z";
  const prior = unverifiedRecord({
    agentType: "fusion:claude-worker",
    acceptance: "accepted",
    turns: 62,
    usage: { outputTokens: 97_000, uncachedTokens: 721_000 },
    retryCount: 1,
    terminalWriteGraceUsedAt: "2026-09-27T00:00:00.000Z",
    cancelReason: "old budget",
    cancelRequestedAt: "2026-09-27T00:00:00.000Z",
    windDownContextSentAt: "2026-09-27T00:00:00.000Z",
    tokenWindDownSentAt: "2026-09-27T00:00:00.000Z",
    uncachedWindDownSentAt: "2026-09-27T00:00:00.000Z",
    lastLivenessAt: "2026-09-27T00:00:00.000Z"
  });
  const reopened = reopenWorkerContinuation(prior, at);

  assert.deepStrictEqual(reopened.budgetBaseline, { at, turns: 62, outputTokens: 97_000, uncachedTokens: 721_000 });
  assert.strictEqual(reopened.transportStatus, "running");
  assert.strictEqual(reopened.lastLivenessAt, at);
  assert.deepStrictEqual(Object.fromEntries(["terminalWriteGraceUsedAt", "cancelReason", "cancelRequestedAt", "windDownContextSentAt", "tokenWindDownSentAt", "uncachedWindDownSentAt"].map((key) => [key, reopened[key]])), {
    terminalWriteGraceUsedAt: null,
    cancelReason: null,
    cancelRequestedAt: null,
    windDownContextSentAt: null,
    tokenWindDownSentAt: null,
    uncachedWindDownSentAt: null
  });
  assert.strictEqual(reopened.retryCount, 0);
  assert.strictEqual(reopened.continuations[0].acceptance, "accepted");
  assert.strictEqual(reopened.continuations[0].transportStatus, "done");
});

test("unsettled continuation keeps its job id available for the next verdict", () => {
  const jobId = "c".repeat(32);
  const reopened = reopenWorkerContinuation(unverifiedRecord({ peerJobId: jobId, peerJobIds: [jobId], infraFailure: true }), "2026-09-27T00:01:00.000Z");
  assert.deepStrictEqual(reopened.continuations, []);
  assert.strictEqual(reopened.peerJobId, jobId);
  assert.deepStrictEqual(reopened.peerJobIds, [jobId]);
  assert.strictEqual(reopened.transportStatus, "running");
  assert.strictEqual(reopened.infraFailure, null);
});

test("settled continuation archives infrastructure failure without carrying it forward", () => {
  const reopened = reopenWorkerContinuation(unverifiedRecord({ acceptance: "rejected", infraFailure: true }));
  assert.strictEqual(reopened.continuations[0].infraFailure, true);
  assert.strictEqual(reopened.infraFailure, null);
  const successfulLaterRound = { ...reopened, transportStatus: "done", acceptance: "accepted" };
  assert.notStrictEqual(successfulLaterRound.infraFailure, true);
});

test("created worker records stamp the Fusion companion version", (t) => {
  const directory = sandbox(t);
  const env = { FUSION_WORKER_STATE_DIR: path.join(directory, "worker-state") };
  const expectedVersion = JSON.parse(fs.readFileSync(new URL("../plugins/fusion/.claude-plugin/plugin.json", import.meta.url), "utf8")).version;
  const record = createWorkerRecord({ taskId: "fusion-version-stamp", sessionId: "session-version", dispatchToolUseId: "tool-version", agentType: "fusion:claude-worker", workspaceRoot: directory, limits: {} }, env);

  assert.strictEqual(typeof record.companionVersion, "string");
  assert.strictEqual(record.companionVersion, expectedVersion);
});

test("worker records create and normalize the nullable peer failure kind", (t) => {
  const directory = sandbox(t);
  const env = { FUSION_WORKER_STATE_DIR: path.join(directory, "worker-state") };
  const taskId = "fusion-peer-failure-kind";
  const created = createWorkerRecord({ taskId, sessionId: "session-peer-kind", agentType: "fusion:claude-worker", workspaceRoot: directory }, env);
  assert.strictEqual(created.peerFailureKind, null);

  const file = path.join(env.FUSION_WORKER_STATE_DIR, "jobs", `${taskId}.json`);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  delete stored.peerFailureKind;
  fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  assert.strictEqual(readWorkerRecord(taskId, env).peerFailureKind, null);
});

test("peer wrapper records start with an empty job history and older records load one", (t) => {
  const directory = sandbox(t);
  const env = { FUSION_WORKER_STATE_DIR: path.join(directory, "worker-state") };
  for (const [index, agentType] of ["codex:codex-rescue", "grok:grok-rescue", "grok:grok-review-runner"].entries()) {
    const taskId = `fusion-peer-history-${index}`;
    const created = createWorkerRecord({ taskId, sessionId: "session-peer-history", agentType, workspaceRoot: directory }, env);
    assert.deepStrictEqual(created.peerJobIds, []);
    const file = path.join(env.FUSION_WORKER_STATE_DIR, "jobs", `${taskId}.json`);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    delete stored.peerJobIds;
    fs.writeFileSync(file, `${JSON.stringify(stored)}\n`, "utf8");
    assert.deepStrictEqual(readWorkerRecord(taskId, env).peerJobIds, []);
  }
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
  const baseline = createWorkerRecord({ taskId: settledTaskId, sessionId: "session-semantic", dispatchToolUseId: "tool-semantic", agentType: "fusion:claude-worker", workspaceRoot: directory, limits: {} }, env);
  assert.strictEqual(baseline.acceptanceFailureKind, null);
  updateWorkerRecord(settledTaskId, env, (record) => ({ ...record, transportStatus: "done" }));

  const settled = recordWorkerAcceptance({ taskId: settledTaskId, acceptance: "rejected", env, failureKind: "oversized" });
  assert.strictEqual(settled.record.acceptanceFailureKind, "oversized");

  createWorkerRecord({ taskId: queuedTaskId, sessionId: "session-semantic", dispatchToolUseId: "tool-semantic-queued", agentType: "fusion:claude-worker", workspaceRoot: directory, limits: {} }, env);
  const queued = recordWorkerAcceptance({ taskId: queuedTaskId, acceptance: "rejected", env, failureKind: "scope_rewrite" });
  assert.strictEqual(queued.queued, true);
  assert.strictEqual(queued.record.pendingVerdict.failureKind, "scope_rewrite");

  const applied = updateWorkerRecord(queuedTaskId, env, (record) => applyQueuedVerdict({ ...record, transportStatus: "done" }, "2026-07-22T00:05:00.000Z"));
  assert.strictEqual(applied.acceptanceFailureKind, "scope_rewrite");
  assert.strictEqual(applied.pendingVerdict, undefined);

  const invalidTaskId = "fusion-semantic-invalid";
  createWorkerRecord({ taskId: invalidTaskId, sessionId: "session-semantic", agentType: "fusion:claude-worker", workspaceRoot: directory }, env);
  updateWorkerRecord(invalidTaskId, env, (record) => ({ ...record, transportStatus: "done" }));
  assert.throws(
    () => recordWorkerAcceptance({ taskId: invalidTaskId, acceptance: "rejected", env, failureKind: "not_a_kind" }),
    /intent_override, scope_rewrite, wrong_approach, style_mismatch, oversized/
  );
  assert.strictEqual(readWorkerRecord(invalidTaskId, env).acceptance, "unverified");
});

test("pending settlement clears after recordWorkerAcceptance and applyQueuedVerdict", (t) => {
  const directory = sandbox(t);
  const env = { FUSION_WORKER_STATE_DIR: path.join(directory, "worker-state") };
  const taskId = "fusion-contract-anchor";
  createWorkerRecord({ taskId, sessionId: "session-anchor", dispatchToolUseId: "tool-anchor", agentType: "fusion:claude-worker", workspaceRoot: directory, limits: {} }, env);
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
