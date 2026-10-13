import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const runner = path.join(repoRoot, "bench", "lanes", "run.mjs");
const summarizer = path.join(repoRoot, "bench", "lanes", "summarize.mjs");
const fixtureRoot = path.join(import.meta.dirname, "fixtures", "bench-lanes");
const companion = path.join(fixtureRoot, "fake-companion.mjs");

function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bench-lanes-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bins = path.join(root, "bins");
  fs.mkdirSync(bins);
  for (const name of ["codex", "grok", "cursor"]) {
    const file = path.join(bins, name);
    fs.writeFileSync(file, "#!/usr/bin/env bash\nprintf '%s\\n' 'fake version'\n");
    fs.chmodSync(file, 0o755);
  }
  return {
    root,
    taskRoot: path.join(fixtureRoot, "tasks"),
    results: path.join(root, "results"),
    env: {
      ...process.env,
      PATH: `${bins}${path.delimiter}${process.env.PATH}`,
      FUSION_CODEX_COMPANION: companion,
      FUSION_GROK_COMPANION: companion,
      FUSION_CURSOR_COMPANION: companion,
      CODEX_COMPANION_DATA: path.join(root, "codex-data"),
      GROK_COMPANION_DATA: path.join(root, "grok-data"),
      CURSOR_COMPANION_DATA: path.join(root, "cursor-data"),
      FAKE_VERIFY_LOG: path.join(root, "verify.log"),
      FAKE_VERIFY_FAIL: "0",
      FAKE_ARGS_FILE: path.join(root, "args.json"),
      FAKE_PID_FILE: path.join(root, "pid")
    }
  };
}

function run(s, { engine = "codex", mode = "write", fakeMode = "pass", extra = [], env = {} } = {}) {
  const args = [runner, "--task", "T01-test", "--engine", engine, "--mode", mode, "--repetition", "1", "--results", s.results, "--task-root", s.taskRoot, "--model", "requested-model", "--effort", "xhigh", ...(mode === "consult" ? ["--brief", path.join(s.taskRoot, "T01-test", "brief.md")] : []), ...extra];
  return spawnSync(process.execPath, args, { cwd: repoRoot, env: { ...s.env, FAKE_ENGINE: engine, FAKE_MODE: fakeMode, ...env }, encoding: "utf8", timeout: 30000 });
}

