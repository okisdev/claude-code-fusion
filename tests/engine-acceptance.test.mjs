import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ENGINE_IDS } from "../plugins/fusion/scripts/lib/engines.mjs";
import { deliverWorkerEngineAcceptance, newestEngineCompanion, prepareEngineAcceptanceDelivery, recordEngineAcceptance, retryWorkerEngineAcceptances } from "../plugins/fusion/scripts/lib/engine-acceptance.mjs";
import { settleQueuedVerdict } from "../plugins/fusion/scripts/lib/lifecycle/collection.mjs";
import { createWorkerRecord, readSessionWorkerRecords, readWorkerRecord, readWorkerSessionState, recordWorkerAcceptance, reopenWorkerContinuation, updateWorkerRecord, workerRecordFile } from "../plugins/fusion/scripts/lib/worker-state.mjs";
import { settleRecords } from "../plugins/fusion/scripts/lib/stats/settlement.mjs";
import { readEngineJobFailureKind, readEngineJobRecord } from "../plugins/fusion/scripts/lib/engine-job-state.mjs";
import { tokenUsageSidecarPath } from "../plugins/fusion/scripts/lib/stats/evidence.mjs";
import { handleLifecycleHook } from "../plugins/fusion/scripts/worker-lifecycle.mjs";

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-acceptance-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function companion(root, source) {
  const file = path.join(root, "codex-companion.mjs");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, source);
  return file;
}

function cachedCompanion(home, version, modifiedAt) {
  const file = companion(path.join(home, ".claude", "plugins", "cache", "claude-code-fusion", "codex", version, "scripts"), "export {};\n");
  fs.utimesSync(file, modifiedAt, modifiedAt);
  return file;
}

test("settlement observes peer token usage without starting a monitor", (t) => {
  const root = sandbox(t);
  const taskId = `fusion-${"d".repeat(24)}`;
  const jobId = "e".repeat(32);
  const env = { HOME: root, FUSION_DATA_DIR: path.join(root, "fusion"), FUSION_WORKER_STATE_DIR: path.join(root, "workers"), GROK_COMPANION_DATA: path.join(root, "grok"), CURSOR_COMPANION_DATA: path.join(root, "cursor"), DEVIN_COMPANION_DATA: path.join(root, "devin") };
  const jobFile = path.join(env.GROK_COMPANION_DATA, "state", "workspace", "jobs", `${jobId}.json`);
  fs.mkdirSync(path.dirname(jobFile), { recursive: true });
  fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, cwd: root, status: "done", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }));
  createWorkerRecord({ taskId, sessionId: "settlement-only", agentType: "fusion:claude-worker", workspaceRoot: root }, env);
  updateWorkerRecord(taskId, env, (record) => ({ ...record, transportStatus: "done" }));
  const result = settleRecords({ records: [{ id: taskId, verdict: "accepted" }], source: "main-loop", asJson: true, env, stdout: { write() {} }, stderr: { write(message) { assert.fail(message); } } });
  assert.deepEqual(result.errors, []);
  const observations = fs.readFileSync(tokenUsageSidecarPath(root, env), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].jobId, jobId);
  assert.equal(observations[0].engine, "grok");
  assert.equal(observations[0].availability, "available");
  assert.equal(observations[0].tokenUsage.totalTokens, 3);
});

test("record acceptance survives a removed workspace", (t) => {
  const root = sandbox(t);
  const workspaceRoot = path.join(root, "removed-worktree");
  const ledger = path.join(root, "ledger.json");
  const bin = companion(path.join(root, "companion"), 'import fs from "node:fs";\nfs.writeFileSync(process.env.TEST_LEDGER, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n');
  fs.mkdirSync(workspaceRoot);
  fs.rmdirSync(workspaceRoot);

  const result = recordEngineAcceptance({ engine: "codex", jobId: "a".repeat(32), acceptance: "accepted", workspaceRoot, env: { ...process.env, FUSION_CODEX_COMPANION: bin, TEST_LEDGER: ledger } });

  assert.deepEqual(result, { updated: true });
  const written = JSON.parse(fs.readFileSync(ledger, "utf8"));
  assert.equal(written.cwd, fs.realpathSync(path.dirname(bin)));
  assert.deepEqual(written.args.slice(0, 5), ["record-acceptance", "--job-id", "a".repeat(32), "--acceptance", "accepted"]);
});

test("a spawn error reports its own cause", (t) => {
  const root = sandbox(t);
  const bin = companion(path.join(root, "companion"), "export {};\n");

  assert.throws(
    () => recordEngineAcceptance({ engine: "codex", jobId: "a".repeat(32), acceptance: "accepted", env: { ...process.env, FUSION_CODEX_COMPANION: bin, TEST_OVERSIZED_ENV: "x".repeat(4_000_000) } }),
    (error) => error.code === "E2BIG" && !/Upgrade the Codex plugin/.test(error.message)
  );
});

