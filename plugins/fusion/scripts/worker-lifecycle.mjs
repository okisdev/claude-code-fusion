#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { recordEngineAcceptance } from "./lib/engine-acceptance.mjs";
import { readEngineJobFailureKind } from "./lib/engine-job-state.mjs";
import { appendTokenUsageObservation, fusionRepositoryKey } from "./fusion-stats.mjs";
import { tagMessage } from "./lib/user-messages.mjs";
import {
  applyQueuedVerdict,
  backfillWorkerTaskOutputTelemetry,
  canonicalWorkerAgentType,
  createWorkerRecord,
  createWorkerTaskId,
  findWorkerRecord,
  isFusionWorkerAgent,
  isPendingSettlement,
  isSettledWorker,
  isTerminalWorkerStatus,
  markWorkerCollected,
  readWorkerRecord,
  readWorkerSessionState,
  readWorkerRecords,
  refreshWorkerTranscript,
  resolveFusionDataDir,
  updateWorkerRecord,
  updateWorkerSessionState,
  WORKER_COLLECTION_METHODS,
  workerRecordFile,
  writePrivateText
} from "./lib/worker-state.mjs";

const WALL_CLOCK_MS_ENV = "FUSION_WORKER_WALL_CLOCK_MS";
const STALL_MS_ENV = "FUSION_WORKER_STALL_MS";
const PARENT_CONTEXT_ADVISORY_BYTES_ENV = "FUSION_PARENT_CONTEXT_ADVISORY_BYTES";
const VERIFICATION_MANIFEST_ENV = "FUSION_VERIFICATION_MANIFEST";
const DEFAULT_BRIEF_MAX_BYTES = 16 * 1024;
const SIZING_ADVISORY_BYTES = 8 * 1024;
const DEFAULT_PARENT_CONTEXT_ADVISORY_BYTES = 4 * 1024 * 1024;
const SETTLE_DEMAND_STALE_MS_ENV = "FUSION_SETTLE_DEMAND_STALE_MS";
const DEFAULT_SETTLE_DEMAND_STALE_MS = 1_800_000;
const TASK_NOTIFICATION_SCAN_MAX_BYTES = 4 * 1024 * 1024;
const TASK_NOTIFICATION_SCAN_CHUNK_BYTES = 64 * 1024;
const TASK_NOTIFICATION_MAX_LINE_BYTES = 1024 * 1024;
const TASK_NOTIFICATION_FINAL_SCAN_MAX_BYTES = Math.min(TASK_NOTIFICATION_SCAN_MAX_BYTES, 384 * 1024);
const FINAL_TEXT_MAX_BYTES = 72 * 1024;
const FINAL_TEXT_HEAD_BYTES = 24 * 1024;
const FINAL_TEXT_TAIL_BYTES = 48 * 1024;
const EXECUTION_END_MARKER = /(?:^|\n)delivery:\s*complete\s*\r?\nverification:\s*passed\s*$/i;
const COVERAGE_END_MARKER = /(?:^|\n)delivery:\s*complete\s*\r?\ncoverage:\s*complete\s*$/i;
const COLLECTOR_END_MARKER = /(?:^|\n)collector:\s*(?:state=|timeout\b|dead\b|status-error\b).*$/i;
const COLLECTOR_TERMINAL_MARKER = /^collector:\s*state=(done|error|cancelled|completed|failed)\s+semantic=(accepted|rejected|unverified)\s+engine=(codex|grok)\s+job=([a-f0-9]{32})\s+elapsed=(\d+)s$/i;
const COLLECTOR_OUTCOME_MARKER = /^collector:\s*(timeout|dead|status-error)\s+engine=(codex|grok)\s+job=([a-f0-9]{32})\s+elapsed=(\d+)s$/i;
const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch"]);
const EXECUTION_AGENTS = new Set(["fusion:claude-worker", "fusion:trivial-worker"]);
const BRIEF_AGENTS = new Set(["fusion:claude-worker", "fusion:trivial-worker", "fusion:deep-reasoner"]);
const PEER_WRAPPER_AGENTS = new Set(["codex:codex-rescue", "codex-rescue", "grok:grok-rescue", "grok-rescue"]);
const MANAGED_PEER_AGENTS = new Set(["grok:grok-review-runner", "grok-review-runner"]);
const PEER_JOB_FOOTER_AGENTS = new Set(["codex:codex-rescue", "grok:grok-rescue", "grok:grok-review-runner"]);
const TERMINAL_RUNTIME_TASK_STATUSES = new Set(["completed", "complete", "done", "failed", "error", "cancelled", "canceled", "stopped", "terminated", "timed_out", "timeout"]);
const SUCCESSFUL_TASK_NOTIFICATION_STATUSES = new Set(["completed", "complete", "done"]);
const CANCELLED_TASK_NOTIFICATION_STATUSES = new Set(["killed", "cancelled", "canceled", "stopped", "terminated"]);
const FAILED_TASK_NOTIFICATION_STATUSES = new Set(["failed", "error", "timed_out", "timeout"]);
const ENGINE_JOB_ID_PATTERN = /^[0-9a-f]{32}$/;
const WRAPPER_API_DEATH_PATTERN = /terminated early due to an API error|Connection closed mid-response/i;
const WRAPPER_API_DEATH_REASON = "wrapper died on a harness API error before dispatch; redispatch the brief";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function positiveInteger(env, name, fallback) {
  const parsed = Number.parseInt(String(env[name] ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function workerLimits(agentType, env = process.env, sizing) {
  const canonical = canonicalWorkerAgentType(agentType);
  const defaults = canonical === "fusion:trivial-worker"
    ? { wallClockMs: 240_000, stallMs: 120_000, maxTurns: 16, maxOutputTokens: 24_000, maxUncachedTokens: 120_000 }
    : canonical === "fusion:job-collector"
      ? { wallClockMs: 540_000, stallMs: 540_000, maxTurns: 6, maxOutputTokens: 8_000, maxUncachedTokens: 30_000 }
      : canonical === "fusion:deep-reasoner"
        ? { wallClockMs: 480_000, stallMs: 600_000, maxTurns: 30, maxOutputTokens: 48_000, maxUncachedTokens: 120_000 }
        : { wallClockMs: 1_200_000, stallMs: 600_000, maxTurns: 60, maxOutputTokens: 48_000, maxUncachedTokens: 360_000 };
  const multiplier = sizing === "small" ? 0.5 : sizing === "large" ? 2 : 1;
  const scaled = Object.fromEntries(Object.entries(defaults).map(([name, value]) => [name, Math.round(value * multiplier)]));
  return {
    wallClockMs: positiveInteger(env, WALL_CLOCK_MS_ENV, scaled.wallClockMs),
    stallMs: positiveInteger(env, STALL_MS_ENV, scaled.stallMs),
    maxTurns: scaled.maxTurns,
    maxOutputTokens: scaled.maxOutputTokens,
    maxUncachedTokens: scaled.maxUncachedTokens
  };
}

function hookOutput(hookEventName, additionalContext) {
  return { hookSpecificOutput: { hookEventName, additionalContext } };
}

function blockStop(reason) {
  return { decision: "block", reason };
}

function denyTool(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function allowAgentWithTaskId(toolInput, taskId, additionalContext = null) {
  const prompt = promptText(toolInput);
  const marker = `fusion-task-id: ${taskId}`;
  const lines = prompt.split(/\r?\n/).filter((line) => !/^fusion-task-id:\s*/i.test(line.trim()));
  const firstNonBlankLine = lines.findIndex((line) => line.trim());
  lines.splice(lines[firstNonBlankLine]?.trim() === "fusion-brief: v1" ? firstNonBlankLine + 1 : 0, 0, marker);
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...toolInput, prompt: lines.join("\n") }, ...(additionalContext ? { additionalContext } : {}) } };
}

function writeOutput(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function promptText(toolInput) {
  return typeof toolInput?.prompt === "string" ? toolInput.prompt : "";
}

function parentContextAdvisoryBytes(env) {
  const raw = env[PARENT_CONTEXT_ADVISORY_BYTES_ENV];
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
    return DEFAULT_PARENT_CONTEXT_ADVISORY_BYTES;
  }
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_PARENT_CONTEXT_ADVISORY_BYTES;
}

function verificationManifestPath(env) {
  const configured = env[VERIFICATION_MANIFEST_ENV];
  return typeof configured === "string" && configured.trim()
    ? path.resolve(configured)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "verification-manifest.json");
}

