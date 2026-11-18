import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseArgs, parseRawArgs, parseRecordAcceptanceArgs } from "../plugins/codex/scripts/lib/args.mjs";

test("Codex argument parsing keeps option-shaped values from consuming known short options", () => {
  const config = { valueOptions: ["cwd", "model"] };
  assert.throws(() => parseArgs(["--cwd", "-model=test"], config), { message: "Missing value for --cwd." });
  assert.throws(() => parseRawArgs("--cwd -model=test", config), { message: "Missing value for --cwd." });
});

test("Codex acceptance arguments keep literal values and reject duplicate or retired flag forms", () => {
  const jobId = "a".repeat(32);
  const prefix = ["--job-id", jobId, "--acceptance", "rejected", "--reason"];
  for (const reason of ["--json", '"quoted"', "line one\nline two", "back\\slash"]) {
    assert.deepEqual(parseRecordAcceptanceArgs([...prefix, reason]), { jobId, acceptance: "rejected", reason, source: "stats" });
  }
  assert.throws(() => parseRecordAcceptanceArgs([...prefix, "reason", "--job-id", jobId]), /only once/);
  assert.throws(() => parseRecordAcceptanceArgs([...prefix, "reason", "--json", "--json"]), /only once/);
  for (const token of ["--json=false", "--jobId", "__proto__"]) {
    assert.throws(() => parseRecordAcceptanceArgs([...prefix, "reason", token]), (error) => error.failureKind === "input");
  }
});

test("Codex locks honor live legacy reaper claims and recover their dead successors", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-shared-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ps"), '#!/bin/sh\nprintf "process\\n"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sysctl"), '#!/bin/sh\nprintf "{ sec = 1, usec = 0 }\\n"\n', { mode: 0o755 });
  const source = `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const [stateUrl, identityUrl, dataDir] = process.argv.slice(1);
const { withThreadLock } = await import(stateUrl);
const { getProcessIdentity } = await import(identityUrl);
const identity = getProcessIdentity(process.pid);
assert.ok(identity);
const replaced = { ...identity, commandHash: "0".repeat(64) };
const threadId = "legacy-reaper";
const key = createHash("sha256").update(threadId).digest("hex");
const lock = path.join(dataDir, "locks", "threads", key + ".lock");
fs.mkdirSync(path.dirname(lock), { recursive: true });
function owner(slot, token, ownerIdentity) {
  const dir = slot + ".owner." + token;
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ version: 1, token, ownerPid: process.pid, ownerIdentity }));
  fs.symlinkSync(path.basename(dir), slot, "dir");
  return dir;
}
const deadToken = "a".repeat(32);
const claimToken = "b".repeat(32);
const successorToken = "c".repeat(32);
const deadDir = owner(lock, deadToken, replaced);
const claim = deadDir + ".reap";
const claimDir = owner(claim, claimToken, identity);
assert.throws(() => withThreadLock(dataDir, threadId, () => assert.fail("live reaper was ignored")), /Timed out waiting for the job record lock/);
assert.equal(fs.existsSync(lock), true);
assert.equal(fs.existsSync(claim), true);
fs.writeFileSync(path.join(claimDir, "owner.json"), JSON.stringify({ version: 1, token: claimToken, ownerPid: process.pid, ownerIdentity: replaced }));
owner(claim + "-successor-" + claimToken, successorToken, replaced);
assert.equal(withThreadLock(dataDir, threadId, () => "recovered"), "recovered");
assert.deepEqual(fs.readdirSync(path.dirname(lock)), []);
process.stdout.write("recovered");
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source,
    new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href,
    new URL("../plugins/codex/scripts/lib/process-identity.mjs", import.meta.url).href,
    path.join(root, "data")], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CODEX_COMPANION_LOCK_TIMEOUT_MS: "200" }
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stdout, "recovered");
});

test("stored Codex records survive history, status, collection, migration, and both retention tiers", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-stored-state-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ps"), '#!/bin/sh\nprintf "process\\n"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sysctl"), '#!/bin/sh\nprintf "{ sec = 1, usec = 0 }\\n"\n', { mode: 0o755 });
  const source = `
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const [stateUrl, companion, fixture, root] = process.argv.slice(1);
const state = await import(stateUrl);
const { runningRecordNeedsReconciliation } = await import(companion);
const dataDir = path.join(root, "data");
const cwd = path.join(root, "workspace");
fs.mkdirSync(cwd);
const raw = JSON.parse(fs.readFileSync(fixture, "utf8"));
Object.assign(raw, { cwd, workspaceRoot: cwd, repositoryIdentity: path.join(cwd, ".git"),
  briefFile: state.briefPath(dataDir, cwd, raw.id),
  logFile: state.jobLogPath(dataDir, cwd, raw.id), eventsFile: state.jobEventsPath(dataDir, cwd, raw.id) });
