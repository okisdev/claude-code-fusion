import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { test as nodeTest } from "node:test";
import { envFor, jobLogFiles, jobRecords, killGroups, makeSandbox, processInspectionAvailable, runCompanion, waitFor } from "./lib/companion-harness.mjs";

const processInspectionTests = new Set([
  "missing binary yields failure kind missing_cli",
  "rate limited stderr yields failure kind rate_limited",
  "auth stderr yields failure kind auth",
  "hard organization version policy below range death yields failure kind setup",
  "hard organization version policy above range death yields failure kind setup",
  "quota stderr yields failure kind quota",
  "mixed quota and auth stderr yields failure kind quota",
  "HTTP 402 stderr yields failure kind quota",
  "Payment Required stderr yields failure kind quota",
  "balance exhausted stderr yields failure kind quota",
  "balance is exhausted stderr yields failure kind quota",
  "exhausted balance stderr yields failure kind quota",
  "insufficient balance stderr yields failure kind quota",
  "insufficient account balance stderr yields failure kind quota",
  "insufficient account credit stderr yields failure kind quota",
  "insufficient account credits stderr yields failure kind quota",
  "insufficient account funds stderr yields failure kind quota",
  "usage limit stderr yields failure kind quota",
  "generic stderr yields failure kind error",
  "structured quota errors retain reported usage",
  "result text 402 errors yield failure kind quota",
  "turn-limit failures retain the final envelope and reported spend",
  "malformed spend fields in a structured error fail as transport",
  "invalid zero exit JSON envelope records an error with a bounded stdout tail",
  "external SIGKILL reports exit code 137 and generic failure",
  "large stderr is capped in the job log and rendered error",
  "timeout yields failure kind timeout",
  "permission-cancelled turn yields failure kind permission",
  "permission-cancelled turn names the blocked call when the CLI reports it",
  "permission-cancelled turn reports explicit absence when the CLI omits the call",
  "cancelled background job retains requested model and effort attribution"
]);

function test(name, callback) {
  return nodeTest(name, (t) => {
    if (processInspectionTests.has(name) && !processInspectionAvailable()) {
      t.skip("process inspection unavailable in this environment");
      return;
    }
    return callback(t);
  });
}

test("missing binary yields failure kind missing_cli", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { GROK_BIN: path.join(sandbox.root, "missing-grok") });
  const result = runCompanion(["task", "unlaunchable"], { cwd: sandbox.workDir, env });
  assert.notStrictEqual(result.status, 0);
  const record = jobRecords(sandbox.dataDir)[0];
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.failureKind, "missing_cli");
  const resultOutput = runCompanion(["result", record.id], { cwd: sandbox.workDir, env });
  assert.strictEqual(resultOutput.status, 0, resultOutput.stderr);
  assert.match(resultOutput.stdout, /^failure: missing_cli$/m);
  assert.match(resultOutput.stdout, /^state: error$/m);
  assert.match(result.stderr, /^state: error$/m);
});

test("rate limited stderr yields failure kind rate_limited", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "rate-limit-error" });
  const result = runCompanion(["task", "doomed"], { cwd: sandbox.workDir, env });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /^failure: rate_limited$/m);
  const record = jobRecords(sandbox.dataDir)[0];
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.failureKind, "rate_limited");
  const resultOutput = runCompanion(["result", record.id], { cwd: sandbox.workDir, env });
  assert.strictEqual(resultOutput.status, 0, resultOutput.stderr);
  assert.match(resultOutput.stdout, /^failure: rate_limited$/m);
});

test("auth stderr yields failure kind auth", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "auth-error" });
  const result = runCompanion(["task", "doomed"], { cwd: sandbox.workDir, env });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /^failure: auth$/m);
  const record = jobRecords(sandbox.dataDir)[0];
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.failureKind, "auth");
  const resultOutput = runCompanion(["result", record.id], { cwd: sandbox.workDir, env });
  assert.strictEqual(resultOutput.status, 0, resultOutput.stderr);
  assert.match(resultOutput.stdout, /^failure: auth$/m);
});

for (const [policy, upstreamMessage, remediation] of [
  [
    "below",
    "older than the minimum required by your organization",
    /older than your organization's required minimum version\. Upgrade Grok, then rerun \/grok:setup\./i
  ],
  [
    "above",
    "newer than the maximum allowed by your organization",
    /newer than your organization's allowed maximum version\. Install an approved Grok build at or below that ceiling \(for example `grok update --version <approved>`\), then rerun \/grok:setup\./i
  ]
]) {
  test(`hard organization version policy ${policy} range death yields failure kind setup`, (t) => {
    const sandbox = makeSandbox(t);
    const env = envFor(sandbox, {
      FAKE_GROK_MODE: "required-version-policy-death",
      FAKE_GROK_REQUIRED_VERSION_POLICY: policy
    });
    const result = runCompanion(["task", "doomed"], { cwd: sandbox.workDir, env });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /^failure: setup$/m);
    assert.match(result.stderr, remediation);
    const [record] = jobRecords(sandbox.dataDir);
    assert.strictEqual(record.status, "error");
    assert.strictEqual(record.failureKind, "setup");
    assert.strictEqual(record.sessionId, null);
    assert.match(record.errorMessage, remediation);
    assert.match(record.errorTail, new RegExp(upstreamMessage, "i"));
  });
}