function globToRegExp(glob) {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        while (glob[index + 1] === "*") {
          index += 1;
        }
        if (glob[index + 1] === "/") {
          pattern += "(?:.*/)?";
          index += 1;
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (character === "?") {
      pattern += "[^/]";
    } else {
      pattern += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}

function readVerificationManifest(env) {
  try {
    const manifest = JSON.parse(fs.readFileSync(verificationManifestPath(env), "utf8"));
    if (!Array.isArray(manifest) || !manifest.every((entry) => entry && typeof entry === "object" && Array.isArray(entry.paths) && entry.paths.length > 0 && entry.paths.every((value) => typeof value === "string" && value) && Array.isArray(entry.suites) && entry.suites.length > 0 && entry.suites.every((value) => typeof value === "string" && value))) {
      return [];
    }
    return manifest.map((entry) => ({ paths: entry.paths.map((glob) => globToRegExp(glob)), suites: entry.suites }));
  } catch {
    return [];
  }
}

function pathsNamedInBrief(prompt) {
  const paths = new Set();
  for (const line of prompt.split(/\r?\n/)) {
    const field = line.match(/^(?:scope|goal):\s*(.*)$/i);
    if (!field) {
      continue;
    }
    for (const match of field[1].matchAll(/(?:\.\/)?(?:[A-Za-z0-9_@.+*?\[\]{}-]+\/)+[A-Za-z0-9_@.+*?\[\]{}-]+/g)) {
      paths.add(match[0].replace(/^\.\//, "").replace(/[.,:;!?)\]}]+$/, ""));
    }
  }
  return paths;
}

function missingVerificationSuites(prompt, env) {
  const verification = prompt.split(/\r?\n/).find((line) => /^verification:\s*\S/i.test(line));
  if (!verification) {
    return [];
  }
  const namedPaths = pathsNamedInBrief(prompt);
  if (namedPaths.size === 0) {
    return [];
  }
  const required = new Set();
  for (const entry of readVerificationManifest(env)) {
    if ([...namedPaths].some((namedPath) => entry.paths.some((pattern) => pattern.test(namedPath)))) {
      for (const suite of entry.suites) {
        required.add(suite);
      }
    }
  }
  return [...required].filter((suite) => !verification.includes(suite));
}

function briefAdvisories(prompt, briefBytes, hasSizing, env) {
  const advisories = [];
  const missingSuites = missingVerificationSuites(prompt, env);
  if (missingSuites.length > 0) {
    advisories.push(`Verification advisory: add the required suite${missingSuites.length === 1 ? "" : "s"} to \`verification:\`: ${missingSuites.join(", ")}.`);
  }
  if (briefBytes > SIZING_ADVISORY_BYTES && !hasSizing) {
    advisories.push("Sizing advisory: this brief exceeds 8192 bytes without a `sizing:` field. Add `sizing: large` or split the package into smaller briefs.");
  }
  return advisories;
}

export function validateWorkerBrief(prompt, agentType, env = process.env) {
  const canonical = canonicalWorkerAgentType(agentType);
  if (!BRIEF_AGENTS.has(canonical)) {
    return { ok: true };
  }
  const maximumBytes = DEFAULT_BRIEF_MAX_BYTES;
  if (Buffer.byteLength(prompt) > maximumBytes) {
    return { ok: false, reason: `Fusion worker brief exceeds ${maximumBytes} bytes; reduce it to the minimal self-contained task context.` };
  }
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim())?.trim();
  if (firstLine !== "fusion-brief: v1") {
    return { ok: false, reason: "Fusion worker briefs must start with `fusion-brief: v1`." };
  }
  const required = [
    [/^context-mode:\s*isolated\s*$/im, "context-mode: isolated"],
    [/^goal:\s*\S/im, "goal:"],
    [/^scope:\s*\S/im, "scope:"]
  ];
  for (const [pattern, label] of required) {
    if (!pattern.test(prompt)) {
      return { ok: false, reason: `Fusion worker brief is missing \`${label}\`.` };
    }
  }
  if (!/^(?:verification|acceptance):\s*\S/im.test(prompt)) {
    return { ok: false, reason: "Fusion worker brief must include `verification:` for execution or `acceptance:` for analysis." };
  }
  if (/\b(?:the conversation above|all previous messages|full parent transcript|inherit(?:ed)? conversation)\b/i.test(prompt)) {
    return { ok: false, reason: "Fusion workers receive a minimal isolated brief, not the parent conversation or transcript." };
  }
  if (/^fusion-task-id:\s*/im.test(prompt)) {
    return { ok: false, reason: "`fusion-task-id` is reserved for the lifecycle guard." };
  }
  const packageTypeLines = prompt.split(/\r?\n/).filter((line) => /^package-type\s*:/i.test(line.trim()));
  if (packageTypeLines.length > 1) {
    return { ok: false, reason: "Fusion worker brief `package-type:` may appear once and must be one of `implementation`, `consult`, `review`, `research`, or `design`." };
  }
  const packageType = packageTypeLines.length === 1
    ? packageTypeLines[0].match(/^package-type\s*:\s*(implementation|consult|review|research|design)\s*$/i)?.[1]?.toLowerCase()
    : /^verification:\s*\S/im.test(prompt) ? "implementation" : "consult";
  if (!packageType) {
    return { ok: false, reason: "Fusion worker brief `package-type:` must be one of `implementation`, `consult`, `review`, `research`, or `design`." };
  }
  const sizingLines = prompt.split(/\r?\n/).filter((line) => /^sizing\s*:/i.test(line.trim()));
  if (sizingLines.length > 1) {
    return { ok: false, reason: "Fusion worker brief `sizing:` may appear once and must be one of `small`, `standard`, or `large`." };
  }
  if (sizingLines.length === 1) {
    const sizing = sizingLines[0].match(/^sizing\s*:\s*(small|standard|large)\s*$/i)?.[1]?.toLowerCase();
    if (!sizing) {
      return { ok: false, reason: "Fusion worker brief `sizing:` must be one of `small`, `standard`, or `large`." };
    }
    const briefBytes = Buffer.byteLength(prompt);
    return { ok: true, sizing, packageType, briefBytes, advisories: briefAdvisories(prompt, briefBytes, true, env) };
  }
  const briefBytes = Buffer.byteLength(prompt);
  return { ok: true, packageType, briefBytes, advisories: briefAdvisories(prompt, briefBytes, false, env) };
}

function externalUserText(entry) {
  if (entry?.type !== "user" || entry?.toolUseResult != null || entry?.sourceToolAssistantUUID) {
    return null;
  }
  const content = entry?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
  return text || null;
}

function latestUserRequestedBackground(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    return false;
  }
  let text;
  try {
    const stat = fs.statSync(transcriptPath);
    const start = Math.max(0, stat.size - 1024 * 1024);
    const descriptor = fs.openSync(transcriptPath, "r");
    try {
      const buffer = Buffer.allocUnsafe(stat.size - start);
      fs.readSync(descriptor, buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(descriptor);
    }
    if (start > 0) {
      text = text.slice(text.indexOf("\n") + 1);
    }
  } catch {
    return false;
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(JSON.parse(line));
    } catch {
      void 0;
    }
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const userText = externalUserText(entries[index]);
    if (userText != null) {
      return /(?:^|\s)--background(?:\s|$)/.test(userText);
    }
  }
  return false;
}

function safeDescription(value) {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 120) : null;
}

function completionContract(agentType, prompt) {
  const canonical = canonicalWorkerAgentType(agentType);
  if (canonical === "fusion:job-collector") {
    return "collector";
  }
  if (PEER_JOB_FOOTER_AGENTS.has(agentType)) {
    return "transport";
  }
  if (canonical === "fusion:deep-reasoner" || (!/^verification:\s*\S/im.test(prompt) && /^acceptance:\s*\S/im.test(prompt))) {
    return "coverage";
  }
  return "verification";
}

function collectorRequestIdentity(prompt) {
  const lines = String(prompt ?? "").split(/\r?\n/).map((line) => line.trim());
  const engineLines = lines.filter((line) => /^engine\s*:/i.test(line));
  const jobLines = lines.filter((line) => /^job\s*:/i.test(line));
  if (engineLines.length !== 1 || jobLines.length !== 1) {
    return null;
  }
  const engine = engineLines[0].match(/^engine:\s*(codex|grok)\s*$/)?.[1] ?? null;
  const jobId = jobLines[0].match(/^job:\s*([a-f0-9]{32})\s*$/)?.[1] ?? null;
  return engine && jobId ? { expectedPeerEngine: engine, expectedPeerJobId: jobId } : null;
}

function createDispatch(input, agentType, userBackgroundAuthorized, env, validation = {}) {
  const taskId = createWorkerTaskId(input.session_id, input.tool_use_id);
  const prompt = promptText(input.tool_input);
  const collectorIdentity = canonicalWorkerAgentType(agentType) === "fusion:job-collector" ? collectorRequestIdentity(prompt) : null;
  const fallbackPackageType = () => {
    if (!PEER_WRAPPER_AGENTS.has(agentType)) {
      return /^verification:\s*\S/im.test(prompt) ? "implementation" : "consult";
    }
    const packageTypeLines = prompt.split(/\r?\n/).filter((line) => /^package-type\s*:/i.test(line.trim()));
    const explicitPackageType = packageTypeLines.length === 1
      ? packageTypeLines[0].match(/^package-type\s*:\s*(implementation|consult|review|research|design)\s*$/i)?.[1]?.toLowerCase()
      : null;
    if (explicitPackageType) {
      return explicitPackageType;
    }
    const separator = /(?:^|\s)--(?=\s|$)/.exec(prompt);
    const peerPromptPrefix = separator ? prompt.slice(0, separator.index) : prompt;
    if (/(?:^|\s)--(?:write|transport-default-write)(?=\s|$)/.test(peerPromptPrefix)) {
      return "implementation";
    }
    return /^verification:\s*\S/im.test(prompt) ? "implementation" : "consult";
  };
  let parentTranscriptBytesAtDispatch = null;
  try {
    parentTranscriptBytesAtDispatch = fs.statSync(input.transcript_path).size;
  } catch {
    void 0;
  }
  const record = createWorkerRecord({
    taskId,
    sessionId: input.session_id,
    dispatchToolUseId: input.tool_use_id ?? null,
    agentType,
    description: safeDescription(input.tool_input?.description),
    workspaceRoot: input.cwd,
    expectedDelivery: userBackgroundAuthorized ? "manual-background" : "foreground",
    userBackgroundAuthorized,
    parentTranscriptPath: typeof input.transcript_path === "string" ? input.transcript_path : null,
    parentTranscriptBytesAtDispatch,
    packageType: validation.packageType ?? fallbackPackageType(),
    briefBytes: validation.briefBytes ?? null,
    completionContract: completionContract(agentType, prompt),
    ...collectorIdentity,
    limits: workerLimits(agentType, env, validation.sizing)
  }, env);
  if (!PEER_WRAPPER_AGENTS.has(agentType)) {
    return record;
  }
  try {
    const briefFile = briefArtifactPath(record, env);
    writePrivateText(briefFile, prompt);
    return updateLifecycleWorkerRecord(record.taskId, env, (current) => current ? { ...current, briefFile } : null);
  } catch {
    return record;
  }
}

function claimParentContextAdvisory(record, env) {
  const threshold = parentContextAdvisoryBytes(env);
  if (threshold === 0 || !Number.isSafeInteger(record.parentTranscriptBytesAtDispatch) || record.parentTranscriptBytesAtDispatch <= threshold) {
    return false;
  }
  let claimed = false;
  try {
    updateWorkerSessionState(record.sessionId, env, (current) => {
      if (current?.parentContextAdvisorySent === true) {
        return null;
      }
      claimed = true;
      return { ...(current ?? {}), parentContextAdvisorySent: true };
    });
  } catch {
    return false;
  }
  return claimed;
}

function observedWorkerTokenUsage(usage) {
  return {
    inputTokens: nonNegativeInteger(usage?.inputTokens),
    cachedInputTokens: nonNegativeInteger(usage?.cacheReadInputTokens),
    outputTokens: nonNegativeInteger(usage?.outputTokens),
    reasoningOutputTokens: null,
    totalTokens: nonNegativeInteger(usage?.totalTokens)
  };
}

function observeTerminalTokenUsage(record, env) {
  if (!record || !isTerminalWorkerStatus(record.transportStatus) || record.usageAvailability !== "available" || typeof record.workspaceRoot !== "string" || !record.workspaceRoot) {
    return;
  }
  try {
    const repositoryKey = fusionRepositoryKey(record.workspaceRoot);
    if (!repositoryKey) {
      return;
    }
    appendTokenUsageObservation(path.join(resolveFusionDataDir(env), "observations", repositoryKey, "token-usage.jsonl"), {
      schemaVersion: 1,
      jobId: record.taskId,
      engine: "claude",
      workspaceRoot: record.workspaceRoot,
      repositoryKey,
      availability: record.usageAvailability,
      tokenUsage: observedWorkerTokenUsage(record.usage),
      reason: null,
      threadId: null,
      turnId: null,
      source: "worker-record",
      observedAt: new Date().toISOString()
    });
  } catch {
    void 0;
  }
}

function updateLifecycleWorkerRecord(taskId, env, updater) {
  const updated = updateWorkerRecord(taskId, env, updater);
  observeTerminalTokenUsage(updated, env);
  return updated;
}

function pendingDispatchForStart(input, env) {
  const canonical = canonicalWorkerAgentType(input.agent_type);
  const pending = readWorkerRecords(env, { strict: true }).filter((record) => record.sessionId === input.session_id && canonicalWorkerAgentType(record.agentType) === canonical && !isTerminalWorkerStatus(record.transportStatus) && !record.agentId);
  return pending.length === 1 ? pending[0] : null;
}

function recordForAgent(input, env) {
  if (typeof input.agent_id !== "string" || !input.agent_id) {
    return null;
  }
  const taskId = attributedTaskId(input, env);
  if (taskId) {
    const exact = readWorkerRecords(env, { strict: true }).find((record) => record.taskId === taskId && record.sessionId === input.session_id && canonicalWorkerAgentType(record.agentType) === canonicalWorkerAgentType(input.agent_type));
    if (exact) {
      return updateLifecycleWorkerRecord(exact.taskId, env, (current) => ({ ...current, agentId: input.agent_id }));
    }
  }
  return findWorkerRecord((record) => record.agentId === input.agent_id, env, { strict: true });
}

function attributedTaskId(input, env) {
  const records = readWorkerRecords(env, { strict: true }).filter((record) => record.sessionId === input.session_id);
  const parentPaths = new Set(records.map((record) => record.parentTranscriptPath).filter(Boolean).map((value) => path.resolve(value)));
  const candidate = [input.agent_transcript_path, input.transcript_path].find((value) => typeof value === "string" && path.isAbsolute(value) && !parentPaths.has(path.resolve(value)) && path.basename(value).includes(input.agent_id));
  if (!candidate) {
    return null;
  }
  let descriptor;
  try {
    const size = Math.min(fs.statSync(candidate).size, 256 * 1024);
    descriptor = fs.openSync(candidate, "r");
    const buffer = Buffer.allocUnsafe(size);
    fs.readSync(descriptor, buffer, 0, size, 0);
    return /fusion-task-id:\s*(fusion-[a-f0-9]{24})/.exec(buffer.toString("utf8"))?.[1] ?? null;
  } catch {
    return null;
  } finally {
    if (descriptor != null) {
      fs.closeSync(descriptor);
    }
  }
}

function isAttributedTranscriptPath(candidate, record) {
  return typeof candidate === "string" && path.isAbsolute(candidate) && candidate !== record.parentTranscriptPath && (!record.agentId || path.basename(candidate).includes(record.agentId));
}

function refreshRecord(record, input, env) {
  const candidates = [input.agent_transcript_path, input.transcript_path, record.transcriptPath];
  const transcriptPath = candidates.find((candidate) => isAttributedTranscriptPath(candidate, record)) ?? null;
  if (!transcriptPath) {
    return record;
  }
  return updateLifecycleWorkerRecord(record.taskId, env, (current) => refreshWorkerTranscript(current ?? record, transcriptPath));
}

export function workerBudgetFailure(record, now = Date.now()) {
  const limits = record?.limits;
  if (!limits) {
    return null;
  }
  const startedAt = Date.parse(record.startedAt ?? record.createdAt ?? "");
  if (Number.isFinite(startedAt) && now - startedAt >= limits.wallClockMs) {
    return { failureKind: "timeout", reason: `wall clock budget reached (${limits.wallClockMs}ms)` };
  }
  if (EXECUTION_AGENTS.has(canonicalWorkerAgentType(record.agentType)) && !record.inFlightSince) {
    const livenessAt = Date.parse(record.lastLivenessAt ?? record.startedAt ?? record.createdAt ?? "");
    if (Number.isFinite(livenessAt) && now - livenessAt >= limits.stallMs) {
      return { failureKind: "stall", reason: `no-activity budget reached (${limits.stallMs}ms)` };
    }
  }
  if ((record.turns ?? 0) >= limits.maxTurns) {
    return { failureKind: "turn_limit", reason: `turn budget reached (${limits.maxTurns})` };
  }
  if ((record.usage?.outputTokens ?? 0) >= limits.maxOutputTokens) {
    return { failureKind: "token_limit", reason: `output token budget reached (${limits.maxOutputTokens})` };
  }
  if ((record.usage?.uncachedTokens ?? 0) >= limits.maxUncachedTokens) {
    return { failureKind: "token_limit", reason: `uncached token budget reached (${limits.maxUncachedTokens})` };
  }
  return null;
}

function markBudgetFailure(record, failure, env) {
  return updateLifecycleWorkerRecord(record.taskId, env, (current) => {
    if (!current || isTerminalWorkerStatus(current.transportStatus)) {
      return null;
    }
    return {
      ...current,
      transportStatus: "cancel_requested",
      failureKind: failure.failureKind,
      cancelReason: failure.reason,
      cancelRequestedAt: new Date().toISOString()
    };
  });
}

function completedReport(record, message) {
  const normalized = message.trimEnd();
  if (record.completionContract === "collector" || canonicalWorkerAgentType(record.agentType) === "fusion:job-collector") {
    return COLLECTOR_END_MARKER.test(normalized);
  }
  if (record.completionContract === "transport" || PEER_JOB_FOOTER_AGENTS.has(record.agentType)) {
    return record.agentType === "grok:grok-review-runner" || peerJobIdFromCollectedResult(normalized) != null;
  }
  if (record.completionContract === "coverage" || canonicalWorkerAgentType(record.agentType) === "fusion:deep-reasoner") {
    return COVERAGE_END_MARKER.test(normalized);
  }
  return EXECUTION_END_MARKER.test(normalized);
}

function structuredCollectorReport(message) {
  const line = String(message ?? "").trimEnd().split(/\r?\n/).at(-1) ?? "";
  const terminal = line.match(COLLECTOR_TERMINAL_MARKER);
  if (terminal) {
    return {
      kind: "terminal",
      peerTransportStatus: terminal[1].toLowerCase(),
      peerSemanticStatus: terminal[2].toLowerCase(),
      peerEngine: terminal[3].toLowerCase(),
      peerJobId: terminal[4],
      elapsedSeconds: Number.parseInt(terminal[5], 10)
    };
  }
  const outcome = line.match(COLLECTOR_OUTCOME_MARKER);
  if (outcome) {
    return {
      kind: "outcome",
      collectionOutcome: outcome[1].toLowerCase().replace("-", "_"),
      peerEngine: outcome[2].toLowerCase(),
      peerJobId: outcome[3],
      elapsedSeconds: Number.parseInt(outcome[4], 10)
    };
  }
  return null;
}

function retryInstruction(record) {
  if (record.completionContract === "collector" || canonicalWorkerAgentType(record.agentType) === "fusion:job-collector") {
    return "Return the exact collector command output, including its terminal `collector:` marker. This is the only retry.";
  }
  if (record.completionContract === "transport" || PEER_JOB_FOOTER_AGENTS.has(record.agentType)) {
    return "The transport relay is incomplete. Return the companion output verbatim, including its `job:` and `state:` footer lines. This is the only retry.";
  }
  if (record.completionContract === "coverage" || canonicalWorkerAgentType(record.agentType) === "fusion:deep-reasoner") {
    return "The task is not deliverable yet. Complete the requested coverage check and return the actual result. End with `delivery: complete` plus `coverage: complete`. This is the only retry.";
  }
  return "The task is not deliverable yet. Complete the requested verification and return the actual result. End with `delivery: complete` plus `verification: passed`. This is the only retry.";
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function canonicalToolResponseUsage(response) {
  const usage = response?.usage && typeof response.usage === "object" ? response.usage : null;
  if (!usage) {
    const totalTokens = nonNegativeInteger(response?.totalTokens);
    return totalTokens > 0 ? { availability: "partial", reportedTotalTokens: totalTokens, usage: null } : null;
  }
  const inputTokens = nonNegativeInteger(usage.input_tokens ?? usage.inputTokens);
  const cacheCreationInputTokens = nonNegativeInteger(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens);
  const cacheReadInputTokens = nonNegativeInteger(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens);
  const outputTokens = nonNegativeInteger(usage.output_tokens ?? usage.outputTokens);
  const totalTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens + outputTokens;
  return {
    availability: "available",
    reportedTotalTokens: nonNegativeInteger(response.totalTokens) || totalTokens,
    usage: {
      inputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      outputTokens,
      totalTokens,
      uncachedTokens: inputTokens + cacheCreationInputTokens + outputTokens
    }
  };
}

function handlePreToolUse(input, env) {
  if (!input.agent_id && ["TaskStop", "TaskOutput"].includes(input.tool_name) && typeof input.tool_input?.task_id === "string") {
    const taskId = input.tool_input.task_id;
    const now = new Date().toISOString();
    for (const record of readWorkerRecords(env, { strict: true }).filter((candidate) => candidate.sessionId === input.session_id && !isTerminalWorkerStatus(candidate.transportStatus) && [candidate.backgroundTaskId, candidate.agentId].includes(taskId))) {
      updateLifecycleWorkerRecord(record.taskId, env, (current) => {
        if (!current || current.sessionId !== input.session_id || isTerminalWorkerStatus(current.transportStatus) || ![current.backgroundTaskId, current.agentId].includes(taskId)) {
          return null;
        }
        return {
          ...current,
          cancelAttemptCount: (current.cancelAttemptCount ?? 0) + 1,
          lastCancelAttemptAt: now
        };
      });
    }
  }
  if (input.tool_name === "Agent" || input.tool_name === "Task") {
    const agentType = input.tool_input?.subagent_type;
    if (PEER_WRAPPER_AGENTS.has(agentType)) {
      if (input.tool_input?.run_in_background === true) {
        writeOutput(denyTool(tagMessage("worker-lifecycle.foreground-wrapper-deny", "Codex and Grok wrapper Agents use foreground delivery. Keep the Agent foreground; an explicitly requested companion `--background` receipt stays inside that foreground wrapper call.")));
      }
      return;
    }
    if (MANAGED_PEER_AGENTS.has(agentType)) {
      return;
    }
    if (!isFusionWorkerAgent(agentType)) {
      return;
    }
    if (canonicalWorkerAgentType(agentType) === "fusion:job-collector" && !collectorRequestIdentity(promptText(input.tool_input))) {
      writeOutput(denyTool(tagMessage("worker-lifecycle.collector-request-deny", "Fusion collector requests must contain exactly one `engine: codex|grok` line and one `job: <32 lowercase hexadecimal characters>` line.")));
      return;
    }
    const validation = validateWorkerBrief(promptText(input.tool_input), agentType, env);
    if (!validation.ok) {
      writeOutput(denyTool(tagMessage("worker-lifecycle.brief-validation-deny", validation.reason)));
      return;
    }
    const requestsBackground = input.tool_input?.run_in_background === true;
    const userBackgroundAuthorized = requestsBackground && latestUserRequestedBackground(input.transcript_path);
    if (requestsBackground && !userBackgroundAuthorized) {
      writeOutput(denyTool(tagMessage("worker-lifecycle.background-authorization-deny", "Fusion workers may detach only when the latest user message explicitly contains `--background`. Remove background mode and collect the result in this turn.")));
      return;
    }
    const record = createDispatch(input, agentType, userBackgroundAuthorized, env, validation);
    const advisories = [...(validation.advisories ?? [])];
    if (claimParentContextAdvisory(record, env)) {
      advisories.push("The orchestrator transcript is large. Cache reread cost grows with context size times turns. Consider a fresh session for the next goal.");
    }
    const additionalContext = advisories.join("\n\n");
    writeOutput(allowAgentWithTaskId(input.tool_input, record.taskId, additionalContext ? tagMessage("worker-lifecycle.dispatch-advisory", additionalContext) : null));
    return;
  }
  if (!isFusionWorkerAgent(input.agent_type)) {
    return;
  }
  const record = recordForAgent(input, env);
  if (!record) {
    return;
  }
  const refreshed = refreshRecord(record, input, env);
  if (isTerminalWorkerStatus(refreshed.transportStatus)) {
    return;
  }
  const failure = workerBudgetFailure(refreshed);
  if (failure?.failureKind === "stall") {
    const now = new Date().toISOString();
    updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => {
      if (!current || isTerminalWorkerStatus(current.transportStatus)) {
        return null;
      }
      return { ...current, lastLivenessAt: now, lastActivityAt: now, inFlightSince: now };
    });
    return;
  }
  if (failure) {
    markBudgetFailure(refreshed, failure, env);
    if (failure.failureKind === "token_limit" && input.tool_name === "Write" && !refreshed.terminalWriteGraceUsedAt) {
      const now = new Date().toISOString();
      let terminalWriteGraceUsed = false;
      updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => {
        if (!current || isTerminalWorkerStatus(current.transportStatus) || current.terminalWriteGraceUsedAt) {
          return null;
        }
        terminalWriteGraceUsed = true;
        return { ...current, terminalWriteGraceUsedAt: now };
      });
      if (terminalWriteGraceUsed) {
        writeOutput({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", additionalContext: tagMessage("worker-lifecycle.final-deliverable-allow", "Final deliverable write permitted; every further tool call will be denied.") } });
        return;
      }
    }
    const terminalWriteHint = failure.failureKind === "token_limit" ? " If the deliverable file is not yet written, one final Write is permitted." : "";
    writeOutput(denyTool(tagMessage("worker-lifecycle.worker-stop-deny", `Fusion worker ${refreshed.taskId} must stop: ${failure.reason}. Return a concise partial result now; do not retry or call more tools.${terminalWriteHint}`)));
    return;
  }
  const now = new Date().toISOString();
  updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => {
    if (!current || isTerminalWorkerStatus(current.transportStatus)) {
      return null;
    }
    return { ...current, lastActivityAt: now, inFlightSince: now };
  });
}

function noTaskFoundError(input, failed) {
  const response = input.tool_response;
  const isError = failed || response?.is_error === true || response?.isError === true || response?.status === "error" || typeof response?.error === "string";
  if (!isError) {
    return false;
  }
  const text = [input.error, response].flatMap((value) => {
    if (typeof value === "string") {
      return [value];
    }
    if (!value) {
      return [];
    }
    try {
      return [JSON.stringify(value)];
    } catch {
      return [];
    }
  }).join("\n");
  return /No task found/i.test(text);
}

function taskOutputTranscriptPaths(input, record) {
  const response = input.tool_response && typeof input.tool_response === "object" ? input.tool_response : {};
  const nested = response.toolUseResult && typeof response.toolUseResult === "object" ? response.toolUseResult : {};
  const runtimeId = typeof record.backgroundTaskId === "string" && record.backgroundTaskId
    ? record.backgroundTaskId
    : typeof record.agentId === "string" && record.agentId
      ? record.agentId
      : null;
  const direct = [
    input.agent_transcript_path,
    input.task_output_path,
    input.task_output_file,
    input.output_file,
    response.agentTranscriptPath,
    response.agent_transcript_path,
    response.transcriptPath,
    response.transcript_path,
    response.outputFile,
    nested.agentTranscriptPath,
    nested.agent_transcript_path,
    nested.transcriptPath,
    nested.transcript_path,
    nested.outputFile,
    record.transcriptPath
  ];
  const parents = [input.transcript_path, record.parentTranscriptPath]
    .filter((value) => typeof value === "string" && path.isAbsolute(value));
  if (runtimeId) {
    const safeRuntimeId = path.basename(runtimeId);
    for (const parent of parents) {
      direct.push(path.join(path.dirname(parent), "subagents", `agent-${safeRuntimeId}.jsonl`));
      direct.push(path.join(path.dirname(parent), "subagents", `${safeRuntimeId}.jsonl`));
      const sessionDirectory = path.join(path.dirname(parent), path.basename(parent, path.extname(parent)));
      direct.push(path.join(sessionDirectory, "subagents", `agent-${safeRuntimeId}.jsonl`));
      direct.push(path.join(sessionDirectory, "subagents", `${safeRuntimeId}.jsonl`));
    }
  }
  return [...new Set(direct.filter((value) => typeof value === "string" && path.isAbsolute(value) && path.extname(value) === ".jsonl").map((value) => path.resolve(value)))];
}

function collectedHarnessAsyncDelivery(record, transportStatus) {
  return record.runtimeAsync === true && record.failureKind === "unexpected_async" && transportStatus === "done";
}

function resultTextParts(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(resultTextParts);
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return ["text", "content", "output", "result", "toolUseResult"].flatMap((key) => resultTextParts(value[key]));
}

function documentedTaskOutputText(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && value.type === "text" && typeof value.text === "string") {
    return value.text;
  }
  const content = Array.isArray(value) ? value : value?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content.flatMap((block) => block?.type === "text" && typeof block.text === "string" ? [block.text] : []);
  return text.length > 0 ? text.join("\n") : null;
}

