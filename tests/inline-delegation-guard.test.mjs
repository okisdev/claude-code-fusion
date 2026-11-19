import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  handleInlineDelegationHook,
  normalizeAuditEvent,
  readAuditEvents
} from "../plugins/fusion/scripts/inline-delegation-guard.mjs";
import { messageCode, messageTag, tagMessage } from "../plugins/fusion/scripts/lib/user-messages.mjs";
import { normalizeState } from "../plugins/fusion/scripts/lib/guard/state.mjs";
import { resolveAuditDir, resolveStateDir } from "../plugins/fusion/scripts/lib/guard/config.mjs";

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

test("FUSION_DATA_DIR redirects guard state and audit while explicit paths take precedence", (t) => {
  const sandbox = makeSandbox(t);
  const env = { FUSION_DATA_DIR: ` ${sandbox.dataDir} ` };
  assert.strictEqual(resolveStateDir(env), path.join(sandbox.dataDir, "inline-guard"));
  assert.strictEqual(resolveAuditDir(env), path.join(sandbox.dataDir, "inline-guard-audit"));
  assert.deepStrictEqual(handleInlineDelegationHook(writePayload(sandbox), env), {});
  const stateFile = path.join(sandbox.dataDir, "inline-guard", "session-1.json");
  assert.strictEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).writeCount, 1);
  const audit = readAuditEvents({ env });
  assert.strictEqual(audit.malformedCount, 0);
  assert.strictEqual(audit.events.filter((event) => event.event === "write").length, 1);
  const overrides = { ...env, FUSION_INLINE_GUARD_STATE: sandbox.stateDir, FUSION_INLINE_GUARD_AUDIT_DIR: sandbox.auditDir };
  assert.strictEqual(resolveStateDir(overrides), sandbox.stateDir);
  assert.strictEqual(resolveAuditDir(overrides), sandbox.auditDir);
});

test("guard state and audit retain their legacy paths without FUSION_DATA_DIR", () => {
  const legacy = path.join(os.homedir(), ".claude", "plugins", "data", "fusion-claude-code-fusion");
  for (const env of [{}, { FUSION_DATA_DIR: "  " }]) {
    assert.strictEqual(resolveStateDir(env), path.join(legacy, "inline-guard"));
    assert.strictEqual(resolveAuditDir(env), path.join(legacy, "inline-guard-audit"));
  }
});

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

test("legacy strict environment and persisted posture behave exactly like the default", (t) => {
  const outcomes = [];
  for (const source of ["default", "environment", "file", "both"]) {
    const sandbox = makeSandbox(t);
    const extraEnv = source === "environment" || source === "both" ? { FUSION_POSTURE: "strict" } : {};
    const postureFile = path.join(sandbox.dataDir, "posture");
    if (source === "file" || source === "both") {
      fs.mkdirSync(sandbox.dataDir, { recursive: true });
      fs.writeFileSync(postureFile, "strict\n");
    }
    const outputs = [];
    for (let turn = 1; turn <= 20; turn += 1) {
      const payload = { ...writePayload(sandbox), tool_use_id: `legacy-write-${turn}` };
      const result = run(sandbox, payload, { ...extraEnv, FUSION_TEST_NOW: new Date(Date.parse("2026-07-21T00:00:00.000Z") + turn * 2000).toISOString() });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, "");
      outputs.push(result.stdout);
    }
    const before = readState(sandbox, "session-1");
    assert.strictEqual(before.writesSinceDispatch, 20);
    assert.strictEqual(before.writeReplayTokens, 8_000_000);
    const verification = run(sandbox, verificationPayload(sandbox), { ...extraEnv, FUSION_TEST_NOW: "2026-07-21T00:01:00.000Z" });
    assert.strictEqual(verification.status, 0, verification.stderr);
    assert.strictEqual(verification.stdout, "");
    const after = readState(sandbox, "session-1");
    assert.strictEqual(after.writesSinceDispatch, 0);
    assert.strictEqual(after.writeReplayTokens, 0);
    const env = envFor(sandbox, extraEnv);
    const prompt = JSON.stringify({ session_id: "session-1", cwd: sandbox.workDir });
    for (let index = 0; index < 2; index += 1) {
      const fleet = spawnSync(process.execPath, [path.join(repoRoot, "plugins/fusion/scripts/fleet-posture.mjs")], { env, input: prompt, encoding: "utf8" });
      assert.strictEqual(fleet.status, 0, fleet.stderr);
      assert.strictEqual(fleet.stdout, "");
      outputs.push(fleet.stdout);
    }
    const config = spawnSync(process.execPath, [path.join(repoRoot, "plugins/fusion/scripts/fusion-config.mjs"), "show", "--json"], { env, encoding: "utf8" });
    assert.strictEqual(config.status, 0, config.stderr);
    assert.strictEqual(Object.hasOwn(JSON.parse(config.stdout), "posture"), false);
    outcomes.push({ outputs, before, after, audit: readAuditRecords(sandbox), config: config.stdout.replaceAll(sandbox.root, "<root>") });
    if (source === "file" || source === "both") assert.strictEqual(fs.readFileSync(postureFile, "utf8"), "strict\n");
    else assert.strictEqual(fs.existsSync(postureFile), false);
  }
  for (const outcome of outcomes.slice(1)) assert.deepStrictEqual(outcome, outcomes[0]);
});

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

test("five Edit calls in one turn price one context silently", (t) => {
  const sandbox = makeSandbox(t);
  for (let index = 0; index < 5; index += 1) {
    const payload = { ...writePayload(sandbox), tool_use_id: `edit-${index}` };
    assert.strictEqual(run(sandbox, payload, { FUSION_TEST_NOW: "2026-07-21T00:00:00.000Z" }).stdout, "");
  }
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.writeCount, 5);
  assert.strictEqual(state.writesSinceDispatch, 5);
  assert.strictEqual(state.writeReplayTokens, 400_000);
  assert.strictEqual(state.writeTurnKey, state.turn.key);
  assert.deepStrictEqual(state.pendingWrites.map((entry) => entry.turn), Array(5).fill(state.turn.key));
  assert.strictEqual(state.writeTurnTokens, 400_000);
  assert.strictEqual(state.writeTurnWrites, 5);
  assert.strictEqual(readAuditRecords(sandbox).filter((event) => event.event === "warn").length, 0);
});

