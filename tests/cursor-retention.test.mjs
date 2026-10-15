import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildPrivateHome, cursorChatDir } from "../plugins/cursor/scripts/lib/cursor-home.mjs";
import { createJobRecord, createJobRecordFile, finishSuccessfulJobRecordFile, jobFilePath, listJobRecords, runHomeDir, sweepCursorHomes, updateJobRecordFile, updateJobRecordFileWithCurrent } from "../plugins/cursor/scripts/lib/state.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companion = path.join(repo, "plugins/cursor/scripts/cursor-companion.mjs");
const hook = path.join(repo, "plugins/cursor/scripts/session-end-hook.mjs");
const fake = path.join(repo, "tests/fake-cursor");
const sessionId = "11111111-2222-4333-8444-555555555555";
const identityBin = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-retention-identity-"));
if (["darwin", "freebsd", "openbsd"].includes(process.platform)) {
  fs.writeFileSync(path.join(identityBin, "ps"), '#!/bin/sh\nprintf "process-%s\\n" "$2"\n');
  fs.writeFileSync(path.join(identityBin, "sysctl"), '#!/bin/sh\nprintf "{ sec = 1, usec = 0 }\\n"\n');
  fs.writeFileSync(path.join(identityBin, "uptime"), '#!/bin/sh\nprintf "2020-01-01 00:00:00\\n"\n');
  for (const command of ["ps", "sysctl", "uptime"]) fs.chmodSync(path.join(identityBin, command), 0o755);
  process.env.PATH = `${identityBin}${path.delimiter}${process.env.PATH}`;
}
test.after(() => fs.rmSync(identityBin, { recursive: true, force: true }));

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cursor-retention-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const cwd = path.join(root, "workspace");
  const realHome = path.join(root, "real-home");
  fs.mkdirSync(data);
  fs.mkdirSync(cwd);
  fs.mkdirSync(realHome);
  const env = { ...process.env, HOME: realHome, CURSOR_COMPANION_DATA: data, CURSOR_AGENT_BIN: fake };
  const run = (script, args = []) => spawnSync(process.execPath, [script, ...args], { cwd, env, input: "{}", encoding: "utf8", timeout: 30000 });
  const jobs = () => {
    const state = path.join(data, "state");
    if (!fs.existsSync(state)) return [];
    return fs.readdirSync(state).flatMap((workspace) => {
      const dir = path.join(state, workspace, "jobs");
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))) : [];
    });
  };
  return { root, data, cwd, realHome, env, run, jobs };
}

function recordFixture(h, id, status = "running") {
  const homeDir = runHomeDir(h.data, id);
  const record = createJobRecord({ id, mode: "consult", cwd: h.cwd, homeDir, jobClass: "task", status });
  const file = jobFilePath(h.data, h.cwd, id);
  createJobRecordFile(file, record);
  return { file, homeDir };
}

test("done, error, and cancelled jobs retain only their own chat", (t) => {
  const h = fixture(t);
  for (const [index, status] of ["done", "error", "cancelled"].entries()) {
    const id = String(index + 1).padStart(32, "0");
    const { file, homeDir } = recordFixture(h, id);
    buildPrivateHome({ homeDir, mode: "consult", cwd: h.cwd, realHome: h.realHome });
    const chat = cursorChatDir(homeDir, h.cwd, sessionId);
    const other = cursorChatDir(homeDir, h.cwd, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    fs.mkdirSync(chat, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(chat, "state.json"), "retained");
    fs.writeFileSync(path.join(other, "state.json"), "removed");
    fs.mkdirSync(path.join(homeDir, ".npm", "cache"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".npm", "cache", "large"), "cache");
    assert.equal(fs.lstatSync(path.join(homeDir, ".npm")).isSymbolicLink(), true);
    fs.writeFileSync(path.join(homeDir, "other"), "other");
    if (status === "done") finishSuccessfulJobRecordFile(file, { status, sessionId });
    if (status === "error") updateJobRecordFile(file, { status, sessionId });
    if (status === "cancelled") updateJobRecordFileWithCurrent(file, (record) => ({ ...record, status, sessionId }));
    assert.equal(fs.readFileSync(path.join(chat, "state.json"), "utf8"), "retained");
    assert.deepEqual(fs.readdirSync(homeDir), [".cursor"]);
    assert.deepEqual(fs.readdirSync(path.join(homeDir, ".cursor")), ["chats"]);
    assert.deepEqual(fs.readdirSync(path.dirname(chat)), [sessionId]);
    assert.equal(fs.readFileSync(path.join(h.data, "npm-cache", "cache", "large"), "utf8"), "cache");
  }
});

test("oversized shared npm cache waits for running jobs and clears at most once per day", (t) => {
  const h = fixture(t);
  const { file, homeDir } = recordFixture(h, "f".repeat(32));
  buildPrivateHome({ homeDir, mode: "consult", cwd: h.cwd, realHome: h.realHome });
  const cache = path.join(h.data, "npm-cache");
  const large = path.join(cache, "large");
  const marker = path.join(h.data, ".cursor-npm-cache-clear.json");
  fs.writeFileSync(large, "");
  fs.truncateSync(large, 256 * 1024 * 1024 + 1);
  const now = Date.now();
  sweepCursorHomes(h.data, now);
  assert.equal(fs.existsSync(large), true);
  assert.equal(fs.existsSync(marker), false);
  updateJobRecordFile(file, { status: "done" });
  sweepCursorHomes(h.data, now + 1000);
  assert.deepEqual(fs.readdirSync(cache), []);
  assert.equal(fs.statSync(cache).mode & 0o777, 0o700);
  assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).clearedAt, now + 1000);
  fs.writeFileSync(large, "");
  fs.truncateSync(large, 256 * 1024 * 1024 + 1);
  sweepCursorHomes(h.data, now + 60 * 60 * 1000);
  assert.equal(fs.existsSync(large), true);
  sweepCursorHomes(h.data, now + 24 * 60 * 60 * 1000 + 1000);
  assert.equal(fs.existsSync(large), false);
});

