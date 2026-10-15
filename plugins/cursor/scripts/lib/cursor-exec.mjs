import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CURSOR_SESSION_ID_PATTERN } from "./cursor-home.mjs";

export const TESTED_CURSOR_INTERVAL = { floor: "2026.10.01", ceiling: "2026.11.01" };

const READ_TOOLS = ["read_tool_call", "grep_tool_call", "glob_tool_call", "ls_tool_call"];
const WRITE_TOOLS = [...READ_TOOLS, "edit_tool_call", "delete_tool_call", "shell_tool_call", "update_todos_tool_call", "read_todos_tool_call"];
const STDERR_MAX_BYTES = 64 * 1024;

function cursorBuildDate(value) {
  return String(value).slice(0, 10);
}

function processSignalable(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function cursorGroupSignalable(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function launchCursorProcess(bin, args, cwd, env) {
  return spawn(bin, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
}

export function resolveCursorBin(env = process.env) {
  return env.CURSOR_AGENT_BIN?.trim() || "cursor-agent";
}

function joinCursorBinCandidate(directory, bin) {
  return path.join(directory || ".", bin);
}

function executablePath(bin, env) {
  const candidates = bin.includes(path.sep) ? [path.resolve(bin)] : String(env.PATH || "").split(path.delimiter).map((directory) => joinCursorBinCandidate(directory, bin));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {}
  }
  const error = new Error(`Cursor CLI executable not found: ${bin}`);
  error.failureKind = "missing_cli";
  throw error;
}

export function probeCursorVersion(bin, env = process.env) {
  const buildPath = executablePath(bin, env);
  const result = spawnSync(buildPath, ["--version"], { env, encoding: "utf8", timeout: 60000 });
  const version = String(result.stdout || "").trim();
  if (result.error || result.status !== 0 || !/^\d{4}\.\d{2}\.\d{2}-[0-9a-f]+$/.test(version)) {
    const error = new Error(`Cursor CLI version probe failed: ${result.error?.message || result.stderr?.trim() || version}`);
    error.failureKind = "setup";
    throw error;
  }
  return { version, buildPath };
}

export function compareCursorVersion(left, right) {
  return cursorBuildDate(left).localeCompare(cursorBuildDate(right));
}

export function allowedToolsForMode(mode) {
  if (mode === "consult" || mode === "review") {
    return [...READ_TOOLS];
  }
  if (mode === "write") {
    return [...WRITE_TOOLS];
  }
  throw new Error(`Invalid Cursor mode: ${mode}`);
}

export function buildCursorArgs({ mode, variant, cwd, resumeSessionId }) {
  const args = [
    "-p", "--output-format", "stream-json", "--model", variant, "--workspace", cwd,
    "--trust", "--sandbox", "enabled", "--disable-project-configs", "--disable-auto-update",
    "--single-turn", "--allowed-tools", allowedToolsForMode(mode).join(",")
  ];
  if (mode !== "write") {
    args.push("--mode", "ask");
  }
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }
  return args;
}

function isAllowedChildEnvEntry(entry, allowed) {
  return allowed.has(entry[0]) || entry[0].startsWith("LC_");
}

export function buildCursorChildEnv({ env = process.env, homeDir, dataDir }) {
  const allowed = new Set(["PATH", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TMPDIR", "TZ", "USER", "LOGNAME", "SHELL", "CURSOR_API_KEY", "JAVA_HOME", "GOROOT", "GOPATH", "CARGO_HOME", "RUSTUP_HOME", "PNPM_HOME", "BUN_INSTALL", "VOLTA_HOME", "MISE_DATA_DIR", "MISE_CONFIG_DIR", "MISE_CACHE_DIR", "ANDROID_HOME", "ANDROID_SDK_ROOT", "DEVELOPER_DIR", "SDKROOT"]);
  const childEnv = Object.fromEntries(Object.entries(env).filter((entry) => isAllowedChildEnvEntry(entry, allowed)));
  childEnv.HOME = homeDir;
  childEnv.NODE_COMPILE_CACHE = path.join(dataDir, "compile-cache");
  return childEnv;
}

function underscoreLowercase(letter) {
  return `_${letter.toLowerCase()}`;
}

function toolName(key) {
  return key.replace(/[A-Z]/g, underscoreLowercase);
}

function appendTail(previous, chunk) {
  const combined = Buffer.from(previous + chunk, "utf8");
  return combined.subarray(Math.max(0, combined.length - STDERR_MAX_BYTES)).toString("utf8");
}

function isHomeEnvironmentEntry(value) {
  return value.startsWith("HOME=");
}

function helperHome(pid, platform) {
  if (platform === "linux") {
    try {
      const entry = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find(isHomeEnvironmentEntry);
      return entry ? entry.slice(5) : null;
    } catch {
      return null;
    }
  }
  const result = spawnSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.match(/(?:^|\s)HOME=(\S+)/)?.[1] ?? null : null;
}

function parseProcessLine(line) {
  return line.trim().match(/^(\d+)\s+(.*)$/);
}

function isWorkerServerMatch(match) {
  return match && /\bworker-server\b/.test(match[2]);
}

function pidFromProcessMatch(match) {
  return Number(match[1]);
}

function isPrivateHomeHelper(pid, homeDir, platform) {
  return pid > 1 && pid !== process.pid && helperHome(pid, platform) === homeDir;
}

export async function reapPrivateHomeHelpers(homeDir, { platform = process.platform, graceMs = 2000 } = {}) {
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) {
    return [];
  }
  const listing = spawnSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
  if (listing.status !== 0) {
    return [];
  }
  const helpers = listing.stdout.split("\n").map(parseProcessLine).filter(isWorkerServerMatch).map(pidFromProcessMatch).filter((pid) => isPrivateHomeHelper(pid, homeDir, platform));
  for (const pid of helpers) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      void 0;
    }
  }
  const deadline = Date.now() + graceMs;
  while (helpers.some(processSignalable) && Date.now() < deadline) {
    await new Promise((done) => scheduleDelay(done, 50));
  }
  for (const pid of helpers.filter(processSignalable)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      void 0;
    }
  }
  return helpers;
}