for (const [contextTokens, turns] of [[800_000, 3], [80_000, 25], [2_000_000, 2]]) {
  test(`writes price ${contextTokens} tokens per turn without warnings or denials`, (t) => {
    const sandbox = makeSandbox(t);
    for (let turn = 1; turn <= turns; turn += 1) {
      const payload = { ...writePayload(sandbox), tool_use_id: `write-${turn}` };
      fs.appendFileSync(payload.transcript_path, `${JSON.stringify({ type: "assistant", message: { id: `msg_${turn}`, usage: { input_tokens: 1000, cache_read_input_tokens: contextTokens - 2000, cache_creation_input_tokens: 1000 }, content: [{ type: "tool_use", id: payload.tool_use_id }] } })}\n`);
      const result = run(sandbox, payload);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, "");
      assert.strictEqual(readState(sandbox, "session-1").writeReplayTokens, contextTokens * turn);
    }
    const state = readState(sandbox, "session-1");
    assert.strictEqual(state.writeCount, turns);
    assert.strictEqual(state.writeTurnKey, `msg_${turns}`);
    assert.deepStrictEqual(state.pendingWrites.map((entry) => entry.turn), Array.from({ length: turns }, (_, index) => `msg_${index + 1}`));
    assert.strictEqual(state.writeTurnTokens, contextTokens);
    assert.strictEqual(state.writeTurnWrites, 1);
    const records = readAuditRecords(sandbox);
    assert.strictEqual(records.filter((event) => event.event === "write").length, turns);
    assert.strictEqual(records.filter((event) => ["warn", "deny"].includes(event.event)).length, 0);
  });
}

for (const [name, command] of [
  ["sed in place", "sed -i 's/old/new/' src/x"],
  ["cat heredoc", "cat > src/x <<'EOF'\nnew\nEOF"],
  ["python heredoc", "python3 - <<'PY'\nfrom pathlib import Path\nPath('src/x').write_text('new')\nPY"]
]) {
  test(`a ${name} Bash write counts and audits its path beyond the replay budget`, (t) => {
    const sandbox = makeSandbox(t);
    const payload = { ...bashPayload(sandbox, { command }), tool_use_id: "bash-write" };
    const base = Date.parse("2026-07-21T00:00:00.000Z");
    assert.strictEqual(run(sandbox, payload, { FUSION_TEST_NOW: new Date(base).toISOString() }).stdout, "");
    let state = readState(sandbox, "session-1");
    assert.strictEqual(state.writeCount, 1);
    assert.strictEqual(state.writesSinceDispatch, 1);
    assert.strictEqual(state.writeReplayTokens, 400_000);
    assert.strictEqual(state.pendingWrites[0].turn, state.turn.key);
    assert.strictEqual(state.writeTurnTokens, 400_000);
    const [write] = readAuditRecords(sandbox).filter((event) => event.event === "write");
    assert.strictEqual(write.tool, "Bash");
    assert.strictEqual(write.path, "src/x");
    for (let index = 1; index <= 4; index += 1) run(sandbox, writePayload(sandbox, { filePath: path.join(sandbox.workDir, "src/x") }), { FUSION_TEST_NOW: new Date(base + index * 1600).toISOString() });
    const allowed = run(sandbox, { ...payload, tool_use_id: "next-bash-write" }, { FUSION_TEST_NOW: new Date(base + 8000).toISOString() });
    assert.strictEqual(allowed.stdout, "");
    state = readState(sandbox, "session-1");
    assert.strictEqual(state.writeCount, 6);
    assert.strictEqual(state.writeReplayTokens, 2_400_000);
    const auditWrite = readAuditRecords(sandbox).at(-1);
    assert.strictEqual(auditWrite.tool, "Bash");
    assert.strictEqual(auditWrite.path, "src/x");
    assert.strictEqual(auditWrite.budget, 2_000_000);
    assert.strictEqual(auditWrite.replayTokens, 2_400_000);
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

test("failed Bash write callbacks preserve their write count and replay tokens", (t) => {
  for (const response of [null, { is_error: true }, { isError: true }, { interrupted: true }, { exitCode: 1 }, { exit_code: 2 }, { code: -1 }, { returnCode: 3 }]) {
    const sandbox = makeSandbox(t);
    const payload = { ...bashPayload(sandbox, { command: "cat > src/x <<'EOF'\nnew\nEOF" }), tool_use_id: "failed-bash" };
    const env = { FUSION_INLINE_REPLAY_BUDGET_TOKENS: "400000" };
    assert.strictEqual(run(sandbox, payload, env).stdout, "");
    assert.strictEqual(readState(sandbox, "session-1").writeReplayTokens, 400_000);
    const result = run(sandbox, { ...payload, hook_event_name: response ? "PostToolUse" : "PostToolUseFailure", tool_response: response }, env);
    assert.strictEqual(result.stdout, "");
    const state = readState(sandbox, "session-1");
    assert.strictEqual(state.writeCount, 1);
    assert.strictEqual(state.writesSinceDispatch, 1);
    assert.strictEqual(state.writeReplayTokens, 400_000);
    assert.strictEqual(state.writeTurnTokens, 400_000);
    assert.strictEqual(state.writeTurnWrites, 1);
    assert.deepStrictEqual(state.pendingWrites, []);
  }
});

test("Bash and Edit writes in the same turn keep their charge when both report failure", (t) => {
  const sandbox = makeSandbox(t);
  const env = { FUSION_TEST_NOW: "2026-07-21T00:00:00.000Z" };
  const edit = { ...writePayload(sandbox), tool_use_id: "edit-first" };
  const bash = { ...bashPayload(sandbox, { command: "printf changed > src/a.ts; false" }), tool_use_id: "bash-second" };
  assert.strictEqual(run(sandbox, edit, env).stdout, "");
  assert.strictEqual(run(sandbox, bash, env).stdout, "");
  const admitted = readState(sandbox, "session-1");
  assert.deepStrictEqual(admitted.pendingWrites.map((entry) => entry.turn), [admitted.turn.key, admitted.turn.key]);
  run(sandbox, { ...bash, hook_event_name: "PostToolUseFailure" }, env);
  assert.strictEqual(readState(sandbox, "session-1").writeCount, 2);
  assert.strictEqual(readState(sandbox, "session-1").writeReplayTokens, 400_000);
  run(sandbox, { ...edit, hook_event_name: "PostToolUseFailure" }, env);
  assert.strictEqual(readState(sandbox, "session-1").writeReplayTokens, 400_000);
  assert.strictEqual(readState(sandbox, "session-1").writeTurnWrites, 1);
});

test("a successful Bash write consumes the window once", (t) => {
  const sandbox = makeSandbox(t);
  const payload = { ...bashPayload(sandbox, { command: "printf new > src/x" }), tool_use_id: "bash-success" };
  run(sandbox, payload);
  assert.strictEqual(run(sandbox, payload).stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").writeCount, 1);
  run(sandbox, { ...payload, hook_event_name: "PostToolUse", tool_response: { exitCode: 0 } });
  const confirmed = readState(sandbox, "session-1");
  assert.strictEqual(confirmed.writeReplayTokens, 400_000);
  assert.deepStrictEqual(confirmed.pendingWrites, []);
  run(sandbox, { ...payload, hook_event_name: "PostToolUseFailure" });
  assert.strictEqual(readState(sandbox, "session-1").writeCount, 1);
  assert.strictEqual(readState(sandbox, "session-1").writeReplayTokens, 400_000);
});

test("confirming B then failing A in one write turn keeps the turn charged", (t) => {
  const sandbox = makeSandbox(t);
  const env = { FUSION_TEST_NOW: "2026-07-21T00:00:00.000Z" };
  const a = { ...writePayload(sandbox), tool_use_id: "write-a" };
  const b = { ...writePayload(sandbox), tool_use_id: "write-b" };
  run(sandbox, a, env);
  run(sandbox, b, env);
  run(sandbox, { ...b, hook_event_name: "PostToolUse" }, env);
  run(sandbox, { ...a, hook_event_name: "PostToolUseFailure" }, env);
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.writeReplayTokens, 400_000);
  assert.strictEqual(state.writeTurnTokens, 400_000);
  assert.strictEqual(state.writeTurnWrites, 1);
  assert.strictEqual(state.writeCount, 1);
  assert.deepStrictEqual(state.pendingWrites, []);
});

test("failing A then retrying B in the same turn charges the turn again", (t) => {
  const sandbox = makeSandbox(t);
  const env = { FUSION_TEST_NOW: "2026-07-21T00:00:00.000Z" };
  const a = { ...writePayload(sandbox), tool_use_id: "write-a" };
  const b = { ...writePayload(sandbox), tool_use_id: "write-b" };
  run(sandbox, a, env);
  run(sandbox, { ...a, hook_event_name: "PostToolUseFailure" }, env);
  const failed = readState(sandbox, "session-1");
  assert.strictEqual(failed.writeReplayTokens, 0);
  assert.strictEqual(failed.writeTurnKey, null);
  assert.strictEqual(failed.writeTurnTokens, 0);
  assert.strictEqual(failed.writeTurnWrites, 0);
  run(sandbox, b, env);
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.writeReplayTokens, 400_000);
  assert.strictEqual(state.writeTurnKey, state.turn.key);
  assert.strictEqual(state.writeTurnTokens, 400_000);
  assert.strictEqual(state.writeTurnWrites, 1);
  assert.strictEqual(state.pendingWrites[0].turn, state.turn.key);
  assert.strictEqual(Object.hasOwn(state.pendingWrites[0], "tokens"), false);
});

test("failing every write in the current turn refunds its charge once", (t) => {
  for (const order of [["a", "b"], ["b", "a"]]) {
    const sandbox = makeSandbox(t);
    const env = { FUSION_TEST_NOW: "2026-07-21T00:00:00.000Z" };
    const writes = Object.fromEntries(order.map((id) => [id, { ...writePayload(sandbox), tool_use_id: id }]));
    run(sandbox, writes.a, env);
    run(sandbox, writes.b, env);
    run(sandbox, { ...writes[order[0]], hook_event_name: "PostToolUseFailure" }, env);
    assert.strictEqual(readState(sandbox, "session-1").writeReplayTokens, 400_000);
    run(sandbox, { ...writes[order[1]], hook_event_name: "PostToolUseFailure" }, env);
    const state = readState(sandbox, "session-1");
    assert.strictEqual(state.writeReplayTokens, 0);
    assert.strictEqual(state.writeTurnKey, null);
    assert.strictEqual(state.writeTurnTokens, 0);
    assert.strictEqual(state.writeTurnWrites, 0);
  }
});

test("failure of an older write turn does not refund replay tokens", (t) => {
  const sandbox = makeSandbox(t);
  const a = { ...writePayload(sandbox), tool_use_id: "write-a" };
  const b = { ...writePayload(sandbox), tool_use_id: "write-b" };
  writeDispatchTranscript(sandbox, [{ messageId: "msg_a", payloads: [a] }, { messageId: "msg_b", payloads: [b] }]);
  run(sandbox, a);
  run(sandbox, b);
  run(sandbox, { ...a, hook_event_name: "PostToolUseFailure" });
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.writeReplayTokens, 800_000);
  assert.strictEqual(state.writeTurnKey, "msg_b");
  assert.strictEqual(state.writeTurnTokens, 400_000);
  assert.strictEqual(state.writeTurnWrites, 1);
});

test("passing verification clears turn accounting before subsequent writes", (t) => {
  const sandbox = makeSandbox(t);
  const env = { FUSION_INLINE_REPLAY_BUDGET_TOKENS: "400000" };
  const first = { ...writePayload(sandbox), tool_use_id: "a" };
  assert.strictEqual(run(sandbox, first, env).stdout, "");
  run(sandbox, verificationPayload(sandbox), env);
  const reset = readState(sandbox, "session-1");
  assert.strictEqual(reset.writeTurnKey, null);
  assert.strictEqual(reset.writeTurnTokens, 0);
  assert.strictEqual(reset.writeTurnWrites, 0);
  assert.strictEqual(run(sandbox, { ...writePayload(sandbox), tool_use_id: "b" }, env).stdout, "");
  assert.strictEqual(readAuditRecords(sandbox).filter((event) => event.event === "warn").length, 0);
});

test("a late failure before verification cannot refund a new window in the same turn", (t) => {
  const sandbox = makeSandbox(t);
  const a = { ...writePayload(sandbox), tool_use_id: "a" };
  const b = { ...writePayload(sandbox), tool_use_id: "b" };
  writeDispatchTranscript(sandbox, [{ messageId: "msg_ab", payloads: [a, b] }]);
  run(sandbox, a);
  run(sandbox, verificationPayload(sandbox));
  run(sandbox, b);
  run(sandbox, { ...a, hook_event_name: "PostToolUseFailure" });
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.writeReplayTokens, 400_000);
  assert.strictEqual(state.writeTurnTokens, 400_000);
  assert.strictEqual(state.writeTurnWrites, 1);
  assert.strictEqual(state.writeTurnKey, "msg_ab");
});

