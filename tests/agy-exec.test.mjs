import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildAgyChildEnv, classifyAgyFailure, compareAgyVersion, OPERATING_LIMITS_NOTE, probeAgyVersion, redactCredentialValue, resolveAgyBin, runAgy, TESTED_AGY_INTERVAL, toolsForMode } from "../plugins/agy/scripts/lib/agy-exec.mjs";

const bin = path.resolve("tests/fake-agy");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-exec-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return root;
}

async function fakeRun(t, scenario, { env: extraEnv, ...options } = {}) {
  const root = fixture(t);
  const logFile = path.join(root, "run.log");
  const env = { ...process.env, FAKE_AGY_SCENARIO: scenario, FAKE_AGY_LOG: logFile, ...extraEnv };
  const result = await runAgy({ bin, cwd: root, env, geminiDir: root, brief: "private brief\n", timeoutMs: 2000, exitGraceMs: 75, killGraceMs: 75, mode: "consult", ...options });
  return { result, log: JSON.parse(fs.readFileSync(logFile, "utf8")), root };
}

function selections({ stage }) {
  return stage === "model" ? [{ configId: "model", value: "gemini-4-neon" }] : [{ configId: "thought_level", value: "xhigh" }];
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(predicate(), "Condition did not become true");
}

function processGone(pid) {
  try {
    process.kill(pid, 0);
    return process.platform === "linux" && fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] === "Z";
  } catch (error) {
    if (error.code === "ESRCH" || error.code === "ENOENT") return true;
    throw error;
  }
}

