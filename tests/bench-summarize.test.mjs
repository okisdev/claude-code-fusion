import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const summarizeScript = path.join(repoRoot, "bench", "summarize.mjs");

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bench-summarize-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function tokenCounts(input, output) {
  return { input, output, cacheRead: 0, cacheCreation: 0 };
}

function baseRecord(overrides = {}) {
  return {
    taskId: "T01-first",
    condition: "B1",
    repetition: 1,
    verifyExit: 0,
    wallClockSeconds: 10,
    claudeTokens: {
      orchestrator: tokenCounts(100, 50),
      subagents: tokenCounts(200, 80),
      byModel: {}
    },
    peerTokens: null,
    delegationCount: 1,
    resumeCount: 0,
    escalationCount: 0,
    excluded: false,
    excludedReason: null,
    ...overrides
  };
}

function writeResultsDir(root, name, { records, env, extraLine } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const lines = records.map((record) => JSON.stringify(record));
  if (extraLine !== undefined) {
    lines.push(extraLine);
  }
  fs.writeFileSync(path.join(dir, "runs.jsonl"), `${lines.join("\n")}\n`, "utf8");
  fs.writeFileSync(
    path.join(dir, "env.json"),
    JSON.stringify({
      pluginVersion: "0.0.1",
      claudeCodeVersion: "test",
      models: {},
      effort: {},
      grokCliVersion: "test",
      grokModel: "test",
      codexCliVersion: "test",
      codexModel: "test",
      fixtureCommit: "abc123",
      manifestHash: "hash-a",
      nodeVersion: process.version,
      os: process.platform,
      runDate: "2026-01-01",
      ...env
    }),
    "utf8"
  );
  fs.mkdirSync(path.join(dir, "transcripts"), { recursive: true });
  return dir;
}

function runSummarize(args) {
  return spawnSync(process.execPath, [summarizeScript, ...args], {
    encoding: "utf8",
    timeout: 30000
  });
}

test("summarize builds a pass matrix, gates the token table, and lists exclusions", (t) => {
  const root = makeSandbox(t);
  const records = [
    baseRecord({ repetition: 1, verifyExit: 0, wallClockSeconds: 10 }),
    baseRecord({ repetition: 2, verifyExit: 0, wallClockSeconds: 12 }),
    baseRecord({ repetition: 3, verifyExit: 1, wallClockSeconds: 9 }),

    baseRecord({
      taskId: "T02-second",
      condition: "A",
      repetition: 1,
      verifyExit: 1,
      wallClockSeconds: 5
    }),
    baseRecord({
      taskId: "T02-second",
      condition: "A",
      repetition: 2,
      verifyExit: 0,
      wallClockSeconds: 6
    }),

    baseRecord({
      taskId: "T03-excluded",
      condition: "B2",
      repetition: 1,
      excluded: true,
      excludedReason: "external_service_outage"
    })
  ];

  const dir = writeResultsDir(root, "run-1", { records, extraLine: "{not valid json" });

  const result = runSummarize([dir]);
  assert.strictEqual(result.status, 0, result.stderr);

  assert.match(result.stdout, /\| T01-first \| B1 \| pass \| pass \| fail \| 2\/3 \|/);
  assert.match(result.stdout, /\| T02-second \| A \| fail \| pass \| - \| 1\/2 \|/);

  assert.match(result.stdout, /\| T02-second \| A \| 1\/2 \| not comparable/);
  assert.match(result.stdout, /\| T01-first \| B1 \| 2\/3 \| \d/);

  assert.match(result.stdout, /### Excluded runs/);
  assert.match(result.stdout, /T03-excluded \| B2 \| 1 \| external_service_outage/);

  assert.match(result.stdout, /### Malformed records/);
  assert.match(result.stdout, /runs\.jsonl:7: invalid JSON/);

  assert.doesNotMatch(result.stdout, /T03-excluded[^\n]*\n[^\n]*\| pass \|/);

  assert.match(result.stdout, /These aggregates are descriptive summaries of the tasks above, not a statistical claim\./);
});

test("summarize marks a task and condition comparable once 2 of 3 pass", (t) => {
  const root = makeSandbox(t);
  const records = [
    baseRecord({ repetition: 1, verifyExit: 0, wallClockSeconds: 10 }),
    baseRecord({ repetition: 2, verifyExit: 0, wallClockSeconds: 11 }),
    baseRecord({ repetition: 3, verifyExit: 0, wallClockSeconds: 9 })
  ];
  const dir = writeResultsDir(root, "run-1", { records });

  const result = runSummarize([dir]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /not comparable/);
  assert.match(result.stdout, /\| T01-first \| B1 \| 3\/3 \|/);
});

test("summarize refuses to compare two dirs with different manifest hashes", (t) => {
  const root = makeSandbox(t);
  const records = [baseRecord()];
  const dirA = writeResultsDir(root, "run-a", { records, env: { manifestHash: "hash-a" } });
  const dirB = writeResultsDir(root, "run-b", { records, env: { manifestHash: "hash-b" } });

  const result = runSummarize([dirA, dirB]);
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /different manifest hashes/);
});

test("summarize compares two dirs sharing the same manifest hash", (t) => {
  const root = makeSandbox(t);
  const records = [baseRecord()];
  const dirA = writeResultsDir(root, "run-a", { records, env: { manifestHash: "hash-same" } });
  const dirB = writeResultsDir(root, "run-b", { records, env: { manifestHash: "hash-same" } });

  const result = runSummarize([dirA, dirB]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /## run-a/);
  assert.match(result.stdout, /## run-b/);
});
