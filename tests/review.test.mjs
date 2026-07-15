import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { envFor as companionEnvFor, flagValues, hasPair, jobRecords, makeSandbox, readInvocations, repoRoot, runCompanion, stateModulePath, waitFor } from "./lib/companion-harness.mjs";
import { initFixtureRepo } from "./lib/git-fixture.mjs";

const { createJobRecord, generateJobId, jobFilePath, writeBrief, writeJobRecordFile } = await import(stateModulePath);

function envFor(sandbox, extra = {}) {
  return companionEnvFor(sandbox, extra, { git: true });
}

test("review builds a prompt from the working tree and renders the extracted JSON", (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const result = runCompanion(["review", "--focus", "check the error handling"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "review-ok" }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const invocations = readInvocations(sandbox.argsFile);
  assert.strictEqual(invocations.length, 1);
  const briefFile = flagValues(invocations[0], "--prompt-file")[0];
  assert.ok(briefFile, "Expected a --prompt-file argument.");
  const brief = fs.readFileSync(briefFile, "utf8");
  assert.ok(brief.includes("export const other = 2;"));
  assert.ok(brief.includes("untracked.txt"));
  assert.ok(brief.includes("check the error handling"));
  assert.ok(result.stdout.includes("needs-attention"));
  assert.ok(result.stdout.includes("Example finding"));
  assert.ok(result.stdout.includes("src/app.mjs"));
  assert.ok(result.stdout.includes("Run the tests."));
});

test("review retries once by resuming the session when the output is not valid JSON", (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const result = runCompanion(["review"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "badjson-then-ok" }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const invocations = readInvocations(sandbox.argsFile);
  assert.strictEqual(invocations.length, 2);
  assert.ok(!invocations[0].includes("-r"));
  assert.ok(hasPair(invocations[1], "-r", "22222222-2222-7222-8222-222222222222"));
  assert.ok(result.stdout.includes("needs-attention"));
  assert.ok(result.stdout.includes("Example finding"));
});

test("review merges two complete usage reports without changing token semantics", (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "review-usage-complete-complete" });
  const result = runCompanion(["review"], { cwd: sandbox.workDir, env });
  assert.strictEqual(result.status, 0, result.stderr);
  const [record] = jobRecords(sandbox.dataDir);
  assert.strictEqual(record.status, "done");
  assert.strictEqual(record.usageIsIncomplete, false);
  assert.strictEqual(record.modelUsageIsIncomplete, false);
  assert.deepStrictEqual(record.usage, {
    input_tokens: 30,
    cache_read_input_tokens: 6,
    output_tokens: 9,
    reasoning_tokens: 3,
    total_tokens: 45,
  });
  assert.deepStrictEqual(record.modelUsage["grok-review"], {
    inputTokens: 30,
    cacheReadInputTokens: 6,
    outputTokens: 9,
    reasoningTokens: 3,
    totalTokens: 45,
    modelCalls: 3,
    costUSD: 0.003,
  });

  const statsResult = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(statsResult.status, 0, statsResult.stderr);
  const stats = JSON.parse(statsResult.stdout);
  assert.strictEqual(stats.usage.reportedJobs, 1);
  assert.strictEqual(stats.usage.totalTokens, 45);
  assert.strictEqual(stats.usageCoverage.completeJobs, 1);
});

for (const [name, mode] of [
  ["complete then partial", "review-usage-complete-partial"],
  ["partial then complete", "review-usage-partial-complete"],
  ["complementary partial reports", "review-usage-complementary-partials"],
]) {
  test(`review keeps ${name} usage incomplete after the corrective retry`, (t) => {
    const sandbox = makeSandbox(t);
    initFixtureRepo(sandbox.workDir);
    const env = envFor(sandbox, { FAKE_GROK_MODE: mode });
    const result = runCompanion(["review"], { cwd: sandbox.workDir, env });
    assert.strictEqual(result.status, 0, result.stderr);
    const [record] = jobRecords(sandbox.dataDir);
    assert.strictEqual(record.status, "done");
    assert.strictEqual(record.usageIsIncomplete, true);
    assert.strictEqual(record.modelUsageIsIncomplete, true);
    const aggregateFields = ["input_tokens", "cache_read_input_tokens", "output_tokens", "reasoning_tokens", "total_tokens"];
    assert.ok(record.usage == null || aggregateFields.some((field) => !Object.hasOwn(record.usage, field)));
    const modelUsage = record.modelUsage?.["grok-review"];
    const modelFields = ["inputTokens", "cacheReadInputTokens", "outputTokens", "reasoningTokens", "totalTokens"];
    assert.ok(modelUsage == null || modelFields.some((field) => !Object.hasOwn(modelUsage, field)));

    const statsResult = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
    assert.strictEqual(statsResult.status, 0, statsResult.stderr);
    const stats = JSON.parse(statsResult.stdout);
    assert.strictEqual(stats.usage, null);
    assert.deepStrictEqual(stats.usageCoverage, {
      availability: "unavailable",
      completeJobs: 0,
      incompleteJobs: 1,
      unreportedJobs: 0,
    });
  });
}

