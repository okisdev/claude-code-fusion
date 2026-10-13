import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companion = path.join(root, "plugins/cursor/scripts/cursor-companion.mjs");
const hook = path.join(root, "plugins/cursor/scripts/session-end-hook.mjs");
const fake = path.join(root, "tests/fake-cursor");

function harness(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-session-end-test-"));
  const cwd = path.join(temp, "workspace");
  const data = path.join(temp, "data");
  const home = path.join(temp, "home");
  const identityBin = path.join(temp, "identity-bin");
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
  fs.mkdirSync(identityBin);
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, "fake-cursor-config.json"), JSON.stringify({ scenario: "hang" }));
  if (["darwin", "freebsd", "openbsd"].includes(process.platform)) {
    fs.writeFileSync(path.join(identityBin, "ps"), "#!/bin/sh\npid=\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = \"-p\" ]; then pid=\"$2\"; shift 2; else shift; fi\ndone\nprintf 'process-%s\\n' \"$pid\"\n");
    fs.writeFileSync(path.join(identityBin, "sysctl"), "#!/bin/sh\nprintf '{ sec = 1, usec = 0 }\\n'\n");
    for (const name of ["ps", "sysctl"]) fs.chmodSync(path.join(identityBin, name), 0o755);
  }
  const env = { ...process.env, HOME: home, PATH: `${identityBin}${path.delimiter}${process.env.PATH}`, CURSOR_AGENT_BIN: fake, CURSOR_COMPANION_DATA: data };
  const run = (args, sessionId, input = "") => spawnSync(process.execPath, [companion, ...args], {
    cwd, env: { ...env, CLAUDE_CODE_SESSION_ID: sessionId }, input, encoding: "utf8", timeout: 30000
  });
  const end = (sessionId) => spawnSync(process.execPath, [hook], {
    cwd, env, input: JSON.stringify({ session_id: sessionId }), encoding: "utf8", timeout: 30000
  });
  const jobs = () => {
    const state = path.join(data, "state");
    if (!fs.existsSync(state)) return [];
    return fs.readdirSync(state).flatMap((workspace) => {
      const dir = path.join(state, workspace, "jobs");
      return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
    });
  };
  t.after(() => {
    for (const job of jobs()) if (job.status === "running") run(["cancel", job.id], job.claudeSessionId);
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { cwd, env, run, end, jobs };
}

test("session end removes only verified transports from the ending session", (t) => {
  const h = harness(t);
  const ending = JSON.parse(h.run(["transport-create"], "session-a").stdout);
  const other = JSON.parse(h.run(["transport-create"], "session-b").stdout);
  t.after(() => fs.rmSync(path.dirname(other.file), { recursive: true, force: true }));
  fs.writeFileSync(ending.file, "unused");
  fs.writeFileSync(other.file, "other");
  const result = h.end("session-a");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(ending.file), false);
  assert.equal(fs.existsSync(other.file), true);
});

test("session end cancels only its running Cursor job", async (t) => {
  const h = harness(t);
  for (const sessionId of ["session-a", "session-b"]) {
    const launch = spawnSync(process.execPath, [companion, "task", "--model", "composer-2.5", "--background", "--", "hang"], {
      cwd: h.cwd, env: { ...h.env, CLAUDE_CODE_SESSION_ID: sessionId, FAKE_CURSOR_SCENARIO: "hang" }, encoding: "utf8", timeout: 30000
    });
    assert.equal(launch.status, 0, launch.stdout + launch.stderr);
  }
  const deadline = Date.now() + 10000;
  while (h.jobs().some((job) => !job.cursorPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(h.jobs().length, 2);
  assert.ok(h.jobs().every((job) => job.cursorPidIdentity && job.pidIdentity));
  const result = h.end("session-a");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(h.jobs().find((job) => job.claudeSessionId === "session-a").status, "cancelled");
  assert.equal(h.jobs().find((job) => job.claudeSessionId === "session-b").status, "running");
});

test("session end retains unverifiable process evidence for retry", async (t) => {
  const h = harness(t);
  const launch = spawnSync(process.execPath, [companion, "task", "--model", "composer-2.5", "--background", "--", "hang"], {
    cwd: h.cwd, env: { ...h.env, CLAUDE_CODE_SESSION_ID: "session-a", FAKE_CURSOR_SCENARIO: "hang" }, encoding: "utf8", timeout: 30000
  });
  assert.equal(launch.status, 0, launch.stdout + launch.stderr);
  const deadline = Date.now() + 10000;
  while (!h.jobs()[0]?.cursorPid && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  const job = h.jobs()[0];
  assert.ok(job.cursorPid);
  const state = path.join(h.env.CURSOR_COMPANION_DATA, "state");
  const workspace = fs.readdirSync(state)[0];
  const file = path.join(state, workspace, "jobs", `${job.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...job, pidIdentity: null }));
  const result = h.end("session-a");
  assert.equal(result.status, 0, result.stderr);
  const after = h.jobs()[0];
  assert.equal(after.status, "running");
  assert.equal(after.cleanupRequired, true);
  assert.equal(after.failureKind, "cancelled");
  assert.equal(after.pid, job.pid);
  try { process.kill(-job.pid, "SIGKILL"); } catch {}
});
