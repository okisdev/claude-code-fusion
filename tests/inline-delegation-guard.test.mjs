import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_LOCK_TIMEOUT_MS,
  handleInlineDelegationHook,
  normalizeAuditEvent,
  readAuditEvents,
  resolveLockTimeoutMs,
  resolveTailAllowance,
  resolveTailMaxBytes,
  resolveZeroDispatchMaxBytes,
  resolveZeroDispatchWrites
} from "../plugins/fusion/scripts/inline-delegation-guard.mjs";
import { messageCode, messageTag, tagMessage } from "../plugins/fusion/scripts/lib/user-messages.mjs";
import { normalizeState } from "../plugins/fusion/scripts/lib/guard/state.mjs";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "plugins", "fusion", "scripts", "inline-delegation-guard.mjs");
let toolUseSequence = 0;

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inline-guard-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const auditDir = path.join(root, "audit");
  const dataDir = path.join(root, "data");
  const workDir = path.join(root, "work");
  const clockFile = path.join(root, "clock.mjs");
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(
    clockFile,
    "const NativeDate = Date; const now = NativeDate.parse(process.env.FUSION_TEST_NOW); globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length === 0 ? [now] : args)); } static now() { return now; } };\n",
    "utf8"
  );
  return { root, stateDir, auditDir, dataDir, workDir, clockFile };
}