test("binary resolution parses the bare version and resolves PATH", (t) => {
  const root = fixture(t);
  fs.symlinkSync(bin, path.join(root, "agy"));
  const env = { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}` };
  assert.equal(resolveAgyBin({}), "agy");
  assert.equal(resolveAgyBin({ AGY_BIN: ` ${bin} ` }), bin);
  assert.deepEqual(probeAgyVersion(resolveAgyBin(env), env), { version: "1.5.12", buildPath: fs.realpathSync(bin) });
  assert.throws(() => probeAgyVersion("/missing/agy"), (error) => error.failureKind === "missing_cli");
  for (const version of ["agy 1.5.12", "unknown", "1.5", "1.5.12 extra"]) {
    fs.writeFileSync(path.join(root, ".fake-agy-version.json"), JSON.stringify({ version }));
    assert.throws(() => probeAgyVersion(bin, { ...process.env, HOME: root }), (error) => error.failureKind === "setup");
  }
  assert.deepEqual(TESTED_AGY_INTERVAL, { floor: "1.5", ceiling: "1.6" });
  for (const [version, expected] of [["1.4.99", -1], ["1.5.0", 0], ["1.5.12", 1]]) assert.equal(compareAgyVersion(version, "1.5"), expected);
  assert.equal(compareAgyVersion("1.6.0", "1.6"), 0);
});

test("version probe drops parent API credentials and preserves allowed environment", (t) => {
  const root = fixture(t);
  const logFile = path.join(root, "probe.json");
  fs.writeFileSync(path.join(root, ".fake-agy-version.json"), JSON.stringify({ logFile }));
  const env = { ...process.env, HOME: root, GEMINI_API_KEY: "parent-secret" };
  assert.equal(probeAgyVersion(bin, env).version, "1.5.12");
  assert.deepEqual(JSON.parse(fs.readFileSync(logFile, "utf8")), { home: root, path: env.PATH });
  assert.equal(env.GEMINI_API_KEY, "parent-secret");
});

test("tools follow the contract for consult, review, and write", () => {
  const read = ["read_file", "search_web", "run_command"];
  const write = [...read, "edit_file", "write_file"];
  assert.deepEqual(toolsForMode("consult"), read);
  assert.deepEqual(toolsForMode("review"), read);
  assert.deepEqual(toolsForMode("write"), write);
  toolsForMode("consult").push("webfetch");
  assert.deepEqual(toolsForMode("consult"), read);
  assert.throws(() => toolsForMode("unknown"), /Invalid Antigravity mode/);
});

test("success records exact usage, agent version, isolated flags, and handshake", async (t) => {
  const { result, log, root } = await fakeRun(t, "success");
  assert.equal(classifyAgyFailure(result), null);
  assert.equal(result.sessionId, "a0123456-789a-4bcd-8ef0-123456789abc");
  assert.equal(result.agentVersion, "1.5.12");
  assert.equal(result.resultText, "fake result");
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(result.usage, { totalTokens: 11914, inputTokens: 11875, outputTokens: 39, cachedReadTokens: 11552, thoughtTokens: 12, cachedWriteTokens: 0 });
  assert.deepEqual(result.appliedOptions, { mode: "default", model: "gemini-4-neon", thought_level: "high" });
  assert.equal(result.toolCalls, 2);
  assert.equal(log.cwd, fs.realpathSync(root));
  assert.equal(log.stdinEnded, true);
  assert.deepEqual(log.argv, ["acp", "--disable-telemetry", "--include-default-customizations=false", "--sandbox", "--gemini-dir", root, "--app-data-dir", "agy"]);
  assert.deepEqual(log.messages.map((message) => message.method), ["initialize", "session/new", "session/set_mode", "session/set_config_option", "session/set_config_option", "session/prompt"]);
  assert.deepEqual(log.messages[0].params, { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  assert.deepEqual(log.messages[1].params, { cwd: root, mcpServers: [] });
  assert.deepEqual(log.messages[2].params, { sessionId: result.sessionId, modeId: "default" });
  assert.equal(log.messages.at(-1).params.prompt[0].text, `${OPERATING_LIMITS_NOTE}\n\nprivate brief\n`);
});

test("usage preserves absent and additional keys", async (t) => {
  const absent = await fakeRun(t, "no_cache_usage");
  assert.equal(Object.hasOwn(absent.result.usage, "cachedReadTokens"), false);
  assert.equal((await fakeRun(t, "extra_usage")).result.usage.vendorTokens, 7);
});

test("the browser blocker leads the child PATH", async (t) => {
  const { log, root } = await fakeRun(t, "success");
  assert.equal(log.firstPathEntry, path.join(root, "bin"));
});

test("resume excludes replay text, checks allowed replay tools, and retains the session model", async (t) => {
  const { result, log } = await fakeRun(t, "success", { resumeSessionId: "b0123456-789a-4bcd-8ef0-123456789abc", env: { FAKE_AGY_CURRENT_MODEL: "gemini-4-argon" } });
  assert.equal(classifyAgyFailure(result), null);
  assert.equal(result.resultText, "fake result");
  assert.equal(result.appliedOptions.model, "gemini-4-argon");
  assert.equal(result.toolCalls, 3);
  assert.equal(log.messages[1].method, "session/load");
});

test("resume enforces tool policy before prompting throughout session load", async (t) => {
  for (const scenario of ["replay_forbidden_tool", "replay_forbidden_update", "replay_bypass", "replay_forbidden_after_load"]) {
    const { result, log } = await fakeRun(t, scenario, { resumeSessionId: "b0123456-789a-4bcd-8ef0-123456789abc" });
    assert.equal(classifyAgyFailure(result), "policy", scenario);
    assert.equal(result.timedOut, false, scenario);
    assert.equal(log.messages.some((message) => message.method === "session/prompt"), false, scenario);
    assert.equal(result.resultText, "", scenario);
  }
});

test("selection errors preserve input or setup and abort before prompting", async (t) => {
  for (const stage of ["model", "effort"]) {
    for (const failureKind of ["input", "setup"]) {
      const { result, log } = await fakeRun(t, "success", { resolveSelection: (selection) => {
        if (selection.stage !== stage) return selections(selection);
        throw Object.assign(new Error("Selection unavailable"), { failureKind });
      } });
      assert.deepEqual(result.selectionError, { failureKind, message: "Selection unavailable" });
      assert.equal(classifyAgyFailure(result), failureKind);
      assert.equal(log.messages.some((message) => message.method === "session/prompt"), false);
      assert.equal(log.stdinEnded, true);
      assert.equal(result.timedOut, false);
    }
  }
});

test("each configured value must be acknowledged before proceeding", async (t) => {
  for (const configId of ["mode", "model", "thought_level"]) {
    const { result, log } = await fakeRun(t, "success", { env: { FAKE_AGY_MISMATCH_CONFIG: configId }, resolveSelection: ({ stage }) => {
      if (stage === "model" && configId === "model") return [{ configId: "model", value: "gemini-4-argon" }];
      return selections({ stage });
    } });
    assert.equal(classifyAgyFailure(result), "setup", configId);
    assert.match(result.setupError, /did not apply/);
    if (configId !== "mode") assert.equal(Object.hasOwn(result.appliedOptions, configId), false);
    assert.equal(log.messages.at(-1).params.configId, configId === "mode" ? "model" : configId);
    assert.equal(log.stdinEnded, true);
  }
});

test("invalid set values retain the RPC error and fail setup without prompting", async (t) => {
  const { result, log } = await fakeRun(t, "success", { resolveSelection: () => [{ configId: "model", value: "x" }] });
  assert.equal(classifyAgyFailure(result), "setup");
  assert.deepEqual(result.rpcError, { method: "session/set_config_option", code: -32602, message: "Invalid params", data: "Invalid value 'x' for config option 'model'" });
  assert.equal(result.setupError, "Invalid value 'x' for config option 'model'");
  assert.deepEqual(result.appliedOptions, { mode: "default" });
  assert.equal(log.messages.at(-1).params.configId, "model");
  const mode = await fakeRun(t, "success", { mode: "write", env: { FAKE_AGY_REJECT_CONFIG: "mode" } });
  assert.equal(classifyAgyFailure(mode.result), "setup");
  assert.equal(mode.log.messages.some((message) => message.method === "session/prompt"), false);
});

test("the operating limits note precedes the brief and names the allowlist in every mode", async (t) => {
  for (const mode of ["consult", "review", "write"]) {
    const { log } = await fakeRun(t, "success", { mode });
    assert.equal(log.messages.at(-1).params.prompt[0].text, `${OPERATING_LIMITS_NOTE}\n\nprivate brief\n`, mode);
  }
  for (const program of ["ls", "pwd", "cat", "head", "tail", "wc", "stat", "grep", "rg", "find", "git"]) {
    assert.ok(OPERATING_LIMITS_NOTE.includes(program), program);
  }
});

function refuseBin(t, refusals) {
  const root = fixture(t);
  const bin = path.join(root, "agy");
  fs.writeFileSync(bin, `#!/usr/bin/env node
import readline from "node:readline";
const refusals = ${JSON.stringify(refusals)};
const session = "a0123456-789a-4bcd-8ef0-123456789abc";
const emit = (event) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...event }) + "\\n");
let promptId;
let index = 0;
const request = () => emit({ id: index, method: "session/request_permission", params: { sessionId: session, toolCall: refusals[index], options: [{ optionId: "deny", kind: "reject_once" }] } });
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    index += 1;
    if (index < refusals.length) request();
    else emit({ id: promptId, result: { stopReason: "end_turn", usage: {} } });
    return;
  }
  if (message.method === "initialize") return emit({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "Antigravity", version: "1.5.12" } } });
  if (message.method === "session/new") return emit({ id: message.id, result: { sessionId: session, configOptions: [] } });
  if (message.method === "session/set_mode") return emit({ id: message.id, result: {} });
  if (message.method === "session/prompt") { promptId = message.id; return request(); }
  emit({ id: message.id, error: { code: -32601, message: "Method not found" } });
});
input.on("close", () => process.exit(0));
`, { mode: 0o755 });
  return { root, bin };
}

test("refused permission requests record tool and truncated command, capped at five", async (t) => {
  const long = `rm ${"xx ".repeat(80)}`;
  const { root, bin: fake } = refuseBin(t, [
    { name: "run_command", rawInput: { CommandLine: long } },
    { name: "read_file", rawInput: {} },
    { name: "edit_file" },
    { name: "run_command", rawInput: { CommandLine: "touch f0" } },
    { name: "run_command", rawInput: { CommandLine: "touch f1" } },
    { name: "run_command", rawInput: { CommandLine: "touch f2" } },
    { name: "run_command", rawInput: { CommandLine: "touch f3" } }
  ]);
  const result = await runAgy({ bin: fake, cwd: root, env: process.env, geminiDir: root, brief: "b", timeoutMs: 5000, exitGraceMs: 75, killGraceMs: 75, mode: "consult", resolveSelection: async () => [] });
  assert.equal(result.permissionsAllowed, 0);
  assert.equal(result.permissionsRejected, 7);
  assert.equal(result.refusedPermissions.length, 5);
  assert.deepEqual(result.refusedPermissions[0], { tool: "run_command", command: long.slice(0, 200) });
  assert.deepEqual(result.refusedPermissions[1], { tool: "read_file", command: null });
  assert.deepEqual(result.refusedPermissions[2], { tool: "edit_file", command: null });
  assert.deepEqual(result.refusedPermissions[4], { tool: "run_command", command: "touch f1" });
  assert.equal(classifyAgyFailure(result), "permission");
});

test("refused permission commands record credential shaped values redacted", async (t) => {
  const secret = "s3cr3t-token-value";
  for (const [command, expected] of [
    [`curl --token ${secret} https://example.invalid`, "curl --token [redacted] https://example.invalid"],
    [`curl --token=${secret} https://example.invalid`, "curl --token=[redacted] https://example.invalid"],
    [`env TOKEN=${secret} curl https://example.invalid`, "env TOKEN=[redacted] curl https://example.invalid"],
    [`curl -H 'Authorization: Bearer ${secret}'`, "curl -H 'Authorization: Bearer [redacted]'"],
    [`curl -H 'Authorization: Bearer ${secret}' --api-key ${secret}`, "curl -H 'Authorization: Bearer [redacted]' --api-key [redacted]"],
    [`echo ${"a1b2c3d4".repeat(4)}`, "echo [redacted]"],
    [`echo ${"deadbeef".repeat(3)} suffix`, "echo [redacted] suffix"]
  ]) {
    const { result } = await fakeRun(t, "permission_write", { env: { FAKE_AGY_COMMAND: command } });
    assert.deepEqual(result.refusedPermissions, [{ tool: "run_command", command: expected }], command);
    assert.ok(!JSON.stringify(result.refusedPermissions).includes(secret), command);
  }
});

