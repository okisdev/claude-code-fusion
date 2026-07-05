import { spawn } from "node:child_process";
import os from "node:os";

import { appendJobLog } from "./state.mjs";

const BIN_ENV = "GROK_BIN";
const TIMEOUT_ENV = "GROK_COMPANION_TIMEOUT_MS";
const PIDLESS_RUNNING_GRACE_ENV = "GROK_COMPANION_PIDLESS_RUNNING_GRACE_MS";
const CONSULT_ALLOW_ENV = "GROK_CONSULT_ALLOW";
const DEFAULT_FOREGROUND_TIMEOUT_MS = 570000;
const BACKGROUND_TIMEOUT_CAP_MS = 1800000;
const DEFAULT_PIDLESS_RUNNING_GRACE_MS = 15000;
const TERMINATION_GRACE_MS = 2000;
const TERMINATION_POLL_MS = 50;
const STDOUT_CAPTURE_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_TURNS = { consult: 25, write: 60 };

const CONSULT_ALLOW_RULES = [
  "Read",
  "Grep",
  "Bash(git diff)",
  "Bash(git diff *)",
  "Bash(git log)",
  "Bash(git log *)",
  "Bash(git show)",
  "Bash(git show *)",
  "Bash(git status)",
  "Bash(git status *)",
  "Bash(git blame)",
  "Bash(git blame *)",
  "Bash(gh pr view)",
  "Bash(gh pr view *)",
  "Bash(gh pr list)",
  "Bash(gh pr list *)",
  "Bash(gh pr diff)",
  "Bash(gh pr diff *)",
  "Bash(gh pr checks)",
  "Bash(gh pr checks *)",
  "Bash(gh issue view)",
  "Bash(gh issue view *)",
  "Bash(gh issue list)",
  "Bash(gh issue list *)",
  "Bash(gh repo view)",
  "Bash(gh repo view *)",
  "Bash(gh search)",
  "Bash(gh search *)",
  "Bash(gh run view)",
  "Bash(gh run view *)",
  "Bash(gh run list)",
  "Bash(gh run list *)",
  "Bash(gh release view)",
  "Bash(gh release view *)",
  "Bash(gh release list)",
  "Bash(gh release list *)"
];

export const NESTED_ENGINE_CLI_DENY_NAMES = ["grok", "claude", "codex"];

const NESTED_ENGINE_CLI_DENY_RULES = NESTED_ENGINE_CLI_DENY_NAMES.map((name) => `Bash(${name}*)`);

const CONSULT_DENY_RULES = [
  "Edit",
  "Write",
  "Bash(*;*)",
  "Bash(*&&*)",
  "Bash(*||*)",
  "Bash(*|*)",
  "Bash(*>*)",
  "Bash(*<*)",
  "Bash(*`*)",
  "Bash(*$*)",
  ...NESTED_ENGINE_CLI_DENY_RULES,
  "Bash(node*)"
];

const WRITE_DENY_RULES = [
  "Bash(sudo*)",
  "Bash(rm -rf*)",
  "Bash(git push*)",
  ...NESTED_ENGINE_CLI_DENY_RULES
];

export function resolveGrokBin(env = process.env) {
  const override = env[BIN_ENV];
  return override && override.trim() ? override.trim() : "grok";
}

export function resolveTimeoutMs({ background = false, env = process.env } = {}) {
  const raw = Number(env[TIMEOUT_ENV]);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  if (background) {
    return Math.min(configured ?? BACKGROUND_TIMEOUT_CAP_MS, BACKGROUND_TIMEOUT_CAP_MS);
  }
  return configured ?? DEFAULT_FOREGROUND_TIMEOUT_MS;
}