function taskOutputResultText(input) {
  const text = documentedTaskOutputText(input.tool_response) ?? resultTextParts(input.tool_response).join("\n");
  if (!text) {
    return null;
  }
  const outputSections = [...text.matchAll(/<output>([\s\S]*?)<\/output>/gi)].map((match) => match[1]);
  return outputSections.length > 0 ? outputSections.join("\n") : text;
}

function absoluteOutputFile(value) {
  return typeof value === "string" && path.isAbsolute(value) ? path.resolve(value) : null;
}

function regularFileExists(file) {
  try {
    return typeof file === "string" && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function durableSubagentTranscript(record) {
  const transcriptPath = typeof record.transcriptPath === "string" && path.isAbsolute(record.transcriptPath) ? path.resolve(record.transcriptPath) : null;
  const parentTranscriptPath = typeof record.parentTranscriptPath === "string" && path.isAbsolute(record.parentTranscriptPath) ? path.resolve(record.parentTranscriptPath) : null;
  const agentId = typeof record.agentId === "string" && record.agentId ? path.basename(record.agentId) : null;
  if (!transcriptPath || !parentTranscriptPath || !agentId || path.basename(path.dirname(transcriptPath)) !== "tasks") {
    return transcriptPath;
  }
  const durablePath = path.join(path.dirname(parentTranscriptPath), "subagents", `agent-${agentId}.jsonl`);
  return regularFileExists(durablePath) ? durablePath : transcriptPath;
}

function withDurableCancellationTranscript(record) {
  if (record.transportStatus !== "cancelled") {
    return record;
  }
  const transcriptPath = durableSubagentTranscript(record);
  return transcriptPath && transcriptPath !== record.transcriptPath ? { ...record, transcriptPath } : record;
}

function withPeerFailureKind(record, env) {
  if (record.peerFailureKind != null || !["codex", "grok"].includes(record.peerEngine) || !ENGINE_JOB_ID_PATTERN.test(record.peerJobId ?? "")) {
    return record;
  }
  const peerFailureKind = readEngineJobFailureKind(record.peerEngine, record.peerJobId, env);
  return peerFailureKind == null ? record : { ...record, peerFailureKind };
}

function outputFileFromLaunchResponse(response, nested) {
  const direct = [response.outputFile, response.output_file, nested.outputFile, nested.output_file].map(absoluteOutputFile).find(Boolean);
  if (direct) {
    return direct;
  }
  for (const value of [response, nested]) {
    const text = taskOutputResultText({ tool_response: value });
    for (const line of String(text ?? "").split(/\r?\n/)) {
      const match = line.match(/^\s*output_file:\s*(.+?)\s*$/i);
      const outputFile = absoluteOutputFile(match?.[1]);
      if (outputFile) {
        return outputFile;
      }
    }
  }
  return null;
}

function finalTextArtifactPath(record, env) {
  return path.join(path.dirname(workerRecordFile(record.taskId, env)), `${record.taskId}.final.txt`);
}

function briefArtifactPath(record, env) {
  return path.join(path.dirname(workerRecordFile(record.taskId, env)), `${record.taskId}.brief.txt`);
}

function boundedFinalText(message) {
  const text = Buffer.from(message, "utf8");
  if (text.length <= FINAL_TEXT_MAX_BYTES) {
    return text;
  }
  const omitted = text.length - FINAL_TEXT_HEAD_BYTES - FINAL_TEXT_TAIL_BYTES;
  return Buffer.concat([
    text.subarray(0, FINAL_TEXT_HEAD_BYTES),
    Buffer.from(`\n[fusion: truncated ${omitted} bytes]\n`, "utf8"),
    text.subarray(text.length - FINAL_TEXT_TAIL_BYTES)
  ]);
}

function writeFinalTextArtifact(record, message, env) {
  const file = finalTextArtifactPath(record, env);
  writePrivateText(file, boundedFinalText(message));
  return file;
}

function peerJobIdFromCollectedResult(text) {
  let peerJobId = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = line.match(/^job: ([0-9a-f]{32})$/);
    if (match) {
      peerJobId = match[1];
    }
  }
  return peerJobId;
}

function peerEngineFromAgentType(agentType) {
  if (agentType === "codex:codex-rescue") {
    return "codex";
  }
  if (agentType === "grok:grok-rescue" || agentType === "grok:grok-review-runner") {
    return "grok";
  }
  return null;
}

function capturedPeerIdentity(agentType, text, peerEngine) {
  const peerJobId = peerJobIdFromCollectedResult(text);
  const derivedPeerEngine = peerEngineFromAgentType(agentType);
  return peerJobId
    ? {
        peerJobId,
        ...(peerEngine == null && derivedPeerEngine ? { peerEngine: derivedPeerEngine } : {})
      }
    : {};
}

function backfillCollectedTaskOutput(record, input) {
  for (const transcriptPath of taskOutputTranscriptPaths(input, record)) {
    const backfilled = backfillWorkerTaskOutputTelemetry(record, transcriptPath);
    if (backfilled !== record) {
      return backfilled;
    }
  }
  return record;
}

function settleQueuedVerdict(record, now, env) {
  const prepared = withPeerFailureKind(withDurableCancellationTranscript(record), env);
  const pendingVerdict = prepared.pendingVerdict;
  const settled = applyQueuedVerdict(prepared, now);
  if (!pendingVerdict || settled.pendingVerdict || settled.acceptanceRecordedAt == null) {
    return settled;
  }
  const peerJobId = typeof settled.peerJobId === "string" && ENGINE_JOB_ID_PATTERN.test(settled.peerJobId) ? settled.peerJobId : null;
  const peerEngine = settled.peerEngine === "codex" || settled.peerEngine === "grok" ? settled.peerEngine : null;
  if (!peerJobId || !peerEngine) {
    return settled;
  }
  try {
    recordEngineAcceptance({
      engine: peerEngine,
      jobId: peerJobId,
      acceptance: settled.acceptance,
      source: pendingVerdict.source,
      reason: settled.acceptanceReason,
      failureKind: settled.acceptanceFailureKind ?? null,
      acceptFailedTransport: pendingVerdict.acceptFailedTransport === true,
      workspaceRoot: typeof settled.workspaceRoot === "string" ? settled.workspaceRoot : process.cwd(),
      env
    });
    const { engineSettlementError: _engineSettlementError, ...withoutEngineSettlementError } = settled;
    return withoutEngineSettlementError;
  } catch (error) {
    return {
      ...settled,
      engineSettlementError: error instanceof Error ? error.message : String(error)
    };
  }
}

function readableOutputArtifact(record) {
  for (const candidate of [record.outputFile, record.transcriptPath]) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      continue;
    }
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.R_OK);
        return true;
      }
    } catch {
      void 0;
    }
  }
  return false;
}