test("redactCredentialValue masks every credential form and stays idempotent", () => {
  for (const [input, expected] of [
    ["--token abc", "--token [redacted]"],
    ["--token=abc", "--token=[redacted]"],
    ["--token 'a b c'", "--token [redacted]"],
    ["TOKEN=abc", "TOKEN=[redacted]"],
    ["token: abc", "token: [redacted]"],
    ["--api-key abc", "--api-key [redacted]"],
    ["X-Api-Key: abc", "X-Api-Key: [redacted]"],
    ["--secret xyz", "--secret [redacted]"],
    ["password=hunter2", "password=[redacted]"],
    ["--auth xyz", "--auth [redacted]"],
    ["Authorization: Bearer abc", "Authorization: Bearer [redacted]"],
    ["Bearer abc", "Bearer [redacted]"],
    ["--bearer abc", "--bearer [redacted]"],
    [`run ${"a1b2c3d4".repeat(4)}`, "run [redacted]"],
    [`run ${"0123456789abcdef01234567"}`, "run [redacted]"],
    ["run shorttoken123 here", "run shorttoken123 here"]
  ]) {
    assert.equal(redactCredentialValue(input), expected, input);
    assert.equal(redactCredentialValue(expected), expected, input);
  }
});

test("permission selection uses kind, counts decisions, and cancels without reject", async (t) => {
  for (const [scenario, allowed, optionId, refused] of [
    ["permission", true, "approval", []],
    ["permission_write", false, "denial", [{ tool: "run_command", command: "touch outside" }]],
    ["permission_read", false, "denial", [{ tool: "read_file", command: "git status --short" }]],
    ["permission_edit", false, "denial", [{ tool: "edit_file", command: "git status --short" }]],
    ["permission_no_allow", false, "denial", [{ tool: "run_command", command: "git status --short" }]],
    ["permission_no_reject", false, null, [{ tool: "run_command", command: "touch x" }]]
  ]) {
    const { result, log } = await fakeRun(t, scenario, { env: scenario === "permission_no_reject" ? { FAKE_AGY_COMMAND: "touch x" } : {} });
    assert.equal(classifyAgyFailure(result), null, scenario);
    assert.equal(result.permissionsAllowed, allowed ? 1 : 0, scenario);
    assert.equal(result.permissionsRejected, allowed ? 0 : 1, scenario);
    assert.deepEqual(result.refusedPermissions, refused, scenario);
    assert.deepEqual(log.messages.at(-1), { jsonrpc: "2.0", id: 0, result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } } }, scenario);
    assert.equal(result.resultText, allowed ? "before permission allowed" : "before permission");
  }
});

