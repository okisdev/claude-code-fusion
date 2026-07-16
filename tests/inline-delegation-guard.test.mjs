import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readAuditEvents } from "../plugins/fusion/scripts/inline-delegation-guard.mjs";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "plugins", "fusion", "scripts", "inline-delegation-guard.mjs");

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inline-guard-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const auditDir = path.join(root, "audit");
  const workDir = path.join(root, "work");
  fs.mkdirSync(workDir, { recursive: true });
  return { root, stateDir, auditDir, workDir };
}

function envFor(sandbox, extra = {}) {
  return {
    ...process.env,
    FUSION_INLINE_GUARD_STATE: sandbox.stateDir,
    FUSION_INLINE_GUARD_AUDIT_DIR: sandbox.auditDir,
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
    hook_event_name: "PreToolUse",
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
    hook_event_name: "PostToolUse",
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

function auditFiles(sandbox) {
  if (!fs.existsSync(sandbox.auditDir)) {
    return [];
  }
  return fs.readdirSync(sandbox.auditDir).filter((entry) => /^events-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/.test(entry)).sort().map((entry) => path.join(sandbox.auditDir, entry));
}

function readAuditLines(sandbox) {
  return auditFiles(sandbox).flatMap((file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean));
}

function readAuditRecords(sandbox) {
  const records = [];
  for (const line of readAuditLines(sandbox)) {
    try {
      records.push(JSON.parse(line));
    } catch {
      void 0;
    }
  }
  return records;
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

test("advisory compatibility mode never denies, even far past the budget", (t) => {
  const sandbox = makeSandbox(t);
  for (let i = 0; i < 30; i += 1) {
    const result = run(sandbox, writePayload(sandbox), { FUSION_INLINE_GUARD_MODE: "advisory" });
    assert.strictEqual(result.status, 0);
    if (result.stdout) {
      const output = JSON.parse(result.stdout);
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, "allow");
    }
  }
});

test("the default mode denies writes after the dispatch window budget until an Agent dispatch", (t) => {
  const sandbox = makeSandbox(t);
  for (let i = 0; i < 5; i += 1) {
    const result = run(sandbox, writePayload(sandbox));
    assert.notStrictEqual(JSON.parse(result.stdout || '{"hookSpecificOutput":{"permissionDecision":"allow"}}').hookSpecificOutput.permissionDecision, "deny");
  }

  for (let i = 0; i < 2; i += 1) {
    const denied = run(sandbox, writePayload(sandbox));
    const output = JSON.parse(denied.stdout);
    assert.strictEqual(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /inline write budget is exhausted/i);
  }
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 5);
  assert.strictEqual(readAuditRecords(sandbox).filter((record) => record.event === "write").length, 5);

  run(sandbox, dispatchPayload(sandbox, { subagentType: "fusion:fast-worker" }));
  const allowed = run(sandbox, writePayload(sandbox));
  assert.strictEqual(allowed.stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 1);
});

test("enforcement fails closed when guard state is unavailable while advisory compatibility remains fail open", (t) => {
  const sandbox = makeSandbox(t);
  fs.writeFileSync(sandbox.stateDir, "not a directory", "utf8");
  const denied = run(sandbox, writePayload(sandbox));
  assert.strictEqual(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /state is unavailable/);

  const advisory = run(sandbox, writePayload(sandbox), { FUSION_INLINE_GUARD_MODE: "advisory" });
  assert.strictEqual(advisory.stdout, "");
});

test("enforcement rejects malformed, truncated, and array state without resetting the write budget", (t) => {
  const cases = [
    ["malformed", "not json"],
    ["truncated", '{"writeCount":'],
    ["array", '[{"writeCount":5}]']
  ];
  for (const [name, contents] of cases) {
    const sandbox = makeSandbox(t);
    fs.mkdirSync(sandbox.stateDir, { recursive: true });
    const file = stateFileFor(sandbox, "session-1");
    fs.writeFileSync(file, contents, "utf8");

    const denied = run(sandbox, writePayload(sandbox));
    assert.strictEqual(denied.status, 0, name);
    assert.strictEqual(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny", name);
    assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /state is unavailable/, name);
    assert.strictEqual(fs.readFileSync(file, "utf8"), contents, name);
    assert.deepStrictEqual(readAuditRecords(sandbox), [], name);

    const advisory = run(sandbox, writePayload(sandbox), { FUSION_INLINE_GUARD_MODE: "advisory" });
    assert.strictEqual(advisory.status, 0, name);
    assert.strictEqual(advisory.stdout, "", name);
    assert.strictEqual(fs.readFileSync(file, "utf8"), contents, name);
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
  const extraEnv = { FUSION_INLINE_GUARD_MODE: "advisory" };
  for (let i = 0; i < 5; i += 1) {
    run(sandbox, writePayload(sandbox), extraEnv);
  }
  for (let i = 0; i < 4; i += 1) {
    const result = run(sandbox, writePayload(sandbox), extraEnv);
    assert.strictEqual(result.stdout, "", `write ${i + 6} should stay silent`);
  }
  const tenth = run(sandbox, writePayload(sandbox), extraEnv);
  const tenthReason = JSON.parse(tenth.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(tenthReason, /^10 inline writes happened this session with zero dispatches/);

  for (let i = 0; i < 4; i += 1) {
    const result = run(sandbox, writePayload(sandbox), extraEnv);
    assert.strictEqual(result.stdout, "", `write ${i + 11} should stay silent`);
  }
  const fifteenth = run(sandbox, writePayload(sandbox), extraEnv);
  const fifteenthReason = JSON.parse(fifteenth.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(fifteenthReason, /^15 inline writes happened this session with zero dispatches/);

  const state = readState(sandbox, "session-1");
  assert.deepStrictEqual(state.advisedMultiples, [1, 2, 3]);
});

test("advisories count writes since the most recent dispatch and restart after each dispatch", (t) => {
  const sandbox = makeSandbox(t);
  const dispatchResult = run(sandbox, dispatchPayload(sandbox, { subagentType: "fusion:fast-worker" }));
  assert.strictEqual(dispatchResult.status, 0);
  assert.strictEqual(dispatchResult.stdout, "");

  for (let i = 0; i < 4; i += 1) {
    const result = run(sandbox, writePayload(sandbox));
    assert.strictEqual(result.stdout, "", `write ${i + 1} after the first dispatch should stay silent`);
  }
  const fifth = run(sandbox, writePayload(sandbox));
  assert.match(JSON.parse(fifth.stdout).hookSpecificOutput.permissionDecisionReason, /^5 inline writes happened since the most recent dispatch; this session has 1 dispatch\./);

  run(sandbox, dispatchPayload(sandbox, { subagentType: "codex:codex-rescue" }));
  for (let i = 0; i < 4; i += 1) {
    const result = run(sandbox, writePayload(sandbox));
    assert.strictEqual(result.stdout, "", `write ${i + 1} after the second dispatch should stay silent`);
  }
  const nextFifth = run(sandbox, writePayload(sandbox));
  assert.match(JSON.parse(nextFifth.stdout).hookSpecificOutput.permissionDecisionReason, /^5 inline writes happened since the most recent dispatch; this session has 2 dispatches\./);

  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.writeCount, 10);
  assert.strictEqual(state.writesSinceDispatch, 5);
  assert.strictEqual(state.dispatchEpoch, 2);
  assert.deepStrictEqual(state.advisedMultiples, [1]);
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

test("an Agent PreToolUse attempt does not reset the write window before dispatch succeeds", (t) => {
  const sandbox = makeSandbox(t);
  for (let index = 0; index < 5; index += 1) {
    run(sandbox, writePayload(sandbox));
  }
  const attempted = dispatchPayload(sandbox, { subagentType: "fusion:fast-worker" });
  attempted.hook_event_name = "PreToolUse";
  run(sandbox, attempted);

  assert.deepStrictEqual(readState(sandbox, "session-1").dispatches, {});
  const denied = run(sandbox, writePayload(sandbox));
  assert.strictEqual(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
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

test("writes and dispatches append minimal long-term audit records", (t) => {
  const sandbox = makeSandbox(t);
  const target = path.join(sandbox.workDir, "nested", "file.txt");
  run(sandbox, dispatchPayload(sandbox, { subagentType: "grok:grok-rescue", description: "inspect the failure" }));
  run(sandbox, dispatchPayload(sandbox, { toolName: "Task", subagentType: "codex:codex-rescue", description: "implement the repair" }));
  run(sandbox, writePayload(sandbox, { filePath: target }));

  const { events: records, malformedCount } = readAuditEvents({ auditDir: sandbox.auditDir });
  assert.strictEqual(records.length, 3);
  assert.strictEqual(malformedCount, 0);
  assert.deepStrictEqual(records[0], {
    schemaVersion: 1,
    at: records[0].at,
    session: "session-1",
    event: "dispatch",
    lane: "grok",
    tool: "Agent",
    description: "inspect the failure"
  });
  assert.deepStrictEqual(records[1], {
    schemaVersion: 1,
    at: records[1].at,
    session: "session-1",
    event: "dispatch",
    lane: "codex",
    tool: "Task",
    description: "implement the repair"
  });
  assert.deepStrictEqual(records[2], {
    schemaVersion: 1,
    at: records[2].at,
    session: "session-1",
    event: "write",
    lane: "main",
    tool: "Edit",
    path: "nested/file.txt"
  });
  assert.ok(records.every((record) => /^\d{4}-\d{2}-\d{2}T/.test(record.at)));
});

test("audit reader sorts events, filters by session and time, and degrades on a missing directory", (t) => {
  const sandbox = makeSandbox(t);
  const missing = readAuditEvents({ auditDir: path.join(sandbox.root, "missing") });
  assert.deepStrictEqual(missing, { events: [], malformedCount: 0 });

  fs.mkdirSync(sandbox.auditDir, { recursive: true });
  const records = [
    { at: "2026-07-14T00:02:00.000Z", session: "session-1", event: "write", lane: "main", tool: "Edit", path: "two.txt" },
    { at: "2026-07-14T00:01:00.000Z", session: "session-2", event: "dispatch", lane: "codex", tool: "Task", description: "middle" },
    { at: "2026-07-14T00:00:00.000Z", session: "session-1", event: "write", lane: "main", tool: "Write", path: "one.txt" }
  ];
  fs.writeFileSync(path.join(sandbox.auditDir, "events-2026-07-14.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const all = readAuditEvents({ auditDir: sandbox.auditDir });
  assert.deepStrictEqual(all.events.map((event) => event.at), ["2026-07-14T00:00:00.000Z", "2026-07-14T00:01:00.000Z", "2026-07-14T00:02:00.000Z"]);
  const filtered = readAuditEvents({ auditDir: sandbox.auditDir, sessionId: "session-1", sinceMs: Date.parse("2026-07-14T00:00:30.000Z") });
  assert.deepStrictEqual(filtered.events.map((event) => event.path), ["two.txt"]);
  assert.strictEqual(filtered.malformedCount, 0);
});

test("state and audit records omit full tool input and redact sensitive descriptions", (t) => {
  const sandbox = makeSandbox(t);
  const writeSecret = "write-secret-value";
  const promptSecret = "prompt-secret-value";
  const tokenSecret = "token-secret-value";
  const pathSecret = `sk-${"z".repeat(40)}`;
  const write = writePayload(sandbox, { filePath: path.join(sandbox.workDir, "safe", "file.txt") });
  write.tool_input.old_string = writeSecret;
  write.tool_input.new_string = writeSecret;
  write.tool_input.content = writeSecret;
  run(sandbox, write);
  run(sandbox, writePayload(sandbox, { filePath: path.join(sandbox.workDir, "safe", pathSecret) }));

  const dispatch = dispatchPayload(sandbox, {
    subagentType: "fusion:fast-worker",
    description: `inspect token=${tokenSecret} with Bearer ${"a".repeat(80)}`
  });
  dispatch.tool_input.prompt = promptSecret;
  dispatch.tool_input.password = promptSecret;
  run(sandbox, dispatch);

  const persisted = `${fs.readFileSync(stateFileFor(sandbox, "session-1"), "utf8")}\n${readAuditLines(sandbox).join("\n")}`;
  assert.doesNotMatch(persisted, new RegExp(writeSecret));
  assert.doesNotMatch(persisted, new RegExp(promptSecret));
  assert.doesNotMatch(persisted, new RegExp(tokenSecret));
  assert.doesNotMatch(persisted, new RegExp(pathSecret));
  assert.doesNotMatch(persisted, new RegExp(sandbox.workDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(persisted, /old_string|new_string|prompt|password|content/);
  assert.match(persisted, /\[redacted\]/);
});

test("audit retains writes whose paths cannot be safely recorded", (t) => {
  const sandbox = makeSandbox(t);
  const pathSecret = `sk-${"z".repeat(40)}`;
  run(sandbox, writePayload(sandbox, { filePath: path.join(sandbox.workDir, pathSecret) }));

  const writes = readAuditRecords(sandbox).filter((record) => record.event === "write");
  assert.strictEqual(writes.length, 1);
  assert.ok(!Object.hasOwn(writes[0], "path"));
  assert.doesNotMatch(readAuditLines(sandbox).join("\n"), new RegExp(pathSecret));
});

test("malformed or oversized subagent types fall back to builtin without entering state or audit", (t) => {
  const sandbox = makeSandbox(t);
  const secrets = ["fusion:bad\nsecret-value", `fusion:${"s".repeat(200)}`, "fusion:token=secret-value", "fusion:api-key-secret-value"];
  for (const subagentType of secrets) {
    run(sandbox, dispatchPayload(sandbox, { subagentType, description: "safe description" }));
  }

  const stateText = fs.readFileSync(stateFileFor(sandbox, "session-1"), "utf8");
  const auditText = readAuditLines(sandbox).join("\n");
  assert.deepStrictEqual(readState(sandbox, "session-1").dispatches, { builtin: 4 });
  assert.ok(readState(sandbox, "session-1").dispatchLog.every((entry) => !Object.hasOwn(entry, "subagentType")));
  assert.deepStrictEqual(readAuditRecords(sandbox).map((record) => record.lane), ["builtin", "builtin", "builtin", "builtin"]);
  assert.doesNotMatch(`${stateText}\n${auditText}`, /secret-value/);
  assert.doesNotMatch(`${stateText}\n${auditText}`, new RegExp("s".repeat(100)));
});

test("dispatch ledger descriptions are truncated at 120 characters", (t) => {
  const sandbox = makeSandbox(t);
  const description = "two words ".repeat(20);
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

test("legacy state without a period counter starts counting future writes after its recorded dispatches", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.stateDir, { recursive: true });
  fs.writeFileSync(
    stateFileFor(sandbox, "session-1"),
    JSON.stringify({ writeCount: 7, dispatches: { codex: 1 }, advisedMultiples: [1], createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z" }),
    "utf8"
  );

  for (let index = 0; index < 4; index += 1) {
    assert.strictEqual(run(sandbox, writePayload(sandbox)).stdout, "");
  }
  const fifth = run(sandbox, writePayload(sandbox));
  assert.match(JSON.parse(fifth.stdout).hookSpecificOutput.permissionDecisionReason, /^5 inline writes happened since the most recent dispatch/);

  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.writeCount, 12);
  assert.strictEqual(state.writesSinceDispatch, 5);
  assert.strictEqual(state.dispatchEpoch, 1);
  assert.deepStrictEqual(state.advisedMultiples, [1]);
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

test("audit appends after a malformed trailing line and readers skip only the damaged record", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.auditDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(sandbox.auditDir, `events-${date}.jsonl`);
  fs.writeFileSync(file, "{ malformed", "utf8");

  run(sandbox, writePayload(sandbox));
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0], "{ malformed");
  const audit = readAuditEvents({ auditDir: sandbox.auditDir });
  assert.strictEqual(audit.events.length, 1);
  assert.strictEqual(audit.events[0].event, "write");
  assert.strictEqual(audit.malformedCount, 1);
});

test("audit rotates by size without losing valid records", (t) => {
  const sandbox = makeSandbox(t);
  const extraEnv = { FUSION_INLINE_GUARD_AUDIT_MAX_BYTES: "1", FUSION_INLINE_GUARD_AUDIT_MAX_FILES: "10" };
  for (let index = 0; index < 4; index += 1) {
    run(sandbox, writePayload(sandbox), extraEnv);
  }

  assert.strictEqual(auditFiles(sandbox).length, 4);
  assert.strictEqual(readAuditEvents({ auditDir: sandbox.auditDir }).events.length, 4);
});

test("audit enforces its rotated file cap", (t) => {
  const sandbox = makeSandbox(t);
  const extraEnv = { FUSION_INLINE_GUARD_AUDIT_MAX_BYTES: "1", FUSION_INLINE_GUARD_AUDIT_MAX_FILES: "2" };
  for (let index = 0; index < 4; index += 1) {
    run(sandbox, writePayload(sandbox), extraEnv);
  }

  assert.strictEqual(auditFiles(sandbox).length, 2);
  assert.strictEqual(readAuditEvents({ auditDir: sandbox.auditDir }).events.length, 2);
});

test("audit removes segments older than its retention window", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.auditDir, { recursive: true });
  const staleFile = path.join(sandbox.auditDir, "events-2020-01-01.jsonl");
  fs.writeFileSync(staleFile, `${JSON.stringify({ at: "2020-01-01T00:00:00.000Z", session: "old-session", event: "write", lane: "main", tool: "Edit", path: "old.txt" })}\n`, "utf8");
  const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(staleFile, oldTime, oldTime);

  run(sandbox, writePayload(sandbox), { FUSION_INLINE_GUARD_AUDIT_RETENTION_DAYS: "1" });
  assert.strictEqual(fs.existsSync(staleFile), false);
  assert.strictEqual(readAuditEvents({ auditDir: sandbox.auditDir }).events.length, 1);
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
  const audit = readAuditEvents({ auditDir: sandbox.auditDir });
  assert.strictEqual(audit.events.length, 32);
  assert.strictEqual(audit.malformedCount, 0);
  assert.strictEqual(audit.events.filter((record) => record.event === "write").length, 16);
  assert.strictEqual(audit.events.filter((record) => record.event === "dispatch").length, 16);
  assert.strictEqual(fs.existsSync(path.join(sandbox.auditDir, ".append.lock")), false);
});
