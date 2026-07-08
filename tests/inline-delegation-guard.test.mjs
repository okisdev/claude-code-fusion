import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "plugins", "fusion", "scripts", "inline-delegation-guard.mjs");

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inline-guard-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const workDir = path.join(root, "work");
  fs.mkdirSync(workDir, { recursive: true });
  return { root, stateDir, workDir };
}

function envFor(sandbox, extra = {}) {
  return {
    ...process.env,
    FUSION_INLINE_GUARD_STATE: sandbox.stateDir,
    ...extra
  };
}

function run(sandbox, payload, extraEnv = {}) {
  return spawnSync(process.execPath, [script], {
    input: payload === undefined ? "" : JSON.stringify(payload),
    env: envFor(sandbox, extraEnv),
    encoding: "utf8"
  });
}

function writePayload(sandbox, { sessionId = "session-1", toolName = "Edit", filePath, cwd, agentId } = {}) {
  const targetPath = filePath ?? path.join(sandbox.workDir, "file.txt");
  const payload = {
    session_id: sessionId,
    transcript_path: path.join(sandbox.root, "transcript.jsonl"),
    cwd: cwd ?? sandbox.workDir,
    tool_name: toolName,
    tool_input: { file_path: targetPath }
  };
  if (agentId) {
    payload.agent_id = agentId;
    payload.agent_type = "Explore";
  }
  return payload;
}

function stateFileFor(sandbox, sessionId) {
  return path.join(sandbox.stateDir, `${sessionId}.json`);
}

test("writes below the budget are allowed silently", (t) => {
  const sandbox = makeSandbox(t);
  for (let i = 0; i < 5; i += 1) {
    const result = run(sandbox, writePayload(sandbox));
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
  }
  const state = JSON.parse(fs.readFileSync(stateFileFor(sandbox, "session-1"), "utf8"));
  assert.strictEqual(state.count, 5);
});

test("the sixth write under the default budget is denied with the routing checkpoint reason", (t) => {
  const sandbox = makeSandbox(t);
  for (let i = 0; i < 5; i += 1) {
    run(sandbox, writePayload(sandbox));
  }
  const result = run(sandbox, writePayload(sandbox));
  assert.strictEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.strictEqual(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /fusion routing checkpoint: the inline write budget/);
  assert.match(
    output.hookSpecificOutput.permissionDecisionReason,
    new RegExp(`node ${script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} allow session-1`)
  );
});

test("an Agent dispatch resets the write counter to zero", (t) => {
  const sandbox = makeSandbox(t);
  for (let i = 0; i < 5; i += 1) {
    run(sandbox, writePayload(sandbox));
  }
  const resetResult = run(sandbox, {
    session_id: "session-1",
    transcript_path: path.join(sandbox.root, "transcript.jsonl"),
    cwd: sandbox.workDir,
    tool_name: "Agent",
    tool_input: {}
  });
  assert.strictEqual(resetResult.status, 0);
  assert.strictEqual(resetResult.stdout, "");
  const state = JSON.parse(fs.readFileSync(stateFileFor(sandbox, "session-1"), "utf8"));
  assert.strictEqual(state.count, 0);
  assert.strictEqual(state.lastResetReason, "delegation-dispatched");

  const nextWrite = run(sandbox, writePayload(sandbox));
  assert.strictEqual(nextWrite.stdout, "");
});

test("a Skill invocation does not reset the write counter", (t) => {
  const sandbox = makeSandbox(t);
  for (let i = 0; i < 5; i += 1) {
    run(sandbox, writePayload(sandbox));
  }
  const skillResult = run(sandbox, {
    session_id: "session-1",
    transcript_path: path.join(sandbox.root, "transcript.jsonl"),
    cwd: sandbox.workDir,
    tool_name: "Skill",
    tool_input: {}
  });
  assert.strictEqual(skillResult.status, 0);
  assert.strictEqual(skillResult.stdout, "");
  const state = JSON.parse(fs.readFileSync(stateFileFor(sandbox, "session-1"), "utf8"));
  assert.strictEqual(state.count, 5);

  const sixthWrite = run(sandbox, writePayload(sandbox));
  assert.match(JSON.parse(sixthWrite.stdout).hookSpecificOutput.permissionDecisionReason, /routing checkpoint/);
});

