import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_TIMEOUT_MS = 570000;
export const DEFAULT_TERMINATION_GRACE_MS = 2000;
export const DEFAULT_TERMINATION_POLL_MS = 25;
export const BASH_TOOL_TIMEOUT_MS = 600000;
export const TIMEOUT_PATH_MARGIN_MS = 15000;
const FORCED_CLOSE_MS = 50;
const DEFAULT_TIMEOUT_ESCALATION_MS =
  DEFAULT_TERMINATION_GRACE_MS * 2 + DEFAULT_TERMINATION_POLL_MS * 3 + FORCED_CLOSE_MS;
export const DEFAULT_TIMEOUT_PATH_MAX_MS = DEFAULT_TIMEOUT_MS + DEFAULT_TIMEOUT_ESCALATION_MS;
export const DEFAULT_TIMEOUT_PATH_WITH_MARGIN_MS = DEFAULT_TIMEOUT_PATH_MAX_MS + TIMEOUT_PATH_MARGIN_MS;

if (DEFAULT_TIMEOUT_PATH_WITH_MARGIN_MS > BASH_TOOL_TIMEOUT_MS) {
  throw new Error("The default Codex timeout path exceeds the Bash tool deadline.");
}
const DEFAULT_STDERR_MAX_BYTES = 256 * 1024;
const DEFAULT_EVENTS_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_EVENT_LINE_MAX_BYTES = 1024 * 1024;
const DEFAULT_PROMPT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_RESULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_ROLLOUT_HEAD_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_ROLLOUT_TAIL_MAX_BYTES = 16 * 1024 * 1024;
const MAX_ROLLOUT_SCAN_ENTRIES = 50000;
const MAX_DIAGNOSTICS = 64;
const MAX_DIAGNOSTIC_MESSAGE_BYTES = 4096;
const EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const SERVICE_TIER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WEB_SEARCH_MODES = new Set(["disabled", "cached", "live"]);
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const ZERO_USAGE = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0
});

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonemptyString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function resolveCodexBin(options = {}) {
  const env = options.env ?? process.env;
  const candidate = options.bin ?? env.CODEX_BIN;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : "codex";
}

function probeCodex(options = {}) {
  const bin = resolveCodexBin(options);
  const result = spawnSync(bin, ["--version"], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 5000,
    windowsHide: true
  });
  const rawVersion = String(result.stdout || result.stderr || "").trim();
  const match = rawVersion.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/);
  const errorMessage =
    result.error?.message ||
    (result.status !== 0
      ? rawVersion || `Codex exited with code ${result.status ?? 1}.`
      : match
        ? null
        : "Codex returned an unrecognized version string.");
  return {
    available: !result.error && result.status === 0 && Boolean(match),
    bin,
    version: match?.[0] ?? null,
    rawVersion: rawVersion || null,
    exitCode: result.status,
    errorMessage
  };
}

export function getCodexVersion(options = {}) {
  return probeCodex(options).version;
}

export function getCodexAvailability(options = {}) {
  return probeCodex(options);
}

function sandboxForTask(options) {
  const write = options.write === true || options.mode === "write";
  const expected = write ? "workspace-write" : "read-only";
  if (options.sandboxMode === "danger-full-access") {
    throw new TypeError("danger-full-access is not supported by the Codex adapter.");
  }
  if (options.sandboxMode != null && options.sandboxMode !== expected) {
    throw new TypeError(`Task sandbox must be ${expected}.`);
  }
  return expected;
}

function appendExplicitSettings(args, options, sandbox) {
  if (options.approvalPolicy != null && options.approvalPolicy !== "never") {
    throw new TypeError("Codex exec approval policy must be never.");
  }
  if (options.model != null) {
    args.push("--model", nonemptyString(options.model, "model"));
  }
  const configuredServiceTier = hasOwn(options, "serviceTier") ? options.serviceTier : "priority";
  const serviceTier = configuredServiceTier === "none" ? null : configuredServiceTier;
  if (serviceTier != null) {
    if (typeof serviceTier !== "string" || !SERVICE_TIER_PATTERN.test(serviceTier)) {
      throw new TypeError(`Unsupported Codex service tier: ${serviceTier}`);
    }
    args.push("-c", `service_tier=${serviceTier}`);
  }
  const effort = options.effort ?? options.modelReasoningEffort;
  if (effort != null) {
    if (typeof effort !== "string" || !EFFORT_PATTERN.test(effort)) {
      throw new TypeError(`Unsupported Codex reasoning effort: ${effort}`);
    }
    args.push("--config", `model_reasoning_effort=${JSON.stringify(effort)}`);
  }
  let webSearchMode = "disabled";
  if (hasOwn(options, "webSearchMode")) {
    webSearchMode = options.webSearchMode;
  } else if (hasOwn(options, "webSearchEnabled")) {
    webSearchMode = options.webSearchEnabled ? "live" : "disabled";
  } else if (hasOwn(options, "web")) {
    webSearchMode = options.web ? "live" : "disabled";
  }
  if (!WEB_SEARCH_MODES.has(webSearchMode)) {
    throw new TypeError(`Unsupported Codex web search mode: ${webSearchMode}`);
  }
  args.push("--config", `web_search=${JSON.stringify(webSearchMode)}`);
  const hasNetworkSetting = hasOwn(options, "networkAccessEnabled") || hasOwn(options, "network");
  const network = hasNetworkSetting ? (hasOwn(options, "networkAccessEnabled") ? options.networkAccessEnabled : options.network) : false;
  if (typeof network !== "boolean") {
    throw new TypeError("networkAccessEnabled must be a boolean.");
  }
  if (network && sandbox !== "workspace-write") {
    throw new TypeError("Codex sandbox network access requires a write task.");
  }
  if (sandbox === "workspace-write") {
    args.push("--config", `sandbox_workspace_write.network_access=${network}`);
  }
  const cwd = options.workingDirectory ?? options.cwd;
  if (cwd != null) {
    args.push("--cd", nonemptyString(cwd, "workingDirectory"));
  }
  if (options.skipGitRepoCheck === true) {
    args.push("--skip-git-repo-check");
  }
  if (options.outputSchemaFile != null) {
    args.push("--output-schema", nonemptyString(options.outputSchemaFile, "outputSchemaFile"));
  }
  if (options.additionalDirectories != null) {
    if (!Array.isArray(options.additionalDirectories)) {
      throw new TypeError("additionalDirectories must be an array.");
    }
    for (const directory of options.additionalDirectories) {
      args.push("--add-dir", nonemptyString(directory, "additional directory"));
    }
  }
}

function baseExecArgs(sandbox, options) {
  const args = [
    "exec",
    "--strict-config",
    "--json",
    "--sandbox",
    sandbox,
    "--config",
    'approval_policy="never"',
    "--disable",
    "multi_agent",
    "--disable",
    "multi_agent_v2"
  ];
  appendExplicitSettings(args, options, sandbox);
  return args;
}