test("matching fusion version wins, then highest semantic version wins", (t) => {
  const root = sandbox(t);
  const home = path.join(root, "home");
  const current = JSON.parse(fs.readFileSync(new URL("../plugins/fusion/.claude-plugin/plugin.json", import.meta.url), "utf8")).version;
  const older = cachedCompanion(home, "0.0.9", new Date("2026-10-03"));
  const newer = cachedCompanion(home, "0.0.10", new Date("2026-10-01"));
  cachedCompanion(home, "0.0.10-beta.1", new Date("2026-10-04"));

  assert.equal(newestEngineCompanion("codex", { HOME: home }), newer);
  const matching = cachedCompanion(home, current, new Date("2026-09-01"));
  assert.equal(newestEngineCompanion("codex", { HOME: home }), matching);
  assert.equal(newestEngineCompanion("codex", { HOME: home, FUSION_CODEX_COMPANION: older }), older);
});

test("queued accepted verdict enables failed transport for a salvaged timeout", async (t) => {
  const root = sandbox(t);
  const workspaceRoot = path.join(root, "worktree");
  const stateRoot = path.join(root, "codex-state");
  const jobId = "b".repeat(32);
  const taskId = `fusion-${"c".repeat(24)}`;
  const calls = path.join(root, "calls.json");
  const bin = companion(path.join(root, "companion"), 'import fs from "node:fs";\nconst args = process.argv.slice(2);\nfs.writeFileSync(process.env.TEST_CALLS, JSON.stringify(args));\nif (!args.includes("--accept-failed-transport")) { process.stderr.write("has transport status error. Pass --accept-failed-transport"); process.exitCode = 1; }\n');
  const jobFile = path.join(stateRoot, "retained-workspace", "jobs", `${jobId}.json`);
  fs.mkdirSync(path.dirname(jobFile), { recursive: true });
  fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, workspaceRoot, status: "error", failureKind: "timeout" }));
  fs.mkdirSync(workspaceRoot);
  const env = { ...process.env, FUSION_WORKER_STATE_DIR: path.join(root, "workers"), FUSION_CODEX_STATE: stateRoot, FUSION_CODEX_COMPANION: bin, TEST_CALLS: calls };
  createWorkerRecord({ taskId, sessionId: "session-1", agentType: "codex:codex-rescue", workspaceRoot }, env);
  const queued = recordWorkerAcceptance({ taskId, acceptance: "accepted", source: "main-loop", env });
  assert.equal(queued.queued, true);
  fs.rmdirSync(workspaceRoot);

  const settled = updateWorkerRecord(taskId, env, (record) => settleQueuedVerdict({ ...record, transportStatus: "done", peerEngine: "codex", peerJobId: jobId }, new Date().toISOString(), env));

  assert.equal(settled.acceptance, "accepted");
  assert.equal(settled.engineAcceptanceDelivery.status, "pending");
  assert.equal(fs.existsSync(calls), false);
  await Promise.resolve();
  assert.equal(readWorkerRecord(taskId, env).engineAcceptanceDelivery.status, "delivered");
  assert.equal(settled.engineSettlementError, undefined);
  assert.ok(JSON.parse(fs.readFileSync(calls, "utf8")).includes("--accept-failed-transport"));
});

function deliveryWorker(t, source) {
  const root = sandbox(t);
  const taskId = `fusion-${"d".repeat(24)}`;
  const jobId = "e".repeat(32);
  const calls = path.join(root, "calls.jsonl");
  const bin = companion(root, [
    'import assert from "node:assert/strict";',
    'import fs from "node:fs";',
    'const file = process.env.TEST_WORKER_FILE;',
    'assert.equal(fs.existsSync(`${file}.lock`), false, "worker lock held during delivery");',
    'const worker = JSON.parse(fs.readFileSync(file, "utf8"));',
    'assert.ok(worker.acceptanceRecordedAt);',
    'fs.appendFileSync(process.env.TEST_CALLS, `${JSON.stringify({ acceptance: worker.acceptance, args: process.argv.slice(2) })}\\n`);',
    source
  ].join("\n"));
  const env = { ...process.env, HOME: root, FUSION_WORKER_STATE_DIR: path.join(root, "workers"), FUSION_CODEX_STATE: path.join(root, "state"), FUSION_CODEX_COMPANION: bin, FUSION_ACCEPTANCE_RETRY_BACKOFF_MS: "0", TEST_CALLS: calls };
  env.TEST_WORKER_FILE = workerRecordFile(taskId, env);
  seedEngineJobs({ root, env }, [{ jobId }]);
  createWorkerRecord({ taskId, sessionId: "delivery-session", agentType: "codex:codex-rescue", workspaceRoot: root }, env);
  return { root, taskId, jobId, calls, env, bin };
}

function seedEngineJobs(box, jobs) {
  const directory = path.join(box.env.FUSION_CODEX_STATE, "workspace", "jobs");
  fs.mkdirSync(directory, { recursive: true });
  for (const { jobId } of jobs) fs.writeFileSync(path.join(directory, `${jobId}.json`), JSON.stringify({ id: jobId, workspaceRoot: box.root, status: "done" }));
}