test("read_file outside the workspace is allowed unless the resolved path is sensitive", async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agy-read-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const home = path.join(outside, "home");
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.mkdirSync(path.join(home, ".cargo", "registry"), { recursive: true });
  fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "secret");
  fs.writeFileSync(path.join(home, ".netrc"), "secret");
  fs.writeFileSync(path.join(home, ".cargo", "registry", "lib.rs"), "source");
  fs.writeFileSync(path.join(outside, "review.diff"), "diff");
  fs.symlinkSync(path.join(home, ".ssh", "id_ed25519"), path.join(outside, "linked.diff"));
  const vault = path.join(outside, "vault");
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, "credentials"), "secret");
  fs.symlinkSync(vault, path.join(home, ".aws"));
  fs.writeFileSync(path.join(outside, "netrc-target"), "secret");
  fs.rmSync(path.join(home, ".netrc"));
  fs.symlinkSync(path.join(outside, "netrc-target"), path.join(home, ".netrc"));
  for (const [label, target, allowed] of [
    ["scratchpad file", path.join(outside, "review.diff"), true],
    ["dependency source", path.join(home, ".cargo", "registry", "lib.rs"), true],
    ["sensitive directory", path.join(home, ".ssh", "id_ed25519"), false],
    ["sensitive file", path.join(home, ".netrc"), false],
    ["symlink into a sensitive directory", path.join(outside, "linked.diff"), false],
    ["target of a symlinked sensitive directory", path.join(vault, "credentials"), false],
    ["target of a symlinked sensitive file", path.join(outside, "netrc-target"), false],
    ["missing file", path.join(outside, "missing.diff"), false],
    ["relative path", "review.diff", false]
  ]) {
    const { result, log } = await fakeRun(t, "permission_read", { realHome: home, env: { FAKE_AGY_READ_PATH: target } });
    assert.equal(result.permissionsAllowed, allowed ? 1 : 0, label);
    assert.equal(result.permissionsRejected, allowed ? 0 : 1, label);
    assert.deepEqual(log.messages.at(-1).result, { outcome: { outcome: "selected", optionId: allowed ? "approval" : "denial" } }, label);
  }
});

