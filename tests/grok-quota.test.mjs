import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { writeQuotaCooldown } from "../plugins/grok/scripts/lib/state.mjs";
import { initFixtureRepo } from "./lib/git-fixture.mjs";
import { envFor, fakeGrok, jobRecords, makeSandbox, readInvocations, runCompanion } from "./lib/companion-harness.mjs";

const cooldownFile = (sandbox) => path.join(sandbox.dataDir, "quota-cooldown.json");
const runTask = (sandbox, extra = {}, args = ["task", "check"]) =>
  runCompanion(args, { cwd: sandbox.workDir, env: envFor(sandbox, extra) });

test("active cooldown rejects a task without invoking Grok", (t) => {
  const sandbox = makeSandbox(t);
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  writeQuotaCooldown(sandbox.dataDir, {
    setAt: new Date().toISOString(),
    expiresAt,
    jobId: "b".repeat(32),
    message: "HTTP 402 usage balance exhausted"
  });
  const blocked = runTask(sandbox);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /^failure: quota$/m);
  assert.ok(blocked.stderr.includes(expiresAt));
  assert.ok(blocked.stderr.includes("b".repeat(32)));
  assert.match(blocked.stderr, /--clear-quota-cooldown/);
  assert.deepEqual(readInvocations(sandbox.argsFile), []);
  assert.deepEqual(jobRecords(sandbox.dataDir), []);
});

test("active cooldown blocks review and stop gate before invoking Grok", (t) => {
  for (const command of ["review", "stop-gate"]) {
    const sandbox = makeSandbox(t);
    initFixtureRepo(sandbox.workDir);
    writeQuotaCooldown(sandbox.dataDir, {
      setAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      jobId: "c".repeat(32),
      message: "HTTP 402 usage balance exhausted"
    });
    const result = runCompanion([command], {
      cwd: sandbox.workDir,
      env: envFor(sandbox, { CLAUDE_PLUGIN_OPTION_STOP_GATE: "true" }),
      input: command === "stop-gate" ? JSON.stringify({ cwd: sandbox.workDir }) : ""
    });
    if (command === "review") assert.match(result.stderr, /^failure: quota$/m);
    assert.deepEqual(readInvocations(sandbox.argsFile), []);
  }
});

test("quota failure records cooldown and later task fails before Grok launch", (t) => {
  const sandbox = makeSandbox(t);
  const first = runTask(sandbox, { FAKE_GROK_MODE: "quota-json-error", GROK_QUOTA_COOLDOWN_MS: "60000" });
  assert.notEqual(first.status, 0);
  const failed = jobRecords(sandbox.dataDir)[0];
  assert.equal(failed.failureKind, "quota");
  assert.equal(failed.errorMessage, "HTTP 402 Payment Required: usage balance exhausted");
  assert.match(failed.errorTail, /"error"/);
  const cooldown = JSON.parse(fs.readFileSync(cooldownFile(sandbox), "utf8"));
  assert.equal(cooldown.jobId, failed.id);
  assert.equal(cooldown.message, failed.errorMessage);
  assert.equal(Date.parse(cooldown.expiresAt) - Date.parse(cooldown.setAt), 60000);

  const before = readInvocations(sandbox.argsFile).length;
  const second = runTask(sandbox);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /^failure: quota$/m);
  assert.match(second.stderr, new RegExp(failed.id));
  assert.ok(second.stderr.includes(cooldown.expiresAt));
  assert.match(second.stderr, /--clear-quota-cooldown/);
  assert.equal(readInvocations(sandbox.argsFile).length, before);
  assert.equal(JSON.parse(fs.readFileSync(cooldownFile(sandbox), "utf8")).jobId, failed.id);
});

