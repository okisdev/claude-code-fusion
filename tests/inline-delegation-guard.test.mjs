import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
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

async function runAsync(sandbox, payload, extraEnv = {}) {
  const child = spawn(process.execPath, [script], {
    env: envFor(sandbox, extraEnv),
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.stdin.end(JSON.stringify(payload));
  const [status] = await once(child, "close");
  return { status, stdout, stderr };
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

function dispatchPayload(sandbox, { sessionId = "session-1", toolName = "Agent", subagentType, description = "do the thing", agentId } = {}) {
  const payload = {
    session_id: sessionId,
    transcript_path: path.join(sandbox.root, "transcript.jsonl"),
    cwd: sandbox.workDir,
    tool_name: toolName,
    tool_input: { description, prompt: "do the thing" }
  };
  if (subagentType) {
    payload.tool_input.subagent_type = subagentType;
  }
  if (agentId) {
    payload.agent_id = agentId;
    payload.agent_type = "Explore";
  }
  return payload;
}

function stateFileFor(sandbox, sessionId) {
  return path.join(sandbox.stateDir, `${sessionId}.json`);
}

function readState(sandbox, sessionId) {
  return JSON.parse(fs.readFileSync(stateFileFor(sandbox, sessionId), "utf8"));
}

test("writes below the budget are allowed silently and accumulate", (t) => {
  const sandbox = makeSandbox(t);
  for (let i = 0; i < 4; i += 1) {
    const result = run(sandbox, writePayload(sandbox));
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
  }
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.writeCount, 4);
});

test("no call is ever denied, even far past the budget", (t) => {
  const sandbox = makeSandbox(t);
  for (let i = 0; i < 30; i += 1) {
    const result = run(sandbox, writePayload(sandbox));
    assert.strictEqual(result.status, 0);
    if (result.stdout) {
      const output = JSON.parse(result.stdout);
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, "allow");
    }
  }
});

test("the fifth write under the default budget attaches one advisory naming the counts", (t) => {
  const sandbox = makeSandbox(t);
  for (let i = 0; i < 4; i += 1) {
    const result = run(sandbox, writePayload(sandbox));
    assert.strictEqual(result.stdout, "");
  }
  const fifth = run(sandbox, writePayload(sandbox));
  assert.strictEqual(fifth.status, 0);
  const output = JSON.parse(fifth.stdout);
  assert.strictEqual(output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.strictEqual(output.hookSpecificOutput.permissionDecision, "allow");
  assert.strictEqual(
    output.hookSpecificOutput.permissionDecisionReason,
    "5 inline writes happened this session with zero dispatches. The next package belongs in a lane: quick scoped work goes to the codex quick tier gpt-5.6-terra at effort xhigh; trivial or high-volume work goes to gpt-5.6-luna at effort xhigh; work needing the Claude Code tool surface goes to fusion:fast-worker."
  );
});

test("no repeat nagging between threshold multiples, a new advisory fires at 2x and 3x the budget", (t) => {
  const sandbox = makeSandbox(t);
  for (let i = 0; i < 5; i += 1) {
    run(sandbox, writePayload(sandbox));
  }
  for (let i = 0; i < 4; i += 1) {
    const result = run(sandbox, writePayload(sandbox));
    assert.strictEqual(result.stdout, "", `write ${i + 6} should stay silent`);
  }
  const tenth = run(sandbox, writePayload(sandbox));
  const tenthReason = JSON.parse(tenth.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(tenthReason, /^10 inline writes happened this session with zero dispatches/);

  for (let i = 0; i < 4; i += 1) {
    const result = run(sandbox, writePayload(sandbox));
    assert.strictEqual(result.stdout, "", `write ${i + 11} should stay silent`);
  }
  const fifteenth = run(sandbox, writePayload(sandbox));
  const fifteenthReason = JSON.parse(fifteenth.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(fifteenthReason, /^15 inline writes happened this session with zero dispatches/);

  const state = readState(sandbox, "session-1");
  assert.deepStrictEqual(state.advisedMultiples, [1, 2, 3]);
});

test("no advisory fires once the session has recorded any agent dispatch", (t) => {
  const sandbox = makeSandbox(t);
  const dispatchResult = run(sandbox, dispatchPayload(sandbox, { subagentType: "fusion:fast-worker" }));
  assert.strictEqual(dispatchResult.status, 0);
  assert.strictEqual(dispatchResult.stdout, "");

  for (let i = 0; i < 12; i += 1) {
    const result = run(sandbox, writePayload(sandbox));
    assert.strictEqual(result.stdout, "", `write ${i + 1} should stay silent once a dispatch is recorded`);
  }
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.writeCount, 12);
  assert.deepStrictEqual(state.advisedMultiples, []);
});

test("agent dispatches are bucketed by lane from the subagent_type prefix", (t) => {
  const sandbox = makeSandbox(t);
  run(sandbox, dispatchPayload(sandbox, { subagentType: "grok:grok-rescue" }));
  run(sandbox, dispatchPayload(sandbox, { subagentType: "grok:grok-rescue" }));
  run(sandbox, dispatchPayload(sandbox, { subagentType: "codex:codex-rescue" }));
  run(sandbox, dispatchPayload(sandbox, { subagentType: "fusion:fast-worker" }));
  run(sandbox, dispatchPayload(sandbox, { subagentType: "fusion:trivial-worker" }));
  run(sandbox, dispatchPayload(sandbox, { subagentType: "Explore" }));
  run(sandbox, dispatchPayload(sandbox, {}));

  const state = readState(sandbox, "session-1");
  assert.deepStrictEqual(state.dispatches, {
    grok: 2,
    codex: 1,
    "fusion:fast-worker": 1,
    "fusion:trivial-worker": 1,
    builtin: 2
  });
});

test("a Task dispatch is bucketed the same way as an Agent dispatch", (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, dispatchPayload(sandbox, { toolName: "Task", subagentType: "codex:codex-rescue" }));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  const state = readState(sandbox, "session-1");
  assert.deepStrictEqual(state.dispatches, { codex: 1 });
});

test("Agent and Task dispatches append ledger entries with their computed lane", (t) => {
  const sandbox = makeSandbox(t);
  run(sandbox, dispatchPayload(sandbox, { subagentType: "grok:grok-rescue", description: "inspect the failure" }));
  run(sandbox, dispatchPayload(sandbox, { toolName: "Task", subagentType: "codex:codex-rescue", description: "implement the repair" }));

  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.dispatchLog.length, 2);
  assert.match(state.dispatchLog[0].at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepStrictEqual(state.dispatchLog[0], {
    at: state.dispatchLog[0].at,
    lane: "grok",
    subagentType: "grok:grok-rescue",
    description: "inspect the failure"
  });
  assert.deepStrictEqual(state.dispatchLog[1], {
    at: state.dispatchLog[1].at,
    lane: "codex",
    subagentType: "codex:codex-rescue",
    description: "implement the repair"
  });
});

test("dispatch ledger descriptions are truncated at 120 characters", (t) => {
  const sandbox = makeSandbox(t);
  const description = "x".repeat(121);
  run(sandbox, dispatchPayload(sandbox, { description }));

  const [entry] = readState(sandbox, "session-1").dispatchLog;
  assert.strictEqual(entry.description, description.slice(0, 120));
  assert.strictEqual(entry.description.length, 120);
});

test("dispatch ledger retains only its 200 most recent entries", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.stateDir, { recursive: true });
  fs.writeFileSync(
    stateFileFor(sandbox, "session-1"),
    JSON.stringify({
      writeCount: 0,
      dispatches: {},
      dispatchLog: Array.from({ length: 200 }, (_, index) => ({ at: `2026-07-10T00:00:${String(index % 60).padStart(2, "0")}.000Z`, lane: "builtin", description: String(index) })),
      advisedMultiples: [],
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    }),
    "utf8"
  );

  run(sandbox, dispatchPayload(sandbox, { description: "latest" }));
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.dispatchLog.length, 200);
  assert.strictEqual(state.dispatchLog[0].description, "1");
  assert.strictEqual(state.dispatchLog.at(-1).description, "latest");
});