function wrapperApiDeathEvidence(record, evidence) {
  const texts = [evidence, record.notificationSummary, record.statusDetail, record.finalText].filter((value) => typeof value === "string");
  return PEER_WRAPPER_AGENTS.has(record.agentType)
    && !record.peerJobId
    && !readableOutputArtifact(record)
    && WRAPPER_API_DEATH_PATTERN.test(texts.join("\n"));
}

function settleWrapperApiDeath(record, evidence, now, env) {
  if (!wrapperApiDeathEvidence(record, evidence)) {
    return record;
  }
  return settleQueuedVerdict({
    ...record,
    transportStatus: "failed",
    failureKind: "delivery",
    pendingVerdict: {
      acceptance: "rejected",
      source: "lifecycle",
      reason: WRAPPER_API_DEATH_REASON,
      failureKind: null,
      queuedAt: now
    },
    finishedAt: record.finishedAt ?? now,
    lastActivityAt: now
  }, now, env);
}

function isAutoSettledWrapperApiDeath(record) {
  return record?.acceptance === "rejected" && record.acceptanceSource === "lifecycle" && record.acceptanceReason === WRAPPER_API_DEATH_REASON;
}

function statusEvidence(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  return [value.notificationSummary, value.notification_summary, value.summary, value.statusDetail, value.status_detail, value.detail, value.error]
    .filter((part) => typeof part === "string")
    .join("\n");
}

function settleReapedWorker(current, now, env) {
  return settleQueuedVerdict({
    ...markWorkerCollected(current, WORKER_COLLECTION_METHODS.TASK_REAPED, now),
    transportStatus: "failed",
    failureKind: "task_reaped",
    finishedAt: now,
    lastActivityAt: now
  }, now, env);
}

function settleReapedIfActive(taskId, now, env, extraGuard) {
  let settled = false;
  updateLifecycleWorkerRecord(taskId, env, (current) => {
    if (!current || isTerminalWorkerStatus(current.transportStatus) || !extraGuard(current)) {
      return null;
    }
    settled = true;
    return settleReapedWorker(current, now, env);
  });
  return settled;
}

