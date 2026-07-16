import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { envFor as companionEnvFor, flagValues, grokCompanionCapabilities, jobRecords, makeSandbox, readInvocations, runCompanion, stateModulePath, waitFor } from "./lib/companion-harness.mjs";
import { initFixtureRepo } from "./lib/git-fixture.mjs";

const { createJobRecord, generateJobId, jobFilePath, writeBrief, writeJobRecordFile } = await import(stateModulePath);

function envFor(sandbox, extra = {}) {
  return companionEnvFor(sandbox, extra, { git: true });
}

const reviewObject = {
  verdict: "needs-attention",
  findings: [
    {
      severity: "high",
      title: "Example finding",
      body: "Example body describing the defect.",
      file: "src/app.mjs",
      line_start: 10,
      line_end: 12,
      confidence: 0.9,
      recommendation: "Fix the defect before merging."
    }
  ],
  next_steps: ["Run the tests."]
};

function writeEnvelopeGrok(sandbox, name, envelope, exitCode = 0) {
  const file = path.join(sandbox.root, `${name}.mjs`);
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node\nimport fs from "node:fs";\nimport os from "node:os";\nimport path from "node:path";\nif (process.env.FAKE_GROK_ARGS_FILE) fs.appendFileSync(process.env.FAKE_GROK_ARGS_FILE, JSON.stringify(process.argv.slice(2)) + "\\n");\nconst sandboxIndex = process.argv.indexOf("--sandbox");\nif (sandboxIndex >= 0) {\n  const profile = process.argv[sandboxIndex + 1];\n  const grokHome = Object.hasOwn(process.env, "GROK_HOME") ? path.resolve(process.cwd(), process.env.GROK_HOME) : path.join(os.homedir(), ".grok");\n  fs.mkdirSync(grokHome, { recursive: true });\n  fs.appendFileSync(path.join(grokHome, "sandbox-events.jsonl"), JSON.stringify({ event_type: "ProfileApplied", profile, workspace: fs.realpathSync(process.cwd()), enforced: true, restrict_network: profile !== "workspace", read_write_paths: [fs.realpathSync(process.cwd()), grokHome, process.env.TMPDIR].filter(Boolean) }) + "\\n");\n  process.stderr.write("DEBUG xai_grok_agent::builder: tools allowlist applied\\n");\n}\nfor await (const chunk of process.stdin) void chunk;\nprocess.stdout.write(${JSON.stringify(`${JSON.stringify(envelope)}\n`)});\nprocess.exit(${exitCode});\n`,
    "utf8"
  );
  fs.chmodSync(file, 0o755);
  return file;
}

test("review passes the output contract as an inline JSON schema and renders the structured result", (t) => {
  const sandbox = makeSandbox(t);
  const stdinFile = path.join(sandbox.root, "review-stdin.txt");
  initFixtureRepo(sandbox.workDir);
  const result = runCompanion(["review", "--focus", "check the error handling"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "review-ok", FAKE_GROK_STDIN_FILE: stdinFile }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const invocations = readInvocations(sandbox.argsFile);
  assert.strictEqual(invocations.length, 1);
  const briefFile = flagValues(invocations[0], "--prompt-file")[0];
  assert.strictEqual(briefFile, "/dev/stdin");
  const schema = JSON.parse(flagValues(invocations[0], "--json-schema")[0]);
  assert.deepStrictEqual(schema.required, ["verdict", "findings", "next_steps"]);
  assert.deepStrictEqual(schema.properties.verdict.enum, ["approve", "needs-attention"]);
  assert.strictEqual(schema.properties.findings.items.additionalProperties, false);
  assert.deepStrictEqual(schema.properties.findings.items.required, ["severity", "title", "body"]);
  const brief = fs.readFileSync(stdinFile, "utf8");
  assert.ok(brief.includes("export const other = 2;"));
  assert.ok(brief.includes("untracked.txt"));
  assert.ok(brief.includes("check the error handling"));
  assert.ok(result.stdout.includes("needs-attention"));
  assert.ok(result.stdout.includes("Example finding"));
  assert.ok(result.stdout.includes("src/app.mjs"));
  assert.ok(result.stdout.includes("Run the tests."));
});

test("review fails closed before launch without structured output support", (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const capabilities = grokCompanionCapabilities
    .split(",")
    .filter((capability) => capability !== "--json-schema")
    .join(",");
  const result = runCompanion(["review"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { GROK_COMPANION_CAPABILITIES: capabilities })
  });

  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /--json-schema/);
  assert.deepStrictEqual(readInvocations(sandbox.argsFile), []);
});

test("review trusts validated structured output without resuming when the text is not JSON", (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const grokBin = writeEnvelopeGrok(sandbox, "structured-review", {
    text: "The validated review is attached outside this prose.",
    structuredOutput: reviewObject,
    stopReason: "EndTurn",
    sessionId: "22222222-2222-7222-8222-222222222222",
    requestId: "req-structured"
  });
  const result = runCompanion(["review"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { GROK_BIN: grokBin }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const invocations = readInvocations(sandbox.argsFile);
  assert.strictEqual(invocations.length, 1);
  assert.ok(!invocations[0].includes("-r"));
  assert.ok(result.stdout.includes("needs-attention"));
  assert.ok(result.stdout.includes("Example finding"));
});

test("review records one structured turn's usage without a corrective model call", (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const usage = {
    input_tokens: 10,
    cache_read_input_tokens: 2,
    output_tokens: 3,
    reasoning_tokens: 1,
    total_tokens: 15
  };
  const modelUsage = {
    "grok-review": {
      inputTokens: 10,
      cacheReadInputTokens: 2,
      outputTokens: 3,
      reasoningTokens: 1,
      totalTokens: 15,
      modelCalls: 1,
      costUSD: 0.001
    }
  };
  const grokBin = writeEnvelopeGrok(sandbox, "usage-review", {
    text: "structured review",
    structuredOutput: reviewObject,
    stopReason: "EndTurn",
    sessionId: "23232323-2323-7323-8323-232323232323",
    requestId: "req-review-usage",
    usage,
    modelUsage,
    usage_is_incomplete: false
  });
  const env = envFor(sandbox, { GROK_BIN: grokBin });
  const result = runCompanion(["review"], { cwd: sandbox.workDir, env });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(readInvocations(sandbox.argsFile).length, 1);
  const [record] = jobRecords(sandbox.dataDir);
  assert.strictEqual(record.status, "done");
  assert.strictEqual(record.usageIsIncomplete, false);
  assert.strictEqual(record.modelUsageIsIncomplete, false);
  assert.deepStrictEqual(record.usage, usage);
  assert.deepStrictEqual(record.modelUsage, modelUsage);

  const statsResult = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(statsResult.status, 0, statsResult.stderr);
  const stats = JSON.parse(statsResult.stdout);
  assert.strictEqual(stats.usage.reportedJobs, 1);
  assert.strictEqual(stats.usage.totalTokens, 15);
  assert.strictEqual(stats.usageCoverage.completeJobs, 1);
});

test("review falls back to local text parsing for an older Grok envelope", (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const grokBin = writeEnvelopeGrok(sandbox, "legacy-review", {
    text: `\`\`\`json\n${JSON.stringify(reviewObject)}\n\`\`\``,
    stopReason: "EndTurn",
    sessionId: "24242424-2424-7424-8424-242424242424",
    requestId: "req-legacy"
  });
  const result = runCompanion(["review"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { GROK_BIN: grokBin })
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(readInvocations(sandbox.argsFile).length, 1);
  assert.match(result.stdout, /Example finding/);
});

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