test("multiline internal error reports the JSON message and uses HTTP status for quota cooldown", (t) => {
  const marker = '  if (mode === "quota-json-error") {';
  const source = fs.readFileSync(fakeGrok, "utf8");
  assert.ok(source.includes(marker));
  for (const message of [
    "API error (status 402 Payment Required): Grok Build usage balance exhausted",
    "Grok Build plan disabled"
  ]) {
    const sandbox = makeSandbox(t);
    const bin = path.join(sandbox.root, "multiline-grok");
    fs.writeFileSync(bin, source.replace(marker, `  if (mode === "multiline-quota-error") {
    emit({ type: "error", message: "Internal error: {" });
    process.stderr.write("Error: Internal error: " + JSON.stringify({ message: process.env.FAKE_GROK_QUOTA_MESSAGE, http_status: 402 }, null, 2) + "\\n");
    process.exit(1);
  }

${marker}`), { mode: 0o700 });
    const result = runTask(sandbox, { GROK_BIN: bin, FAKE_GROK_MODE: "multiline-quota-error", FAKE_GROK_QUOTA_MESSAGE: message });
    assert.notEqual(result.status, 0);
    const [failed] = jobRecords(sandbox.dataDir);
    assert.equal(failed.failureKind, "quota");
    assert.equal(failed.errorMessage, message);
    assert.match(failed.errorTail, /HTTP 402/);
    assert.equal(JSON.parse(fs.readFileSync(cooldownFile(sandbox), "utf8")).message, message);
  }
});

test("bare quota diagnostic classifies as quota without opening cooldown", (t) => {
  const sandbox = makeSandbox(t);
  const result = runTask(sandbox, { FAKE_GROK_MODE: "quota-error" });
  assert.notEqual(result.status, 0);
  const failed = jobRecords(sandbox.dataDir)[0];
  assert.equal(failed.failureKind, "quota");
  assert.match(failed.errorTail, /quota exceeded/);
  assert.equal(fs.existsSync(cooldownFile(sandbox)), false);
});