function handlePostToolUse(input, env, failed = false) {
  if (!input.agent_id && ["Read", "TaskOutput", "TaskStop"].includes(input.tool_name)) {
    const taskId = typeof input.tool_input?.task_id === "string" ? input.tool_input.task_id : null;
    const readPath = typeof input.tool_input?.file_path === "string" ? path.resolve(input.cwd, input.tool_input.file_path) : null;
    const records = readWorkerRecords(env, { strict: true });
    if (["TaskOutput", "TaskStop"].includes(input.tool_name) && taskId && noTaskFoundError(input, failed)) {
      const now = new Date().toISOString();
      for (const record of records.filter((candidate) => candidate.sessionId === input.session_id && !isTerminalWorkerStatus(candidate.transportStatus) && [candidate.backgroundTaskId, candidate.agentId].includes(taskId))) {
        settleReapedIfActive(record.taskId, now, env, (current) => current.sessionId === input.session_id && [current.backgroundTaskId, current.agentId].includes(taskId));
      }
      return;
    }
    const matches = records.filter((record) => {
      if (record.sessionId !== input.session_id) {
        return false;
      }
      if (input.tool_name === "Read") {
        const collectionPath = record.outputFile ?? record.transcriptPath;
        return terminalCollectionPending(record) && typeof collectionPath === "string" && path.resolve(collectionPath) === readPath;
      }
      if (input.tool_name === "TaskOutput" && input.tool_input?.block !== true) {
        return false;
      }
      return taskId && [record.backgroundTaskId, record.agentId, record.taskId].includes(taskId);
    });
    if (!failed || input.tool_name === "Read") {
      const now = new Date().toISOString();
      const collectedResultText = !failed && ["Read", "TaskOutput"].includes(input.tool_name) ? taskOutputResultText(input) : null;
      if (["Read", "TaskOutput"].includes(input.tool_name) && matches.length > 0) {
      }
      for (const record of matches) {
        updateLifecycleWorkerRecord(record.taskId, env, (current) => {
          if (!current || current.sessionId !== input.session_id) {
            return null;
          }
          const worker = current;
          const peerIdentity = ["Read", "TaskOutput"].includes(input.tool_name) && PEER_JOB_FOOTER_AGENTS.has(worker.agentType)
            ? capturedPeerIdentity(worker.agentType, collectedResultText, worker.peerEngine)
            : {};
          if (terminalCollectedRecord(worker)) {
            return peerIdentityBackfill(worker, peerIdentity, env);
          }
          const transportStatus = input.tool_name === "TaskStop" ? "cancelled" : "done";
          const collectionMethod = input.tool_name === "Read"
            ? WORKER_COLLECTION_METHODS.OUTPUT_FILE_READ
            : input.tool_name === "TaskOutput"
              ? WORKER_COLLECTION_METHODS.TASK_OUTPUT
              : WORKER_COLLECTION_METHODS.TASK_STOP;
          const harnessAsyncDelivery = collectedHarnessAsyncDelivery(worker, transportStatus);
          const updated = settleQueuedVerdict({
            ...markWorkerCollected(worker, collectionMethod, now),
            transportStatus,
            failureKind: input.tool_name === "TaskStop" ? worker.failureKind ?? "cancelled" : harnessAsyncDelivery ? null : worker.failureKind,
            ...(harnessAsyncDelivery ? { deliveryMode: "harness_async" } : {}),
            ...peerIdentity,
            finishedAt: worker.finishedAt ?? now,
            lastActivityAt: now
          }, now, env);
          return ["Read", "TaskOutput"].includes(input.tool_name) ? backfillCollectedTaskOutput(updated, input) : updated;
        });
      }
    }
    return;
  }
  if ((input.tool_name === "Agent" || input.tool_name === "Task") && !input.agent_id) {
    const agentType = input.tool_input?.subagent_type;
    if (PEER_WRAPPER_AGENTS.has(agentType)) {
      if (failed) {
        return;
      }
      const response = input.tool_response && typeof input.tool_response === "object" ? input.tool_response : {};
      const nested = response.toolUseResult && typeof response.toolUseResult === "object" ? response.toolUseResult : {};
      const isAsync = response.isAsync === true || nested.isAsync === true || response.status === "async_launched" || nested.status === "async_launched";
      if (!isAsync) {
        return;
      }
      const agentId = typeof response.agentId === "string" ? response.agentId : typeof nested.agentId === "string" ? nested.agentId : null;
      const outputFile = outputFileFromLaunchResponse(response, nested);
      const now = new Date().toISOString();
      const record = createDispatch(input, agentType, false, env);
      updateLifecycleWorkerRecord(record.taskId, env, (current) => ({
        ...current,
        ...(agentId ? { agentId, backgroundTaskId: agentId } : {}),
        ...(outputFile ? { outputFile } : {}),
        transportStatus: "pending_async",
        runtimeAsync: true,
        failureKind: "unexpected_async",
        startedAt: current.startedAt ?? now
      }));
      return;
    }
    if (!isFusionWorkerAgent(agentType)) {
      return;
    }
    const pending = findWorkerRecord((record) => record.sessionId === input.session_id && record.dispatchToolUseId === input.tool_use_id, env, { strict: true });
    if (pending) {
      const response = input.tool_response && typeof input.tool_response === "object" ? input.tool_response : {};
      const nested = response.toolUseResult && typeof response.toolUseResult === "object" ? response.toolUseResult : {};
      const agentId = typeof response.agentId === "string" ? response.agentId : typeof nested.agentId === "string" ? nested.agentId : null;
      const outputFile = outputFileFromLaunchResponse(response, nested);
      const isAsync = response.isAsync === true || nested.isAsync === true || response.status === "async_launched" || nested.status === "async_launched";
      const resolvedModel = typeof response.resolvedModel === "string" ? response.resolvedModel : typeof nested.resolvedModel === "string" ? nested.resolvedModel : null;
      const usageResponse = response.usage || response.totalTokens != null ? response : nested;
      const directUsage = canonicalToolResponseUsage(usageResponse);
      const completed = response.status === "completed" || nested.status === "completed";
      const totalToolUseCount = response.totalToolUseCount ?? nested.totalToolUseCount;
      const now = new Date().toISOString();
      updateLifecycleWorkerRecord(pending.taskId, env, (current) => {
        if (!current || terminalCollectedRecord(current)) {
          return null;
        }
        const worker = current;
        const transportStatus = failed ? "failed" : isAsync ? "pending_async" : completed && !isTerminalWorkerStatus(worker.transportStatus) ? "done" : worker.transportStatus === "dispatching" ? "running" : worker.transportStatus;
        const updated = {
          ...(!failed && completed ? markWorkerCollected(worker, WORKER_COLLECTION_METHODS.AGENT_RESULT, now) : worker),
          ...(agentId ? { agentId, backgroundTaskId: isAsync ? agentId : worker.backgroundTaskId } : {}),
          ...(outputFile ? { transcriptPath: outputFile } : {}),
          ...(resolvedModel ? { resolvedModel } : {}),
          ...(directUsage?.usage ? { usage: directUsage.usage, usageSource: "tool-response" } : {}),
          ...(directUsage ? { usageAvailability: directUsage.availability, reportedTotalTokens: directUsage.reportedTotalTokens } : {}),
          ...(Number.isFinite(response.totalDurationMs ?? nested.totalDurationMs) ? { durationMs: response.totalDurationMs ?? nested.totalDurationMs } : {}),
          ...(Number.isSafeInteger(totalToolUseCount) ? { toolCalls: totalToolUseCount, toolCallsSource: "tool-response" } : {}),
          transportStatus,
          failureKind: failed ? "launch" : worker.failureKind,
          finishedAt: failed || completed ? now : worker.finishedAt,
          runtimeAsync: isAsync,
          ...(isAsync ? { startedAt: worker.startedAt ?? now } : {})
        };
        return isTerminalWorkerStatus(transportStatus) ? settleQueuedVerdict(updated, now, env) : updated;
      });
    }
    return;
  }
  if (!isFusionWorkerAgent(input.agent_type) && !PEER_JOB_FOOTER_AGENTS.has(input.agent_type)) {
    return;
  }
  const record = recordForAgent(input, env);
  if (!record) {
    return;
  }
  const now = new Date().toISOString();
  let emitTurnWindDown = false;
  let emitTokenWindDown = false;
  updateLifecycleWorkerRecord(record.taskId, env, (current) => {
    if (!current || isTerminalWorkerStatus(current.transportStatus)) {
      return null;
    }
    const selectedTranscript = isAttributedTranscriptPath(input.transcript_path, record) ? input.transcript_path : null;
    const refreshed = selectedTranscript ? refreshWorkerTranscript(current, selectedTranscript) : current;
    const progress = !failed && !READ_ONLY_TOOLS.has(input.tool_name);
    const turnWindDownThreshold = Math.max(0, (refreshed.limits?.maxTurns ?? Number.POSITIVE_INFINITY) - 2);
    const tokenWindDownThreshold = (refreshed.limits?.maxOutputTokens ?? Number.POSITIVE_INFINITY) * 0.85;
    emitTokenWindDown = !isTerminalWorkerStatus(refreshed.transportStatus) && refreshed.tokenWindDownSentAt == null && (refreshed.usage?.outputTokens ?? 0) >= tokenWindDownThreshold;
    emitTurnWindDown = !emitTokenWindDown && !isTerminalWorkerStatus(refreshed.transportStatus) && refreshed.windDownContextSentAt == null && (refreshed.turns ?? 0) >= turnWindDownThreshold;
    return {
      ...refreshed,
      lastActivityAt: now,
      inFlightSince: undefined,
      ...(!failed ? { lastLivenessAt: now } : {}),
      ...(progress ? { lastProgressAt: now, progressEvents: (refreshed.progressEvents ?? 0) + 1 } : {}),
      ...(emitTurnWindDown ? { windDownContextSentAt: now } : {}),
      ...(emitTokenWindDown ? { tokenWindDownSentAt: now } : {})
    };
  });
  if (emitTokenWindDown) {
    writeOutput(hookOutput(input.hook_event_name, tagMessage("worker-lifecycle.budget-wind-down", "Token budget wind-down: stop making tool calls and write your final deliverable now.")));
  } else if (emitTurnWindDown) {
    writeOutput(hookOutput(input.hook_event_name, tagMessage("worker-lifecycle.budget-wind-down", "Turn budget wind-down: stop making tool calls and write your final deliverable now.")));
  }
}

function handleSubagentStart(input, env) {
  if (!isFusionWorkerAgent(input.agent_type)) {
    return;
  }
  const pending = recordForAgent(input, env) ?? pendingDispatchForStart(input, env);
  if (!pending) {
    return;
  }
  const now = new Date().toISOString();
  let started = false;
  const record = updateLifecycleWorkerRecord(pending.taskId, env, (current) => {
    if (!current || isTerminalWorkerStatus(current.transportStatus)) {
      return null;
    }
    started = true;
    return {
      ...current,
      agentId: input.agent_id,
      transportStatus: "running",
      startedAt: current.startedAt ?? now,
      lastActivityAt: now,
      lastProgressAt: now
    };
  });
  if (!started) {
    return;
  }
  const limits = record.limits;
  const verdictEnvelope = "Keep the final message to a compact verdict envelope that states changed file paths without diffs, the verification command with pass and fail counts, any environment findings, and the path of a file holding the full report when one is written. Write long unified diffs, full test logs, and long quoted file contents to that file instead of inlining them.";
  const delivery = record.completionContract === "collector"
    ? "Return the collector command output exactly, including its terminal `collector:` marker."
    : record.completionContract === "coverage"
      ? `End the completed analysis with separate lines \`delivery: complete\` and \`coverage: complete\`. ${verdictEnvelope}`
      : `End a successful execution report with separate lines \`delivery: complete\` and \`verification: passed\`. ${verdictEnvelope}`;
  const artifactFirst = EXECUTION_AGENTS.has(canonicalWorkerAgentType(record.agentType))
    ? " Write your deliverable artifact to a file early, before deep work, and keep updating it; your final message names its path, and a budget death must still leave a readable artifact."
    : "";
  writeOutput(hookOutput("SubagentStart", tagMessage("worker-lifecycle.subagent-start-context", `Fusion task id: ${record.taskId}. Work only from the supplied isolated brief. Do not request or reconstruct the parent transcript. Budgets: ${limits.wallClockMs}ms wall clock, ${limits.stallMs}ms without successful tool activity, ${limits.maxTurns} turns, ${limits.maxOutputTokens} output tokens, ${limits.maxUncachedTokens} uncached tokens. Retry at most once. At 85 percent of the output token budget, stop making tool calls and write the final deliverable; after the token limit, exactly one final Write of the deliverable is permitted.${artifactFirst} ${delivery}`)));
}

function handleSubagentStop(input, env) {
  if (!isFusionWorkerAgent(input.agent_type) && !PEER_JOB_FOOTER_AGENTS.has(input.agent_type)) {
    return;
  }
  const record = recordForAgent(input, env);
  if (!record) {
    return;
  }
  const refreshed = refreshRecord(record, input, env);
  const message = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
  if (terminalCollectedRecord(refreshed)) {
    const peerIdentity = PEER_JOB_FOOTER_AGENTS.has(refreshed.agentType) ? capturedPeerIdentity(refreshed.agentType, message, refreshed.peerEngine) : {};
    updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => current && terminalCollectedRecord(current) ? peerIdentityBackfill(current, peerIdentity, env) : null);
    return;
  }
  const failure = workerBudgetFailure(refreshed);
  let finalTextFile = isFusionWorkerAgent(refreshed.agentType) && message.length > 0 ? finalTextArtifactPath(refreshed, env) : null;
  if (finalTextFile) {
    try {
      finalTextFile = writeFinalTextArtifact(refreshed, message, env);
      updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => ({ ...(current ?? refreshed), outputFile: finalTextFile }));
    } catch {
      finalTextFile = null;
    }
  }
  if (wrapperApiDeathEvidence(refreshed, [message, statusEvidence(input)].join("\n"))) {
    const now = new Date().toISOString();
    updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => current && !isTerminalWorkerStatus(current.transportStatus)
      ? settleWrapperApiDeath(current, [message, statusEvidence(input)].join("\n"), now, env)
      : null);
    return;
  }
  const complete = completedReport(refreshed, message);
  const collectorContract = refreshed.completionContract === "collector" || canonicalWorkerAgentType(refreshed.agentType) === "fusion:job-collector";
  const collectorReport = collectorContract ? structuredCollectorReport(message) : null;
  const collectorIdentityMismatch = collectorContract && collectorReport && (collectorReport.peerEngine !== refreshed.expectedPeerEngine || collectorReport.peerJobId !== refreshed.expectedPeerJobId);
  const trustedCollectorReport = collectorIdentityMismatch ? null : collectorReport;
  const collectorProtocolFailure = (collectorContract && complete && !collectorReport) || collectorIdentityMismatch;
  if (collectorProtocolFailure && !failure && (refreshed.retryCount ?? 0) < 1 && !input.stop_hook_active) {
    updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => ({ ...current, retryCount: (current.retryCount ?? 0) + 1 }));
    const expected = refreshed.expectedPeerEngine && refreshed.expectedPeerJobId
      ? ` Repeat collection for exactly engine=${refreshed.expectedPeerEngine} job=${refreshed.expectedPeerJobId}.`
      : "";
    writeOutput(blockStop(tagMessage("worker-lifecycle.collector-marker-block", `The collector returned an invalid or mismatched terminal marker.${expected} Return the exact collector command output with its terminal marker. This is the only retry.`)));
    return;
  }
  if (!complete && !failure && (refreshed.retryCount ?? 0) < 1 && !input.stop_hook_active) {
    updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => ({ ...current, retryCount: (current.retryCount ?? 0) + 1 }));
    writeOutput(blockStop(tagMessage("worker-lifecycle.deliverable-retry-block", retryInstruction(refreshed))));
    return;
  }
  const now = new Date().toISOString();
  updateLifecycleWorkerRecord(refreshed.taskId, env, (current) => {
    if (!current) {
      return null;
    }
    const worker = current;
    const peerIdentity = PEER_JOB_FOOTER_AGENTS.has(worker.agentType) ? capturedPeerIdentity(worker.agentType, message, worker.peerEngine) : {};
    if (terminalCollectedRecord(worker)) {
      return peerIdentityBackfill(worker, peerIdentity, env);
    }
    const runtimeAsync = worker.runtimeAsync === true;
    const successfulCompletion = complete && !failure && trustedCollectorReport?.kind !== "outcome" && !collectorProtocolFailure;
    const subagentStopCollected = successfulCompletion && finalTextFile != null && !collectorContract;
    return settleQueuedVerdict({
      ...(runtimeAsync && !subagentStopCollected ? worker : markWorkerCollected(worker, WORKER_COLLECTION_METHODS.SUBAGENT_STOP, now)),
      transportStatus: complete && (trustedCollectorReport?.kind === "outcome" || collectorProtocolFailure) ? "incomplete" : complete ? runtimeAsync && !subagentStopCollected ? "ready_uncollected" : "done" : failure ? "failed" : "incomplete",
      failureKind: failure?.failureKind ?? (trustedCollectorReport?.kind === "outcome" ? `collection_${trustedCollectorReport.collectionOutcome}` : collectorProtocolFailure ? "collection_protocol" : complete ? null : "delivery"),
      inFlightSince: undefined,
      ...(successfulCompletion && worker.failureKind && worker.failureKind !== "unexpected_async" ? { recoveredFailureKind: worker.failureKind } : {}),
      ...(complete && !failure && !collectorProtocolFailure && runtimeAsync && worker.failureKind === "unexpected_async" ? { deliveryMode: "harness_async" } : {}),
      ...(finalTextFile ? { outputFile: finalTextFile } : {}),
      ...peerIdentity,
      ...(trustedCollectorReport?.peerEngine ? { peerEngine: trustedCollectorReport.peerEngine } : {}),
      ...(trustedCollectorReport?.peerJobId ? { peerJobId: trustedCollectorReport.peerJobId } : {}),
      ...(trustedCollectorReport?.peerTransportStatus ? { peerTransportStatus: trustedCollectorReport.peerTransportStatus } : {}),
      ...(trustedCollectorReport?.peerSemanticStatus ? { peerSemanticStatus: trustedCollectorReport.peerSemanticStatus } : {}),
      ...(trustedCollectorReport?.collectionOutcome ? { collectionOutcome: trustedCollectorReport.collectionOutcome } : {}),
      ...(Number.isSafeInteger(trustedCollectorReport?.elapsedSeconds) ? { collectionElapsedSeconds: trustedCollectorReport.elapsedSeconds } : {}),
      finishedAt: now,
      lastActivityAt: now
    }, now, env);
  });
}

