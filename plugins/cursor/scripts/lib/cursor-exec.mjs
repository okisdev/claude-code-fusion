import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CURSOR_SESSION_ID_PATTERN } from "./cursor-home.mjs";

export const TESTED_CURSOR_INTERVAL = { floor: "2026.10.01", ceiling: "2026.11.01" };

const READ_TOOLS = ["read_tool_call", "grep_tool_call", "glob_tool_call", "ls_tool_call"];
const WRITE_TOOLS = [...READ_TOOLS, "edit_tool_call", "delete_tool_call", "shell_tool_call", "update_todos_tool_call", "read_todos_tool_call"];
const STDERR_MAX_BYTES = 64 * 1024;

export function resolveCursorBin(env = process.env) {
  return env.CURSOR_AGENT_BIN?.trim() || "cursor-agent";
}

function executablePath(bin, env) {
  const candidates = bin.includes(path.sep) ? [path.resolve(bin)] : String(env.PATH || "").split(path.delimiter).map((directory) => path.join(directory || ".", bin));
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
  const date = (value) => String(value).slice(0, 10);
  return date(left).localeCompare(date(right));
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
  const allowed = new Set(["PATH", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TMPDIR", "TZ", "USER", "LOGNAME", "SHELL", "CURSOR_API_KEY", "JAVA_HOME", "GOROOT", "GOPATH", "CARGO_HOME", "RUSTUP_HOME", "PNPM_HOME", "BUN_INSTALL", "VOLTA_HOME", "MISE_DATA_DIR", "MISE_CONFIG_DIR", "MISE_CACHE_DIR", "ANDROID_HOME", "ANDROID_SDK_ROOT", "DEVELOPER_DIR", "SDKROOT"]);
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key) || key.startsWith("LC_")));
  childEnv.HOME = homeDir;
  childEnv.NODE_COMPILE_CACHE = path.join(dataDir, "compile-cache");
  return childEnv;
}

function toolName(key) {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function appendTail(previous, chunk) {
  const combined = Buffer.from(previous + chunk, "utf8");
  return combined.subarray(Math.max(0, combined.length - STDERR_MAX_BYTES)).toString("utf8");
}

function helperHome(pid, platform) {
  if (platform === "linux") {
    try {
      const entry = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((value) => value.startsWith("HOME="));
      return entry ? entry.slice(5) : null;
    } catch {
      return null;
    }
  }
  const result = spawnSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.match(/(?:^|\s)HOME=(\S+)/)?.[1] ?? null : null;
}

export async function reapPrivateHomeHelpers(homeDir, { platform = process.platform, graceMs = 2000 } = {}) {
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) {
    return [];
  }
  const listing = spawnSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" });
  if (listing.status !== 0) {
    return [];
  }
  const helpers = listing.stdout.split("\n").map((line) => line.trim().match(/^(\d+)\s+(.*)$/)).filter((match) => match && /\bworker-server\b/.test(match[2])).map((match) => Number(match[1])).filter((pid) => pid > 1 && pid !== process.pid && helperHome(pid, platform) === homeDir);
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  };
  for (const pid of helpers) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      void 0;
    }
  }
  const deadline = Date.now() + graceMs;
  while (helpers.some(alive) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 50));
  }
  for (const pid of helpers.filter(alive)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      void 0;
    }
  }
  return helpers;
}

