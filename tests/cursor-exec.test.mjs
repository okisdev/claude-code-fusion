import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { allowedToolsForMode, buildCursorArgs, buildCursorChildEnv, classifyCursorFailure, compareCursorVersion, probeCursorVersion, resolveCursorBin, runCursor, TESTED_CURSOR_INTERVAL } from "../plugins/cursor/scripts/lib/cursor-exec.mjs";

const bin = path.resolve("tests/fake-cursor");
const launcher = path.resolve("tests/fake-cursor-launcher");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-exec-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("binary resolution and build date preflight", () => {
  assert.equal(resolveCursorBin({}), "cursor-agent");
  assert.equal(resolveCursorBin({ CURSOR_AGENT_BIN: bin }), bin);
  assert.deepEqual(probeCursorVersion(bin), { version: "2026.10.01-e373342", buildPath: fs.realpathSync(bin) });
  assert.equal(compareCursorVersion("2026.10.01-ffff", "2026.10.01-0000"), 0);
  assert.ok(compareCursorVersion("2026.09.30-a", TESTED_CURSOR_INTERVAL.floor) < 0);
  assert.ok(compareCursorVersion("2026.11.01-a", TESTED_CURSOR_INTERVAL.ceiling) === 0);
  assert.throws(() => probeCursorVersion("/missing/cursor-agent"), (error) => error.failureKind === "missing_cli");
});

test("argv uses only contract flags and mode allowlists", () => {
  const cwd = "/tmp/workspace";
  const read = ["read_tool_call", "grep_tool_call", "glob_tool_call", "ls_tool_call"];
  const write = [...read, "edit_tool_call", "delete_tool_call", "shell_tool_call", "update_todos_tool_call", "read_todos_tool_call"];
  assert.deepEqual(allowedToolsForMode("review"), read);
  assert.deepEqual(allowedToolsForMode("write"), write);
  const prefix = ["-p", "--output-format", "stream-json", "--model", "composer-2.5", "--workspace", cwd, "--trust", "--sandbox", "enabled", "--disable-project-configs", "--disable-auto-update", "--single-turn"];
  assert.deepEqual(buildCursorArgs({ mode: "consult", variant: "composer-2.5", cwd }), [...prefix, "--allowed-tools", read.join(","), "--mode", "ask"]);
  assert.deepEqual(buildCursorArgs({ mode: "write", variant: "composer-2.5", cwd, resumeSessionId: "abc" }), [...prefix, "--allowed-tools", write.join(","), "--resume", "abc"]);
  for (const mode of ["consult", "write"]) {
    const args = buildCursorArgs({ mode, variant: "composer-2.5", cwd });
    assert.doesNotMatch(args[args.indexOf("--allowed-tools") + 1], /read_lints_tool_call/);
  }
});

