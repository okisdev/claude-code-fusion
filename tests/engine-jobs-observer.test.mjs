import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { fusionRepositoryKey, modelAuditSidecarPath, tokenUsageSidecarPath } from "../plugins/fusion/scripts/fusion-stats.mjs";
import { engineJobsObserverStatePath, observeEngineJobs, observeEngineJobsSafely } from "../plugins/fusion/scripts/engine-jobs-observer.mjs";

function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "engine-jobs-observer-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function engineWorkspaceSlug(cwd) {
  const absolute = path.resolve(cwd);
  return `${path.basename(absolute)}-${createHash("sha256").update(absolute).digest("hex").slice(0, 16)}`;
}

function writeEngineJob(dataDir, cwd, id, fields) {
  const jobsDir = path.join(dataDir, "state", engineWorkspaceSlug(cwd), "jobs");
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
  writeEngineJob(grokData, workspaceRoot, "grok-available", {
    status: "done",
    resolvedModel: "grok-4",
    resolvedEffort: "high",
    usage: {
      input_tokens: 120,
      cache_read_input_tokens: 40,
      output_tokens: 30,
      reasoning_tokens: 12,
      total_tokens: 150
    }
  });
  writeEngineJob(grokData, workspaceRoot, "grok-unavailable", {
    status: "error",
    resolvedModel: "grok-4",
    resolvedEffort: null
  });
  writeEngineJob(grokData, workspaceRoot, "grok-running", {
    status: "running",
    resolvedModel: "grok-4",
    resolvedEffort: "low",
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 }
  });

  assert.strictEqual(observeEngineJobs("grok", { env, now: () => "2026-07-22T00:00:00.000Z" }), 2);
  const repositoryKey = fusionRepositoryKey(workspaceRoot);
  const observations = readJsonLines(tokenUsageSidecarPath(workspaceRoot, env));
  assert.deepStrictEqual(observations, [
    {
      schemaVersion: 1,
      jobId: "grok-available",
      engine: "grok",
      workspaceRoot,
      repositoryKey,
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
      repositoryKey,
      availability: "unavailable",
      tokenUsage: null,
      source: "grok-job-record",
      observedAt: "2026-07-22T00:00:00.000Z"
    }
  ]);
  const modelAuditPath = modelAuditSidecarPath(workspaceRoot, env);
  const modelAudits = readJsonLines(modelAuditPath);
  assert.deepStrictEqual(modelAudits, [
    {
      schemaVersion: 1,
      jobId: "grok-available",
      engine: "grok",
      model: "grok-4",
      effort: "high",
      workspaceRoot,
      repositoryKey,
      source: "grok-job-record",
      observedAt: "2026-07-22T00:00:00.000Z"
    },
    {
      schemaVersion: 1,
      jobId: "grok-unavailable",
      engine: "grok",
      model: "grok-4",
      effort: null,
      workspaceRoot,
      repositoryKey,
      source: "grok-job-record",
      observedAt: "2026-07-22T00:00:00.000Z"
    }
  ]);
  const observerState = JSON.parse(fs.readFileSync(engineJobsObserverStatePath("grok", env), "utf8"));
  assert.strictEqual(observerState.schemaVersion, 2);
  assert.deepStrictEqual(observerState.observedJobIds, ["grok-available"]);
  assert.deepStrictEqual(observerState.unavailableObservedAt, { "grok-unavailable": "2026-07-22T00:00:00.000Z" });
  assert.strictEqual(observeEngineJobs("grok", { env, now: () => "2026-07-22T00:01:00.000Z" }), 1);
  assert.deepStrictEqual(readJsonLines(tokenUsageSidecarPath(workspaceRoot, env)), observations);
  assert.deepStrictEqual(readJsonLines(modelAuditPath), modelAudits);

  writeEngineJob(grokData, workspaceRoot, "grok-unavailable", {
    status: "error",
    resolvedModel: "grok-4",
    resolvedEffort: null,
    usage: { input_tokens: 90, cache_read_input_tokens: 20, output_tokens: 10, reasoning_tokens: 4, total_tokens: 120 }
  });
  assert.strictEqual(observeEngineJobs("grok", { env, now: () => "2026-07-22T00:02:00.000Z" }), 1);
  assert.deepStrictEqual(readJsonLines(tokenUsageSidecarPath(workspaceRoot, env)), [
    ...observations,
    {
      schemaVersion: 1,
      jobId: "grok-unavailable",
      engine: "grok",
      workspaceRoot,
      repositoryKey,
      availability: "available",
      tokenUsage: { inputTokens: 90, cachedInputTokens: 20, outputTokens: 10, reasoningOutputTokens: 4, totalTokens: 120 },
      source: "grok-job-record",
      observedAt: "2026-07-22T00:02:00.000Z"
    }
  ]);
  assert.deepStrictEqual(readJsonLines(modelAuditPath), modelAudits);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(engineJobsObserverStatePath("grok", env), "utf8")).observedJobIds, ["grok-available", "grok-unavailable"]);
  assert.strictEqual(observeEngineJobs("grok", { env, now: () => "2026-07-22T00:03:00.000Z" }), 0);
  assert.deepStrictEqual(readJsonLines(modelAuditPath), modelAudits);
});