test("setup reports and clears cooldown", (t) => {
  const sandbox = makeSandbox(t);
  writeQuotaCooldown(sandbox.dataDir, {
    setAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    jobId: "a".repeat(32),
    message: "HTTP 402 usage balance exhausted"
  });
  const active = runCompanion(["setup", "--json"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  const report = JSON.parse(active.stdout);
  assert.equal(report.ready, false);
  assert.equal(report.quotaCooldown.jobId, "a".repeat(32));
  assert.match(report.nextSteps.join(" "), /--clear-quota-cooldown/);
  const rendered = runCompanion(["setup"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.match(rendered.stdout, /quota cooldown is active until/);
  const disabled = runCompanion(["setup", "--json"], {
    cwd: sandbox.workDir, env: envFor(sandbox, { GROK_QUOTA_COOLDOWN_MS: "0" })
  });
  assert.equal(JSON.parse(disabled.stdout).quotaCooldown, null);
  assert.equal(fs.existsSync(cooldownFile(sandbox)), true);
  const cleared = runCompanion(["setup", "--clear-quota-cooldown", "--json"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(JSON.parse(cleared.stdout).quotaCooldown, null);
  assert.equal(fs.existsSync(cooldownFile(sandbox)), false);
});

test("recovered JSON error messages are capped at 500 characters", (t) => {
  const sandbox = makeSandbox(t);
  const longMessage = `HTTP 402 Payment Required: ${"x".repeat(600)}`;
  runTask(sandbox, { FAKE_GROK_MODE: "quota-json-error", FAKE_GROK_QUOTA_MESSAGE: longMessage });
  const failed = jobRecords(sandbox.dataDir)[0];
  assert.equal(failed.failureKind, "quota");
  assert.equal(failed.errorMessage, longMessage.slice(0, 500));
  assert.equal(JSON.parse(fs.readFileSync(cooldownFile(sandbox), "utf8")).message, longMessage.slice(0, 500));
});

test("disabled and expired cooldowns allow launches", (t) => {
  const disabled = makeSandbox(t);
  runTask(disabled, { FAKE_GROK_MODE: "http-402-error", GROK_QUOTA_COOLDOWN_MS: "0" });
  assert.equal(fs.existsSync(cooldownFile(disabled)), false);
  assert.equal(runTask(disabled, { GROK_QUOTA_COOLDOWN_MS: "0" }).status, 0);

  const expired = makeSandbox(t);
  runTask(expired, { FAKE_GROK_MODE: "http-402-error" });
  const value = JSON.parse(fs.readFileSync(cooldownFile(expired), "utf8"));
  value.expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(cooldownFile(expired), JSON.stringify(value));
  assert.equal(runTask(expired).status, 0);
  assert.equal(fs.existsSync(cooldownFile(expired)), false);
});

test("review and stop gate quota failures set the shared cooldown", (t) => {
  const review = makeSandbox(t);
  initFixtureRepo(review.workDir);
  const failedReview = runTask(review, { FAKE_GROK_MODE: "http-402-error" }, ["review"]);
  assert.notEqual(failedReview.status, 0);
  assert.equal(jobRecords(review.dataDir)[0].failureKind, "quota");
  assert.equal(JSON.parse(fs.readFileSync(cooldownFile(review), "utf8")).jobId, jobRecords(review.dataDir)[0].id);
  const reviewInvocations = readInvocations(review.argsFile).length;
  const blockedReview = runTask(review, {}, ["review"]);
  assert.match(blockedReview.stderr, /^failure: quota$/m);
  assert.equal(readInvocations(review.argsFile).length, reviewInvocations);

  const stop = makeSandbox(t);
  initFixtureRepo(stop.workDir);
  const gate = runCompanion(["stop-gate"], {
    cwd: stop.workDir,
    env: envFor(stop, { FAKE_GROK_MODE: "http-402-error", CLAUDE_PLUGIN_OPTION_STOP_GATE: "true" }),
    input: JSON.stringify({ cwd: stop.workDir })
  });
  assert.equal(gate.status, 0, gate.stderr);
  assert.equal(jobRecords(stop.dataDir)[0]?.failureKind, "quota");
  assert.equal(JSON.parse(fs.readFileSync(cooldownFile(stop), "utf8")).jobId, jobRecords(stop.dataDir)[0].id);
  const stopInvocations = readInvocations(stop.argsFile).length;
  const blockedGate = runCompanion(["stop-gate"], {
    cwd: stop.workDir,
    env: envFor(stop, { CLAUDE_PLUGIN_OPTION_STOP_GATE: "true" }),
    input: JSON.stringify({ cwd: stop.workDir })
  });
  assert.equal(blockedGate.status, 0, blockedGate.stderr);
  assert.equal(readInvocations(stop.argsFile).length, stopInvocations);
});

test("unparseable versions fail managed runs closed", (t) => {
  const bad = makeSandbox(t);
  const failed = runTask(bad, { FAKE_GROK_MODE: "unparseable-version" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Could not parse grok --version output/);
  assert.equal(jobRecords(bad.dataDir)[0].failureKind, "setup");
  assert.deepEqual(readInvocations(bad.argsFile), [["--version"]]);
});

test("setup rejects unparseable versions and warns on newer ready builds", (t) => {
  const bad = makeSandbox(t);
  const badSetup = JSON.parse(runCompanion(["setup", "--json"], {
    cwd: bad.workDir, env: envFor(bad, { FAKE_GROK_MODE: "unparseable-version" })
  }).stdout);
  assert.equal(badSetup.ready, false);

  const newer = makeSandbox(t);
  const setup = runCompanion(["setup", "--json"], {
    cwd: newer.workDir, env: envFor(newer, { FAKE_GROK_VERSION_OUTPUT: "grok 1.0.42" })
  });
  assert.equal(setup.status, 0, setup.stderr);
  const report = JSON.parse(setup.stdout);
  assert.equal(report.ready, true);
  assert.match(report.nextSteps.join(" "), /run a verification pass/);
});

test("newer builds execute managed tasks", (t) => {
  const newer = makeSandbox(t);
  assert.equal(runTask(newer, { FAKE_GROK_VERSION_OUTPUT: "grok 1.0.42" }).status, 0);
});