test("child env keeps only terminal, locale, API key, and toolchain roots", () => {
  const env = buildCursorChildEnv({ homeDir: "/tmp/private", dataDir: "/tmp/data", env: {
    PATH: "/bin", LANG: "en_US.UTF-8", LANGUAGE: "en", TERM: "xterm", COLORTERM: "truecolor", TMPDIR: "/tmp", TZ: "UTC", USER: "u", LOGNAME: "u", SHELL: "/bin/sh", LC_ALL: "C", CURSOR_API_KEY: "keep", JAVA_HOME: "/jdk", GOROOT: "/go", GOPATH: "/gopath", CARGO_HOME: "/cargo", RUSTUP_HOME: "/rustup", PNPM_HOME: "/pnpm", BUN_INSTALL: "/bun", VOLTA_HOME: "/volta", MISE_DATA_DIR: "/mise", MISE_CONFIG_DIR: "/mise-config", MISE_CACHE_DIR: "/mise-cache", ANDROID_HOME: "/android", ANDROID_SDK_ROOT: "/sdk", DEVELOPER_DIR: "/xcode", SDKROOT: "/sysroot", CURSOR_CONFIG_DIR: "drop", CURSOR_DATA_DIR: "drop",
    CLAUDE_SESSION: "drop", FUSION_JOB: "drop", GROK_HOME: "drop", CODEX_HOME: "drop",
    OPENAI_API_KEY: "drop", ANTHROPIC_API_KEY: "drop", XAI_API_KEY: "drop",
    SERVICE_TOKEN: "drop", DB_PASSWORD: "drop", APP_SECRET: "drop", CUSTOM_API_KEY: "drop", DATABASE_URL: "drop", NPM_CONFIG__AUTH: "drop", SSH_AUTH_SOCK: "drop", NODE_OPTIONS: "drop", BASH_ENV: "drop", GH_TOKEN: "drop", CLAUDE_PLUGIN_ROOT: "drop"
  } });
  for (const key of ["DATABASE_URL", "NPM_CONFIG__AUTH", "SSH_AUTH_SOCK", "NODE_OPTIONS", "BASH_ENV", "GH_TOKEN", "CLAUDE_PLUGIN_ROOT", "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR"]) assert.equal(Object.hasOwn(env, key), false, key);
  for (const key of ["PATH", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TMPDIR", "TZ", "USER", "LOGNAME", "SHELL", "LC_ALL", "CURSOR_API_KEY", "JAVA_HOME", "GOROOT", "GOPATH", "CARGO_HOME", "RUSTUP_HOME", "PNPM_HOME", "BUN_INSTALL", "VOLTA_HOME", "MISE_DATA_DIR", "MISE_CONFIG_DIR", "MISE_CACHE_DIR", "ANDROID_HOME", "ANDROID_SDK_ROOT", "DEVELOPER_DIR", "SDKROOT"]) assert.ok(Object.hasOwn(env, key), key);
  assert.equal(env.HOME, "/tmp/private");
  assert.equal(env.NODE_COMPILE_CACHE, "/tmp/data/compile-cache");
  assert.equal(Object.keys(env).length, 29);
});

async function fakeRun(t, scenario, overrides = {}) {
  const root = fixture(t);
  const log = path.join(root, "run.log");
  const env = { ...process.env, FAKE_CURSOR_SCENARIO: scenario, FAKE_CURSOR_LOG: log, ...overrides };
  const args = buildCursorArgs({ mode: "consult", variant: "composer-2.5", cwd: root });
  const result = await runCursor({ bin, args, cwd: root, env, brief: "private brief\n", timeoutMs: 1000, exitGraceMs: 100, killGraceMs: 100, mode: "consult" });
  return { result, log: JSON.parse(fs.readFileSync(log, "utf8")) };
}

test("invalid stream session ids fail protocol validation", async (t) => {
  for (const scenario of ["invalid_init_session", "invalid_result_session"]) {
    const { result } = await fakeRun(t, scenario);
    assert.equal(classifyCursorFailure(result), "protocol", scenario);
    assert.notEqual(result.sessionId, "../..");
    assert.notEqual(result.sessionId, "a/../../b");
  }
});

test("forbidden tools before init and after result terminate immediately", async (t) => {
  for (const scenario of ["forbidden_before_init", "forbidden_after_result"]) {
    const { result } = await fakeRun(t, scenario);
    assert.equal(result.policyViolation, "task_tool_call", scenario);
    assert.equal(result.timedOut, false, scenario);
    assert.equal(classifyCursorFailure(result), "policy", scenario);
  }
});

test("a result near the run deadline gets only exit grace", async (t) => {
  const root = fixture(t);
  const result = await runCursor({ bin, args: buildCursorArgs({ mode: "consult", variant: "composer-2.5", cwd: root }), cwd: root, env: { ...process.env, FAKE_CURSOR_SCENARIO: "near_deadline" }, brief: "inspect", timeoutMs: 1000, exitGraceMs: 500, killGraceMs: 100, mode: "consult" });
  assert.equal(result.resultSeen, true);
  assert.equal(result.timedOut, false);
  assert.equal(classifyCursorFailure(result), null);
  const late = await runCursor({ bin, args: buildCursorArgs({ mode: "consult", variant: "composer-2.5", cwd: root }), cwd: root, env: { ...process.env, FAKE_CURSOR_SCENARIO: "near_deadline_late_close" }, brief: "inspect", timeoutMs: 1000, exitGraceMs: 100, killGraceMs: 100, mode: "consult" });
  assert.equal(late.resultSeen, true);
  assert.equal(late.lateClose, true);
  assert.equal(late.timedOut, false);
  assert.equal(classifyCursorFailure(late), null);
});

test("exit resolves when a detached descendant holds stdout open", async (t) => {
  const root = fixture(t);
  const pidFile = path.join(root, "escaped.pid");
  t.after(() => { try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {} });
  const start = Date.now();
  const result = await runCursor({ bin, args: buildCursorArgs({ mode: "consult", variant: "composer-2.5", cwd: root }), cwd: root, env: { ...process.env, FAKE_CURSOR_SCENARIO: "escape_stdio", FAKE_CURSOR_HELPER_PID_FILE: pidFile }, brief: "inspect", timeoutMs: 1000, exitGraceMs: 100, killGraceMs: 100, mode: "consult" });
  assert.equal(result.resultSeen, true);
  assert.equal(result.timedOut, false);
  assert.equal(classifyCursorFailure(result), null);
  assert.ok(Date.now() - start < 1000);
});

test("stdout and stderr retain multibyte text across chunks", async (t) => {
  const { result } = await fakeRun(t, "split_utf8");
  assert.equal(result.resultText, "é 中文");
  assert.equal(result.stderrTail, "é\n");
  assert.equal(classifyCursorFailure(result), null);
});

test("success stream records metadata, usage, and stdin transport", async (t) => {
  const { result, log } = await fakeRun(t, "success");
  assert.equal(classifyCursorFailure(result), null);
  assert.equal(result.initSeen, true);
  assert.equal(result.resultSeen, true);
  assert.equal(result.sessionId, "11111111-2222-4333-8444-555555555555");
  assert.equal(result.requestId, "fake-request-1");
  assert.equal(result.observedModel, "Composer 2.5");
  assert.equal(result.resultText, "fake result");
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 });
  assert.equal(result.eventCount, 7);
  assert.equal(log.stdin, "private brief\n");
  assert.equal(log.argv.includes("private brief"), false);
});