test("a write waits for a held state lock and charges its current turn", async (t) => {
  const sandbox = makeSandbox(t);
  const a = { ...writePayload(sandbox), tool_use_id: "a" };
  const b = { ...writePayload(sandbox), tool_use_id: "b" };
  writeDispatchTranscript(sandbox, [{ messageId: "msg_a", payloads: [a] }, { messageId: "msg_b", payloads: [b] }]);
  run(sandbox, a);
  const lock = `${stateFileFor(sandbox, "session-1")}.lock`;
  const marker = path.join(sandbox.root, "contended");
  const preload = path.join(sandbox.root, "contention.mjs");
  fs.writeFileSync(preload, `import fs from 'node:fs'; const open = fs.openSync; let attempts = 0; fs.openSync = function (...args) { try { return open.apply(this, args); } catch (error) { if (args[0] === ${JSON.stringify(lock)} && error.code === 'EEXIST' && ++attempts === 2) fs.writeFileSync(${JSON.stringify(marker)}, ''); throw error; } };`);
  fs.writeFileSync(lock, String(process.pid));
  const pending = runAsyncRaw(sandbox, b, { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`.trim() });
  try {
    const deadline = performance.now() + 3000;
    while (!fs.existsSync(marker) && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(marker));
  } finally {
    fs.rmSync(lock, { force: true });
  }
  const result = await pending;
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, "");
  const state = readState(sandbox, "session-1");
  assert.strictEqual(state.turn.key, "msg_b");
  assert.strictEqual(state.writeTurnKey, "msg_b");
  assert.strictEqual(state.writeReplayTokens, 800_000);
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

test("allows a main loop write at count 200", (t) => {
  const sandbox = makeSandbox(t);
  assert.strictEqual(run(sandbox, writePayload(sandbox)).stdout, "");
  const file = stateFileFor(sandbox, "session-1");
  const state = readState(sandbox, "session-1");
  state.writeCount = 200;
  state.writesSinceDispatch = 200;
  fs.writeFileSync(file, JSON.stringify(state), "utf8");

  const result = run(sandbox, writePayload(sandbox, { toolName: "Write", filePath: path.join(sandbox.workDir, "write-201.txt"), toolInput: { content: "x" } }));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 201);
  const records = readAuditRecords(sandbox);
  assert.strictEqual(records.filter((record) => record.event === "deny").length, 0);
  assert.strictEqual(records.filter((record) => record.event === "write").length, 2);
});

test("a passing verification resets the write window", (t) => {
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

test("a passing verification without writes records evidence with an empty write window", (t) => {
  const sandbox = makeSandbox(t);
  const verification = run(sandbox, verificationPayload(sandbox));
  assert.strictEqual(verification.status, 0);
  assert.strictEqual(verification.stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 0);
  const [event] = readAuditRecords(sandbox);
  assert.strictEqual(event.event, "verification");
  assert.strictEqual(event.writeCount, 0);
  assert.strictEqual(event.evidence, "exit-status");
});

test("dispatch, verify, and settle records evidence with zero inline writes", (t) => {
  const sandbox = makeSandbox(t);
  run(sandbox, dispatchPayload(sandbox, { subagentType: "codex:codex-rescue" }));
  const before = readState(sandbox, "session-1");
  assert.strictEqual(before.writesSinceDispatch, 0);
  const result = run(sandbox, verificationPayload(sandbox, { command: "npm test && node fusion-stats.mjs --record fusion-example=accepted" }));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.deepStrictEqual({ ...readState(sandbox, "session-1"), updatedAt: before.updatedAt }, before);
  const [event] = readAuditRecords(sandbox).filter((record) => record.event === "verification");
  assert.strictEqual(event.writeCount, 0);
  assert.strictEqual(event.dispatchCount, 1);
  assert.strictEqual(event.evidence, "exit-status");
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

test("the write window resets on dispatch and on a passing verification", (t) => {
  const sandbox = makeSandbox(t);
  for (let index = 0; index < 2; index += 1) {
    run(sandbox, writePayload(sandbox, { toolInput: { new_string: "ab" } }));
  }
  const written = readState(sandbox, "session-1");
  assert.strictEqual(written.writesSinceDispatch, 2);

  run(sandbox, dispatchPayload(sandbox, { subagentType: "codex:codex-rescue" }));
  const dispatched = readState(sandbox, "session-1");
  assert.strictEqual(dispatched.writesSinceDispatch, 0);
  assert.strictEqual(dispatched.writeReplayTokens, 0);
  assert.strictEqual(dispatched.writeTurnKey, null);
  assert.strictEqual(dispatched.writeTurnTokens, 0);
  assert.strictEqual(dispatched.writeTurnWrites, 0);

  for (let index = 0; index < 3; index += 1) {
    run(sandbox, writePayload(sandbox, { toolInput: { new_string: "xyz" } }));
  }
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 3);

  run(sandbox, verificationPayload(sandbox));
  const verified = readState(sandbox, "session-1");
  assert.strictEqual(verified.writesSinceDispatch, 0);
  assert.strictEqual(verified.writeCount, 5);
});

test("audit normalization accepts legacy event categories and discards retired fields", () => {
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
  };
  assert.deepStrictEqual(normalizeAuditEvent(verification), { schemaVersion: 1, ...verification });
  assert.deepStrictEqual(normalizeAuditEvent({ ...verification, messageCode: 4321 }), { schemaVersion: 1, ...verification, messageCode: 4321 });
  assert.deepStrictEqual(normalizeAuditEvent({ ...verification, posture: "strict", remainingTailSlots: 2, remainingZeroDispatchWrites: 4, remainingZeroDispatchBytes: 100, exempt: "out-of-workspace", suppressed: true, streakTurns: 7 }), { schemaVersion: 1, ...verification });
  for (const invalidMessageCode of [999, 10000, 4321.5, "4321"]) {
    assert.ok(!Object.hasOwn(normalizeAuditEvent({ ...verification, messageCode: invalidMessageCode }), "messageCode"));
  }

  const legacyEvents = [
    { at, session: "session-1", event: "write", lane: "main", tool: "Edit", path: "file.txt", exempt: "out-of-workspace" },
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
    { at, session: "session-1", event: "deny", lane: "main", tool: "TaskStop", description: "reaped-worker-redirect", mode: "enforce" },
    { at, session: "session-1", event: "warn", lane: "main", tool: "TaskStop", description: "reaped-worker-redirect", mode: "advisory", suppressed: true },
    { at, session: "session-1", event: "deny", lane: "main", tool: "Edit", path: "file.txt", writeCount: 5, dispatchCount: 1, budget: 5, mode: "enforce" },
    { at, session: "session-1", event: "warn", lane: "main", tool: "Bash", writeCount: 5, dispatchCount: 1, budget: 5, mode: "advisory", suppressed: true },
    { at, session: "session-1", event: "warn", lane: "main", tool: "Read", reason: "read-streak-advisory", streakTurns: 7 }
  ];
  assert.ok(legacyEvents.every((event) => normalizeAuditEvent(event) !== null));
  assert.ok(legacyEvents.every((event) => !Object.hasOwn(normalizeAuditEvent(event), "posture")));
  for (const event of legacyEvents) {
    for (const key of ["remainingTailSlots", "remainingZeroDispatchWrites", "remainingZeroDispatchBytes", "exempt", "suppressed", "streakTurns"]) {
      assert.strictEqual(Object.hasOwn(normalizeAuditEvent(event), key), false, key);
    }
  }
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

test("a PostToolUse-only dispatch recovers a missing launch and resets the write window", (t) => {
  const sandbox = makeSandbox(t);
  for (let index = 0; index < 5; index += 1) {
    run(sandbox, writePayload(sandbox));
  }
  const allowedWrite = run(sandbox, writePayload(sandbox));
  assert.strictEqual(allowedWrite.stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 6);

  const recovered = runRaw(sandbox, dispatchPayload(sandbox, { subagentType: "fusion:claude-worker", description: "recover the missing launch" }));
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
    }
  ]);

  const allowed = run(sandbox, writePayload(sandbox));
  assert.strictEqual(allowed.stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 1);
});

test("unavailable guard state leaves writes silent", (t) => {
  const sandbox = makeSandbox(t);
  fs.writeFileSync(sandbox.stateDir, "not a directory", "utf8");
  const result = run(sandbox, writePayload(sandbox));
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});

test("malformed, truncated, and array state leave writes silent and state intact", (t) => {
  for (const contents of ["not json", '{"writeCount":', '[{"writeCount":5}]']) {
    const sandbox = makeSandbox(t);
    fs.mkdirSync(sandbox.stateDir, { recursive: true });
    const file = stateFileFor(sandbox, "session-1");
    fs.writeFileSync(file, contents, "utf8");
    const result = run(sandbox, writePayload(sandbox));
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
    assert.strictEqual(fs.readFileSync(file, "utf8"), contents);
    assert.deepStrictEqual(readAuditRecords(sandbox), []);
  }
});

test("duplicate dispatch callbacks preserve the write window, state, and audit", (t) => {
  for (const toolName of ["Agent", "Task"]) {
    for (const launched of [false, true]) {
      const sandbox = makeSandbox(t);
      const payload = dispatchPayload(sandbox, { toolName, subagentType: "fusion:claude-worker" });
      if (launched) assert.strictEqual(runRaw(sandbox, { ...payload, hook_event_name: "PreToolUse" }).status, 0);
      assert.strictEqual(runRaw(sandbox, payload).status, 0);
      assert.strictEqual(run(sandbox, writePayload(sandbox)).status, 0);
      const file = stateFileFor(sandbox, "session-1");
      const before = fs.readFileSync(file, "utf8");
      const audit = readAuditRecords(sandbox);
      const repeated = runRaw(sandbox, payload);
      assert.strictEqual(repeated.status, 0);
      assert.strictEqual(repeated.stdout, "");
      assert.strictEqual(repeated.stderr, "");
      assert.strictEqual(fs.readFileSync(file, "utf8"), before);
      assert.deepStrictEqual(readAuditRecords(sandbox), audit);
      assert.deepStrictEqual(JSON.parse(before).dispatches, { "fusion:claude-worker": 1 });
      assert.strictEqual(JSON.parse(before).writesSinceDispatch, 1);
    }
  }
});

test("concurrent deliveries of a dispatch callback confirm it once", async (t) => {
  const sandbox = makeSandbox(t);
  const payload = dispatchPayload(sandbox, { subagentType: "fusion:claude-worker" });
  assert.strictEqual(runRaw(sandbox, { ...payload, hook_event_name: "PreToolUse" }).status, 0);
  const results = await Promise.all(Array.from({ length: 4 }, () => runAsyncRaw(sandbox, payload)));
  for (const result of results) assert.deepStrictEqual(result, { status: 0, stdout: "", stderr: "" });
  const state = readState(sandbox, "session-1");
  assert.deepStrictEqual(state.dispatches, { "fusion:claude-worker": 1 });
  assert.strictEqual(state.dispatchEpoch, 1);
  assert.strictEqual(state.dispatchLog.length, 1);
  assert.strictEqual(readAuditRecords(sandbox).filter((event) => event.event === "dispatch").length, 1);
});

test("dispatch callback deduplication survives log truncation and legacy state", (t) => {
  for (const legacy of [false, true]) {
    const sandbox = makeSandbox(t);
    const payload = dispatchPayload(sandbox, { subagentType: "fusion:claude-worker" });
    assert.strictEqual(run(sandbox, payload).status, 0);
    const file = stateFileFor(sandbox, "session-1");
    const state = readState(sandbox, "session-1");
    if (legacy) delete state.confirmedDispatchIds;
    else state.dispatchLog = [];
    fs.writeFileSync(file, `${JSON.stringify(state)}\n`);
    const before = fs.readFileSync(file, "utf8");
    const audit = readAuditRecords(sandbox);
    assert.strictEqual(runRaw(sandbox, payload).status, 0);
    assert.strictEqual(fs.readFileSync(file, "utf8"), before);
    assert.deepStrictEqual(readAuditRecords(sandbox), audit);
  }
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
  for (let index = 0; index < 5; index += 1) {
    run(sandbox, writePayload(sandbox));
  }
  const attempted = dispatchPayload(sandbox, { subagentType: "fusion:claude-worker" });
  attempted.hook_event_name = "PreToolUse";
  run(sandbox, attempted);

  assert.deepStrictEqual(readState(sandbox, "session-1").dispatches, {});
  assert.strictEqual(readState(sandbox, "session-1").dispatchLog[0].phase, "launched");
  const allowedWrite = run(sandbox, writePayload(sandbox));
  assert.strictEqual(allowedWrite.stdout, "");
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 6);
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
    path: "nested/file.txt",
    writeCount: 1,
    replayTokens: 400_000,
    budget: 2_000_000
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
    JSON.stringify({ writeCount: 4, dispatches: { grok: 2 }, createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z" }),
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

test("out-of-workspace writes are audited without entering the write window", (t) => {
  const sandbox = makeSandbox(t);
  const writes = [
    { toolName: "Edit", filePath: "/Users/x/.claude/projects/slug/memory/note.md" },
    { toolName: "Write", filePath: path.join(os.tmpdir(), "raw-args-transport", "payload.json"), toolInput: { content: "[]" } }
  ];
  for (const write of writes) {
    const result = run(sandbox, writePayload(sandbox, write), { });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
  }
  assert.strictEqual(readState(sandbox, "session-1").writeCount, 0);
  assert.strictEqual(readState(sandbox, "session-1").writesSinceDispatch, 0);
  assert.strictEqual(readState(sandbox, "session-1").turn.kind, "other");
  const records = readAuditRecords(sandbox).filter((event) => event.event !== "replay");
  assert.strictEqual(readAuditRecords(sandbox).filter((event) => event.event === "replay").length, 1);
  assert.strictEqual(records.length, 2);
  assert.ok(records.every((record) => record.event === "write" && !Object.hasOwn(record, "writeCount") && !Object.hasOwn(record, "path")));

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
    path: "repo-relative.txt",
    writeCount: 1,
    replayTokens: 400_000,
    budget: 2_000_000
  });
});

test("FUSION_INLINE_REPLAY_BUDGET_TOKENS overrides the default threshold", (t) => {
  const sandbox = makeSandbox(t);
  const base = Date.parse("2026-07-21T00:00:00.000Z");
  const runRead = (turn) => run(sandbox, readPayload(sandbox), { FUSION_INLINE_REPLAY_BUDGET_TOKENS: "800000", FUSION_TEST_NOW: new Date(base + turn * 1600).toISOString() });
  assert.strictEqual(runRead(1).stdout, "");
  const reason = advisoryContext(runRead(2), "inline-guard.read-streak-advisory");
  assert.match(reason, /^2 read only turns in a row replayed 800k tokens of context\./);
  assert.strictEqual(readAuditRecords(sandbox).at(-1).budget, 800_000);
});

test("a nonsense FUSION_INLINE_REPLAY_BUDGET_TOKENS value falls back to the default of 2,000,000 tokens", (t) => {
  const sandbox = makeSandbox(t);
  const base = Date.parse("2026-07-21T00:00:00.000Z");
  for (let turn = 1; turn <= 5; turn += 1) {
    const result = run(sandbox, readPayload(sandbox), { FUSION_INLINE_REPLAY_BUDGET_TOKENS: "not-a-number", FUSION_TEST_NOW: new Date(base + turn * 1600).toISOString() });
    if (turn < 5) assert.strictEqual(result.stdout, "");
    else assert.match(advisoryContext(result, "inline-guard.read-streak-advisory"), /^5 read only turns in a row replayed 2\.0M tokens of context\./);
  }
  assert.strictEqual(readAuditRecords(sandbox).at(-1).budget, 2_000_000);
});

test("stale session state is pruned after 48 hours", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.stateDir, { recursive: true });
  const staleFile = stateFileFor(sandbox, "old-session");
  fs.writeFileSync(staleFile, JSON.stringify({ writeCount: 5, dispatches: {}, createdAt: "x", updatedAt: "x" }), "utf8");
  const oldTime = new Date(Date.now() - 49 * 60 * 60 * 1000);
  fs.utimesSync(staleFile, oldTime, oldTime);

  run(sandbox, writePayload(sandbox, { sessionId: "session-2" }));
  assert.strictEqual(fs.existsSync(staleFile), false);
});

test("main-session Read lock counts stay constant after pruning as unrelated sessions grow", (t) => {
  const counts = [];
  for (const unrelatedSessions of [0, 100]) {
    const sandbox = makeSandbox(t);
    const payload = { ...readPayload(sandbox), transcript_path: path.join(sandbox.root, "transcript.jsonl"), tool_use_id: "read-call" };
    writeDispatchTranscript(sandbox, [{ messageId: "msg_first", payloads: [payload] }]);
    handleInlineDelegationHook(payload, envFor(sandbox));
    for (let index = 0; index < unrelatedSessions; index += 1) {
      fs.writeFileSync(stateFileFor(sandbox, `unrelated-${index}`), "{}");
    }
    const file = stateFileFor(sandbox, "session-1");
    const locks = [];
    const writes = [];
    let scans = 0;
    const open = fs.openSync;
    const readdir = fs.readdirSync;
    const rename = fs.renameSync;
    const openMock = t.mock.method(fs, "openSync", function (target, ...args) {
      if (String(target).endsWith(".lock")) locks.push(String(target));
      return open.call(this, target, ...args);
    });
    const readdirMock = t.mock.method(fs, "readdirSync", function (target, ...args) {
      if (target === sandbox.stateDir) scans += 1;
      return readdir.call(this, target, ...args);
    });
    const renameMock = t.mock.method(fs, "renameSync", function (source, target, ...args) {
      if (target === file) writes.push(JSON.parse(fs.readFileSync(source, "utf8")));
      return rename.call(this, source, target, ...args);
    });
    try {
      assert.deepStrictEqual(handleInlineDelegationHook(payload, envFor(sandbox)), {});
      const sameTurn = locks.length;
      assert.deepStrictEqual(locks, [`${file}.lock`]);
      writeDispatchTranscript(sandbox, [{ messageId: "msg_second", payloads: [payload] }]);
      locks.length = 0;
      assert.deepStrictEqual(handleInlineDelegationHook(payload, envFor(sandbox)), {});
      assert.strictEqual(locks.filter((lock) => lock === `${file}.lock`).length, 1);
      assert.strictEqual(scans, 0);
      assert.strictEqual(writes.length, 2);
      assert.strictEqual(writes[0].turn.key, "msg_first");
      assert.strictEqual(writes[0].readStreakTurns, 1);
      assert.strictEqual(writes[1].turn.key, "msg_second");
      assert.strictEqual(writes[1].readStreakTurns, 2);
      assert.strictEqual(writes[1].readStreakReplayTokens, 800_000);
      counts.push({ sameTurn, newTurn: locks.length });
      t.diagnostic(`${unrelatedSessions} unrelated sessions: ${sameTurn} locks for the same turn, ${locks.length} for a new turn`);
    } finally {
      openMock.mock.restore();
      readdirMock.mock.restore();
      renameMock.mock.restore();
    }
  }
  assert.deepStrictEqual(counts, [{ sameTurn: 1, newTurn: 2 }, { sameTurn: 1, newTurn: 2 }]);
});

test("stale pruning persists a ten minute throttle per data directory including callbacks", (t) => {
  const sandbox = makeSandbox(t);
  const now = Date.parse("2026-07-21T00:00:00.000Z");
  const payload = { ...readPayload(sandbox), hook_event_name: "PostToolUse" };
  const env = { FUSION_DATA_DIR: sandbox.dataDir, FUSION_INLINE_GUARD_STATE: "" };
  const directory = path.join(sandbox.dataDir, "inline-guard");
  fs.mkdirSync(directory, { recursive: true });
  const seed = (name, age) => {
    const file = path.join(directory, `${name}.json`);
    fs.writeFileSync(file, "{}");
    fs.utimesSync(file, new Date(now - age), new Date(now - age));
    return file;
  };
  const expired = seed("expired", 49 * 60 * 60 * 1000);
  const justExpired = seed("just-expired", 48 * 60 * 60 * 1000 + 1);
  const boundary = seed("boundary", 48 * 60 * 60 * 1000);
  const justFresh = seed("just-fresh", 48 * 60 * 60 * 1000 - 1);
  const fresh = seed("fresh", 47 * 60 * 60 * 1000);
  assert.strictEqual(fs.statSync(boundary).mtimeMs, now - 48 * 60 * 60 * 1000);
  assert.strictEqual(run(sandbox, payload, { ...env, FUSION_TEST_NOW: new Date(now).toISOString() }).status, 0);
  assert.strictEqual(fs.existsSync(expired), false);
  assert.strictEqual(fs.existsSync(justExpired), false);
  assert.strictEqual(fs.existsSync(boundary), true);
  assert.strictEqual(fs.existsSync(justFresh), true);
  assert.strictEqual(fs.existsSync(fresh), true);
  const marker = path.join(directory, ".prune");
  assert.strictEqual(JSON.parse(fs.readFileSync(marker, "utf8")), now);
  assert.strictEqual(fs.statSync(marker).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(directory).mode & 0o777, 0o700);
  const later = seed("later", 49 * 60 * 60 * 1000);
  for (const hook_event_name of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
    assert.strictEqual(run(sandbox, { ...payload, hook_event_name }, { ...env, FUSION_TEST_NOW: new Date(now + 599_999).toISOString() }).status, 0);
    assert.strictEqual(fs.existsSync(later), true);
    assert.strictEqual(JSON.parse(fs.readFileSync(marker, "utf8")), now);
  }
  assert.strictEqual(run(sandbox, payload, { ...env, FUSION_TEST_NOW: new Date(now + 600_000).toISOString() }).status, 0);
  assert.strictEqual(fs.existsSync(later), false);
  assert.strictEqual(fs.existsSync(boundary), false);
  assert.strictEqual(fs.existsSync(justFresh), false);
  assert.strictEqual(fs.existsSync(fresh), true);
  assert.strictEqual(JSON.parse(fs.readFileSync(marker, "utf8")), now + 600_000);
  const other = makeSandbox(t);
  fs.mkdirSync(other.stateDir, { recursive: true });
  const otherStale = stateFileFor(other, "expired");
  fs.writeFileSync(otherStale, "{}");
  fs.utimesSync(otherStale, new Date(now - 49 * 60 * 60 * 1000), new Date(now - 49 * 60 * 60 * 1000));
  assert.strictEqual(run(other, { ...readPayload(other), hook_event_name: "PostToolUse" }, { FUSION_TEST_NOW: new Date(now).toISOString() }).status, 0);
  assert.strictEqual(fs.existsSync(otherStale), false);
});

test("concurrent callbacks perform only one stale-session sweep", async (t) => {
  const sandbox = makeSandbox(t);
  const sweeps = path.join(sandbox.root, "sweeps");
  const preload = path.join(sandbox.root, "prune-count.mjs");
  fs.writeFileSync(preload, `import fs from 'node:fs'; const readdir = fs.readdirSync; fs.readdirSync = function (target, ...args) { if (target === ${JSON.stringify(sandbox.stateDir)}) fs.appendFileSync(${JSON.stringify(sweeps)}, 'scan\\n'); return readdir.call(this, target, ...args); };`);
  const results = await Promise.all(Array.from({ length: 6 }, () => runAsyncRaw(sandbox, { ...readPayload(sandbox), hook_event_name: "PostToolUse" }, { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`.trim() })));
  for (const result of results) {
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
  }
  assert.strictEqual(fs.readFileSync(sweeps, "utf8"), "scan\n");
  assert.strictEqual(fs.existsSync(path.join(sandbox.stateDir, ".prune.lock")), false);
});