function envFor(sandbox, extra = {}) {
  const env = {
    ...process.env,
    FUSION_INLINE_GUARD_STATE: sandbox.stateDir,
    FUSION_INLINE_GUARD_AUDIT_DIR: sandbox.auditDir,
    FUSION_DATA_DIR: sandbox.dataDir,
    FUSION_MODEL_ROUTING: path.join(sandbox.root, "missing-model-routing.json"),
    ...extra
  };
  if (extra.FUSION_TEST_NOW) {
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(sandbox.clockFile).href}`.trim();
  }
  return env;
}

function runRaw(sandbox, payload, extraEnv = {}) {
  if (!extraEnv.FUSION_TEST_NOW && payload?.hook_event_name === "PreToolUse" && ["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(payload.tool_name) && (!path.isAbsolute(payload.tool_input?.file_path ?? "") || payload.tool_input.file_path.startsWith(`${sandbox.workDir}/`))) {
    sandbox.writeTurnAt = Math.max(Date.now(), (sandbox.writeTurnAt ?? 0) + 2000);
    extraEnv = { ...extraEnv, FUSION_TEST_NOW: new Date(sandbox.writeTurnAt).toISOString() };
  }
  return spawnSync(process.execPath, [script], {
    input: payload === undefined ? "" : JSON.stringify(payload),
    env: envFor(sandbox, extraEnv),
    encoding: "utf8"
  });
}

function run(sandbox, payload, extraEnv = {}) {
  if (payload?.hook_event_name === "PostToolUse" && (payload.tool_name === "Agent" || payload.tool_name === "Task")) {
    const launch = runRaw(sandbox, { ...payload, hook_event_name: "PreToolUse" }, extraEnv);
    if (launch.status !== 0 || launch.stdout || launch.stderr) {
      return launch;
    }
  }
  return runRaw(sandbox, payload, extraEnv);
}

async function runAsyncRaw(sandbox, payload, extraEnv = {}) {
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

async function runAsync(sandbox, payload, extraEnv = {}) {
  if (payload?.hook_event_name === "PostToolUse" && (payload.tool_name === "Agent" || payload.tool_name === "Task")) {
    const launch = await runAsyncRaw(sandbox, { ...payload, hook_event_name: "PreToolUse" }, extraEnv);
    if (launch.status !== 0 || launch.stdout || launch.stderr) {
      return launch;
    }
  }
  return runAsyncRaw(sandbox, payload, extraEnv);
}

function writePayload(sandbox, { sessionId = "session-1", toolName = "Edit", filePath, cwd, agentId, toolInput = {} } = {}) {
  const targetPath = filePath ?? path.join(sandbox.workDir, "file.txt");
  const payload = {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    transcript_path: path.join(sandbox.root, "transcript.jsonl"),
    cwd: cwd ?? sandbox.workDir,
    tool_name: toolName,
    tool_input: { file_path: targetPath, ...toolInput }
  };
  if (agentId) {
    payload.agent_id = agentId;
    payload.agent_type = "Explore";
  }
  return payload;
}

function dispatchPayload(sandbox, { sessionId = "session-1", toolName = "Agent", subagentType = "Explore", description = "do the thing", agentId } = {}) {
  const payload = {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    transcript_path: path.join(sandbox.root, "transcript.jsonl"),
    cwd: sandbox.workDir,
    tool_name: toolName,
    tool_use_id: `tool-use-${++toolUseSequence}`,
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

function writeDispatchTranscript(sandbox, groups) {
  fs.writeFileSync(path.join(sandbox.root, "transcript.jsonl"), `${groups.map(({ messageId, payloads }) => JSON.stringify({
    type: "assistant",
    message: { id: messageId, content: payloads.map((payload) => ({ type: "tool_use", id: payload.tool_use_id })) }
  })).join("\n")}\n`, "utf8");
}

function writeRoutingFixture(sandbox) {
  const file = path.join(sandbox.root, "model-routing.json");
  const models = ["quick-choice", "volume-choice", "flagship-choice"].map((id) => ({ id, lane: "codex", intelligence: 5, taste: 4, cost: 3 }));
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-07-04T00:00:00.000Z",
    costProfile: "",
    models,
    defaults: { codex: { quick: { model: "quick-choice", effort: "high" }, volume: { model: "volume-choice", effort: "low" }, flagship: { model: "flagship-choice", effort: "max" } } }
  }), "utf8");
  return file;
}

function verificationPayload(sandbox, { sessionId = "session-1", command = "node --test", toolResponse = {} } = {}) {
  return {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    transcript_path: path.join(sandbox.root, "transcript.jsonl"),
    cwd: sandbox.workDir,
    tool_name: "Bash",
    tool_input: { command },
    tool_response: toolResponse
  };
}

function testSummary({ tests = 1074, pass = 1073, fail = 0, skipped = 1, failureLine = "" } = {}) {
  return [failureLine, `ℹ tests ${tests}`, `ℹ pass ${pass}`, `ℹ fail ${fail}`, `ℹ skipped ${skipped}`].filter(Boolean).join("\n");
}

function stateFileFor(sandbox, sessionId) {
  return path.join(sandbox.stateDir, `${sessionId}.json`);
}

function readState(sandbox, sessionId) {
  return JSON.parse(fs.readFileSync(stateFileFor(sandbox, sessionId), "utf8"));
}

function readPayload(sandbox, toolName = "Read", agentId) {
  return {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    cwd: sandbox.workDir,
    tool_name: toolName,
    tool_input: { file_path: path.join(sandbox.workDir, "file.txt") },
    ...(agentId ? { agent_id: agentId } : {})
  };
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

function assertSingleReplay(sandbox, tool, kind) {
  const { turn } = readState(sandbox, "session-1");
  const records = readAuditRecords(sandbox);
  assert.deepStrictEqual(records, [{ schemaVersion: 1, at: records[0]?.at, session: "session-1", event: "replay", lane: "main", tool, turn: turn.key, kind, tokens: 400_000, measured: false }]);
}

function assertMessageTagged(text, slug) {
  const tag = messageTag(slug);
  assert.ok(text.endsWith(tag), `${text} should end with ${tag}`);
  assert.deepStrictEqual(text.match(/\[fusion:\d{4}\]/g), [tag]);
}

function advisoryContext(result, slug) {
  const output = JSON.parse(result.stdout);
  assert.deepStrictEqual(Object.keys(output), ["hookSpecificOutput"]);
  assert.deepStrictEqual(Object.keys(output.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"]);
  assert.strictEqual(output.hookSpecificOutput.hookEventName, "PreToolUse");
  assertMessageTagged(output.hookSpecificOutput.additionalContext, slug);
  return output.hookSpecificOutput.additionalContext;
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
  assert.strictEqual(state.writeReplayTokens, 1_600_000);
});

test("five Edit calls in one turn price one context without an advisory", (t) => {
  for (const posture of ["judgment", "strict"]) {
    const sandbox = makeSandbox(t);
    for (let index = 0; index < 5; index += 1) {
      const payload = { ...writePayload(sandbox), tool_use_id: `edit-${index}` };
      assert.strictEqual(run(sandbox, payload, { FUSION_POSTURE: posture, FUSION_TEST_NOW: "2026-07-21T00:00:00.000Z" }).stdout, "");
    }
    const state = readState(sandbox, "session-1");
    assert.strictEqual(state.writeCount, 5);
    assert.strictEqual(state.writesSinceDispatch, 5);
    assert.strictEqual(state.writeReplayTokens, 400_000);
    assert.strictEqual(state.writeTurnKey, state.turn.key);
    assert.deepStrictEqual(state.pendingWrites.map((entry) => entry.tokens), [400_000, 0, 0, 0, 0]);
    assert.deepStrictEqual(state.advisedMultiples, []);
    assert.strictEqual(readAuditRecords(sandbox).filter((event) => event.event === "warn").length, 0);
  }
});

for (const [contextTokens, thresholdTurn, formattedTokens] of [[800_000, 3, "2.4M"], [80_000, 25, "2.0M"], [2_000_000, 1, "2.0M"]]) {
  for (const posture of ["judgment", "strict"]) {
    test(`${posture} prices ${contextTokens} tokens of context per write turn and reaches the budget at turn ${thresholdTurn}`, (t) => {
      const sandbox = makeSandbox(t);
      const env = { FUSION_POSTURE: posture, FUSION_INLINE_TAIL_ALLOWANCE: "0", FUSION_INLINE_ZERO_DISPATCH_WRITES: "0" };
      const base = Date.parse("2026-07-21T00:00:00.000Z");
      for (let turn = 1; turn <= thresholdTurn; turn += 1) {
        const payload = { ...writePayload(sandbox), tool_use_id: `write-${turn}` };
        fs.appendFileSync(payload.transcript_path, `${JSON.stringify({ type: "assistant", message: { id: `msg_${turn}`, usage: { input_tokens: 1000, cache_read_input_tokens: contextTokens - 2000, cache_creation_input_tokens: 1000 }, content: [{ type: "tool_use", id: payload.tool_use_id }] } })}\n`);
        const result = run(sandbox, payload, { ...env, FUSION_TEST_NOW: new Date(base + turn * 1600).toISOString() });
        assert.strictEqual(result.status, 0);
        assert.strictEqual(result.stderr, "");
        if (turn < thresholdTurn) assert.strictEqual(result.stdout, "", `turn ${turn}`);
        else {
          const line = advisoryContext(result, posture === "strict" ? "inline-guard.write-budget-advisory" : "inline-guard.unverified-advisory");
          const prefix = posture === "strict"
            ? `${turn} inline ${turn === 1 ? "write" : "writes"} replayed ${formattedTokens} tokens of context this session with zero dispatches. `
            : `${turn} main loop ${turn === 1 ? "write is" : "writes are"} unverified in this window, and ${turn === 1 ? "its turn" : "their turns"} replayed ${formattedTokens} tokens of context. `;
          assert.ok(line.startsWith(prefix), line);
        }
      }
      const state = readState(sandbox, "session-1");
      assert.strictEqual(state.writeCount, thresholdTurn);
      assert.strictEqual(state.writeReplayTokens, contextTokens * thresholdTurn);
      assert.strictEqual(state.writeTurnKey, `msg_${thresholdTurn}`);
      assert.deepStrictEqual(state.pendingWrites.map((entry) => entry.tokens), Array(thresholdTurn).fill(contextTokens));
      const [warning] = readAuditRecords(sandbox).filter((event) => event.event === "warn");
      assert.strictEqual(warning.budget, 2_000_000);
      assert.strictEqual(warning.replayTokens, state.writeReplayTokens);
      const next = run(sandbox, { ...writePayload(sandbox, { toolName: "Write" }), tool_use_id: "next-write" }, { ...env, FUSION_TEST_NOW: new Date(base + (thresholdTurn + 1) * 1600).toISOString() });
      if (posture === "strict") {
        assert.strictEqual(JSON.parse(next.stdout).hookSpecificOutput.permissionDecision, "deny");
        assert.strictEqual(readState(sandbox, "session-1").writeReplayTokens, state.writeReplayTokens);
        assert.strictEqual(readAuditRecords(sandbox).at(-1).replayTokens, state.writeReplayTokens);
      } else {
        const nextMultiple = Math.floor((state.writeReplayTokens + contextTokens) / 2_000_000);
        if (nextMultiple === 2) advisoryContext(next, "inline-guard.unverified-advisory");
        else assert.strictEqual(next.stdout, "");
      }
    });
  }
}

for (const [name, command, bytes] of [
  ["sed in place", "sed -i 's/old/new/' src/x", 0],
  ["cat heredoc", "cat > src/x <<'EOF'\nnew\nEOF", 3],
  ["python heredoc", "python3 - <<'PY'\nfrom pathlib import Path\nPath('src/x').write_text('new')\nPY", 56]
]) {
  test(`a ${name} Bash write counts, audits its path, and is denied past the strict replay budget`, (t) => {
    const sandbox = makeSandbox(t);
    const payload = { ...bashPayload(sandbox, { command }), tool_use_id: "bash-write" };
    const env = { FUSION_POSTURE: "strict", FUSION_INLINE_ZERO_DISPATCH_WRITES: "0" };
    const base = Date.parse("2026-07-21T00:00:00.000Z");
    assert.strictEqual(run(sandbox, payload, { ...env, FUSION_TEST_NOW: new Date(base).toISOString() }).stdout, "");
    let state = readState(sandbox, "session-1");
    assert.strictEqual(state.writeCount, 1);
    assert.strictEqual(state.writesSinceDispatch, 1);
    assert.strictEqual(state.writeReplayTokens, 400_000);
    assert.strictEqual(state.inlineWriteBytes, bytes);
    assert.strictEqual(state.pendingWrites[0].tokens, 400_000);
    const [write] = readAuditRecords(sandbox).filter((event) => event.event === "write");
    assert.strictEqual(write.tool, "Bash");
    assert.strictEqual(write.path, "src/x");
    for (let index = 1; index <= 4; index += 1) run(sandbox, writePayload(sandbox, { filePath: path.join(sandbox.workDir, "src/x") }), { ...env, FUSION_TEST_NOW: new Date(base + index * 1600).toISOString() });
    const denied = run(sandbox, { ...payload, tool_use_id: "denied-bash-write" }, { ...env, FUSION_TEST_NOW: new Date(base + 8000).toISOString() });
    assert.strictEqual(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
    state = readState(sandbox, "session-1");
    assert.strictEqual(state.writeCount, 5);
    assert.strictEqual(state.writeReplayTokens, 2_000_000);
    assert.strictEqual(state.tailWritesSinceDispatch, 0);
    const denial = readAuditRecords(sandbox).at(-1);
    assert.strictEqual(denial.tool, "Bash");
    assert.strictEqual(denial.path, "src/x");
    assert.strictEqual(denial.budget, 2_000_000);
    assert.strictEqual(denial.replayTokens, 2_000_000);
  });
}

test("a Bash redirect outside the workspace does not consume the write window", (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, bashPayload(sandbox, { command: "cat > /tmp/fusion-output <<'EOF'\nnew\nEOF" }));
  assert.strictEqual(result.stdout, "");
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.writeCount, 0);
  assert.strictEqual(state.writeReplayTokens, 0);
  assert.strictEqual(state.writeTurnKey, null);
  assertSingleReplay(sandbox, "Bash", "other");
});

test("failed Bash write callbacks roll back their count, bytes, tokens, path, and advisory", (t) => {
  for (const response of [null, { is_error: true }, { isError: true }, { interrupted: true }, { exitCode: 1 }, { exit_code: 2 }, { code: -1 }, { returnCode: 3 }]) {
    const sandbox = makeSandbox(t);
    const payload = { ...bashPayload(sandbox, { command: "cat > src/x <<'EOF'\nnew\nEOF" }), tool_use_id: "failed-bash" };
    const env = { FUSION_INLINE_REPLAY_BUDGET_TOKENS: "400000" };
    advisoryContext(run(sandbox, payload, env), "inline-guard.unverified-advisory");
    assert.strictEqual(readState(sandbox, "session-1").writeReplayTokens, 400_000);
    const result = run(sandbox, { ...payload, hook_event_name: response ? "PostToolUse" : "PostToolUseFailure", tool_response: response }, env);
    assert.strictEqual(result.stdout, "");
    const state = readState(sandbox, "session-1");
    assert.strictEqual(state.writeCount, 0);
    assert.strictEqual(state.writesSinceDispatch, 0);
    assert.strictEqual(state.writeReplayTokens, 0);
    assert.strictEqual(state.inlineWriteBytes, 0);
    assert.deepStrictEqual(state.pendingWrites, []);
    assert.deepStrictEqual(state.writtenPathSignatures, []);
    assert.deepStrictEqual(state.advisedMultiples, []);
    assert.strictEqual(state.advisorySignatures["write-budget"], undefined);
  }
});

test("Bash and Edit writes in the same turn share their replay charge and roll back only their own tokens", (t) => {
  const sandbox = makeSandbox(t);
  const env = { FUSION_TEST_NOW: "2026-07-21T00:00:00.000Z" };
  const edit = { ...writePayload(sandbox), tool_use_id: "edit-first" };
  const bash = { ...bashPayload(sandbox, { command: "printf new > src/x" }), tool_use_id: "bash-second" };
  assert.strictEqual(run(sandbox, edit, env).stdout, "");
  assert.strictEqual(run(sandbox, bash, env).stdout, "");
  assert.deepStrictEqual(readState(sandbox, "session-1").pendingWrites.map((entry) => entry.tokens), [400_000, 0]);
  run(sandbox, { ...bash, hook_event_name: "PostToolUseFailure" }, env);
  assert.strictEqual(readState(sandbox, "session-1").writeCount, 1);
  assert.strictEqual(readState(sandbox, "session-1").writeReplayTokens, 400_000);
  run(sandbox, { ...edit, hook_event_name: "PostToolUseFailure" }, env);
  assert.strictEqual(readState(sandbox, "session-1").writeReplayTokens, 0);
});

test("a successful Bash write consumes the window once and confirms its path", (t) => {
  const sandbox = makeSandbox(t);
  const payload = { ...bashPayload(sandbox, { command: "printf new > src/x" }), tool_use_id: "bash-success" };
  run(sandbox, payload);
  assert.strictEqual(run(sandbox, payload).stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").writeCount, 1);
  run(sandbox, { ...payload, hook_event_name: "PostToolUse", tool_response: { exitCode: 0 } });
  const confirmed = readState(sandbox, "session-1");
  assert.strictEqual(confirmed.writeReplayTokens, 400_000);
  assert.deepStrictEqual(confirmed.pendingWrites, []);
  assert.deepStrictEqual(confirmed.confirmedPathSignatures, confirmed.writtenPathSignatures);
  run(sandbox, { ...payload, hook_event_name: "PostToolUseFailure" });
  assert.strictEqual(readState(sandbox, "session-1").writeCount, 1);
  assert.strictEqual(readState(sandbox, "session-1").writeReplayTokens, 400_000);
});

test("late Bash failures do not subtract replay tokens from a window opened by verification or dispatch", (t) => {
  for (const reset of [verificationPayload, dispatchPayload]) {
    const sandbox = makeSandbox(t);
    const payload = { ...bashPayload(sandbox, { command: "printf new > src/x" }), tool_use_id: "old-bash" };
    run(sandbox, payload);
    assert.strictEqual(readState(sandbox, "session-1").writeReplayTokens, 400_000);
    run(sandbox, reset(sandbox));
    assert.strictEqual(readState(sandbox, "session-1").writeReplayTokens, 0);
    assert.strictEqual(readState(sandbox, "session-1").writeTurnKey, null);
    run(sandbox, writePayload(sandbox));
    assert.strictEqual(readState(sandbox, "session-1").writeReplayTokens, 400_000);
    run(sandbox, { ...payload, hook_event_name: "PostToolUseFailure" });
    assert.strictEqual(readState(sandbox, "session-1").writeReplayTokens, 400_000);
  }
});

test("a Bash write can use zero dispatch relief and audits the resulting replay total", (t) => {
  const sandbox = makeSandbox(t);
  const env = { FUSION_POSTURE: "strict" };
  for (let index = 0; index < 5; index += 1) run(sandbox, writePayload(sandbox), env);
  const result = run(sandbox, bashPayload(sandbox, { command: "cat > src/x <<'EOF'\nnew\nEOF" }), env);
  advisoryContext(result, "inline-guard.zero-dispatch-advisory");
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.writeCount, 6);
  assert.strictEqual(state.inlineWriteBytes, 3);
  const relief = readAuditRecords(sandbox).at(-1);
  assert.strictEqual(relief.event, "zero-dispatch-softened");
  assert.strictEqual(relief.tool, "Bash");
  assert.strictEqual(relief.path, "src/x");
  assert.strictEqual(relief.budget, 2_000_000);
  assert.strictEqual(relief.replayTokens, state.writeReplayTokens);
});

test("judgment posture allows a main loop write at count 200", (t) => {
  const sandbox = makeSandbox(t);
  assert.strictEqual(run(sandbox, writePayload(sandbox)).stdout, "");
  const file = stateFileFor(sandbox, "session-1");
  const state = readState(sandbox, "session-1");
  state.writeCount = 200;
  state.writesSinceDispatch = 200;
  state.advisedMultiples = Array.from({ length: 40 }, (_, index) => index + 1);
  fs.writeFileSync(file, JSON.stringify(state), "utf8");

  const result = run(sandbox, writePayload(sandbox, { toolName: "Write", filePath: path.join(sandbox.workDir, "write-201.txt"), toolInput: { content: "x" } }));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 201);
  const records = readAuditRecords(sandbox);
  assert.strictEqual(records.filter((record) => record.event === "deny").length, 0);
  assert.strictEqual(records.filter((record) => record.event === "write").length, 2);
});

test("strict posture denies writes after the dispatch window budget and audits enforcement until an Agent dispatch", (t) => {
  const sandbox = makeSandbox(t);
  const strictEnv = { FUSION_POSTURE: "strict" };
  run(sandbox, dispatchPayload(sandbox, { subagentType: "fusion:claude-worker" }), strictEnv);
  for (let i = 0; i < 5; i += 1) {
    const result = run(sandbox, writePayload(sandbox), strictEnv);
    assert.notStrictEqual(JSON.parse(result.stdout || '{"hookSpecificOutput":{}}').hookSpecificOutput.permissionDecision, "deny");
    if (i === 4) {
      advisoryContext(result, "inline-guard.write-budget-advisory");
    }
  }

  for (let i = 0; i < 2; i += 1) {
    const denied = run(sandbox, writePayload(sandbox), strictEnv);
    const output = JSON.parse(denied.stdout);
    assert.strictEqual(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /inline replay budget is exhausted/i);
    assertMessageTagged(output.hookSpecificOutput.permissionDecisionReason, "inline-guard.write-budget-deny");
  }
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 5);
  const records = readAuditRecords(sandbox);
  assert.strictEqual(records.filter((record) => record.event === "write").length, 5);
  const denies = records.filter((record) => record.event === "deny");
  assert.strictEqual(denies.length, 2);
  assert.strictEqual(records.find((record) => record.event === "warn").messageCode, messageCode("inline-guard.write-budget-advisory"));
  assert.deepStrictEqual(denies[0], {
    schemaVersion: 1,
    at: denies[0].at,
    session: "session-1",
    event: "deny",
    lane: "main",
    tool: "Edit",
    path: "file.txt",
    writeCount: 5,
    dispatchCount: 1,
    budget: 2_000_000,
    replayTokens: 2_000_000,
    mode: "enforce",
    posture: "strict",
    messageCode: messageCode("inline-guard.write-budget-deny")
  });
  assert.ok(records.filter((record) => record.event === "write" || record.event === "dispatch").every((record) => !Object.hasOwn(record, "messageCode")));

  run(sandbox, dispatchPayload(sandbox, { subagentType: "fusion:claude-worker" }), strictEnv);
  const allowed = run(sandbox, writePayload(sandbox), strictEnv);
  assert.strictEqual(allowed.stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 1);
});

test("a small Edit to a file written in the current window uses one tail slot", (t) => {
  const sandbox = makeSandbox(t);
  const strictEnv = { FUSION_POSTURE: "strict" };
  run(sandbox, dispatchPayload(sandbox, { subagentType: "fusion:claude-worker" }), strictEnv);
  for (let index = 0; index < 5; index += 1) {
    run(sandbox, writePayload(sandbox, { toolInput: { new_string: "base" } }), strictEnv);
  }

  const tail = run(sandbox, writePayload(sandbox, { toolInput: { new_string: "finish" } }), strictEnv);
  const context = advisoryContext(tail, "inline-guard.tail-allowance-advisory");
  assert.match(context, /2 tail slots remain/i);
  assert.strictEqual(readState(sandbox, "session-1").tailWritesSinceDispatch, 1);
  assert.deepStrictEqual(
    readAuditRecords(sandbox).filter((record) => record.event === "tail-allowed").map((record) => [record.remainingTailSlots, record.messageCode]),
    [[2, messageCode("inline-guard.tail-allowance-advisory")]]
  );
});

test("tail allowance denies a new path Write and an oversized Edit", (t) => {
  for (const { toolName, filePath, toolInput } of [
    { toolName: "Write", filePath: "new-file.txt", toolInput: { content: "finish" } },
    { toolName: "Edit", filePath: "file.txt", toolInput: { new_string: "x".repeat(1025) } }
  ]) {
    const sandbox = makeSandbox(t);
    const extraEnv = { FUSION_POSTURE: "strict", FUSION_INLINE_ZERO_DISPATCH_WRITES: "0" };
    run(sandbox, dispatchPayload(sandbox, { subagentType: "fusion:claude-worker" }), extraEnv);
    for (let index = 0; index < 5; index += 1) {
      run(sandbox, writePayload(sandbox, { toolInput: { new_string: "base" } }), extraEnv);
    }
    const denied = run(sandbox, writePayload(sandbox, { toolName, filePath: path.join(sandbox.workDir, filePath), toolInput }), extraEnv);
    assert.strictEqual(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.strictEqual(readAuditRecords(sandbox).filter((record) => record.event === "tail-allowed").length, 0);
  }
});

test("tail allowance exhausts per window and resets after dispatch", (t) => {
  const sandbox = makeSandbox(t);
  const extraEnv = { FUSION_POSTURE: "strict", FUSION_INLINE_ZERO_DISPATCH_WRITES: "0" };
  run(sandbox, dispatchPayload(sandbox, { subagentType: "fusion:claude-worker" }), extraEnv);
  for (let index = 0; index < 5; index += 1) {
    run(sandbox, writePayload(sandbox, { toolInput: { new_string: "base" } }), extraEnv);
  }
  for (let index = 0; index < 3; index += 1) {
    const tail = run(sandbox, writePayload(sandbox, { toolInput: { new_string: "finish" } }), extraEnv);
    advisoryContext(tail, "inline-guard.tail-allowance-advisory");
  }
  const denied = run(sandbox, writePayload(sandbox, { toolInput: { new_string: "finish" } }), extraEnv);
  assert.strictEqual(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");

  run(sandbox, dispatchPayload(sandbox, { subagentType: "fusion:claude-worker" }), extraEnv);
  for (let index = 0; index < 5; index += 1) {
    run(sandbox, writePayload(sandbox, { toolInput: { new_string: "base" } }), extraEnv);
  }
  const resetTail = run(sandbox, writePayload(sandbox, { toolInput: { new_string: "finish" } }), extraEnv);
  const resetTailReason = advisoryContext(resetTail, "inline-guard.tail-allowance-advisory");
  assert.match(resetTailReason, /2 tail slots remain/i);
  assertMessageTagged(resetTailReason, "inline-guard.tail-allowance-advisory");
});

test("strict posture softens an exhausted budget for a zero dispatch session within its write and byte bounds", (t) => {
  const sandbox = makeSandbox(t);
  const strictEnv = { FUSION_POSTURE: "strict" };
  for (let index = 0; index < 5; index += 1) {
    run(sandbox, writePayload(sandbox, { toolInput: { new_string: "a" } }), strictEnv);
  }
  const softened = run(sandbox, writePayload(sandbox, { toolName: "Write", filePath: path.join(sandbox.workDir, "new-file.txt"), toolInput: { content: "a" } }), strictEnv);
  const context = advisoryContext(softened, "inline-guard.zero-dispatch-advisory");
  assert.strictEqual(
    context,
    tagMessage(
      "inline-guard.zero-dispatch-advisory",
      "The inline replay budget is exhausted; this window remains within its inline relief bounds, with 4 writes and 16378 bytes left before enforcement resumes."
    )
  );
  const audit = readAuditRecords(sandbox).filter((record) => record.event === "zero-dispatch-softened");
  assert.deepStrictEqual(audit.map((record) => [record.remainingZeroDispatchWrites, record.remainingZeroDispatchBytes, record.messageCode]), [
    [4, 16378, messageCode("inline-guard.zero-dispatch-advisory")]
  ]);
});

test("zero dispatch softening stops at its configured write and byte bounds", (t) => {
  const writeSandbox = makeSandbox(t);
  const writeEnv = { FUSION_POSTURE: "strict", FUSION_INLINE_ZERO_DISPATCH_WRITES: "6" };
  for (let index = 0; index < 6; index += 1) {
    run(writeSandbox, writePayload(writeSandbox, { toolName: "Write", filePath: path.join(writeSandbox.workDir, `write-${index}.txt`), toolInput: { content: "a" } }), writeEnv);
  }
  const writeDenied = run(writeSandbox, writePayload(writeSandbox, { toolName: "Write", filePath: path.join(writeSandbox.workDir, "write-7.txt"), toolInput: { content: "a" } }), writeEnv);
  assert.strictEqual(JSON.parse(writeDenied.stdout).hookSpecificOutput.permissionDecision, "deny");

  const byteSandbox = makeSandbox(t);
  const byteEnv = { FUSION_POSTURE: "strict", FUSION_INLINE_ZERO_DISPATCH_MAX_BYTES: "7" };
  for (let index = 0; index < 6; index += 1) {
    run(byteSandbox, writePayload(byteSandbox, { toolName: "Write", filePath: path.join(byteSandbox.workDir, `byte-${index}.txt`), toolInput: { content: "a" } }), byteEnv);
  }
  const byteDenied = run(byteSandbox, writePayload(byteSandbox, { toolName: "Write", filePath: path.join(byteSandbox.workDir, "byte-7.txt"), toolInput: { content: "a" } }), byteEnv);
  assert.strictEqual(JSON.parse(byteDenied.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("a passing verification resets the write window and stops the advisory from repeating", (t) => {
  const sandbox = makeSandbox(t);
  for (let index = 0; index < 5; index += 1) {
    run(sandbox, writePayload(sandbox));
  }
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 5);

  const verified = run(sandbox, verificationPayload(sandbox));
  assert.strictEqual(verified.status, 0);
  assert.strictEqual(verified.stdout, "");
  assert.strictEqual(verified.stderr, "");
  const reset = readState(sandbox, "session-1");
  assert.strictEqual(reset.writesSinceDispatch, 0);
  assert.strictEqual(reset.writeReplayTokens, 0);
  assert.strictEqual(reset.writeTurnKey, null);
  assert.deepStrictEqual(reset.advisedMultiples, []);
  assert.deepStrictEqual(reset.writtenPathSignatures, []);

  const sixth = run(sandbox, writePayload(sandbox));
  assert.strictEqual(sixth.stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 1);
  const verifications = readAuditRecords(sandbox).filter((record) => record.event === "verification");
  assert.deepStrictEqual(verifications, [
    {
      schemaVersion: 1,
      at: verifications[0].at,
      session: "session-1",
      event: "verification",
      lane: "main",
      tool: "Bash",
      writeCount: 5,
      dispatchCount: 0,
      budget: 2_000_000,
      replayTokens: 2_000_000,
      mode: "advisory",
      posture: "judgment",
      evidence: "exit-status"
    }
  ]);
  assert.ok(verifications.every((record) => !Object.hasOwn(record, "messageCode")));
});

test("a verification whose exit status is masked by a later segment does not reset the window", (t) => {
  for (const command of ["npm test 2>&1 | tail -20", "npm test || true", "npm test; git status --short"]) {
    const sandbox = makeSandbox(t);
    for (let index = 0; index < 5; index += 1) {
      run(sandbox, writePayload(sandbox));
    }

    const verification = run(sandbox, verificationPayload(sandbox, { command }));
    assert.strictEqual(verification.stdout, "");
    assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 5, command);
    assert.strictEqual(readAuditRecords(sandbox).filter((record) => record.event === "verification").length, 0);
  }
});

for (const { name, command, output } of [
  {
    name: "redirected npm test followed by report filters",
    command: 'npm test 2>&1 > /tmp/x/suite.log; rg "^✖|not ok|^ℹ (tests|pass|fail|skipped)" /tmp/x/suite.log | head -20',
    output: testSummary()
  },
  {
    name: "node test piped to tail",
    command: "node --test --test-timeout=120000 tests/a.test.mjs tests/b.test.mjs 2>&1 | tail -15",
    output: testSummary()
  },
  {
    name: "node test piped to rg",
    command: 'node --test --test-timeout=120000 tests/a.test.mjs 2>&1 | rg "^ℹ (tests|pass|fail)"',
    output: testSummary({ tests: 171, pass: 171, skipped: 0 })
  },
  {
    name: "two node test pipelines after echo segments",
    command: 'S=/tmp/x; echo RUN-A; node --test tests/a.test.mjs 2>&1 | rg "^ℹ "; echo RUN-B; COMPANION_TEST_NO_PROCESS_INSPECTION=1 node --test tests/a.test.mjs 2>&1 | rg "^ℹ "',
    output: testSummary({ tests: 171, pass: 171, skipped: 0 })
  },
  {
    name: "npm test after a manifest generator",
    command: 'node plugins/fusion/scripts/generate-rules-manifest.mjs && npm test 2>&1 | rg "^✖|^ℹ (tests|pass|fail|skipped)"',
    output: testSummary()
  },
  {
    name: "npm test piped to tail with vitest output",
    command: "npm test 2>&1 | tail -20",
    output: "Test Files  3 passed (3)\nTests  42 passed (42)"
  },
  {
    name: "jest piped to tail",
    command: "npx jest --ci 2>&1 | tail -20",
    output: "Tests: 12 passed, 12 total"
  },
  {
    name: "pytest piped to tail",
    command: "pytest -q 2>&1 | tail -5",
    output: "3 passed in 0.12s"
  }
]) {
  test(`an output summary resets an unobservable verification for ${name}`, (t) => {
    const sandbox = makeSandbox(t);
    for (let index = 0; index < 5; index += 1) {
      run(sandbox, writePayload(sandbox));
    }

    const result = run(sandbox, verificationPayload(sandbox, { command, toolResponse: { is_error: false, output } }));
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 0);
    assert.strictEqual(readAuditRecords(sandbox).filter((record) => record.event === "verification")[0].evidence, "output-summary");
  });
}

for (const { name, command, toolResponse } of [
  {
    name: "a failing npm summary",
    command: 'npm test 2>&1 > /tmp/x/suite.log; rg "^✖|not ok|^ℹ (tests|pass|fail|skipped)" /tmp/x/suite.log | head -20',
    toolResponse: { is_error: false, output: testSummary({ fail: 1 }) }
  },
  {
    name: "a failure marker before a node tail",
    command: "node --test --test-timeout=120000 tests/a.test.mjs tests/b.test.mjs 2>&1 | tail -15",
    toolResponse: { is_error: false, output: testSummary({ failureLine: "✖ a failing test" }) }
  },
  {
    name: "a tool error after rg output",
    command: 'node --test --test-timeout=120000 tests/a.test.mjs 2>&1 | rg "^ℹ (tests|pass|fail)"',
    toolResponse: { is_error: true, output: testSummary({ tests: 171, pass: 171, skipped: 0 }) }
  },
  {
    name: "a TAP failure after two node pipelines",
    command: 'S=/tmp/x; echo RUN-A; node --test tests/a.test.mjs 2>&1 | rg "^ℹ "; echo RUN-B; COMPANION_TEST_NO_PROCESS_INSPECTION=1 node --test tests/a.test.mjs 2>&1 | rg "^ℹ "',
    toolResponse: { is_error: false, output: testSummary({ tests: 171, pass: 171, skipped: 0, failureLine: "not ok 1 - a failing test" }) }
  },
  {
    name: "a failing npm summary after a manifest generator",
    command: 'node plugins/fusion/scripts/generate-rules-manifest.mjs && npm test 2>&1 | rg "^✖|^ℹ (tests|pass|fail|skipped)"',
    toolResponse: { is_error: false, output: testSummary({ fail: 1 }) }
  },
  {
    name: "a failing vitest summary after a passing count",
    command: "npm test 2>&1 | tail -20",
    toolResponse: { is_error: false, output: "Tests  42 passed\nTest Files  1 failed" }
  }
]) {
  test(`an unobservable verification does not reset for ${name}`, (t) => {
    const sandbox = makeSandbox(t);
    for (let index = 0; index < 5; index += 1) {
      run(sandbox, writePayload(sandbox));
    }

    const result = run(sandbox, verificationPayload(sandbox, { command, toolResponse }));
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 5);
    assert.strictEqual(readAuditRecords(sandbox).filter((record) => record.event === "verification").length, 0);
  });
}

test("a verification that ends the command resets the window through every separator", (t) => {
  for (const command of ["pnpm lint && npm test", "echo starting; npm run test:unit", "npm test > /tmp/out 2>&1", "npm test && git status --short", "set -o pipefail; npm test | tail", "set -euo pipefail; npm test 2>&1 | tail -20", "tsc --noEmit"]) {
    const sandbox = makeSandbox(t);
    for (let index = 0; index < 5; index += 1) {
      run(sandbox, writePayload(sandbox));
    }

    run(sandbox, verificationPayload(sandbox, { command }));
    assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 0, command);
    const sixth = run(sandbox, writePayload(sandbox));
    assert.strictEqual(sixth.stdout, "");
    assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 1);
  }
});

test("failed and interrupted verifications do not reset the write window", (t) => {
  for (const toolResponse of [
    { is_error: true }, { is_error: "true" }, { isError: true }, { interrupted: true },
    { exitCode: 1 }, { exit_code: 2 }, { code: -1 }, { returnCode: 3 }
  ]) {
    const sandbox = makeSandbox(t);
    for (let index = 0; index < 5; index += 1) {
      run(sandbox, writePayload(sandbox));
    }

    const verification = run(sandbox, verificationPayload(sandbox, { toolResponse }));
    assert.strictEqual(verification.stdout, "");
    assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 5);
    assert.strictEqual(readAuditRecords(sandbox).filter((record) => record.event === "verification").length, 0);
  }
});

test("a failing summary prevents observable verification credit", (t) => {
  const sandbox = makeSandbox(t);
  for (let index = 0; index < 5; index += 1) {
    run(sandbox, writePayload(sandbox));
  }
  const result = run(sandbox, verificationPayload(sandbox, {
    command: "npm test && echo done",
    toolResponse: { is_error: false, output: "ℹ pass 11\nℹ fail 1" }
  }));
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 5);
  assert.strictEqual(readAuditRecords(sandbox).filter((record) => record.event === "verification").length, 0);
});

test("zero exit codes reset the write window", (t) => {
  for (const key of ["exitCode", "exit_code", "code", "returnCode"]) {
    const sandbox = makeSandbox(t);
    for (let index = 0; index < 5; index += 1) {
      run(sandbox, writePayload(sandbox));
    }
    run(sandbox, verificationPayload(sandbox, { toolResponse: { [key]: 0 } }));
    assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 0, key);
  }
});

test("a passing verification without writes records evidence without creating state", (t) => {
  const sandbox = makeSandbox(t);
  const verification = run(sandbox, verificationPayload(sandbox));
  assert.strictEqual(verification.status, 0);
  assert.strictEqual(verification.stdout, "");
  assert.strictEqual(fs.existsSync(stateFileFor(sandbox, "session-1")), false);
  const [event] = readAuditRecords(sandbox);
  assert.strictEqual(event.event, "verification");
  assert.strictEqual(event.writeCount, 0);
  assert.strictEqual(event.evidence, "exit-status");
});

test("dispatch, verify, and settle records evidence with zero inline writes in both postures", (t) => {
  for (const posture of ["judgment", "strict"]) {
    const sandbox = makeSandbox(t);
    const extraEnv = { FUSION_POSTURE: posture };
    run(sandbox, dispatchPayload(sandbox, { subagentType: "codex:codex-rescue" }), extraEnv);
    const before = readState(sandbox, "session-1");
    assert.strictEqual(before.writesSinceDispatch, 0);
    const result = run(sandbox, verificationPayload(sandbox, { command: "npm test && node fusion-stats.mjs --record fusion-example=accepted" }), extraEnv);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
    assert.deepStrictEqual(readState(sandbox, "session-1"), before);
    const [event] = readAuditRecords(sandbox).filter((record) => record.event === "verification");
    assert.strictEqual(event.writeCount, 0);
    assert.strictEqual(event.dispatchCount, 1);
    assert.strictEqual(event.posture, posture);
    assert.strictEqual(event.evidence, "exit-status");
  }
});

test("an unrecognized Bash command does not reset the write window", (t) => {
  const sandbox = makeSandbox(t);
  for (let index = 0; index < 5; index += 1) {
    run(sandbox, writePayload(sandbox));
  }

  const unrecognized = run(sandbox, verificationPayload(sandbox, { command: "git status --short" }));
  assert.strictEqual(unrecognized.stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 5);
  assert.strictEqual(readAuditRecords(sandbox).filter((record) => record.event === "verification").length, 0);
});

test("a verification reset leaves dispatch and fleet telemetry unchanged", (t) => {
  const sandbox = makeSandbox(t);
  run(sandbox, dispatchPayload(sandbox, { subagentType: "codex:codex-rescue" }));
  for (let index = 0; index < 3; index += 1) {
    run(sandbox, writePayload(sandbox));
  }
  const before = readState(sandbox, "session-1");
  const telemetryBefore = {
    dispatches: before.dispatches,
    dispatchEpoch: before.dispatchEpoch,
    lastDispatchAt: before.lastDispatchAt,
    dispatchLog: before.dispatchLog
  };

  const verification = run(sandbox, verificationPayload(sandbox));
  assert.strictEqual(verification.stdout, "");
  const after = readState(sandbox, "session-1");
  assert.deepStrictEqual(
    {
      dispatches: after.dispatches,
      dispatchEpoch: after.dispatchEpoch,
      lastDispatchAt: after.lastDispatchAt,
      dispatchLog: after.dispatchLog
    },
    telemetryBefore
  );
});

test("strict posture records a passing verification and preserves the strict deny reason", (t) => {
  const sandbox = makeSandbox(t);
  const extraEnv = { FUSION_POSTURE: "strict", FUSION_INLINE_TAIL_ALLOWANCE: "0", FUSION_INLINE_ZERO_DISPATCH_WRITES: "0" };
  for (let index = 0; index < 5; index += 1) {
    run(sandbox, writePayload(sandbox), extraEnv);
  }

  assert.strictEqual(run(sandbox, verificationPayload(sandbox), extraEnv).stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 5);
  const sixth = run(sandbox, writePayload(sandbox), extraEnv);
  assert.strictEqual(
    JSON.parse(sixth.stdout).hookSpecificOutput.permissionDecisionReason,
    tagMessage(
      "inline-guard.write-budget-deny",
      "5 inline writes replayed 2.0M tokens of context this session with zero dispatches. Lanes: quick scoped work goes to the codex quick default gpt-6-sol at effort xhigh; trivial or high volume work goes to the codex volume default gpt-6-luna at effort xhigh; work needing the Claude Code tool surface goes to fusion:claude-worker. The inline replay budget is exhausted. Dispatch an Agent or Task before another main-loop write."
    )
  );
  const [event] = readAuditRecords(sandbox).filter((record) => record.event === "verification");
  assert.strictEqual(event.writeCount, 5);
  assert.strictEqual(event.posture, "strict");
});

test("a new path Write past the budget is silent in judgment posture and denied in strict posture", (t) => {
  for (const [posture, expected] of [
    ["judgment", ""],
    ["strict", "deny"]
  ]) {
    const sandbox = makeSandbox(t);
    const extraEnv = { FUSION_POSTURE: posture, FUSION_INLINE_TAIL_ALLOWANCE: "0" };
    run(sandbox, dispatchPayload(sandbox, { subagentType: "codex:codex-rescue" }), extraEnv);
    for (let index = 0; index < 5; index += 1) {
      run(
        sandbox,
        writePayload(sandbox, { toolName: "Write", filePath: path.join(sandbox.workDir, `${posture}-${index}.txt`), toolInput: { content: "a" } }),
        extraEnv
      );
    }
    const sixth = run(
      sandbox,
      writePayload(sandbox, { toolName: "Write", filePath: path.join(sandbox.workDir, `${posture}-sixth.txt`), toolInput: { content: "a" } }),
      extraEnv
    );
    assert.strictEqual(expected === "" ? sixth.stdout : JSON.parse(sixth.stdout).hookSpecificOutput.permissionDecision, expected, posture);
    assert.strictEqual(readAuditRecords(sandbox).filter((record) => record.event === "zero-dispatch-softened").length, 0, posture);
    assert.strictEqual(readAuditRecords(sandbox).filter((record) => record.event === "deny").length, posture === "strict" ? 1 : 0, posture);
  }
});

test("the write window resets on dispatch and on a passing verification", (t) => {
  const sandbox = makeSandbox(t);
  for (let index = 0; index < 2; index += 1) {
    run(sandbox, writePayload(sandbox, { toolInput: { new_string: "ab" } }));
  }
  const written = readState(sandbox, "session-1");
  assert.strictEqual(written.writesSinceDispatch, 2);
  assert.strictEqual(written.writtenPathSignatures.length, 1);

  run(sandbox, dispatchPayload(sandbox, { subagentType: "codex:codex-rescue" }));
  const dispatched = readState(sandbox, "session-1");
  assert.strictEqual(dispatched.writesSinceDispatch, 0);
  assert.strictEqual(dispatched.writeReplayTokens, 0);
  assert.strictEqual(dispatched.writeTurnKey, null);
  assert.deepStrictEqual(dispatched.writtenPathSignatures, []);

  for (let index = 0; index < 3; index += 1) {
    run(sandbox, writePayload(sandbox, { toolInput: { new_string: "xyz" } }));
  }
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 3);

  run(sandbox, verificationPayload(sandbox));
  const verified = readState(sandbox, "session-1");
  assert.strictEqual(verified.writesSinceDispatch, 0);
  assert.deepStrictEqual(verified.writtenPathSignatures, []);
  assert.strictEqual(verified.writeCount, 5);
});

test("judgment posture uses the exact unverified advisory and the guard omits the retired lane", (t) => {
  const sandbox = makeSandbox(t);
  for (let index = 0; index < 4; index += 1) {
    assert.strictEqual(run(sandbox, writePayload(sandbox)).stdout, "");
  }
  const fifth = run(sandbox, writePayload(sandbox));
  const context = advisoryContext(fifth, "inline-guard.unverified-advisory");
  assert.strictEqual(
    context,
    tagMessage(
      "inline-guard.unverified-advisory",
      "5 main loop writes are unverified in this window, and their turns replayed 2.0M tokens of context. Run this change's verification command once it is coherent, or hand the remaining work to a lane. Lanes: quick scoped work goes to the codex quick default gpt-6-sol at effort xhigh; trivial or high volume work goes to the codex volume default gpt-6-luna at effort xhigh; work needing the Claude Code tool surface goes to fusion:claude-worker. This session has not dispatched yet; if the remaining work splits into independent packages, dispatch them together in one message, and three or more convene /fusion:ultra."
    )
  );
  assert.doesNotMatch(fs.readFileSync(script, "utf8"), /fast-worker/);
});

test("lane hints render the configured codex quick and volume defaults", (t) => {
  const sandbox = makeSandbox(t);
  const routingFile = writeRoutingFixture(sandbox);
  const env = { FUSION_MODEL_ROUTING: routingFile };
  for (let index = 0; index < 4; index += 1) {
    assert.strictEqual(run(sandbox, writePayload(sandbox), env).stdout, "");
  }
  const result = run(sandbox, writePayload(sandbox), env);
  const context = advisoryContext(result, "inline-guard.unverified-advisory");
  assert.match(context, /Lanes: quick scoped work goes to the codex quick default quick-choice at effort high; trivial or high volume work goes to the codex volume default volume-choice at effort low; work needing the Claude Code tool surface goes to fusion:claude-worker\./);
});

test("audit normalization accepts verification posture and every legacy event category", () => {
  const at = "2026-07-30T00:00:00.000Z";
  const verification = {
    at,
    session: "session-1",
    event: "verification",
    lane: "main",
    tool: "Bash",
    writeCount: 5,
    dispatchCount: 2,
    budget: 5,
    mode: "enforce",
    posture: "judgment"
  };
  assert.deepStrictEqual(normalizeAuditEvent(verification), { schemaVersion: 1, ...verification });
  assert.deepStrictEqual(normalizeAuditEvent({ ...verification, messageCode: 4321 }), { schemaVersion: 1, ...verification, messageCode: 4321 });
  assert.strictEqual(normalizeAuditEvent({ ...verification, posture: "reckless" }), null);
  for (const invalidMessageCode of [999, 10000, 4321.5, "4321"]) {
    assert.ok(!Object.hasOwn(normalizeAuditEvent({ ...verification, messageCode: invalidMessageCode }), "messageCode"));
  }

  const legacyEvents = [
    { at, session: "session-1", event: "write", lane: "main", tool: "Edit", path: "file.txt" },
    { at, session: "session-1", event: "tail-allowed", lane: "main", tool: "Edit", path: "file.txt", writeCount: 6, dispatchCount: 1, budget: 5, mode: "enforce", remainingTailSlots: 2 },
    {
      at,
      session: "session-1",
      event: "zero-dispatch-softened",
      lane: "main",
      tool: "Write",
      path: "file.txt",
      writeCount: 6,
      dispatchCount: 0,
      budget: 2_000_000,
      replayTokens: 2_000_000,
      mode: "enforce",
      remainingZeroDispatchWrites: 4,
      remainingZeroDispatchBytes: 100
    },
    { at, session: "session-1", event: "dispatch", lane: "codex", tool: "Agent", description: "legacy dispatch" },
    { at, session: "session-1", event: "warn", lane: "codex", tool: "Agent", reason: "missing-launch-recovered" },
    { at, session: "session-1", event: "deny", lane: "main", tool: "TaskOutput", description: "reaped-worker-redirect", mode: "enforce" },
    { at, session: "session-1", event: "warn", lane: "main", tool: "TaskStop", description: "reaped-worker-redirect", mode: "advisory", suppressed: true },
    { at, session: "session-1", event: "deny", lane: "main", tool: "Edit", path: "file.txt", writeCount: 5, dispatchCount: 1, budget: 5, mode: "enforce" },
    { at, session: "session-1", event: "warn", lane: "main", tool: "Bash", writeCount: 5, dispatchCount: 1, budget: 5, mode: "advisory", suppressed: true }
  ];
  assert.ok(legacyEvents.every((event) => normalizeAuditEvent(event) !== null));
  assert.ok(legacyEvents.every((event) => !Object.hasOwn(normalizeAuditEvent(event), "posture")));
  assert.ok(legacyEvents.every((event) => normalizeAuditEvent({ ...event, messageCode: 1000 }).messageCode === 1000));
  assert.ok(legacyEvents.every((event) => normalizeAuditEvent({ ...event, messageCode: 9999 }).messageCode === 9999));
});

test("dispatch audit keeps only valid assistant message IDs", () => {
  const event = { at: "2026-07-30T00:00:00.000Z", session: "session-1", event: "dispatch", lane: "codex", tool: "SendMessage" };
  for (const messageId of ["message_123-abc", "x".repeat(128)]) {
    assert.strictEqual(normalizeAuditEvent({ ...event, messageId }).messageId, messageId);
  }
  for (const messageId of ["", "x".repeat(129), "contains.dot", "has space", "has\nnewline", 42]) {
    assert.ok(!Object.hasOwn(normalizeAuditEvent({ ...event, messageId }), "messageId"));
  }
});

test("tail allowance environment overrides apply and zero disables it", (t) => {
  for (const { env: overrides, newString, expected } of [
    { env: { FUSION_INLINE_TAIL_MAX_BYTES: "1", FUSION_INLINE_ZERO_DISPATCH_WRITES: "0" }, newString: "xx", expected: "deny" },
    { env: { FUSION_INLINE_TAIL_ALLOWANCE: "0", FUSION_INLINE_ZERO_DISPATCH_WRITES: "0" }, newString: "x", expected: "deny" },
    { env: { FUSION_INLINE_TAIL_ALLOWANCE: "1", FUSION_INLINE_ZERO_DISPATCH_WRITES: "0" }, newString: "x", expected: undefined }
  ]) {
    const env = { FUSION_POSTURE: "strict", ...overrides };
    const sandbox = makeSandbox(t);
    run(sandbox, dispatchPayload(sandbox, { subagentType: "fusion:claude-worker" }), env);
    for (let index = 0; index < 5; index += 1) {
      run(sandbox, writePayload(sandbox, { toolInput: { new_string: "base" } }), env);
    }
    const result = run(sandbox, writePayload(sandbox, { toolInput: { new_string: newString } }), env);
    if (expected === undefined) {
      advisoryContext(result, "inline-guard.tail-allowance-advisory");
    } else {
      assert.strictEqual(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, expected);
    }
  }
});

test("a PostToolUse-only dispatch recovers a missing launch and reopens an exhausted write budget", (t) => {
  const sandbox = makeSandbox(t);
  const strictEnv = { FUSION_POSTURE: "strict", FUSION_INLINE_ZERO_DISPATCH_WRITES: "0" };
  for (let index = 0; index < 5; index += 1) {
    run(sandbox, writePayload(sandbox), strictEnv);
  }
  const denied = run(sandbox, writePayload(sandbox), strictEnv);
  assert.strictEqual(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");

  const recovered = runRaw(sandbox, dispatchPayload(sandbox, { subagentType: "fusion:claude-worker", description: "recover the missing launch" }), strictEnv);
  assert.strictEqual(recovered.status, 0);
  assert.strictEqual(recovered.stdout, "");
  assert.strictEqual(recovered.stderr, "");

  const recoveredState = readState(sandbox, "session-1");
  assert.strictEqual(recoveredState.writesSinceDispatch, 0);
  assert.strictEqual(recoveredState.dispatchEpoch, 1);
  assert.deepStrictEqual(recoveredState.dispatches, { "fusion:claude-worker": 1 });
  assert.strictEqual(recoveredState.dispatchLog.length, 1);
  assert.strictEqual(recoveredState.dispatchLog[0].phase, "confirmed");
  assert.strictEqual(recoveredState.dispatchLog[0].description, "recover the missing launch");

  const recoveryWarnings = readAuditRecords(sandbox).filter((record) => record.event === "warn" && record.reason === "missing-launch-recovered");
  assert.deepStrictEqual(recoveryWarnings, [
    {
      schemaVersion: 1,
      at: recoveryWarnings[0].at,
      session: "session-1",
      event: "warn",
      lane: "fusion:claude-worker",
      tool: "Agent",
      reason: "missing-launch-recovered",
      posture: "strict"
    }
  ]);

  const allowed = run(sandbox, writePayload(sandbox), strictEnv);
  assert.strictEqual(allowed.stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 1);
});

test("strict posture fails closed when guard state is unavailable while judgment posture fails open", (t) => {
  const sandbox = makeSandbox(t);
  fs.writeFileSync(sandbox.stateDir, "not a directory", "utf8");
  const denied = run(sandbox, writePayload(sandbox), { FUSION_POSTURE: "strict" });
  assert.strictEqual(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  const deniedReason = JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(deniedReason, /state is unavailable/);
  assertMessageTagged(deniedReason, "inline-guard.state-unavailable-deny");

  const judgment = run(sandbox, writePayload(sandbox));
  assert.strictEqual(judgment.stdout, "");
});

test("strict enforcement rejects malformed, truncated, and array state without resetting the write budget", (t) => {
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

    const denied = run(sandbox, writePayload(sandbox), { FUSION_POSTURE: "strict" });
    assert.strictEqual(denied.status, 0, name);
    assert.strictEqual(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny", name);
    const deniedReason = JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason;
    assert.match(deniedReason, /state is unavailable/, name);
    assertMessageTagged(deniedReason, "inline-guard.state-unavailable-deny");
    assert.strictEqual(fs.readFileSync(file, "utf8"), contents, name);
    assert.deepStrictEqual(readAuditRecords(sandbox), [], name);

    const judgment = run(sandbox, writePayload(sandbox));
    assert.strictEqual(judgment.status, 0, name);
    assert.strictEqual(judgment.stdout, "", name);
    assert.strictEqual(fs.readFileSync(file, "utf8"), contents, name);
  }
});

test("the fifth write under the default budget attaches one advisory and audits a warning alongside the write", (t) => {
  const sandbox = makeSandbox(t);
  for (let i = 0; i < 4; i += 1) {
    const result = run(sandbox, writePayload(sandbox));
    assert.strictEqual(result.stdout, "");
  }
  const fifth = run(sandbox, writePayload(sandbox));
  assert.strictEqual(fifth.status, 0);
  const output = JSON.parse(fifth.stdout);
  assert.strictEqual(output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(advisoryContext(fifth, "inline-guard.unverified-advisory"), /^5 main loop writes are unverified in this window, and their turns replayed 2\.0M tokens of context\./);
  const records = readAuditRecords(sandbox);
  assert.strictEqual(records.filter((record) => record.event === "write").length, 5);
  const warnings = records.filter((record) => record.event === "warn");
  assert.strictEqual(warnings.length, 1);
  assert.deepStrictEqual(warnings[0], {
    schemaVersion: 1,
    at: warnings[0].at,
    session: "session-1",
    event: "warn",
    lane: "main",
    tool: "Edit",
    path: "file.txt",
    writeCount: 5,
    dispatchCount: 0,
    budget: 2_000_000,
    replayTokens: 2_000_000,
    mode: "advisory",
    posture: "judgment",
    messageCode: messageCode("inline-guard.unverified-advisory")
  });
});

test("judgment advisories fire at 1x, 2x, 4x, 8x, and 16x the budget", (t) => {
  const sandbox = makeSandbox(t);
  for (let i = 1; i <= 80; i += 1) {
    const result = run(sandbox, writePayload(sandbox));
    if ([5, 10, 20, 40, 80].includes(i)) {
      assert.match(advisoryContext(result, "inline-guard.unverified-advisory"), new RegExp(`^${i} main loop writes are unverified in this window, and their turns replayed ${(i * 0.4).toFixed(1).replace(".", "\\.")}M tokens of context\\.`));
    } else {
      assert.strictEqual(result.stdout, "", `write ${i} should stay silent`);
    }
  }
  const state = readState(sandbox, "session-1");
  assert.deepStrictEqual(state.advisedMultiples, [1, 2, 4, 8, 16]);
  assert.deepStrictEqual(readAuditRecords(sandbox).filter((record) => record.event === "warn").map((record) => record.writeCount), [5, 10, 20, 40, 80]);
});

test("advisories count writes since the most recent dispatch and restart after each dispatch", (t) => {
  const sandbox = makeSandbox(t);
  const dispatchResult = run(sandbox, dispatchPayload(sandbox, { subagentType: "fusion:claude-worker" }));
  assert.strictEqual(dispatchResult.status, 0);
  assert.strictEqual(dispatchResult.stdout, "");

  for (let i = 0; i < 4; i += 1) {
    const result = run(sandbox, writePayload(sandbox));
    assert.strictEqual(result.stdout, "", `write ${i + 1} after the first dispatch should stay silent`);
  }
  const fifth = run(sandbox, writePayload(sandbox));
  const fifthReason = advisoryContext(fifth, "inline-guard.unverified-advisory");
  assert.match(fifthReason, /^5 main loop writes are unverified in this window, and their turns replayed 2\.0M tokens of context\./);
  assert.doesNotMatch(fifthReason, /This session has not dispatched yet;/);
  assertMessageTagged(fifthReason, "inline-guard.unverified-advisory");

  run(sandbox, dispatchPayload(sandbox, { subagentType: "codex:codex-rescue" }));
  for (let i = 0; i < 4; i += 1) {
    const result = run(sandbox, writePayload(sandbox));
    assert.strictEqual(result.stdout, "", `write ${i + 1} after the second dispatch should stay silent`);
  }
  const nextFifth = run(sandbox, writePayload(sandbox));
  const nextFifthReason = advisoryContext(nextFifth, "inline-guard.unverified-advisory");
  assert.match(nextFifthReason, /^5 main loop writes are unverified in this window, and their turns replayed 2\.0M tokens of context\./);
  assert.doesNotMatch(nextFifthReason, /This session has not dispatched yet;/);
  assertMessageTagged(nextFifthReason, "inline-guard.unverified-advisory");

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
  run(sandbox, dispatchPayload(sandbox, { subagentType: "fusion:claude-worker" }));
  run(sandbox, dispatchPayload(sandbox, { subagentType: "fusion:trivial-worker" }));
  run(sandbox, dispatchPayload(sandbox, { subagentType: "Explore" }));
  run(sandbox, dispatchPayload(sandbox, { subagentType: null }));

  const state = readState(sandbox, "session-1");
  assert.deepStrictEqual(state.dispatches, {
    grok: 2,
    codex: 1,
    "fusion:claude-worker": 1,
    "fusion:trivial-worker": 1,
    builtin: 2
  });
});

test("generic Agent launches advise on PostToolUse without denying the dispatch", (t) => {
  for (const subagentType of ["fork", "general-purpose", "claude", null]) {
    const sandbox = makeSandbox(t);
    const payload = dispatchPayload(sandbox, { subagentType });
    const launch = runRaw(sandbox, { ...payload, hook_event_name: "PreToolUse" });
    assert.strictEqual(launch.stdout, "");
    const result = runRaw(sandbox, payload);
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    assert.strictEqual(output.hookEventName, "PostToolUse");
    assert.strictEqual(output.permissionDecision, undefined);
    assertMessageTagged(output.additionalContext, "inline-guard.generic-agent-advisory");
    assert.match(output.additionalContext, /outside Fusion collection and settlement/);
    assert.match(output.additionalContext, /codex:codex-rescue/);
    assert.match(output.additionalContext, /fusion:claude-worker/);
    assert.match(output.additionalContext, /Explore for read only search/);
    assert.strictEqual(readState(sandbox, "session-1").dispatches.builtin, 1);
  }
});

test("tracked agents, Explore, Task, and subagent launches do not receive the generic Agent advisory", (t) => {
  for (const options of [
    { subagentType: "codex:codex-rescue" },
    { subagentType: "fusion:claude-worker" },
    { subagentType: "Explore" },
    { toolName: "Task", subagentType: "fork" },
    { subagentType: "fork", agentId: "nested-agent" }
  ]) {
    const sandbox = makeSandbox(t);
    assert.strictEqual(run(sandbox, dispatchPayload(sandbox, options)).stdout, "");
  }
});

test("a Task dispatch is bucketed the same way as an Agent dispatch", (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, dispatchPayload(sandbox, { toolName: "Task", subagentType: "codex:codex-rescue" }));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  const state = readState(sandbox, "session-1");
  assert.deepStrictEqual(state.dispatches, { codex: 1 });
});

test("launch timestamps remain in the dispatch ledger when confirmations span ten minutes", (t) => {
  const sandbox = makeSandbox(t);
  const baseMs = Date.parse("2026-07-21T00:00:00.000Z");
  const payloads = Array.from({ length: 4 }, (_, index) =>
    dispatchPayload(sandbox, { subagentType: "fusion:claude-worker", description: `package ${index + 1}` })
  );

  for (const [index, payload] of payloads.entries()) {
    const launched = runRaw(sandbox, { ...payload, hook_event_name: "PreToolUse" }, { FUSION_TEST_NOW: new Date(baseMs + index * 1000).toISOString() });
    assert.strictEqual(launched.status, 0);
    assert.strictEqual(launched.stdout, "");
  }

  for (const [index, payload] of payloads.entries()) {
    const confirmed = runRaw(sandbox, payload, { FUSION_TEST_NOW: new Date(baseMs + index * 200000).toISOString() });
    assert.strictEqual(confirmed.status, 0);
    assert.strictEqual(confirmed.stdout, "");
  }

  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.dispatchLog.length, 4);
  assert.ok(state.dispatchLog.every((entry) => entry.phase === "confirmed"));
  assert.deepStrictEqual(
    state.dispatchLog.map((entry) => entry.at),
    Array.from({ length: 4 }, (_, index) => new Date(baseMs + index * 1000).toISOString())
  );
});

test("an Agent PreToolUse attempt does not reset the write window before dispatch succeeds", (t) => {
  const sandbox = makeSandbox(t);
  const strictEnv = { FUSION_POSTURE: "strict", FUSION_INLINE_ZERO_DISPATCH_WRITES: "0" };
  for (let index = 0; index < 5; index += 1) {
    run(sandbox, writePayload(sandbox), strictEnv);
  }
  const attempted = dispatchPayload(sandbox, { subagentType: "fusion:claude-worker" });
  attempted.hook_event_name = "PreToolUse";
  run(sandbox, attempted, strictEnv);

  assert.deepStrictEqual(readState(sandbox, "session-1").dispatches, {});
  assert.strictEqual(readState(sandbox, "session-1").dispatchLog[0].phase, "launched");
  const denied = run(sandbox, writePayload(sandbox), strictEnv);
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
    phase: "confirmed",
    toolUseId: state.dispatchLog[0].toolUseId,
    subagentType: "grok:grok-rescue",
    description: "inspect the failure"
  });
  assert.deepStrictEqual(state.dispatchLog[1], {
    at: state.dispatchLog[1].at,
    lane: "codex",
    phase: "confirmed",
    toolUseId: state.dispatchLog[1].toolUseId,
    subagentType: "codex:codex-rescue",
    description: "implement the repair"
  });
});

test("assistant message IDs remain on dispatch records across time gaps", (t) => {
  const sandbox = makeSandbox(t);
  const first = dispatchPayload(sandbox, { subagentType: "codex:codex-rescue" });
  const second = dispatchPayload(sandbox, { subagentType: "grok:grok-rescue" });
  const third = dispatchPayload(sandbox, { subagentType: "codex:codex-rescue" });
  writeDispatchTranscript(sandbox, [
    { messageId: "wave_one", payloads: [first, second] },
    { messageId: "wave_two", payloads: [third] }
  ]);
  const baseMs = Date.parse("2026-07-21T00:00:00.000Z");
  const at = (offset) => ({ FUSION_TEST_NOW: new Date(baseMs + offset).toISOString() });

  assert.strictEqual(run(sandbox, first, at(0)).stdout, "");
  assert.strictEqual(run(sandbox, second, at(15000)).stdout, "");
  let state = readState(sandbox, "session-1");
  assert.deepStrictEqual(state.dispatchLog.map((entry) => entry.messageId), ["wave_one", "wave_one"]);

  assert.strictEqual(run(sandbox, third, at(16000)).stdout, "");
  state = readState(sandbox, "session-1");
  assert.deepStrictEqual(readAuditRecords(sandbox).filter((event) => event.event === "dispatch").map((event) => event.messageId), ["wave_one", "wave_one", "wave_two"]);
});

test("missing transcripts and invalid assistant IDs leave messageId absent", (t) => {
  const sandbox = makeSandbox(t);
  const missing = dispatchPayload(sandbox);
  assert.strictEqual(run(sandbox, missing).stdout, "");
  const invalid = dispatchPayload(sandbox);
  writeDispatchTranscript(sandbox, [{ messageId: "invalid.id", payloads: [invalid] }]);
  assert.strictEqual(run(sandbox, invalid).stdout, "");
  assert.ok(readState(sandbox, "session-1").dispatchLog.every((entry) => !Object.hasOwn(entry, "messageId")));
  assert.ok(readAuditRecords(sandbox).filter((event) => event.event === "dispatch").every((event) => !Object.hasOwn(event, "messageId")));
});

test("SendMessage continuations of same-session rescue wrappers count as dispatches", (t) => {
  const sandbox = makeSandbox(t);
  const jobsDir = path.join(sandbox.root, "workers", "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, "fusion-codex.json"), JSON.stringify({ taskId: "fusion-codex", sessionId: "session-1", agentType: "codex:codex-rescue", agentId: "codex-agent", backgroundTaskId: "codex-task", transportStatus: "done" }));
  fs.writeFileSync(path.join(jobsDir, "fusion-claude.json"), JSON.stringify({ taskId: "fusion-claude", sessionId: "session-1", agentType: "fusion:claude-worker", agentId: "claude-agent", transportStatus: "done" }));
  fs.writeFileSync(path.join(jobsDir, "fusion-other.json"), JSON.stringify({ taskId: "fusion-other", sessionId: "other-session", agentType: "grok:grok-rescue", agentId: "other-agent", transportStatus: "done" }));
  const env = { FUSION_WORKER_STATE_DIR: path.dirname(jobsDir) };
  const continuation = { ...dispatchPayload(sandbox, { toolName: "SendMessage" }), tool_input: { to: "codex-task", message: "continue" } };
  const agentContinuation = { ...dispatchPayload(sandbox, { toolName: "SendMessage" }), tool_input: { to: "codex-agent", message: "continue again" } };
  writeDispatchTranscript(sandbox, [{ messageId: "continuation_1", payloads: [continuation, agentContinuation] }]);

  for (const to of ["other-agent", "unknown-agent"]) {
    const ignored = { ...continuation, tool_input: { to, message: "continue" } };
    assert.strictEqual(runRaw(sandbox, { ...ignored, hook_event_name: "PreToolUse" }, env).stdout, "");
    assert.strictEqual(runRaw(sandbox, ignored, env).stdout, "");
  }
  assert.strictEqual(readState(sandbox, "session-1").writeCount, 0);
  assert.deepStrictEqual(readState(sandbox, "session-1").dispatches, {});
  assertSingleReplay(sandbox, "SendMessage", "dispatch");

  assert.strictEqual(runRaw(sandbox, { ...continuation, hook_event_name: "PreToolUse" }, env).stdout, "");
  assert.strictEqual(runRaw(sandbox, continuation, env).stdout, "");
  assert.strictEqual(runRaw(sandbox, { ...agentContinuation, hook_event_name: "PreToolUse" }, env).stdout, "");
  assert.strictEqual(runRaw(sandbox, agentContinuation, env).stdout, "");
  const state = readState(sandbox, "session-1");
  assert.deepStrictEqual(state.dispatches, { codex: 2 });
  assert.strictEqual(state.dispatchLog[0].lane, "codex");
  assert.strictEqual(state.dispatchLog[0].messageId, "continuation_1");
  assert.deepStrictEqual(readAuditRecords(sandbox).filter((event) => event.event === "dispatch").map((event) => ({ tool: event.tool, lane: event.lane, messageId: event.messageId })), [
    { tool: "SendMessage", lane: "codex", messageId: "continuation_1" },
    { tool: "SendMessage", lane: "codex", messageId: "continuation_1" }
  ]);
});

test("same-session Fusion worker SendMessage continuation counts as a dispatch", (t) => {
  const sandbox = makeSandbox(t);
  const jobsDir = path.join(sandbox.root, "workers", "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, "fusion-claude.json"), JSON.stringify({ taskId: "fusion-claude", sessionId: "session-1", agentType: "fusion:claude-worker", agentId: "claude-agent", backgroundTaskId: "claude-task", transportStatus: "done" }));
  const env = { FUSION_WORKER_STATE_DIR: path.dirname(jobsDir) };
  const continuation = { ...dispatchPayload(sandbox, { toolName: "SendMessage" }), tool_input: { to: "claude-task", message: "continue" } };
  writeDispatchTranscript(sandbox, [{ messageId: "fusion_continuation", payloads: [continuation] }]);

  assert.strictEqual(runRaw(sandbox, { ...continuation, hook_event_name: "PreToolUse" }, env).stdout, "");
  assert.strictEqual(runRaw(sandbox, continuation, env).stdout, "");
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.dispatchLog.length, 1);
  assert.strictEqual(state.dispatchLog[0].subagentType, "fusion:claude-worker");
  assert.strictEqual(state.dispatchLog[0].messageId, "fusion_continuation");
  assert.deepStrictEqual(readAuditRecords(sandbox).filter((event) => event.event === "dispatch").map((event) => ({ tool: event.tool, lane: event.lane, messageId: event.messageId })), [
    { tool: "SendMessage", lane: "fusion:claude-worker", messageId: "fusion_continuation" }
  ]);
});

test("writes and dispatches append minimal long-term audit records", (t) => {
  const sandbox = makeSandbox(t);
  const target = path.join(sandbox.workDir, "nested", "file.txt");
  run(sandbox, dispatchPayload(sandbox, { subagentType: "grok:grok-rescue", description: "inspect the failure" }));
  run(sandbox, dispatchPayload(sandbox, { toolName: "Task", subagentType: "codex:codex-rescue", description: "implement the repair" }));
  run(sandbox, writePayload(sandbox, { filePath: target }));

  const { events, malformedCount } = readAuditEvents({ auditDir: sandbox.auditDir });
  const records = events.filter((event) => event.event !== "replay");
  assert.strictEqual(events.filter((event) => event.event === "replay").length, 1);
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
    subagentType: "fusion:claude-worker",
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

test("enforcement audit records omit unsafe paths", (t) => {
  const sandbox = makeSandbox(t);
  const strictEnv = { FUSION_POSTURE: "strict", FUSION_INLINE_ZERO_DISPATCH_WRITES: "0" };
  const pathSecret = `sk-${"z".repeat(40)}`;
  for (let index = 0; index < 4; index += 1) {
    run(sandbox, writePayload(sandbox), strictEnv);
  }
  const unsafeWrite = writePayload(sandbox, { filePath: path.join(sandbox.workDir, pathSecret) });
  run(sandbox, unsafeWrite, strictEnv);
  run(sandbox, unsafeWrite, strictEnv);

  const enforcement = readAuditRecords(sandbox).filter((record) => record.event === "warn" || record.event === "deny");
  assert.strictEqual(enforcement.length, 2);
  assert.ok(enforcement.every((record) => !Object.hasOwn(record, "path")));
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
  assert.deepStrictEqual(readAuditRecords(sandbox).map((record) => record.lane), ["main", "builtin", "builtin", "builtin", "builtin"]);
  assert.strictEqual(readAuditRecords(sandbox)[0].event, "replay");
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

  run(sandbox, dispatchPayload(sandbox, { toolName: "Task", subagentType: "fusion:claude-worker" }));
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.writeCount, 4);
  assert.deepStrictEqual(state.dispatches, { grok: 2, "fusion:claude-worker": 1 });
  assert.strictEqual(state.dispatchLog.length, 1);
  assert.strictEqual(state.dispatchLog[0].lane, "fusion:claude-worker");
});

test("legacy dispatch ledger entries normalize as confirmed launches", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.stateDir, { recursive: true });
  fs.writeFileSync(
    stateFileFor(sandbox, "session-1"),
    JSON.stringify({
      writeCount: 0,
      writesSinceDispatch: 0,
      dispatches: { builtin: 2 },
      dispatchLog: [
        { at: "2026-07-21T00:00:00.000Z", lane: "builtin", description: "first legacy launch" },
        { at: "2026-07-21T00:03:00.000Z", lane: "builtin", description: "second legacy launch" }
      ],
      advisedMultiples: [],
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:03:00.000Z"
    }),
    "utf8"
  );

  const result = run(sandbox, writePayload(sandbox));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stderr, "");
  const state = readState(sandbox, "session-1");
  assert.ok(state.dispatchLog.every((entry) => entry.phase === "confirmed"));
  assert.ok(state.dispatchLog.every((entry) => !Object.hasOwn(entry, "toolUseId")));
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

test("out-of-workspace writes are audited as exempt without entering either posture's window", (t) => {
  const sandbox = makeSandbox(t);
  const writes = [
    { toolName: "Edit", filePath: "/Users/x/.claude/projects/slug/memory/note.md" },
    { toolName: "Write", filePath: path.join(os.tmpdir(), "raw-args-transport", "payload.json"), toolInput: { content: "[]" } }
  ];
  for (const posture of ["judgment", "strict"]) {
    for (const write of writes) {
      const result = run(sandbox, writePayload(sandbox, write), { FUSION_POSTURE: posture });
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, "");
    }
  }
  assert.strictEqual(readState(sandbox, "session-1").writeCount, 0);
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 0);
  assert.strictEqual(readState(sandbox, "session-1").turn.kind, "other");
  const records = readAuditRecords(sandbox).filter((event) => event.event !== "replay");
  assert.strictEqual(readAuditRecords(sandbox).filter((event) => event.event === "replay").length, 1);
  assert.strictEqual(records.length, 4);
  assert.ok(records.every((record) => record.event === "write" && record.exempt === "out-of-workspace" && !Object.hasOwn(record, "path")));

  const inWorkspace = run(sandbox, writePayload(sandbox, { filePath: "repo-relative.txt" }));
  assert.strictEqual(inWorkspace.status, 0);
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 1);
  assert.deepStrictEqual(readAuditRecords(sandbox).at(-1), {
    schemaVersion: 1,
    at: readAuditRecords(sandbox).at(-1).at,
    session: "session-1",
    event: "write",
    lane: "main",
    tool: "Edit",
    path: "repo-relative.txt"
  });
});

test("FUSION_LOCK_TIMEOUT_MS overrides the default lock timeout", () => {
  assert.strictEqual(resolveLockTimeoutMs({ FUSION_LOCK_TIMEOUT_MS: "1" }), 1);
  assert.strictEqual(resolveLockTimeoutMs({ FUSION_LOCK_TIMEOUT_MS: "7500" }), 7500);
  assert.strictEqual(DEFAULT_LOCK_TIMEOUT_MS, 5000);
});

test("an invalid FUSION_LOCK_TIMEOUT_MS falls back to the default", () => {
  assert.strictEqual(resolveLockTimeoutMs({}), DEFAULT_LOCK_TIMEOUT_MS);
  assert.strictEqual(resolveLockTimeoutMs({ FUSION_LOCK_TIMEOUT_MS: "invalid" }), DEFAULT_LOCK_TIMEOUT_MS);
  assert.strictEqual(resolveLockTimeoutMs({ FUSION_LOCK_TIMEOUT_MS: "0" }), DEFAULT_LOCK_TIMEOUT_MS);
  assert.strictEqual(resolveLockTimeoutMs({ FUSION_LOCK_TIMEOUT_MS: "-5" }), DEFAULT_LOCK_TIMEOUT_MS);
  assert.strictEqual(resolveLockTimeoutMs({ FUSION_LOCK_TIMEOUT_MS: "1.5" }), DEFAULT_LOCK_TIMEOUT_MS);
});

test("inline relief environment values accept overrides, preserve zero, and reject invalid values", () => {
  assert.strictEqual(resolveTailMaxBytes({ FUSION_INLINE_TAIL_MAX_BYTES: "512" }), 512);
  assert.strictEqual(resolveTailAllowance({ FUSION_INLINE_TAIL_ALLOWANCE: "0" }), 0);
  assert.strictEqual(resolveZeroDispatchMaxBytes({ FUSION_INLINE_ZERO_DISPATCH_MAX_BYTES: "8192" }), 8192);
  assert.strictEqual(resolveZeroDispatchWrites({ FUSION_INLINE_ZERO_DISPATCH_WRITES: "0" }), 0);
  assert.strictEqual(resolveTailMaxBytes({ FUSION_INLINE_TAIL_MAX_BYTES: "invalid" }), 1024);
  assert.strictEqual(resolveTailAllowance({ FUSION_INLINE_TAIL_ALLOWANCE: "-1" }), 3);
  assert.strictEqual(resolveZeroDispatchMaxBytes({ FUSION_INLINE_ZERO_DISPATCH_MAX_BYTES: "1.5" }), 16384);
  assert.strictEqual(resolveZeroDispatchWrites({ FUSION_INLINE_ZERO_DISPATCH_WRITES: "not-a-number" }), 10);
});

test("FUSION_INLINE_REPLAY_BUDGET_TOKENS overrides the default threshold", (t) => {
  const sandbox = makeSandbox(t);
  const extraEnv = { FUSION_INLINE_REPLAY_BUDGET_TOKENS: "800000" };
  const first = run(sandbox, writePayload(sandbox), extraEnv);
  const second = run(sandbox, writePayload(sandbox), extraEnv);
  assert.strictEqual(first.stdout, "");
  const secondReason = advisoryContext(second, "inline-guard.unverified-advisory");
  assert.match(secondReason, /^2 main loop writes are unverified in this window, and their turns replayed 800k tokens of context\./);
  assertMessageTagged(secondReason, "inline-guard.unverified-advisory");
});

test("a nonsense FUSION_INLINE_REPLAY_BUDGET_TOKENS value falls back to the default of 2,000,000 tokens", (t) => {
  const sandbox = makeSandbox(t);
  const extraEnv = { FUSION_INLINE_REPLAY_BUDGET_TOKENS: "not-a-number" };
  for (let i = 0; i < 4; i += 1) {
    const result = run(sandbox, writePayload(sandbox), extraEnv);
    assert.strictEqual(result.stdout, "");
  }
  const fifth = run(sandbox, writePayload(sandbox), extraEnv);
  const reason = advisoryContext(fifth, "inline-guard.unverified-advisory");
  assert.match(reason, /^5 main loop writes are unverified in this window, and their turns replayed 2\.0M tokens of context\./);
  assertMessageTagged(reason, "inline-guard.unverified-advisory");
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

test("stale state pruning skips a file held by another process", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.stateDir, { recursive: true });
  const staleFile = stateFileFor(sandbox, "old-session");
  fs.writeFileSync(staleFile, "{}", "utf8");
  const oldTime = new Date(Date.now() - 49 * 60 * 60 * 1000);
  fs.utimesSync(staleFile, oldTime, oldTime);
  fs.writeFileSync(`${staleFile}.lock`, "other-process", "utf8");
  run(sandbox, writePayload(sandbox, { sessionId: "session-2" }));
  assert.strictEqual(fs.existsSync(staleFile), true);
  fs.rmSync(`${staleFile}.lock`);
  run(sandbox, writePayload(sandbox, { sessionId: "session-2" }));
  assert.strictEqual(fs.existsSync(staleFile), false);
});

test("failed write callbacks undo only their matching unverified call", (t) => {
  const sandbox = makeSandbox(t);
  const first = { ...writePayload(sandbox), tool_use_id: "write-first" };
  const second = { ...writePayload(sandbox), tool_use_id: "write-second" };
  assert.strictEqual(run(sandbox, first).status, 0);
  assert.strictEqual(run(sandbox, second).status, 0);
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 2);
  assert.strictEqual(run(sandbox, { ...first, hook_event_name: "PostToolUseFailure" }).stdout, "");
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.writeCount, 1);
  assert.strictEqual(state.writesSinceDispatch, 1);
  assert.strictEqual(state.pendingWrites.length, 1);
  run(sandbox, { ...first, hook_event_name: "PostToolUseFailure" });
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 1);
  run(sandbox, { ...second, hook_event_name: "PostToolUse" });
  run(sandbox, { ...second, hook_event_name: "PostToolUseFailure" });
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 1);
});

test("two failed calls to the same path leave no tail allowance path", (t) => {
  const sandbox = makeSandbox(t);
  const first = { ...writePayload(sandbox), tool_use_id: "first" };
  const second = { ...first, tool_use_id: "second" };
  run(sandbox, first);
  run(sandbox, second);
  run(sandbox, { ...first, hook_event_name: "PostToolUseFailure" });
  run(sandbox, { ...second, hook_event_name: "PostToolUseFailure" });
  assert.deepStrictEqual(readState(sandbox, "session-1").writtenPathSignatures, []);
});

test("failure callbacks release Edit, Write, NotebookEdit, and MultiEdit counts", (t) => {
  const sandbox = makeSandbox(t);
  for (const toolName of ["Edit", "Write", "NotebookEdit", "MultiEdit"]) {
    const payload = { ...writePayload(sandbox, { toolName, filePath: path.join(sandbox.workDir, `${toolName}.txt`) }), tool_use_id: `id-${toolName}` };
    run(sandbox, payload, { FUSION_INLINE_REPLAY_BUDGET_TOKENS: "8000000" });
    run(sandbox, { ...payload, hook_event_name: "PostToolUseFailure" }, { FUSION_INLINE_REPLAY_BUDGET_TOKENS: "8000000" });
    assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 0, toolName);
  }
  assert.strictEqual(readState(sandbox, "session-1").writeCount, 0);
});

test("failed write releases its byte and tail allowance accounting", (t) => {
  const sandbox = makeSandbox(t);
  const payload = { ...writePayload(sandbox, { toolInput: { old_string: "a", new_string: "updated" } }), tool_use_id: "failed-tail" };
  run(sandbox, payload);
  const before = readState(sandbox, "session-1");
  assert.ok(before.inlineWriteBytes > 0);
  run(sandbox, { ...payload, hook_event_name: "PostToolUseFailure" });
  const after = readState(sandbox, "session-1");
  assert.strictEqual(after.inlineWriteBytes, 0);
  assert.deepStrictEqual(after.writtenPathSignatures, []);
});

test("audit appends after a malformed trailing line and readers skip only the damaged record", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.auditDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(sandbox.auditDir, `events-${date}.jsonl`);
  fs.writeFileSync(file, "{ malformed", "utf8");

  run(sandbox, writePayload(sandbox));
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines[0], "{ malformed");
  const audit = readAuditEvents({ auditDir: sandbox.auditDir });
  assert.strictEqual(audit.events.length, 2);
  assert.deepStrictEqual(audit.events.map((event) => event.event), ["replay", "write"]);
  assert.strictEqual(audit.malformedCount, 1);
});

test("audit rotates by size without losing valid enforcement records", (t) => {
  const sandbox = makeSandbox(t);
  const extraEnv = { FUSION_POSTURE: "strict", FUSION_INLINE_GUARD_AUDIT_MAX_BYTES: "1", FUSION_INLINE_GUARD_AUDIT_MAX_FILES: "20", FUSION_INLINE_ZERO_DISPATCH_WRITES: "0" };
  for (let index = 0; index < 6; index += 1) {
    run(sandbox, writePayload(sandbox), extraEnv);
  }

  const audit = readAuditEvents({ auditDir: sandbox.auditDir });
  assert.strictEqual(auditFiles(sandbox).length, 13);
  assert.strictEqual(audit.events.length, 13);
  assert.strictEqual(audit.events.filter((event) => event.event === "replay").length, 6);
  assert.strictEqual(audit.events.filter((event) => event.event === "write").length, 5);
  assert.strictEqual(audit.events.filter((event) => event.event === "warn").length, 1);
  assert.strictEqual(audit.events.filter((event) => event.event === "deny").length, 1);
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
  assert.deepStrictEqual(readAuditEvents({ auditDir: sandbox.auditDir }).events.map((event) => event.event), ["replay", "write"]);
});

test("audit pointer avoids a segment scan and retention waits for its hourly stamp", (t) => {
  const sandbox = makeSandbox(t);
  const start = "2026-07-21T00:00:00.000Z";
  const later = "2026-07-21T01:01:00.000Z";
  assert.strictEqual(run(sandbox, writePayload(sandbox), { FUSION_TEST_NOW: start }).status, 0);
  const pointer = path.join(sandbox.auditDir, ".current");
  const stamp = path.join(sandbox.auditDir, ".retention-stamp");
  assert.strictEqual(fs.readFileSync(pointer, "utf8").trim(), "events-2026-07-21.jsonl");
  const stampTime = fs.statSync(stamp).mtimeMs;
  const staleFile = path.join(sandbox.auditDir, "events-2020-01-01.jsonl");
  fs.writeFileSync(staleFile, "old\n");
  fs.utimesSync(staleFile, new Date("2020-01-01"), new Date("2020-01-01"));
  run(sandbox, writePayload(sandbox), { FUSION_TEST_NOW: "2026-07-21T00:01:00.000Z", FUSION_INLINE_GUARD_AUDIT_RETENTION_DAYS: "1" });
  assert.strictEqual(fs.existsSync(staleFile), true);
  assert.strictEqual(fs.statSync(stamp).mtimeMs, stampTime);
  run(sandbox, writePayload(sandbox), { FUSION_TEST_NOW: later, FUSION_INLINE_GUARD_AUDIT_RETENTION_DAYS: "1" });
  assert.strictEqual(fs.existsSync(staleFile), false);
  const records = readAuditEvents({ auditDir: sandbox.auditDir }).events;
  assert.strictEqual(records.length, 6);
  assert.strictEqual(records.filter((event) => event.event === "replay").length, 3);
  assert.strictEqual(records.filter((event) => event.event === "write").length, 3);
});

test("concurrent hook invocations serialize dispatch and write increments", async (t) => {
  const sandbox = makeSandbox(t);
  const extraEnv = { FUSION_INLINE_REPLAY_BUDGET_TOKENS: "400000000" };
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
  assert.strictEqual(audit.events.filter((event) => event.event !== "replay").length, 32);
  assert.ok(audit.events.some((event) => event.event === "replay"));
  assert.strictEqual(audit.malformedCount, 0);
  assert.strictEqual(audit.events.filter((record) => record.event === "write").length, 16);
  assert.strictEqual(audit.events.filter((record) => record.event === "dispatch").length, 16);
  assert.strictEqual(fs.existsSync(path.join(sandbox.auditDir, ".append.lock")), false);
});

const NO_OP_HEARTBEAT_REASON = tagMessage(
  "inline-guard.no-op-heartbeat-deny",
  "Fusion tasks are in flight for this session, so emit a text-only heartbeat instead of this no-op Bash command."
);

function workerStateEnv(sandbox) {
  const workerStateDir = path.join(sandbox.root, "workers");
  return { FUSION_WORKER_STATE_DIR: workerStateDir };
}

function seedInFlightWorker(
  sandbox,
  {
    sessionId = "session-1",
    taskId = "fusion-abcdef0123456789abcdef01",
    backgroundTaskId = taskId,
    agentId,
    transportStatus = "pending_async",
    outputFile,
    transcriptPath
  } = {}
) {
  const jobsDir = path.join(sandbox.root, "workers", "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobsDir, `${taskId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      taskId,
      sessionId,
      backgroundTaskId,
      ...(agentId ? { agentId } : {}),
      transportStatus,
      ...(outputFile ? { outputFile } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
      acceptance: "unverified"
    }),
    "utf8"
  );
}

