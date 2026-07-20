import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { envFor, jobFileFor, jobRecords, makeSandbox, runCompanion } from "./lib/companion-harness.mjs";

const processIdentityBin = fs.mkdtempSync(path.join(os.tmpdir(), "grok-process-identity-"));
fs.writeFileSync(path.join(processIdentityBin, "ps"), '#!/bin/sh\npid=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-p" ]; then\n    pid="$2"\n    shift 2\n  else\n    shift\n  fi\ndone\nprintf "process-%s\\n" "$pid"\n');
fs.writeFileSync(path.join(processIdentityBin, "sysctl"), '#!/bin/sh\nprintf "{ sec = 1, usec = 0 }\\n"\n');
fs.chmodSync(path.join(processIdentityBin, "ps"), 0o755);
fs.chmodSync(path.join(processIdentityBin, "sysctl"), 0o755);
test.after(() => {
  fs.rmSync(processIdentityBin, { recursive: true, force: true });
});

function childEnv(sandbox, extraEnv = {}) {
  return envFor(sandbox, {
    ...extraEnv,
    PATH: [processIdentityBin, process.env.PATH].filter(Boolean).join(path.delimiter),
  });
}

function seedJob(sandbox, cwd, args, extraEnv = {}) {
  return runCompanion(["task", ...args], { cwd, env: childEnv(sandbox, extraEnv) });
}

test("stats aggregates the workspace jobs as markdown and json", (t) => {
  const sandbox = makeSandbox(t);
  const env = childEnv(sandbox);
  assert.strictEqual(seedJob(sandbox, sandbox.workDir, ["first job"], { FAKE_GROK_MODE: "usage-ok" }).status, 0);
  assert.strictEqual(seedJob(sandbox, sandbox.workDir, ["--write", "second job"]).status, 0);
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
  assert.strictEqual(usageRecord.modelUsageIsIncomplete, false);
  assert.ok(typeof stats.meanWallClockSeconds === "number" && stats.meanWallClockSeconds >= 0);
  assert.ok(stats.earliestCreatedAt, "Expected earliestCreatedAt to be set.");
  assert.ok(stats.latestCreatedAt, "Expected latestCreatedAt to be set.");
  assert.ok(stats.earliestCreatedAt <= stats.latestCreatedAt);
});