test("missing engine records are checked in the store rather than companion error text", (t) => {
  const box = deliveryWorker(t, 'process.stderr.write("No job record found for this job."); process.exitCode = 1;');
  updateWorkerRecord(box.taskId, box.env, (record) => prepareEngineAcceptanceDelivery({ ...record, transportStatus: "done", acceptance: "unverified", acceptanceRecordedAt: new Date().toISOString() }, { jobs: [{ engine: "codex", jobId: box.jobId }] }));
  deliverWorkerEngineAcceptance({ taskId: box.taskId, env: box.env });
  assert.equal(readWorkerRecord(box.taskId, box.env).engineAcceptanceDelivery.status, "failed");
  assert.equal(readWorkerRecord(box.taskId, box.env).engineAcceptanceDelivery.attempts, 1);
  fs.unlinkSync(path.join(box.env.FUSION_CODEX_STATE, "workspace", "jobs", `${box.jobId}.json`));
  retryWorkerEngineAcceptances({ env: box.env, sessionId: "delivery-session" });
  const worker = readWorkerRecord(box.taskId, box.env);
  assert.equal(worker.engineAcceptanceDelivery.status, "skipped");
  assert.equal(worker.engineAcceptanceDelivery.attempts, 1);
  assert.equal(worker.engineAcceptanceDelivery.entries[0].skipReason, "record-missing");
  assert.equal(worker.acceptance, "unverified");
  assert.equal(fs.readFileSync(box.calls, "utf8").trim().split("\n").length, 1);
});

test("an engine record removed during delivery becomes terminal despite an unrelated error", (t) => {
  const box = deliveryWorker(t, 'fs.unlinkSync(process.env.TEST_JOB_FILE); process.stderr.write("store rotated"); process.exitCode = 1;');
  box.env.TEST_JOB_FILE = path.join(box.env.FUSION_CODEX_STATE, "workspace", "jobs", `${box.jobId}.json`);
  updateWorkerRecord(box.taskId, box.env, (record) => prepareEngineAcceptanceDelivery({ ...record, transportStatus: "done", acceptance: "accepted", acceptanceRecordedAt: new Date().toISOString() }, { jobs: [{ engine: "codex", jobId: box.jobId }] }));
  deliverWorkerEngineAcceptance({ taskId: box.taskId, env: box.env });
  const worker = readWorkerRecord(box.taskId, box.env);
  assert.equal(worker.engineAcceptanceDelivery.status, "skipped");
  assert.equal(worker.engineAcceptanceDelivery.attempts, 1);
  assert.equal(worker.engineAcceptanceDelivery.entries[0].skipReason, "record-missing");
  assert.equal(worker.engineSettlementError, undefined);
  assert.equal(worker.acceptance, "accepted");
  retryWorkerEngineAcceptances({ env: box.env });
  assert.equal(fs.readFileSync(box.calls, "utf8").trim().split("\n").length, 1);
});

test("an unreadable engine record remains pending until the store can be read", (t) => {
  const box = deliveryWorker(t, "");
  const file = path.join(box.env.FUSION_CODEX_STATE, "workspace", "jobs", `${box.jobId}.json`);
  updateWorkerRecord(box.taskId, box.env, (record) => prepareEngineAcceptanceDelivery({ ...record, transportStatus: "done", acceptance: "accepted", acceptanceRecordedAt: new Date().toISOString() }, { jobs: [{ engine: "codex", jobId: box.jobId }] }));
  fs.writeFileSync(file, "incomplete write");
  retryWorkerEngineAcceptances({ env: box.env });
  const pending = readWorkerRecord(box.taskId, box.env);
  assert.equal(pending.engineAcceptanceDelivery.status, "pending");
  assert.equal(pending.engineAcceptanceDelivery.attempts, 0);
  assert.equal(fs.existsSync(box.calls), false);
  seedEngineJobs(box, [{ jobId: box.jobId }]);
  retryWorkerEngineAcceptances({ env: box.env });
  assert.equal(readWorkerRecord(box.taskId, box.env).engineAcceptanceDelivery.status, "delivered");
});

function queueDelivery(box) {
  recordWorkerAcceptance({ taskId: box.taskId, acceptance: "accepted", env: box.env });
  return updateWorkerRecord(box.taskId, box.env, (record) => settleQueuedVerdict({ ...record, transportStatus: "done", peerEngine: "codex", peerJobId: box.jobId }, new Date().toISOString(), box.env));
}

test("tool hooks never retry engine acceptance delivery or alter it on denied launches", async (t) => {
  const box = deliveryWorker(t, "");
  updateWorkerRecord(box.taskId, box.env, (record) => prepareEngineAcceptanceDelivery({ ...record, transportStatus: "done", acceptance: "accepted", acceptanceRecordedAt: new Date().toISOString() }, { jobs: [{ engine: "codex", jobId: box.jobId }] }));
  const before = fs.readFileSync(workerRecordFile(box.taskId, box.env), "utf8");
  for (const input of [
    { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "codex:codex-rescue", run_in_background: true } },
    { hook_event_name: "PreToolUse", agent_type: "fusion:claude-worker", agent_id: "other-worker", tool_name: "Read", tool_input: {} },
    { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: path.join(box.root, "unrelated.txt") }, tool_response: "unrelated" },
    { hook_event_name: "PostToolUseFailure", agent_type: "fusion:claude-worker", agent_id: "other-worker", tool_name: "Read", tool_input: {} }
  ]) {
    await handleLifecycleHook({ ...input, session_id: "delivery-session" }, box.env);
    assert.equal(fs.existsSync(box.calls), false);
    assert.equal(fs.readFileSync(workerRecordFile(box.taskId, box.env), "utf8"), before);
  }
});