function bashPayload(sandbox, { sessionId = "session-1", command = "true", agentId } = {}) {
  const payload = {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    transcript_path: path.join(sandbox.root, "transcript.jsonl"),
    cwd: sandbox.workDir,
    tool_name: "Bash",
    tool_input: { command }
  };
  if (agentId) {
    payload.agent_id = agentId;
    payload.agent_type = "Explore";
  }
  return payload;
}

function taskControlPayload(sandbox, { sessionId = "session-1", toolName = "TaskOutput", taskId } = {}) {
  return {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    transcript_path: path.join(sandbox.root, "transcript.jsonl"),
    cwd: sandbox.workDir,
    tool_name: toolName,
    tool_input: { task_id: taskId }
  };
}

test("in-flight worker tasks deny no-op Bash true with the heartbeat reason", (t) => {
  const sandbox = makeSandbox(t);
  seedInFlightWorker(sandbox);
  const result = run(sandbox, bashPayload(sandbox, { command: "true" }), workerStateEnv(sandbox));
  assert.strictEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.hookSpecificOutput.permissionDecision, "deny");
  assert.strictEqual(output.hookSpecificOutput.permissionDecisionReason, NO_OP_HEARTBEAT_REASON);
});

test("in-flight signature follows the session index without reading other sessions", (t) => {
  const sandbox = makeSandbox(t);
  const ownTaskId = "fusion-indexed-worker";
  const otherTaskId = "fusion-other-worker";
  seedInFlightWorker(sandbox, { taskId: ownTaskId });
  seedInFlightWorker(sandbox, { taskId: otherTaskId, sessionId: "session-2" });
  const sessionsDir = path.join(sandbox.root, "workers", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, "session-1.json"), JSON.stringify({ taskIds: [ownTaskId] }));
  fs.writeFileSync(path.join(sandbox.root, "workers", "jobs", `${otherTaskId}.json`), "not json");
  const result = run(sandbox, bashPayload(sandbox, { command: "true" }), workerStateEnv(sandbox));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, NO_OP_HEARTBEAT_REASON);
});