function activeSessionRecords(sessionId, env) {
  return readWorkerRecords(env, { strict: true }).filter((record) => record.sessionId === sessionId && !isTerminalWorkerStatus(record.transportStatus));
}

function sessionRecords(sessionId, env) {
  return readWorkerRecords(env, { strict: true }).filter((record) => record.sessionId === sessionId);
}

function runtimeTaskForRecord(record, tasks) {
  const runtimeIds = [record.backgroundTaskId, record.agentId].filter(Boolean);
  return tasks.find((task) => runtimeIds.includes(task?.id))
    ?? (!record.backgroundTaskId && !record.agentId
      ? tasks.find((task) => task?.type === "subagent" && canonicalWorkerAgentType(task.agent_type) === canonicalWorkerAgentType(record.agentType))
      : null);
}

function runtimeTaskIsTerminal(task) {
  return typeof task?.status === "string" && TERMINAL_RUNTIME_TASK_STATUSES.has(task.status.trim().toLowerCase());
}

function runtimeTaskSucceeded(task) {
  return typeof task?.status === "string" && ["completed", "complete", "done"].includes(task.status.trim().toLowerCase());
}

function runtimeTaskFailed(task) {
  return typeof task?.status === "string" && FAILED_TASK_NOTIFICATION_STATUSES.has(task.status.trim().toLowerCase());
}

function terminalTransportObserved(record, task) {
  return isTerminalWorkerStatus(record.transportStatus)
    || ["ready_uncollected", "ready_background"].includes(record.transportStatus)
    || runtimeTaskIsTerminal(task);
}

function terminalCollectionPending(record) {
  return ["ready_uncollected", "ready_background"].includes(record.transportStatus)
    || (record.runtimeAsync === true && isTerminalWorkerStatus(record.transportStatus) && !record.collectedAt && !isAutoSettledWrapperApiDeath(record));
}

function terminalCollectedRecord(record) {
  return Boolean(record) && isTerminalWorkerStatus(record.transportStatus) && Boolean(record.collectedAt) && (isSettledWorker(record) || record.awaitingVerdict === true || record.acceptance === "unverified");
}

function peerIdentityBackfill(record, identity, env) {
  const additions = Object.fromEntries(Object.entries(identity).filter(([key, value]) => value != null && record[key] == null));
  if (Object.keys(additions).length === 0) {
    return null;
  }
  return withPeerFailureKind({ ...record, ...additions }, env);
}

function taskNotificationTextParts(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(taskNotificationTextParts);
  }
  if (value && typeof value === "object" && value.type === "text" && typeof value.text === "string") {
    return [value.text];
  }
  return [];
}

function notificationField(block, names) {
  for (const name of names) {
    const match = new RegExp(`<${name}\\s*>\\s*([\\s\\S]*?)\\s*</${name}\\s*>`, "i").exec(block);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return null;
}

function taskNotificationsFromTranscriptLine(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return [];
  }
  const texts = taskNotificationTextParts(entry.message?.content).concat(taskNotificationTextParts(entry.content));
  const notifications = [];
  for (const text of texts) {
    const blocks = text.matchAll(/<task-notification(?:\s[^>]*)?\s*>([\s\S]*?)<\/task-notification\s*>/gi);
    for (const block of blocks) {
      const taskId = /<task-id\s*>\s*([^<\s]+)\s*<\/task-id\s*>/i.exec(block[1])?.[1] ?? null;
      const status = /<status\s*>\s*([^<]+?)\s*<\/status\s*>/i.exec(block[1])?.[1]?.trim().toLowerCase() ?? null;
      const outputFile = absoluteOutputFile(/<output-file\s*>\s*([^<]+?)\s*<\/output-file\s*>/i.exec(block[1])?.[1]?.trim());
      const notificationSummary = notificationField(block[1], ["notification-summary", "summary"]);
      const statusDetail = notificationField(block[1], ["status-detail", "status_detail", "detail"]);
      if (taskId && status && (SUCCESSFUL_TASK_NOTIFICATION_STATUSES.has(status) || CANCELLED_TASK_NOTIFICATION_STATUSES.has(status) || FAILED_TASK_NOTIFICATION_STATUSES.has(status))) {
        notifications.push({ taskId, status, outputFile, notificationSummary, statusDetail });
      }
    }
  }
  return notifications;
}

function taskNotificationScanOffset(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function initialTaskNotificationScanOffset(records) {
  const offsets = records.map((record) => taskNotificationScanOffset(record.parentTranscriptBytesAtDispatch)).filter((offset) => offset != null);
  return offsets.length > 0 ? Math.min(...offsets) : 0;
}

function parentTranscriptPathForTaskNotifications(records, input) {
  const configured = records.map((record) => record.parentTranscriptPath).find((transcriptPath) => typeof transcriptPath === "string" && path.isAbsolute(transcriptPath));
  if (configured) {
    return path.resolve(configured);
  }
  return typeof input.transcript_path === "string" && path.isAbsolute(input.transcript_path) ? path.resolve(input.transcript_path) : null;
}

function scanTaskNotifications(transcriptPath, requestedOffset) {
  let descriptor;
  try {
    descriptor = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(descriptor).size;
    const startOffset = Math.min(taskNotificationScanOffset(requestedOffset) ?? 0, size);
    const bytesToScan = Math.min(TASK_NOTIFICATION_SCAN_MAX_BYTES, size - startOffset);
    const notifications = new Map();
    let cursor = startOffset;
    let safeOffset = startOffset;
    let pending = Buffer.alloc(0);
    let skippingLongLine = false;
    let remaining = bytesToScan;

    while (remaining > 0) {
      const chunk = Buffer.allocUnsafe(Math.min(TASK_NOTIFICATION_SCAN_CHUNK_BYTES, remaining));
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, cursor);
      if (bytesRead === 0) {
        break;
      }
      const data = chunk.subarray(0, bytesRead);
      const chunkStart = cursor;
      let segmentStart = 0;
      while (segmentStart < data.length) {
        const lineEnd = data.indexOf(0x0a, segmentStart);
        const segmentEnd = lineEnd === -1 ? data.length : lineEnd;
        const segment = data.subarray(segmentStart, segmentEnd);
        if (!skippingLongLine) {
          if (pending.length + segment.length > TASK_NOTIFICATION_MAX_LINE_BYTES) {
            pending = Buffer.alloc(0);
            skippingLongLine = true;
          } else if (segment.length > 0) {
            pending = pending.length === 0 ? Buffer.from(segment) : Buffer.concat([pending, segment]);
          }
        }
        if (lineEnd === -1) {
          break;
        }
        if (!skippingLongLine && pending.length > 0) {
          for (const notification of taskNotificationsFromTranscriptLine(pending.toString("utf8").replace(/\r$/, ""))) {
            notifications.set(notification.taskId, notification);
          }
        }
        pending = Buffer.alloc(0);
        skippingLongLine = false;
        safeOffset = chunkStart + lineEnd + 1;
        segmentStart = lineEnd + 1;
      }
      cursor += bytesRead;
      remaining -= bytesRead;
      if (skippingLongLine) {
        safeOffset = cursor;
      }
    }
    return { notifications, offset: safeOffset };
  } catch {
    return null;
  } finally {
    if (descriptor != null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        void 0;
      }
    }
  }
}

function transcriptEntryContent(entry) {
  if (Array.isArray(entry?.message?.content)) {
    return entry.message.content;
  }
  return Array.isArray(entry?.content) ? entry.content : [];
}

function boundedTranscriptTailText(transcriptPath) {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) {
    return null;
  }
  let descriptor;
  try {
    descriptor = fs.openSync(transcriptPath, "r");
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0) {
      return null;
    }
    const bytesToRead = Math.min(TASK_NOTIFICATION_FINAL_SCAN_MAX_BYTES, stat.size);
    const start = stat.size - bytesToRead;
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    const parts = [];
    for (const line of text.split("\n")) {
      if (!line.trim() || Buffer.byteLength(line) > TASK_NOTIFICATION_MAX_LINE_BYTES) {
        continue;
      }
      try {
        for (const block of transcriptEntryContent(JSON.parse(line))) {
          if (block?.type === "text" && typeof block.text === "string") {
            parts.push(block.text);
          }
        }
      } catch {
        void 0;
      }
    }
    return parts.length > 0 ? parts.join("\n") : text;
  } catch {
    return null;
  } finally {
    if (descriptor != null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        void 0;
      }
    }
  }
}

function finalAssistantTextFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) {
    return null;
  }
  let descriptor;
  try {
    descriptor = fs.openSync(transcriptPath, "r");
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0) {
      return null;
    }
    const bytesToRead = Math.min(TASK_NOTIFICATION_FINAL_SCAN_MAX_BYTES, stat.size);
    const start = stat.size - bytesToRead;
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].replace(/\r$/, "");
      if (!line.trim() || Buffer.byteLength(line) > TASK_NOTIFICATION_MAX_LINE_BYTES) {
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const content = transcriptEntryContent(entry);
      if (entry?.type === "assistant") {
        if (content.some((block) => block?.type === "tool_use")) {
          return null;
        }
        const blocks = content.filter((block) => block?.type === "text" && typeof block.text === "string" && block.text.length > 0).map((block) => block.text);
        if (blocks.length > 0) {
          return blocks.join("\n");
        }
      } else if (entry?.type === "user" && (entry.toolUseResult != null || content.some((block) => block?.type === "tool_result"))) {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (descriptor != null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        void 0;
      }
    }
  }
}