test("session acceptance retries use their pending index without parsing unrelated records", (t) => {
  const box = deliveryWorker(t, "");
  const otherId = `fusion-${"f".repeat(24)}`;
  createWorkerRecord({ taskId: otherId, sessionId: "delivery-session", agentType: "fusion:claude-worker", workspaceRoot: box.root }, box.env);
  updateWorkerRecord(box.taskId, box.env, (record) => prepareEngineAcceptanceDelivery({ ...record, acceptance: "accepted", acceptanceRecordedAt: new Date().toISOString() }, { jobs: [{ engine: "codex", jobId: box.jobId }] }));
  fs.writeFileSync(workerRecordFile(otherId, box.env), "unreadable unrelated record");
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    assert.notEqual(file, workerRecordFile(otherId, box.env), "unrelated record parsed during retry");
    return originalRead(file, ...args);
  };
  try {
    retryWorkerEngineAcceptances({ env: box.env, sessionId: "another-session" });
    assert.equal(fs.existsSync(box.calls), false);
    retryWorkerEngineAcceptances({ env: box.env, sessionId: "delivery-session" });
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(readWorkerRecord(box.taskId, box.env).engineAcceptanceDelivery.status, "delivered");
  assert.deepEqual(readWorkerSessionState("delivery-session", box.env).engineAcceptanceTaskIds, []);
});

test("bounded lifecycle retries time out quickly and back off by attempt count", async (t) => {
  const box = deliveryWorker(t, 'setInterval(() => {}, 1000);');
  box.env.FUSION_ACCEPTANCE_RETRY_TIMEOUT_MS = "100";
  box.env.FUSION_ACCEPTANCE_RETRY_BACKOFF_MS = "60000";
  updateWorkerRecord(box.taskId, box.env, (record) => prepareEngineAcceptanceDelivery({ ...record, transportStatus: "done", acceptance: "accepted", acceptanceRecordedAt: new Date().toISOString() }, { jobs: [{ engine: "codex", jobId: box.jobId }] }));
  const input = { hook_event_name: "SubagentStop", session_id: "delivery-session", agent_type: "fusion:claude-worker", agent_id: "other-worker" };
  const started = Date.now();
  await handleLifecycleHook(input, box.env);
  assert.ok(Date.now() - started < 1500);
  const failed = readWorkerRecord(box.taskId, box.env);
  assert.equal(failed.engineAcceptanceDelivery.status, "failed");
  assert.equal(failed.engineAcceptanceDelivery.attempts, 1);
  await handleLifecycleHook(input, box.env);
  assert.equal(readWorkerRecord(box.taskId, box.env).engineAcceptanceDelivery.attempts, 1);
  fs.writeFileSync(box.bin, 'import fs from "node:fs"; fs.appendFileSync(process.env.TEST_CALLS, "retry\\n");');
  updateWorkerRecord(box.taskId, box.env, (record) => ({ ...record, engineAcceptanceDelivery: { ...record.engineAcceptanceDelivery, attempts: 2, entries: record.engineAcceptanceDelivery.entries.map((entry) => ({ ...entry, attempts: 2, updatedAt: new Date(Date.now() - 61_000).toISOString() })) } }));
  await handleLifecycleHook(input, box.env);
  assert.equal(readWorkerRecord(box.taskId, box.env).engineAcceptanceDelivery.attempts, 2);
  updateWorkerRecord(box.taskId, box.env, (record) => ({ ...record, engineAcceptanceDelivery: { ...record.engineAcceptanceDelivery, entries: record.engineAcceptanceDelivery.entries.map((entry) => ({ ...entry, updatedAt: new Date(Date.now() - 121_000).toISOString() })) } }));
  await handleLifecycleHook(input, box.env);
  assert.equal(readWorkerRecord(box.taskId, box.env).engineAcceptanceDelivery.status, "delivered");
  assert.equal(readWorkerRecord(box.taskId, box.env).engineAcceptanceDelivery.attempts, 3);
});

test("lifecycle retry budget bounds a backlog of slow acceptance deliveries", async (t) => {
  const box = deliveryWorker(t, 'setInterval(() => {}, 1000);');
  box.env.FUSION_ACCEPTANCE_RETRY_TIMEOUT_MS = "300";
  const jobs = Array.from({ length: 10 }, (_, index) => ({ engine: "codex", jobId: index.toString(16).repeat(32) }));
  seedEngineJobs(box, jobs);
  updateWorkerRecord(box.taskId, box.env, (record) => prepareEngineAcceptanceDelivery({ ...record, transportStatus: "done", acceptance: "accepted", acceptanceRecordedAt: new Date().toISOString() }, { jobs }));
  const started = Date.now();
  await handleLifecycleHook({ hook_event_name: "SubagentStop", session_id: "delivery-session", agent_type: "fusion:claude-worker", agent_id: "other-worker" }, box.env);
  assert.ok(Date.now() - started < 3000);
  const delivery = readWorkerRecord(box.taskId, box.env).engineAcceptanceDelivery;
  assert.ok(delivery.attempts > 0 && delivery.attempts < jobs.length);
  assert.equal(delivery.entries.filter((entry) => entry.status === "failed").length, delivery.attempts);
  assert.equal(delivery.entries.filter((entry) => entry.status === "pending").length, jobs.length - delivery.attempts);
});

