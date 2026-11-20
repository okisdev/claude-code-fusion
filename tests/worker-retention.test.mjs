import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createWorkerRecord,
  pruneExpiredWorkerRecords,
  readWorkerRollups
} from "../plugins/fusion/scripts/lib/worker-state.mjs";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-retention-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workers = path.join(root, "workers");
  return { root, workers, env: { FUSION_WORKER_STATE_DIR: workers, FUSION_WORKER_RETENTION_DAYS: "30" } };
}

function writeJob(workers, id, record, mtimeMs) {
  const file = path.join(workers, "jobs", `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record));
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test("dispatch gates retention scans for six hours and explicit force bypasses the stamp", (t) => {
  const { root, workers, env } = sandbox(t);
  const now = Date.now();
  const oldFile = writeJob(workers, "fusion-retention-old", {
    createdAt: new Date(now - 50 * DAY_MS).toISOString(),
    agentType: "fusion:claude-worker",
    transportStatus: "done"
  }, now - 40 * DAY_MS);
  let jobScans = 0;
  const originalReaddir = fs.readdirSync;
  fs.readdirSync = (directory, ...args) => {
    if (directory === path.join(workers, "jobs")) jobScans += 1;
    return originalReaddir(directory, ...args);
  };
  try {
    createWorkerRecord({ taskId: "fusion-new-worker-one", sessionId: "session-retention", agentType: "fusion:claude-worker", workspaceRoot: root }, env);
    assert.strictEqual(fs.existsSync(oldFile), false);
    assert.strictEqual(jobScans, 1);
    createWorkerRecord({ taskId: "fusion-new-worker-two", sessionId: "session-retention", agentType: "fusion:claude-worker", workspaceRoot: root }, env);
    assert.strictEqual(jobScans, 1);
    assert.deepStrictEqual(pruneExpiredWorkerRecords(env, now + 6 * HOUR_MS - 1), { records: 0, sessions: 0 });
    assert.strictEqual(jobScans, 1);
    pruneExpiredWorkerRecords(env, now + 6 * HOUR_MS, { force: true });
    assert.strictEqual(jobScans, 2);
    pruneExpiredWorkerRecords(env, now + 12 * HOUR_MS + 1);
    assert.strictEqual(jobScans, 3);
  } finally {
    fs.readdirSync = originalReaddir;
  }
  assert.strictEqual(fs.existsSync(path.join(workers, ".retention-sweep")), true);
});

test("expired records append grouped additive rollups before removal", (t) => {
  const { workers, env } = sandbox(t);
  const now = Date.parse("2026-10-15T12:00:00.000Z");
  const old = now - 40 * DAY_MS;
  const record = (overrides = {}) => ({
    createdAt: "2026-07-12T00:00:00.000Z",
    agentType: "fusion:claude-worker",
    resolvedModel: "opus",
    transportStatus: "done",
    acceptance: "accepted",
    failureKind: null,
    startedAt: "2026-07-12T00:00:00.000Z",
    finishedAt: "2026-07-12T00:00:02.000Z",
    usage: { outputTokens: 10, uncachedTokens: 30, cacheReadInputTokens: 40 },
    ...overrides
  });
  const first = writeJob(workers, "fusion-rollup-one", record(), old);
  writeJob(workers, "fusion-rollup-two", record({ usage: { outputTokens: 4, uncachedTokens: 5, cacheReadInputTokens: 6 } }), old);
  writeJob(workers, "fusion-rollup-other", record({ acceptance: "rejected", failureKind: "timeout" }), old);
  writeJob(workers, "fusion-rollup-active", record({ transportStatus: "running" }), old);
  const unreadable = path.join(workers, "jobs", "fusion-rollup-unreadable.json");
  fs.writeFileSync(unreadable, "{ malformed");
  fs.utimesSync(unreadable, old / 1000, old / 1000);
  assert.deepStrictEqual(readWorkerRollups(env), []);
  assert.deepStrictEqual(pruneExpiredWorkerRecords(env, now), { records: 4, sessions: 0 });
  assert.strictEqual(fs.existsSync(first), false);
  assert.strictEqual(fs.existsSync(path.join(workers, "jobs", "fusion-rollup-active.json")), true);
  const rows = readWorkerRollups(env);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows.find((row) => row.acceptance === "accepted"), {
    schemaVersion: 1, month: "2026-07", agentType: "fusion:claude-worker", model: "opus",
    transportStatus: "done", acceptance: "accepted", failureKind: null, fallbackReason: null, count: 2,
    wallClockMsSum: 4000, outputTokensSum: 14, uncachedTokensSum: 35, cacheReadInputTokensSum: 46
  });
  assert.strictEqual(rows.find((row) => row.acceptance === "rejected").count, 1);
  assert.deepStrictEqual(rows.find((row) => row.month === null), {
    schemaVersion: 1, month: null, agentType: null, model: null,
    transportStatus: null, acceptance: null, failureKind: null, fallbackReason: null, count: 1,
    wallClockMsSum: 0, outputTokensSum: 0, uncachedTokensSum: 0, cacheReadInputTokensSum: 0
  });
  writeJob(workers, "fusion-rollup-later", record(), old);
  assert.deepStrictEqual(pruneExpiredWorkerRecords(env, now + HOUR_MS), { records: 0, sessions: 0 });
  assert.deepStrictEqual(pruneExpiredWorkerRecords(env, now + HOUR_MS, { force: true }), { records: 1, sessions: 0 });
  const deltas = readWorkerRollups(env).filter((row) => row.acceptance === "accepted");
  assert.deepStrictEqual(deltas.map((row) => row.count), [2, 1]);
});

test("rollup write failure leaves expired records available for a later sweep", (t) => {
  const { workers, env } = sandbox(t);
  const now = Date.now();
  const file = writeJob(workers, "fusion-rollup-retry", {
    createdAt: new Date(now - 40 * DAY_MS).toISOString(), transportStatus: "done"
  }, now - 40 * DAY_MS);
  const originalOpen = fs.openSync;
  fs.openSync = (target, ...args) => {
    if (target === path.join(workers, "rollup.jsonl")) throw new Error("rollup unavailable");
    return originalOpen(target, ...args);
  };
  try {
    assert.throws(() => pruneExpiredWorkerRecords(env, now), /rollup unavailable/);
  } finally {
    fs.openSync = originalOpen;
  }
  assert.strictEqual(fs.existsSync(file), true);
  assert.strictEqual(fs.existsSync(path.join(workers, ".retention-sweep")), false);
  assert.deepStrictEqual(pruneExpiredWorkerRecords(env, now), { records: 1, sessions: 0 });
});

test("retention preserves fallback reasons as separate rollup dimensions", (t) => {
  const { workers, env } = sandbox(t);
  const now = Date.now();
  const old = now - 40 * DAY_MS;
  for (const [index, fallbackReason] of ["privacy", "network", "privacy", null].entries()) {
    writeJob(workers, `fusion-fallback-${index}`, {
      createdAt: new Date(old).toISOString(), agentType: "fusion:claude-worker",
      transportStatus: "done", acceptance: "accepted", ...(fallbackReason ? { fallbackReason } : {})
    }, old);
  }
  assert.equal(pruneExpiredWorkerRecords(env, now).records, 4);
  const rows = readWorkerRollups(env);
  assert.equal(rows.length, 3);
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.fallbackReason ?? "unrecorded", row.count])), { privacy: 2, network: 1, unrecorded: 1 });
});

test("retention retries count each record once after rollup append succeeds and unlink fails", (t) => {
  const { workers, env } = sandbox(t);
  const now = Date.now();
  const old = now - 40 * DAY_MS;
  const record = {
    createdAt: new Date(old).toISOString(),
    transportStatus: "done",
    startedAt: new Date(old).toISOString(),
    finishedAt: new Date(old + 2000).toISOString(),
    usage: { outputTokens: 10, uncachedTokens: 30, cacheReadInputTokens: 40 }
  };
  const first = writeJob(workers, "fusion-unlink-first", record, old);
  const retry = writeJob(workers, "fusion-unlink-retry", record, old);
  const originalRemove = fs.rmSync;
  fs.rmSync = (file, ...args) => {
    if (file === retry) {
      assert.strictEqual(readWorkerRollups(env)[0].count, 2);
      throw new Error("unlink unavailable");
    }
    return originalRemove(file, ...args);
  };
  try {
    assert.deepStrictEqual(pruneExpiredWorkerRecords(env, now), { records: 1, sessions: 0 });
  } finally {
    fs.rmSync = originalRemove;
  }
  assert.strictEqual(fs.existsSync(first), false);
  assert.strictEqual(fs.existsSync(retry), true);
  const beforeRetry = readWorkerRollups(env);
  assert.deepStrictEqual(pruneExpiredWorkerRecords(env, now + 6 * HOUR_MS), { records: 1, sessions: 0 });
  assert.strictEqual(fs.existsSync(retry), false);
  assert.deepStrictEqual(readWorkerRollups(env), beforeRetry);
  assert.strictEqual(beforeRetry[0].count, 2);
  assert.strictEqual(beforeRetry[0].wallClockMsSum, 4000);
  assert.strictEqual(beforeRetry[0].outputTokensSum, 20);
  assert.strictEqual(beforeRetry[0].uncachedTokensSum, 60);
  assert.strictEqual(beforeRetry[0].cacheReadInputTokensSum, 80);
});

test("retention retries do not recount a rollup persisted before an interrupted sweep", (t) => {
  const { workers, env } = sandbox(t);
  const now = Date.now();
  const old = now - 40 * DAY_MS;
  const file = writeJob(workers, "fusion-rollup-interrupted", {
    createdAt: new Date(old).toISOString(), transportStatus: "done"
  }, old);
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = (target, content, ...args) => {
    const result = originalWrite(target, content, ...args);
    if (typeof target === "number" && typeof content === "string" && content.startsWith('{"schemaVersion":1,')) {
      throw new Error("sweep interrupted after append");
    }
    return result;
  };
  try {
    assert.throws(() => pruneExpiredWorkerRecords(env, now), /sweep interrupted after append/);
  } finally {
    fs.writeFileSync = originalWrite;
  }
  assert.strictEqual(fs.existsSync(file), true);
  assert.strictEqual(fs.existsSync(path.join(workers, ".retention-sweep")), false);
  const persisted = readWorkerRollups(env);
  assert.strictEqual(persisted[0].count, 1);
  assert.deepStrictEqual(pruneExpiredWorkerRecords(env, now), { records: 1, sessions: 0 });
  assert.strictEqual(fs.existsSync(file), false);
  assert.deepStrictEqual(readWorkerRollups(env), persisted);
});
