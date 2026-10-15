import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getProcessIdentity,
  isProcessAlive,
  processGroupAlive,
  processIdentitiesMatch as identitiesMatch,
  processIdentityMatches,
  processIsDirectlyAlive as directProcessAlive
} from "./process-identity.mjs";

import { applyRolloutRecovery } from "./codex-rollout.mjs";
import { resourceError, outputPaths } from "./codex-events.mjs";
import { usageOutcome, timeoutOutcome, buildRunOutcome } from "./codex-outcome.mjs";
import { superviseCodex } from "./codex-run-supervisor.mjs";

export { normalizeCumulativeUsage, subtractUsage } from "./codex-usage.mjs";
export { getProcessIdentity, isProcessAlive, processIdentitiesMatch, processIdentityMatches } from "./process-identity.mjs";

export const DEFAULT_TIMEOUT_MS = 570000;
export const DEFAULT_TERMINATION_GRACE_MS = 2000;
export const DEFAULT_TERMINATION_POLL_MS = 25;
export const BASH_TOOL_TIMEOUT_MS = 600000;
export const TIMEOUT_PATH_MARGIN_MS = 15000;
export const FORCED_CLOSE_MS = 2000;
const POST_CLOSE_DRAIN_MS = 10000;
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
const EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const SERVICE_TIER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const WEB_SEARCH_MODES = new Set(["disabled", "cached", "live"]);
const PRIVATE_FILE_MODE = 0o600;
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
  const write = options.write === true;
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
  const configuredServiceTier = Object.hasOwn(options, "serviceTier") ? options.serviceTier : "priority";
  const serviceTier = configuredServiceTier === "none" ? null : configuredServiceTier;
  if (serviceTier != null) {
    if (typeof serviceTier !== "string" || !SERVICE_TIER_PATTERN.test(serviceTier)) {
      throw new TypeError(`Unsupported Codex service tier: ${serviceTier}`);
    }
    args.push("-c", `service_tier=${serviceTier}`);
  }
  const effort = options.effort;
  if (effort != null) {
    if (typeof effort !== "string" || !EFFORT_PATTERN.test(effort)) {
      throw new TypeError(`Unsupported Codex reasoning effort: ${effort}`);
    }
    args.push("--config", `model_reasoning_effort=${JSON.stringify(effort)}`);
  }
  let webSearchMode = "disabled";
  if (Object.hasOwn(options, "webSearchMode")) {
    webSearchMode = options.webSearchMode;
  } else if (Object.hasOwn(options, "web")) {
    webSearchMode = options.web ? "live" : "disabled";
  }
  if (!WEB_SEARCH_MODES.has(webSearchMode)) {
    throw new TypeError(`Unsupported Codex web search mode: ${webSearchMode}`);
  }
  args.push("--config", `web_search=${JSON.stringify(webSearchMode)}`);
  const network = Object.hasOwn(options, "network") ? options.network : false;
  if (typeof network !== "boolean") {
    throw new TypeError("network must be a boolean.");
  }
  if (network && sandbox !== "workspace-write") {
    throw new TypeError("Codex sandbox network access requires a write task.");
  }
  if (sandbox === "workspace-write") {
    args.push("--config", `sandbox_workspace_write.network_access=${network}`);
  }
  const cwd = options.cwd;
  if (cwd != null) {
    args.push("--cd", nonemptyString(cwd, "cwd"));
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
    "multi_agent_v2",
    "--disable",
    "sleep_tool",
    "--disable",
    "memories",
    "--disable",
    "goals",
    "--disable",
    "computer_use",
    "--disable",
    "browser_use",
    "--disable",
    "browser_use_external",
    "--disable",
    "in_app_browser",
    "--disable",
    "image_generation",
    "--disable",
    "apps",
    "--disable",
    "plugins",
    "--disable",
    "remote_plugin",
    "--config",
    "agents.enabled=false"
  ];
  appendExplicitSettings(args, options, sandbox);
  return args;
}

