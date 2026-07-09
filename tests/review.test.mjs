import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { envFor as companionEnvFor, flagValues, hasPair, jobRecords, makeSandbox, readInvocations, repoRoot, runCompanion, waitFor } from "./lib/companion-harness.mjs";
import { initFixtureRepo } from "./lib/git-fixture.mjs";

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

test("review gives up after one failed retry and renders the raw text with a parse warning", (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const result = runCompanion(["review"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "badjson" }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const invocations = readInvocations(sandbox.argsFile);
  assert.strictEqual(invocations.length, 2);
  assert.ok(hasPair(invocations[1], "-r", "44444444-4444-7444-8444-444444444444"));
  assert.ok(result.stdout.includes("did not return a valid review JSON object"));
  assert.ok(result.stdout.includes("I still cannot produce the requested object."));
  const jsonRun = runCompanion(["review", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "badjson" }),
  });
  assert.strictEqual(jsonRun.status, 0, jsonRun.stderr);
  const payload = JSON.parse(jsonRun.stdout);
  assert.strictEqual(payload.valid, false);
  assert.ok(payload.parseError, "Expected a parse error in the JSON payload.");
  assert.strictEqual(payload.review, null);
  assert.ok(payload.rawText.includes("I still cannot produce the requested object."));
});

test("review output contract is enforced by validateReviewOutput instead of a schema file", () => {
  assert.ok(!fs.existsSync(path.join(repoRoot, "plugins", "grok", "schemas", "review-output.schema.json")));
});
