import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { envFor, jobFileFor, jobRecords, makeSandbox, runCompanion } from "./lib/companion-harness.mjs";

function seedJob(sandbox, cwd, args, extraEnv = {}) {
  return runCompanion(["task", ...args], { cwd, env: envFor(sandbox, extraEnv) });
}

test("stats aggregates the workspace jobs as markdown and json", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  assert.strictEqual(seedJob(sandbox, sandbox.workDir, ["first job"], { FAKE_GROK_MODE: "usage-ok" }).status, 0);
  assert.strictEqual(seedJob(sandbox, sandbox.workDir, ["second job", "--write"]).status, 0);
  const rateLimited = seedJob(sandbox, sandbox.workDir, ["doomed"], { FAKE_GROK_MODE: "rate-limit-error" });
  assert.notStrictEqual(rateLimited.status, 0);
  const authFailed = seedJob(sandbox, sandbox.workDir, ["doomed too"], { FAKE_GROK_MODE: "auth-error" });
  assert.notStrictEqual(authFailed.status, 0);

  const report = runCompanion(["stats"], { cwd: sandbox.workDir, env });
  assert.strictEqual(report.status, 0, report.stderr);
  assert.match(report.stdout, /Total jobs: 4/);
  assert.match(report.stdout, /^- done: 2$/m);
  assert.match(report.stdout, /^- error: 2$/m);
  assert.match(report.stdout, /^- consult: 3$/m);
  assert.match(report.stdout, /^- write: 1$/m);
  assert.match(report.stdout, /^- rate_limited: 1$/m);
  assert.match(report.stdout, /^- auth: 1$/m);
  assert.match(report.stdout, /^- grok-test-main: 1$/m);
  assert.match(report.stdout, /^- grok-test-subagent: 1$/m);
  assert.match(report.stdout, /^- unknown: 3$/m);
  assert.match(report.stdout, /Exact token usage coverage: partial \(1 complete, 0 incomplete, 3 unreported\)/);
  assert.match(report.stdout, /Observed exact tokens \(1 complete job\):/);
  assert.match(report.stdout, /^- input tokens: 120$/m);
  assert.match(report.stdout, /^- cache read input tokens: 30$/m);
  assert.match(report.stdout, /^- output tokens: 20$/m);
  assert.match(report.stdout, /^- reasoning tokens: 5$/m);
  assert.match(report.stdout, /^- total tokens: 170$/m);
  assert.match(report.stdout, /Mean wall clock for finished jobs: \d+(\.\d+)?s/);

  const asJson = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(asJson.status, 0, asJson.stderr);
  const stats = JSON.parse(asJson.stdout);
  assert.strictEqual(stats.scope, "workspace");
  assert.strictEqual(stats.cwd, sandbox.workDir);
  assert.strictEqual(stats.totalJobs, 4);
  assert.deepStrictEqual(stats.byStatus, { done: 2, error: 2 });
  assert.deepStrictEqual(stats.byMode, { consult: 3, write: 1 });
  assert.deepStrictEqual(stats.byFailureKind, { rate_limited: 1, auth: 1 });
  assert.deepStrictEqual(stats.byModel, {
    "grok-test-main": 1,
    "grok-test-subagent": 1,
    unknown: 3,
  });
  assert.deepStrictEqual(stats.usage, {
    reportedJobs: 1,
    inputTokens: 120,
    cacheReadInputTokens: 30,
    outputTokens: 20,
    reasoningTokens: 5,
    totalTokens: 170,
  });
  assert.deepStrictEqual(stats.usageCoverage, {
    availability: "partial",
    completeJobs: 1,
    incompleteJobs: 0,
    unreportedJobs: 3,
  });
  const usageRecord = jobRecords(sandbox.dataDir).find((record) => record.resultText === "FAKE-USAGE-OK");
  assert.ok(usageRecord, "Expected a completed job with usage.");
  assert.deepStrictEqual(usageRecord.usage, {
    input_tokens: 120,
    cache_read_input_tokens: 30,
    output_tokens: 20,
    reasoning_tokens: 5,
    total_tokens: 170,
  });
  assert.deepStrictEqual(Object.keys(usageRecord.modelUsage), ["grok-test-main", "grok-test-subagent"]);
  assert.ok(typeof stats.meanWallClockSeconds === "number" && stats.meanWallClockSeconds >= 0);
  assert.ok(stats.earliestCreatedAt, "Expected earliestCreatedAt to be set.");
  assert.ok(stats.latestCreatedAt, "Expected latestCreatedAt to be set.");
  assert.ok(stats.earliestCreatedAt <= stats.latestCreatedAt);
});