function taskNotificationTransition(record, notification, now, env) {
  const { status } = notification;
  const refreshed = refreshWorkerTranscript(record, record.transcriptPath);
  if (SUCCESSFUL_TASK_NOTIFICATION_STATUSES.has(status)) {
    const finalText = finalAssistantTextFromTranscript(refreshed.transcriptPath);
    const peerIdentity = PEER_JOB_FOOTER_AGENTS.has(refreshed.agentType)
      ? capturedPeerIdentity(refreshed.agentType, finalText ?? boundedTranscriptTailText(refreshed.transcriptPath), refreshed.peerEngine)
      : {};
    if (!finalText) {
      const turnLimited = refreshed.failureKind === "turn_limit" || (refreshed.turns ?? 0) >= (refreshed.limits?.maxTurns ?? Number.POSITIVE_INFINITY);
      return settleQueuedVerdict({
        ...refreshed,
        transportStatus: "incomplete",
        failureKind: turnLimited ? "turn_limit" : "missing_final_text",
        ...peerIdentity,
        finishedAt: refreshed.finishedAt ?? now,
        lastActivityAt: now
      }, now, env);
    }
    let finalTextFile = null;
    try {
      finalTextFile = writeFinalTextArtifact(refreshed, finalText, env);
    } catch {
      finalTextFile = null;
    }
    if (!finalTextFile) {
      return settleQueuedVerdict({
        ...refreshed,
        transportStatus: "incomplete",
        failureKind: "delivery",
        ...peerIdentity,
        finishedAt: refreshed.finishedAt ?? now,
        lastActivityAt: now
      }, now, env);
    }
    const harnessAsyncDelivery = collectedHarnessAsyncDelivery(refreshed, "done");
    return settleQueuedVerdict({
      ...markWorkerCollected(refreshed, WORKER_COLLECTION_METHODS.TASK_NOTIFICATION, now),
      transportStatus: "done",
      failureKind: harnessAsyncDelivery ? null : refreshed.failureKind,
      ...(harnessAsyncDelivery ? { deliveryMode: "harness_async" } : {}),
      outputFile: finalTextFile,
      ...peerIdentity,
      finishedAt: refreshed.finishedAt ?? now,
      lastActivityAt: now
    }, now, env);
  }
  const cancelled = CANCELLED_TASK_NOTIFICATION_STATUSES.has(status);
  const fallbackFailureKind = cancelled ? "cancelled" : "task_failed";
  const terminal = {
    ...markWorkerCollected(refreshed, WORKER_COLLECTION_METHODS.TASK_NOTIFICATION, now),
    transportStatus: cancelled ? "cancelled" : "failed",
    failureKind: refreshed.failureKind && refreshed.failureKind !== "unexpected_async" ? refreshed.failureKind : fallbackFailureKind,
    finishedAt: refreshed.finishedAt ?? now,
    lastActivityAt: now
  };
  return cancelled ? settleQueuedVerdict(terminal, now, env) : settleWrapperApiDeath(terminal, statusEvidence(notification), now, env);
}

function reconcileTaskNotifications(input, env) {
  try {
    const candidates = sessionRecords(input.session_id, env).filter((record) => !isTerminalWorkerStatus(record.transportStatus) && [record.backgroundTaskId, record.agentId].some((taskId) => typeof taskId === "string" && taskId));
    if (candidates.length === 0) {
      return;
    }
    const transcriptPath = parentTranscriptPathForTaskNotifications(candidates, input);
    if (!transcriptPath) {
      return;
    }
    const sessionState = readWorkerSessionState(input.session_id, env);
    const scanOffset = sessionState?.taskNotificationTranscriptPath === transcriptPath
      ? taskNotificationScanOffset(sessionState.taskNotificationScanOffset) ?? initialTaskNotificationScanOffset(candidates)
      : initialTaskNotificationScanOffset(candidates);
    const scanned = scanTaskNotifications(transcriptPath, scanOffset);
    if (!scanned) {
      return;
    }
    const now = new Date().toISOString();
    for (const [taskId, notification] of scanned.notifications) {
      for (const record of candidates.filter((candidate) => [candidate.backgroundTaskId, candidate.agentId].includes(taskId))) {
        const stamped = updateLifecycleWorkerRecord(record.taskId, env, (current) => {
          if (!current || current.sessionId !== input.session_id || isTerminalWorkerStatus(current.transportStatus) || ![current.backgroundTaskId, current.agentId].includes(taskId)) {
            return null;
          }
          const currentTranscriptExists = regularFileExists(current.transcriptPath);
          return {
            ...current,
            ...(notification.outputFile && (!current.transcriptPath || !currentTranscriptExists) ? { transcriptPath: notification.outputFile } : {}),
            ...(notification.notificationSummary ? { notificationSummary: notification.notificationSummary } : {}),
            ...(notification.statusDetail ? { statusDetail: notification.statusDetail } : {})
          };
        });
        if (!stamped || stamped.sessionId !== input.session_id || isTerminalWorkerStatus(stamped.transportStatus) || ![stamped.backgroundTaskId, stamped.agentId].includes(taskId)) {
          continue;
        }
        updateLifecycleWorkerRecord(record.taskId, env, (current) => {
          if (!current || current.sessionId !== input.session_id || isTerminalWorkerStatus(current.transportStatus) || ![current.backgroundTaskId, current.agentId].includes(taskId)) {
            return null;
          }
          return taskNotificationTransition(current, notification, now, env);
        });
      }
    }
    updateWorkerSessionState(input.session_id, env, (current) => ({
      ...(current ?? {}),
      taskNotificationTranscriptPath: transcriptPath,
      taskNotificationScanOffset: scanned.offset
    }));
  } catch {
    void 0;
  }
}

function armInFlightRecords(records, tasks, env) {
  const inFlight = records.filter((record) => !terminalTransportObserved(record, runtimeTaskForRecord(record, tasks)));
  const armedAt = new Date().toISOString();
  const armed = [];
  for (const record of inFlight) {
    const updated = updateLifecycleWorkerRecord(record.taskId, env, (current) => {
      if (!current || terminalTransportObserved(current, runtimeTaskForRecord(current, tasks))) {
        return null;
      }
      return {
        ...current,
        awaitingCollection: true,
        awaitingCollectionArmedAt: current.awaitingCollectionArmedAt ?? armedAt
      };
    });
    if (updated && !terminalTransportObserved(updated, runtimeTaskForRecord(updated, tasks))) {
      armed.push(updated);
    }
  }
  return armed;
}

function unjudgedPeerCollections(sessionId, env) {
  return readWorkerRecords(env, { strict: true }).filter((record) => record.sessionId === sessionId && record.completionContract === "collector" && record.peerJobId && record.peerTransportStatus && !isSettledWorker(record));
}

function unreportedCollectorFailures(sessionId, env) {
  return readWorkerRecords(env, { strict: true }).filter((record) => record.sessionId === sessionId && isTerminalWorkerStatus(record.transportStatus) && record.completionContract === "collector" && record.failureKind && !record.failureReportedAt);
}

function collectorResultCommand(record) {
  const engine = record.peerEngine ?? record.expectedPeerEngine;
  const jobId = record.peerJobId ?? record.expectedPeerJobId;
  return ["codex", "grok"].includes(engine) && /^[a-f0-9]{32}$/.test(jobId ?? "") ? `/${engine}:result ${jobId}` : null;
}

function settlementCommand(records) {
  return `/fusion:stats --record ${records.map((record) => `${record.taskId}=accepted|rejected|unverified`).join(" --record ")}`;
}

function collectorStopGate(input, env) {
  const finalMessage = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
  const collectorFailures = unreportedCollectorFailures(input.session_id, env);
  const missingFailureReports = [];
  for (const record of collectorFailures) {
    const jobId = record.peerJobId ?? record.expectedPeerJobId;
    const resultCommand = collectorResultCommand(record);
    const acknowledged = finalMessage.includes(record.taskId) && (!jobId || finalMessage.includes(jobId)) && /\buncollected\b/i.test(finalMessage) && (!resultCommand || finalMessage.includes(resultCommand));
    if (acknowledged) {
      const reportedAt = new Date().toISOString();
      updateLifecycleWorkerRecord(record.taskId, env, (current) => ({
        ...current,
        failureReportedAt: reportedAt,
        ...(current.failureKind === "collection_protocol" ? { protocolReportedAt: reportedAt } : {})
      }));
    } else {
      updateLifecycleWorkerRecord(record.taskId, env, (current) => ({ ...current, failureStopBlockCount: (current.failureStopBlockCount ?? 0) + 1 }));
      missingFailureReports.push(record);
    }
  }
  if (missingFailureReports.length > 0) {
    const commands = missingFailureReports.map(collectorResultCommand).filter(Boolean);
    const commandInstruction = commands.length > 0 ? ` Include ${commands.join(" or ")}.` : "";
    writeOutput(blockStop(tagMessage("worker-lifecycle.collector-reporting-block", `Collector failure reporting is incomplete for ${missingFailureReports.map((record) => {
      const engine = record.peerEngine ?? record.expectedPeerEngine;
      const jobId = record.peerJobId ?? record.expectedPeerJobId;
      const identity = engine && jobId ? `${engine}:${jobId}` : jobId ? `job=${jobId}` : "peer identity unavailable";
      return `${record.taskId} (${record.failureKind}, ${identity})`;
    }).join(", ")}. Report each Fusion task id and every available peer job id, and state explicitly that the peer result remains uncollected.${commandInstruction}`)));
    return true;
  }
  const unjudged = unjudgedPeerCollections(input.session_id, env);
  if (unjudged.length > 0) {
    const settlementRecords = unjudged.filter((record) => ["codex", "grok"].includes(record.peerEngine));
    const manualRecords = unjudged.filter((record) => !["codex", "grok"].includes(record.peerEngine));
    const instructions = [
      settlementRecords.length > 0 ? `record the judgments in one command: ${settlementCommand(settlementRecords)}` : null,
      ...manualRecords.map((record) => `complete a manual resolution because the collection for Fusion task ${record.taskId} needs manual resolution`)
    ].filter(Boolean);
    writeOutput(blockStop(tagMessage("worker-lifecycle.semantic-judgment-block", `Collected peer transport results still require an explicit semantic judgment before finishing: ${unjudged.map((record) => `${record.peerEngine}:${record.peerJobId} (task=${record.taskId}, transport=${record.peerTransportStatus}, semantic=${record.peerSemanticStatus ?? "unverified"})`).join(", ")}. After checking the requested completion criteria, ${instructions.join("; ")}.`)));
    return true;
  }
  return false;
}

function writeAcceptanceAdvisory(records, env) {
  const unverified = settleOnlyRecords(rereadPendingRecords(records, isPendingSettlement, env));
  if (unverified.length === 0) {
    return;
  }
  const workers = unverified.map((record) => `${record.taskId} (${[record.agentType, record.description].filter((value) => typeof value === "string" && value.trim()).join(", ")})`);
  writeOutput(hookOutput("Stop", tagMessage("worker-lifecycle.acceptance-advisory", `Acceptance remains unverified for ${unverified.length} collected Fusion worker${unverified.length === 1 ? "" : "s"}: ${workers.join("; ")}. Settle the pending wave in one command: ${settlementCommand(unverified)}. pairs are <id>=<verdict> with id either a fusion task id (fusion- plus 24 lowercase hex) or an engine job id (32 lowercase hex), verdict one of accepted|rejected|unverified.`)));
}

function terminalCollectionInstruction(record) {
  const collectId = record.backgroundTaskId ?? record.agentId;
  const identity = [record.agentType, record.description].filter((value) => typeof value === "string" && value.trim()).join(", ");
  const worker = `${record.taskId}${identity ? ` (${identity})` : ""}`;
  return record.outputFile
    ? `Call Read with file_path=${record.outputFile} to collect the terminal output for Fusion task ${worker} before finishing.`
    : collectId ? `Call TaskOutput with block=true for terminal owned task ${collectId} and collect Fusion task ${worker} before finishing.` : `Collect terminal owned task ${worker} before finishing.`;
}

export function settleOnlyRecords(records) {
  return records.filter(isPendingSettlement);
}

function rereadPendingRecords(records, predicate, env) {
  return records.map((record) => readWorkerRecord(record.taskId, env)).filter((record) => record && predicate(record));
}

function settleDemandStaleMs(env) {
  const raw = env[SETTLE_DEMAND_STALE_MS_ENV];
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
    return DEFAULT_SETTLE_DEMAND_STALE_MS;
  }
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_SETTLE_DEMAND_STALE_MS;
}

function hasStaleSettlement(records, env, now = Date.now()) {
  const oldestCollectedAt = Math.min(...records.map((record) => Date.parse(record.collectedAt ?? "")).filter(Number.isFinite));
  return Number.isFinite(oldestCollectedAt) && now - oldestCollectedAt > settleDemandStaleMs(env);
}

function writeSettlementDemand(records, env) {
  const current = rereadPendingRecords(records, isPendingSettlement, env);
  if (current.length === 0) {
    return false;
  }
  writeOutput(blockStop(tagMessage("worker-lifecycle.acceptance-required-block", `Collected Fusion worker results still require explicit acceptance before finishing. Settle the pending wave in one command: ${settlementCommand(current)}.`)));
  return true;
}