for (const { name, mode, failureKind } of [
  { name: "quota stderr yields failure kind quota", mode: "quota-error", failureKind: "quota" },
  { name: "mixed quota and auth stderr yields failure kind quota", mode: "quota-auth-error", failureKind: "quota" },
  { name: "HTTP 402 stderr yields failure kind quota", mode: "http-402-error", failureKind: "quota" },
  { name: "Payment Required stderr yields failure kind quota", mode: "payment-required-error", failureKind: "quota" },
  { name: "balance exhausted stderr yields failure kind quota", mode: "balance-exhausted-error", failureKind: "quota" },
  { name: "balance is exhausted stderr yields failure kind quota", mode: "balance-is-exhausted-error", failureKind: "quota" },
  { name: "exhausted balance stderr yields failure kind quota", mode: "exhausted-balance-error", failureKind: "quota" },
  { name: "insufficient balance stderr yields failure kind quota", mode: "insufficient-balance-error", failureKind: "quota" },
  { name: "insufficient account balance stderr yields failure kind quota", mode: "insufficient-account-balance-error", failureKind: "quota" },
  { name: "insufficient account credit stderr yields failure kind quota", mode: "insufficient-account-credit-error", failureKind: "quota" },
  { name: "insufficient account credits stderr yields failure kind quota", mode: "insufficient-account-credits-error", failureKind: "quota" },
  { name: "insufficient account funds stderr yields failure kind quota", mode: "insufficient-account-funds-error", failureKind: "quota" },
  { name: "usage limit stderr yields failure kind quota", mode: "usage-limit-error", failureKind: "quota" },
  { name: "generic stderr yields failure kind error", mode: "error", failureKind: "error" },
]) {
  test(name, (t) => {
    const sandbox = makeSandbox(t);
    const env = envFor(sandbox, { FAKE_GROK_MODE: mode });
    const result = runCompanion(["task", "doomed"], { cwd: sandbox.workDir, env });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`^failure: ${failureKind}$`, "m"));
    const record = jobRecords(sandbox.dataDir)[0];
    assert.strictEqual(record.status, "error");
    assert.strictEqual(record.failureKind, failureKind);
    const resultOutput = runCompanion(["result", record.id], { cwd: sandbox.workDir, env });
    assert.strictEqual(resultOutput.status, 0, resultOutput.stderr);
    assert.match(resultOutput.stdout, new RegExp(`^failure: ${failureKind}$`, "m"));
  });
}

test("structured quota errors retain reported usage", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "usage-error" });
  const result = runCompanion(["task", "doomed"], { cwd: sandbox.workDir, env });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 402 Payment Required: balance exhausted/);
  assert.match(result.stderr, /^failure: quota$/m);
  const record = jobRecords(sandbox.dataDir)[0];
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.failureKind, "quota");
  assert.deepStrictEqual(record.usage, {
    input_tokens: 120,
    cache_read_input_tokens: 30,
    output_tokens: 20,
    reasoning_tokens: 5,
    total_tokens: 170,
  });
  assert.deepStrictEqual(Object.keys(record.modelUsage), ["grok-test-main", "grok-test-subagent"]);
  assert.strictEqual(record.numTurns, 2);
  assert.strictEqual(record.usageIsIncomplete, true);
  assert.strictEqual(record.modelUsageIsIncomplete, false);

  const stats = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(stats.status, 0, stats.stderr);
  assert.deepStrictEqual(JSON.parse(stats.stdout).usageCoverage, {
    availability: "unavailable",
    completeJobs: 0,
    incompleteJobs: 1,
    unreportedJobs: 0,
  });
});

test("result text 402 errors yield failure kind quota", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "result-text-402-error" });
  const result = runCompanion(["task", "doomed"], { cwd: sandbox.workDir, env });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /^failure: quota$/m);
  const [record] = jobRecords(sandbox.dataDir);
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.failureKind, "quota");
  assert.strictEqual(record.resultText, "API error (status 402 Payment Required): Grok Build usage balance exhausted");
});