test("orphan sweep respects age and the ten minute interval", (t) => {
  const h = fixture(t);
  const old = path.join(h.data, "runs", "orphan-old");
  const young = path.join(h.data, "runs", "orphan-young");
  const recorded = recordFixture(h, "b".repeat(32)).homeDir;
  for (const directory of [old, young, path.dirname(recorded)]) fs.mkdirSync(directory, { recursive: true });
  const now = Date.now();
  fs.utimesSync(old, new Date(now - 2 * 3600000), new Date(now - 2 * 3600000));
  fs.utimesSync(path.dirname(recorded), new Date(now - 2 * 3600000), new Date(now - 2 * 3600000));
  assert.equal(sweepCursorHomes(h.data, now), true);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(young), true);
  assert.equal(fs.existsSync(path.dirname(recorded)), true);
  fs.utimesSync(young, new Date(now - 2 * 3600000), new Date(now - 2 * 3600000));
  assert.equal(sweepCursorHomes(h.data, now + 9 * 60000), false);
  assert.equal(fs.existsSync(young), true);
  assert.equal(sweepCursorHomes(h.data, now + 10 * 60000), true);
  assert.equal(fs.existsSync(young), false);
});

test("task start and SessionEnd both trigger the orphan sweep", (t) => {
  for (const trigger of ["task", "hook"]) {
    const h = fixture(t);
    const orphan = path.join(h.data, "runs", `orphan-${trigger}`);
    fs.mkdirSync(orphan, { recursive: true });
    fs.utimesSync(orphan, new Date(Date.now() - 2 * 3600000), new Date(Date.now() - 2 * 3600000));
    const result = trigger === "task" ? h.run(companion, ["task", "--model", "composer-2.5", "--", "inspect"]) : h.run(hook);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(orphan), false);
  }
});

test("old terminal homes are removed and resume reports expired chat before creating a job", (t) => {
  const h = fixture(t);
  const id = "c".repeat(32);
  const { file, homeDir } = recordFixture(h, id);
  const chat = cursorChatDir(homeDir, h.cwd, sessionId);
  fs.mkdirSync(chat, { recursive: true });
  fs.writeFileSync(path.join(chat, "state.json"), "chat");
  finishSuccessfulJobRecordFile(file, { status: "done", sessionId, finishedAt: new Date(Date.now() - 31 * 86400000).toISOString() });
  assert.equal(h.jobs()[0]?.sessionId, sessionId);
  assert.deepEqual(listJobRecords(h.data, h.cwd).map((job) => [job.status, job.jobClass, job.mode, job.sessionId]), [["done", "task", "consult", sessionId]]);
  assert.equal(fs.existsSync(homeDir), false);
  const result = h.run(companion, ["task", "--model", "composer-2.5", "--resume", sessionId, "--", "continue"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no longer retained/);
  assert.match(result.stderr, /failure: input/);
  assert.equal(h.jobs().length, 1);
});

test("sweep removes a home when its existing terminal record ages past 30 days", (t) => {
  const h = fixture(t);
  const id = "e".repeat(32);
  const { file, homeDir } = recordFixture(h, id);
  const chat = cursorChatDir(homeDir, h.cwd, sessionId);
  fs.mkdirSync(chat, { recursive: true });
  finishSuccessfulJobRecordFile(file, { status: "done", sessionId });
  assert.equal(fs.existsSync(chat), true);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...record, finishedAt: new Date(Date.now() - 31 * 86400000).toISOString() }));
  assert.equal(sweepCursorHomes(h.data), true);
  assert.equal(fs.existsSync(homeDir), false);
});

test("private home rebuild accepts the correct keychain link and replaces a wrong one", (t) => {
  const h = fixture(t);
  const keychains = path.join(h.realHome, "Library", "Keychains");
  const homeDir = path.join(h.root, "private");
  fs.mkdirSync(keychains, { recursive: true });
  const args = { homeDir, mode: "consult", cwd: h.cwd, realHome: h.realHome, platform: "darwin" };
  buildPrivateHome(args);
  const link = path.join(homeDir, "Library", "Keychains");
  buildPrivateHome(args);
  assert.equal(fs.readlinkSync(link), keychains);
  fs.unlinkSync(link);
  fs.symlinkSync(path.join(h.root, "wrong"), link);
  buildPrivateHome(args);
  assert.equal(fs.readlinkSync(link), keychains);
});

test("missing parent chat fails before record, lease, or home creation", (t) => {
  const h = fixture(t);
  const id = "d".repeat(32);
  const { file, homeDir } = recordFixture(h, id);
  finishSuccessfulJobRecordFile(file, { status: "done", sessionId });
  assert.equal(h.jobs()[0]?.sessionId, sessionId);
  assert.deepEqual(listJobRecords(h.data, h.cwd).map((job) => [job.status, job.jobClass, job.mode, job.sessionId]), [["done", "task", "consult", sessionId]]);
  const result = h.run(companion, ["task", "--model", "composer-2.5", "--resume", sessionId, "--", "continue"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /failure: input/);
  assert.match(result.stderr, /no longer retained/);
  assert.equal(h.jobs().length, 1);
  assert.equal(fs.existsSync(path.join(h.data, "state", fs.readdirSync(path.join(h.data, "state"))[0], "session-leases")), false);
  assert.equal(fs.existsSync(homeDir), false);
  assert.deepEqual(fs.existsSync(path.join(h.data, "runs")) ? fs.readdirSync(path.join(h.data, "runs")) : [], []);
});