test("dispatch ledger initializes when an existing state file has no dispatchLog", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.stateDir, { recursive: true });
  fs.writeFileSync(
    stateFileFor(sandbox, "session-1"),
    JSON.stringify({ writeCount: 4, dispatches: { grok: 2 }, advisedMultiples: [1], createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z" }),
    "utf8"
  );

  run(sandbox, dispatchPayload(sandbox, { toolName: "Task", subagentType: "fusion:fast-worker" }));
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.writeCount, 4);
  assert.deepStrictEqual(state.dispatches, { grok: 2, "fusion:fast-worker": 1 });
  assert.strictEqual(state.dispatchLog.length, 1);
  assert.strictEqual(state.dispatchLog[0].lane, "fusion:fast-worker");
});

test("a Skill invocation is ignored and does not touch the counters", (t) => {
  const sandbox = makeSandbox(t);
  for (let i = 0; i < 3; i += 1) {
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
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.writeCount, 3);
  assert.deepStrictEqual(state.dispatches, {});
});

test("the old allow escape hatch exits 0 with a notice and never touches state", (t) => {
  const sandbox = makeSandbox(t);
  for (let i = 0; i < 6; i += 1) {
    run(sandbox, writePayload(sandbox));
  }
  const before = readState(sandbox, "session-1");

  const allowResult = spawnSync(process.execPath, [script, "allow", "session-1"], {
    env: envFor(sandbox),
    encoding: "utf8"
  });
  assert.strictEqual(allowResult.status, 0);
  assert.match(allowResult.stdout, /retired/);
  assert.strictEqual(allowResult.stderr, "");

  const after = readState(sandbox, "session-1");
  assert.deepStrictEqual(after, before);
});