test("other agent requests receive method-not-found errors", async (t) => {
  const { result, log } = await fakeRun(t, "unknown_request");
  assert.equal(classifyAgyFailure(result), null);
  assert.deepEqual(log.messages.at(-1), { jsonrpc: "2.0", id: "client-request", error: { code: -32601, message: "Method not found" } });
});

test("permission refusals without result text fail even after a successful end_turn", async (t) => {
  for (const scenario of ["permission_empty", "permission_whitespace"]) {
    const { result } = await fakeRun(t, scenario);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.permissionsRejected, 1);
    assert.equal(result.resultText.trim(), "");
    assert.equal(classifyAgyFailure(result), "permission");
  }
});

test("forbidden tools terminate before initialization, during updates, and after the result", async (t) => {
  for (const scenario of ["forbidden_before_init", "forbidden_tool", "forbidden_update", "forbidden_after_result"]) {
    let pid;
    const { result } = await fakeRun(t, scenario, { onSpawn: (child) => { pid = child.pid; } });
    assert.ok(result.policyViolation, scenario);
    assert.equal(classifyAgyFailure(result), "policy", scenario);
    assert.equal(result.timedOut, false, scenario);
    assert.throws(() => process.kill(-pid, 0), (error) => error.code === "ESRCH");
  }
});

test("search_web tool calls remain allowed in consult mode", async (t) => {
  const { result } = await fakeRun(t, "web_search");
  assert.equal(result.policyViolation, null);
  assert.equal(classifyAgyFailure(result), null);
});

test("file writes are refused in consult and review and accepted with accept-edits mode", async (t) => {
  for (const mode of ["consult", "review", "write"]) {
    const { result, log } = await fakeRun(t, "write_tool", { mode });
    assert.equal(classifyAgyFailure(result), mode === "write" ? null : "policy", mode);
    assert.equal(log.messages[2].params.modeId, mode === "write" ? "accept-edits" : "default");
  }
});

for (const [scenario, kind] of [
  ["auth_required", "auth"], ["quota", "quota"], ["capacity", "rate_limited"], ["unavailable", "rate_limited"], ["http503", "rate_limited"],
  ["rate_limit", "rate_limited"], ["network", "network"], ["language_server", "setup"], ["refusal", "refused"],
  ["rpc_error", "error"], ["initialize_error", "error"], ["bad_protocol_version", "setup"],
  ["garbage", "protocol"], ["non_object", "protocol"], ["unknown_id", "protocol"], ["missing_session", "protocol"],
  ["no_result", "protocol"], ["no_result_nonzero", "protocol"], ["malformed_response", "protocol"],
  ["malformed_error", "protocol"], ["missing_stop_reason", "protocol"], ["missing_tool", "protocol"], ["oversized_line", "protocol"],
  ["unexpected_signal", "process"]
]) {
  test(`${scenario} classifies as ${kind}`, async (t) => {
    const { result, log } = await fakeRun(t, scenario);
    assert.equal(classifyAgyFailure(result), kind);
    assert.equal(result.timedOut, false);
    if (scenario === "bad_protocol_version") {
      assert.ok(result.setupError);
      assert.deepEqual(log.messages.map((message) => message.method), ["initialize"]);
    }
    if (scenario === "rpc_error") assert.deepEqual(result.rpcError, { method: "session/prompt", code: -32000, message: "Internal server error" });
    if (scenario === "initialize_error") assert.equal(result.rpcError.method, "initialize");
    if (kind === "protocol") assert.ok(result.protocolError);
  });
}