test("review --background drives the job to done and result returns the review output", async (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "review-ok", GROK_COMPANION_WAIT_POLL_MS: "10" });
  const launch = runCompanion(["review", "--focus", "check the error handling", "--background"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(launch.status, 0, launch.stderr);
  const record = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current && current.status === "done" ? current : null;
  });
  assert.ok(launch.stdout.endsWith(`job: ${record.id}\ndelivery: manual\nstate: running\n`));
  assert.ok(launch.stdout.endsWith("state: running\n"));
  assert.strictEqual(record.background, true);
  assert.strictEqual(record.mode, "consult");
  assert.ok(record.resultText.includes("needs-attention"));
  assert.ok(record.resultText.includes("Example finding"));
  const result = runCompanion(["result", record.id, "--wait"], { cwd: sandbox.workDir, env });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("needs-attention"));
  assert.ok(result.stdout.includes("Example finding"));
  assert.ok(result.stdout.includes("src/app.mjs"));
  assert.match(result.stdout, new RegExp(`^job: ${record.id}$`, "m"));
  assert.match(result.stdout, /^state: done$/m);
});

test("managed JSON review collection preserves the terminal review envelope", async (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const env = envFor(sandbox, {
    FAKE_GROK_MODE: "review-ok",
    GROK_COMPANION_BACKGROUND_DELIVERY: "managed",
    GROK_COMPANION_WAIT_POLL_MS: "10",
  });
  const launch = runCompanion(["review", "--background", "--json"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(launch.status, 0, launch.stderr);
  const receipt = JSON.parse(launch.stdout);
  assert.strictEqual(receipt.status, "running");
  assert.strictEqual(receipt.delivery, "managed");

  const result = runCompanion(["result", receipt.jobId, "--wait", "--json"], {
    cwd: sandbox.workDir,
    env,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.strictEqual(payload.jobId, receipt.jobId);
  assert.strictEqual(payload.status, "done");
  assert.strictEqual(payload.mode, "consult");
  assert.strictEqual(payload.background, true);
  assert.strictEqual(payload.valid, true);
  assert.strictEqual(payload.review.verdict, "needs-attention");
  assert.ok(payload.rendered.includes("Example finding"));
  const [record] = jobRecords(sandbox.dataDir);
  assert.deepStrictEqual(record.resultPayload, payload);
  assert.ok(record.deliveryCollectedAt);
});

test("review records an error after one failed corrective retry and preserves the raw output", (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const result = runCompanion(["review"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "badjson" }),
  });
  assert.notStrictEqual(result.status, 0);
  const invocations = readInvocations(sandbox.argsFile);
  assert.strictEqual(invocations.length, 2);
  assert.ok(hasPair(invocations[1], "-r", "44444444-4444-7444-8444-444444444444"));
  assert.ok(result.stderr.includes("did not return a valid review JSON object"));
  assert.ok(result.stderr.includes("I still cannot produce the requested object."));
  const [record] = jobRecords(sandbox.dataDir);
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.failureKind, "error");
  assert.ok(record.resultText.includes("I still cannot produce the requested object."));
  assert.match(record.errorMessage, /failed validation after one corrective retry/);
  assert.doesNotMatch(record.errorMessage, /\r?\n/);
  assert.match(result.stderr, new RegExp(`job: ${record.id}\\nstate: error\\nfailure: error\\n$`));
});

test("review preserves a structured quota failure from the corrective retry", (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "review-retry-quota-error" });
  const result = runCompanion(["review"], { cwd: sandbox.workDir, env });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 402 Payment Required: insufficient account credits/);
  assert.match(result.stderr, /^state: error$/m);
  assert.match(result.stderr, /^failure: quota$/m);
  assert.strictEqual(readInvocations(sandbox.argsFile).length, 2);

  const [record] = jobRecords(sandbox.dataDir);
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.exitCode, 42);
  assert.strictEqual(record.failureKind, "quota");
  assert.strictEqual(record.sessionId, "24242424-2424-7424-8424-242424242424");
  assert.strictEqual(record.errorMessage, "HTTP 402 Payment Required: insufficient account credits");
  assert.match(record.errorTail, /HTTP 402 Payment Required: insufficient account credits/);
  assert.strictEqual(record.usageIsIncomplete, true);
  assert.strictEqual(record.modelUsageIsIncomplete, true);
  assert.strictEqual(record.usage.total_tokens, 30);

  const statsResult = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(statsResult.status, 0, statsResult.stderr);
  const stats = JSON.parse(statsResult.stdout);
  assert.deepStrictEqual(stats.byFailureKind, { quota: 1 });
  assert.strictEqual(stats.usage, null);
  assert.strictEqual(stats.usageCoverage.incompleteJobs, 1);
});