export function buildTaskArgs(options = {}) {
  const args = baseExecArgs(sandboxForTask(options), options);
  const threadId = options.resumeThreadId ?? options.threadId;
  if (threadId != null) {
    args.push("resume", nonemptyString(threadId, "resumeThreadId"));
  }
  if (options.images != null) {
    if (!Array.isArray(options.images)) {
      throw new TypeError("images must be an array.");
    }
    for (const image of options.images) {
      args.push("--image", nonemptyString(image, "image"));
    }
  }
  return args;
}

export function buildReviewArgs(options = {}) {
  if (options.write === true || options.mode === "write" || options.sandboxMode === "workspace-write" || options.sandboxMode === "danger-full-access") {
    throw new TypeError("Codex native review must use the read-only sandbox.");
  }
  if (options.outputSchemaFile != null) {
    throw new TypeError("Codex review ignores --output-schema on tested CLI versions.");
  }
  const args = baseExecArgs("read-only", options);
  args.push("review");
  const targets = [options.uncommitted === true, options.base != null, options.commit != null].filter(Boolean).length;
  if (targets > 1) {
    throw new TypeError("Codex review accepts only one target.");
  }
  if (options.base != null) {
    args.push("--base", nonemptyString(options.base, "base"));
  } else if (options.commit != null) {
    args.push("--commit", nonemptyString(options.commit, "commit"));
    if (options.commitTitle != null) {
      args.push("--title", nonemptyString(options.commitTitle, "commitTitle"));
    }
  } else {
    args.push("--uncommitted");
  }
  return args;
}

function usageField(value, ...keys) {
  for (const key of keys) {
    if (hasOwn(value, key)) {
      const field = value[key];
      return Number.isSafeInteger(field) && field >= 0 ? field : null;
    }
  }
  return null;
}

export function normalizeCumulativeUsage(value) {
  const raw = value?.total_token_usage ?? value?.totalTokenUsage ?? value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const inputTokens = usageField(raw, "inputTokens", "input_tokens");
  const cachedInputTokens = usageField(raw, "cachedInputTokens", "cached_input_tokens");
  const outputTokens = usageField(raw, "outputTokens", "output_tokens");
  const reasoningOutputTokens = usageField(raw, "reasoningOutputTokens", "reasoning_output_tokens");
  if ([inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens].some((field) => field == null)) {
    return null;
  }
  if (cachedInputTokens > inputTokens || reasoningOutputTokens > outputTokens) {
    return null;
  }
  const reportedTotal = usageField(raw, "totalTokens", "total_tokens");
  const calculatedTotal = inputTokens + outputTokens;
  if (!Number.isSafeInteger(calculatedTotal)) {
    return null;
  }
  if (reportedTotal != null && reportedTotal !== calculatedTotal) {
    return null;
  }
  const totalTokens = reportedTotal ?? calculatedTotal;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

export function subtractUsage(endValue, startValue) {
  const end = normalizeCumulativeUsage(endValue);
  const start = normalizeCumulativeUsage(startValue);
  if (!end || !start) {
    return null;
  }
  const result = {};
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]) {
    const value = end[key] - start[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      return null;
    }
    result[key] = value;
  }
  return result;
}

function observedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sessionConfiguredServiceTier(event) {
  if (!["session.configured", "session_configured", "session-configured"].includes(event.type)) {
    return null;
  }
  const metadata = [event, event.config, event.metadata, event.session, event.session_config, event.sessionConfig, event.session_configured, event.sessionConfigured];
  for (const value of metadata) {
    const serviceTier = observedString(value?.service_tier ?? value?.serviceTier);
    if (serviceTier && SERVICE_TIER_PATTERN.test(serviceTier)) {
      return serviceTier;
    }
  }
  return null;
}

function codexHome(env) {
  const configured = observedString(env?.CODEX_HOME);
  return path.resolve(configured ?? path.join(os.homedir(), ".codex"));
}

function recentRolloutDirectories(env) {
  const sessions = path.join(codexHome(env), "sessions");
  const directories = new Set([sessions, path.join(codexHome(env), "archived_sessions")]);
  for (let offset = -2; offset <= 1; offset += 1) {
    const date = new Date(Date.now() + offset * 24 * 60 * 60 * 1000);
    directories.add(path.join(sessions, String(date.getFullYear()).padStart(4, "0"), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")));
    directories.add(path.join(sessions, String(date.getUTCFullYear()).padStart(4, "0"), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")));
  }
  return [...directories];
}

function matchingRolloutInDirectory(directory, suffix) {
  let latest = null;
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(suffix)) {
        continue;
      }
      const file = path.join(directory, entry.name);
      const stats = fs.statSync(file);
      if (!latest || stats.mtimeMs > latest.mtimeMs) {
        latest = { file, mtimeMs: stats.mtimeMs };
      }
    }
  } catch {}
  return latest;
}

function findRolloutPath(threadId, env, allowHistoricalScan = false) {
  if (!THREAD_ID_PATTERN.test(threadId)) {
    return null;
  }
  const suffix = `-${threadId}.jsonl`;
  let latest = null;
  for (const directory of recentRolloutDirectories(env)) {
    const candidate = matchingRolloutInDirectory(directory, suffix);
    if (candidate && (!latest || candidate.mtimeMs > latest.mtimeMs)) {
      latest = candidate;
    }
  }
  if (latest || !allowHistoricalScan) {
    return latest?.file ?? null;
  }
  let scanned = 0;
  for (const root of [path.join(codexHome(env), "sessions"), path.join(codexHome(env), "archived_sessions")]) {
    const stack = [root];
    while (stack.length > 0 && scanned < MAX_ROLLOUT_SCAN_ENTRIES) {
      const directory = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => right.name.localeCompare(left.name));
      } catch {
        continue;
      }
      for (const entry of entries) {
        scanned += 1;
        if (scanned > MAX_ROLLOUT_SCAN_ENTRIES) {
          break;
        }
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          stack.push(candidate);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(suffix)) {
          continue;
        }
        try {
          const stats = fs.statSync(candidate);
          if (!latest || stats.mtimeMs > latest.mtimeMs) {
            latest = { file: candidate, mtimeMs: stats.mtimeMs };
          }
        } catch {}
      }
    }
  }
  return latest?.file ?? null;
}

function readFileSlice(descriptor, start, length) {
  const buffer = Buffer.alloc(length);
  const bytesRead = fs.readSync(descriptor, buffer, 0, length, start);
  return buffer.subarray(0, bytesRead);
}

function completeJsonlLines(buffer, { dropLeading = false, dropTrailing = false } = {}) {
  let start = 0;
  let end = buffer.length;
  if (dropLeading) {
    const newline = buffer.indexOf(10);
    start = newline === -1 ? buffer.length : newline + 1;
  }
  if (dropTrailing) {
    const newline = buffer.lastIndexOf(10);
    end = newline === -1 ? 0 : newline;
  }
  return buffer.subarray(start, Math.max(start, end)).toString("utf8").split("\n").filter(Boolean);
}