test("timeout sends session/cancel before closing stdin and reaps the group", async (t) => {
  let pid;
  const { result, log } = await fakeRun(t, "hang", { timeoutMs: 500, onSpawn: (child) => { pid = child.pid; } });
  assert.equal(result.timedOut, true);
  assert.equal(classifyAgyFailure(result), "timeout");
  assert.deepEqual(log.messages.at(-1), { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "a0123456-789a-4bcd-8ef0-123456789abc" } });
  assert.equal(log.stdinEnded, true);
  assert.throws(() => process.kill(-pid, 0), (error) => error.code === "ESRCH");
});

test("timeout before a session exists sends no cancellation notification", async (t) => {
  const { result, log } = await fakeRun(t, "slow_init", { timeoutMs: 500 });
  assert.equal(classifyAgyFailure(result), "timeout");
  assert.equal(result.sessionId, null);
  assert.deepEqual(log.messages.map((message) => message.method), ["initialize"]);
});

test("abort cancels an active prompt and exposes the spawned child to the owner", async (t) => {
  const root = fixture(t);
  const promptFile = path.join(root, "prompt");
  const controller = new AbortController();
  let child;
  let launches = 0;
  const running = fakeRun(t, "hang", { env: { FAKE_AGY_PROMPT_FILE: promptFile }, signal: controller.signal,
    launchProcess: (launch) => { launches += 1; return launch(); }, onSpawn: (spawned) => { child = spawned; } });
  t.after(() => controller.abort());
  await waitFor(() => fs.existsSync(promptFile));
  controller.abort();
  const { result, log } = await running;
  assert.equal(launches, 1);
  assert.equal(child.spawnargs[1], "acp");
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(classifyAgyFailure(result), "cancelled");
  assert.equal(log.messages.at(-1).method, "session/cancel");
  assert.throws(() => process.kill(-child.pid, 0), (error) => error.code === "ESRCH");
});

test("an already aborted signal settles without starting the protocol", async () => {
  const controller = new AbortController();
  controller.abort();
  let pid;
  const result = await runAgy({ bin, geminiDir: process.cwd(), cwd: process.cwd(), env: process.env, mode: "consult", signal: controller.signal, killGraceMs: 75, onSpawn: (child) => { pid = child.pid; } });
  assert.equal(classifyAgyFailure(result), "cancelled");
  assert.equal(result.sessionId, null);
  assert.throws(() => process.kill(-pid, 0), (error) => error.code === "ESRCH");
});

test("cancellation while resolving selection cannot send a later prompt", async (t) => {
  const controller = new AbortController();
  const { result, log } = await fakeRun(t, "success", { signal: controller.signal, resolveSelection: async () => {
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return [{ configId: "model", value: "gemini-4-neon" }];
  } });
  assert.equal(classifyAgyFailure(result), "cancelled");
  assert.equal(log.messages.at(-1).method, "session/cancel");
  assert.equal(log.messages.some((message) => message.method === "session/prompt"), false);
});

