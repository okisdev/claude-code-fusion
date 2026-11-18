import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createProcessTransport, destroyRunStreams, executablePath, inheritChildEnv, runProcess, settleRun } from "./process-run.mjs";
import { CURSOR_SESSION_ID_PATTERN } from "./cursor-home.mjs";

export const TESTED_CURSOR_INTERVAL = { floor: "2026.10.01", ceiling: "2026.11.01" };

const READ_TOOLS = ["read_tool_call", "grep_tool_call", "glob_tool_call", "ls_tool_call"];
const WRITE_TOOLS = [...READ_TOOLS, "edit_tool_call", "delete_tool_call", "shell_tool_call", "update_todos_tool_call", "read_todos_tool_call"];
const { signalRunGroup, terminateRun, finishProcessGroup, startProcess } = createProcessTransport({
  processLine: processCursorLine,
  onStreamOverflow(run) {
    run.outcome.protocolError ??= "Stream line exceeds size limit";
    terminateRun(run);
  }
});

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

export function resolveCursorBin(env = process.env) {
  return env.CURSOR_AGENT_BIN?.trim() || "cursor-agent";
}

export function probeCursorVersion(bin, env = process.env) {
  const buildPath = executablePath(bin, env, "Cursor");
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

export function buildCursorChildEnv({ env = process.env, homeDir, dataDir }) {
  const childEnv = inheritChildEnv(env, ["CURSOR_API_KEY"]);
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

function abortRun(run) {
  if (run.settled) return;
  run.outcome.cancelled = true;
  terminateRun(run);
}

async function drainRun(run) {
  if (run.settled || run.draining) return;
  run.draining = true;
  destroyRunStreams(run);
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
      if (name !== "mcp_list_servers_tool_call" && !allowedToolsForMode(run.options.mode).includes(name)) {
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
  await finishProcessGroup(run);
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
  const { args, brief, timeoutMs, exitGraceMs, killGraceMs, signal } = run.options;
  if (!startProcess(run, resolve, args, {
    launchError(run, error) {
      run.outcome.spawnError = error;
      run.outcome.stderrTail = error.message;
      run.resolve(run.outcome);
    },
    exit: handleChildExit,
    close: handleChildClose
  })) return;
  signal?.addEventListener("abort", run.abort, { once: true });
  if (signal?.aborted) abortRun(run);
  run.deadlineTimer = setTimeout(() => handleDrainDeadline(run), timeoutMs + exitGraceMs + 2 * killGraceMs);
  run.runTimer = setTimeout(() => handleRunTimeout(run), timeoutMs);
  run.child.stdin.end(brief ?? "");
}

export function runCursor({ bin, args, cwd, env, brief, timeoutMs = 540000, exitGraceMs = 15000, killGraceMs = 5000, mode, launchProcess, signal, onInit }) {
  return runProcess({ bin, args, cwd, env, brief, timeoutMs, exitGraceMs, killGraceMs, mode, launchProcess, signal, onInit }, {
    outcome: { initSeen: false, eventCount: 0 },
    start: startCursorRun,
    abort: abortRun
  });
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