function writeTerminalCollectionPending(records, env) {
  const terminalUncollected = rereadPendingRecords(records, terminalCollectionPending, env);
  if (terminalUncollected.length === 0) {
    return false;
  }
  const instructions = terminalUncollected.map(terminalCollectionInstruction);
  instructions.push(
    "Transport completion remains unverified until the result and verification evidence are reviewed. Record accepted or rejected explicitly through /fusion:stats."
  );
  writeOutput(blockStop(tagMessage("worker-lifecycle.terminal-collection-block", instructions.join(" "))));
  return true;
}

function taskSetSignature(records) {
  return records.map((record) => record.taskId).sort().join(",");
}

function inFlightPendingState(record) {
  return terminalCollectionPending(record) ? "awaiting-collection" : "in-flight";
}

function inFlightAdvisorySignature(records) {
  return records
    .filter((record) => !terminalCollectedRecord(record))
    .map((record) => `${record.taskId}:${inFlightPendingState(record)}`)
    .sort()
    .join(",");
}

export function reverifyInFlightRecords(records, tasks, env = process.env) {
  return records
    .map((record) => readWorkerRecord(record.taskId, env))
    .filter((record) => record && !terminalCollectedRecord(record) && !terminalTransportObserved(record, runtimeTaskForRecord(record, tasks)));
}

export function runtimeTaskMissing(record, hasBackgroundTasks, tasks) {
  return hasBackgroundTasks ? !runtimeTaskForRecord(record, tasks) : (record.cancelAttemptCount ?? 0) >= 2;
}

export function needsCancellation(record) {
  return record.transportStatus === "cancel_requested" || (!record.userBackgroundAuthorized && !["ready_uncollected", "ready_background"].includes(record.transportStatus) && (record.stopBlockCount ?? 0) >= 6);
}

export function reverifyCancellationRecords(records, env = process.env) {
  return records
    .map((record) => readWorkerRecord(record.taskId, env))
    .filter((record) => record && !terminalCollectedRecord(record) && needsCancellation(record));
}

function claimStopAdvisory(sessionId, kind, signature, env) {
  let claimed = false;
  updateWorkerSessionState(sessionId, env, (current) => {
    if (current?.stopAdvisorySignatures?.[kind] === signature) {
      return null;
    }
    claimed = true;
    return {
      ...(current ?? {}),
      stopAdvisorySignatures: { ...(current?.stopAdvisorySignatures ?? {}), [kind]: signature }
    };
  });
  return claimed;
}

function claimSettleOnlyAdvisory(sessionId, signature, env) {
  let claimed = false;
  updateWorkerSessionState(sessionId, env, (current) => {
    if (current?.settleOnlyAdvisorySignature === signature) {
      return null;
    }
    claimed = true;
    return { ...(current ?? {}), settleOnlyAdvisorySignature: signature };
  });
  return claimed;
}

function clearSettleOnlyAdvisory(sessionId, env) {
  updateWorkerSessionState(sessionId, env, (current) => {
    if (!current || !("settleOnlyAdvisorySignature" in current)) {
      return null;
    }
    const { settleOnlyAdvisorySignature, ...next } = current;
    return next;
  });
}

function writeWrapperApiDeathRedispatchAdvisory(sessionId, env) {
  const records = sessionRecords(sessionId, env).filter((record) => isAutoSettledWrapperApiDeath(record) && typeof record.briefFile === "string" && !record.redispatchAdvisoryAt);
  if (records.length === 0) {
    return false;
  }
  const advisedAt = new Date().toISOString();
  const advised = [];
  for (const record of records) {
    const updated = updateLifecycleWorkerRecord(record.taskId, env, (current) => current && isAutoSettledWrapperApiDeath(current) && !current.redispatchAdvisoryAt
      ? { ...current, redispatchAdvisoryAt: advisedAt }
      : null);
    if (updated?.redispatchAdvisoryAt === advisedAt) {
      advised.push(updated);
    }
  }
  if (advised.length === 0) {
    return false;
  }
  writeOutput(hookOutput("Stop", tagMessage("worker-lifecycle.wrapper-death-context", `Fusion wrapper API death: redispatch ${advised.map((record) => `${record.taskId} from ${record.briefFile}`).join("; ")}.`)));
  return true;
}

function handleStop(input, env) {
  const hasBackgroundTasks = Array.isArray(input.background_tasks);
  const tasks = hasBackgroundTasks ? input.background_tasks : [];
  reconcileTaskNotifications(input, env);
  const initialRecords = sessionRecords(input.session_id, env);
  if (initialRecords.every((record) => !terminalCollectionPending(record)) && collectorStopGate(input, env)) {
    armInFlightRecords(initialRecords, tasks, env);
    return;
  }
  const pending = [];
  for (const record of activeSessionRecords(input.session_id, env)) {
    const task = runtimeTaskForRecord(record, tasks);
    const observedTerminal = terminalTransportObserved(record, task);
    const failure = observedTerminal ? null : workerBudgetFailure(record);
    const now = new Date().toISOString();
    const updated = updateLifecycleWorkerRecord(record.taskId, env, (current) => {
      if (!current || isTerminalWorkerStatus(current.transportStatus)) {
        return null;
      }
      const worker = current;
      const wrapperApiDeath = runtimeTaskFailed(task) && wrapperApiDeathEvidence(worker, statusEvidence(task));
      const transportStatus = wrapperApiDeath ? "failed" : failure ? "cancel_requested" : runtimeTaskIsTerminal(task) ? "ready_uncollected" : ["ready_uncollected", "ready_background", "cancel_requested"].includes(worker.transportStatus) ? worker.transportStatus : "pending_async";
      const advisoryRound = !failure && transportStatus === "pending_async";
      const successfulTerminal = !failure && worker.failureKind !== "unexpected_async" && runtimeTaskSucceeded(task);
      const transitioned = {
        ...worker,
        ...(task?.id ? { backgroundTaskId: task.id } : {}),
        transportStatus,
        failureKind: wrapperApiDeath ? "delivery" : failure?.failureKind ?? (successfulTerminal ? null : worker.failureKind),
        ...(successfulTerminal && worker.failureKind ? { recoveredFailureKind: worker.failureKind } : {}),
        cancelReason: failure?.reason ?? worker.cancelReason,
        stopBlockCount: advisoryRound ? worker.stopBlockCount ?? 0 : (worker.stopBlockCount ?? 0) + 1,
        ...(wrapperApiDeath ? { finishedAt: worker.finishedAt ?? now, lastActivityAt: now } : {})
      };
      return wrapperApiDeath ? settleWrapperApiDeath(transitioned, statusEvidence(task), now, env) : transitioned;
    });
    pending.push(updated);
  }
  const cancellations = pending.filter(needsCancellation);
  const verifiedCancellations = reverifyCancellationRecords(cancellations, env);
  if (verifiedCancellations.length > 0) {
    const now = new Date().toISOString();
    const missingRuntimeIds = verifiedCancellations.filter((record) => !record.backgroundTaskId && !record.agentId);
    for (const record of missingRuntimeIds) {
      updateLifecycleWorkerRecord(record.taskId, env, (current) => {
        if (!current || isTerminalWorkerStatus(current.transportStatus)) {
          return null;
        }
        return settleQueuedVerdict({ ...current, transportStatus: "failed", failureKind: current.failureKind ?? "owner_lost", finishedAt: now }, now, env);
      });
    }
    const reapedTaskIds = [];
    for (const record of verifiedCancellations.filter((candidate) => candidate.backgroundTaskId || candidate.agentId)) {
      if (!runtimeTaskMissing(record, hasBackgroundTasks, tasks)) {
        continue;
      }
      const settled = settleReapedIfActive(record.taskId, now, env, () => true);
      if (settled) {
        reapedTaskIds.push(record.taskId);
      }
    }
    const reapedSentence = reapedTaskIds.length > 0 ? `Fusion task IDs ${reapedTaskIds.join(", ")} were settled as task_reaped because the harness no longer tracks their runtime tasks.` : "";
    const reapedSuffix = reapedSentence ? ` ${reapedSentence}` : "";
    const cancelIds = verifiedCancellations.filter((record) => !reapedTaskIds.includes(record.taskId)).map((record) => record.backgroundTaskId ?? record.agentId).filter(Boolean);
    if (cancelIds.length > 0) {
      writeOutput(blockStop(tagMessage("worker-lifecycle.over-budget-stop-block", `Call TaskStop for over-budget task${cancelIds.length === 1 ? "" : "s"} ${cancelIds.join(", ")} and report the cancellation before finishing.${reapedSuffix}`)));
      return;
    }
    if (missingRuntimeIds.length > 0) {
      writeOutput(blockStop(tagMessage("worker-lifecycle.pre-runtime-failure-block", `Fusion task${missingRuntimeIds.length === 1 ? "" : "s"} ${missingRuntimeIds.map((record) => record.taskId).join(", ")} failed before a runtime task id was available. Report the failure before finishing.${reapedSuffix}`)));
      return;
    }
    if (reapedSentence) {
      writeOutput(hookOutput("Stop", tagMessage("worker-lifecycle.task-reaped-context", reapedSentence)));
      return;
    }
  }
  const currentRecords = sessionRecords(input.session_id, env);
  const inFlight = armInFlightRecords(currentRecords, tasks, env);
  const terminalUncollected = currentRecords.filter(terminalCollectionPending);
  const settleOnly = settleOnlyRecords(currentRecords);
  const settleOnlySignature = settleOnly.length > 0 ? taskSetSignature(settleOnly) : null;
  if (!settleOnlySignature) {
    clearSettleOnlyAdvisory(input.session_id, env);
  }
  if (terminalUncollected.length > 0) {
    writeTerminalCollectionPending(terminalUncollected, env);
    return;
  }
  if (settleOnly.length > 0) {
    const hasInFlightSibling = currentRecords.some((record) => !isTerminalWorkerStatus(record.transportStatus));
    if ((!hasInFlightSibling && settleOnly.length > 1) || hasStaleSettlement(settleOnly, env)) {
      writeSettlementDemand(settleOnly, env);
      return;
    }
    if (!input.stop_hook_active && claimSettleOnlyAdvisory(input.session_id, settleOnlySignature, env)) {
      writeAcceptanceAdvisory(settleOnly, env);
    }
    return;
  }
  if (inFlight.length > 0) {
    const verifiedInFlight = reverifyInFlightRecords(inFlight, tasks, env);
    if (verifiedInFlight.length === 0) {
      return;
    }
    const signature = inFlightAdvisorySignature(verifiedInFlight);
    if (!input.stop_hook_active && claimStopAdvisory(input.session_id, "in-flight", signature, env)) {
      writeOutput(hookOutput("Stop", tagMessage("worker-lifecycle.in-flight-context", `Fusion task${verifiedInFlight.length === 1 ? "" : "s"} ${verifiedInFlight.map((record) => record.taskId).join(", ")} ${verifiedInFlight.length === 1 ? "is" : "are"} still in flight. Collection is armed and will be required after terminal notification.`)));
    }
    return;
  }
  writeWrapperApiDeathRedispatchAdvisory(input.session_id, env);
}

function handleSessionEnd(input, env) {
  const now = new Date().toISOString();
  for (const record of activeSessionRecords(input.session_id, env)) {
    updateLifecycleWorkerRecord(record.taskId, env, (current) => {
      if (!current || isTerminalWorkerStatus(current.transportStatus)) {
        return null;
      }
      return settleQueuedVerdict({
        ...current,
        transportStatus: "owner_ended",
        failureKind: current.failureKind ?? "owner_lost",
        finishedAt: now
      }, now, env);
    });
  }
}

function runHook(input, env = process.env) {
  switch (input.hook_event_name) {
    case "PreToolUse":
      handlePreToolUse(input, env);
      break;
    case "PostToolUse":
      handlePostToolUse(input, env, false);
      break;
    case "PostToolUseFailure":
      handlePostToolUse(input, env, true);
      break;
    case "SubagentStart":
      handleSubagentStart(input, env);
      break;
    case "SubagentStop":
      handleSubagentStop(input, env);
      break;
    case "Stop":
      handleStop(input, env);
      break;
    case "SessionEnd":
      handleSessionEnd(input, env);
      break;
    default:
      break;
  }
}

function main() {
  const input = readHookInput();
  if (!input) {
    return;
  }
  try {
    runHook(input);
  } catch {
    if (input.hook_event_name === "PreToolUse") {
      writeOutput(denyTool(tagMessage("worker-lifecycle.state-unavailable", "Fusion lifecycle state is unavailable. Retry after restoring private worker state access.")));
    } else if (input.hook_event_name === "Stop" || input.hook_event_name === "SubagentStop") {
      writeOutput(blockStop(tagMessage("worker-lifecycle.state-unavailable", "Fusion lifecycle state is unavailable. Restore private worker state access before ending this task.")));
    }
  }
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  main();
}

export { runHook };