test("in-flight worker tasks allow a real Bash command untouched", (t) => {
  const sandbox = makeSandbox(t);
  seedInFlightWorker(sandbox);
  const result = run(sandbox, bashPayload(sandbox, { command: "ls -la" }), workerStateEnv(sandbox));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assertSingleReplay(sandbox, "Bash", "read");
});

test("ordinary Bash PreToolUse does not read worker records", (t) => {
  const sandbox = makeSandbox(t);
  seedInFlightWorker(sandbox);
  const marker = path.join(sandbox.root, "worker-reads.txt");
  const jobsDir = path.join(sandbox.root, "workers", "jobs") + path.sep;
  const preloadFile = path.join(sandbox.root, "trace-worker-reads.mjs");
  fs.writeFileSync(preloadFile, `import fs from "node:fs";\nconst read = fs.readFileSync;\nfs.readFileSync = function (file, ...args) { if (String(file).startsWith(${JSON.stringify(jobsDir)})) fs.appendFileSync(${JSON.stringify(marker)}, String(file) + "\\n"); return read.call(this, file, ...args); };\n`);
  const env = { ...workerStateEnv(sandbox), NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preloadFile).href}`.trim() };
  const ordinary = run(sandbox, bashPayload(sandbox, { command: "ls -la" }), env);
  assert.strictEqual(ordinary.status, 0, ordinary.stderr);
  assert.strictEqual(ordinary.stdout, "");
  assert.strictEqual(fs.existsSync(marker), false);
  const noOp = run(sandbox, bashPayload(sandbox, { command: "true" }), env);
  assert.strictEqual(noOp.status, 0, noOp.stderr);
  assert.strictEqual(JSON.parse(noOp.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(fs.readFileSync(marker, "utf8"), /fusion-abcdef0123456789abcdef01\.json/);
});

test("no in-flight worker tasks allow no-op Bash true untouched", (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, bashPayload(sandbox, { command: "true" }), workerStateEnv(sandbox));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assertSingleReplay(sandbox, "Bash", "read");
});

test("the no-op heartbeat denial holds in judgment posture and in strict posture", (t) => {
  for (const posture of ["judgment", "strict"]) {
    const sandbox = makeSandbox(t);
    seedInFlightWorker(sandbox);
    const result = run(sandbox, bashPayload(sandbox, { command: "true" }), { ...workerStateEnv(sandbox), FUSION_POSTURE: posture });
    assert.strictEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.hookSpecificOutput.permissionDecision, "deny", posture);
    assert.strictEqual(output.hookSpecificOutput.permissionDecisionReason, NO_OP_HEARTBEAT_REASON);
    const denials = readAuditRecords(sandbox).filter((record) => record.event === "deny" && record.tool === "Bash");
    assert.strictEqual(denials.length, 1, posture);
    assert.strictEqual(denials[0].mode, "enforce", posture);
    assert.strictEqual(denials[0].posture, posture);
  }
});

test("heartbeat denials repeat on unchanged state", (t) => {
  const sandbox = makeSandbox(t);
  seedInFlightWorker(sandbox);
  const extraEnv = workerStateEnv(sandbox);

  const first = run(sandbox, bashPayload(sandbox, { command: "true" }), extraEnv);
  const repeated = run(sandbox, bashPayload(sandbox, { command: "true" }), extraEnv);
  assert.strictEqual(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.strictEqual(JSON.parse(repeated.stdout).hookSpecificOutput.permissionDecision, "deny");

  const denials = readAuditRecords(sandbox).filter((record) => record.event === "deny" && record.tool === "Bash");
  assert.strictEqual(denials.length, 2);
  assert.ok(denials.every((record) => !Object.hasOwn(record, "suppressed")));
});

test("no-op Bash deny audits an enforcement event for Bash on the main lane", (t) => {
  const sandbox = makeSandbox(t);
  seedInFlightWorker(sandbox);
  run(sandbox, bashPayload(sandbox, { command: "true" }), workerStateEnv(sandbox));
  const denies = readAuditRecords(sandbox).filter((record) => record.event === "deny");
  assert.strictEqual(denies.length, 1);
  assert.deepStrictEqual(denies[0], {
    schemaVersion: 1,
    at: denies[0].at,
    session: "session-1",
    event: "deny",
    lane: "main",
    tool: "Bash",
    writeCount: 0,
    dispatchCount: 0,
    budget: 2_000_000,
    replayTokens: 0,
    mode: "enforce",
    posture: "judgment",
    messageCode: messageCode("inline-guard.no-op-heartbeat-deny")
  });
  assert.ok(!Object.hasOwn(denies[0], "path"));
});

test("TaskOutput against a terminal Fusion worker redirects to its output file", (t) => {
  const sandbox = makeSandbox(t);
  const taskId = "fusion-abcdef0123456789abcdef01";
  const backgroundTaskId = "peer-reaped-output";
  const outputFile = path.join(sandbox.root, "tasks", "peer-reaped-output.txt");
  seedInFlightWorker(sandbox, { taskId, backgroundTaskId, transportStatus: "done", outputFile });

  const result = run(sandbox, taskControlPayload(sandbox, { taskId: backgroundTaskId }), workerStateEnv(sandbox));
  assert.strictEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, new RegExp(outputFile));
  assert.match(output.hookSpecificOutput.permissionDecisionReason, new RegExp(`/fusion:stats --record ${taskId}=<verdict>`));
  assertMessageTagged(output.hookSpecificOutput.permissionDecisionReason, "inline-guard.reaped-worker-redirect");
  const redirects = readAuditRecords(sandbox).filter((record) => record.tool === "TaskOutput" && record.event !== "replay");
  assert.deepStrictEqual(redirects, [
    {
      schemaVersion: 1,
      at: redirects[0].at,
      session: "session-1",
      event: "deny",
      lane: "main",
      tool: "TaskOutput",
      description: "reaped-worker-redirect",
      mode: "enforce",
      posture: "judgment",
      messageCode: messageCode("inline-guard.reaped-worker-redirect")
    }
  ]);
});

test("TaskOutput against a running Fusion worker is allowed", (t) => {
  const sandbox = makeSandbox(t);
  const backgroundTaskId = "peer-running";
  seedInFlightWorker(sandbox, { backgroundTaskId });

  const result = run(sandbox, taskControlPayload(sandbox, { taskId: backgroundTaskId }), workerStateEnv(sandbox));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assertSingleReplay(sandbox, "TaskOutput", "other");
});

test("TaskOutput with an unknown task id is allowed", (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, taskControlPayload(sandbox, { taskId: "not-a-fusion-worker" }), workerStateEnv(sandbox));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assertSingleReplay(sandbox, "TaskOutput", "other");
});

test("TaskStop against a terminal Fusion worker redirects to its transcript", (t) => {
  const sandbox = makeSandbox(t);
  const taskId = "fusion-abcdef0123456789abcdef01";
  const agentId = "peer-reaped-stop";
  const transcriptPath = path.join(sandbox.root, "tasks", "peer-reaped-stop.jsonl");
  seedInFlightWorker(sandbox, { taskId, agentId, transportStatus: "cancelled", transcriptPath });

  const result = run(sandbox, taskControlPayload(sandbox, { toolName: "TaskStop", taskId: agentId }), workerStateEnv(sandbox));
  assert.strictEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, new RegExp(transcriptPath));
  assertMessageTagged(output.hookSpecificOutput.permissionDecisionReason, "inline-guard.reaped-worker-redirect");
});

test("the terminal TaskOutput redirect denies in strict posture too", (t) => {
  const sandbox = makeSandbox(t);
  const backgroundTaskId = "peer-strict";
  seedInFlightWorker(sandbox, { backgroundTaskId, transportStatus: "failed" });

  const result = run(sandbox, taskControlPayload(sandbox, { taskId: backgroundTaskId }), {
    ...workerStateEnv(sandbox),
    FUSION_POSTURE: "strict"
  });
  assert.strictEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /settle via \/fusion:stats --record/);
  assertMessageTagged(output.hookSpecificOutput.permissionDecisionReason, "inline-guard.reaped-worker-redirect");
  const denials = readAuditRecords(sandbox).filter((record) => record.tool === "TaskOutput" && record.event !== "replay");
  assert.strictEqual(denials.length, 1);
  assert.strictEqual(denials[0].event, "deny");
  assert.strictEqual(denials[0].description, "reaped-worker-redirect");
  assert.strictEqual(denials[0].mode, "enforce");
  assert.strictEqual(denials[0].posture, "strict");
});


test("read calls within 1500 ms share a turn and unknown tools leave the streak alone", (t) => {
  const sandbox = makeSandbox(t);
  const base = Date.parse("2026-07-21T00:00:00.000Z");
  const at = (offset) => ({ FUSION_TEST_NOW: new Date(base + offset).toISOString() });
  for (const offset of [0, 1500, 3000]) assert.strictEqual(run(sandbox, readPayload(sandbox), at(offset)).stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").readStreakTurns, 1);
  assert.strictEqual(run(sandbox, readPayload(sandbox, "Skill"), at(4501)).stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").readStreakTurns, 1);
  assert.strictEqual(run(sandbox, readPayload(sandbox, "Grep"), at(4501)).stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").readStreakTurns, 1);
  for (const [offset, tool] of [[6102, "Grep"], [7703, "Glob"], [9304, "Read"]]) {
    assert.strictEqual(run(sandbox, readPayload(sandbox, tool), at(offset)).stdout, "");
  }
  assert.strictEqual(readState(sandbox, "session-1").readStreakTurns, 4);
  const result = run(sandbox, bashPayload(sandbox, { command: "git status --short" }), at(10905));
  assert.strictEqual(JSON.parse(result.stdout).hookSpecificOutput.additionalContext,
    tagMessage("inline-guard.read-streak-advisory", "5 read only turns in a row replayed 2.0M tokens of context. Batch independent reads into one message, and send open ended reconnaissance to Explore."));
  assert.strictEqual(readState(sandbox, "session-1").readStreakTurns, 5);
  assert.strictEqual(readState(sandbox, "session-1").readStreakReplayTokens, 2_000_000);
  assert.strictEqual(readAuditRecords(sandbox).filter((event) => event.reason === "read-streak-advisory").length, 1);
});

test("read streak advises at five turns and each doubling in both postures", (t) => {
  for (const posture of ["judgment", "strict"]) {
    const sandbox = makeSandbox(t);
    const base = Date.parse("2026-07-21T00:00:00.000Z");
    const warnings = [];
    for (let turn = 1; turn <= 20; turn += 1) {
      const tool = ["Read", "Grep", "Glob"][turn % 3];
      const result = run(sandbox, readPayload(sandbox, tool), { FUSION_POSTURE: posture, FUSION_TEST_NOW: new Date(base + turn * 1600).toISOString() });
      if ([5, 10, 20].includes(turn)) {
        assert.strictEqual(JSON.parse(result.stdout).hookSpecificOutput.additionalContext,
          tagMessage("inline-guard.read-streak-advisory", `${turn} read only turns in a row replayed ${(turn * 0.4).toFixed(1)}M tokens of context. Batch independent reads into one message, and send open ended reconnaissance to Explore.`));
        warnings.push(turn);
      } else assert.strictEqual(result.stdout, "", `${posture}: ${turn}`);
    }
    assert.deepStrictEqual(warnings, [5, 10, 20]);
    assert.strictEqual(readState(sandbox, "session-1").readStreakTurns, 20);
    assert.strictEqual(readState(sandbox, "session-1").readStreakReplayTokens, 8_000_000);
    assert.deepStrictEqual(readAuditRecords(sandbox).filter((event) => event.reason === "read-streak-advisory").map((event) => ({
      event: event.event, reason: event.reason, streakTurns: event.streakTurns, replayTokens: event.replayTokens, budget: event.budget, posture: event.posture,
      messageCode: event.messageCode, lane: event.lane, tool: event.tool
    })), [5, 10, 20].map((turn) => ({
      event: "warn", reason: "read-streak-advisory", streakTurns: turn, replayTokens: turn * 400_000, budget: 2_000_000, posture,
      messageCode: messageCode("inline-guard.read-streak-advisory"), lane: "main", tool: ["Read", "Grep", "Glob"][turn % 3]
    })));
  }
});

test("Bash writes, edit tools, and dispatches reset the read streak", (t) => {
  for (const tool of ["Bash", "Edit", "Write", "NotebookEdit", "MultiEdit", "Agent", "Task", "SendMessage"]) {
    const sandbox = makeSandbox(t);
    const base = Date.parse("2026-07-21T00:00:00.000Z");
    for (let turn = 0; turn < 4; turn += 1) run(sandbox, readPayload(sandbox), { FUSION_TEST_NOW: new Date(base + turn * 1600).toISOString() });
    const payload = tool === "Bash" ? bashPayload(sandbox, { command: "node -v" }) :
      ["Agent", "Task", "SendMessage"].includes(tool) ? { ...dispatchPayload(sandbox, { toolName: tool }), hook_event_name: "PreToolUse" } : writePayload(sandbox, { toolName: tool });
    run(sandbox, payload, { FUSION_TEST_NOW: new Date(base + 6400).toISOString() });
    assert.strictEqual(readState(sandbox, "session-1").readStreakTurns, 0, tool);
    assert.strictEqual(readState(sandbox, "session-1").readStreakReplayTokens, 0, tool);
    assert.strictEqual(Object.hasOwn(readState(sandbox, "session-1"), "lastReadAt"), false, tool);
    assert.strictEqual(run(sandbox, readPayload(sandbox), { FUSION_TEST_NOW: new Date(base + 8000).toISOString() }).stdout, "", tool);
    assert.strictEqual(readState(sandbox, "session-1").readStreakTurns, 1, tool);
    assert.strictEqual(readState(sandbox, "session-1").readStreakReplayTokens, 400_000, tool);
  }
});

test("read streak read and reset skip a held state lock promptly without output", (t) => {
  const sandbox = makeSandbox(t);
  for (let turn = 0; turn < 4; turn += 1) {
    run(sandbox, readPayload(sandbox), { FUSION_TEST_NOW: new Date(Date.parse("2026-07-21T00:00:00.000Z") + turn * 1600).toISOString() });
  }
  const file = stateFileFor(sandbox, "session-1");
  const before = readAuditRecords(sandbox);
  fs.writeFileSync(`${file}.lock`, String(process.pid));
  for (const payload of [readPayload(sandbox, "Read"), readPayload(sandbox, "Grep"), readPayload(sandbox, "Glob"), bashPayload(sandbox, { command: "node -v" })]) {
    const start = performance.now();
    const result = run(sandbox, payload);
    assert.ok(performance.now() - start < 2000, payload.tool_name);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
  }
  assert.strictEqual(readState(sandbox, "session-1").readStreakTurns, 4);
  assert.strictEqual(readState(sandbox, "session-1").readStreakReplayTokens, 1_600_000);
  assert.deepStrictEqual(readAuditRecords(sandbox), before);
});

test("subagent reads do not change the main loop streak", (t) => {
  const sandbox = makeSandbox(t);
  const base = Date.parse("2026-07-21T00:00:00.000Z");
  const at = (offset) => ({ FUSION_TEST_NOW: new Date(base + offset).toISOString() });
  assert.strictEqual(run(sandbox, readPayload(sandbox, "Read", "worker-1"), at(0)).stdout, "");
  assert.strictEqual(run(sandbox, { ...readPayload(sandbox), agent_id: "" }, at(0)).stdout, "");
  assert.strictEqual(fs.existsSync(stateFileFor(sandbox, "session-1")), false);
  run(sandbox, readPayload(sandbox), at(1600));
  assert.strictEqual(run(sandbox, bashPayload(sandbox, { command: "cat file", agentId: "worker-1" }), at(3200)).stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").readStreakTurns, 1);
  assert.strictEqual(readState(sandbox, "session-1").readStreakReplayTokens, 400_000);
  const records = readAuditRecords(sandbox);
  assert.deepStrictEqual(records, [{ schemaVersion: 1, at: new Date(base + 1600).toISOString(), session: "session-1", event: "replay", lane: "main", tool: "Read", turn: `t:${base + 1600}`, kind: "read", tokens: 400_000, measured: false }]);
});

for (const [contextTokens, advisoryTurn, formattedTokens] of [[800_000, 3, "2.4M"], [80_000, 25, "2.0M"], [2_000_000, 1, "2.0M"]]) {
  test(`${contextTokens} tokens of context advises on read turn ${advisoryTurn}`, (t) => {
    const sandbox = makeSandbox(t);
    const transcript = path.join(sandbox.root, "transcript.jsonl");
    const base = Date.parse("2026-07-21T00:00:00.000Z");
    for (let turn = 1; turn <= advisoryTurn; turn += 1) {
      const payload = { ...readPayload(sandbox), transcript_path: transcript, tool_use_id: `tool-${turn}` };
      fs.appendFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { id: `msg_${turn}`, usage: { input_tokens: 1000, cache_read_input_tokens: contextTokens - 2000, cache_creation_input_tokens: 1000 }, content: [{ type: "tool_use", id: payload.tool_use_id }] } })}\n`);
      const result = run(sandbox, payload, { FUSION_TEST_NOW: new Date(base + turn * 1600).toISOString() });
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stderr, "");
      if (turn < advisoryTurn) assert.strictEqual(result.stdout, "", `turn ${turn}`);
      else assert.strictEqual(advisoryContext(result, "inline-guard.read-streak-advisory"), tagMessage("inline-guard.read-streak-advisory", `${turn} read only ${turn === 1 ? "turn" : "turns"} in a row replayed ${formattedTokens} tokens of context. Batch independent reads into one message, and send open ended reconnaissance to Explore.`));
    }
    const state = readState(sandbox, "session-1");
    assert.strictEqual(state.readStreakTurns, advisoryTurn);
    assert.strictEqual(state.readStreakReplayTokens, contextTokens * advisoryTurn);
    assert.deepStrictEqual(state.turn, { id: `msg_${advisoryTurn}`, key: `msg_${advisoryTurn}`, at: new Date(base + advisoryTurn * 1600).toISOString(), kind: "read", tokens: contextTokens, measured: true });
    const records = readAuditRecords(sandbox);
    assert.strictEqual(records.filter((event) => event.event === "replay").length, advisoryTurn);
    const warnings = records.filter((event) => event.reason === "read-streak-advisory");
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].replayTokens, contextTokens * advisoryTurn);
    assert.strictEqual(warnings[0].budget, 2_000_000);
  });
}