export function resolvePidlessRunningGraceMs(env = process.env) {
  const raw = Number(env[PIDLESS_RUNNING_GRACE_ENV]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_PIDLESS_RUNNING_GRACE_MS;
}

export function resolveConsultAllowRules(env = process.env) {
  const raw = env[CONSULT_ALLOW_ENV];
  if (raw == null || !String(raw).trim()) {
    return [];
  }
  return String(raw)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function buildGrokArgs(options) {
  const bestOfN = options.bestOfN ?? null;
  const mode = bestOfN || options.mode === "write" ? "write" : "consult";
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS[mode];
  const args = [];

  if (options.resumeSessionId) {
    args.push("-r", options.resumeSessionId);
  }

  args.push("--prompt-file", options.briefFile, "--output-format", "json", "--sandbox", "workspace");
  if (!bestOfN) {
    args.push("--no-subagents");
  }
  if (!options.web) {
    args.push("--disable-web-search");
  }
  args.push("--max-turns", String(maxTurns));

  if (options.model) {
    args.push("-m", options.model);
  }
  if (options.effort) {
    args.push("--effort", options.effort);
  }

  if (mode === "consult") {
    args.push("--permission-mode", "dontAsk");
    const env = options.env ?? process.env;
    for (const rule of CONSULT_ALLOW_RULES) {
      args.push("--allow", rule);
    }
    for (const rule of resolveConsultAllowRules(env)) {
      args.push("--allow", rule);
    }
    for (const rule of CONSULT_DENY_RULES) {
      args.push("--deny", rule);
    }
  } else {
    args.push("--always-approve");
    for (const rule of WRITE_DENY_RULES) {
      args.push("--deny", rule);
    }
  }

  if (bestOfN) {
    args.push("--best-of-n", String(bestOfN));
  }

  return args;
}

function tryParseObject(text) {
  if (!text || !text.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseGrokOutput(stdout) {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const whole = tryParseObject(trimmed);
  if (whole) {
    return whole;
  }
  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = tryParseObject(lines[index].trim());
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function appendBounded(value, chunk, maxBytes) {
  const next = `${value}${chunk.toString()}`;
  if (Buffer.byteLength(next) <= maxBytes) {
    return next;
  }
  return Buffer.from(next).subarray(-maxBytes).toString("utf8");
}

function stdoutTail(stdout) {
  return String(stdout ?? "").trim().slice(-8192);
}

function expectsJsonOutput(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--output-format" && args[index + 1] === "json") {
      return true;
    }
    if (token === "--output-format=json") {
      return true;
    }
  }
  return false;
}

function isGrokEnvelope(value) {
  return Boolean(value) && typeof value.text === "string" && typeof value.stopReason === "string";
}

function signalProcessGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function processGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (groupError) {
    if (groupError?.code === "EPERM") {
      return true;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (pidError) {
      if (pidError?.code === "EPERM") {
        return true;
      }
      return false;
    }
  }
}

function normalizedPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function launchTimestampMs(record) {
  const value = record?.startedAt ?? record?.createdAt;
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function runningJobLiveness(record, options = {}) {
  if (record?.status !== "running") {
    return { alive: true, pids: [], deadPids: [] };
  }
  const pid = normalizedPid(record.pid);
  const grokPid = normalizedPid(record.grokPid);
  const pids = pid ? [pid] : grokPid ? [grokPid] : [];
  if (pids.length === 0) {
    const launchedAt = launchTimestampMs(record);
    const now = options.now ?? Date.now();
    const graceMs = options.pidlessGraceMs ?? resolvePidlessRunningGraceMs(options.env ?? process.env);
    return { alive: launchedAt == null || now - launchedAt <= graceMs, pids, deadPids: [] };
  }
  const deadPids = pids.filter((processPid) => !processGroupAlive(processPid));
  return { alive: deadPids.length !== pids.length, pids, deadPids };
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function terminateProcessGroup(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  const graceMs = options.graceMs ?? TERMINATION_GRACE_MS;
  const pollMs = options.pollMs ?? TERMINATION_POLL_MS;
  signalProcessGroup(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!processGroupAlive(pid)) {
      return true;
    }
    await waitMs(pollMs);
  }
  if (processGroupAlive(pid)) {
    signalProcessGroup(pid, "SIGKILL");
  }
  while (Date.now() < deadline + graceMs) {
    if (!processGroupAlive(pid)) {
      return true;
    }
    await waitMs(pollMs);
  }
  return !processGroupAlive(pid);
}

function exitCodeFromSignal(signal) {
  if (!signal) {
    return 1;
  }
  const signalNumber = os.constants.signals[signal];
  return Number.isInteger(signalNumber) ? 128 + signalNumber : 1;
}

export function runGrok(options) {
  const env = options.env ?? process.env;
  const bin = options.bin ?? resolveGrokBin(env);
  const args = options.args ?? buildGrokArgs(options);
  const timeoutMs = options.timeoutMs ?? resolveTimeoutMs({ background: Boolean(options.background), env });

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    options.onSpawn?.(child.pid ?? null);

    let stdout = "";
    let timedOut = false;
    let cancelledByCompanion = false;
    const forwardTermination = () => {
      cancelledByCompanion = true;
      void terminateProcessGroup(child.pid);
    };
    process.once("SIGTERM", forwardTermination);
    process.once("SIGINT", forwardTermination);
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessGroup(child.pid);
    }, timeoutMs);
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      process.removeListener("SIGTERM", forwardTermination);
      process.removeListener("SIGINT", forwardTermination);
    };

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk, STDOUT_CAPTURE_MAX_BYTES);
    });
    child.stderr.on("data", (chunk) => {
      appendJobLog(options.logFile, chunk.toString());
    });
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code, signal) => {
      cleanup();
      const parsed = parseGrokOutput(stdout);
      const exitCode = code ?? exitCodeFromSignal(signal);
      const validEnvelope = isGrokEnvelope(parsed);
      const parseError =
        exitCode === 0 && !timedOut && !validEnvelope && expectsJsonOutput(args)
          ? "Grok did not return a valid JSON envelope for --output-format json."
          : null;
      resolve({
        text: validEnvelope ? parsed.text : stdout.trim(),
        sessionId: validEnvelope && typeof parsed.sessionId === "string" && parsed.sessionId ? parsed.sessionId : null,
        stopReason: validEnvelope ? parsed.stopReason : null,
        exitCode,
        timedOut,
        parseError,
        stdoutTail: stdoutTail(stdout),
        cancelledByCompanion
      });
    });
  });
}