test("turn-limit failures retain the final envelope and reported spend", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, {
    FAKE_GROK_MODE: "max-turns",
    FAKE_GROK_RESOLVED_MODEL: "grok-turn-limit",
    FAKE_GROK_RESOLVED_EFFORT: "xhigh"
  });
  const result = runCompanion(["task", "doomed"], { cwd: sandbox.workDir, env });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /^failure: turn_limit$/m);
  assert.match(result.stderr, /Error: max turns reached/);
  const [record] = jobRecords(sandbox.dataDir);
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.failureKind, "turn_limit");
  assert.strictEqual(record.errorMessage, "Error: max turns reached");
  assert.strictEqual(record.resultText, "FAKE-TURN-LIMIT-PARTIAL");
  assert.strictEqual(record.requestId, "req-max-turns");
  assert.strictEqual(record.stopReason, "Cancelled");
  assert.strictEqual(record.resolvedModel, "grok-turn-limit");
  assert.strictEqual(record.resolvedEffort, "xhigh");
  assert.deepStrictEqual(record.usage, {
    input_tokens: 120,
    cache_read_input_tokens: 30,
    output_tokens: 20,
    reasoning_tokens: 5,
    total_tokens: 170
  });
  assert.deepStrictEqual(record.modelUsage, {
    "grok-test-main": {
      inputTokens: 100,
      outputTokens: 15,
      cacheReadInputTokens: 30,
      modelCalls: 2,
      costUSD: 0.01
    },
    "grok-test-subagent": {
      inputTokens: 20,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      modelCalls: 1,
      costUSD: 0.002
    }
  });
  assert.strictEqual(record.numTurns, 60);
  assert.strictEqual(record.totalCostUsd, 0.012);
  assert.strictEqual(record.totalCostUsdTicks, 120000000);
  assert.strictEqual(record.costIsPartial, false);
  assert.strictEqual(record.usageIsIncomplete, false);
  assert.strictEqual(record.modelUsageIsIncomplete, false);
  assert.deepStrictEqual(record.structuredOutput, {
    status: "partial",
    summary: "The turn limit stopped further work."
  });
});

test("malformed spend fields in a structured error fail as transport", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "usage-error-malformed" });
  const result = runCompanion(["task", "doomed"], { cwd: sandbox.workDir, env });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /invalid usage\.output_tokens/);
  assert.match(result.stderr, /^failure: transport$/m);
  const [record] = jobRecords(sandbox.dataDir);
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.failureKind, "transport");
  assert.strictEqual(record.usageIsIncomplete, true);
});

test("invalid zero exit JSON envelope records an error with a bounded stdout tail", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "invalid-json" });
  const result = runCompanion(["task", "bad output"], { cwd: sandbox.workDir, env });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /^state: error$/m);
  assert.match(result.stderr, /^failure: transport$/m);
  assert.ok(result.stderr.includes("valid JSON envelope"));
  assert.ok(result.stderr.includes("not a JSON envelope"));
  const record = jobRecords(sandbox.dataDir)[0];
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.failureKind, "transport");
  assert.strictEqual(record.sessionId, null);
  assert.ok(record.errorTail.includes("not a JSON envelope"));
});

test("bad cwd is an input error before a job is created", (t) => {
  const sandbox = makeSandbox(t);
  const missing = path.join(sandbox.root, "missing-work");
  const textResult = runCompanion(["task", "--cwd", missing, "hello"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.notStrictEqual(textResult.status, 0);
  assert.doesNotMatch(textResult.stderr, /^job: /m);
  assert.match(textResult.stderr, /state: error\nfailure: input\n$/);
  const result = runCompanion(["task", "--cwd", missing, "--json", "hello"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.notStrictEqual(result.status, 0);
  const payload = JSON.parse(result.stderr);
  assert.strictEqual(payload.status, "error");
  assert.strictEqual(payload.failureKind, "input");
  assert.match(payload.message, /Working directory does not exist/);
  assert.deepStrictEqual(jobRecords(sandbox.dataDir), []);
});

test("prompt file preflight errors are parseable in text and JSON modes", (t) => {
  const sandbox = makeSandbox(t);
  const textResult = runCompanion(["task", "--prompt-file", "missing.md"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.notStrictEqual(textResult.status, 0);
  assert.match(textResult.stderr, /^state: error$/m);
  assert.match(textResult.stderr, /^failure: input$/m);
  const jsonResult = runCompanion(["task", "--prompt-file", "missing.md", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.notStrictEqual(jsonResult.status, 0);
  const payload = JSON.parse(jsonResult.stderr);
  assert.strictEqual(payload.status, "error");
  assert.strictEqual(payload.failureKind, "input");
  assert.match(payload.message, /missing\.md/);
  assert.deepStrictEqual(jobRecords(sandbox.dataDir), []);
});

test("external SIGKILL reports exit code 137 and generic failure", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "sigkill" });
  const result = runCompanion(["task", "killed externally"], { cwd: sandbox.workDir, env });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /^failure: error$/m);
  const record = jobRecords(sandbox.dataDir)[0];
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.failureKind, "error");
  assert.strictEqual(record.exitCode, 137);
});

test("large stderr is capped in the job log and rendered error", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "large-stderr-error" });
  const result = runCompanion(["task", "noisy failure"], { cwd: sandbox.workDir, env });
  assert.notStrictEqual(result.status, 0);
  assert.ok(result.stderr.length < 100000);
  const [logFile] = jobLogFiles(sandbox.dataDir);
  assert.ok(logFile, "Expected a job log file.");
  assert.ok(fs.statSync(logFile).size <= 1024 * 1024);
  const record = jobRecords(sandbox.dataDir)[0];
  assert.strictEqual(record.status, "error");
  assert.ok(record.errorTail.includes("large stderr ends"));
});

