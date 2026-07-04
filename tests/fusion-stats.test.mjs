import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "fusion", "scripts", "fusion-stats.mjs");

function sandbox(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-stats-test-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let slugCounter = 0;

function writeCodexJob(stateRoot, workspaceRoot, id, fields) {
  slugCounter += 1;
  const dir = path.join(stateRoot, `ws-${slugCounter}`, "jobs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, workspaceRoot, ...fields }));
}

function grokWorkspaceSlug(cwd) {
  const absolute = path.resolve(cwd);
  const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 16);
  return `${path.basename(absolute)}-${hash}`;
}

function writeGrokJob(dataDir, cwd, id, fields) {
  const dir = path.join(dataDir, "state", grokWorkspaceSlug(cwd), "jobs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, cwd, ...fields }));
}

function run(env, extraArgs = [], extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    cwd: env.cwd,
    encoding: "utf8",
    env: { ...process.env, FUSION_GROK_COMPANION: "/nonexistent/grok-companion.mjs", FUSION_CODEX_STATE: env.codexState, ...extraEnv }
  });
}

test("reports both engines unavailable when neither has data", (t) => {
  const dir = sandbox(t);
  const result = run({ cwd: dir, codexState: path.join(dir, "missing") });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /## Grok\n\nUnavailable:/);
  assert.match(result.stdout, /## Codex\n\nUnavailable:/);
});

test("aggregates codex job state scoped to the workspace", (t) => {
  const dir = sandbox(t);
  const stateRoot = path.join(dir, "state");
  writeCodexJob(stateRoot, dir, "task-a", {
    status: "completed",
    jobClass: "task",
    createdAt: "2026-07-02T06:00:00.000Z",
    startedAt: "2026-07-02T06:00:00.000Z",
    completedAt: "2026-07-02T06:00:10.000Z"
  });
  writeCodexJob(stateRoot, "/somewhere/else", "task-b", { status: "failed", jobClass: "task", createdAt: "2026-07-02T05:00:00.000Z" });

  const scoped = run({ cwd: dir, codexState: stateRoot }, ["--json"]);
  assert.strictEqual(scoped.status, 0, scoped.stderr);
  const scopedData = JSON.parse(scoped.stdout).codex;
  assert.strictEqual(scopedData.totalJobs, 1);
  assert.strictEqual(scopedData.byStatus.completed, 1);
  assert.strictEqual(scopedData.meanWallClockSeconds, 10);

  const all = run({ cwd: dir, codexState: stateRoot }, ["--all", "--json"]);
  const allData = JSON.parse(all.stdout).codex;
  assert.strictEqual(allData.totalJobs, 2);
  assert.strictEqual(allData.byStatus.failed, 1);
});

test("survives a malformed codex job file", (t) => {
  const dir = sandbox(t);
  const stateRoot = path.join(dir, "state");
  const jobsDir = path.join(stateRoot, "ws-broken", "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, "broken.json"), "{ not json");
  fs.writeFileSync(
    path.join(jobsDir, "task-ok.json"),
    JSON.stringify({ id: "task-ok", workspaceRoot: dir, status: "completed", jobClass: "review", createdAt: "2026-07-02T06:00:00.000Z" })
  );

  const result = run({ cwd: dir, codexState: stateRoot }, ["--json"]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(JSON.parse(result.stdout).codex.totalJobs, 1);
});

test("Aggregates available Grok companion stats into the merged output", (t) => {
  const dir = sandbox(t);
  const dataDir = path.join(dir, "grok-data");
  const companion = path.join(path.dirname(SCRIPT), "..", "..", "grok", "scripts", "grok-companion.mjs");
  writeGrokJob(dataDir, dir, "grok-a", {
    status: "done",
    mode: "consult",
    createdAt: "2026-07-04T00:00:00.000Z",
    finishedAt: "2026-07-04T00:00:05.000Z"
  });
  writeGrokJob(dataDir, dir, "grok-b", {
    status: "error",
    mode: "write",
    failureKind: "quota",
    createdAt: "2026-07-04T00:01:00.000Z",
    finishedAt: "2026-07-04T00:01:03.000Z"
  });

  const result = run(
    { cwd: dir, codexState: path.join(dir, "missing-codex") },
    ["--json"],
    { FUSION_GROK_COMPANION: companion, GROK_COMPANION_DATA: dataDir }
  );
  assert.strictEqual(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.strictEqual(data.grok.available, true);
  assert.strictEqual(data.grok.totalJobs, 2);
  assert.deepStrictEqual(data.grok.byStatus, { done: 1, error: 1 });
  assert.deepStrictEqual(data.grok.byMode, { consult: 1, write: 1 });
  assert.deepStrictEqual(data.grok.byFailureKind, { quota: 1 });
});