test("stale state pruning skips a file held by another process", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.stateDir, { recursive: true });
  const staleFile = stateFileFor(sandbox, "old-session");
  fs.writeFileSync(staleFile, "{}", "utf8");
  const oldTime = new Date(Date.now() - 49 * 60 * 60 * 1000);
  fs.utimesSync(staleFile, oldTime, oldTime);
  fs.writeFileSync(`${staleFile}.lock`, "other-process", "utf8");
  const now = Date.now();
  run(sandbox, writePayload(sandbox, { sessionId: "session-2" }), { FUSION_TEST_NOW: new Date(now).toISOString() });
  assert.strictEqual(fs.existsSync(staleFile), true);
  fs.rmSync(`${staleFile}.lock`);
  run(sandbox, writePayload(sandbox, { sessionId: "session-2" }), { FUSION_TEST_NOW: new Date(now + 600_000).toISOString() });
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

test("audit rotates by size without losing write or replay records", (t) => {
  const sandbox = makeSandbox(t);
  const extraEnv = { FUSION_INLINE_GUARD_AUDIT_MAX_BYTES: "1", FUSION_INLINE_GUARD_AUDIT_MAX_FILES: "20", };
  for (let index = 0; index < 6; index += 1) {
    run(sandbox, writePayload(sandbox), extraEnv);
  }

  const audit = readAuditEvents({ auditDir: sandbox.auditDir });
  assert.strictEqual(auditFiles(sandbox).length, 12);
  assert.strictEqual(audit.events.length, 12);
  assert.strictEqual(audit.events.filter((event) => event.event === "replay").length, 6);
  assert.strictEqual(audit.events.filter((event) => event.event === "write").length, 6);
  assert.strictEqual(audit.events.filter((event) => event.event === "warn").length, 0);
  assert.strictEqual(audit.events.filter((event) => event.event === "deny").length, 0);
});

