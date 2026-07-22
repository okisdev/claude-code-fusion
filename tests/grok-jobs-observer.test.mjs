import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { tokenUsageSidecarPath } from "../plugins/fusion/scripts/fusion-stats.mjs";
import { grokJobsObserverStatePath, observeGrokJobs } from "../plugins/fusion/scripts/grok-jobs-observer.mjs";

const observerScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "fusion", "scripts", "grok-jobs-observer.mjs");

function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-jobs-observer-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function grokWorkspaceSlug(cwd) {
  const absolute = path.resolve(cwd);
  return `${path.basename(absolute)}-${createHash("sha256").update(absolute).digest("hex").slice(0, 16)}`;
}

function writeGrokJob(dataDir, cwd, id, fields) {
  const jobsDir = path.join(dataDir, "state", grokWorkspaceSlug(cwd), "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, `${id}.json`), `${JSON.stringify({ id, cwd, ...fields })}\n`);
}

function readJsonLines(file) {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("reobserves unavailable terminal jobs until usage becomes available", (t) => {
  const root = sandbox(t);
  const workspaceRoot = path.join(root, "workspace");
  const grokData = path.join(root, "grok-data");
  const fusionData = path.join(root, "fusion-data");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const env = { GROK_COMPANION_DATA: grokData, FUSION_DATA_DIR: fusionData };
  writeGrokJob(grokData, workspaceRoot, "grok-available", {
    status: "done",
    usage: {
      input_tokens: 120,
      cache_read_input_tokens: 40,
      output_tokens: 30,
      reasoning_tokens: 12,
      total_tokens: 150
    }
  });
  writeGrokJob(grokData, workspaceRoot, "grok-unavailable", { status: "error" });
  writeGrokJob(grokData, workspaceRoot, "grok-running", {
    status: "running",
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 }
  });

  assert.strictEqual(observeGrokJobs({ env, now: () => "2026-07-22T00:00:00.000Z" }), 2);
  const observations = readJsonLines(tokenUsageSidecarPath(workspaceRoot, env));
  assert.deepStrictEqual(observations, [
    {
      schemaVersion: 1,
      jobId: "grok-available",
      engine: "grok",
      workspaceRoot,
      availability: "available",
      tokenUsage: { inputTokens: 120, cachedInputTokens: 40, outputTokens: 30, reasoningOutputTokens: 12, totalTokens: 150 },
      source: "grok-job-record",
      observedAt: "2026-07-22T00:00:00.000Z"
    },
    {
      schemaVersion: 1,
      jobId: "grok-unavailable",
      engine: "grok",
      workspaceRoot,
      availability: "unavailable",
      tokenUsage: null,
      source: "grok-job-record",
      observedAt: "2026-07-22T00:00:00.000Z"
    }
  ]);
  const observerState = JSON.parse(fs.readFileSync(grokJobsObserverStatePath(env), "utf8"));
  assert.strictEqual(observerState.schemaVersion, 2);
  assert.deepStrictEqual(observerState.observedJobIds, ["grok-available"]);
  assert.deepStrictEqual(observerState.unavailableObservedAt, { "grok-unavailable": "2026-07-22T00:00:00.000Z" });
  assert.strictEqual(observeGrokJobs({ env, now: () => "2026-07-22T00:01:00.000Z" }), 1);
  assert.deepStrictEqual(readJsonLines(tokenUsageSidecarPath(workspaceRoot, env)), observations);

  writeGrokJob(grokData, workspaceRoot, "grok-unavailable", {
    status: "error",
    usage: { input_tokens: 90, cache_read_input_tokens: 20, output_tokens: 10, reasoning_tokens: 4, total_tokens: 120 }
  });
  assert.strictEqual(observeGrokJobs({ env, now: () => "2026-07-22T00:02:00.000Z" }), 1);
  assert.deepStrictEqual(readJsonLines(tokenUsageSidecarPath(workspaceRoot, env)), [
    ...observations,
    {
      schemaVersion: 1,
      jobId: "grok-unavailable",
      engine: "grok",
      workspaceRoot,
      availability: "available",
      tokenUsage: { inputTokens: 90, cachedInputTokens: 20, outputTokens: 10, reasoningOutputTokens: 4, totalTokens: 120 },
      source: "grok-job-record",
      observedAt: "2026-07-22T00:02:00.000Z"
    }
  ]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(grokJobsObserverStatePath(env), "utf8")).observedJobIds, ["grok-available", "grok-unavailable"]);
  assert.strictEqual(observeGrokJobs({ env, now: () => "2026-07-22T00:03:00.000Z" }), 0);
});

test("marks an unavailable terminal job only after its observation TTL", (t) => {
  const root = sandbox(t);
  const workspaceRoot = path.join(root, "workspace");
  const grokData = path.join(root, "grok-data");
  const fusionData = path.join(root, "fusion-data");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const env = { GROK_COMPANION_DATA: grokData, FUSION_DATA_DIR: fusionData, GROK_JOBS_OBSERVER_UNAVAILABLE_TTL_MS: "1000" };
  writeGrokJob(grokData, workspaceRoot, "grok-late-usage", { status: "done" });

  assert.strictEqual(observeGrokJobs({ env, now: () => "2026-07-22T00:00:00.000Z" }), 1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(grokJobsObserverStatePath(env), "utf8")).observedJobIds, []);
  assert.strictEqual(observeGrokJobs({ env, now: () => "2026-07-22T00:00:01.001Z" }), 1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(grokJobsObserverStatePath(env), "utf8")).observedJobIds, ["grok-late-usage"]);
  assert.strictEqual(readJsonLines(tokenUsageSidecarPath(workspaceRoot, env)).length, 1);
});

test("the observer emits no stdout when its state has no new terminal jobs", (t) => {
  const root = sandbox(t);
  const workspaceRoot = path.join(root, "workspace");
  const grokData = path.join(root, "grok-data");
  const fusionData = path.join(root, "fusion-data");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const env = { GROK_COMPANION_DATA: grokData, FUSION_DATA_DIR: fusionData };
  writeGrokJob(grokData, workspaceRoot, "grok-observed", {
    status: "done",
    usage: { inputTokens: 10, cacheReadTokens: 2, outputTokens: 3, reasoningTokens: 1, totalTokens: 13 }
  });
  assert.strictEqual(observeGrokJobs({ env }), 1);

  const result = spawnSync(process.execPath, [observerScript], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: { ...process.env, ...env, GROK_JOBS_OBSERVER_INTERVAL_MS: "1000" },
    timeout: 400,
    killSignal: "SIGTERM"
  });

  assert.strictEqual(result.stdout, "");
});

test("the observer monitor ignores poll IO failures", (t) => {
  const root = sandbox(t);
  const workspaceRoot = path.join(root, "workspace");
  const grokData = path.join(root, "grok-data");
  const fusionData = path.join(root, "fusion-data");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(fusionData, "not a directory\n");
  writeGrokJob(grokData, workspaceRoot, "grok-io-failure", {
    status: "done",
    usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 3, reasoning_tokens: 1, total_tokens: 13 }
  });

  const result = spawnSync(process.execPath, [observerScript], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: { ...process.env, GROK_COMPANION_DATA: grokData, FUSION_DATA_DIR: fusionData, GROK_JOBS_OBSERVER_INTERVAL_MS: "25" },
    timeout: 200,
    killSignal: "SIGTERM"
  });

  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
  assert.strictEqual(result.status, 0);
});
