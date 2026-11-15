import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { deliverWorkerEngineAcceptance, newestEngineCompanion, prepareEngineAcceptanceDelivery, recordEngineAcceptance, retryWorkerEngineAcceptances } from "../plugins/fusion/scripts/lib/engine-acceptance.mjs";
import { settleQueuedVerdict } from "../plugins/fusion/scripts/lib/lifecycle/collection.mjs";
import { createWorkerRecord, readWorkerRecord, recordWorkerAcceptance, reopenWorkerContinuation, updateWorkerRecord, workerRecordFile } from "../plugins/fusion/scripts/lib/worker-state.mjs";

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
  const env = { ...process.env, HOME: root, FUSION_WORKER_STATE_DIR: path.join(root, "workers"), FUSION_CODEX_STATE: path.join(root, "state"), FUSION_CODEX_COMPANION: bin, TEST_CALLS: calls };
  env.TEST_WORKER_FILE = workerRecordFile(taskId, env);
  createWorkerRecord({ taskId, sessionId: "delivery-session", agentType: "codex:codex-rescue", workspaceRoot: root }, env);
  return { root, taskId, jobId, calls, env, bin };
}

function queueDelivery(box) {
  recordWorkerAcceptance({ taskId: box.taskId, acceptance: "accepted", env: box.env });
  return updateWorkerRecord(box.taskId, box.env, (record) => settleQueuedVerdict({ ...record, transportStatus: "done", peerEngine: "codex", peerJobId: box.jobId }, new Date().toISOString(), box.env));
}

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

for (const recovery of ["monitor", "same verdict"]) {
  test(`a crash after claiming attempt five recovers through ${recovery}`, (t) => {
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
      retryWorkerEngineAcceptances({ env: box.env });
    }

    const delivered = readWorkerRecord(box.taskId, box.env);
    assert.equal(delivered.engineAcceptanceDelivery.status, "delivered");
    assert.equal(delivered.engineAcceptanceDelivery.entries[0].failures, 4);
    assert.equal(delivered.engineSettlementError, undefined);
    assert.equal(fs.readFileSync(box.calls, "utf8").trim().split("\n").length, 6);
  });
}

for (const engine of ["codex", "grok", "cursor", "devin"]) {
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