test("marks an unavailable terminal job only after its observation TTL", (t) => {
  const root = sandbox(t);
  const workspaceRoot = path.join(root, "workspace");
  const grokData = path.join(root, "grok-data");
  const fusionData = path.join(root, "fusion-data");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const env = { GROK_COMPANION_DATA: grokData, FUSION_DATA_DIR: fusionData, GROK_JOBS_OBSERVER_UNAVAILABLE_TTL_MS: "1000" };
  writeEngineJob(grokData, workspaceRoot, "grok-late-usage", { status: "done" });

  assert.strictEqual(observeEngineJobs("grok", { env, now: () => "2026-07-22T00:00:00.000Z" }), 1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(engineJobsObserverStatePath("grok", env), "utf8")).observedJobIds, []);
  assert.strictEqual(observeEngineJobs("grok", { env, now: () => "2026-07-22T00:00:01.001Z" }), 1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(engineJobsObserverStatePath("grok", env), "utf8")).observedJobIds, ["grok-late-usage"]);
  assert.strictEqual(readJsonLines(tokenUsageSidecarPath(workspaceRoot, env)).length, 1);
});

test("the observer leaves sidecars unchanged when no terminal jobs are new", (t) => {
  const root = sandbox(t);
  const workspaceRoot = path.join(root, "workspace");
  const grokData = path.join(root, "grok-data");
  const fusionData = path.join(root, "fusion-data");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const env = { GROK_COMPANION_DATA: grokData, FUSION_DATA_DIR: fusionData };
  writeEngineJob(grokData, workspaceRoot, "grok-observed", {
    status: "done",
    resolvedModel: "grok-4",
    resolvedEffort: "high",
    usage: { inputTokens: 10, cacheReadTokens: 2, outputTokens: 3, reasoningTokens: 1, totalTokens: 13 }
  });
  assert.strictEqual(observeEngineJobs("grok", { env }), 1);
  const tokenUsage = fs.readFileSync(tokenUsageSidecarPath(workspaceRoot, env), "utf8");
  const modelAudit = fs.readFileSync(modelAuditSidecarPath(workspaceRoot, env), "utf8");

  assert.strictEqual(observeEngineJobs("grok", { env }), 0);
  assert.strictEqual(fs.readFileSync(tokenUsageSidecarPath(workspaceRoot, env), "utf8"), tokenUsage);
  assert.strictEqual(fs.readFileSync(modelAuditSidecarPath(workspaceRoot, env), "utf8"), modelAudit);
});

test("the observer safely ignores poll IO failures", (t) => {
  const root = sandbox(t);
  const workspaceRoot = path.join(root, "workspace");
  const grokData = path.join(root, "grok-data");
  const fusionData = path.join(root, "fusion-data");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(fusionData, "not a directory\n");
  writeEngineJob(grokData, workspaceRoot, "grok-io-failure", {
    status: "done",
    usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 3, reasoning_tokens: 1, total_tokens: 13 }
  });

  const env = { GROK_COMPANION_DATA: grokData, FUSION_DATA_DIR: fusionData };
  assert.strictEqual(observeEngineJobsSafely("grok", { env }), 0);
});

test("Cursor terminal records produce observations while unreadable records are skipped", (t) => {
  const root = sandbox(t);
  const workspaceRoot = path.join(root, "workspace");
  const cursorData = path.join(root, "cursor-data");
  const fusionData = path.join(root, "fusion-data");
  const env = { CURSOR_COMPANION_DATA: cursorData, FUSION_DATA_DIR: fusionData };
  fs.mkdirSync(workspaceRoot, { recursive: true });
  writeEngineJob(cursorData, workspaceRoot, "cursor-done", {
    status: "done",
    resolvedModel: "auto",
    resolvedEffort: "high",
    usage: { inputTokens: 12, cacheReadTokens: 3, cacheWriteTokens: 2, outputTokens: 5, totalTokens: 17 }
  });
  writeEngineJob(cursorData, workspaceRoot, "cursor-error", { status: "error", resolvedModel: "auto" });
  const unreadableFile = path.join(cursorData, "state", engineWorkspaceSlug(workspaceRoot), "jobs", "cursor-unreadable.json");
  fs.writeFileSync(unreadableFile, "{");
  const notified = [];

  assert.strictEqual(observeEngineJobs("cursor", { env, now: () => "2026-07-22T00:00:00.000Z", notify: (record) => notified.push([record.id, record.status]) }), 2);
  assert.deepStrictEqual(notified, [["cursor-done", "done"], ["cursor-error", "error"]]);
  assert.deepStrictEqual(readJsonLines(tokenUsageSidecarPath(workspaceRoot, env)).map(({ jobId, engine, availability, source }) => ({ jobId, engine, availability, source })), [
    { jobId: "cursor-done", engine: "cursor", availability: "available", source: "cursor-job-record" },
    { jobId: "cursor-error", engine: "cursor", availability: "unavailable", source: "cursor-job-record" }
  ]);
  assert.deepStrictEqual(readJsonLines(tokenUsageSidecarPath(workspaceRoot, env))[0].tokenUsage, { inputTokens: 14, cachedInputTokens: 3, outputTokens: 5, reasoningOutputTokens: null, totalTokens: 17 });
  assert.deepStrictEqual(readJsonLines(modelAuditSidecarPath(workspaceRoot, env)).map(({ jobId, engine, model, source }) => ({ jobId, engine, model, source })), [
    { jobId: "cursor-done", engine: "cursor", model: "auto", source: "cursor-job-record" },
    { jobId: "cursor-error", engine: "cursor", model: "auto", source: "cursor-job-record" }
  ]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(engineJobsObserverStatePath("cursor", env), "utf8")).notifiedJobIds, ["cursor-done", "cursor-error"]);
  assert.strictEqual(observeEngineJobs("cursor", { env, now: () => "2026-07-22T00:00:01.000Z", notify: (record) => notified.push([record.id, record.status]) }), 1);
  assert.strictEqual(notified.length, 2);
});