function records(s) {
  return fs.readFileSync(path.join(s.results, "runs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("write pass records a staged diff and requested lane", (t) => {
  const s = sandbox(t);
  const result = run(s);
  assert.equal(result.status, 0, result.stderr);
  const [record] = records(s);
  assert.deepEqual(Object.keys(record), ["schema", "runId", "taskId", "mode", "engine", "model", "effort", "repetition", "startedAt", "finishedAt", "wallClockSeconds", "companionPath", "companionExit", "jobId", "jobState", "failureKind", "resolvedModel", "resolvedEffort", "billingPool", "cliVersion", "usage", "totalCostUsd", "verifyExit", "verdict", "infrastructureFailure", "resultFile", "diffFile", "taskManifestHash"]);
  assert.equal(record.verdict, "pass");
  assert.equal(record.verifyExit, 0);
  assert.equal(record.model, "requested-model");
  assert.equal(record.resolvedModel, "observed-model");
  assert.equal(record.cliVersion, "1.2.3");
  assert.match(fs.readFileSync(record.diffFile, "utf8"), /\+fake companion completed/);
  const invocation = JSON.parse(fs.readFileSync(s.env.FAKE_ARGS_FILE, "utf8"));
  assert.equal(invocation.cwd, invocation.args[invocation.args.indexOf("--cwd") + 1]);
  assert.deepEqual(invocation.args.slice(0, 8), ["task", "--write", "--json", "--model", "requested-model", "--effort", "xhigh", "--cwd"]);
  assert.equal(invocation.args.at(-1), "Edit the marker file.\n");
  assert.equal(fs.existsSync(invocation.cwd), false);
});

test("write verifier failure is a scored fail", (t) => {
  const s = sandbox(t);
  const result = run(s, { env: { FAKE_VERIFY_FAIL: "1" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(records(s)[0].verdict, "fail");
  assert.equal(records(s)[0].verifyExit, 10);
});

test("engine failure with a job record is scored, not infrastructure failure", (t) => {
  const s = sandbox(t);
  const result = run(s, { fakeMode: "quota" });
  assert.equal(result.status, 0, result.stderr);
  const [record] = records(s);
  assert.equal(record.verdict, "fail");
  assert.equal(record.failureKind, "quota");
  assert.equal(record.infrastructureFailure, null);
  assert.equal(record.companionExit, 1);
  assert.equal(record.verifyExit, 9);
});

test("companion error output still uses its workspace job record", (t) => {
  const s = sandbox(t);
  const result = run(s, { engine: "grok", fakeMode: "stderr-error" });
  assert.equal(result.status, 0, result.stderr);
  const [record] = records(s);
  assert.equal(record.verdict, "fail");
  assert.equal(record.failureKind, "quota");
  assert.equal(record.infrastructureFailure, null);
  assert.equal(record.jobId, "a".repeat(32));
});

test("consult saves the result and skips verification", (t) => {
  const s = sandbox(t);
  const result = run(s, { engine: "grok", mode: "consult" });
  assert.equal(result.status, 0, result.stderr);
  const [record] = records(s);
  assert.equal(record.verdict, "unscored");
  assert.equal(record.verifyExit, null);
  assert.equal(record.diffFile, null);
  assert.equal(fs.readFileSync(record.resultFile, "utf8"), "consult result\n");
  assert.equal(fs.existsSync(s.env.FAKE_VERIFY_LOG), false);
});

test("Cursor consult reads its job id and preserves engine failure", (t) => {
  const s = sandbox(t);
  const result = run(s, { engine: "cursor", mode: "consult", fakeMode: "quota" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(records(s)[0].verdict, "unscored");
  assert.equal(records(s)[0].failureKind, "quota");
});

test("unparseable stdout appends an infrastructure failure", (t) => {
  const s = sandbox(t);
  const result = run(s, { fakeMode: "nojson" });
  assert.equal(result.status, 0, result.stderr);
  const [record] = records(s);
  assert.equal(record.verdict, "infra_failure");
  assert.equal(record.infrastructureFailure.type, "job_id");
  assert.equal(record.jobId, null);
});

test("missing job record appends an infrastructure failure", (t) => {
  const s = sandbox(t);
  const result = run(s, { fakeMode: "missing-record" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(records(s)[0].infrastructureFailure.type, "job_record");
});

test("timeout kills the companion process group and records infra failure", (t) => {
  const s = sandbox(t);
  const result = run(s, { fakeMode: "timeout", extra: ["--timeout-ms", "300"] });
  assert.equal(result.status, 0, result.stderr);
  const [record] = records(s);
  assert.equal(record.infrastructureFailure.type, "timeout");
  assert.equal(record.verdict, "infra_failure");
  assert.equal(record.companionExit, null);
  const pid = Number(fs.readFileSync(s.env.FAKE_PID_FILE, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("usage errors exit 2 without writing a record", (t) => {
  const s = sandbox(t);
  for (const extra of [["--bogus", "x"], ["--model"], ["--repetition", "0"], ["--engine", "other"], ["--mode", "other"]]) {
    const args = [runner, "--task", "T01-test", "--engine", "codex", "--mode", "write", "--repetition", "1", "--results", s.results, ...extra];
    const result = spawnSync(process.execPath, args, { cwd: repoRoot, env: s.env, encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Usage:/);
  }
  const consult = run(s, { mode: "consult", extra: ["--brief"] });
  assert.equal(consult.status, 2);
  assert.equal(fs.existsSync(path.join(s.results, "runs.jsonl")), false);
});

test("env.json is written once", (t) => {
  const s = sandbox(t);
  assert.equal(run(s).status, 0);
  const file = path.join(s.results, "env.json");
  const initial = fs.readFileSync(file, "utf8");
  const env = JSON.parse(initial);
  assert.equal(env.engineCliVersions.codex, "fake version");
  assert.equal(env.pluginVersions.cursor, JSON.parse(fs.readFileSync(path.join(repoRoot, "plugins", "cursor", ".claude-plugin", "plugin.json"), "utf8")).version);
  assert.equal(env.os.platform, process.platform);
  assert.equal(env.taskManifestHash, records(s)[0].taskManifestHash);
  assert.equal(run(s, { engine: "grok", mode: "consult" }).status, 0);
  assert.equal(fs.readFileSync(file, "utf8"), initial);
  assert.equal(records(s).length, 2);
});

test("summarizer groups records and normalizes token shapes", (t) => {
  const s = sandbox(t);
  assert.equal(run(s).status, 0);
  assert.equal(run(s, { fakeMode: "quota" }).status, 0);
  assert.equal(run(s, { engine: "grok", mode: "consult" }).status, 0);
  const json = spawnSync(process.execPath, [summarizer, "--results", s.results, "--json"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  const rows = JSON.parse(json.stdout);
  assert.equal(rows.length, 2);
  const codex = rows.find((row) => row.engine === "codex");
  assert.equal(codex.runs, 2);
  assert.equal(codex.pass, 1);
  assert.equal(codex.fail, 1);
  assert.equal(codex.medianInputTokens, 10);
  assert.equal(codex.failureKinds, "quota:1");
  const grok = rows.find((row) => row.engine === "grok");
  assert.equal(grok.medianInputTokens, 12);
  assert.equal(grok.medianOutputTokens, 8);
  const table = spawnSync(process.execPath, [summarizer, "--results", s.results], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /median wall clock seconds/);
  assert.match(table.stdout, /quota:1/);
});