test("the allow subcommand resets the counter and prints a confirmation", (t) => {
  const sandbox = makeSandbox(t);
  for (let i = 0; i < 6; i += 1) {
    run(sandbox, writePayload(sandbox));
  }
  const denied = run(sandbox, writePayload(sandbox));
  assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /routing checkpoint/);

  const allowResult = spawnSync(process.execPath, [script, "allow", "session-1"], {
    env: envFor(sandbox),
    encoding: "utf8"
  });
  assert.strictEqual(allowResult.status, 0);
  assert.strictEqual(allowResult.stdout, "fusion inline delegation guard: fresh write budget granted for session session-1\n");
  const state = JSON.parse(fs.readFileSync(stateFileFor(sandbox, "session-1"), "utf8"));
  assert.strictEqual(state.count, 0);
  assert.strictEqual(state.lastResetReason, "manual-allow");

  const nextWrite = run(sandbox, writePayload(sandbox));
  assert.strictEqual(nextWrite.stdout, "");
});

test("a subagent payload fails open and is never counted", (t) => {
  const sandbox = makeSandbox(t);
  for (let i = 0; i < 8; i += 1) {
    const result = run(sandbox, writePayload(sandbox, { agentId: "agent-123" }));
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
  }
  assert.strictEqual(fs.existsSync(stateFileFor(sandbox, "session-1")), false);
});

test("malformed stdin fails open", (t) => {
  const sandbox = makeSandbox(t);
  const result = spawnSync(process.execPath, [script], {
    input: "{ not json",
    env: envFor(sandbox),
    encoding: "utf8"
  });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
});

test("empty stdin fails open", (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, undefined);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
});

test("a write outside the session cwd is not counted", (t) => {
  const sandbox = makeSandbox(t);
  const outsidePath = path.join(sandbox.root, "outside", "file.txt");
  for (let i = 0; i < 8; i += 1) {
    const result = run(sandbox, writePayload(sandbox, { filePath: outsidePath }));
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
  }
  assert.strictEqual(fs.existsSync(stateFileFor(sandbox, "session-1")), false);
});

test("FUSION_INLINE_WRITE_BUDGET overrides the default threshold", (t) => {
  const sandbox = makeSandbox(t);
  const extraEnv = { FUSION_INLINE_WRITE_BUDGET: "2" };
  const first = run(sandbox, writePayload(sandbox), extraEnv);
  const second = run(sandbox, writePayload(sandbox), extraEnv);
  const third = run(sandbox, writePayload(sandbox), extraEnv);
  assert.strictEqual(first.stdout, "");
  assert.strictEqual(second.stdout, "");
  assert.match(JSON.parse(third.stdout).hookSpecificOutput.permissionDecisionReason, /routing checkpoint/);
});

test("a nonsense FUSION_INLINE_WRITE_BUDGET value falls back to the default of 5", (t) => {
  const sandbox = makeSandbox(t);
  const extraEnv = { FUSION_INLINE_WRITE_BUDGET: "not-a-number" };
  for (let i = 0; i < 5; i += 1) {
    const result = run(sandbox, writePayload(sandbox), extraEnv);
    assert.strictEqual(result.stdout, "");
  }
  const sixth = run(sandbox, writePayload(sandbox), extraEnv);
  assert.match(JSON.parse(sixth.stdout).hookSpecificOutput.permissionDecisionReason, /routing checkpoint/);
});

test("stale session state is pruned after 48 hours", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.stateDir, { recursive: true });
  const staleFile = stateFileFor(sandbox, "old-session");
  fs.writeFileSync(staleFile, JSON.stringify({ count: 5, lastResetReason: null, createdAt: "x", updatedAt: "x" }), "utf8");
  const oldTime = new Date(Date.now() - 49 * 60 * 60 * 1000);
  fs.utimesSync(staleFile, oldTime, oldTime);

  run(sandbox, writePayload(sandbox, { sessionId: "session-2" }));
  assert.strictEqual(fs.existsSync(staleFile), false);
});
