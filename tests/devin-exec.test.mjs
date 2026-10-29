import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildDevinChildEnv, classifyDevinFailure, compareDevinVersion, probeDevinVersion, resolveDevinBin, runDevin, TESTED_DEVIN_INTERVAL, toolsForMode } from "../plugins/devin/scripts/lib/devin-exec.mjs";

const bin = path.resolve("tests/fake-devin");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devin-exec-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function fakeRun(t, scenario, { env: extraEnv, ...options } = {}) {
  const root = fixture(t);
  const logFile = path.join(root, "run.log");
  const env = { ...process.env, FAKE_DEVIN_SCENARIO: scenario, FAKE_DEVIN_LOG: logFile, ...extraEnv };
  const result = await runDevin({ bin, cwd: root, env, brief: "private brief\n", timeoutMs: 2000, exitGraceMs: 75, killGraceMs: 75, mode: "consult", ...options });
  return { result, log: JSON.parse(fs.readFileSync(logFile, "utf8")), root };
}

function selections({ stage }) {
  return stage === "model" ? [{ configId: "model", value: "swe-2-high" }] : [{ configId: "thought_level", value: "max" }, { configId: "speed", value: "standard" }];
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

test("binary resolution and version preflight use the executable on PATH", (t) => {
  const root = fixture(t);
  fs.symlinkSync(bin, path.join(root, "devin"));
  const env = { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}` };
  assert.equal(resolveDevinBin({}), "devin");
  assert.equal(resolveDevinBin({ DEVIN_BIN: ` ${bin} ` }), bin);
  assert.equal(resolveDevinBin({ DEVIN_BIN: "  " }), "devin");
  assert.deepEqual(probeDevinVersion(resolveDevinBin(env), env), { version: "3000.11.228", buildPath: fs.realpathSync(bin) });
  assert.throws(() => probeDevinVersion("/missing/devin"), (error) => error.failureKind === "missing_cli");
  const denied = path.join(root, "denied");
  fs.writeFileSync(denied, "denied", { mode: 0o600 });
  assert.throws(() => probeDevinVersion(denied), (error) => error.failureKind === "missing_cli");
  for (const version of ["3000.11.228", "devin unknown (abc)", "devin 3000.11.228", "devin 3000.11.228 (abc) extra"]) {
    assert.throws(() => probeDevinVersion(bin, { ...process.env, FAKE_DEVIN_VERSION: version }), (error) => error.failureKind === "setup", version);
  }
});

test("versions compare dotted numeric parts with missing parts treated as zero", () => {
  assert.deepEqual(TESTED_DEVIN_INTERVAL, { floor: "3000.11", ceiling: "3000.12" });
  assert.equal(compareDevinVersion("3000.11.0", TESTED_DEVIN_INTERVAL.floor), 0);
  assert.equal(compareDevinVersion("3000.11.228", TESTED_DEVIN_INTERVAL.floor), 1);
  assert.equal(compareDevinVersion("3000.11.228", TESTED_DEVIN_INTERVAL.ceiling), -1);
  assert.equal(compareDevinVersion("3000.9", "3000.11"), -1);
  assert.equal(compareDevinVersion("3000.11.10", "3000.11.9"), 1);
  assert.equal(compareDevinVersion("3000.12", TESTED_DEVIN_INTERVAL.ceiling), 0);
});

test("tools follow the contract for consult, review, and write", () => {
  const read = ["read", "grep", "glob", "find_file_by_name", "notebook_read", "todo_write"];
  const write = [...read, "edit", "write", "notebook_edit", "exec", "get_output", "kill_shell", "write_to_process"];
  assert.deepEqual(toolsForMode("consult"), read);
  assert.deepEqual(toolsForMode("review"), read);
  assert.deepEqual(toolsForMode("write"), write);
  toolsForMode("consult").push("web_search");
  assert.deepEqual(toolsForMode("consult"), read);
  assert.throws(() => toolsForMode("unknown"), /Invalid Devin mode/);
});

test("child env inherits exactly the contract allowlist and isolates home and configuration", () => {
  const keys = ["PATH", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TMPDIR", "TZ", "USER", "LOGNAME", "SHELL", "LC_ALL", "LC_MESSAGES", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "JAVA_HOME", "GOROOT", "GOPATH", "CARGO_HOME", "RUSTUP_HOME", "PNPM_HOME", "BUN_INSTALL", "VOLTA_HOME", "MISE_DATA_DIR", "MISE_CONFIG_DIR", "MISE_CACHE_DIR", "ANDROID_HOME", "ANDROID_SDK_ROOT", "DEVELOPER_DIR", "SDKROOT"];
  const inherited = Object.fromEntries(keys.map((key) => [key, `/keep/${key}`]));
  const dropped = ["DEVIN_MODEL", "DEVIN_REFUSAL_FALLBACK", "DEVIN_PERMISSION_MODE", "DEVIN_BIN", "DEVIN_OTHER", "DEVIN_SANDBOX", "HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "RUST_LOG", "CURSOR_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "CODEX_HOME", "GROK_HOME", "GH_TOKEN", "DATABASE_URL", "SSH_AUTH_SOCK", "NODE_OPTIONS", "NODE_COMPILE_CACHE", "BASH_ENV", "CLAUDE_PLUGIN_ROOT", "NPM_CONFIG__AUTH"];
  const env = { ...inherited, ...Object.fromEntries(dropped.map((key) => [key, "drop"])) };
  const expected = { ...inherited, HOME: "/tmp/private", XDG_DATA_HOME: "/tmp/private/.local/share", XDG_STATE_HOME: "/tmp/private/.local/state", XDG_CACHE_HOME: "/tmp/private/.cache", XDG_CONFIG_HOME: "/tmp/job/config", RUST_LOG: "error" };
  for (const mode of ["consult", "review", "write"]) {
    assert.deepEqual(buildDevinChildEnv({ env, homeDir: "/tmp/private", configDir: "/tmp/job/config", mode }), { ...expected, ...(mode === "write" ? { DEVIN_SANDBOX: "true" } : {}) }, mode);
  }
  assert.equal(env.DEVIN_SANDBOX, "drop");
});

test("success records text, exact usage, metadata, and the ACP handshake", async (t) => {
  const { result, log, root } = await fakeRun(t, "success");
  assert.equal(classifyDevinFailure(result), null);
  assert.equal(result.exitCode, 0);
  assert.equal(result.resultSeen, true);
  assert.equal(result.sessionId, "artistic-breeze");
  assert.equal(result.requestId, "8f3a-fake-request");
  assert.equal(result.observedModel, "SWE-2 High");
  assert.equal(result.resultText, "fake result");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.stopCause, "complete");
  assert.deepEqual(result.usage, { totalTokens: 11914, inputTokens: 11875, outputTokens: 39, cachedReadTokens: 11552 });
  assert.deepEqual(result.appliedOptions, { mode: "ask" });
  assert.equal(result.toolCalls, 2);
  assert.deepEqual(log.argv, ["acp"]);
  assert.equal(log.cwd, fs.realpathSync(root));
  assert.equal(log.stdinEnded, true);
  assert.deepEqual(log.messages, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } },
    { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: root, mcpServers: [] } },
    { jsonrpc: "2.0", id: 3, method: "session/set_config_option", params: { sessionId: "artistic-breeze", configId: "mode", value: "ask" } },
    { jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: "artistic-breeze", prompt: [{ type: "text", text: "private brief\n" }] } }
  ]);
});

test("usage preserves missing and additional keys", async (t) => {
  const { result } = await fakeRun(t, "no_cache_usage");
  assert.deepEqual(result.usage, { totalTokens: 11914, inputTokens: 11875, outputTokens: 39 });
  const extra = await fakeRun(t, "extra_usage");
  assert.deepEqual(extra.result.usage, { totalTokens: 11914, inputTokens: 11875, outputTokens: 39, cachedReadTokens: 11552, vendorTokens: 7 });
});

test("resume sends session/load and excludes all replayed text before prompting", async (t) => {
  const { result, log, root } = await fakeRun(t, "success", { resumeSessionId: "resumed-breeze" });
  assert.equal(classifyDevinFailure(result), null);
  assert.equal(result.resultText, "fake result");
  assert.equal(result.sessionId, "resumed-breeze");
  assert.deepEqual(log.messages[1], { jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: "resumed-breeze", cwd: root, mcpServers: [] } });
  assert.equal(log.messages.some((message) => message.method === "session/new"), false);
});

test("model and effort selection receive updated options and apply each pair in order", async (t) => {
  const stages = [];
  const { result, log } = await fakeRun(t, "success", { resolveSelection: async ({ stage, configOptions }) => {
    stages.push(stage);
    assert.equal(configOptions.find((option) => option.id === "mode").currentValue, "ask");
    if (stage === "model") assert.equal(configOptions.some((option) => option.id === "thought_level"), false);
    else {
      assert.equal(configOptions.find((option) => option.id === "model").currentValue, "swe-2-high");
      assert.deepEqual(configOptions.find((option) => option.id === "thought_level").options.map((option) => option.value), ["low", "high", "max"]);
      assert.equal(configOptions.find((option) => option.id === "speed").currentValue, "fast");
    }
    return selections({ stage });
  } });
  assert.equal(classifyDevinFailure(result), null);
  assert.deepEqual(stages, ["model", "effort"]);
  assert.deepEqual(result.appliedOptions, { mode: "ask", model: "swe-2-high", thought_level: "max", speed: "standard" });
  assert.deepEqual(log.messages.filter((message) => message.method === "session/set_config_option").map(({ params }) => [params.configId, params.value]), [["mode", "ask"], ["model", "swe-2-high"], ["thought_level", "max"], ["speed", "standard"]]);
  assert.equal(log.messages.at(-1).method, "session/prompt");
});

test("a model change refreshes effort choices and an empty effort selection preserves defaults", async (t) => {
  const { result } = await fakeRun(t, "success", { resolveSelection: ({ stage, configOptions }) => {
    if (stage === "model") return [{ configId: "model", value: "kimi-k3-high" }];
    assert.equal(configOptions.find((option) => option.id === "model").currentValue, "kimi-k3-high");
    assert.equal(configOptions.some((option) => option.id === "speed"), false);
    return [];
  } });
  assert.equal(classifyDevinFailure(result), null);
  assert.deepEqual(result.appliedOptions, { mode: "ask", model: "kimi-k3-high" });
});

test("selection errors preserve input or setup and abort before prompting", async (t) => {
  for (const stage of ["model", "effort"]) {
    for (const failureKind of ["input", "setup"]) {
      const { result, log } = await fakeRun(t, "success", { resolveSelection: (selection) => {
        if (selection.stage !== stage) return selections(selection);
        throw Object.assign(new Error("Selection unavailable"), { failureKind });
      } });
      assert.deepEqual(result.selectionError, { failureKind, message: "Selection unavailable" });
      assert.equal(classifyDevinFailure(result), failureKind);
      assert.equal(log.messages.some((message) => message.method === "session/prompt"), false);
      assert.equal(log.stdinEnded, true);
      assert.equal(result.timedOut, false);
    }
  }
});

test("each configured value must be acknowledged before proceeding", async (t) => {
  for (const configId of ["mode", "model", "thought_level", "speed"]) {
    const { result, log } = await fakeRun(t, "success", { env: { FAKE_DEVIN_MISMATCH_CONFIG: configId }, resolveSelection: ({ stage }) => {
      if (stage === "model" && configId === "model") return [{ configId: "model", value: "kimi-k3-high" }];
      return selections({ stage });
    } });
    assert.equal(classifyDevinFailure(result), "setup", configId);
    assert.match(result.setupError, new RegExp(configId));
    assert.equal(Object.hasOwn(result.appliedOptions, configId), false);
    assert.equal(log.messages.at(-1).params.configId, configId);
    assert.equal(log.stdinEnded, true);
  }
});

test("invalid set values retain the RPC error and fail setup without prompting", async (t) => {
  const { result, log } = await fakeRun(t, "success", { resolveSelection: () => [{ configId: "model", value: "x" }] });
  assert.equal(classifyDevinFailure(result), "setup");
  assert.deepEqual(result.rpcError, { method: "session/set_config_option", code: -32602, message: "Invalid params", data: "Invalid value 'x' for config option 'model'" });
  assert.equal(result.setupError, "Invalid value 'x' for config option 'model'");
  assert.deepEqual(result.appliedOptions, { mode: "ask" });
  assert.equal(log.messages.at(-1).params.configId, "model");
  const mode = await fakeRun(t, "success", { mode: "write", env: { FAKE_DEVIN_REJECT_CONFIG: "mode" } });
  assert.equal(classifyDevinFailure(mode.result), "setup");
  assert.equal(mode.log.messages.some((message) => message.method === "session/prompt"), false);
});

test("permission requests with id zero receive a cancelled outcome", async (t) => {
  const { result, log } = await fakeRun(t, "permission");
  assert.equal(classifyDevinFailure(result), null);
  assert.deepEqual(log.messages.at(-1), { jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "cancelled" } } });
  assert.equal(result.cancelled, false);
});

test("other agent requests receive method-not-found errors", async (t) => {
  const { result, log } = await fakeRun(t, "unknown_request");
  assert.equal(classifyDevinFailure(result), null);
  assert.deepEqual(log.messages.at(-1), { jsonrpc: "2.0", id: "client-request", error: { code: -32601, message: "Method not found" } });
});

test("forbidden tools terminate before initialization, during updates, and after the result", async (t) => {
  for (const scenario of ["forbidden_before_init", "forbidden_tool", "forbidden_update", "forbidden_after_result"]) {
    let pid;
    const { result } = await fakeRun(t, scenario, { onSpawn: (child) => { pid = child.pid; } });
    assert.deepEqual(result.policyViolation, { tool: "web_search" }, scenario);
    assert.equal(classifyDevinFailure(result), "policy", scenario);
    assert.equal(result.timedOut, false, scenario);
    assert.throws(() => process.kill(-pid, 0), (error) => error.code === "ESRCH");
  }
});

test("exec is refused in consult and review but accepted with autonomous write mode", async (t) => {
  for (const mode of ["consult", "review", "write"]) {
    const { result, log } = await fakeRun(t, "write_tool", { mode });
    assert.equal(classifyDevinFailure(result), mode === "write" ? null : "policy", mode);
    assert.equal(log.messages[2].params.value, mode === "write" ? "autonomous" : "ask");
  }
});

for (const [scenario, kind] of [
  ["tool_rejected", "permission"], ["auth_required", "auth"], ["quota", "quota"], ["allowance", "quota"],
  ["rate_limit", "rate_limited"], ["network", "network"], ["sandbox_unavailable", "setup"], ["refusal", "refused"],
  ["rpc_error", "error"], ["initialize_error", "error"], ["bad_protocol_version", "setup"],
  ["garbage", "protocol"], ["non_object", "protocol"], ["unknown_id", "protocol"], ["missing_session", "protocol"],
  ["no_result", "protocol"], ["no_result_nonzero", "protocol"], ["malformed_response", "protocol"],
  ["malformed_error", "protocol"], ["missing_stop_reason", "protocol"], ["missing_tool", "protocol"], ["oversized_line", "protocol"],
  ["unexpected_signal", "process"]
]) {
  test(`${scenario} classifies as ${kind}`, async (t) => {
    const { result, log } = await fakeRun(t, scenario);
    assert.equal(classifyDevinFailure(result), kind);
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

test("session/load keeps the requested session id because its result carries none", async (t) => {
  const { result } = await fakeRun(t, "success", { resumeSessionId: "existing-session" });
  assert.equal(classifyDevinFailure(result), null);
  assert.equal(result.sessionId, "existing-session");
});

test("timeout sends session/cancel before closing stdin and reaps the group", async (t) => {
  let pid;
  const { result, log } = await fakeRun(t, "hang", { timeoutMs: 500, onSpawn: (child) => { pid = child.pid; } });
  assert.equal(result.timedOut, true);
  assert.equal(classifyDevinFailure(result), "timeout");
  assert.deepEqual(log.messages.at(-1), { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "artistic-breeze" } });
  assert.equal(log.stdinEnded, true);
  assert.throws(() => process.kill(-pid, 0), (error) => error.code === "ESRCH");
});

test("timeout before a session exists sends no cancellation notification", async (t) => {
  const { result, log } = await fakeRun(t, "slow_init", { timeoutMs: 500 });
  assert.equal(classifyDevinFailure(result), "timeout");
  assert.equal(result.sessionId, null);
  assert.deepEqual(log.messages.map((message) => message.method), ["initialize"]);
});

test("abort cancels an active prompt and exposes the spawned child to the owner", async (t) => {
  const root = fixture(t);
  const promptFile = path.join(root, "prompt");
  const controller = new AbortController();
  let child;
  let launches = 0;
  const running = fakeRun(t, "hang", { env: { FAKE_DEVIN_PROMPT_FILE: promptFile }, signal: controller.signal,
    launchProcess: (launch) => { launches += 1; return launch(); }, onSpawn: (spawned) => { child = spawned; } });
  t.after(() => controller.abort());
  await waitFor(() => fs.existsSync(promptFile));
  controller.abort();
  const { result, log } = await running;
  assert.equal(launches, 1);
  assert.deepEqual(child.spawnargs, [bin, "acp"]);
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(classifyDevinFailure(result), "cancelled");
  assert.equal(log.messages.at(-1).method, "session/cancel");
  assert.throws(() => process.kill(-child.pid, 0), (error) => error.code === "ESRCH");
});

test("an already aborted signal settles without starting the protocol", async () => {
  const controller = new AbortController();
  controller.abort();
  let pid;
  const result = await runDevin({ bin, cwd: process.cwd(), env: process.env, mode: "consult", signal: controller.signal, killGraceMs: 75, onSpawn: (child) => { pid = child.pid; } });
  assert.equal(classifyDevinFailure(result), "cancelled");
  assert.equal(result.sessionId, null);
  assert.throws(() => process.kill(-pid, 0), (error) => error.code === "ESRCH");
});

test("cancellation while resolving selection cannot send a later prompt", async (t) => {
  const controller = new AbortController();
  const { result, log } = await fakeRun(t, "success", { signal: controller.signal, resolveSelection: async () => {
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return [{ configId: "model", value: "swe-2-high" }];
  } });
  assert.equal(classifyDevinFailure(result), "cancelled");
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
  assert.equal(classifyDevinFailure(result), null);
  assert.equal(log.stdinEnded, true);
  assert.ok(log.signals.includes("SIGTERM"));
  assert.throws(() => process.kill(-pid, 0), (error) => error.code === "ESRCH");
});

test("terminal setup errors receive exit grace and keep their classification", async (t) => {
  const { result, log } = await fakeRun(t, "terminal_late_close", { env: { FAKE_DEVIN_MISMATCH_CONFIG: "mode" } });
  assert.equal(classifyDevinFailure(result), "setup");
  assert.equal(result.lateClose, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(log.stdinEnded, true);
  assert.equal(log.messages.at(-1).params.configId, "mode");
});

test("a prompt result clears the run deadline during exit grace", async (t) => {
  const { result } = await fakeRun(t, "delayed_exit", { timeoutMs: 250, exitGraceMs: 1000 });
  assert.equal(result.timedOut, false);
  assert.equal(result.lateClose, false);
  assert.equal(classifyDevinFailure(result), null);
});

test("stdout and stderr retain multibyte text across chunks", async (t) => {
  const { result } = await fakeRun(t, "split_utf8");
  assert.equal(result.resultText, "é 中文");
  assert.equal(result.stderrTail, "é\n");
  assert.equal(classifyDevinFailure(result), null);
});

test("stderr is a bounded 64 KiB UTF-8 tail", async (t) => {
  const { result } = await fakeRun(t, "stderr_tail");
  assert.ok(Buffer.byteLength(result.stderrTail) <= 64 * 1024);
  assert.ok(Buffer.byteLength(result.stderrTail) >= 64 * 1024 - 3);
  assert.ok(result.stderrTail.endsWith("tail\n"));
  assert.doesNotMatch(result.stderrTail, /�/);
  assert.equal(classifyDevinFailure(result), null);
});

test("the final response is drained without a trailing newline", async (t) => {
  const { result } = await fakeRun(t, "no_final_newline");
  assert.equal(classifyDevinFailure(result), null);
  assert.equal(result.stopReason, "end_turn");
});

test("a detached descendant holding stdout cannot stall completion", async (t) => {
  const root = fixture(t);
  const pidFile = path.join(root, "escaped.pid");
  let pid;
  t.after(() => { if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  const start = Date.now();
  const { result } = await fakeRun(t, "escape_stdio", { env: { FAKE_DEVIN_HELPER_PID_FILE: pidFile }, timeoutMs: 10000 });
  pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.equal(classifyDevinFailure(result), null);
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
    const { result } = await fakeRun(t, scenario, { env: { FAKE_DEVIN_HELPER_PID_FILE: pidFile } });
    pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.equal(classifyDevinFailure(result), null, scenario);
    await waitFor(() => processGone(pid));
  }
});

test("spawn failures are reported for both asynchronous and synchronous launch errors", async () => {
  const missing = await runDevin({ bin: "/missing/devin", cwd: process.cwd(), env: process.env, brief: "", timeoutMs: 1000, mode: "consult" });
  assert.equal(classifyDevinFailure(missing), "missing_cli");
  for (const code of ["ENOENT", "EACCES", "ENOEXEC"]) {
    const result = await runDevin({ bin, mode: "consult", launchProcess: () => { throw Object.assign(new Error("Cannot spawn"), { code }); } });
    assert.equal(classifyDevinFailure(result), "missing_cli");
    assert.equal(result.spawnError.code, code);
  }
});

test("failure classification respects precedence and ignores network logs after a result", async (t) => {
  const cases = [
    [{ cancelled: true, spawnError: { code: "ENOENT" } }, "cancelled"],
    [{ spawnError: { code: "ENOENT" }, selectionError: { failureKind: "input" } }, "missing_cli"],
    [{ selectionError: { failureKind: "input" }, policyViolation: { tool: "exec" } }, "input"],
    [{ policyViolation: { tool: "exec" }, timedOut: true }, "policy"],
    [{ timedOut: true, setupError: "Bad configuration" }, "timeout"],
    [{ setupError: "Bad configuration", stopCause: "auth_required" }, "setup"],
    [{ stopCause: "auth_required", stderrTail: "quota" }, "auth"],
    [{ stderrTail: "quota and rate limit" }, "quota"],
    [{ stderrTail: "rate limit ECONNRESET" }, "rate_limited"],
    [{ stderrTail: "ECONNRESET", stopCause: "tool_rejected" }, "network"],
    [{ stopCause: "tool_rejected", stopReason: "refusal" }, "permission"],
    [{ stopReason: "refusal", protocolError: "Malformed stream" }, "refused"],
    [{ protocolError: "Missing result", signal: "SIGTERM" }, "protocol"],
    [{ signal: "SIGINT" }, "process"],
    [{ exitCode: 1, stderrTail: "ENOENT opening a workspace file" }, "error"],
    [{ exitCode: 0, stopReason: "cancelled", resultSeen: true }, "error"],
    [{ exitCode: 1, stopReason: "end_turn", resultSeen: true }, "error"],
    [{ exitCode: 0, stopReason: "end_turn", stopCause: "complete", resultSeen: true, stderrTail: "HTTP 429 too many requests, retrying" }, null],
    [{ exitCode: 0, stopReason: "end_turn", stopCause: "tool_rejected", resultSeen: true }, "permission"]
  ];
  for (const [outcome, kind] of cases) assert.equal(classifyDevinFailure(outcome), kind, JSON.stringify(outcome));
  for (const [kind, messages] of [
    ["auth", ["Please log in", "not logged in", "unauthorized", "HTTP 401", "HTTP 403"]],
    ["quota", ["usage limit", "quota", "allowance", "spend limit", "insufficient credit", "HTTP 402"]],
    ["rate_limited", ["rate limit", "too many requests", "HTTP 429"]],
    ["network", ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "DNS failure", "fetch failed"]],
    ["setup", ["Sandbox unavailable", "Could not start sandbox", "Failed to start Seatbelt", "bubblewrap failed"]]
  ]) {
    for (const message of messages) {
      assert.equal(classifyDevinFailure({ stderrTail: message, protocolError: "Exit before prompt result" }), kind, message);
      assert.equal(classifyDevinFailure({ rpcError: { method: "session/prompt", code: -32000, message: "Error", data: { detail: message } } }), kind, message);
    }
  }
  const { result } = await fakeRun(t, "network_after_result");
  assert.equal(classifyDevinFailure(result), null);
});

test("a launch wrapper that throws after spawning kills the child", async (t) => {
  const root = fixture(t);
  let pid;
  const result = await runDevin({ bin, cwd: root, env: { ...process.env, FAKE_DEVIN_SCENARIO: "hang", FAKE_DEVIN_LOG: path.join(root, "run.log") }, brief: "brief", timeoutMs: 2000, exitGraceMs: 75, killGraceMs: 75, mode: "consult",
    launchProcess: (launch) => {
      pid = launch().pid;
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    } });
  assert.equal(result.spawnError.code, "ENOSPC");
  await waitFor(() => processGone(pid));
});
