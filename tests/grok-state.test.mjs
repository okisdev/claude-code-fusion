import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as grok from "../plugins/grok/scripts/lib/state.mjs";
import * as cursor from "../plugins/cursor/scripts/lib/state.mjs";
import * as devin from "../plugins/devin/scripts/lib/state.mjs";

const identityBin = fs.mkdtempSync(path.join(os.tmpdir(), "grok-factory-identity-"));
const originalPath = process.env.PATH;
if (["darwin", "freebsd", "openbsd"].includes(process.platform)) {
  fs.writeFileSync(path.join(identityBin, "ps"), '#!/bin/sh\npid=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-p" ]; then pid="$2"; shift 2; else shift; fi\ndone\nprintf "process-%s\\n" "$pid"\n');
  fs.writeFileSync(path.join(identityBin, "sysctl"), '#!/bin/sh\nprintf "{ sec = 1, usec = 0 }\\n"\n');
  fs.writeFileSync(path.join(identityBin, "uptime"), '#!/bin/sh\nprintf "2020-01-01 00:00:00\\n"\n');
  for (const command of ["ps", "sysctl", "uptime"]) fs.chmodSync(path.join(identityBin, command), 0o755);
  process.env.PATH = `${identityBin}${path.delimiter}${originalPath}`;
}
test.after(() => {
  process.env.PATH = originalPath;
  fs.rmSync(identityBin, { recursive: true, force: true });
});

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-factory-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const cwd = path.join(root, "work");
  fs.mkdirSync(cwd);
  return { root, dataDir, cwd };
}

function saveRecord(state, work, id, fields = {}) {
  const file = state.jobFilePath(work.dataDir, work.cwd, id);
  state.createJobRecordFile(file, state.createJobRecord({ id, cwd: work.cwd, mode: "consult", ...fields }));
  return file;
}

function legacyRecord(work, id, fields = {}) {
  return {
    id, cwd: work.cwd, mode: "consult", status: "running", background: false,
    createdAt: "2020-01-01T00:00:00.000Z", request: {}, ...fields
  };
}

for (const [engine, state, marker] of [
  ["grok", grok, ".grok-state-sweep.json"],
  ["cursor", cursor, ".cursor-home-sweep.json"],
  ["devin", devin, ".devin-run-sweep.json"]
]) {
  test(`${engine} creates records while holding both sweep and job locks`, (t) => {
    const work = sandbox(t);
    const file = state.jobFilePath(work.dataDir, work.cwd, "created");
    const originalRename = fs.renameSync;
    let observed = false;
    fs.renameSync = function(from, to) {
      if (to === file) {
        assert.ok(fs.lstatSync(`${path.join(work.dataDir, marker)}.lock`).isSymbolicLink());
        assert.ok(fs.lstatSync(`${file}.lock`).isSymbolicLink());
        observed = true;
      }
      return originalRename.call(this, from, to);
    };
    try { saveRecord(state, work, "created"); }
    finally { fs.renameSync = originalRename; }
    assert.equal(observed, true);
    assert.throws(() => saveRecord(state, work, "created"), (error) => error.failureKind === "resource");
    assert.equal(fs.existsSync(`${file}.lock`), false);
    assert.equal(fs.existsSync(`${path.join(work.dataDir, marker)}.lock`), false);
  });

  test(`${engine} preflight leases protect an owner before its record exists`, (t) => {
    const work = sandbox(t);
    const first = state.claimResumeSessionLease(work.dataDir, work.cwd, "session", "first", { preflight: true });
    assert.equal(first.ownerPid, process.pid);
    assert.ok(first.ownerPidIdentity);
    assert.equal(fs.existsSync(state.jobFilePath(work.dataDir, work.cwd, "first")), false);
    assert.throws(() => state.claimResumeSessionLease(work.dataDir, work.cwd, "session", "second", { preflight: true }),
      (error) => error.failureKind === "resource" && /already being resumed/.test(error.message));
    saveRecord(state, work, "first");
    assert.deepEqual(state.claimResumeSessionLease(work.dataDir, work.cwd, "session", "first"), first);
    assert.throws(() => state.claimResumeSessionLease(work.dataDir, work.cwd, "other", "missing"),
      (error) => error.failureKind === "resource" && /invalid job/.test(error.message));
  });

  test(`${engine} preflight leases recover an owner that died before creating a record`, (t) => {
    const work = sandbox(t);
    const leaseFile = state.resumeSessionLeasePath(work.dataDir, work.cwd, "session");
    state.writePrivateStateFile(leaseFile, JSON.stringify({ version: 1, sessionId: "session", ownerJobId: "dead", ownerPid: 99999999, ownerPidIdentity: null, claimedAt: new Date().toISOString() }));
    const next = state.claimResumeSessionLease(work.dataDir, work.cwd, "session", "next", { preflight: true });
    assert.equal(next.ownerJobId, "next");
    assert.deepEqual(state.readJobRecordFile(leaseFile), next);
  });

  test(`${engine} records flat and nested launch PIDs for both process roles`, (t) => {
    const work = sandbox(t);
    for (const processRole of [engine, "worker"]) {
      for (const [shape, launched, expected] of [
        ["flat", { pid: 12345, identity: { source: "flat" } }, 12345],
        ["nested", { child: { pid: 23456 }, identity: { source: "nested" } }, 23456],
        ["both", { pid: 34567, child: { pid: 45678 } }, 34567]
      ]) {
        const file = saveRecord(state, work, `${processRole}-${shape}`);
        const result = state.launchRunningJobProcess(file, () => launched, { processRole });
        const pidField = processRole === "worker" ? "pid" : `${engine}Pid`;
        assert.equal(result.record[pidField], expected);
        assert.equal(state.readJobRecordFile(file)[pidField], expected);
        assert.deepEqual(result.record[`${pidField}Identity`], launched.identity ?? null);
      }
    }
  });

  test(`${engine} rejects invalid launch PIDs and blocks launches after cancellation`, (t) => {
    const work = sandbox(t);
    const file = saveRecord(state, work, "invalid-launch");
    for (const pid of [undefined, null, 0, 1, 1.5, "12345"]) {
      assert.throws(() => state.launchRunningJobProcess(file, () => ({ pid })),
        (error) => error.failureKind === "resource" && /valid PID/.test(error.message));
    }
    state.updateJobRecordFile(file, { cancelRequestedAt: new Date().toISOString() });
    let launched = false;
    assert.throws(() => state.launchRunningJobProcess(file, () => { launched = true; return { pid: 12345 }; }),
      (error) => error.launchPrevented && error.failureKind === "cancelled");
    assert.equal(launched, false);
  });
}