const delivered = { ...raw, deliveryCollectedAt: "2026-01-02T00:00:00.000Z" };
assert.deepEqual(state.createJobRecord(delivered), delivered);
const realpath = fs.realpathSync.native;
let identityResolvedAt;
fs.realpathSync.native = (...args) => {
  fs.realpathSync.native = realpath;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
  identityResolvedAt = Date.now();
  return realpath(...args);
};
const starting = state.createJobRecord({ id: "new-owner", cwd, repositoryIdentity: cwd, pid: null });
assert.ok(Date.parse(starting.createdAt) >= identityResolvedAt);
assert.equal(starting.updatedAt, starting.createdAt);
assert.equal(runningRecordNeedsReconciliation(starting, { CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS: "500" }), false);
const file = state.jobFilePath(dataDir, cwd, raw.id);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.mkdirSync(path.dirname(raw.briefFile), { recursive: true });
fs.writeFileSync(file, JSON.stringify(raw));
fs.writeFileSync(raw.briefFile, "original brief");
fs.writeFileSync(raw.logFile, "original log");
fs.writeFileSync(raw.eventsFile, '{"type":"turn.completed"}\\n');
assert.equal(Object.hasOwn(raw, "sessionId"), false);
assert.equal(Object.hasOwn(raw, "resultPayload"), false);
assert.deepEqual(state.readJobRecordFile(file), raw);
assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), raw);
assert.deepEqual(state.listJobRecords(dataDir, cwd), [raw]);
const tied = ["order-a", "order-b"].map((id) => {
  const file = state.jobFilePath(dataDir, cwd, id);
  fs.writeFileSync(file, JSON.stringify({ ...raw, id }));
  return file;
});
assert.deepEqual(state.listJobRecords(dataDir, cwd).map((record) => record.id), [raw.id, "order-a", "order-b"]);
assert.deepEqual(state.listAllJobRecords(dataDir).map(({ record }) => record.id), [raw.id, "order-a", "order-b"]);
for (const file of tied) fs.unlinkSync(file);
const command = (...args) => {
  const result = spawnSync(process.execPath, [companion, ...args], { cwd, encoding: "utf8",
    env: { ...process.env, CODEX_COMPANION_DATA: dataDir } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
assert.deepEqual(command("history", "--json").jobs, [raw]);
assert.deepEqual(command("status", raw.id, "--cwd", cwd, "--json"), raw);
const limits = { claudeSessionId: "another-owner", maxBytes: 0, maxRecords: 0, recordMaxRecords: 0, recordRetentionDays: 0 };
const protectedResult = state.pruneJobState(dataDir, limits);
assert.equal(protectedResult.ok, true);
assert.equal(protectedResult.quotaSatisfied, false);
assert.equal(fs.existsSync(file), true);
assert.equal(command("result", raw.id, "--cwd", cwd, "--json").resultText, raw.resultText);
const collected = state.readJobRecordFile(file);
assert.ok(collected.collectedAt);
assert.equal(collected.deliveryCollectedAt, collected.collectedAt);
assert.equal(collected.threadId, raw.threadId);
assert.equal(collected.claudeSessionId, raw.claudeSessionId);
assert.deepEqual(collected.tokenUsage, raw.tokenUsage);
const pruned = state.pruneJobState(dataDir, limits);
assert.equal(pruned.ok, true);
assert.equal(pruned.prunedArtifacts, 1);
assert.equal(pruned.deletedRecords, 1);
assert.equal(fs.existsSync(file), false);
assert.equal(fs.existsSync(raw.briefFile), false);
assert.equal(fs.existsSync(raw.logFile), false);
assert.equal(fs.existsSync(raw.eventsFile), false);
const legacy = { ...raw, sessionId: raw.claudeSessionId, appliedServiceTier: "priority" };
delete legacy.claudeSessionId;
delete legacy.fileChangeCount;
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(legacy));
const migrated = state.readJobRecordFile(file);
assert.equal(migrated.claudeSessionId, raw.claudeSessionId);
assert.equal(migrated.fileChangeCount, null);
assert.equal(Object.hasOwn(migrated, "sessionId"), false);
assert.equal(Object.hasOwn(migrated, "appliedServiceTier"), false);
assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), migrated);
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source,
    new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href,
    path.resolve(import.meta.dirname, "../plugins/codex/scripts/codex-companion.mjs"),
    path.join(import.meta.dirname, "fixtures/codex-job-v1.json"), root], {
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