test("audit malformed counts include only segments and timestamps overlapping the window", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.auditDir, { recursive: true });
  const event = { schemaVersion: 1, at: "2026-11-18T10:00:00.000Z", session: "session-1", event: "dispatch", lane: "codex", tool: "Agent" };
  for (const [day, lines] of [
    ["2026-11-07", ["{old", "null", JSON.stringify(event)]],
    ["2026-11-16", ["{boundary"]],
    ["2026-11-19", ["{recent", JSON.stringify({ at: event.at }), JSON.stringify({ at: "2026-11-07T10:00:00.000Z" }), JSON.stringify({ at: "2026-11-20T10:00:00.000Z" })]],
    ["2026-11-20", ["{future"]]
  ]) {
    fs.writeFileSync(path.join(sandbox.auditDir, `events-${day}.jsonl`), `${lines.join("\n")}\n`);
  }
  const sinceMs = Date.parse("2026-11-16T12:00:00.000Z");
  const untilMs = Date.parse("2026-11-19T12:00:00.000Z");
  const scoped = readAuditEvents({ auditDir: sandbox.auditDir, sinceMs, untilMs });
  assert.strictEqual(scoped.malformedCount, 3);
  assert.deepStrictEqual(scoped.events, [event]);
  assert.strictEqual(readAuditEvents({ auditDir: sandbox.auditDir, since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() }).malformedCount, 3);
  assert.strictEqual(readAuditEvents({ auditDir: sandbox.auditDir }).malformedCount, 8);
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