test("the old allow escape hatch exits 0 even without a session id argument", (t) => {
  const sandbox = makeSandbox(t);
  const result = spawnSync(process.execPath, [script, "allow"], {
    env: envFor(sandbox),
    encoding: "utf8"
  });
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /retired/);
});

test("a subagent payload fails open and is never counted", (t) => {
  const sandbox = makeSandbox(t);
  for (let i = 0; i < 8; i += 1) {
    const result = run(sandbox, writePayload(sandbox, { agentId: "agent-123" }));
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
  }
  const dispatchResult = run(sandbox, dispatchPayload(sandbox, { subagentType: "codex:codex-rescue", agentId: "agent-123" }));
  assert.strictEqual(dispatchResult.status, 0);
  assert.strictEqual(dispatchResult.stdout, "");
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
  assert.strictEqual(first.stdout, "");
  const secondReason = JSON.parse(second.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(secondReason, /^2 inline writes happened this session with zero dispatches/);
});

test("a nonsense FUSION_INLINE_WRITE_BUDGET value falls back to the default of 5", (t) => {
  const sandbox = makeSandbox(t);
  const extraEnv = { FUSION_INLINE_WRITE_BUDGET: "not-a-number" };
  for (let i = 0; i < 4; i += 1) {
    const result = run(sandbox, writePayload(sandbox), extraEnv);
    assert.strictEqual(result.stdout, "");
  }
  const fifth = run(sandbox, writePayload(sandbox), extraEnv);
  const reason = JSON.parse(fifth.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /^5 inline writes happened this session with zero dispatches/);
});

test("stale session state is pruned after 48 hours", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.stateDir, { recursive: true });
  const staleFile = stateFileFor(sandbox, "old-session");
  fs.writeFileSync(staleFile, JSON.stringify({ writeCount: 5, dispatches: {}, advisedMultiples: [], createdAt: "x", updatedAt: "x" }), "utf8");
  const oldTime = new Date(Date.now() - 49 * 60 * 60 * 1000);
  fs.utimesSync(staleFile, oldTime, oldTime);

  run(sandbox, writePayload(sandbox, { sessionId: "session-2" }));
  assert.strictEqual(fs.existsSync(staleFile), false);
});

test("concurrent hook invocations serialize dispatch and write increments", async (t) => {
  const sandbox = makeSandbox(t);
  const extraEnv = { FUSION_INLINE_WRITE_BUDGET: "1000" };
  const calls = [];
  for (let index = 0; index < 16; index += 1) {
    calls.push(runAsync(sandbox, writePayload(sandbox), extraEnv));
    calls.push(runAsync(sandbox, dispatchPayload(sandbox, { subagentType: "grok:grok-rescue" }), extraEnv));
  }
  const results = await Promise.all(calls);
  for (const result of results) {
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, "");
  }
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.writeCount, 16);
  assert.deepStrictEqual(state.dispatches, { grok: 16 });
  assert.strictEqual(fs.existsSync(`${stateFileFor(sandbox, "session-1")}.lock`), false);
});