test("compound Bash reads count toward the replay budget", (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox, bashPayload(sandbox, { command: "sed -n 1,5p a; echo ---; grep x b" }));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.readStreakTurns, 1);
  assert.strictEqual(state.readStreakReplayTokens, 400_000);
  assert.strictEqual(state.turn.kind, "read");
  assert.deepStrictEqual(readAuditRecords(sandbox), [{ schemaVersion: 1, at: state.turn.at, session: "session-1", event: "replay", lane: "main", tool: "Bash", turn: state.turn.key, kind: "read", tokens: 400_000, measured: false }]);
});

test("parallel tool calls sharing an assistant message price one turn and one replay event", async (t) => {
  const sandbox = makeSandbox(t);
  const at = "2026-07-21T00:00:00.000Z";
  const payloads = ["Read", "Grep", "Glob"].map((tool, index) => ({ ...readPayload(sandbox, tool), transcript_path: path.join(sandbox.root, "transcript.jsonl"), tool_use_id: `parallel-${index}` }));
  writeDispatchTranscript(sandbox, [{ messageId: "msg_parallel", payloads }]);
  const results = await Promise.all(payloads.map((payload) => runAsync(sandbox, payload, { FUSION_TEST_NOW: at })));
  for (const result of results) assert.deepStrictEqual(result, { status: 0, stdout: "", stderr: "" });
  assert.strictEqual(readState(sandbox, "session-1").readStreakTurns, 1);
  assert.strictEqual(readState(sandbox, "session-1").readStreakReplayTokens, 400_000);
  const records = readAuditRecords(sandbox);
  assert.strictEqual(records.length, 1);
  assert.deepStrictEqual(records[0], { schemaVersion: 1, at, session: "session-1", event: "replay", lane: "main", tool: records[0].tool, turn: "msg_parallel", kind: "read", tokens: 400_000, measured: false });
  assert.ok(["Read", "Grep", "Glob"].includes(records[0].tool));
  assert.strictEqual(run(sandbox, payloads[0], { FUSION_TEST_NOW: "2026-07-21T00:10:00.000Z" }).stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").readStreakTurns, 1);
  assert.strictEqual(readState(sandbox, "session-1").turn.at, "2026-07-21T00:10:00.000Z");
  assert.deepStrictEqual(readAuditRecords(sandbox), records);
});

test("a later tool that outranks its turn emits another replay event with the same key", (t) => {
  const sandbox = makeSandbox(t);
  const at = "2026-07-21T00:00:00.000Z";
  const read = { ...readPayload(sandbox), transcript_path: path.join(sandbox.root, "transcript.jsonl"), tool_use_id: "first-read" };
  const write = { ...writePayload(sandbox), tool_use_id: "later-write" };
  writeDispatchTranscript(sandbox, [{ messageId: "msg_raise", payloads: [read, write] }]);
  assert.strictEqual(run(sandbox, read, { FUSION_TEST_NOW: at }).stdout, "");
  assert.strictEqual(run(sandbox, write, { FUSION_TEST_NOW: "2026-07-21T00:00:02.000Z" }).stdout, "");
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.turn.kind, "write");
  assert.strictEqual(state.readStreakTurns, 0);
  assert.strictEqual(state.readStreakReplayTokens, 0);
  const records = readAuditRecords(sandbox).filter((event) => event.event === "replay");
  assert.deepStrictEqual(records, [
    { schemaVersion: 1, at, session: "session-1", event: "replay", lane: "main", tool: "Read", turn: "msg_raise", kind: "read", tokens: 400_000, measured: false },
    { schemaVersion: 1, at: "2026-07-21T00:00:02.000Z", session: "session-1", event: "replay", lane: "main", tool: "Edit", turn: "msg_raise", kind: "write", tokens: 400_000, measured: false }
  ]);
  assert.strictEqual(run(sandbox, read, { FUSION_TEST_NOW: "2026-07-21T00:00:04.000Z" }).stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").turn.kind, "write");
  assert.deepStrictEqual(readAuditRecords(sandbox).filter((event) => event.event === "replay"), records);
});

test("state validates replay turns and token totals without migrating old fields", () => {
  const at = "2026-07-21T00:00:00.000Z";
  const turn = { id: "msg_valid", key: "msg_valid", at, kind: "read", tokens: 80_000, measured: true };
  assert.strictEqual(normalizeState(null, at).turn, null);
  assert.strictEqual(normalizeState(null, at).readStreakReplayTokens, 0);
  assert.strictEqual(normalizeState(null, at).writeReplayTokens, 0);
  assert.strictEqual(normalizeState(null, at).writeTurnKey, null);
  assert.deepStrictEqual(normalizeState({ turn, readStreakReplayTokens: 80_000 }, at).turn, turn);
  assert.deepStrictEqual(normalizeState({ turn: { ...turn, id: null, key: `t:${Date.parse(at)}` } }, at).turn, { ...turn, id: null, key: `t:${Date.parse(at)}` });
  for (const change of [{ id: "bad id" }, { id: undefined }, { key: "" }, { key: "bad key" }, { at: "bad" }, { kind: "unknown" }, { tokens: 0 }, { tokens: -1 }, { tokens: 1.5 }, { tokens: Number.MAX_SAFE_INTEGER + 1 }, { measured: "true" }]) {
    assert.strictEqual(normalizeState({ turn: { ...turn, ...change } }, at).turn, null, JSON.stringify(change));
  }
  for (const tokens of [-1, 1.5, "80000", Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.strictEqual(normalizeState({ readStreakReplayTokens: tokens }, at).readStreakReplayTokens, 0);
    assert.strictEqual(normalizeState({ writeReplayTokens: tokens }, at).writeReplayTokens, 0);
  }
  for (const tokens of [0, 80_000, Number.MAX_SAFE_INTEGER]) {
    assert.strictEqual(normalizeState({ writeReplayTokens: tokens }, at).writeReplayTokens, tokens);
  }
  for (const key of [turn.key, `t:${Date.parse(at)}`]) {
    assert.strictEqual(normalizeState({ writeTurnKey: key }, at).writeTurnKey, key);
  }
  for (const key of ["", "bad key", 42, null]) {
    assert.strictEqual(normalizeState({ writeTurnKey: key }, at).writeTurnKey, null);
  }
  const legacy = normalizeState({ lastReadAt: at, readStreakTurns: 4 }, at);
  assert.strictEqual(legacy.turn, null);
  assert.strictEqual(legacy.readStreakReplayTokens, 0);
  assert.strictEqual(Object.hasOwn(legacy, "lastReadAt"), false);
});

test("every main lane tool is classified for replay before its existing handler", (t) => {
  const cases = [
    ...["Agent", "Task", "SendMessage"].map((tool) => [tool, { subagent_type: "Explore" }, "dispatch"]),
    ...["Edit", "Write", "NotebookEdit", "MultiEdit"].map((tool) => [tool, { file_path: "src/file.mjs" }, "write"]),
    ...["Read", "Grep", "Glob"].map((tool) => [tool, {}, "read"]),
    ["Write", { file_path: "/tmp/outside-replay-workspace.txt" }, "other"],
    ["Bash", { command: "npm test > results.log" }, "write"],
    ["Bash", { command: "npm test" }, "verify"],
    ["Bash", { command: "npm test && node fusion-stats.mjs --record job=accepted" }, "verify"],
    ["Bash", { command: "node fusion-stats.mjs --record job=accepted" }, "settle"],
    ["Bash", { command: "node fusion-stats.mjs --json" }, "other"],
    ["Bash", { command: "git status --short" }, "read"],
    ["Bash", { command: "node -v" }, "other"],
    ["TaskOutput", { task_id: "unknown" }, "other"],
    ["TaskStop", { task_id: "unknown" }, "other"],
    ["Skill", {}, "other"]
  ];
  for (const [tool, toolInput, kind] of cases) {
    const sandbox = makeSandbox(t);
    const payload = { ...readPayload(sandbox, tool), tool_input: toolInput };
    const result = handleInlineDelegationHook(payload, envFor(sandbox));
    assert.deepStrictEqual(result, { stdout: "", stderr: "", exitCode: 0 }, `${tool} ${JSON.stringify(toolInput)}`);
    const state = readState(sandbox, "session-1");
    assert.strictEqual(state.turn.kind, kind);
    assert.strictEqual(state.turn.tokens, 400_000);
    assert.strictEqual(state.turn.measured, false);
    assert.strictEqual(state.readStreakReplayTokens, kind === "read" ? 400_000 : 0);
    const replay = readAuditRecords(sandbox).filter((event) => event.event === "replay");
    assert.deepStrictEqual(replay, [{ schemaVersion: 1, at: state.turn.at, session: "session-1", event: "replay", lane: "main", tool, turn: state.turn.key, kind, tokens: 400_000, measured: false }]);
  }
});

test("callbacks and subagent payloads do not price replay turns", (t) => {
  const sandbox = makeSandbox(t);
  for (const hook_event_name of ["PostToolUse", "PostToolUseFailure"]) {
    assert.deepStrictEqual(handleInlineDelegationHook({ ...readPayload(sandbox), hook_event_name }, envFor(sandbox)), { stdout: "", stderr: "", exitCode: 0 });
  }
  for (const agent_id of ["worker-1", ""]) {
    assert.deepStrictEqual(handleInlineDelegationHook({ ...readPayload(sandbox), agent_id }, envFor(sandbox)), { stdout: "", stderr: "", exitCode: 0 });
  }
  assert.strictEqual(fs.existsSync(stateFileFor(sandbox, "session-1")), false);
  assert.deepStrictEqual(readAuditRecords(sandbox), []);
});

test("legacy narrow wave state is discarded when the guard updates a session", (t) => {
  const sandbox = makeSandbox(t);
  const at = "2026-07-21T00:00:00.000Z";
  run(sandbox, readPayload(sandbox), { FUSION_TEST_NOW: at });
  const file = stateFileFor(sandbox, "session-1");
  fs.writeFileSync(file, JSON.stringify({ ...readState(sandbox, "session-1"), fleetWaveWidth: 1,
    consecutiveNarrowWaves: 2, lastAdvisedNarrowWaveStreak: 2, advisedNarrowWaveSignatures: ["a".repeat(64)],
    advisorySignatures: { "narrow-wave": "old", "write-budget": "kept" } }));
  run(sandbox, readPayload(sandbox), { FUSION_TEST_NOW: "2026-07-21T00:00:01.600Z" });
  const state = readState(sandbox, "session-1");
  for (const key of ["fleetWaveWidth", "consecutiveNarrowWaves", "lastAdvisedNarrowWaveStreak", "advisedNarrowWaveSignatures"]) {
    assert.strictEqual(Object.hasOwn(state, key), false, key);
  }
  assert.deepStrictEqual(state.advisorySignatures, { "write-budget": "kept" });
});

test("hooks configuration wires PreToolUse read, write, Bash, dispatch, TaskOutput, and TaskStop tools through the inline guard", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "hooks", "hooks.json"), "utf8")).hooks;
  const preToolHandlers = hooks.PreToolUse.flatMap((group) => group.hooks.map((hook) => ({ matcher: group.matcher, command: hook.command }))).filter((hook) => hook.command?.includes("fusion-hook.mjs"));
  assert.deepStrictEqual(preToolHandlers, [
    {
      matcher: "^(Read|Grep|Glob|Edit|Write|NotebookEdit|MultiEdit|Bash)$",
      command: 'command -v node >/dev/null 2>&1 || exit 0; node "${CLAUDE_PLUGIN_ROOT}/scripts/fusion-hook.mjs"'
    },
    {
      matcher: "^(Agent|Task)$",
      command: 'command -v node >/dev/null 2>&1 || exit 0; node "${CLAUDE_PLUGIN_ROOT}/scripts/fusion-hook.mjs"'
    },
    {
      matcher: "^SendMessage$",
      command: 'command -v node >/dev/null 2>&1 || exit 0; node "${CLAUDE_PLUGIN_ROOT}/scripts/fusion-hook.mjs"'
    },
    {
      matcher: "^(TaskOutput|TaskStop)$",
      command: 'command -v node >/dev/null 2>&1 || exit 0; node "${CLAUDE_PLUGIN_ROOT}/scripts/fusion-hook.mjs"'
    }
  ]);
  const postToolHandlers = hooks.PostToolUse.flatMap((group) => group.hooks.map((hook) => ({ matcher: group.matcher, command: hook.command }))).filter((hook) => hook.command?.includes("fusion-hook.mjs"));
  assert.deepStrictEqual(postToolHandlers, [
    {
      matcher: "^(Agent|Task|Bash|SendMessage)$",
      command: 'command -v node >/dev/null 2>&1 || exit 0; node "${CLAUDE_PLUGIN_ROOT}/scripts/fusion-hook.mjs"'
    },
    {
      matcher: "^(Edit|Write|NotebookEdit|MultiEdit)$",
      command: 'command -v node >/dev/null 2>&1 || exit 0; node "${CLAUDE_PLUGIN_ROOT}/scripts/fusion-hook.mjs"'
    }
  ]);
  const failedHandlers = hooks.PostToolUseFailure.flatMap((group) => group.hooks.map((hook) => ({ matcher: group.matcher, command: hook.command }))).filter((hook) => hook.command?.includes("fusion-hook.mjs"));
  assert.deepStrictEqual(failedHandlers, [{ matcher: "^(Edit|Write|NotebookEdit|MultiEdit|Bash)$", command: 'command -v node >/dev/null 2>&1 || exit 0; node "${CLAUDE_PLUGIN_ROOT}/scripts/fusion-hook.mjs"' }]);
});

test("all plugin node hooks fail open without node and compact text is exact", () => {
  for (const plugin of ["codex", "grok", "cursor", "fusion"]) {
    const hooks = JSON.parse(fs.readFileSync(path.join(repoRoot, "plugins", plugin, "hooks", "hooks.json"), "utf8")).hooks;
    for (const groups of Object.values(hooks)) for (const group of groups) for (const hook of group.hooks) {
      if (!hook.command.includes("node ")) continue;
      assert.ok(hook.command.startsWith("command -v node >/dev/null 2>&1 || exit 0; "), `${plugin}: ${hook.command}`);
      const result = spawnSync("/bin/sh", ["-c", hook.command], { env: { PATH: "/nonexistent", CLAUDE_PLUGIN_ROOT: "/nonexistent" }, encoding: "utf8" });
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, "");
      assert.strictEqual(result.stderr, "");
    }
    if (plugin === "fusion") {
      const compactCommand = hooks.SessionStart.flatMap((group) => group.hooks).find((hook) => hook.command.includes("[fusion:9902]"))?.command;
      assert.strictEqual(compactCommand, "echo 'Context was compacted. In one line, restate the execution posture and every in-flight Fusion task still owed collection, verification, or settlement. [fusion:9902]'");
    }
  }
});