function settleRun(run) {
  if (run.settled) return;
  run.settled = true;
  clearTimeout(run.runTimer);
  clearTimeout(run.exitTimer);
  clearTimeout(run.killTimer);
  clearTimeout(run.drainTimer);
  clearTimeout(run.deadlineTimer);
  run.options.signal?.removeEventListener("abort", run.abort);
  run.resolve(run.outcome);
}

function signalRunGroup(run, signal) {
  if (!Number.isInteger(run.pid) || run.pid <= 1) {
    return;
  }
  try {
    process.kill(-run.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      run.outcome.stderrTail = appendTail(run.outcome.stderrTail, Buffer.from(`\n${error.message}`));
    }
  }
}

function terminateRun(run) {
  signalRunGroup(run, "SIGTERM");
  run.killTimer ??= setTimeout(() => signalRunGroup(run, "SIGKILL"), run.options.killGraceMs);
}

function abortRun(run) {
  if (run.settled) return;
  run.outcome.cancelled = true;
  terminateRun(run);
}

async function drainRun(run) {
  if (run.settled || run.draining) return;
  run.draining = true;
  run.child.stdout.destroy();
  run.child.stderr.destroy();
  run.child.stdin.destroy();
  signalRunGroup(run, "SIGKILL");
  await reapPrivateHomeHelpers(run.options.env?.HOME);
  settleRun(run);
}

function handleExitGrace(run) {
  if (!run.closed) {
    run.outcome.lateClose = true;
    terminateRun(run);
  }
}

function isToolCallKey(key) {
  return key.endsWith("ToolCall");
}

function isNonStringEventField(event, field) {
  return typeof event[field] !== "string";
}

