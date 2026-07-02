import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const companion = path.join(repoRoot, "plugins", "grok", "scripts", "grok-companion.mjs");
const fakeGrok = path.join(import.meta.dirname, "fake-grok");

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-plugin-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const workDir = path.join(root, "work");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workDir);
  return { root, dataDir, workDir, argsFile: path.join(root, "args.jsonl") };
}

function envFor(sandbox, extra = {}) {
  const env = { ...process.env };
  delete env.FAKE_GROK_MODE;
  delete env.FAKE_GROK_ARGS_FILE;
  delete env.GROK_COMPANION_TIMEOUT_MS;
  delete env.CLAUDE_CODE_SESSION_ID;
  return {
    ...env,
    GROK_BIN: fakeGrok,
    GROK_COMPANION_DATA: sandbox.dataDir,
    FAKE_GROK_ARGS_FILE: sandbox.argsFile,
    ...extra,
  };
}

function runCompanion(args, options) {
  return spawnSync(process.execPath, [companion, ...args], {
    cwd: options.cwd,
    env: options.env,
    input: options.input ?? "",
    encoding: "utf8",
    timeout: 60000,
  });
}

function seedJob(sandbox, cwd, args, extraEnv = {}) {
  return runCompanion(["task", ...args], { cwd, env: envFor(sandbox, extraEnv) });
}

test("stats aggregates the workspace jobs as markdown and json", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  assert.strictEqual(seedJob(sandbox, sandbox.workDir, ["first job"]).status, 0);
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
  assert.match(report.stdout, /Mean wall clock for done jobs: \d+(\.\d+)?s/);

  const asJson = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.strictEqual(asJson.status, 0, asJson.stderr);
  const stats = JSON.parse(asJson.stdout);
  assert.strictEqual(stats.scope, "workspace");
  assert.strictEqual(stats.cwd, sandbox.workDir);
  assert.strictEqual(stats.totalJobs, 4);
  assert.deepStrictEqual(stats.byStatus, { done: 2, error: 2 });
  assert.deepStrictEqual(stats.byMode, { consult: 3, write: 1 });
  assert.deepStrictEqual(stats.byFailureKind, { rate_limited: 1, auth: 1 });
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
});