test("stats --all spans every workspace while the default stays scoped", (t) => {
  const sandbox = makeSandbox(t);
  const otherDir = path.join(sandbox.root, "other");
  fs.mkdirSync(otherDir);
  const env = envFor(sandbox);
  assert.strictEqual(seedJob(sandbox, sandbox.workDir, ["work job"]).status, 0);
  assert.strictEqual(seedJob(sandbox, otherDir, ["other job"]).status, 0);

  const scoped = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(scoped.status, 0, scoped.stderr);
  assert.strictEqual(JSON.parse(scoped.stdout).totalJobs, 1);

  const all = runCompanion(["stats", "--all", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(all.status, 0, all.stderr);
  const stats = JSON.parse(all.stdout);
  assert.strictEqual(stats.scope, "all");
  assert.strictEqual(stats.cwd, null);
  assert.strictEqual(stats.totalJobs, 2);
  assert.deepStrictEqual(stats.byStatus, { done: 2 });

  const allReport = runCompanion(["stats", "--all"], { cwd: sandbox.workDir, env });
  assert.strictEqual(allReport.status, 0, allReport.stderr);
  assert.match(allReport.stdout, /Scope: all workspaces/);
  assert.match(allReport.stdout, /Total jobs: 2/);
  assert.match(allReport.stdout, /Exact token usage coverage: unavailable \(0 complete, 0 incomplete, 2 unreported\)/);
  assert.match(allReport.stdout, /Token totals: unavailable/);
});

test("stats reclassifies legacy quota summaries without changing their records", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const summaries = ["HTTP 402", "Payment Required", "account balance exhausted", "insufficient balance"];

  for (const summary of summaries) {
    const existingIds = new Set(jobRecords(sandbox.dataDir).map((record) => record.id));
    const failed = seedJob(sandbox, sandbox.workDir, ["legacy failure"], { FAKE_GROK_MODE: "error" });
    assert.notStrictEqual(failed.status, 0);
    const record = jobRecords(sandbox.dataDir).find((candidate) => !existingIds.has(candidate.id));
    assert.ok(record, "Expected a newly recorded failed job.");
    record.failureKind = "error";
    record.errorMessage = "Grok exited with code 1.";
    record.errorTail = summary;
    delete record.usage;
    delete record.modelUsage;
    fs.writeFileSync(jobFileFor(sandbox.dataDir, record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  const report = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(report.status, 0, report.stderr);
  const stats = JSON.parse(report.stdout);
  assert.deepStrictEqual(stats.byFailureKind, { quota: 4 });
  for (const record of jobRecords(sandbox.dataDir)) {
    assert.strictEqual(record.failureKind, "error");
  }
});

test("stats reclassifies a legacy quota failure from its bounded job log", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const failed = seedJob(sandbox, sandbox.workDir, ["legacy log failure"], { FAKE_GROK_MODE: "error" });
  assert.notStrictEqual(failed.status, 0);
  const [record] = jobRecords(sandbox.dataDir);
  record.failureKind = "error";
  record.errorMessage = "Grok exited with code 1.";
  record.errorTail = "generic failure";
  const file = jobFileFor(sandbox.dataDir, record.id);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.writeFileSync(file.replace(/\.json$/, ".log"), "API error (status 402 Payment Required): usage balance exhausted\n", "utf8");

  const report = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(report.status, 0, report.stderr);
  assert.deepStrictEqual(JSON.parse(report.stdout).byFailureKind, { quota: 1 });
  assert.strictEqual(jobRecords(sandbox.dataDir)[0].failureKind, "error");
});

test("stats aggregates legacy camelCase model usage without double counting cached input", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  assert.strictEqual(seedJob(sandbox, sandbox.workDir, ["legacy usage"]).status, 0);
  const [record] = jobRecords(sandbox.dataDir);
  delete record.usage;
  record.modelUsage = {
    "grok-legacy": {
      inputTokens: 409026,
      cachedReadTokens: 347648,
      outputTokens: 6718,
      reasoningTokens: 4000,
      totalTokens: 415744,
    },
  };
  fs.writeFileSync(jobFileFor(sandbox.dataDir, record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const report = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(report.status, 0, report.stderr);
  const stats = JSON.parse(report.stdout);
  assert.deepStrictEqual(stats.byModel, { "grok-legacy": 1 });
  assert.deepStrictEqual(stats.usage, {
    reportedJobs: 1,
    inputTokens: 409026,
    cacheReadInputTokens: 347648,
    outputTokens: 6718,
    reasoningTokens: 4000,
    totalTokens: 415744,
  });
  assert.deepStrictEqual(stats.usageCoverage, {
    availability: "available",
    completeJobs: 1,
    incompleteJobs: 0,
    unreportedJobs: 0,
  });
});

test("stats excludes partial direct usage from exact totals", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  assert.strictEqual(seedJob(sandbox, sandbox.workDir, ["partial direct usage"]).status, 0);
  const [record] = jobRecords(sandbox.dataDir);
  record.usage = { input_tokens: 12, output_tokens: 3 };
  record.modelUsage = null;
  fs.writeFileSync(jobFileFor(sandbox.dataDir, record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const asJson = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(asJson.status, 0, asJson.stderr);
  const stats = JSON.parse(asJson.stdout);
  assert.strictEqual(stats.usage, null);
  assert.deepStrictEqual(stats.usageCoverage, {
    availability: "unavailable",
    completeJobs: 0,
    incompleteJobs: 1,
    unreportedJobs: 0,
  });

  const rendered = runCompanion(["stats"], { cwd: sandbox.workDir, env });
  assert.strictEqual(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /Exact token usage coverage: unavailable \(0 complete, 1 incomplete, 0 unreported\)/);
  assert.match(rendered.stdout, /Token totals: unavailable/);
  assert.doesNotMatch(rendered.stdout, /input tokens: 12/);
  assert.doesNotMatch(rendered.stdout, /total tokens: 15/);
});

test("stats treats a full-shaped CLI usage report marked incomplete as incomplete", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  assert.strictEqual(
    seedJob(sandbox, sandbox.workDir, ["flagged incomplete usage"], { FAKE_GROK_MODE: "usage-incomplete-ok" }).status,
    0
  );
  const [record] = jobRecords(sandbox.dataDir);
  assert.strictEqual(record.usageIsIncomplete, true);
  assert.strictEqual(record.modelUsageIsIncomplete, true);
  assert.strictEqual(record.usage.total_tokens, 170);

  const result = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(result.status, 0, result.stderr);
  const stats = JSON.parse(result.stdout);
  assert.strictEqual(stats.usage, null);
  assert.deepStrictEqual(stats.usageCoverage, {
    availability: "unavailable",
    completeJobs: 0,
    incompleteJobs: 1,
    unreportedJobs: 0,
  });
});

test("stats excludes all per-model totals when any reported model is incomplete", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  assert.strictEqual(seedJob(sandbox, sandbox.workDir, ["partial model usage"]).status, 0);
  const [record] = jobRecords(sandbox.dataDir);
  record.usage = null;
  record.modelUsage = {
    "grok-complete": {
      inputTokens: 20,
      cachedReadTokens: 5,
      outputTokens: 4,
      reasoningTokens: 2,
      totalTokens: 24,
    },
    "grok-incomplete": {
      inputTokens: 8,
      outputTokens: 1,
    },
  };
  fs.writeFileSync(jobFileFor(sandbox.dataDir, record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const result = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(result.status, 0, result.stderr);
  const stats = JSON.parse(result.stdout);
  assert.strictEqual(stats.usage, null);
  assert.deepStrictEqual(stats.usageCoverage, {
    availability: "unavailable",
    completeJobs: 0,
    incompleteJobs: 1,
    unreportedJobs: 0,
  });
});