export function runCursor({ bin, args, cwd, env, brief, timeoutMs = 540000, exitGraceMs = 15000, killGraceMs = 5000, mode, launchProcess, signal, onInit }) {
  return new Promise((resolve) => {
    const outcome = {
      exitCode: null, signal: null, sessionId: null, requestId: null, resultText: null,
      usage: null, observedModel: null, initSeen: false, resultSeen: false, protocolError: null,
      policyViolation: null, timedOut: false, lateClose: false, cancelled: false, stderrTail: "", eventCount: 0
    };
    let child;
    try {
      const launch = () => spawn(bin, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      child = launchProcess ? launchProcess(launch) : launch();
    } catch (error) {
      outcome.spawnError = error;
      outcome.stderrTail = error.message;
      resolve(outcome);
      return;
    }
    const pid = child.pid;
    let closed = false;
    let stdoutRemainder = "";
    let runTimer;
    let exitTimer;
    let killTimer;
    let drainTimer;
    let deadlineTimer;
    let settled = false;
    let draining = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(runTimer);
      clearTimeout(exitTimer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", abort);
      resolve(outcome);
    };
    const signalGroup = (signal) => {
      if (!Number.isInteger(pid) || pid <= 1) {
        return;
      }
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") {
          outcome.stderrTail = appendTail(outcome.stderrTail, Buffer.from(`\n${error.message}`));
        }
      }
    };
    const groupAlive = () => {
      if (!Number.isInteger(pid) || pid <= 1) {
        return false;
      }
      try {
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        return error.code === "EPERM";
      }
    };
    const terminate = () => {
      signalGroup("SIGTERM");
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), killGraceMs);
    };
    const abort = () => {
      if (settled) return;
      outcome.cancelled = true;
      terminate();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const drain = async () => {
      if (settled || draining) return;
      draining = true;
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      signalGroup("SIGKILL");
      await reapPrivateHomeHelpers(env?.HOME);
      settle();
    };
    const processLine = (line) => {
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
        toolKeys = calls && typeof calls === "object" && !Array.isArray(calls) ? Object.keys(calls).filter((key) => key.endsWith("ToolCall")) : [];
        for (const key of toolKeys) {
          const name = toolName(key);
          if (!allowedToolsForMode(mode).includes(name)) {
            outcome.policyViolation ??= name;
            terminate();
          }
        }
        if (outcome.policyViolation) return;
      }
      if (!outcome.initSeen) {
        if (event.type !== "system" || event.subtype !== "init") {
          outcome.protocolError ??= "Missing init event";
          return;
        }
        if (["session_id", "model", "cwd", "apiKeySource", "permissionMode"].some((field) => typeof event[field] !== "string") || !CURSOR_SESSION_ID_PATTERN.test(event.session_id)) {
          outcome.protocolError ??= "Invalid init event";
          return;
        }
        outcome.initSeen = true;
        outcome.sessionId = event.session_id ?? null;
        outcome.observedModel = event.model ?? null;
        try {
          onInit?.(pid);
        } catch (error) {
          outcome.protocolError ??= error.message;
          terminate();
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
        clearTimeout(runTimer);
        outcome.resultText = event.result;
        outcome.sessionId = event.session_id ?? outcome.sessionId;
        outcome.requestId = event.request_id ?? null;
        outcome.usage = event.usage ?? null;
        if (!closed) {
          exitTimer = setTimeout(() => {
            if (!closed) {
              outcome.lateClose = true;
              terminate();
            }
          }, exitGraceMs);
        }
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutRemainder += chunk;
      let newline;
      while ((newline = stdoutRemainder.indexOf("\n")) !== -1) {
        processLine(stdoutRemainder.slice(0, newline).replace(/\r$/, ""));
        stdoutRemainder = stdoutRemainder.slice(newline + 1);
      }
      if (stdoutRemainder.length > 2 * 1024 * 1024) {
        outcome.protocolError ??= "Stream line exceeds size limit";
        stdoutRemainder = "";
        terminate();
      }
    });
    child.stderr.on("data", (chunk) => {
      outcome.stderrTail = appendTail(outcome.stderrTail, chunk);
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") {
        outcome.stderrTail = appendTail(outcome.stderrTail, Buffer.from(`\n${error.message}`));
      }
    });
    child.on("error", (error) => {
      outcome.spawnError = error;
      outcome.stderrTail = appendTail(outcome.stderrTail, Buffer.from(error.message));
    });
    child.on("exit", (code, signal) => {
      outcome.exitCode = code;
      outcome.signal = signal;
      drainTimer = setTimeout(drain, killGraceMs);
    });
    child.on("close", async (code, signal) => {
      if (settled || draining) return;
      closed = true;
      clearTimeout(runTimer);
      clearTimeout(exitTimer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      if (stdoutRemainder.trim()) {
        processLine(stdoutRemainder);
      }
      outcome.exitCode = code;
      outcome.signal = signal;
      if (code === 0 && !outcome.resultSeen) {
        outcome.protocolError ??= "Missing result event";
      }
      if (outcome.eventCount && !outcome.initSeen) {
        outcome.protocolError ??= "Missing init event";
      }
      signalGroup("SIGTERM");
      const deadline = Date.now() + killGraceMs;
      while (groupAlive() && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, Math.min(50, deadline - Date.now())));
      }
      if (groupAlive()) {
        signalGroup("SIGKILL");
      }
      await reapPrivateHomeHelpers(env?.HOME);
      settle();
    });
    deadlineTimer = setTimeout(() => {
      if (!outcome.resultSeen && !outcome.policyViolation) outcome.timedOut = true;
      drain();
    }, timeoutMs + exitGraceMs + 2 * killGraceMs);
    runTimer = setTimeout(() => {
      if (!closed) {
        outcome.timedOut = true;
        terminate();
      }
    }, timeoutMs);
    child.stdin.end(brief ?? "");
  });
}

export function classifyCursorFailure(outcome) {
  const message = String(outcome.stderrTail || "");
  if (outcome.cancelled) return "cancelled";
  if ((outcome.spawnError?.code && ["ENOENT", "EACCES", "ENOEXEC"].includes(outcome.spawnError.code)) || /\bENOENT\b|command not found/i.test(message)) return "missing_cli";
  if (outcome.policyViolation) return "policy";
  if (outcome.timedOut) return "timeout";
  if (outcome.protocolError || (outcome.exitCode === 0 && (!outcome.initSeen || !outcome.resultSeen))) return "protocol";
  if (outcome.resultSeen && outcome.initSeen && (outcome.exitCode === 0 || outcome.lateClose)) return null;
  if (/Invalid --allowed-tools value|Cannot use this model|unknown (?:option|argument)|unrecognized (?:option|argument)/i.test(message)) return "setup";
  if (/Authentication required|Not logged in|Unauthorized|\b(?:401|403)\b/i.test(message)) return "auth";
  if (/usage limit|quota|spend limit|insufficient credit|\b402\b/i.test(message)) return "quota";
  if (/rate.?limit|too many requests|\b429\b/i.test(message)) return "rate_limited";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|DNS|fetch fail|network|socket hang up/i.test(message)) return "network";
  if (/Sandbox mode is enabled but not available|sandbox helper fail/i.test(message)) return "sandbox";
  if (outcome.signal || outcome.exitCode === 143) return "process";
  return outcome.exitCode === 0 ? null : "error";
}