function boundedObservedText(value, maxBytes) {
  const buffer = Buffer.from(String(value ?? ""));
  return (buffer.length <= maxBytes ? buffer : buffer.subarray(0, maxBytes)).toString("utf8");
}

function rolloutLines(file, options = {}) {
  const headMaxBytes = options.headMaxBytes ?? DEFAULT_ROLLOUT_HEAD_MAX_BYTES;
  const tailMaxBytes = options.tailMaxBytes ?? DEFAULT_ROLLOUT_TAIL_MAX_BYTES;
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const size = fs.fstatSync(descriptor).size;
    if (size <= headMaxBytes + tailMaxBytes) {
      return completeJsonlLines(readFileSlice(descriptor, 0, size));
    }
    const head = readFileSlice(descriptor, 0, headMaxBytes);
    const tailStart = Math.max(headMaxBytes, size - tailMaxBytes);
    const tail = readFileSlice(descriptor, tailStart, size - tailStart);
    return [
      ...completeJsonlLines(head, { dropTrailing: true }),
      ...completeJsonlLines(tail, { dropLeading: true })
    ];
  } catch {
    return [];
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

export function recoverRolloutObservation(threadId, options = {}) {
  const result = {
    collaborationTool: null,
    cumulativeTokenUsage: null,
    found: false,
    matchedTurn: false,
    partialResultText: null,
    resolvedEffort: null,
    resolvedModel: null,
    source: null
  };
  const file = options.file ?? findRolloutPath(threadId, options.env ?? process.env, options.allowHistoricalScan === true);
  if (!file) {
    return result;
  }
  result.found = true;
  result.source = "local_rollout";
  for (const line of rolloutLines(file, options)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry?.payload;
    const timestamp = Date.parse(entry?.timestamp ?? "");
    const belongsToExecution = options.notBeforeMs == null || (Number.isFinite(timestamp) && timestamp >= options.notBeforeMs - 5000);
    if (!belongsToExecution) {
      continue;
    }
    if (entry?.type === "turn_context" && payload && typeof payload === "object") {
      result.matchedTurn = true;
      result.resolvedModel = observedString(payload.model) ?? result.resolvedModel;
      result.resolvedEffort = observedString(payload.collaboration_mode?.settings?.reasoning_effort ?? payload.reasoning_effort ?? payload.model_reasoning_effort) ?? result.resolvedEffort;
    }
    if (entry?.type === "event_msg" && payload?.type === "token_count") {
      result.matchedTurn = true;
      result.cumulativeTokenUsage = normalizeCumulativeUsage(payload.info?.total_token_usage) ?? result.cumulativeTokenUsage;
    }
    if (entry?.type === "event_msg" && payload?.type === "agent_message" && typeof payload.message === "string") {
      result.matchedTurn = true;
      result.partialResultText = boundedObservedText(payload.message, options.resultMaxBytes ?? DEFAULT_RESULT_MAX_BYTES);
    }
    if (entry?.type === "response_item" && payload?.type === "message" && payload.role === "assistant" && Array.isArray(payload.content)) {
      const text = payload.content.filter((item) => item?.type === "output_text" && typeof item.text === "string").map((item) => item.text).join("");
      if (text) {
        result.matchedTurn = true;
        result.partialResultText = boundedObservedText(text, options.resultMaxBytes ?? DEFAULT_RESULT_MAX_BYTES);
      }
    }
    if (entry?.type === "response_item" && ["custom_tool_call", "function_call"].includes(payload?.type) && ["spawn_agent", "spawn_agents_on_csv"].includes(payload?.name)) {
      result.matchedTurn = true;
      result.collaborationTool = payload.name;
    }
  }
  return result;
}

function signalProcessTree(pid, signal, ownsProcessGroup) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (signal === "SIGKILL") {
      args.push("/F");
    }
    const result = spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
    return result.status === 0 || !isProcessAlive(pid);
  }
  if (ownsProcessGroup === true) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {}
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function linuxProcessState(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) {
      return null;
    }
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    return { state: fields[0] ?? null, pgrp: fields[2] ?? null };
  } catch {
    return null;
  }
}

function linuxProcessGroupHasLiveMember(pgid) {
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const info = linuxProcessState(Number(entry));
    if (info && Number(info.pgrp) === pgid && info.state !== "Z") {
      return true;
    }
  }
  return false;
}

function directProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code === "EPERM";
  }
  return process.platform !== "linux" || linuxProcessState(pid)?.state !== "Z";
}

function processGroupAlive(pid) {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  let groupSignalable;
  try {
    process.kill(-pid, 0);
    groupSignalable = true;
  } catch (error) {
    if (error?.code === "EPERM") {
      return true;
    }
    groupSignalable = false;
  }
  if (!groupSignalable || process.platform !== "linux") {
    return groupSignalable;
  }
  return linuxProcessGroupHasLiveMember(pid);
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function linuxProcessIdentity(pid) {
  let stat;
  let bootId;
  let command;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    command = fs.readFileSync(`/proc/${pid}/cmdline`);
  } catch {
    return null;
  }
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd === -1 || !bootId) {
    return null;
  }
  const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
  const startMarker = fields[19];
  if (!/^\d+$/.test(startMarker ?? "")) {
    return null;
  }
  return {
    version: 1,
    platform: "linux",
    bootMarker: bootId,
    startMarker,
    commandHash: digest(command)
  };
}

function bsdProcessIdentity(pid) {
  const env = { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" };
  const started = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env,
    timeout: 2000,
    windowsHide: true
  });
  const command = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    env,
    timeout: 2000,
    windowsHide: true
  });
  const boot = process.platform === "darwin"
    ? spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", env, timeout: 2000, windowsHide: true })
    : spawnSync("uptime", ["-s"], { encoding: "utf8", env, timeout: 2000, windowsHide: true });
  const startMarker = String(started.stdout ?? "").trim().replace(/\s+/g, " ");
  const commandValue = String(command.stdout ?? "").trim();
  const bootValue = String(boot.stdout ?? "").trim();
  if (started.status !== 0 || command.status !== 0 || boot.status !== 0 || !startMarker || !commandValue || !bootValue) {
    return null;
  }
  const darwinBoot = process.platform === "darwin" ? bootValue.match(/\bsec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)\b/) : null;
  return {
    version: 1,
    platform: process.platform,
    bootMarker: darwinBoot ? `${darwinBoot[1]}.${darwinBoot[2]}` : digest(bootValue),
    startMarker,
    commandHash: digest(commandValue)
  };
}

function validProcessIdentity(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.version === 1 &&
      typeof value.platform === "string" &&
      typeof value.bootMarker === "string" &&
      typeof value.startMarker === "string" &&
      typeof value.commandHash === "string"
  );
}

export function getProcessIdentity(pid) {
  if (!directProcessAlive(pid)) {
    return null;
  }
  if (process.platform === "linux") {
    return linuxProcessIdentity(pid);
  }
  if (process.platform === "darwin" || process.platform === "freebsd" || process.platform === "openbsd") {
    return bsdProcessIdentity(pid);
  }
  return null;
}