test("legacy acceptance index migration retains every pending worker after a write", (t) => {
  const box = deliveryWorker(t, "");
  const otherId = `fusion-${"f".repeat(24)}`;
  createWorkerRecord({ taskId: otherId, sessionId: "delivery-session", agentType: "codex:codex-rescue", workspaceRoot: box.root }, box.env);
  for (const taskId of [box.taskId, otherId]) {
    updateWorkerRecord(taskId, box.env, (record) => prepareEngineAcceptanceDelivery({ ...record, acceptance: "accepted", acceptanceRecordedAt: new Date().toISOString() }, { jobs: [{ engine: "codex", jobId: box.jobId }] }));
  }
  const sessionFile = path.join(box.env.FUSION_WORKER_STATE_DIR, "sessions", "delivery-session.json");
  const { engineAcceptanceTaskIds, ...legacy } = readWorkerSessionState("delivery-session", box.env);
  fs.writeFileSync(sessionFile, JSON.stringify(legacy));
  updateWorkerRecord(box.taskId, box.env, (record) => ({ ...record, description: "updated before migration" }));
  readSessionWorkerRecords(box.env, "delivery-session", { strict: true });
  assert.deepEqual(readWorkerSessionState("delivery-session", box.env).engineAcceptanceTaskIds, [box.taskId, otherId]);
  retryWorkerEngineAcceptances({ env: box.env, sessionId: "delivery-session" });
  assert.equal(readWorkerRecord(box.taskId, box.env).engineAcceptanceDelivery.status, "delivered");
  assert.equal(readWorkerRecord(otherId, box.env).engineAcceptanceDelivery.status, "delivered");
  assert.deepEqual(readWorkerSessionState("delivery-session", box.env).engineAcceptanceTaskIds, []);
});

test("queued engine delivery runs after the lock releases and preserves concurrent worker updates", async (t) => {
  const workerState = new URL("../plugins/fusion/scripts/lib/worker-state.mjs", import.meta.url).href;
  const box = deliveryWorker(t, `const { updateWorkerRecord } = await import(${JSON.stringify(workerState)});\nupdateWorkerRecord(worker.taskId, process.env, (current) => ({ ...current, description: "updated during delivery" }));`);
  const pending = queueDelivery(box);
  assert.equal(pending.engineAcceptanceDelivery.status, "pending");
  assert.equal(fs.existsSync(box.calls), false);
  await Promise.resolve();
  const delivered = readWorkerRecord(box.taskId, box.env);
  assert.equal(delivered.description, "updated during delivery");
  assert.equal(delivered.engineAcceptanceDelivery.status, "delivered");
  assert.equal(delivered.engineAcceptanceDelivery.attempts, 1);
  deliverWorkerEngineAcceptance({ taskId: box.taskId, env: box.env });
  assert.equal(fs.readFileSync(box.calls, "utf8").trim().split("\n").length, 1);
});

test("a companion ignoring termination times out without losing its verdict and a retry delivers", async (t) => {
  const box = deliveryWorker(t, 'if (fs.readFileSync(process.env.TEST_CALLS, "utf8").trim().split("\\n").length === 1) { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }');
  const started = Date.now();
  queueDelivery(box);
  await Promise.resolve();
  const failed = readWorkerRecord(box.taskId, box.env);
  assert.equal(failed.acceptance, "accepted");
  assert.equal(failed.engineAcceptanceDelivery.status, "failed");
  assert.equal(failed.engineAcceptanceDelivery.attempts, 1);
  assert.match(failed.engineAcceptanceDelivery.lastError, /timed out after 10 seconds/);
  assert.ok(Date.now() - started >= 10_000);
  assert.ok(Date.now() - started < 20_000);
  retryWorkerEngineAcceptances({ env: box.env });
  const delivered = readWorkerRecord(box.taskId, box.env);
  assert.equal(delivered.engineAcceptanceDelivery.status, "delivered");
  assert.equal(delivered.engineAcceptanceDelivery.attempts, 2);
  assert.equal(delivered.engineSettlementError, undefined);
  assert.equal(delivered.engineAcceptanceDelivery.lastError, null);
  retryWorkerEngineAcceptances({ env: box.env });
  assert.equal(fs.readFileSync(box.calls, "utf8").trim().split("\n").length, 2);
});

