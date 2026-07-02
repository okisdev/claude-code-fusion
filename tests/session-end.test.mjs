import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const companion = path.join(repoRoot, "plugins", "grok", "scripts", "grok-companion.mjs");
const sessionEndHook = path.join(repoRoot, "plugins", "grok", "scripts", "session-end-hook.mjs");
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

function jobRecords(dataDir) {
  const stateDir = path.join(dataDir, "state");
  if (!fs.existsSync(stateDir)) return [];
  const records = [];
  for (const workspace of fs.readdirSync(stateDir)) {
    const jobsDir = path.join(stateDir, workspace, "jobs");
    if (!fs.existsSync(jobsDir)) continue;
    for (const name of fs.readdirSync(jobsDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        records.push(JSON.parse(fs.readFileSync(path.join(jobsDir, name), "utf8")));
      } catch {}
    }
  }
  return records;
}

async function waitFor(fn, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = fn();
    if (value) return value;
    assert.ok(Date.now() < deadline, "Timed out waiting for the expected state.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroups(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

test("session end hook cancels only running jobs owned by the exiting session", async (t) => {
  const sandbox = makeSandbox(t);
  const launchA = runCompanion(["task", "hang for session a", "--background"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "hang", CLAUDE_CODE_SESSION_ID: "session-A" }),
  });
  assert.strictEqual(launchA.status, 0, launchA.stderr);
  const launchB = runCompanion(["task", "hang for session b", "--background"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "hang", CLAUDE_CODE_SESSION_ID: "session-B" }),
  });
  assert.strictEqual(launchB.status, 0, launchB.stderr);
  const bySession = (sessionId) =>
    jobRecords(sandbox.dataDir).find((record) => record.claudeSessionId === sessionId) ?? null;
  const runningA = await waitFor(() => {
    const record = bySession("session-A");
    return record && record.status === "running" && record.pid && record.grokPid ? record : null;
  });
  const runningB = await waitFor(() => {
    const record = bySession("session-B");
    return record && record.status === "running" && record.pid && record.grokPid ? record : null;
  });
  t.after(() => {
    killGroups(runningB.grokPid);
    killGroups(runningB.pid);
    killGroups(runningA.grokPid);
    killGroups(runningA.pid);
  });
  const hook = spawnSync(process.execPath, [sessionEndHook], {
    input: JSON.stringify({ session_id: "session-A" }),
    env: { ...process.env, GROK_COMPANION_DATA: sandbox.dataDir },
    encoding: "utf8",
    timeout: 60000,
  });
  assert.strictEqual(hook.status, 0, hook.stderr);
  const cancelledA = bySession("session-A");
  assert.strictEqual(cancelledA.status, "cancelled");
  assert.strictEqual(cancelledA.pid, null);
  assert.strictEqual(cancelledA.grokPid, null);
  await waitFor(() => (pidAlive(runningA.grokPid) ? null : true));
  await waitFor(() => (pidAlive(runningA.pid) ? null : true));
  const stillB = bySession("session-B");
  assert.strictEqual(stillB.status, "running");
  assert.ok(pidAlive(runningB.grokPid), "Expected the grok process for session B to stay alive.");
  assert.ok(pidAlive(runningB.pid), "Expected the worker for session B to stay alive.");
});