export function processIdentityMatches(pid, expectedIdentity) {
  if (!validProcessIdentity(expectedIdentity)) {
    return false;
  }
  return identitiesMatch(getProcessIdentity(pid), expectedIdentity);
}

export function processIdentitiesMatch(currentIdentity, expectedIdentity) {
  return identitiesMatch(currentIdentity, expectedIdentity);
}

function identitiesMatch(currentIdentity, expectedIdentity) {
  return validProcessIdentity(currentIdentity) && validProcessIdentity(expectedIdentity) && currentIdentity.version === expectedIdentity.version && currentIdentity.platform === expectedIdentity.platform && currentIdentity.bootMarker === expectedIdentity.bootMarker && currentIdentity.startMarker === expectedIdentity.startMarker && currentIdentity.commandHash === expectedIdentity.commandHash;
}

export function isProcessAlive(pid, identity = null, ownsProcessGroup = true) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  if (identity != null) {
    return processIdentityMatches(pid, identity);
  }
  if (process.platform === "win32" || !ownsProcessGroup) {
    return directProcessAlive(pid);
  }
  return directProcessAlive(pid) || processGroupAlive(pid);
}

function processTargetAlive(pid, identity, ownsProcessGroup) {
  if (identity == null) {
    return directProcessAlive(pid) || (ownsProcessGroup && processGroupAlive(pid));
  }
  const current = getProcessIdentity(pid);
  if (current) {
    return identitiesMatch(current, identity);
  }
  return directProcessAlive(pid) || (ownsProcessGroup && processGroupAlive(pid));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function settleProcessIdentity(pid, options = {}) {
  const retries = options.retries ?? 40;
  const intervalMs = options.intervalMs ?? 4;
  let previous = getProcessIdentity(pid);
  if (!previous) {
    return previous;
  }
  for (let attempt = 0; attempt < retries; attempt += 1) {
    await wait(intervalMs);
    const current = getProcessIdentity(pid);
    if (!current) {
      return current;
    }
    if (identitiesMatch(current, previous)) {
      return current;
    }
    previous = current;
  }
  return previous;
}

export async function terminateProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  const graceMs = options.graceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const interruptGraceMs = Math.ceil(graceMs / 2);
  const terminateGraceMs = graceMs - interruptGraceMs;
  const pollMs = options.pollMs ?? DEFAULT_TERMINATION_POLL_MS;
  const identity = options.identity ?? null;
  const ownsProcessGroup = options.ownsProcessGroup === true;
  const allowOrphanedGroup = options.allowOrphanedGroup === true;
  const directAlive = directProcessAlive(pid);
  const groupAlive = ownsProcessGroup && processGroupAlive(pid);
  const currentIdentity = identity == null ? null : getProcessIdentity(pid);
  if (identity != null && currentIdentity && !identitiesMatch(currentIdentity, identity)) {
    return false;
  }
  if (identity != null && !currentIdentity && !directAlive && !groupAlive) {
    return true;
  }
  const verifiedLeader = identity != null && identitiesMatch(currentIdentity, identity);
  const verifiedOrphanGroup = identity != null && ownsProcessGroup && allowOrphanedGroup && !directAlive && groupAlive;
  if ((options.requireIdentity === true || identity != null) && !verifiedLeader && !verifiedOrphanGroup) {
    return false;
  }
  if (verifiedOrphanGroup) {
    try {
      process.kill(-pid, "SIGINT");
    } catch {
      return false;
    }
  } else {
    signalProcessTree(pid, "SIGINT", ownsProcessGroup);
  }
  let deadline = Date.now() + interruptGraceMs;
  const stillAlive = () => processTargetAlive(pid, identity, ownsProcessGroup);
  while (Date.now() < deadline && stillAlive()) {
    await wait(pollMs);
  }
  if (stillAlive()) {
    const current = getProcessIdentity(pid);
    if (!identity || (current && processIdentityMatches(pid, identity))) {
      signalProcessTree(pid, "SIGTERM", ownsProcessGroup);
    } else if (ownsProcessGroup && !current && !directProcessAlive(pid) && processGroupAlive(pid)) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {}
    } else {
      return false;
    }
    deadline = Date.now() + terminateGraceMs;
    while (Date.now() < deadline && stillAlive()) {
      await wait(pollMs);
    }
  }
  if (stillAlive()) {
    const current = getProcessIdentity(pid);
    if (!identity || (current && processIdentityMatches(pid, identity))) {
      signalProcessTree(pid, "SIGKILL", ownsProcessGroup);
    } else if (ownsProcessGroup && !current && !directProcessAlive(pid) && processGroupAlive(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    } else {
      return false;
    }
    deadline = Date.now() + graceMs;
    while (Date.now() < deadline && stillAlive()) {
      await wait(pollMs);
    }
  }
  return !stillAlive();
}

export function terminateProcessTreeSync(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  const graceMs = options.graceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const interruptGraceMs = Math.ceil(graceMs / 2);
  const terminateGraceMs = graceMs - interruptGraceMs;
  const pollMs = options.pollMs ?? DEFAULT_TERMINATION_POLL_MS;
  const identity = options.identity ?? null;
  const ownsProcessGroup = options.ownsProcessGroup === true;
  const allowOrphanedGroup = options.allowOrphanedGroup === true;
  const directAlive = directProcessAlive(pid);
  const groupAlive = ownsProcessGroup && processGroupAlive(pid);
  const currentIdentity = identity == null ? null : getProcessIdentity(pid);
  if (identity != null && currentIdentity && !identitiesMatch(currentIdentity, identity)) {
    return false;
  }
  if (identity != null && !currentIdentity && !directAlive && !groupAlive) {
    return true;
  }
  const verifiedLeader = identity != null && identitiesMatch(currentIdentity, identity);
  const verifiedOrphanGroup = identity != null && ownsProcessGroup && allowOrphanedGroup && !directAlive && groupAlive;
  if ((options.requireIdentity === true || identity != null) && !verifiedLeader && !verifiedOrphanGroup) {
    return false;
  }
  if (verifiedOrphanGroup) {
    try {
      process.kill(-pid, "SIGINT");
    } catch {
      return false;
    }
  } else {
    signalProcessTree(pid, "SIGINT", ownsProcessGroup);
  }
  let deadline = Date.now() + interruptGraceMs;
  const stillAlive = () => processTargetAlive(pid, identity, ownsProcessGroup);
  while (Date.now() < deadline && stillAlive()) {
    waitSync(pollMs);
  }
  if (stillAlive()) {
    const current = getProcessIdentity(pid);
    if (!identity || (current && processIdentityMatches(pid, identity))) {
      signalProcessTree(pid, "SIGTERM", ownsProcessGroup);
    } else if (ownsProcessGroup && !current && !directProcessAlive(pid) && processGroupAlive(pid)) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {}
    } else {
      return false;
    }
    deadline = Date.now() + terminateGraceMs;
    while (Date.now() < deadline && stillAlive()) {
      waitSync(pollMs);
    }
  }
  if (stillAlive()) {
    const current = getProcessIdentity(pid);
    if (!identity || (current && processIdentityMatches(pid, identity))) {
      signalProcessTree(pid, "SIGKILL", ownsProcessGroup);
    } else if (ownsProcessGroup && !current && !directProcessAlive(pid) && processGroupAlive(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    } else {
      return false;
    }
    deadline = Date.now() + graceMs;
    while (Date.now() < deadline && stillAlive()) {
      waitSync(pollMs);
    }
  }
  return !stillAlive();
}