test("failed deliveries stop after five attempts and repeating the same verdict keeps the cap", async (t) => {
  const box = deliveryWorker(t, 'process.stderr.write("temporary failure"); process.exitCode = 1;');
  queueDelivery(box);
  await Promise.resolve();
  for (let attempt = 0; attempt < 6; attempt += 1) retryWorkerEngineAcceptances({ env: box.env });
  updateWorkerRecord(box.taskId, box.env, (record) => prepareEngineAcceptanceDelivery(record, { jobs: [{ engine: "codex", jobId: box.jobId }] }));
  retryWorkerEngineAcceptances({ env: box.env });
  const failed = readWorkerRecord(box.taskId, box.env);
  assert.equal(failed.engineAcceptanceDelivery.status, "failed");
  assert.equal(failed.engineAcceptanceDelivery.attempts, 5);
  assert.equal(failed.engineAcceptanceDelivery.entries[0].failures, 5);
  assert.equal(fs.readFileSync(box.calls, "utf8").trim().split("\n").length, 5);
});

for (const status of ["pending", "failed"]) {
  test(`a lifecycle hook retries ${status} acceptance delivery after settlement without another verdict`, async (t) => {
    const box = deliveryWorker(t, "");
    updateWorkerRecord(box.taskId, box.env, (record) => {
      const prepared = prepareEngineAcceptanceDelivery({ ...record, transportStatus: "done", acceptance: "accepted", acceptanceSource: "main-loop", acceptanceRecordedAt: new Date().toISOString() }, { jobs: [{ engine: "codex", jobId: box.jobId }] });
      return { ...prepared, engineAcceptanceDelivery: { ...prepared.engineAcceptanceDelivery, status, entries: prepared.engineAcceptanceDelivery.entries.map((entry) => ({ ...entry, status, attempts: 1, failures: status === "failed" ? 1 : 0 })) } };
    });
    const input = { hook_event_name: status === "pending" ? "Stop" : "SubagentStop", session_id: "delivery-session", agent_type: "fusion:claude-worker", agent_id: "other-worker" };
    await handleLifecycleHook({ ...input, session_id: "another-session" }, box.env);
    assert.equal(fs.existsSync(box.calls), false);
    await handleLifecycleHook(input, box.env);
    const delivered = readWorkerRecord(box.taskId, box.env);
    assert.equal(delivered.engineAcceptanceDelivery.status, "delivered");
    assert.equal(delivered.engineAcceptanceDelivery.entries[0].attempts, 2);
    assert.equal(delivered.acceptance, "accepted");
    await handleLifecycleHook(input, box.env);
    assert.equal(fs.readFileSync(box.calls, "utf8").trim().split("\n").length, 1);
    updateWorkerRecord(box.taskId, box.env, (record) => ({ ...record, engineAcceptanceDelivery: { ...record.engineAcceptanceDelivery, status: "failed", entries: record.engineAcceptanceDelivery.entries.map((entry) => ({ ...entry, status: "failed", attempts: 5, failures: 5 })) } }));
    await handleLifecycleHook(input, box.env);
    assert.equal(fs.readFileSync(box.calls, "utf8").trim().split("\n").length, 1);
  });
}

test("an interrupted delivery retries after its lease expires and survives a continuation", (t) => {
  const box = deliveryWorker(t, "");
  updateWorkerRecord(box.taskId, box.env, (record) => prepareEngineAcceptanceDelivery({ ...record, transportStatus: "done", acceptance: "accepted", acceptanceSource: "main-loop", acceptanceRecordedAt: new Date().toISOString(), peerJobId: box.jobId }, { jobs: [{ engine: "codex", jobId: box.jobId }] }));
  const claim = (updatedAt) => updateWorkerRecord(box.taskId, box.env, (record) => ({ ...record, engineAcceptanceDelivery: { ...record.engineAcceptanceDelivery, entries: record.engineAcceptanceDelivery.entries.map((entry) => ({ ...entry, attempts: 1, attemptId: "interrupted", updatedAt })) } }));
  claim(new Date().toISOString());
  retryWorkerEngineAcceptances({ env: box.env });
  assert.equal(fs.existsSync(box.calls), false);
  claim(new Date(Date.now() - 12_000).toISOString());
  updateWorkerRecord(box.taskId, box.env, (record) => reopenWorkerContinuation(record));
  fs.writeFileSync(box.bin, 'import fs from "node:fs"; fs.appendFileSync(process.env.TEST_CALLS, "delivered\\n");');
  retryWorkerEngineAcceptances({ env: box.env });
  const delivered = readWorkerRecord(box.taskId, box.env);
  assert.equal(delivered.acceptance, "unverified");
  assert.equal(delivered.continuations[0].acceptance, "accepted");
  assert.equal(delivered.engineAcceptanceDelivery.status, "delivered");
  assert.equal(delivered.engineAcceptanceDelivery.entries[0].acceptance, "accepted");
});