test("Grok migrates queued legacy records once and preserves their payload and usage", (t) => {
  const work = sandbox(t);
  const file = grok.jobFilePath(work.dataDir, work.cwd, "legacy");
  const raw = legacyRecord(work, "legacy", {
    status: "queued", background: true, grokVersion: " 1.0.77 ",
    modelUsage: { model: { inputTokens: 4 } }, modelUsageIsIncomplete: true,
    resultPayload: { text: "kept", transportStatus: "stale", semanticStatus: "stale", delivery: "stale", deliveryStatus: "stale" }
  });
  grok.writePrivateStateFile(file, JSON.stringify(raw));
  const migrated = grok.readJobRecordFile(file);
  assert.equal(migrated.status, "queued");
  assert.equal(migrated.engine, "grok");
  assert.equal(migrated.grokVersion, "1.0.77");
  assert.equal(migrated.delivery, "manual");
  assert.equal(migrated.semanticStatus, "unverified");
  assert.equal(migrated.cleanupRequired, false);
  assert.deepEqual(migrated.modelUsage, raw.modelUsage);
  assert.equal(migrated.modelUsageIsIncomplete, true);
  assert.deepEqual(migrated.resultPayload, { text: "kept", transportStatus: "queued", semanticStatus: "unverified", delivery: "manual", deliveryStatus: "pending" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), migrated);
  assert.equal(Object.hasOwn(raw, "schemaVersion"), false);
  const inode = fs.statSync(file).ino;
  assert.deepEqual(grok.readJobRecordFile(file), migrated);
  assert.equal(fs.statSync(file).ino, inode);
  assert.deepEqual(grok.listJobRecords(work.dataDir, work.cwd), [migrated]);
  assert.deepEqual(grok.listAllJobRecords(work.dataDir), [{ file, record: migrated }]);
  assert.throws(() => grok.launchRunningJobProcess(file, () => ({ pid: 12345 })), /already queued/);
});