function boundedBuffer(current, chunk, maxBytes) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  return combined.length <= maxBytes ? combined : combined.subarray(combined.length - maxBytes);
}

function boundedMessage(message) {
  const buffer = Buffer.from(String(message ?? ""));
  return (buffer.length <= MAX_DIAGNOSTIC_MESSAGE_BYTES ? buffer : buffer.subarray(0, MAX_DIAGNOSTIC_MESSAGE_BYTES)).toString("utf8");
}

function resourceError(message) {
  const error = new Error(message);
  error.failureKind = "resource";
  return error;
}

function safeDiagnosticMessage(message) {
  const redacted = String(message ?? "")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{20,}\b/g, "[redacted]")
    .replace(/\bxai-[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\bBearer\s+\S{20,}/gi, "Bearer [redacted]")
    .replace(/((?:OPENAI_API_KEY|CODEX_API_KEY|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(["']?(?:api_key|access_token|refresh_token|authorization)["']?\s*:\s*["'])[^"']+/gi, "$1[redacted]");
  return boundedMessage(redacted);
}

function signalExitCode(signal) {
  const number = signal ? os.constants.signals[signal] : null;
  return Number.isInteger(number) ? 128 + number : 1;
}

function outputPaths(options) {
  const paths = [options.eventsFile, options.logFile].filter((value) => typeof value === "string" && value);
  for (const file of paths) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
    fs.chmodSync(path.dirname(file), PRIVATE_DIR_MODE);
  }
  if (options.logFile) {
    fs.writeFileSync(options.logFile, Buffer.alloc(0), { mode: PRIVATE_FILE_MODE });
    fs.chmodSync(options.logFile, PRIVATE_FILE_MODE);
  }
}

function checkpointState(state, event = null) {
  return {
    appliedServiceTier: state.appliedServiceTier,
    collaborationViolation: state.collaborationViolation,
    event,
    eventCount: state.eventCount,
    threadId: state.threadId,
    turnStarted: state.turnStarted,
    terminalEvent: state.terminalEvent?.type ?? null,
    finalResponse: state.finalResponse,
    cumulativeTokenUsage: state.cumulativeTokenUsage,
    protocolError: state.protocolError
  };
}

function classifyDiagnostic(state, event) {
  let diagnostic = null;
  if (event.type === "error") {
    diagnostic = { type: "error", message: event.message };
  } else if (event.type === "item.completed" && event.item?.type === "error") {
    diagnostic = { type: "item.error", message: event.item.message };
  }
  if (!diagnostic || typeof diagnostic.message !== "string") {
    return;
  }
  state.diagnostics.push({ ...diagnostic, message: safeDiagnosticMessage(diagnostic.message) });
  if (state.diagnostics.length > MAX_DIAGNOSTICS) {
    state.diagnostics.splice(0, state.diagnostics.length - MAX_DIAGNOSTICS);
  }
}

function recordProtocolError(state, message) {
  if (!state.protocolError) {
    state.protocolError = boundedMessage(message);
  }
}

function recordResourceError(state, message) {
  if (!state.resourceError) {
    state.resourceError = boundedMessage(message);
  }
}

function validateEvent(state, event) {
  if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string" || !event.type) {
    recordProtocolError(state, "Codex emitted a JSONL value without a valid event type.");
    return;
  }
  state.eventCount += 1;
  classifyDiagnostic(state, event);
  switch (event.type) {
    case "session.configured":
    case "session_configured":
    case "session-configured":
      state.appliedServiceTier = sessionConfiguredServiceTier(event) ?? state.appliedServiceTier;
      break;
    case "thread.started": {
      if (state.threadStarted || state.turnStarted || state.terminalEvent) {
        recordProtocolError(state, "Codex emitted thread.started outside the initial lifecycle position.");
      }
      if (typeof event.thread_id !== "string" || !event.thread_id.trim()) {
        recordProtocolError(state, "Codex thread.started omitted thread_id.");
        break;
      }
      state.threadStarted = true;
      state.threadId = event.thread_id;
      if (state.expectedResumeThreadId && event.thread_id !== state.expectedResumeThreadId) {
        state.resumeThreadMismatch = true;
        recordProtocolError(state, `Codex resumed thread ${event.thread_id} instead of the requested thread ${state.expectedResumeThreadId}.`);
      }
      break;
    }
    case "turn.started":
      if (!state.threadStarted || state.turnStarted || state.terminalEvent) {
        recordProtocolError(state, "Codex emitted turn.started outside the required lifecycle sequence.");
      }
      state.turnStarted = true;
      break;
    case "turn.completed": {
      const duplicateTerminal = Boolean(state.terminalEvent);
      if (!state.threadStarted || !state.turnStarted || duplicateTerminal) {
        recordProtocolError(state, "Codex emitted turn.completed outside the required lifecycle sequence.");
      }
      const usage = normalizeCumulativeUsage(event.usage);
      if (!usage) {
        recordProtocolError(state, "Codex turn.completed contained invalid cumulative usage.");
      }
      if (!duplicateTerminal) {
        state.cumulativeTokenUsage = usage?.totalTokens === 0 ? null : usage;
        state.cumulativeUsageUnavailableReason = usage?.totalTokens === 0 ? "upstream_zero_usage" : null;
        state.terminalEvent = event;
      }
      break;
    }
    case "turn.failed": {
      const duplicateTerminal = Boolean(state.terminalEvent);
      if (!state.threadStarted || !state.turnStarted || duplicateTerminal) {
        recordProtocolError(state, "Codex emitted turn.failed outside the required lifecycle sequence.");
      }
      if (typeof event.error?.message !== "string" || !event.error.message.trim()) {
        recordProtocolError(state, "Codex turn.failed omitted error.message.");
      }
      if (!duplicateTerminal) {
        state.terminalEvent = event;
        state.turnFailureMessage = typeof event.error?.message === "string" ? event.error.message : null;
      }
      break;
    }
    case "item.started":
    case "item.updated":
    case "item.completed":
      if ((!state.turnStarted && !(state.threadStarted && event.type === "item.completed" && event.item?.type === "error")) || state.terminalEvent) {
        recordProtocolError(state, `Codex emitted ${event.type} outside an active turn.`);
      }
      if (!event.item || typeof event.item !== "object" || Array.isArray(event.item) || typeof event.item.type !== "string") {
        recordProtocolError(state, `Codex ${event.type} contained an invalid item.`);
        break;
      }
      if (event.item.type === "collab_tool_call") {
        const tool = observedString(event.item.tool) ?? "unknown collaboration tool";
        state.collaborationViolation = `Delegated Codex execution attempted the disabled ${tool} tool.`;
      }
      if (event.type === "item.completed" && event.item.type === "agent_message" && typeof event.item.text === "string") {
        if (Buffer.byteLength(event.item.text) > state.resultMaxBytes) {
          recordResourceError(state, `Codex final response exceeded the ${state.resultMaxBytes} byte limit.`);
        } else {
          state.finalResponse = event.item.text;
          state.resultSource = "agent_message";
        }
      }
      break;
    case "error":
      if (typeof event.message !== "string") {
        recordProtocolError(state, "Codex error event omitted message.");
      }
      break;
    default:
      state.unknownEventCount += 1;
      break;
  }
}

function usageOutcome(state, options) {
  if (state.resumeThreadMismatch) {
    return { tokenUsage: null, tokenUsageAvailability: "unavailable", tokenUsageUnavailableReason: "resume_thread_mismatch" };
  }
  if (!state.cumulativeTokenUsage) {
    return { tokenUsage: null, tokenUsageAvailability: "unavailable", tokenUsageUnavailableReason: state.cumulativeUsageUnavailableReason ?? "missing_cumulative_usage" };
  }
  const baselineValue = options.cumulativeUsageBaseline ?? options.cumulativeTokenUsageBaseline ?? options.usageBaseline;
  const args = options.args ?? [];
  const resumed = options.resumeThreadId != null || args.includes("resume");
  if (resumed) {
    return { tokenUsage: null, tokenUsageAvailability: "unavailable", tokenUsageUnavailableReason: "resume_continuity_unverifiable" };
  }
  const freshThread = options.freshThread ?? !resumed;
  const baseline = baselineValue == null ? (freshThread ? ZERO_USAGE : null) : normalizeCumulativeUsage(baselineValue);
  if (!baseline) {
    return {
      tokenUsage: null,
      tokenUsageAvailability: "unavailable",
      tokenUsageUnavailableReason: baselineValue == null ? "resume_baseline_unavailable" : "invalid_cumulative_baseline"
    };
  }
  const tokenUsage = subtractUsage(state.cumulativeTokenUsage, baseline);
  if (!tokenUsage) {
    return { tokenUsage: null, tokenUsageAvailability: "unavailable", tokenUsageUnavailableReason: "invalid_cumulative_delta" };
  }
  return { tokenUsage, tokenUsageAvailability: "available", tokenUsageUnavailableReason: null };
}

function classifiedFailureKind(message, fallback = "error") {
  const text = String(message ?? "");
  if (/quota|insufficient (?:account )?(?:balance|credit|credits|funds)|balance (?:is )?exhausted|payment required|usage limit|billing|http(?:\/\d(?:\.\d)?)?\s+402|status(?: code)?\s*[:=]?\s*402/i.test(text)) {
    return "quota";
  }
  if (/rate[ _-]?limit|too many requests|http(?:\/\d(?:\.\d)?)?\s+429|status(?: code)?\s*[:=]?\s*429/i.test(text)) {
    return "rate_limited";
  }
  if (/unauthori[sz]ed|unauthenticated|authentication|login required|invalid api key|api key/i.test(text)) {
    return "auth";
  }
  if (/permission denied|operation not permitted|approval (?:required|denied)|sandbox (?:denied|violation)/i.test(text)) {
    return "permission";
  }
  return fallback;
}

function withTrustedDirectoryRemedy(message, stderrTail) {
  if (!/Not inside a trusted directory and --skip-git-repo-check was not specified\./i.test(stderrTail)) {
    return message;
  }
  return `${message} Re-run the task with --skip-git-repo-check to allow execution outside a Git repository.`;
}

function failureOutcome(state, processOutcome, stderrTail) {
  if (state.callbackError) {
    return { status: "error", failureKind: "error", errorMessage: state.callbackError.message };
  }
  if (processOutcome.spawnError) {
    return {
      status: "error",
      failureKind: processOutcome.spawnError.code === "ENOENT" ? "missing_cli" : processOutcome.spawnError.code === "EACCES" ? "permission" : "error",
      errorMessage: processOutcome.spawnError.message
    };
  }
  if (state.collaborationViolation) {
    return { status: "error", failureKind: "policy", errorMessage: state.collaborationViolation };
  }
  if (state.cancelled) {
    return { status: "cancelled", failureKind: "cancelled", errorMessage: "Codex execution was cancelled." };
  }
  if (state.stdinError) {
    return { status: "error", failureKind: "process", errorMessage: `Codex closed stdin before accepting the complete prompt: ${state.stdinError.message}` };
  }
  if (state.resourceError) {
    return { status: "error", failureKind: "resource", errorMessage: state.resourceError };
  }
  if (state.protocolError) {
    return { status: "error", failureKind: "protocol", errorMessage: state.protocolError };
  }
  if (state.terminalEvent?.type === "turn.failed") {
    const errorMessage = state.turnFailureMessage || "Codex turn failed.";
    return { status: "error", failureKind: classifiedFailureKind(`${errorMessage}\n${stderrTail}`), errorMessage };
  }
  if (processOutcome.exitCode !== 0 || processOutcome.signal) {
    const processMessage = processOutcome.signal
      ? `Codex exited with signal ${processOutcome.signal}.`
      : `Codex exited with code ${processOutcome.exitCode}.`;
    const diagnosticMessage = state.turnFailureMessage || state.diagnostics.at(-1)?.message || null;
    const failureKind = classifiedFailureKind(`${diagnosticMessage ?? ""}\n${stderrTail}`, "process");
    return {
      status: "error",
      failureKind,
      errorMessage: withTrustedDirectoryRemedy(failureKind === "process" || !diagnosticMessage ? processMessage : diagnosticMessage, stderrTail)
    };
  }
  return { status: "done", failureKind: null, errorMessage: null };
}

function timeoutOutcome(state) {
  return {
    status: state.cleanupComplete ? "error" : "running",
    failureKind: "timeout",
    errorMessage: `Codex timed out after ${state.timeoutMs}ms.`
  };
}

export async function runCodex(options = {}) {
  const executionStartedAtMs = Date.now();
  const env = options.env ?? process.env;
  const bin = resolveCodexBin({ ...options, env });
  const args = [...(options.args ?? buildTaskArgs(options))];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stderrMaxBytes = options.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES;
  const eventsMaxBytes = options.eventsMaxBytes ?? DEFAULT_EVENTS_MAX_BYTES;
  const eventLineMaxBytes = options.eventLineMaxBytes ?? DEFAULT_EVENT_LINE_MAX_BYTES;
  const promptMaxBytes = options.promptMaxBytes ?? DEFAULT_PROMPT_MAX_BYTES;
  const resultMaxBytes = options.resultMaxBytes ?? DEFAULT_RESULT_MAX_BYTES;
  const prompt = String(options.prompt ?? "");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be greater than zero.");
  }
  if (!Number.isSafeInteger(stderrMaxBytes) || stderrMaxBytes <= 0) {
    throw new TypeError("stderrMaxBytes must be a positive integer.");
  }
  if (!Number.isSafeInteger(eventsMaxBytes) || eventsMaxBytes <= 0) {
    throw new TypeError("eventsMaxBytes must be a positive integer.");
  }
  if (!Number.isSafeInteger(eventLineMaxBytes) || eventLineMaxBytes <= 0) {
    throw new TypeError("eventLineMaxBytes must be a positive integer.");
  }
  if (!Number.isSafeInteger(promptMaxBytes) || promptMaxBytes <= 0) {
    throw new TypeError("promptMaxBytes must be a positive integer.");
  }
  if (!Number.isSafeInteger(resultMaxBytes) || resultMaxBytes <= 0) {
    throw new TypeError("resultMaxBytes must be a positive integer.");
  }
  if (Buffer.byteLength(prompt) > promptMaxBytes) {
    throw resourceError(`Codex prompt exceeded the ${promptMaxBytes} byte limit.`);
  }
  outputPaths(options);
  const eventsFd = options.eventsFile ? fs.openSync(options.eventsFile, "w", PRIVATE_FILE_MODE) : null;
  if (options.eventsFile) {
    fs.chmodSync(options.eventsFile, PRIVATE_FILE_MODE);
  }
  const state = {
    appliedServiceTier: null,
    callbackError: null,
    cancelled: false,
    cleanupComplete: true,
    collaborationViolation: null,
    cumulativeTokenUsage: null,
    cumulativeUsageUnavailableReason: null,
    diagnostics: [],
    eventCount: 0,
    eventsTruncated: false,
    expectedResumeThreadId: typeof options.resumeThreadId === "string" && options.resumeThreadId.trim() ? options.resumeThreadId.trim() : null,
    finalResponse: "",
    protocolError: null,
    resourceError: null,
    resumeThreadMismatch: false,
    resultSource: null,
    resultMaxBytes,
    resolvedEffort: null,
    resolvedModel: null,
    rolloutRecoveryStatus: "not_attempted",
    terminalEvent: null,
    threadId: null,
    threadStarted: false,
    stdinError: null,
    timedOut: false,
    timeoutMs,
    turnFailureMessage: null,
    turnStarted: false,
    unknownEventCount: 0
  };
  let stderr = Buffer.alloc(0);
  let eventsBytes = 0;
  let spawnError = null;
  let terminationPromise = null;
  let closeResolved = false;
  let resolveForcedClose;
  const forcedClosePromise = new Promise((resolve) => {
    resolveForcedClose = resolve;
  });
  const forwardedSignals = process.platform === "win32" ? ["SIGTERM", "SIGINT"] : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];
  let child;
  let childIdentity = null;
  let requestTermination = () => Promise.resolve(false);
  const forwardTermination = () => {
    state.cancelled = true;
    void requestTermination();
  };
  for (const signal of forwardedSignals) {
    process.on(signal, forwardTermination);
  }
  try {
    child = spawn(bin, args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true
    });
  } catch (error) {
    for (const signal of forwardedSignals) {
      process.removeListener(signal, forwardTermination);
    }
    if (eventsFd != null) {
      fs.closeSync(eventsFd);
    }
    throw error;
  }
  requestTermination = () => {
    if (!terminationPromise) {
      terminationPromise = terminateProcessTree(child.pid, {
        allowOrphanedGroup: true,
        graceMs: options.terminationGraceMs,
        pollMs: options.terminationPollMs,
        identity: childIdentity ?? undefined,
        ownsProcessGroup: process.platform !== "win32",
        requireIdentity: Boolean(childIdentity)
      }).then((terminated) => {
        state.cleanupComplete = terminated;
        setTimeout(() => {
          if (!closeResolved) {
            state.cleanupComplete = false;
            child.stdin?.destroy();
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();
            resolveForcedClose({ code: null, exitCode: null, forced: true, signal: null });
          }
        }, FORCED_CLOSE_MS);
        return terminated;
      });
    }
    return terminationPromise;
  };
  try {
    options.onSpawnAttempt?.(child.pid ?? null);
  } catch (error) {
    state.callbackError = error instanceof Error ? error : new Error(String(error));
    void requestTermination();
  }
  childIdentity = Number.isInteger(child.pid) ? getProcessIdentity(child.pid) : null;
  if (Number.isInteger(child.pid) && !childIdentity) {
    state.callbackError = new Error("Codex process identity could not be verified.");
    void requestTermination();
  } else if (state.cancelled) {
    void requestTermination();
  }
  const identitySettlePromise = childIdentity
    ? settleProcessIdentity(child.pid).then(async (settled) => {
        if (settled) {
          childIdentity = settled;
        }
        try {
          await options.onIdentitySettled?.(child.pid ?? null, childIdentity);
        } catch (error) {
          state.callbackError = error instanceof Error ? error : new Error(String(error));
          void requestTermination();
        }
      })
    : Promise.resolve();
  child.once("error", (error) => {
    spawnError = error;
  });
  const closePromise = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      closeResolved = true;
      resolve({
        code,
        exitCode: Number.isInteger(code) ? code : signalExitCode(signal),
        signal
      });
    });
  });
  const stdinSettled = new Promise((resolve) => {
    if (!child.stdin) {
      if (prompt) {
        state.stdinError = new Error("Codex process did not expose stdin.");
        void requestTermination();
      }
      resolve();
      return;
    }
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    child.stdin.once("error", (error) => {
      if (prompt) {
        state.stdinError = error;
        void requestTermination();
      }
      settle();
    });
    child.stdin.once("close", settle);
    child.stdin.end(prompt);
  });
  const timer = setTimeout(() => {
    state.timedOut = true;
    void requestTermination();
  }, timeoutMs);
  timer.unref?.();
  child.stderr?.on("data", (chunk) => {
    stderr = boundedBuffer(stderr, chunk, stderrMaxBytes);
    if (options.logFile) {
      try {
        fs.writeFileSync(options.logFile, stderr);
        fs.chmodSync(options.logFile, PRIVATE_FILE_MODE);
      } catch (error) {
        state.callbackError = error instanceof Error ? error : new Error(String(error));
        void requestTermination();
      }
    }
  });
  const spawnCheckpointPromise = (async () => {
    try {
      if (childIdentity) {
        await options.onSpawn?.(child.pid ?? null, childIdentity);
      }
    } catch (error) {
      state.callbackError = error instanceof Error ? error : new Error(String(error));
      void requestTermination();
    }
  })();
  const abort = () => {
    state.cancelled = true;
    void requestTermination();
  };
  if (options.signal?.aborted) {
    abort();
  } else {
    options.signal?.addEventListener("abort", abort, { once: true });
  }
  const processLine = async (lineBuffer) => {
    const line = (lineBuffer.at(-1) === 13 ? lineBuffer.subarray(0, -1) : lineBuffer).toString("utf8");
    if (eventsFd != null && !state.eventsTruncated) {
      const rawLine = Buffer.concat([lineBuffer, Buffer.from("\n")]);
      if (eventsBytes + rawLine.length <= eventsMaxBytes) {
        try {
          fs.writeSync(eventsFd, rawLine);
          eventsBytes += rawLine.length;
        } catch (error) {
          state.callbackError = error instanceof Error ? error : new Error(String(error));
          void requestTermination();
        }
      } else {
        state.eventsTruncated = true;
      }
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      recordProtocolError(state, `Codex emitted malformed JSONL at event ${state.eventCount + 1}.`);
      void requestTermination();
      try {
        await options.onCheckpoint?.(checkpointState(state));
      } catch (error) {
        state.callbackError = error instanceof Error ? error : new Error(String(error));
      }
      return;
    }
    validateEvent(state, event);
    if (state.protocolError || state.resourceError || state.collaborationViolation) {
      void requestTermination();
    }
    try {
      await options.onCheckpoint?.(checkpointState(state, event));
    } catch (error) {
      state.callbackError = error instanceof Error ? error : new Error(String(error));
      void requestTermination();
    }
  };
  const parsePromise = (async () => {
    if (!child.stdout) {
      recordProtocolError(state, "Codex process did not expose stdout.");
      void requestTermination();
      return;
    }
    await spawnCheckpointPromise;
    let segments = [];
    let segmentBytes = 0;
    try {
      for await (const rawChunk of child.stdout) {
        const chunk = Buffer.from(rawChunk);
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset);
          const end = newline === -1 ? chunk.length : newline;
          const segment = chunk.subarray(offset, end);
          if (segmentBytes + segment.length > eventLineMaxBytes) {
            recordResourceError(state, `Codex emitted a JSONL event larger than the ${eventLineMaxBytes} byte limit.`);
            void requestTermination();
            child.stdout.destroy();
            return;
          }
          if (segment.length > 0) {
            segments.push(segment);
            segmentBytes += segment.length;
          }
          if (newline === -1) {
            break;
          }
          await processLine(Buffer.concat(segments, segmentBytes));
          segments = [];
          segmentBytes = 0;
          offset = newline + 1;
        }
      }
    } catch (error) {
      if (state.cleanupComplete || error?.code !== "ERR_STREAM_PREMATURE_CLOSE") {
        state.callbackError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (segmentBytes > 0) {
      await processLine(Buffer.concat(segments, segmentBytes));
    }
  })();
  const processOutcome = await Promise.race([closePromise, forcedClosePromise]);
  if (!terminationPromise && childIdentity && process.platform !== "win32" && !directProcessAlive(child.pid) && processGroupAlive(child.pid)) {
    void requestTermination();
  }
  try {
    await stdinSettled;
    await parsePromise;
    await identitySettlePromise;
    if (terminationPromise) {
      await terminationPromise;
    }
  } finally {
    clearTimeout(timer);
    for (const signal of forwardedSignals) {
      process.removeListener(signal, forwardTermination);
    }
    options.signal?.removeEventListener("abort", abort);
  }
  if (eventsFd != null) {
    fs.closeSync(eventsFd);
  }
  if (!state.timedOut && !state.cancelled && !spawnError && !state.callbackError && processOutcome.exitCode === 0 && !processOutcome.signal) {
    if (!state.threadStarted) {
      recordProtocolError(state, "Codex exited without thread.started.");
    } else if (!state.turnStarted) {
      recordProtocolError(state, "Codex exited without turn.started.");
    } else if (!state.terminalEvent) {
      recordProtocolError(state, "Codex reached EOF without a terminal turn event.");
    }
  }
  if (state.threadId) {
    const recovered = recoverRolloutObservation(state.threadId, {
      allowHistoricalScan: options.resumeThreadId != null,
      env,
      notBeforeMs: executionStartedAtMs,
      resultMaxBytes
    });
    state.rolloutRecoveryStatus = recovered.matchedTurn ? "recovered" : recovered.found ? "stale" : "not_found";
    state.resolvedModel = recovered.resolvedModel;
    state.resolvedEffort = recovered.resolvedEffort;
    if (recovered.cumulativeTokenUsage && (!state.cumulativeTokenUsage || state.timedOut || state.cancelled)) {
      state.cumulativeTokenUsage = recovered.cumulativeTokenUsage;
      state.cumulativeUsageUnavailableReason = null;
    }
    if (!state.finalResponse && (state.timedOut || state.cancelled) && recovered.partialResultText) {
      state.finalResponse = recovered.partialResultText;
      state.resultSource = "rollout_partial";
    }
    if (!state.collaborationViolation && recovered.collaborationTool) {
      state.collaborationViolation = `Delegated Codex execution attempted the disabled ${recovered.collaborationTool} tool.`;
    }
  }
  const usage = usageOutcome(state, { ...options, args });
  if ((state.timedOut || state.cancelled) && usage.tokenUsage) {
    usage.tokenUsageAvailability = "partial";
    usage.tokenUsageUnavailableReason = null;
  }
  const stderrTail = stderr.toString("utf8");
  const failure = state.timedOut
    ? timeoutOutcome(state)
    : failureOutcome(state, { ...processOutcome, spawnError }, stderrTail);
  const rawErrorMessage = failure.errorMessage;
  const errorMessage = rawErrorMessage == null ? null : safeDiagnosticMessage(rawErrorMessage);
  return {
    status: failure.status,
    success: failure.status === "done",
    failureKind: failure.failureKind,
    errorMessage,
    pid: child.pid ?? null,
    pidIdentity: childIdentity,
    ownsProcessGroup: process.platform !== "win32",
    exitCode: processOutcome.exitCode,
    processCode: processOutcome.code,
    signal: processOutcome.signal,
    timedOut: state.timedOut,
    cancelled: state.cancelled,
    cleanupComplete: state.cleanupComplete,
    collaborationViolation: state.collaborationViolation,
    threadId: state.threadId,
    terminalEvent: state.terminalEvent?.type ?? null,
    finalResponse: state.finalResponse,
    partialResultText: state.timedOut || state.cancelled ? state.finalResponse || null : null,
    resultSource: state.resultSource,
    cumulativeTokenUsage: state.cumulativeTokenUsage,
    appliedServiceTier: state.appliedServiceTier,
    resolvedEffort: state.resolvedEffort,
    resolvedModel: state.resolvedModel,
    rolloutRecoveryStatus: state.rolloutRecoveryStatus,
    semanticStatus: state.collaborationViolation ? "rejected" : "unverified",
    usageIsIncomplete: state.timedOut || state.cancelled || state.terminalEvent?.type !== "turn.completed",
    ...usage,
    eventCount: state.eventCount,
    eventsTruncated: state.eventsTruncated,
    unknownEventCount: state.unknownEventCount,
    diagnostics: state.diagnostics,
    protocolError: state.protocolError,
    resourceError: state.resourceError,
    stderrTail: safeDiagnosticMessage(stderrTail),
    spawnError
  };
}
