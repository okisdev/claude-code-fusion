import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { killGroups, pidAlive, waitFor } from "./lib/companion-harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companion = path.join(root, "plugins/cursor/scripts/cursor-companion.mjs");
const hook = path.join(root, "plugins/cursor/scripts/session-end-hook.mjs");
const fake = path.join(root, "tests/fake-cursor");
const stateModule = new URL("../plugins/cursor/scripts/lib/engine-state.mjs", import.meta.url);

function harness(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-session-end-test-"));
  const cwd = path.join(temp, "workspace");
  const data = path.join(temp, "data");
  const home = path.join(temp, "home");
  const identityBin = path.join(temp, "identity-bin");
  const execMarker = path.join(temp, "cursor-started");
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
  fs.mkdirSync(identityBin);
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, "fake-cursor-config.json"), JSON.stringify({ scenario: "hang", execMarker }));
  if (["darwin", "freebsd", "openbsd"].includes(process.platform)) {
    fs.writeFileSync(path.join(identityBin, "ps"), "#!/bin/sh\npid=\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = \"-p\" ]; then pid=\"$2\"; shift 2; else shift; fi\ndone\nprintf 'process-%s\\n' \"$pid\"\n");
    fs.writeFileSync(path.join(identityBin, "sysctl"), "#!/bin/sh\nprintf '{ sec = 1, usec = 0 }\\n'\n");
    for (const name of ["ps", "sysctl"]) fs.chmodSync(path.join(identityBin, name), 0o755);
  }
  const env = { ...process.env, TMPDIR: temp, HOME: home, PATH: `${identityBin}${path.delimiter}${process.env.PATH}`, CURSOR_AGENT_BIN: fake, CURSOR_COMPANION_DATA: data };
  const run = (args, sessionId, input = "") => spawnSync(process.execPath, [companion, ...args], {
    cwd, env: { ...env, CLAUDE_CODE_SESSION_ID: sessionId }, input, encoding: "utf8", timeout: 30000
  });
  const end = (sessionId) => spawnSync(process.execPath, [hook], {
    cwd, env, input: JSON.stringify({ session_id: sessionId }), encoding: "utf8", timeout: 30000
  });
  const pids = new Set();
  const jobs = () => {
    const state = path.join(data, "state");
    if (!fs.existsSync(state)) return [];
    const records = fs.readdirSync(state).flatMap((workspace) => {
      const dir = path.join(state, workspace, "jobs");
      return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
    });
    for (const { pid, cursorPid } of records) {
      if (pid) pids.add(pid);
      if (cursorPid) pids.add(cursorPid);
    }
    return records;
  };
  t.after(async () => {
    try {
      for (const job of jobs()) {
        if (job.status !== "running") continue;
        killGroups(job.pid);
        killGroups(job.cursorPid);
      }
      await waitFor(() => [...pids].every((pid) => !pidAlive(pid)));
    } finally {
      await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  });
  return { cwd, env, run, end, execMarker, jobs };
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
  const running = await waitFor(() => {
    const jobs = h.jobs();
    return jobs.length === 2 && jobs.every((job) => job.cursorPid && job.cursorPidIdentity && job.pidIdentity) && jobs;
  }, 10000);
  assert.equal(running.length, 2);
  assert.ok(running.every((job) => job.cursorPidIdentity && job.pidIdentity));
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
  const job = await waitFor(() => {
    const [job] = h.jobs();
    return job?.cursorPid && job.cursorPidIdentity && job.pidIdentity &&
      fs.existsSync(h.execMarker) && Number(fs.readFileSync(h.execMarker, "utf8")) === job.cursorPid && job;
  }, 10000);
  assert.ok(job.cursorPid);
  const stripIdentity = `import state from ${JSON.stringify(stateModule.href)};
const file = state.jobFilePath(state.resolveDataDir(), process.cwd(), process.argv[1]);
state.updateJobRecordFile(file, { pidIdentity: null });`;
  const patched = spawnSync(process.execPath, ["--input-type=module", "-e", stripIdentity, job.id], {
    cwd: h.cwd, env: h.env, encoding: "utf8", timeout: 30000
  });
  assert.equal(patched.status, 0, patched.stderr);
  const result = h.end("session-a");
  assert.equal(result.status, 0, result.stderr);
  const after = h.jobs()[0];
  assert.equal(after.status, "running");
  assert.equal(after.cleanupRequired, true);
  assert.equal(after.failureKind, "cancelled");
  assert.equal(after.pid, job.pid);
  assert.equal(after.cursorPid, job.cursorPid);
  assert.equal(after.pidIdentity, null);
});