test("a retry delivers failed peers without resending peers already delivered", (t) => {
  const box = deliveryWorker(t, 'if (process.argv.includes("f".repeat(32)) && !fs.existsSync(process.env.TEST_READY)) { process.stderr.write("temporary failure"); process.exitCode = 1; }');
  box.env.TEST_READY = path.join(box.root, "ready");
  const jobs = [{ engine: "codex", jobId: box.jobId }, { engine: "codex", jobId: "f".repeat(32) }];
  seedEngineJobs(box, jobs);
  updateWorkerRecord(box.taskId, box.env, (record) => prepareEngineAcceptanceDelivery({ ...record, transportStatus: "done", acceptance: "accepted", acceptanceSource: "main-loop", acceptanceRecordedAt: new Date().toISOString() }, { jobs }));
  deliverWorkerEngineAcceptance({ taskId: box.taskId, env: box.env });
  assert.deepEqual(readWorkerRecord(box.taskId, box.env).engineAcceptanceDelivery.entries.map((entry) => entry.status), ["delivered", "failed"]);
  fs.writeFileSync(box.env.TEST_READY, "");
  retryWorkerEngineAcceptances({ env: box.env });
  const delivered = readWorkerRecord(box.taskId, box.env);
  assert.equal(delivered.engineAcceptanceDelivery.status, "delivered");
  assert.deepEqual(delivered.engineAcceptanceDelivery.entries.map((entry) => entry.attempts), [1, 2]);
  assert.deepEqual(fs.readFileSync(box.calls, "utf8").trim().split("\n").map((line) => JSON.parse(line).args[2]), [box.jobId, "f".repeat(32), "f".repeat(32)]);
});

test("a concurrent retry cannot claim a delivery while its companion is running", async (t) => {
  const acceptance = new URL("../plugins/fusion/scripts/lib/engine-acceptance.mjs", import.meta.url).href;
  const box = deliveryWorker(t, `const { retryWorkerEngineAcceptances } = await import(${JSON.stringify(acceptance)});\nretryWorkerEngineAcceptances({ env: process.env });`);
  queueDelivery(box);
  await Promise.resolve();
  assert.equal(readWorkerRecord(box.taskId, box.env).engineAcceptanceDelivery.status, "delivered");
  assert.equal(readWorkerRecord(box.taskId, box.env).engineAcceptanceDelivery.attempts, 1);
  assert.equal(fs.readFileSync(box.calls, "utf8").trim().split("\n").length, 1);
});

test("a verdict replaced during delivery reaches the engine after the older verdict", (t) => {
  const acceptanceModule = new URL("../plugins/fusion/scripts/lib/engine-acceptance.mjs", import.meta.url).href;
  const workerModule = new URL("../plugins/fusion/scripts/lib/worker-state.mjs", import.meta.url).href;
  const box = deliveryWorker(t, `
const { deliverWorkerEngineAcceptance, prepareEngineAcceptanceDelivery } = await import(${JSON.stringify(acceptanceModule)});
const { updateWorkerRecord } = await import(${JSON.stringify(workerModule)});
const args = process.argv.slice(2);
const acceptance = args[args.indexOf("--acceptance") + 1];
if (acceptance === "accepted") {
  updateWorkerRecord(worker.taskId, process.env, (current) => prepareEngineAcceptanceDelivery({ ...current, acceptance: "rejected", acceptanceReason: "verification failed", description: "updated during delivery" }, { jobs: [{ engine: "codex", jobId: args[args.indexOf("--job-id") + 1] }] }));
  deliverWorkerEngineAcceptance({ taskId: worker.taskId, env: process.env });
}
fs.writeFileSync(process.env.TEST_ENGINE_VERDICT, acceptance);
`);
  box.env.TEST_ENGINE_VERDICT = path.join(box.root, "engine-verdict");
  updateWorkerRecord(box.taskId, box.env, (record) => prepareEngineAcceptanceDelivery({ ...record, transportStatus: "done", acceptance: "accepted", acceptanceSource: "main-loop", acceptanceRecordedAt: new Date().toISOString() }, { jobs: [{ engine: "codex", jobId: box.jobId }] }));

  deliverWorkerEngineAcceptance({ taskId: box.taskId, env: box.env });

  const worker = readWorkerRecord(box.taskId, box.env);
  assert.equal(worker.acceptance, "rejected");
  assert.equal(worker.description, "updated during delivery");
  assert.equal(worker.engineAcceptanceDelivery.status, "delivered");
  assert.equal(worker.engineAcceptanceDelivery.entries[0].acceptance, "rejected");
  assert.equal(fs.readFileSync(box.env.TEST_ENGINE_VERDICT, "utf8"), "rejected");
  assert.deepEqual(fs.readFileSync(box.calls, "utf8").trim().split("\n").map((line) => JSON.parse(line).acceptance), ["accepted", "rejected"]);
});

