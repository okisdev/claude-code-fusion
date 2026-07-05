import assert from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { envFor, jobRecords, killGroups, makeSandbox, pidAlive, repoRoot, runCompanion, waitFor } from "./lib/companion-harness.mjs";

const sessionEndHook = path.join(repoRoot, "plugins", "grok", "scripts", "session-end-hook.mjs");

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