function processCursorLine(run, line) {
  const { outcome } = run;
  if (!line.trim()) {
    return;
  }
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    outcome.protocolError ??= "Malformed stream line";
    return;
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    outcome.protocolError ??= "Malformed stream event";
    return;
  }
  outcome.eventCount += 1;
  if (!["system", "user", "thinking", "assistant", "tool_call", "result"].includes(event.type)) {
    return;
  }
  let toolKeys = [];
  if (event.type === "tool_call") {
    const calls = event.tool_call;
    toolKeys = calls && typeof calls === "object" && !Array.isArray(calls) ? Object.keys(calls).filter(isToolCallKey) : [];
    for (const key of toolKeys) {
      const name = toolName(key);
      if (!allowedToolsForMode(run.options.mode).includes(name)) {
        outcome.policyViolation ??= name;
        terminateRun(run);
      }
    }
    if (outcome.policyViolation) return;
  }
  if (!outcome.initSeen) {
    if (event.type !== "system" || event.subtype !== "init") {
      outcome.protocolError ??= "Missing init event";
      return;
    }
    if (["session_id", "model", "cwd", "apiKeySource", "permissionMode"].some((field) => isNonStringEventField(event, field)) || !CURSOR_SESSION_ID_PATTERN.test(event.session_id)) {
      outcome.protocolError ??= "Invalid init event";
      return;
    }
    outcome.initSeen = true;
    outcome.sessionId = event.session_id ?? null;
    outcome.observedModel = event.model ?? null;
    try {
      run.options.onInit?.(run.pid);
    } catch (error) {
      outcome.protocolError ??= error.message;
      terminateRun(run);
    }
    return;
  }
  if (outcome.resultSeen) {
    outcome.protocolError ??= "Event after result";
    return;
  }
  if (event.type === "tool_call") {
    if (!["started", "completed"].includes(event.subtype) || typeof event.call_id !== "string" || toolKeys.length === 0) {
      outcome.protocolError ??= "Tool call missing tool name";
      return;
    }
  } else if (event.type === "result") {
    if (event.subtype !== "success" || event.is_error !== false || typeof event.result !== "string" || !CURSOR_SESSION_ID_PATTERN.test(event.session_id) || typeof event.request_id !== "string" || typeof event.duration_ms !== "number") {
      outcome.protocolError ??= "Invalid result event";
      return;
    }
    outcome.resultSeen = true;
    clearTimeout(run.runTimer);
    outcome.resultText = event.result;
    outcome.sessionId = event.session_id ?? outcome.sessionId;
    outcome.requestId = event.request_id ?? null;
    outcome.usage = event.usage ?? null;
    if (!run.closed) {
      run.exitTimer = setTimeout(() => handleExitGrace(run), run.options.exitGraceMs);
    }
  }
}

function handleStdoutData(run, chunk) {
  run.stdoutRemainder += chunk;
  let newline;
  while ((newline = run.stdoutRemainder.indexOf("\n")) !== -1) {
    processCursorLine(run, run.stdoutRemainder.slice(0, newline).replace(/\r$/, ""));
    run.stdoutRemainder = run.stdoutRemainder.slice(newline + 1);
  }
  if (run.stdoutRemainder.length > 2 * 1024 * 1024) {
    run.outcome.protocolError ??= "Stream line exceeds size limit";
    run.stdoutRemainder = "";
    terminateRun(run);
  }
}

function handleStderrData(run, chunk) {
  run.outcome.stderrTail = appendTail(run.outcome.stderrTail, chunk);
}

function handleStdinError(run, error) {
  if (error.code !== "EPIPE") {
    run.outcome.stderrTail = appendTail(run.outcome.stderrTail, Buffer.from(`\n${error.message}`));
  }
}

function handleChildError(run, error) {
  run.outcome.spawnError = error;
  run.outcome.stderrTail = appendTail(run.outcome.stderrTail, Buffer.from(error.message));
}

function handleChildExit(run, code, signal) {
  run.outcome.exitCode = code;
  run.outcome.signal = signal;
  run.drainTimer = setTimeout(() => drainRun(run), run.options.killGraceMs);
}

function scheduleDelay(done, ms) {
  setTimeout(done, ms);
}

async function handleChildClose(run, code, signal) {
  if (run.settled || run.draining) return;
  run.closed = true;
  clearTimeout(run.runTimer);
  clearTimeout(run.exitTimer);
  clearTimeout(run.killTimer);
  clearTimeout(run.drainTimer);
  if (run.stdoutRemainder.trim()) {
    processCursorLine(run, run.stdoutRemainder);
  }
  const { outcome } = run;
  outcome.exitCode = code;
  outcome.signal = signal;
  if (code === 0 && !outcome.resultSeen) {
    outcome.protocolError ??= "Missing result event";
  }
  if (outcome.eventCount && !outcome.initSeen) {
    outcome.protocolError ??= "Missing init event";
  }
  signalRunGroup(run, "SIGTERM");
  const deadline = Date.now() + run.options.killGraceMs;
  while (cursorGroupSignalable(run.pid) && Date.now() < deadline) {
    await new Promise((done) => scheduleDelay(done, Math.min(50, deadline - Date.now())));
  }
  if (cursorGroupSignalable(run.pid)) {
    signalRunGroup(run, "SIGKILL");
  }
  await reapPrivateHomeHelpers(run.options.env?.HOME);
  settleRun(run);
}

function handleDrainDeadline(run) {
  if (!run.outcome.resultSeen && !run.outcome.policyViolation) run.outcome.timedOut = true;
  drainRun(run);
}