test("fake failure scenarios classify from stderr and protocol evidence", async (t) => {
  for (const [scenario, kind] of [
    ["auth", "auth"], ["quota", "quota"], ["rate_limit", "rate_limited"],
    ["network", "network"], ["sandbox_unavailable", "sandbox"],
    ["bad_model", "setup"], ["bad_tools", "setup"],
    ["garbage", "protocol"], ["no_result", "protocol"]
  ]) {
    const { result } = await fakeRun(t, scenario);
    assert.equal(classifyCursorFailure(result), kind, scenario);
  }
  const missing = await runCursor({ bin: "/missing/cursor-agent", args: [], cwd: process.cwd(), env: process.env, brief: "", timeoutMs: 1000, mode: "consult" });
  assert.equal(classifyCursorFailure(missing), "missing_cli");
});

test("forbidden tool terminates the process group", async (t) => {
  const { result } = await fakeRun(t, "forbidden_tool");
  assert.equal(result.policyViolation, "task_tool_call");
  assert.equal(classifyCursorFailure(result), "policy");
  assert.equal(result.timedOut, false);
});

test("read lints events fail local policy enforcement", async (t) => {
  const { result } = await fakeRun(t, "forbidden_lints");
  assert.equal(result.policyViolation, "read_lints_tool_call");
  assert.equal(classifyCursorFailure(result), "policy");
});

test("run timeout and post result grace terminate the group", async (t) => {
  const hang = await fakeRun(t, "hang");
  assert.equal(hang.result.timedOut, true);
  assert.equal(classifyCursorFailure(hang.result), "timeout");
  const late = await fakeRun(t, "late_close");
  assert.equal(late.result.lateClose, true);
  assert.equal(late.result.resultSeen, true);
  assert.equal(classifyCursorFailure(late.result), null);
});

test("abort cancels the live exec launcher and reaps its group", async (t) => {
  const root = fixture(t);
  const controller = new AbortController();
  let pid;
  const result = await runCursor({ bin: launcher, args: buildCursorArgs({ mode: "consult", variant: "composer-2.5", cwd: root }), cwd: root,
    env: { ...process.env, FAKE_CURSOR_SCENARIO: "hang" }, brief: "inspect", timeoutMs: 10000, killGraceMs: 100, mode: "consult",
    signal: controller.signal, onInit: (cursorPid) => { pid = cursorPid; controller.abort(); } });
  assert.ok(pid);
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(classifyCursorFailure(result), "cancelled");
  assert.throws(() => process.kill(-pid, 0), (error) => error.code === "ESRCH");
});

test("leader exit reaps a helper that inherited its process group", async (t) => {
  const root = fixture(t);
  const pidFile = path.join(root, "helper.pid");
  const { result } = await fakeRun(t, "spawn_helper", { FAKE_CURSOR_HELPER_PID_FILE: pidFile });
  assert.equal(classifyCursorFailure(result), null);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  let state = "running";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0);
      if (process.platform === "linux") {
        state = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2];
      }
    } catch (error) {
      if (error.code === "ESRCH" || error.code === "ENOENT") {
        state = "gone";
        break;
      }
      throw error;
    }
    if (state === "Z") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(state === "gone" || state === "Z", `helper still running: ${state}`);
});