test("stats --all spans every workspace while the default stays scoped", (t) => {
  const sandbox = makeSandbox(t);
  const otherDir = path.join(sandbox.root, "other");
  fs.mkdirSync(otherDir);
  const env = childEnv(sandbox);
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

test("workspace stats never trusts a recorded cwd when refreshing jobs", (t) => {
  const sandbox = makeSandbox(t);
  const env = childEnv(sandbox);
  const seeded = seedJob(sandbox, sandbox.workDir, ["malformed cwd record"]);
  assert.strictEqual(seeded.status, 0, seeded.stderr);
  const [record] = jobRecords(sandbox.dataDir);
  const file = jobFileFor(sandbox.dataDir, record.id);
  fs.writeFileSync(file, `${JSON.stringify({ ...record, cwd: 42 }, null, 2)}\n`, "utf8");

  const result = runCompanion(["stats", "--json"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(JSON.parse(result.stdout).totalJobs, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).cwd, 42);
});

test("stats reclassifies legacy quota summaries without changing their records", (t) => {
  const sandbox = makeSandbox(t);
  const env = childEnv(sandbox);
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
  const env = childEnv(sandbox);
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
  const env = childEnv(sandbox);
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
  const env = childEnv(sandbox);
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

test("stats excludes fractional and inconsistent token reports from exact totals", (t) => {
  for (const [label, usage] of [
    ["fractional", { input_tokens: 120, cache_read_input_tokens: 30, output_tokens: 20.5, reasoning_tokens: 5, total_tokens: 170.5 }],
    ["inconsistent", { input_tokens: 120, cache_read_input_tokens: 30, output_tokens: 20, reasoning_tokens: 5, total_tokens: 169 }],
    ["conflicting aliases", { input_tokens: 120, cache_read_input_tokens: 30, output_tokens: 20, outputTokens: 21, reasoning_tokens: 5, total_tokens: 170 }],
    ["reasoning exceeds output", { input_tokens: 120, cache_read_input_tokens: 30, output_tokens: 20, reasoning_tokens: 21, total_tokens: 170 }]
  ]) {
    const sandbox = makeSandbox(t);
    const env = childEnv(sandbox);
    assert.strictEqual(seedJob(sandbox, sandbox.workDir, [`${label} token usage`]).status, 0);
    const [record] = jobRecords(sandbox.dataDir);
    record.usage = usage;
    record.modelUsage = null;
    fs.writeFileSync(jobFileFor(sandbox.dataDir, record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const result = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
    assert.strictEqual(result.status, 0, result.stderr);
    const stats = JSON.parse(result.stdout);
    assert.strictEqual(stats.usage, null);
    assert.deepStrictEqual(stats.usageCoverage, {
      availability: "unavailable",
      completeJobs: 0,
      incompleteJobs: 1,
      unreportedJobs: 0
    });
  }
});

test("stats fail closed when individually safe token totals overflow during aggregation", (t) => {
  const sandbox = makeSandbox(t);
  const env = childEnv(sandbox);
  assert.strictEqual(seedJob(sandbox, sandbox.workDir, ["first large token report"]).status, 0);
  assert.strictEqual(seedJob(sandbox, sandbox.workDir, ["second large token report"]).status, 0);
  for (const record of jobRecords(sandbox.dataDir)) {
    record.usage = {
      input_tokens: 4_000_000_000_000_000,
      cache_read_input_tokens: 0,
      output_tokens: 1_000_000_000_000_000,
      reasoning_tokens: 0,
      total_tokens: 5_000_000_000_000_000
    };
    record.modelUsage = null;
    fs.writeFileSync(jobFileFor(sandbox.dataDir, record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  const json = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(json.status, 0, json.stderr);
  const stats = JSON.parse(json.stdout);
  assert.strictEqual(stats.usage, null);
  assert.strictEqual(stats.usageCoverage.availability, "overflow");
  assert.strictEqual(stats.usageCoverage.aggregationOverflow, true);

  const text = runCompanion(["stats"], { cwd: sandbox.workDir, env });
  assert.strictEqual(text.status, 0, text.stderr);
  assert.match(text.stdout, /Exact token usage coverage: overflow/);
  assert.match(text.stdout, /Token totals: unavailable/);
});

test("stats fail closed when individually safe cost ticks overflow during aggregation", (t) => {
  const sandbox = makeSandbox(t);
  const env = childEnv(sandbox);
  assert.strictEqual(seedJob(sandbox, sandbox.workDir, ["first large cost"], { FAKE_GROK_MODE: "metrics-complete" }).status, 0);
  assert.strictEqual(seedJob(sandbox, sandbox.workDir, ["second large cost"], { FAKE_GROK_MODE: "metrics-complete" }).status, 0);
  for (const record of jobRecords(sandbox.dataDir)) {
    record.totalCostUsdTicks = 5_000_000_000_000_000;
    record.totalCostUsd = 500_000;
    fs.writeFileSync(jobFileFor(sandbox.dataDir, record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  const json = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(json.status, 0, json.stderr);
  const stats = JSON.parse(json.stdout);
  assert.strictEqual(stats.headlessMetrics.exactCostJobs, 2);
  assert.strictEqual(stats.headlessMetrics.costAggregationOverflow, true);
  assert.strictEqual(stats.headlessMetrics.totalCostUsdTicks, null);
  assert.strictEqual(stats.headlessMetrics.totalCostUsd, null);

  const text = runCompanion(["stats"], { cwd: sandbox.workDir, env });
  assert.strictEqual(text.status, 0, text.stderr);
  assert.match(text.stdout, /Observed exact cost: unavailable \(aggregate ticks exceed the safe integer range\)/);
});

test("stats excludes exact cost when model usage is explicitly incomplete", (t) => {
  const sandbox = makeSandbox(t);
  const env = childEnv(sandbox);
  assert.strictEqual(seedJob(sandbox, sandbox.workDir, ["incomplete model usage cost"], { FAKE_GROK_MODE: "metrics-complete" }).status, 0);
  const [record] = jobRecords(sandbox.dataDir);
  record.modelUsageIsIncomplete = true;
  fs.writeFileSync(jobFileFor(sandbox.dataDir, record.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const result = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(JSON.parse(result.stdout).headlessMetrics, {
    turnsReportedJobs: 1,
    totalTurns: 3,
    exactCostJobs: 0,
    partialCostJobs: 1,
    unreportedCostJobs: 0,
    totalCostUsd: 0,
    totalCostUsdTicks: 0,
  });
});

test("stats treats a full-shaped CLI usage report marked incomplete as incomplete", (t) => {
  const sandbox = makeSandbox(t);
  const env = childEnv(sandbox);
  assert.strictEqual(
    seedJob(sandbox, sandbox.workDir, ["flagged incomplete usage"], { FAKE_GROK_MODE: "usage-incomplete-ok" }).status,
    0
  );
  const [record] = jobRecords(sandbox.dataDir);
  assert.strictEqual(record.usageIsIncomplete, true);
  assert.strictEqual(record.modelUsageIsIncomplete, false);
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

test("partial unflagged CLI usage is recorded as incomplete", (t) => {
  const sandbox = makeSandbox(t);
  const env = childEnv(sandbox);
  assert.strictEqual(
    seedJob(sandbox, sandbox.workDir, ["partial unflagged usage"], { FAKE_GROK_MODE: "usage-partial-unflagged" }).status,
    0
  );
  const [record] = jobRecords(sandbox.dataDir);
  assert.strictEqual(record.usageIsIncomplete, true);
  assert.strictEqual(record.modelUsageIsIncomplete, true);

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
  const env = childEnv(sandbox);
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