function taskControlPayload(sandbox, { sessionId = "session-1", toolName = "TaskStop", taskId } = {}) {
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
    messageCode: messageCode("inline-guard.no-op-heartbeat-deny")
  });
  assert.ok(!Object.hasOwn(denies[0], "path"));
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

test("read streak advises at five turns and each doubling", (t) => {
  const sandbox = makeSandbox(t);
  const base = Date.parse("2026-07-21T00:00:00.000Z");
  const warnings = [];
  for (let turn = 1; turn <= 20; turn += 1) {
    const tool = ["Read", "Grep", "Glob"][turn % 3];
    const result = run(sandbox, readPayload(sandbox, tool), { FUSION_TEST_NOW: new Date(base + turn * 1600).toISOString() });
    if ([5, 10, 20].includes(turn)) {
      assert.strictEqual(JSON.parse(result.stdout).hookSpecificOutput.additionalContext,
        tagMessage("inline-guard.read-streak-advisory", `${turn} read only turns in a row replayed ${(turn * 0.4).toFixed(1)}M tokens of context. Batch independent reads into one message, and send open ended reconnaissance to Explore.`));
      warnings.push(turn);
    } else assert.strictEqual(result.stdout, "", `turn ${turn}`);
  }
  assert.deepStrictEqual(warnings, [5, 10, 20]);
  assert.strictEqual(readState(sandbox, "session-1").readStreakTurns, 20);
  assert.strictEqual(readState(sandbox, "session-1").readStreakReplayTokens, 8_000_000);
  assert.deepStrictEqual(readAuditRecords(sandbox).filter((event) => event.reason === "read-streak-advisory").map((event) => ({
    event: event.event, reason: event.reason, replayTokens: event.replayTokens, budget: event.budget,
    messageCode: event.messageCode, lane: event.lane, tool: event.tool
  })), [5, 10, 20].map((turn) => ({
    event: "warn", reason: "read-streak-advisory", replayTokens: turn * 400_000, budget: 2_000_000,
    messageCode: messageCode("inline-guard.read-streak-advisory"), lane: "main", tool: ["Read", "Grep", "Glob"][turn % 3]
  })));
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

test("read streak reads skip a held state lock promptly without output", (t) => {
  const sandbox = makeSandbox(t);
  for (let turn = 0; turn < 4; turn += 1) {
    run(sandbox, readPayload(sandbox), { FUSION_TEST_NOW: new Date(Date.parse("2026-07-21T00:00:00.000Z") + turn * 1600).toISOString() });
  }
  const file = stateFileFor(sandbox, "session-1");
  const before = readAuditRecords(sandbox);
  fs.writeFileSync(`${file}.lock`, String(process.pid));
  for (const payload of [readPayload(sandbox, "Read"), readPayload(sandbox, "Grep"), readPayload(sandbox, "Glob"), bashPayload(sandbox, { command: "cat file" })]) {
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
  assert.strictEqual(normalizeState(null, at).writeTurnTokens, 0);
  assert.strictEqual(normalizeState(null, at).writeTurnWrites, 0);
  assert.deepStrictEqual(normalizeState({ turn, readStreakReplayTokens: 80_000 }, at).turn, turn);
  assert.deepStrictEqual(normalizeState({ turn: { ...turn, id: null, key: `t:${Date.parse(at)}` } }, at).turn, { ...turn, id: null, key: `t:${Date.parse(at)}` });
  for (const change of [{ id: "bad id" }, { id: undefined }, { key: "" }, { key: "bad key" }, { at: "bad" }, { kind: "unknown" }, { tokens: 0 }, { tokens: -1 }, { tokens: 1.5 }, { tokens: Number.MAX_SAFE_INTEGER + 1 }, { measured: "true" }]) {
    assert.strictEqual(normalizeState({ turn: { ...turn, ...change } }, at).turn, null, JSON.stringify(change));
  }
  for (const tokens of [-1, 1.5, "80000", Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.strictEqual(normalizeState({ readStreakReplayTokens: tokens }, at).readStreakReplayTokens, 0);
    assert.strictEqual(normalizeState({ writeReplayTokens: tokens }, at).writeReplayTokens, 0);
    assert.strictEqual(normalizeState({ writeTurnTokens: tokens }, at).writeTurnTokens, 0);
    assert.strictEqual(normalizeState({ writeTurnWrites: tokens }, at).writeTurnWrites, 0);
  }
  for (const tokens of [0, 80_000, Number.MAX_SAFE_INTEGER]) {
    assert.strictEqual(normalizeState({ writeReplayTokens: tokens }, at).writeReplayTokens, tokens);
    assert.strictEqual(normalizeState({ writeTurnTokens: tokens }, at).writeTurnTokens, tokens);
    assert.strictEqual(normalizeState({ writeTurnWrites: tokens }, at).writeTurnWrites, tokens);
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
    ["TaskStop", { task_id: "unknown" }, "other"],
    ["Skill", {}, "other"]
  ];
  for (const [tool, toolInput, kind] of cases) {
    const sandbox = makeSandbox(t);
    const payload = { ...readPayload(sandbox, tool), tool_input: toolInput };
    const result = handleInlineDelegationHook(payload, envFor(sandbox));
    assert.deepStrictEqual(result, {}, `${tool} ${JSON.stringify(toolInput)}`);
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
    assert.deepStrictEqual(handleInlineDelegationHook({ ...readPayload(sandbox), hook_event_name }, envFor(sandbox)), {});
  }
  for (const agent_id of ["worker-1", ""]) {
    assert.deepStrictEqual(handleInlineDelegationHook({ ...readPayload(sandbox), agent_id }, envFor(sandbox)), {});
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
    consecutiveNarrowWaves: 2, lastAdvisedNarrowWaveStreak: 2, advisedNarrowWaveSignatures: ["a".repeat(64)] }));
  run(sandbox, readPayload(sandbox), { FUSION_TEST_NOW: "2026-07-21T00:00:01.600Z" });
  const state = readState(sandbox, "session-1");
  for (const key of ["fleetWaveWidth", "consecutiveNarrowWaves", "lastAdvisedNarrowWaveStreak", "advisedNarrowWaveSignatures"]) {
    assert.strictEqual(Object.hasOwn(state, key), false, key);
  }
});

test("hooks configuration wires PreToolUse read, write, Bash, dispatch, and TaskStop tools through the inline guard", () => {
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
      matcher: "^TaskStop$",
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

test("all plugin node hooks fail open without node and compact runs the session context hook", () => {
  for (const plugin of ["codex", "grok", "cursor", "fusion"]) {
    const hooks = JSON.parse(fs.readFileSync(path.join(repoRoot, "plugins", plugin, "hooks", "hooks.json"), "utf8")).hooks;
    for (const groups of Object.values(hooks)) for (const group of groups) for (const hook of group.hooks) {
      if (!hook.command.includes("node ") || hook.command.includes("session-start.mjs\" --compact")) continue;
      assert.ok(hook.command.startsWith("command -v node >/dev/null 2>&1 || exit 0; "), `${plugin}: ${hook.command}`);
      const result = spawnSync("/bin/sh", ["-c", hook.command], { env: { PATH: "/nonexistent", CLAUDE_PLUGIN_ROOT: "/nonexistent" }, encoding: "utf8" });
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, "");
      assert.strictEqual(result.stderr, "");
    }
    if (plugin === "fusion") {
      const compactCommand = hooks.SessionStart.find((group) => group.matcher === "compact").hooks[0].command;
      assert.strictEqual(compactCommand, `command -v node >/dev/null 2>&1 || { echo 'Fusion rules are in ~/.claude/rules/orchestration.md. Collect and settle any in-flight work. [fusion:9902]'; exit 0; }; node "\${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs" --compact`);
      const fallback = spawnSync("/bin/sh", ["-c", compactCommand], { env: { PATH: "/nonexistent", CLAUDE_PLUGIN_ROOT: "/nonexistent" }, encoding: "utf8" });
      assert.strictEqual(fallback.status, 0);
      assert.strictEqual(fallback.stdout, "Fusion rules are in ~/.claude/rules/orchestration.md. Collect and settle any in-flight work. [fusion:9902]\n");
      assert.strictEqual(fallback.stderr, "");
    }
  }
});