test("review treats a zero exit structured quota response as a corrective retry failure", (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "review-retry-zero-exit-quota-error" });
  const result = runCompanion(["review"], { cwd: sandbox.workDir, env });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 402 Payment Required: insufficient account credits/);
  assert.match(result.stderr, /^state: error$/m);
  assert.match(result.stderr, /^failure: quota$/m);
  assert.strictEqual(readInvocations(sandbox.argsFile).length, 2);

  const [record] = jobRecords(sandbox.dataDir);
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.exitCode, 0);
  assert.strictEqual(record.failureKind, "quota");
  assert.strictEqual(record.sessionId, "24242424-2424-7424-8424-242424242424");
  assert.strictEqual(record.errorMessage, "HTTP 402 Payment Required: insufficient account credits");
  assert.match(record.errorTail, /HTTP 402 Payment Required: insufficient account credits/);
  assert.strictEqual(record.usageIsIncomplete, true);
  assert.strictEqual(record.modelUsageIsIncomplete, true);
  assert.strictEqual(record.usage.total_tokens, 30);
});

test("review preserves first attempt usage when the corrective retry cannot spawn", (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const grokBin = path.join(sandbox.root, "self-deleting-grok.mjs");
  const usage = {
    input_tokens: 10,
    cache_read_input_tokens: 2,
    output_tokens: 3,
    reasoning_tokens: 1,
    total_tokens: 15,
  };
  const modelUsage = {
    "grok-review": {
      inputTokens: 10,
      cacheReadInputTokens: 2,
      outputTokens: 3,
      reasoningTokens: 1,
      totalTokens: 15,
    },
  };
  const response = `${JSON.stringify({
    text: "```markdown\nI could not produce the requested object, sorry.\n```",
    stopReason: "EndTurn",
    sessionId: "25252525-2525-7525-8525-252525252525",
    usage,
    modelUsage,
    usage_is_incomplete: true,
  })}\n`;
  fs.writeFileSync(
    grokBin,
    `#!/usr/bin/env node\nimport fs from "node:fs";\nfs.unlinkSync(process.argv[1]);\nprocess.stdout.write(${JSON.stringify(response)});\n`,
    "utf8",
  );
  fs.chmodSync(grokBin, 0o755);

  const env = envFor(sandbox, { GROK_BIN: grokBin });
  const result = runCompanion(["review"], { cwd: sandbox.workDir, env });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /^failure: missing_cli$/m);

  const [record] = jobRecords(sandbox.dataDir);
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.failureKind, "missing_cli");
  assert.strictEqual(record.sessionId, "25252525-2525-7525-8525-252525252525");
  assert.deepStrictEqual(record.usage, usage);
  assert.deepStrictEqual(record.modelUsage, modelUsage);
  assert.strictEqual(record.usageIsIncomplete, true);
  assert.strictEqual(record.modelUsageIsIncomplete, true);

  const statsResult = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(statsResult.status, 0, statsResult.stderr);
  const stats = JSON.parse(statsResult.stdout);
  assert.strictEqual(stats.usage, null);
  assert.strictEqual(stats.usageCoverage.incompleteJobs, 1);
});

test("background review records twice malformed output as an error", async (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "badjson" });
  const launch = runCompanion(["review", "--background"], { cwd: sandbox.workDir, env });
  assert.strictEqual(launch.status, 0, launch.stderr);
  const record = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current?.status === "error" ? current : null;
  });
  assert.strictEqual(record.failureKind, "error");
  assert.ok(record.resultText.includes("I still cannot produce the requested object."));
  assert.match(record.errorMessage, /failed validation after one corrective retry/);
});

test("review worker preserves a running cleanup-required record without launching Grok", (t) => {
  const sandbox = makeSandbox(t);
  const id = generateJobId();
  const briefFile = writeBrief(sandbox.dataDir, sandbox.workDir, id, "review cleanup state");
  writeJobRecordFile(jobFilePath(sandbox.dataDir, sandbox.workDir, id), {
    ...createJobRecord({
      id,
      pid: null,
      mode: "consult",
      cwd: sandbox.workDir,
      briefFile,
      background: true,
      request: { reviewTargetLabel: "working tree changes", sandboxProfile: "strict" },
    }),
    cleanupRequired: true,
    grokPid: 987654,
  });

  const result = runCompanion(["review-worker", "--job-id", id, "--cwd", sandbox.workDir], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });

  assert.strictEqual(result.status, 0, result.stderr);
  const [record] = jobRecords(sandbox.dataDir);
  assert.strictEqual(record.status, "running");
  assert.strictEqual(record.cleanupRequired, true);
  assert.strictEqual(record.grokPid, 987654);
  assert.strictEqual(fs.existsSync(sandbox.argsFile), false);
});

test("review output contract is enforced by validateReviewOutput instead of a schema file", () => {
  assert.ok(!fs.existsSync(path.join(repoRoot, "plugins", "grok", "schemas", "review-output.schema.json")));
});