test("timeout yields failure kind timeout", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "hang", GROK_COMPANION_TIMEOUT_MS: "500" });
  const result = runCompanion(["task", "slow work"], { cwd: sandbox.workDir, env });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /^failure: timeout$/m);
  const record = jobRecords(sandbox.dataDir)[0];
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.failureKind, "timeout");
  const resultOutput = runCompanion(["result", record.id], { cwd: sandbox.workDir, env });
  assert.strictEqual(resultOutput.status, 0, resultOutput.stderr);
  assert.match(resultOutput.stdout, /^failure: timeout$/m);
});

test("permission-cancelled turn yields failure kind permission", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "permission-cancelled" });
  const result = runCompanion(["task", "doomed"], { cwd: sandbox.workDir, env });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /^failure: permission$/m);
  assert.match(result.stderr, /^state: error$/m);
  assert.match(
    result.stderr,
    /consult-mode permission gate.*blocked call not reported by the CLI/s
  );
  const record = jobRecords(sandbox.dataDir)[0];
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.failureKind, "permission");
  assert.match(record.errorTail, /blocked call not reported by the CLI/);
  const resultOutput = runCompanion(["result", record.id], { cwd: sandbox.workDir, env });
  assert.strictEqual(resultOutput.status, 0, resultOutput.stderr);
  assert.match(resultOutput.stdout, /^failure: permission$/m);
  assert.match(resultOutput.stdout, /^state: error$/m);
});

test("permission-cancelled turn names the blocked call when the CLI reports it", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "permission-cancelled-named" });
  const result = runCompanion(["task", "doomed"], { cwd: sandbox.workDir, env });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /^failure: permission$/m);
  assert.match(
    result.stderr,
    /blocked call: Bash\(\{"command":"git status --short && npm test"\}\)/
  );
  const record = jobRecords(sandbox.dataDir)[0];
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.failureKind, "permission");
  assert.match(record.errorTail, /blocked call: Bash\(/);
  const resultOutput = runCompanion(["result", record.id], { cwd: sandbox.workDir, env });
  assert.strictEqual(resultOutput.status, 0, resultOutput.stderr);
  assert.match(resultOutput.stdout, /^failure: permission$/m);
});

test("permission-cancelled turn reports explicit absence when the CLI omits the call", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "permission-cancelled" });
  const result = runCompanion(["task", "doomed"], { cwd: sandbox.workDir, env });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /blocked call not reported by the CLI/);
  assert.doesNotMatch(result.stderr, /blocked call: /);
});

test("cancelled background job retains requested model and effort attribution", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "hang" });
  const launch = runCompanion(["task", "--background", "--model", "grok-requested", "--effort", "high", "long running"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(launch.status, 0, launch.stderr);
  const running = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current && current.status === "running" && current.pid && current.grokPid ? current : null;
  });
  t.after(() => {
    killGroups(running.grokPid);
    killGroups(running.pid);
  });
  const cancelOutput = runCompanion(["cancel", running.id], { cwd: sandbox.workDir, env });
  assert.strictEqual(cancelOutput.status, 0, cancelOutput.stderr);
  assert.match(cancelOutput.stdout, /^state: cancelled$/m);
  assert.match(cancelOutput.stdout, /^failure: cancelled$/m);
  const cancelled = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current && current.status === "cancelled" ? current : null;
  });
  assert.strictEqual(cancelled.failureKind, "cancelled");
  assert.strictEqual(cancelled.resolvedModel, "grok-requested");
  assert.strictEqual(cancelled.resolvedEffort, "high");
  const resultOutput = runCompanion(["result", cancelled.id], { cwd: sandbox.workDir, env });
  assert.strictEqual(resultOutput.status, 0, resultOutput.stderr);
  assert.match(resultOutput.stdout, /^failure: cancelled$/m);
});
