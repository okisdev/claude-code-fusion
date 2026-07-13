import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { envFor, jobLogFiles, jobRecords, killGroups, makeSandbox, runCompanion, waitFor } from "./lib/companion-harness.mjs";

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

for (const { name, mode, failureKind } of [
  { name: "quota stderr yields failure kind quota", mode: "quota-error", failureKind: "quota" },
  { name: "mixed quota and auth stderr yields failure kind quota", mode: "quota-auth-error", failureKind: "quota" },
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

test("invalid zero exit JSON envelope records an error with a bounded stdout tail", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "invalid-json" });
  const result = runCompanion(["task", "bad output"], { cwd: sandbox.workDir, env });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /^state: error$/m);
  assert.match(result.stderr, /^failure: error$/m);
  assert.ok(result.stderr.includes("valid JSON envelope"));
  assert.ok(result.stderr.includes("not a JSON envelope"));
  const record = jobRecords(sandbox.dataDir)[0];
  assert.strictEqual(record.status, "error");
  assert.strictEqual(record.failureKind, "error");
  assert.strictEqual(record.sessionId, null);
  assert.ok(record.errorTail.includes("not a JSON envelope"));
});

test("bad cwd is an input error before a job is created", (t) => {
  const sandbox = makeSandbox(t);
  const missing = path.join(sandbox.root, "missing-work");
  const textResult = runCompanion(["task", "hello", "--cwd", missing], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.notStrictEqual(textResult.status, 0);
  assert.doesNotMatch(textResult.stderr, /^job: /m);
  assert.match(textResult.stderr, /state: error\nfailure: input\n$/);
  const result = runCompanion(["task", "hello", "--cwd", missing, "--json"], {
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
  assert.match(textResult.stderr, /^failure: error$/m);
  const jsonResult = runCompanion(["task", "--prompt-file", "missing.md", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.notStrictEqual(jsonResult.status, 0);
  const payload = JSON.parse(jsonResult.stderr);
  assert.strictEqual(payload.status, "error");
  assert.strictEqual(payload.failureKind, "error");
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

test("cancelled background job yields failure kind cancelled", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_GROK_MODE: "hang" });
  const launch = runCompanion(["task", "long running", "--background"], {
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
  const resultOutput = runCompanion(["result", cancelled.id], { cwd: sandbox.workDir, env });
  assert.strictEqual(resultOutput.status, 0, resultOutput.stderr);
  assert.match(resultOutput.stdout, /^failure: cancelled$/m);
});