test("Grok keeps its existing record acceptance and metadata read behavior", (t) => {
  const work = sandbox(t);
  const record = grok.createJobRecord({ id: "current", cwd: work.cwd, briefFile: null });
  for (const key of ["mode", "cwd", "createdAt", "finishedAt", "warnings", "grokBuildPath"]) delete record[key];
  const file = grok.jobFilePath(work.dataDir, work.cwd, record.id);
  grok.writePrivateStateFile(file, JSON.stringify(record));
  const before = fs.readFileSync(file, "utf8");
  assert.deepEqual(grok.readJobRecordFile(file), record);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  saveRecord(grok, work, "other");
  assert.equal(grok.listJobRecords(work.dataDir, work.cwd).length, 2);
  assert.equal(grok.listAllJobRecords(work.dataDir).length, 2);
  for (const value of [null, [], { sweptAt: 1 }, { version: 1, sessionId: "session", ownerJobId: "job" }]) {
    const metadataFile = path.join(work.dataDir, "metadata.json");
    grok.writePrivateStateFile(metadataFile, JSON.stringify(value));
    assert.deepEqual(grok.readJobRecordFile(metadataFile), value);
  }
  for (const fields of [{ engine: "cursor" }, { schemaVersion: 2 }, { status: "unknown" }, { request: undefined }]) {
    const invalid = legacyRecord(work, "invalid", fields);
    grok.writePrivateStateFile(file, JSON.stringify(invalid));
    const bytes = fs.readFileSync(file, "utf8");
    assert.equal(grok.readJobRecordFile(file), null);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
  }
});

test("Grok migration rereads a record changed before its lock was acquired", (t) => {
  const work = sandbox(t);
  const file = grok.jobFilePath(work.dataDir, work.cwd, "racing-migration");
  const raw = legacyRecord(work, "racing-migration");
  grok.writePrivateStateFile(file, JSON.stringify(raw));
  const originalRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function(target, ...args) {
    const value = originalRead.call(this, target, ...args);
    if (target === file && ++reads === 1) fs.writeFileSync(file, JSON.stringify({ ...raw, resultText: "concurrent update" }));
    return value;
  };
  let migrated;
  try { migrated = grok.readJobRecordFile(file); }
  finally { fs.readFileSync = originalRead; }
  assert.equal(migrated.resultText, "concurrent update");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).resultText, "concurrent update");
  assert.equal(reads, 2);
});

test("Grok payload status follows terminal transport, acceptance and collection", (t) => {
  const work = sandbox(t);
  const file = saveRecord(grok, work, "payload", { background: true, delivery: "managed" });
  grok.finishSuccessfulJobRecordFile(file, { status: "done", resultPayload: { text: "kept", transportStatus: "stale", deliveryStatus: "stale" } });
  assert.deepEqual(grok.readJobRecordFile(file).resultPayload, {
    text: "kept", transportStatus: "done", semanticStatus: "unverified", delivery: "managed", deliveryStatus: "pending"
  });
  grok.updateJobRecordFileWithCurrent(file, (record) => ({ ...record, semanticStatus: "accepted" }), { allowTerminal: true });
  grok.markDeliveryCollectedFile(file);
  assert.deepEqual(grok.readJobRecordFile(file).resultPayload, {
    text: "kept", transportStatus: "done", semanticStatus: "accepted", delivery: "managed", deliveryStatus: "collected"
  });
});

test("Cursor and Devin keep rejecting records outside their current schema", (t) => {
  const work = sandbox(t);
  for (const [engine, state] of [["cursor", cursor], ["devin", devin]]) {
    const file = state.jobFilePath(work.dataDir, work.cwd, engine);
    const raw = legacyRecord(work, engine, { engine });
    state.writePrivateStateFile(file, JSON.stringify(raw));
    assert.equal(state.readJobRecordFile(file), null);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), raw);
  }
});

for (const [name, update] of [
  ["write", (file, state) => grok.writeJobRecordFile(file, { ...state, resultText: "updated" })],
  ["patch", (file) => grok.updateJobRecordFile(file, { resultText: "updated" })],
  ["updater", (file) => grok.updateJobRecordFileWithCurrent(file, (state) => ({ ...state, resultText: "updated" }))],
  ["launch", (file) => grok.launchRunningJobProcess(file, () => ({ pid: 12345 }))],
  ["finish", (file) => grok.finishSuccessfulJobRecordFile(file, { status: "done", resultText: "updated" })],
  ["collect", (file) => grok.markDeliveryCollectedFile(file)],
  ["managed collect", (file) => grok.markManagedDeliveryCollectedFile(file)]
]) {
  test(`Grok ${name} migrates an old record while already holding its lock`, (t) => {
    const work = sandbox(t);
    const file = grok.jobFilePath(work.dataDir, work.cwd, "legacy");
    const raw = legacyRecord(work, "legacy", name.includes("collect") ? { status: "done", delivery: "managed" } : {});
    grok.writePrivateStateFile(file, JSON.stringify(raw));
    update(file, grok.migrateJobRecord(raw));
    const record = grok.readJobRecordFile(file);
    assert.equal(record.engine, "grok");
    assert.equal(record.schemaVersion, 1);
    if (name.includes("collect")) assert.ok(record.deliveryCollectedAt);
    else if (name === "launch") assert.equal(record.grokPid, 12345);
    else assert.equal(record.resultText, "updated");
  });
}