function handleRunTimeout(run) {
  if (!run.closed) {
    run.outcome.timedOut = true;
    terminateRun(run);
  }
}

function startCursorRun(run, resolve) {
  run.resolve = resolve;
  const { bin, args, cwd, env, brief, timeoutMs, exitGraceMs, killGraceMs, launchProcess, signal } = run.options;
  try {
    run.child = launchProcess ? launchProcess(() => launchCursorProcess(bin, args, cwd, env)) : launchCursorProcess(bin, args, cwd, env);
  } catch (error) {
    run.outcome.spawnError = error;
    run.outcome.stderrTail = error.message;
    resolve(run.outcome);
    return;
  }
  run.pid = run.child.pid;
  signal?.addEventListener("abort", run.abort, { once: true });
  if (signal?.aborted) abortRun(run);
  run.child.stdout.setEncoding("utf8");
  run.child.stderr.setEncoding("utf8");
  run.child.stdout.on("data", (chunk) => handleStdoutData(run, chunk));
  run.child.stderr.on("data", (chunk) => handleStderrData(run, chunk));
  run.child.stdin.on("error", (error) => handleStdinError(run, error));
  run.child.on("error", (error) => handleChildError(run, error));
  run.child.on("exit", (code, childSignal) => handleChildExit(run, code, childSignal));
  run.child.on("close", (code, childSignal) => handleChildClose(run, code, childSignal));
  run.deadlineTimer = setTimeout(() => handleDrainDeadline(run), timeoutMs + exitGraceMs + 2 * killGraceMs);
  run.runTimer = setTimeout(() => handleRunTimeout(run), timeoutMs);
  run.child.stdin.end(brief ?? "");
}

export function runCursor({ bin, args, cwd, env, brief, timeoutMs = 540000, exitGraceMs = 15000, killGraceMs = 5000, mode, launchProcess, signal, onInit }) {
  const run = {
    options: { bin, args, cwd, env, brief, timeoutMs, exitGraceMs, killGraceMs, mode, launchProcess, signal, onInit },
    outcome: {
      exitCode: null, signal: null, sessionId: null, requestId: null, resultText: null,
      usage: null, observedModel: null, initSeen: false, resultSeen: false, protocolError: null,
      policyViolation: null, timedOut: false, lateClose: false, cancelled: false, stderrTail: "", eventCount: 0
    },
    child: undefined, pid: undefined, resolve: undefined, abort: undefined,
    closed: false, settled: false, draining: false, stdoutRemainder: "",
    runTimer: undefined, exitTimer: undefined, killTimer: undefined, drainTimer: undefined, deadlineTimer: undefined
  };
  run.abort = () => abortRun(run);
  return new Promise((resolve) => startCursorRun(run, resolve));
}

export function classifyCursorFailure(outcome) {
  const message = String(outcome.stderrTail || "");
  if (outcome.cancelled) return "cancelled";
  const spawnCode = outcome.spawnError?.code;
  if (spawnCode && ["ENOENT", "EACCES", "ENOEXEC"].includes(spawnCode)) return "missing_cli";
  if (outcome.exitCode === 127 && /command not found/i.test(message)) return "missing_cli";
  if (outcome.policyViolation) return "policy";
  if (outcome.timedOut) return "timeout";
  if (outcome.protocolError || (outcome.exitCode === 0 && (!outcome.initSeen || !outcome.resultSeen))) return "protocol";
  if (outcome.resultSeen && outcome.initSeen && (outcome.exitCode === 0 || outcome.lateClose)) return null;
  if (/Authentication required|Not logged in|Unauthorized|\b(?:401|403)\b/i.test(message)) return "auth";
  if (/usage limit|quota|spend limit|insufficient credit|\b402\b/i.test(message)) return "quota";
  if (/rate.?limit|too many requests|\b429\b/i.test(message)) return "rate_limited";
  if (/Invalid --allowed-tools value|Cannot use this model|unknown (?:option|argument)|unrecognized (?:option|argument)/i.test(message)) return "setup";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|DNS|fetch fail|network|socket hang up/i.test(message)) return "network";
  if (/Sandbox mode is enabled but not available|sandbox helper fail|sandbox denied|sandbox unavailable|operation not permitted by sandbox/i.test(message)) return "sandbox";
  if (outcome.signal || outcome.exitCode === 143) return "process";
  return outcome.exitCode === 0 ? null : "error";
}
