import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { cursorChatDir } from "../plugins/cursor/scripts/lib/cursor-home.mjs";
import { claimResumeSessionLease, createJobRecord, createJobRecordFile, jobFilePath, listJobRecords, runHomeDir } from "../plugins/cursor/scripts/lib/state.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companion = path.join(root, "plugins/cursor/scripts/cursor-companion.mjs");
const fake = path.join(root, "tests/fake-cursor");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugins/cursor/.claude-plugin/plugin.json"), "utf8"));
const sessionId = "11111111-2222-4333-8444-555555555555";
const identityBin = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-preflight-identity-"));
if (["darwin", "freebsd", "openbsd"].includes(process.platform)) {
  fs.writeFileSync(path.join(identityBin, "ps"), '#!/bin/sh\npid=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-p" ]; then pid="$2"; shift 2; else shift; fi\ndone\nprintf "process-%s\\n" "$pid"\n');
  fs.writeFileSync(path.join(identityBin, "sysctl"), '#!/bin/sh\nprintf "{ sec = 1, usec = 0 }\\n"\n');
  fs.writeFileSync(path.join(identityBin, "uptime"), '#!/bin/sh\nprintf "2020-01-01 00:00:00\\n"\n');
  for (const command of ["ps", "sysctl", "uptime"]) fs.chmodSync(path.join(identityBin, command), 0o755);
  process.env.PATH = `${identityBin}${path.delimiter}${process.env.PATH}`;
}
test.after(() => fs.rmSync(identityBin, { recursive: true, force: true }));

function fixture(t, { helper = true, scenario = "success" } = {}) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cursor-preflight-")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const binDir = path.join(temp, "bin");
  const cwd = path.join(temp, "workspace");
  const home = path.join(temp, "real-home");
  const data = path.join(temp, "data");
  for (const dir of [binDir, cwd, home, data]) fs.mkdirSync(dir);
  const bin = path.join(binDir, "cursor-agent");
  fs.copyFileSync(fake, bin);
  fs.chmodSync(bin, 0o755);
  if (helper) {
    const helperPath = path.join(binDir, "cursorsandbox");
    fs.copyFileSync(path.join(root, "tests/cursorsandbox"), helperPath);
    fs.chmodSync(helperPath, 0o755);
  }
  fs.writeFileSync(path.join(data, "fake-cursor-config.json"), JSON.stringify({ scenario }));
  const env = { ...process.env, HOME: home, CURSOR_AGENT_BIN: bin, CURSOR_COMPANION_DATA: data };
  const run = (args) => spawnSync(process.execPath, [companion, ...args], { cwd, env, encoding: "utf8", timeout: 30000 });
  const jobs = () => {
    const state = path.join(data, "state");
    if (!fs.existsSync(state)) return [];
    return fs.readdirSync(state).flatMap((workspace) => {
      const dir = path.join(state, workspace, "jobs");
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))) : [];
    });
  };
  return { temp, cwd, data, run, jobs };
}

function reviewChanges(h) {
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: h.cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q");
  git("config", "user.email", "cursor-test@example.invalid");
  git("config", "user.name", "Cursor Test");
  fs.writeFileSync(path.join(h.cwd, "sample.txt"), "before\n");
  git("add", "sample.txt");
  git("commit", "-qm", "baseline");
  fs.writeFileSync(path.join(h.cwd, "sample.txt"), "after\n");
}

test("R1 task and review reject a missing sandbox helper before making a job or home", (t) => {
  const h = fixture(t, { helper: false });
  reviewChanges(h);
  const setup = JSON.parse(h.run(["setup", "--json"]).stdout);
  assert.equal(setup.sandboxHelper.present, false);
  assert.match(setup.nextSteps.join(" "), /cursorsandbox/);
  for (const args of [["task", "--model", "composer-2.5", "--", "inspect"], ["review", "--scope", "working-tree", "--model", "composer-2.5"]]) {
    const result = h.run(args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /cursorsandbox|sandbox helper/i);
    assert.match(result.stderr, /\/cursor:setup/);
    assert.match(result.stderr, /failure: sandbox/);
  }
  assert.deepEqual(h.jobs(), []);
  assert.equal(fs.existsSync(path.join(h.data, "runs")), false);
});

test("R2 a live resume claim rejects contention without creating a job or home", (t) => {
  const h = fixture(t);
  const sourceId = "a".repeat(32);
  const sourceHome = runHomeDir(h.data, sourceId);
  const source = createJobRecord({ id: sourceId, cwd: h.cwd, mode: "consult", jobClass: "task", status: "done", sessionId, homeDir: sourceHome });
  createJobRecordFile(jobFilePath(h.data, h.cwd, sourceId), source);
  fs.mkdirSync(cursorChatDir(sourceHome, h.cwd, sessionId), { recursive: true });
  assert.equal(listJobRecords(h.data, h.cwd)[0]?.sessionId, sessionId);
  claimResumeSessionLease(h.data, h.cwd, sessionId, "b".repeat(32), { preflight: true });
  const result = h.run(["task", "--model", "composer-2.5", "--resume", sessionId, "--", "continue"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /already being resumed/);
  assert.match(result.stderr, /failure: resource/);
  assert.deepEqual(h.jobs().map((job) => job.id), [sourceId]);
  assert.deepEqual(fs.readdirSync(path.join(h.data, "runs")), [sourceId]);
});

test("R3 task and review stamp the plugin manifest version", (t) => {
  const h = fixture(t, { scenario: "review_ok" });
  reviewChanges(h);
  const task = h.run(["task", "--model", "composer-2.5", "--", "inspect"]);
  const review = h.run(["review", "--scope", "working-tree", "--model", "composer-2.5"]);
  for (const result of [task, review]) assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(h.jobs().length, 2);
  for (const job of h.jobs()) {
    assert.equal(job.companionVersion, manifest.version);
    assert.equal(job.observedModel, "Composer 2.5");
    assert.equal(job.modelDrift, null);
  }
});

test("R4 records the stream variant and warns once when it differs from the catalog", (t) => {
  const h = fixture(t, { scenario: "model_drift" });
  const result = h.run(["task", "--model", "muse-spark-1.3-high", "--json", "--", "inspect"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [record] = h.jobs();
  const expected = { requested: "muse-spark-1.3-high", observed: "Muse Spark 1.3 300K" };
  assert.equal(record.resolvedModel, expected.requested);
  assert.equal(record.observedModel, expected.observed);
  assert.deepEqual(record.modelDrift, expected);
  assert.deepEqual(JSON.parse(result.stdout).modelDrift, expected);
  assert.deepEqual(record.warnings, [`model drift: requested ${expected.requested}, observed ${expected.observed}`]);
  const shown = h.run(["result", record.id]);
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  assert.match(shown.stdout, /warning: model drift: requested muse-spark-1\.3-high, observed Muse Spark 1\.3 300K\n/);
});