for (const recovery of ["lifecycle", "same verdict"]) {
  test(`a crash after claiming attempt five recovers through ${recovery}`, async (t) => {
    const acceptanceModule = new URL("../plugins/fusion/scripts/lib/engine-acceptance.mjs", import.meta.url).href;
    const box = deliveryWorker(t, `
const attempts = fs.readFileSync(process.env.TEST_CALLS, "utf8").trim().split("\\n").length;
if (attempts <= 4) { process.stderr.write("temporary failure"); process.exitCode = 1; }
if (attempts === 5) process.kill(process.ppid, "SIGKILL");
`);
    const jobs = [{ engine: "codex", jobId: box.jobId }];
    updateWorkerRecord(box.taskId, box.env, (record) => prepareEngineAcceptanceDelivery({ ...record, transportStatus: "done", acceptance: "accepted", acceptanceSource: "main-loop", acceptanceRecordedAt: new Date().toISOString() }, { jobs }));
    for (let attempt = 0; attempt < 4; attempt += 1) deliverWorkerEngineAcceptance({ taskId: box.taskId, env: box.env });
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", `import { deliverWorkerEngineAcceptance } from ${JSON.stringify(acceptanceModule)}; deliverWorkerEngineAcceptance({ taskId: ${JSON.stringify(box.taskId)}, env: process.env });`], { env: box.env, encoding: "utf8", timeout: 5_000 });
    assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
    const claimed = readWorkerRecord(box.taskId, box.env).engineAcceptanceDelivery.entries[0];
    assert.equal(claimed.attempts, 5);
    assert.ok(claimed.attemptId);
    retryWorkerEngineAcceptances({ env: box.env });
    assert.equal(fs.readFileSync(box.calls, "utf8").trim().split("\n").length, 5);
    updateWorkerRecord(box.taskId, box.env, (record) => ({ ...record, engineAcceptanceDelivery: { ...record.engineAcceptanceDelivery, entries: record.engineAcceptanceDelivery.entries.map((entry) => {
      const { failures, ...legacy } = entry;
      return { ...(recovery === "same verdict" ? legacy : entry), updatedAt: new Date(Date.now() - 12_000).toISOString() };
    }) } }));
    const lockDirectory = path.dirname(workerRecordFile(box.taskId, box.env));
    for (const file of fs.readdirSync(lockDirectory).filter((file) => file.endsWith(".lock"))) {
      const staleAt = new Date(Date.now() - 12_000);
      fs.utimesSync(path.join(lockDirectory, file), staleAt, staleAt);
    }
    if (recovery === "same verdict") {
      updateWorkerRecord(box.taskId, box.env, (record) => prepareEngineAcceptanceDelivery(record, { jobs }));
      deliverWorkerEngineAcceptance({ taskId: box.taskId, env: box.env });
    } else {
      await handleLifecycleHook({ hook_event_name: "SubagentStop", session_id: "delivery-session", agent_type: "fusion:claude-worker", agent_id: "other-worker" }, box.env);
    }

    const delivered = readWorkerRecord(box.taskId, box.env);
    assert.equal(delivered.engineAcceptanceDelivery.status, "delivered");
    assert.equal(delivered.engineAcceptanceDelivery.entries[0].failures, 4);
    assert.equal(delivered.engineSettlementError, undefined);
    assert.equal(fs.readFileSync(box.calls, "utf8").trim().split("\n").length, 6);
  });
}

for (const engine of ENGINE_IDS) {
  test(`${engine} companion repeated acceptance preserves the job and verdict`, async (t) => {
    const root = sandbox(t);
    const data = path.join(root, "data");
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    if (["darwin", "freebsd", "openbsd"].includes(process.platform)) {
      fs.writeFileSync(path.join(bin, "ps"), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-p" ]; then printf "process-%s\\n" "$2"; exit 0; fi; shift; done\n', { mode: 0o755 });
      fs.writeFileSync(path.join(bin, "sysctl"), '#!/bin/sh\nprintf "{ sec = 1, usec = 0 }\\n"\n', { mode: 0o755 });
    }
    const jobId = "a".repeat(32);
    const file = path.join(data, "state", "workspace", "jobs", `${jobId}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { createJobRecord } = await import(`../plugins/${engine}/scripts/lib/state.mjs`);
    fs.writeFileSync(file, JSON.stringify({ ...createJobRecord({ id: jobId, cwd: root, workspaceRoot: root, status: "done", mode: "consult", briefFile: null }), resultText: "retained result" }));
    const env = { ...process.env, HOME: root, PATH: `${bin}${path.delimiter}${process.env.PATH}`, [`${engine.toUpperCase()}_COMPANION_DATA`]: data, [`FUSION_${engine.toUpperCase()}_COMPANION`]: new URL(`../plugins/${engine}/scripts/${engine}-companion.mjs`, import.meta.url).pathname };
    for (const acceptance of ["accepted", "rejected", "unverified"]) {
      const payload = { engine, jobId, acceptance, source: "main-loop", reason: acceptance === "rejected" ? "verification failed" : null, failureKind: acceptance === "rejected" ? "wrong_approach" : null, env };
      assert.deepEqual(recordEngineAcceptance(payload), { updated: true });
      const { updatedAt: _firstUpdated, acceptanceRecordedAt: _firstRecorded, ...first } = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.deepEqual(recordEngineAcceptance(payload), { updated: true });
      const { updatedAt: _secondUpdated, acceptanceRecordedAt: _secondRecorded, ...second } = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.deepEqual(second, first);
      assert.equal(second.semanticStatus, acceptance);
      assert.equal(second.resultText, "retained result");
    }
  });
}

test("an unreadable engine job record yields no failure kind on the hook path but fails strict reads", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-engine-job-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobs = path.join(root, "workspace-0123456789abcdef", "jobs");
  fs.mkdirSync(jobs, { recursive: true });
  const jobId = "a".repeat(32);
  fs.writeFileSync(path.join(jobs, `${jobId}.json`), "{\"status\":");
  const env = { FUSION_CODEX_STATE: root };
  assert.equal(readEngineJobFailureKind("codex", jobId, env), null);
  assert.throws(() => readEngineJobRecord("codex", jobId, env), SyntaxError);
});