test("review records a structured validation error without resuming or trusting valid-looking text", (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const grokBin = writeEnvelopeGrok(sandbox, "invalid-structured-review", {
    text: JSON.stringify(reviewObject),
    structuredOutput: null,
    structuredOutputError: "output does not match the required schema",
    stopReason: "EndTurn",
    sessionId: "44444444-4444-7444-8444-444444444444",
    requestId: "req-invalid-structured"
  });
  const result = runCompanion(["review"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { GROK_BIN: grokBin }),
  });
  assert.notStrictEqual(result.status, 0);
  const invocations = readInvocations(sandbox.argsFile);
  assert.strictEqual(invocations.length, 1);
  assert.ok(!invocations[0].includes("-r"));
  assert.ok(result.stderr.includes("did not return a valid review JSON object"));
  assert.ok(result.stderr.includes("output does not match the required schema"));
  const [record] = jobRecords(sandbox.dataDir);
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.failureKind, "error");
  assert.ok(record.resultText.includes(JSON.stringify(reviewObject)));
  assert.match(record.errorMessage, /failed validation: output does not match the required schema/);
  assert.doesNotMatch(record.errorMessage, /\r?\n/);
  assert.match(result.stderr, new RegExp(`job: ${record.id}\\nstate: error\\nfailure: error\\n$`));
});

test("background review records a structured validation failure after one model call", async (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const grokBin = writeEnvelopeGrok(sandbox, "background-invalid-review", {
    text: "I could not produce the requested object.",
    structuredOutput: null,
    structuredOutputError: "output does not match the required schema",
    stopReason: "EndTurn",
    sessionId: "45454545-4545-7545-8545-454545454545",
    requestId: "req-background-invalid"
  });
  const env = envFor(sandbox, { GROK_BIN: grokBin });
  const launch = runCompanion(["review", "--background"], { cwd: sandbox.workDir, env });
  assert.strictEqual(launch.status, 0, launch.stderr);
  const record = await waitFor(() => {
    const current = jobRecords(sandbox.dataDir)[0];
    return current?.status === "error" ? current : null;
  });
  assert.strictEqual(readInvocations(sandbox.argsFile).length, 1);
  assert.strictEqual(record.failureKind, "error");
  assert.ok(record.resultText.includes("I could not produce the requested object."));
  assert.match(record.errorMessage, /failed validation: output does not match the required schema/);
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
