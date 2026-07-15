import { spawn } from "node:child_process";
import os from "node:os";

import {
  getProcessIdentity,
  processIdentityMatches,
  processIsDirectlyAlive,
  validProcessIdentity
} from "./process-identity.mjs";
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
const STDERR_CAPTURE_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_TURNS = { consult: 25, write: 60 };
const SANDBOX_FAILURE_PATTERN = /sandbox (?:could not be applied|initialization failed)/i;

const CONSULT_TOOL_IDS = ["read_file", "grep", "list_dir"];
const CONSULT_WEB_TOOL_IDS = ["web_search", "web_fetch"];
const CONSULT_ALLOW_RULES = ["Read", "Grep"];

const CONSULT_WEB_ALLOW_RULES = ["WebSearch", "WebFetch"];

export const NESTED_ENGINE_CLI_DENY_NAMES = ["grok", "claude", "codex"];

const NESTED_ENGINE_CLI_DENY_RULES = NESTED_ENGINE_CLI_DENY_NAMES.map((name) => `Bash(${name}*)`);

const CONSULT_DENY_RULES = ["Edit", "Write", "Bash", "MCPTool(*)"];

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

export function sandboxProfileForMode(mode) {
  return mode === "write" ? "workspace" : "strict";
}

export function resolveConsultAllowRules(env = process.env) {
  const raw = env[CONSULT_ALLOW_ENV];
  if (raw == null || !String(raw).trim()) {
    return [];
  }
  return String(raw)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^(?:Read|Grep|WebSearch|WebFetch)(?:\([^(),\r\n]*\))?$/.test(entry));
}

export function buildGrokArgs(options) {
  const bestOfN = options.bestOfN ?? null;
  const mode = bestOfN || options.mode === "write" ? "write" : "consult";
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS[mode];
  const args = [];

  if (options.resumeSessionId) {
    args.push("-r", options.resumeSessionId);
  }

  args.push(
    "--prompt-file",
    options.briefFile,
    "--output-format",
    "json",
    "--sandbox",
    sandboxProfileForMode(mode)
  );
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
    args.push(
      "--permission-mode",
      "default",
      "--tools",
      [...CONSULT_TOOL_IDS, ...(options.web ? CONSULT_WEB_TOOL_IDS : [])].join(","),
      "--disallowed-tools",
      "Agent"
    );
    const env = options.env ?? process.env;
    for (const rule of CONSULT_ALLOW_RULES) {
      args.push("--allow", rule);
    }
    if (options.web) {
      for (const rule of CONSULT_WEB_ALLOW_RULES) {
        args.push("--allow", rule);
      }
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

function iterJsonObjects(stdout) {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) {
    return [];
  }
  const whole = tryParseObject(trimmed);
  if (whole) {
    return [whole];
  }
  const objects = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const parsed = tryParseObject(line.trim());
    if (parsed) {
      objects.push(parsed);
    }
  }
  return objects;
}

function sessionUpdatePayload(object) {
  if (!object || typeof object !== "object") {
    return null;
  }
  if (object.sessionUpdate) {
    return object;
  }
  if (object.update && typeof object.update === "object" && object.update.sessionUpdate) {
    return object.update;
  }
  if (object.params?.update && typeof object.params.update === "object" && object.params.update.sessionUpdate) {
    return object.params.update;
  }
  return null;
}

function toolNameFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const metaTool = payload._meta?.["x.ai/tool"];
  const candidates = [
    payload.name,
    payload.toolName,
    payload.tool_name,
    payload.title,
    payload.rawInput?.variant,
    metaTool?.label,
    metaTool?.name
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function toolArgsFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (payload.rawInput != null) {
    return payload.rawInput;
  }
  if (payload.input != null) {
    return payload.input;
  }
  if (payload.args != null) {
    return payload.args;
  }
  if (typeof payload.command === "string") {
    return payload.command;
  }
  if (typeof payload.arguments === "string") {
    return payload.arguments;
  }
  return null;
}