test("late close escalates to SIGKILL while retaining a successful prompt result", async (t) => {
  let pid;
  const { result, log } = await fakeRun(t, "late_close", { onSpawn: (child) => { pid = child.pid; } });
  assert.equal(result.lateClose, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(classifyAgyFailure(result), null);
  assert.equal(log.stdinEnded, true);
  assert.ok(log.signals.includes("SIGTERM"));
  assert.throws(() => process.kill(-pid, 0), (error) => error.code === "ESRCH");
});

test("terminal setup errors receive exit grace and keep their classification", async (t) => {
  const { result, log } = await fakeRun(t, "terminal_late_close", { env: { FAKE_AGY_MISMATCH_CONFIG: "mode" } });
  assert.equal(classifyAgyFailure(result), "setup");
  assert.equal(result.lateClose, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(log.stdinEnded, true);
  assert.equal(log.messages.at(-1).params.configId, "model");
});

test("a prompt result clears the run deadline during exit grace", async (t) => {
  const { result } = await fakeRun(t, "delayed_exit", { timeoutMs: 250, exitGraceMs: 1000 });
  assert.equal(result.timedOut, false);
  assert.equal(result.lateClose, false);
  assert.equal(classifyAgyFailure(result), null);
});

test("stdout and stderr retain multibyte text across chunks", async (t) => {
  const { result } = await fakeRun(t, "split_utf8");
  assert.equal(result.resultText, "é 中文");
  assert.equal(result.stderrTail, "é\n");
  assert.equal(classifyAgyFailure(result), null);
});

test("stderr is a bounded 64 KiB UTF-8 tail", async (t) => {
  const { result } = await fakeRun(t, "stderr_tail");
  assert.ok(Buffer.byteLength(result.stderrTail) <= 64 * 1024);
  assert.ok(Buffer.byteLength(result.stderrTail) >= 64 * 1024 - 3);
  assert.ok(result.stderrTail.endsWith("tail\n"));
  assert.doesNotMatch(result.stderrTail, /�/);
  assert.equal(classifyAgyFailure(result), null);
});

test("the final response is drained without a trailing newline", async (t) => {
  const { result } = await fakeRun(t, "no_final_newline");
  assert.equal(classifyAgyFailure(result), null);
  assert.equal(result.stopReason, "end_turn");
});

test("a detached descendant holding stdout cannot stall completion", async (t) => {
  const root = fixture(t);
  const pidFile = path.join(root, "escaped.pid");
  let pid;
  t.after(() => { if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  const start = Date.now();
  const { result } = await fakeRun(t, "escape_stdio", { env: { FAKE_AGY_HELPER_PID_FILE: pidFile }, timeoutMs: 10000 });
  pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.equal(classifyAgyFailure(result), null);
  assert.equal(result.timedOut, false);
  assert.equal(result.lateClose, false);
  assert.ok(Date.now() - start < 4000);
});

test("leader exit reaps descendants including ones that ignore SIGTERM", async (t) => {
  for (const scenario of ["spawn_helper", "resistant_group"]) {
    const root = fixture(t);
    const pidFile = path.join(root, "helper.pid");
    let pid;
    t.after(() => { if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} } });
    const { result } = await fakeRun(t, scenario, { env: { FAKE_AGY_HELPER_PID_FILE: pidFile } });
    pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.equal(classifyAgyFailure(result), null, scenario);
    await waitFor(() => processGone(pid));
  }
});

test("spawn failures are reported for both asynchronous and synchronous launch errors", async () => {
  const missing = await runAgy({ bin: "/missing/agy", geminiDir: process.cwd(), cwd: process.cwd(), env: process.env, brief: "", timeoutMs: 1000, mode: "consult" });
  assert.equal(classifyAgyFailure(missing), "missing_cli");
  for (const code of ["ENOENT", "EACCES", "ENOEXEC"]) {
    const result = await runAgy({ bin, mode: "consult", launchProcess: () => { throw Object.assign(new Error("Cannot spawn"), { code }); } });
    assert.equal(classifyAgyFailure(result), "missing_cli");
    assert.equal(result.spawnError.code, code);
  }
});

test("failure table uses RPC data, keeps diagnostic stderr separate, and ignores exit status as success evidence", async (t) => {
  for (const [kind, messages] of [
    ["auth", ["Authentication required", "UNAUTHENTICATED", "Please log in", "Please sign in to view available models", "not logged in", "unauthorized", "HTTP 401", "HTTP 403"]],
    ["quota", ["quota", "usage limit", "weekly limit", "credits", "RESOURCE_EXHAUSTED: quota", "HTTP 402"]],
    ["rate_limited", ["rate limit", "too many requests", "HTTP 429", "No capacity available", "UNAVAILABLE", "HTTP 503"]],
    ["network", ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "DNS failure", "fetch failed"]],
    ["setup", ["language server failed to start", "Failed to start language server"]]
  ]) for (const message of messages) {
    assert.equal(classifyAgyFailure({ stderrTail: message, protocolError: "Exit before prompt result" }), kind, message);
    assert.equal(classifyAgyFailure({ rpcError: { code: -32000, message: "Error", data: { detail: message } } }), kind, message);
  }
  assert.equal(classifyAgyFailure({ exitCode: 0 }), "protocol");
  assert.equal(classifyAgyFailure({ exitCode: 7, resultSeen: true, stopReason: "end_turn" }), null);
  assert.equal(classifyAgyFailure((await fakeRun(t, "nonzero_success")).result), null);
  assert.equal(classifyAgyFailure((await fakeRun(t, "network_after_result")).result), null);
});

for (const scenario of ["bypass_update", "bypass_update_no_name"]) {
  test(`${scenario} terminates as policy once a bypassed command completes`, async (t) => {
    const { result } = await fakeRun(t, scenario);
    assert.equal(classifyAgyFailure(result), "policy");
    assert.equal(result.policyViolation.bypassSandbox, true);
  });
}

test("an announced sandbox bypass is refused at permission time without ending the job", async (t) => {
  const announced = await fakeRun(t, "bypass");
  assert.equal(classifyAgyFailure(announced.result), null);
  const requested = await fakeRun(t, "permission_bypass");
  assert.equal(classifyAgyFailure(requested.result), null);
  assert.equal(requested.result.permissionsAllowed, 0);
  assert.equal(requested.result.permissionsRejected, 1);
  const response = requested.log.messages.find((message) => message.id === 0 && message.result);
  assert.equal(response.result.outcome.optionId, "denial");
});
for (const scenario of ["drift_model", "drift_mode"]) {
  test(`${scenario} fails setup before prompting`, async (t) => {
    const { result, log } = await fakeRun(t, scenario);
    assert.equal(classifyAgyFailure(result), "setup");
    assert.equal(log.messages.some((message) => message.method === "session/prompt"), false);
  });
}

test("a launch wrapper that throws after spawning kills the child", async (t) => {
  const root = fixture(t);
  let pid;
  const result = await runAgy({ bin, geminiDir: root, cwd: root, env: { ...process.env, FAKE_AGY_SCENARIO: "hang", FAKE_AGY_LOG: path.join(root, "run.log") }, brief: "brief", timeoutMs: 2000, exitGraceMs: 75, killGraceMs: 75, mode: "consult",
    launchProcess: (launch) => {
      pid = launch().pid;
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    } });
  assert.equal(result.spawnError.code, "ENOSPC");
  await waitFor(() => processGone(pid));
});

for (const name of ["invoke_subagent", "define_subagent", "manage_subagents", "manage_task", "run_workflow", "schedule", "send_message", "swarm", "ask_question", "mcp_list_servers", "mcp_external", "new_tool"]) {
  test(`forbidden tool ${name} fails closed`, async (t) => {
    const { result } = await fakeRun(t, "forbidden_tool", { env: { FAKE_AGY_FORBIDDEN_TOOL: name } });
    assert.equal(classifyAgyFailure(result), "policy");
    assert.equal(result.policyViolation.tool, name);
  });
}

test("an unexpected signal before the prompt result is a process failure", async (t) => {
  const { result } = await fakeRun(t, "early_signal");
  assert.equal(classifyAgyFailure(result), "process");
});

test("permission checks refuse unsafe commands in every mode and allow sandboxed reads", async (t) => {
  for (const mode of ["consult", "review", "write"]) {
    for (const command of ["find . -delete", "git branch --delete", "rg --pre=evil text", "pwd; touch x"]) {
      const { result } = await fakeRun(t, "permission", { mode, env: { FAKE_AGY_COMMAND: command } });
      assert.equal(classifyAgyFailure(result), null);
      assert.equal(result.permissionsRejected, 1);
      assert.equal(result.permissionsAllowed, 0);
    }
    const { result } = await fakeRun(t, "permission", { mode, env: { FAKE_AGY_COMMAND: "find . -type f" } });
    assert.equal(result.permissionsAllowed, 1);
  }
});

test("an in band quota notice as the final line fails as quota", () => {
  const base = { resultSeen: true, sessionReady: true, stopReason: "end_turn", permissionsRejected: 0 };
  assert.equal(classifyAgyFailure({ ...base, resultText: "\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h47m9s.\n" }), "quota");
  assert.equal(classifyAgyFailure({ ...base, resultText: "Partial findings.\n⚠ Individual quota reached. Resets in 1h." }), "quota");
  assert.equal(classifyAgyFailure({ ...base, resultText: "The quota reached its limit in the old code path." }), null);
});