export function buildTaskArgs(options = {}) {
  const args = baseExecArgs(sandboxForTask(options), options);
  const threadId = options.resumeThreadId;
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
  if (options.write === true || options.sandboxMode === "workspace-write" || options.sandboxMode === "danger-full-access") {
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
  while (Date.now() < deadline && processTargetAlive(pid, identity, ownsProcessGroup)) {
    await wait(pollMs);
  }
  if (processTargetAlive(pid, identity, ownsProcessGroup)) {
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
    while (Date.now() < deadline && processTargetAlive(pid, identity, ownsProcessGroup)) {
      await wait(pollMs);
    }
  }
  if (processTargetAlive(pid, identity, ownsProcessGroup)) {
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
    while (Date.now() < deadline && processTargetAlive(pid, identity, ownsProcessGroup)) {
      await wait(pollMs);
    }
  }
  return !processTargetAlive(pid, identity, ownsProcessGroup);
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
  while (Date.now() < deadline && processTargetAlive(pid, identity, ownsProcessGroup)) {
    waitSync(pollMs);
  }
  if (processTargetAlive(pid, identity, ownsProcessGroup)) {
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
    while (Date.now() < deadline && processTargetAlive(pid, identity, ownsProcessGroup)) {
      waitSync(pollMs);
    }
  }
  if (processTargetAlive(pid, identity, ownsProcessGroup)) {
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
    while (Date.now() < deadline && processTargetAlive(pid, identity, ownsProcessGroup)) {
      waitSync(pollMs);
    }
  }
  return !processTargetAlive(pid, identity, ownsProcessGroup);
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
  if (options.deadlineMs != null && !Number.isFinite(options.deadlineMs)) {
    throw new TypeError("deadlineMs must be an absolute time in epoch milliseconds.");
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
  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const terminationPollMs = options.terminationPollMs ?? DEFAULT_TERMINATION_POLL_MS;
  const fullTerminationReserveMs = terminationGraceMs * 2 + terminationPollMs * 3 + FORCED_CLOSE_MS + POST_CLOSE_DRAIN_MS;
  const terminationReserveMs = Math.min(fullTerminationReserveMs, timeoutMs / 10);
  const executionTimeoutMs = options.deadlineMs == null
    ? timeoutMs
    : Math.min(timeoutMs, options.deadlineMs - Date.now() - terminationReserveMs);
  if (executionTimeoutMs <= 0) {
    const failure = timeoutOutcome({ cleanupComplete: true, timeoutMs: 0 });
    return {
      ...failure,
      success: false,
      pid: null,
      pidIdentity: null,
      ownsProcessGroup: false,
      exitCode: null,
      processCode: null,
      signal: null,
      timedOut: true,
      cancelled: false,
      cleanupComplete: true,
      policyViolation: null,
      threadId: null,
      terminalEvent: null,
      finalResponse: "",
      partialResultText: null,
      resultSource: null,
      cumulativeTokenUsage: null,
      resolvedEffort: null,
      resolvedModel: null,
      rolloutRecoveryStatus: "not_attempted",
      semanticStatus: "unverified",
      usageIsIncomplete: true,
      ...usageOutcome({ cumulativeTokenUsage: null, cumulativeUsageUnavailableReason: null, terminalEvent: null }, { ...options, args }),
      eventCount: 0,
      eventsTruncated: false,
      fileChangeCount: 0,
      unknownEventCount: 0,
      diagnostics: [],
      protocolError: null,
      resourceError: null,
      stderrTail: "",
      spawnError: null
    };
  }
  outputPaths(options);
  const eventsFd = options.eventsFile ? fs.openSync(options.eventsFile, "w", PRIVATE_FILE_MODE) : null;
  if (options.eventsFile) {
    fs.chmodSync(options.eventsFile, PRIVATE_FILE_MODE);
  }
  const state = {
    callbackError: null,
    cancelled: false,
    cleanupComplete: true,
    policyViolation: null,
    cumulativeTokenUsage: null,
    cumulativeUsageUnavailableReason: null,
    diagnostics: [],
    eventCount: 0,
    eventsTruncated: false,
    execLost: false,
    fileChangeCount: 0,
    expectedResumeThreadId: typeof options.resumeThreadId === "string" && options.resumeThreadId.trim() ? options.resumeThreadId.trim() : null,
    finalResponse: "",
    lostProcessCount: 0,
    oversizedEventsSkipped: 0,
    patchFailureCount: 0,
    patchThrash: false,
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
    stderrPartialLine: "",
    timedOut: false,
    timeoutMs: executionTimeoutMs,
    turnFailureMessage: null,
    turnStarted: false,
    unknownEventCount: 0
  };
  const { processOutcome, child, childIdentity, spawnError, stderr } = await superviseCodex({
    options, env, bin, args, prompt, state, eventsFd, eventsMaxBytes, stderrMaxBytes,
    eventLineMaxBytes, executionTimeoutMs, terminationReserveMs, terminateProcessTree, settleProcessIdentity
  });
  applyRolloutRecovery(state, { options, env, executionStartedAtMs, resultMaxBytes });
  return buildRunOutcome({ state, options, args, stderr, processOutcome, spawnError, child, childIdentity });
}
