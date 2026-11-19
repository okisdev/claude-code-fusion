import assert from "node:assert/strict";
import test from "node:test";

import {
  extractFirstJsonObject,
  formatAge,
  renderBackgroundLaunch,
  renderCancelReport,
  renderHistoryReport,
  renderJobDetail,
  renderReviewResult,
  renderSetupReport,
  renderStatusTable,
  renderTaskResult,
  validateReviewOutput
} from "../plugins/agy/scripts/lib/render.mjs";

const job = {
  id: "job-1",
  cwd: "/tmp/work",
  status: "done",
  mode: "consult",
  background: false,
  createdAt: "2026-10-13T00:00:00.000Z",
  sessionId: "agy-chat",
  resumedFromJobId: "job-0",
  delivery: "foreground",
  semanticStatus: "unverified",
  requestedModel: "gemini-4-neon",
  resolvedModel: "gemini-4-neon",
  resolvedEffort: "xhigh",
  observedModel: "Gemini Neon",
  requestedEffort: "high",
  effortApplied: false,
  billingPool: "subscription",
  agyVersion: "1.5.12",
  stopReason: "end_turn",
  warnings: ["project hooks enabled", "late_close"]
};

test("task result ends with Antigravity footer and each warning precedes state", () => {
  const output = renderTaskResult({ text: "Completed.", record: job });
  assert.ok(output.startsWith("Completed.\n\n"));
  assert.ok(output.endsWith([
    "agy-session: agy-chat",
    "job: job-1",
    "resumed-from: job-0",
    "sandbox: /tmp/work",
    "delivery: foreground",
    "semantic: unverified",
    "warning: project hooks enabled",
    "warning: late_close",
    "state: done",
    ""
  ].join("\n")));
});

test("input failure has no job or sandbox line", () => {
  const output = renderTaskResult({ text: "Unknown model.", status: "error", failureKind: "input" });
  assert.match(output, /state: error\nfailure: input\n$/);
  assert.doesNotMatch(output, /^job:|^sandbox:/m);
});

test("warnings are single lines and failed outcomes end with failure", () => {
  const output = renderTaskResult({ text: "Stopped.", record: { ...job, status: "error", failureKind: "policy", warnings: ["project\nhooks"] } });
  assert.match(output, /warning: project hooks\nstate: error\nfailure: policy\n$/);
  assert.match(renderCancelReport(job), /warning: late_close\nstate: cancelled\nfailure: cancelled\n$/);
});

test("background launch includes its workspace and running state", () => {
  const output = renderBackgroundLaunch("job-2", "manual", "/tmp/work");
  assert.match(output, /job: job-2\nsandbox: \/tmp\/work\ndelivery: manual\nstate: running\n$/);
  assert.throws(() => renderBackgroundLaunch("job-2", "manual"), /requires a workspace path/);
});

test("status and job detail show the Antigravity model and build evidence", () => {
  const status = renderStatusTable([job], "session-1", Date.parse("2026-10-13T00:01:00.000Z"));
  const detail = renderJobDetail(job);
  for (const value of [job.requestedModel, job.resolvedModel, job.observedModel, job.billingPool, job.agyVersion]) {
    assert.ok(status.includes(value), value);
    assert.ok(detail.includes(value), value);
  }
  assert.match(status, /effort applied/);
  assert.match(detail, /Effort applied: no/);
  assert.match(detail, /Resolved effort: xhigh/);
  assert.match(detail, /Antigravity session: agy-chat/);
  assert.match(detail, /Stop cause: end_turn/);
  assert.ok(detail.endsWith("warning: late_close\nstate: done\n"));
});

test("setup shows Antigravity binary, auth, models, and workspace configuration", () => {
  const output = renderSetupReport({
    ready: true,
    agy: { available: true, buildPath: "/usr/local/bin/agy", version: "1.5.12", detail: "available" },
    compatibility: "tested",
    auth: { authenticated: true,  },
    catalogSize: 12,
    projectConfigFiles: [".gemini"],
    dataDir: { writable: true, path: "/tmp/agy-data" }
  });
  for (const value of ["/usr/local/bin/agy", "1.5.12", "authenticated", "12 Google models", ".gemini"]) {
    assert.ok(output.includes(value), value);
  }
});

test("history has Antigravity columns, safe cells, and no memory column", () => {
  const output = renderHistoryReport({
    scope: "all", totalJobs: 2,
    jobs: [{ ...job, jobId: "job|1", jobClass: "task", deliveryStatus: "collected", resumable: true, ownedByCurrentSession: false, cwd: "/tmp/<work>" }]
  }, Date.parse("2026-10-13T00:01:00.000Z"));
  assert.match(output, /# Antigravity history/);
  assert.match(output, /job&#124;1/);
  assert.match(output, /\/tmp\/&lt;work&gt;/);
  assert.match(output, /requested model \| resolved model \| observed model/);
  assert.match(output, /observed model \| resolved effort \| effort applied/);
  assert.match(output, /Gemini Neon \| xhigh \| no/);
  assert.doesNotMatch(output, /\| memory \|/);
  assert.equal(formatAge(job.createdAt, Date.parse("2026-10-13T00:01:00.000Z")), "1m");
  assert.equal(renderHistoryReport({ scope: "all", jobs: [] }), "No Antigravity jobs recorded across workspaces.\n");
});

test("review JSON extraction handles prose and braces in strings", () => {
  const object = extractFirstJsonObject('Before {broken} then ```json\n{"verdict":"approve","summary":"ok {yes}","findings":[]}\n```');
  assert.equal(object.verdict, "approve");
  assert.equal(object.summary, "ok {yes}");
});

test("review validation accepts only Antigravity verdicts and required finding fields", () => {
  const review = {
    verdict: "request_changes",
    summary: "Fix the guard.",
    findings: [{ severity: "critical", file: "src/index.mjs", line: 12, title: "Missing guard", body: "Input can escape." },
      { severity: "low", file: "src/other.mjs", line: null, title: "Naming", body: "Rename the local." }]
  };
  assert.deepEqual(validateReviewOutput(review), { valid: true, value: review });
  const rendered = renderReviewResult(review, { targetLabel: "working tree" });
  assert.match(rendered, /Verdict: request_changes\nSummary: Fix the guard/);
  assert.match(rendered, /critical \| Missing guard \| src\/index.mjs:12/);
  assert.match(rendered, /low \| Naming \| src\/other.mjs/);
  assert.equal(validateReviewOutput({ ...review, verdict: "needs-attention" }).valid, false);
  assert.equal(validateReviewOutput({ ...review, summary: undefined }).valid, false);
  assert.equal(validateReviewOutput({ ...review, findings: [{ ...review.findings[0], severity: "info" }] }).valid, false);
  assert.equal(validateReviewOutput({ ...review, findings: [{ ...review.findings[0], line: "12" }] }).valid, false);
  assert.equal(validateReviewOutput({ ...review, findings: [{ ...review.findings[0], file: undefined }] }).valid, false);
});