test("Grok cancellation retains cost, model usage and request attribution", (t) => {
  const work = sandbox(t);
  const file = saveRecord(grok, work, "cancelled", { request: { model: "grok-code", effort: "high" } });
  grok.updateJobRecordFile(file, { cancelRequestedAt: new Date().toISOString() });
  const record = grok.finishSuccessfulJobRecordFile(file, {
    status: "done", resultText: "partial", numTurns: 2, totalCostUsd: 0.1,
    totalCostUsdTicks: 100000, costIsPartial: true, usage: { inputTokens: 2 },
    modelUsage: { model: { inputTokens: 2 } }, usageIsIncomplete: true, modelUsageIsIncomplete: true
  });
  assert.equal(record.status, "cancelled");
  assert.equal(record.resolvedModel, "grok-code");
  assert.equal(record.resolvedEffort, "high");
  for (const [key, expected] of Object.entries({ numTurns: 2, totalCostUsd: 0.1, totalCostUsdTicks: 100000, costIsPartial: true, modelUsage: { model: { inputTokens: 2 } }, modelUsageIsIncomplete: true })) {
    assert.deepEqual(record[key], expected);
    assert.deepEqual(grok.readJobRecordFile(file)[key], expected);
  }
});

for (const [name, finish] of [
  ["write", (file, record) => grok.writeJobRecordFile(file, { ...record, status: "done" })],
  ["patch", (file) => grok.updateJobRecordFile(file, { status: "done" })],
  ["updater", (file) => grok.updateJobRecordFileWithCurrent(file, (record) => ({ ...record, status: "done" }))],
  ["finish", (file) => grok.finishSuccessfulJobRecordFile(file, { status: "done" })]
]) {
  test(`Grok terminal ${name} sweeps after releasing the record lock`, (t) => {
    const work = sandbox(t);
    const file = saveRecord(grok, work, "expired");
    const record = { ...grok.readJobRecordFile(file), finishedAt: "2020-01-01T00:00:00.000Z" };
    grok.writePrivateStateFile(file, JSON.stringify(record));
    finish(file, record);
    assert.equal(fs.existsSync(file), false);
    assert.ok(grok.readJobRecordFile(path.join(work.dataDir, ".grok-state-sweep.json"))?.sweptAt);
  });
}

test("Grok lease repair sweeps after releasing the lease lock", (t) => {
  const work = sandbox(t);
  const file = saveRecord(grok, work, "dead", { createdAt: "2020-01-01T00:00:00.000Z" });
  saveRecord(grok, work, "next");
  grok.claimResumeSessionLease(work.dataDir, work.cwd, "session", "dead");
  const lease = grok.resumeSessionLeasePath(work.dataDir, work.cwd, "session");
  const old = new Date("2020-01-01T00:00:00.000Z");
  fs.utimesSync(lease, old, old);
  assert.equal(grok.claimResumeSessionLease(work.dataDir, work.cwd, "session", "next").ownerJobId, "next");
  assert.equal(grok.readJobRecordFile(file).failureKind, "died");
  assert.ok(grok.readJobRecordFile(path.join(work.dataDir, ".grok-state-sweep.json"))?.sweptAt);
});

test("Grok sweep preserves old live preflight leases without owner records", (t) => {
  const work = sandbox(t);
  grok.claimResumeSessionLease(work.dataDir, work.cwd, "session", "preflight", { preflight: true });
  const lease = grok.resumeSessionLeasePath(work.dataDir, work.cwd, "session");
  const old = new Date("2020-01-01T00:00:00.000Z");
  fs.utimesSync(lease, old, old);
  grok.ensurePrivateDataDir(work.dataDir);
  assert.equal(fs.existsSync(lease), true);
});

test("Grok shared pruning recognizes legacy terminal records", (t) => {
  const work = sandbox(t);
  const file = grok.jobFilePath(work.dataDir, work.cwd, "expired-legacy");
  grok.writePrivateStateFile(file, JSON.stringify(legacyRecord(work, "expired-legacy", { status: "done", finishedAt: "2020-01-01T00:00:00.000Z" })));
  grok.ensurePrivateDataDir(work.dataDir);
  assert.equal(fs.existsSync(file), false);
});