function stringifyToolArgs(args) {
  if (args == null) {
    return "";
  }
  if (typeof args === "string") {
    return args;
  }
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function isPermissionFailureUpdate(payload) {
  if (!payload || payload.sessionUpdate !== "tool_call_update") {
    return false;
  }
  if (payload.status !== "failed") {
    return false;
  }
  const chunks = [];
  if (Array.isArray(payload.content)) {
    for (const entry of payload.content) {
      const text = entry?.content?.text ?? entry?.text;
      if (typeof text === "string") {
        chunks.push(text);
      }
    }
  }
  const joined = chunks.join("\n");
  return /permission|denied|cancelled|canceled|not allowed|allow list|allowlist/i.test(joined);
}

export function extractBlockedPermissionCall(stdout, envelope = null) {
  const objects = iterJsonObjects(stdout);
  if (envelope && typeof envelope === "object" && !objects.includes(envelope)) {
    objects.push(envelope);
  }

  for (const object of objects) {
    const directName =
      (typeof object.blockedTool === "string" && object.blockedTool) ||
      (typeof object.blocked_tool === "string" && object.blocked_tool) ||
      (typeof object.deniedTool === "string" && object.deniedTool) ||
      null;
    if (directName) {
      return {
        tool: directName.trim(),
        args: object.blockedArgs ?? object.blocked_args ?? object.deniedArgs ?? object.input ?? object.args ?? null
      };
    }
  }

  const toolCallsById = new Map();
  let lastToolCall = null;
  let deniedToolCall = null;

  for (const object of objects) {
    const payload = sessionUpdatePayload(object) ?? object;
    const sessionUpdate = payload.sessionUpdate ?? (object.type === "tool_call" ? "tool_call" : null);

    if (sessionUpdate === "tool_call" || object.type === "tool_call") {
      const tool = toolNameFromPayload(payload) ?? toolNameFromPayload(object);
      const args = toolArgsFromPayload(payload) ?? toolArgsFromPayload(object);
      if (!tool) {
        continue;
      }
      const entry = { tool, args };
      const id = payload.toolCallId ?? object.toolCallId ?? object.id ?? null;
      if (id) {
        toolCallsById.set(id, entry);
      }
      lastToolCall = entry;
      continue;
    }

    if (isPermissionFailureUpdate(payload)) {
      const id = payload.toolCallId ?? null;
      deniedToolCall = (id && toolCallsById.get(id)) || {
        tool: toolNameFromPayload(payload) || lastToolCall?.tool || "unknown",
        args: toolArgsFromPayload(payload) ?? lastToolCall?.args ?? null
      };
    }
  }

  return deniedToolCall ?? lastToolCall;
}

export function formatBlockedPermissionCall(blocked) {
  if (!blocked || typeof blocked.tool !== "string" || !blocked.tool.trim()) {
    return "; blocked call not reported by the CLI";
  }
  const argsText = stringifyToolArgs(blocked.args).slice(0, 80);
  return `; blocked call: ${blocked.tool.trim()}(${argsText})`;
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

function findSandboxFailureLine(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => SANDBOX_FAILURE_PATTERN.test(line)) ?? null;
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

function objectField(value, key) {
  const field = value?.[key];
  return field && typeof field === "object" && !Array.isArray(field) ? field : null;
}

function booleanField(value, ...keys) {
  for (const key of keys) {
    if (typeof value?.[key] === "boolean") {
      return value[key];
    }
  }
  return null;
}

function signalProcessGroup(pid, signal, identity = null) {
  if (!Number.isInteger(pid) || pid <= 1 || (identity != null && !processIdentityMatches(pid, identity))) {
    return false;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    if (identity != null && !processIdentityMatches(pid, identity)) {
      return false;
    }
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function processGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) {
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
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

export function recordedProcessState(pid, identity = null) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return "absent";
  }
  const currentIdentity = getProcessIdentity(pid);
  if (currentIdentity) {
    if (identity == null) {
      return "legacy";
    }
    if (!validProcessIdentity(identity)) {
      return "unverified";
    }
    return processIdentityMatches(pid, identity) ? "owned" : "replaced";
  }
  if (processIsDirectlyAlive(pid) || processGroupAlive(pid)) {
    return identity == null ? "legacy" : "unverified";
  }
  return "absent";
}

export function recordedProcessTargets(record) {
  const targets = new Map();
  const grokPid = normalizedPid(record?.grokPid);
  const pid = normalizedPid(record?.pid);
  if (grokPid) {
    targets.set(grokPid, { pid: grokPid, identity: record?.grokPidIdentity ?? null });
  }
  if (record?.background || !grokPid) {
    if (pid) {
      targets.set(pid, { pid, identity: record?.pidIdentity ?? null });
    }
  }
  return [...targets.values()];
}

export function recordedProcessGroupsClean(record) {
  return recordedProcessTargets(record).every(({ pid, identity }) => {
    const state = recordedProcessState(pid, identity);
    return state === "absent" || state === "replaced";
  });
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
  const targets = pid
    ? [{ pid, identity: record.pidIdentity ?? null }]
    : grokPid
      ? [{ pid: grokPid, identity: record.grokPidIdentity ?? null }]
      : [];
  const pids = targets.map((target) => target.pid);
  if (pids.length === 0) {
    const launchedAt = launchTimestampMs(record);
    const now = options.now ?? Date.now();
    const graceMs = options.pidlessGraceMs ?? resolvePidlessRunningGraceMs(options.env ?? process.env);
    return { alive: launchedAt == null || now - launchedAt <= graceMs, pids, deadPids: [] };
  }
  const deadPids = targets
    .filter(({ pid: processPid, identity }) => {
      const state = recordedProcessState(processPid, identity);
      return state === "absent" || state === "replaced";
    })
    .map((target) => target.pid);
  return { alive: deadPids.length !== pids.length, pids, deadPids };
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function terminateProcessGroupSync(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  const graceMs = options.graceMs ?? TERMINATION_GRACE_MS;
  const pollMs = options.pollMs ?? TERMINATION_POLL_MS;
  const identity = options.identity ?? null;
  const targetAlive = () => {
    if (identity == null) {
      return processGroupAlive(pid);
    }
    const currentIdentity = getProcessIdentity(pid);
    if (currentIdentity) {
      return processIdentityMatches(pid, identity);
    }
    return processGroupAlive(pid);
  };
  if (!signalProcessGroup(pid, "SIGTERM", identity)) {
    return !targetAlive();
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!targetAlive()) {
      return true;
    }
    waitSync(pollMs);
  }
  if (options.gracefulOnly === true) {
    return !targetAlive();
  }
  if (targetAlive() && !signalProcessGroup(pid, "SIGKILL", identity)) {
    return !targetAlive();
  }
  while (Date.now() < deadline + graceMs) {
    if (!targetAlive()) {
      return true;
    }
    waitSync(pollMs);
  }
  return !targetAlive();
}

export async function terminateProcessGroup(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  const graceMs = options.graceMs ?? TERMINATION_GRACE_MS;
  const pollMs = options.pollMs ?? TERMINATION_POLL_MS;
  const identity = options.identity ?? null;
  const targetAlive = () => {
    if (identity == null) {
      return processGroupAlive(pid);
    }
    const currentIdentity = getProcessIdentity(pid);
    if (currentIdentity) {
      return processIdentityMatches(pid, identity);
    }
    return processGroupAlive(pid);
  };
  if (!signalProcessGroup(pid, "SIGTERM", identity)) {
    return !targetAlive();
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!targetAlive()) {
      return true;
    }
    await waitMs(pollMs);
  }
  if (options.gracefulOnly === true) {
    return !targetAlive();
  }
  if (targetAlive() && !signalProcessGroup(pid, "SIGKILL", identity)) {
    return !targetAlive();
  }
  while (Date.now() < deadline + graceMs) {
    if (!targetAlive()) {
      return true;
    }
    await waitMs(pollMs);
  }
  return !targetAlive();
}

export function terminateRecordedProcessGroupsSync(record, options = {}) {
  const results = recordedProcessTargets(record).map(({ pid, identity }) => {
    const state = recordedProcessState(pid, identity);
    if (state === "absent" || state === "replaced") {
      return true;
    }
    if (state === "unverified") {
      return false;
    }
    return terminateProcessGroupSync(pid, {
      ...options,
      identity: state === "owned" ? identity : null,
      gracefulOnly: state === "legacy"
    });
  });
  return results.every(Boolean);
}

export async function terminateRecordedProcessGroups(record, options = {}) {
  const results = await Promise.all(recordedProcessTargets(record).map(async ({ pid, identity }) => {
    const state = recordedProcessState(pid, identity);
    if (state === "absent" || state === "replaced") {
      return true;
    }
    if (state === "unverified") {
      return false;
    }
    return terminateProcessGroup(pid, {
      ...options,
      identity: state === "owned" ? identity : null,
      gracefulOnly: state === "legacy"
    });
  }));
  return results.every(Boolean);
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
  const captureProcessIdentity = options.captureProcessIdentity ?? getProcessIdentity;

  return new Promise((resolve, reject) => {
    let child = null;
    let childIdentity = null;
    let launchError = null;
    const spawnChild = () => {
      child = spawn(bin, args, {
        cwd: options.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true
      });
      childIdentity = Number.isInteger(child.pid) ? captureProcessIdentity(child.pid) : null;
      return { child, pid: child.pid ?? null, identity: childIdentity };
    };
    try {
      if (typeof options.launchProcess === "function") {
        const launched = options.launchProcess(spawnChild);
        child = launched?.child ?? child;
        childIdentity = launched?.identity ?? childIdentity;
      } else {
        const launched = spawnChild();
        const publication = options.onSpawn?.(launched.pid, launched.identity);
        if (publication?.status && publication.status !== "running") {
          const error = new Error(`Grok process ownership could not be recorded because job ${publication.id ?? "unknown"} is already ${publication.status}.`);
          error.failureKind = publication.failureKind ?? (publication.status === "cancelled" ? "cancelled" : "error");
          throw error;
        }
      }
    } catch (error) {
      launchError = error;
    }
    if (!child) {
      reject(launchError ?? new Error("Grok process launch did not create a child process."));
      return;
    }

    let stdout = "";
    let stderr = "";
    let sandboxFailureLine = null;
    let supervisionError = null;
    let terminationPromise = null;
    let timedOut = false;
    let cancelledByCompanion = false;
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      process.removeListener("SIGTERM", forwardTermination);
      process.removeListener("SIGINT", forwardTermination);
    };
    const cleanupFailure = () => {
      const error = new Error("Verified Grok process cleanup did not complete after the run was aborted.");
      error.failureKind = timedOut ? "timeout" : cancelledByCompanion ? "cancelled" : supervisionError?.failureKind ?? "error";
      error.cleanupRequired = true;
      error.processRole = "grok";
      error.pid = child.pid ?? null;
      error.pidIdentity = childIdentity;
      return error;
    };
    const finishReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      reject(error);
    };
    const terminateChild = () => {
      if (!Number.isInteger(child.pid) || child.pid <= 1) {
        terminationPromise ??= Promise.resolve(true);
        return terminationPromise;
      }
      terminationPromise ??= terminateProcessGroup(
        child.pid,
        childIdentity ? { identity: childIdentity } : {}
      ).catch(() => false);
      void terminationPromise.then((cleaned) => {
        if (!cleaned) {
          finishReject(cleanupFailure());
        }
      });
      return terminationPromise;
    };
    const forwardTermination = () => {
      cancelledByCompanion = true;
      terminateChild();
    };
    process.once("SIGTERM", forwardTermination);
    process.once("SIGINT", forwardTermination);
    timer = setTimeout(() => {
      timedOut = true;
      terminateChild();
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk, STDOUT_CAPTURE_MAX_BYTES);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk, STDERR_CAPTURE_MAX_BYTES);
      const detectedSandboxFailure = sandboxFailureLine ?? findSandboxFailureLine(stderr);
      if (!sandboxFailureLine && detectedSandboxFailure) {
        sandboxFailureLine = detectedSandboxFailure;
        terminateChild();
      }
      if (!supervisionError) {
        try {
          appendJobLog(options.logFile, chunk.toString());
        } catch (error) {
          supervisionError = error;
          terminateChild();
        }
      }
    });
    child.on("error", (error) => {
      finishReject(error);
    });
    child.on("close", async (code, signal) => {
      if (settled) {
        return;
      }
      cleanup();
      if (terminationPromise && !(await terminationPromise)) {
        finishReject(cleanupFailure());
        return;
      }
      if (supervisionError) {
        finishReject(supervisionError);
        return;
      }
      const parsed = parseGrokOutput(stdout);
      const exitCode = code ?? exitCodeFromSignal(signal);
      const validEnvelope = isGrokEnvelope(parsed);
      const structuredErrorMessage =
        parsed?.type === "error" && typeof parsed.message === "string" && parsed.message.trim()
          ? parsed.message.trim()
          : null;
      const errorMessage = sandboxFailureLine
        ? `Grok sandbox enforcement failed; refusing the result: ${sandboxFailureLine}`
        : structuredErrorMessage;
      const parseError =
        exitCode === 0 && !timedOut && !validEnvelope && !errorMessage && expectsJsonOutput(args)
          ? "Grok did not return a valid JSON envelope for --output-format json."
          : null;
      const stopReason = validEnvelope ? parsed.stopReason : null;
      const blockedPermissionCall =
        stopReason === "Cancelled" ? extractBlockedPermissionCall(stdout, validEnvelope ? parsed : null) : null;
      settled = true;
      resolve({
        text: validEnvelope ? parsed.text : stdout.trim(),
        sessionId: validEnvelope && typeof parsed.sessionId === "string" && parsed.sessionId ? parsed.sessionId : null,
        stopReason,
        usage: objectField(parsed, "usage"),
        modelUsage: objectField(parsed, "modelUsage"),
        usageIsIncomplete: booleanField(parsed, "usage_is_incomplete", "usageIsIncomplete"),
        errorMessage,
        exitCode,
        timedOut,
        parseError,
        stdoutTail: stdoutTail(stdout),
        cancelledByCompanion,
        blockedPermissionCall
      });
    });

    if (launchError) {
      supervisionError = launchError;
      terminateChild();
    }
  });
}
