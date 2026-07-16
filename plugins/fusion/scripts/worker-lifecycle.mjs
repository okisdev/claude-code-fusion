#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalWorkerAgentType,
  createWorkerRecord,
  createWorkerTaskId,
  findWorkerRecord,
  isFusionWorkerAgent,
  isTerminalWorkerStatus,
  readWorkerRecords,
  refreshWorkerTranscript,
  updateWorkerRecord
} from "./lib/worker-state.mjs";

const BRIEF_MAX_BYTES_ENV = "FUSION_WORKER_BRIEF_MAX_BYTES";
const WALL_CLOCK_MS_ENV = "FUSION_WORKER_WALL_CLOCK_MS";
const STALL_MS_ENV = "FUSION_WORKER_STALL_MS";
const MAX_TURNS_ENV = "FUSION_WORKER_MAX_TURNS";
const MAX_OUTPUT_TOKENS_ENV = "FUSION_WORKER_MAX_OUTPUT_TOKENS";
const MAX_UNCACHED_TOKENS_ENV = "FUSION_WORKER_MAX_UNCACHED_TOKENS";
const DEFAULT_BRIEF_MAX_BYTES = 16 * 1024;
const EXECUTION_END_MARKER = /(?:^|\n)delivery:\s*complete\s*\r?\nverification:\s*passed\s*$/i;
const COVERAGE_END_MARKER = /(?:^|\n)delivery:\s*complete\s*\r?\ncoverage:\s*complete\s*$/i;
const COLLECTOR_END_MARKER = /(?:^|\n)collector:\s*(?:state=|timeout\b|dead\b|status-error\b).*$/i;
const COLLECTOR_TERMINAL_MARKER = /^collector:\s*state=(done|error|cancelled|completed|failed)\s+semantic=(accepted|rejected|unverified)\s+engine=(codex|grok)\s+job=([a-f0-9]{32})\s+elapsed=(\d+)s$/i;
const COLLECTOR_OUTCOME_MARKER = /^collector:\s*(timeout|dead|status-error)\s+engine=(codex|grok)\s+job=([a-f0-9]{32})\s+elapsed=(\d+)s$/i;
const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch"]);
const EXECUTION_AGENTS = new Set(["fusion:fast-worker", "fusion:trivial-worker"]);
const BRIEF_AGENTS = new Set(["fusion:fast-worker", "fusion:trivial-worker", "fusion:deep-reasoner"]);
const PEER_WRAPPER_AGENTS = new Set(["codex:codex-rescue", "codex-rescue", "grok:grok-rescue", "grok-rescue"]);
const MANAGED_PEER_AGENTS = new Set(["grok:grok-review-runner", "grok-review-runner"]);

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

export function workerLimits(agentType, env = process.env) {
  const canonical = canonicalWorkerAgentType(agentType);
  const defaults = canonical === "fusion:trivial-worker"
    ? { wallClockMs: 180_000, stallMs: 90_000, maxTurns: 12, maxOutputTokens: 8_000, maxUncachedTokens: 40_000 }
    : canonical === "fusion:job-collector"
      ? { wallClockMs: 540_000, stallMs: 540_000, maxTurns: 6, maxOutputTokens: 8_000, maxUncachedTokens: 30_000 }
      : canonical === "fusion:deep-reasoner"
        ? { wallClockMs: 480_000, stallMs: 300_000, maxTurns: 30, maxOutputTokens: 24_000, maxUncachedTokens: 120_000 }
        : { wallClockMs: 480_000, stallMs: 180_000, maxTurns: 40, maxOutputTokens: 24_000, maxUncachedTokens: 120_000 };
  return {
    wallClockMs: positiveInteger(env, WALL_CLOCK_MS_ENV, defaults.wallClockMs),
    stallMs: positiveInteger(env, STALL_MS_ENV, defaults.stallMs),
    maxTurns: positiveInteger(env, MAX_TURNS_ENV, defaults.maxTurns),
    maxOutputTokens: positiveInteger(env, MAX_OUTPUT_TOKENS_ENV, defaults.maxOutputTokens),
    maxUncachedTokens: positiveInteger(env, MAX_UNCACHED_TOKENS_ENV, defaults.maxUncachedTokens)
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

function allowAgentWithTaskId(toolInput, taskId) {
  const prompt = promptText(toolInput);
  const marker = `fusion-task-id: ${taskId}`;
  const lines = prompt.split(/\r?\n/).filter((line) => !/^fusion-task-id:\s*/i.test(line.trim()));
  lines.splice(lines[0]?.trim() === "fusion-brief: v1" ? 1 : 0, 0, marker);
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...toolInput, prompt: lines.join("\n") } } };
}

function writeOutput(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function promptText(toolInput) {
  return typeof toolInput?.prompt === "string" ? toolInput.prompt : "";
}

export function validateWorkerBrief(prompt, agentType, env = process.env) {
  const canonical = canonicalWorkerAgentType(agentType);
  if (!BRIEF_AGENTS.has(canonical)) {
    return { ok: true };
  }
  const maximumBytes = positiveInteger(env, BRIEF_MAX_BYTES_ENV, DEFAULT_BRIEF_MAX_BYTES);
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
  return { ok: true };
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

export function latestUserRequestedBackground(transcriptPath) {
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

function createDispatch(input, agentType, userBackgroundAuthorized, env) {
  const taskId = createWorkerTaskId(input.session_id, input.tool_use_id);
  const collectorIdentity = canonicalWorkerAgentType(agentType) === "fusion:job-collector" ? collectorRequestIdentity(promptText(input.tool_input)) : null;
  let parentTranscriptBytesAtDispatch = null;
  try {
    parentTranscriptBytesAtDispatch = fs.statSync(input.transcript_path).size;
  } catch {
    void 0;
  }
  return createWorkerRecord({
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
    completionContract: completionContract(agentType, promptText(input.tool_input)),
    ...collectorIdentity,
    limits: workerLimits(agentType, env)
  }, env);
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
      return updateWorkerRecord(exact.taskId, env, (current) => ({ ...current, agentId: input.agent_id }));
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
  return updateWorkerRecord(record.taskId, env, (current) => refreshWorkerTranscript(current ?? record, transcriptPath));
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
  if (EXECUTION_AGENTS.has(canonicalWorkerAgentType(record.agentType))) {
    const progressAt = Date.parse(record.lastProgressAt ?? record.startedAt ?? record.createdAt ?? "");
    if (Number.isFinite(progressAt) && now - progressAt >= limits.stallMs) {
      return { failureKind: "stall", reason: `no-progress budget reached (${limits.stallMs}ms)` };
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
  return updateWorkerRecord(record.taskId, env, (current) => ({
    ...(current ?? record),
    transportStatus: "cancel_requested",
    failureKind: failure.failureKind,
    cancelReason: failure.reason,
    cancelRequestedAt: new Date().toISOString()
  }));
}

function completedReport(record, message) {
  const normalized = message.trimEnd();
  if (record.completionContract === "collector" || canonicalWorkerAgentType(record.agentType) === "fusion:job-collector") {
    return COLLECTOR_END_MARKER.test(normalized);
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
  if (input.tool_name === "Agent" || input.tool_name === "Task") {
    const agentType = input.tool_input?.subagent_type;
    if (PEER_WRAPPER_AGENTS.has(agentType)) {
      if (input.tool_input?.run_in_background === true) {
        writeOutput(denyTool("Codex and Grok wrapper Agents use foreground delivery. Keep the Agent foreground; an explicitly requested companion `--background` receipt stays inside that foreground wrapper call."));
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
      writeOutput(denyTool("Fusion collector requests must contain exactly one `engine: codex|grok` line and one `job: <32 lowercase hexadecimal characters>` line."));
      return;
    }
    const validation = validateWorkerBrief(promptText(input.tool_input), agentType, env);
    if (!validation.ok) {
      writeOutput(denyTool(validation.reason));
      return;
    }
    const requestsBackground = input.tool_input?.run_in_background === true;
    const userBackgroundAuthorized = requestsBackground && latestUserRequestedBackground(input.transcript_path);
    if (requestsBackground && !userBackgroundAuthorized) {
      writeOutput(denyTool("Fusion workers may detach only when the latest user message explicitly contains `--background`. Remove background mode and collect the result in this turn."));
      return;
    }
    const record = createDispatch(input, agentType, userBackgroundAuthorized, env);
    writeOutput(allowAgentWithTaskId(input.tool_input, record.taskId));
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
  const failure = workerBudgetFailure(refreshed);
  if (failure) {
    markBudgetFailure(refreshed, failure, env);
    writeOutput(denyTool(`Fusion worker ${refreshed.taskId} must stop: ${failure.reason}. Return a concise partial result now; do not retry or call more tools.`));
    return;
  }
  updateWorkerRecord(refreshed.taskId, env, (current) => ({ ...current, lastActivityAt: new Date().toISOString() }));
}

function handlePostToolUse(input, env, failed = false) {
  if (!input.agent_id && ["Read", "TaskOutput", "TaskStop"].includes(input.tool_name)) {
    const taskId = typeof input.tool_input?.task_id === "string" ? input.tool_input.task_id : null;
    const readPath = typeof input.tool_input?.file_path === "string" ? path.resolve(input.cwd, input.tool_input.file_path) : null;
    const matches = readWorkerRecords(env, { strict: true }).filter((record) => {
      if (record.sessionId !== input.session_id) {
        return false;
      }
      if (input.tool_name === "Read") {
        const partialRead = Object.hasOwn(input.tool_input ?? {}, "offset") || Object.hasOwn(input.tool_input ?? {}, "limit");
        return !partialRead && record.transportStatus === "ready_uncollected" && record.outputFile && path.resolve(record.outputFile) === readPath;
      }
      if (input.tool_name === "TaskOutput" && input.tool_input?.block !== true) {
        return false;
      }
      return taskId && [record.backgroundTaskId, record.agentId, record.taskId].includes(taskId);
    });
    if (!failed) {
      const now = new Date().toISOString();
      for (const record of matches) {
        updateWorkerRecord(record.taskId, env, (current) => ({
          ...current,
          transportStatus: input.tool_name === "TaskStop" ? "cancelled" : "done",
          acceptance: "unverified",
          failureKind: input.tool_name === "TaskStop" ? current.failureKind ?? "cancelled" : current.failureKind,
          collectionMethod: input.tool_name,
          collectedAt: input.tool_name === "TaskStop" ? current.collectedAt : now,
          finishedAt: current.finishedAt ?? now,
          lastActivityAt: now
        }));
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
      const outputFile = typeof response.outputFile === "string" ? response.outputFile : typeof nested.outputFile === "string" ? nested.outputFile : null;
      const record = createDispatch(input, agentType, false, env);
      updateWorkerRecord(record.taskId, env, (current) => ({
        ...current,
        ...(agentId ? { agentId, backgroundTaskId: agentId } : {}),
        ...(outputFile && path.isAbsolute(outputFile) ? { outputFile } : {}),
        transportStatus: "pending_async",
        runtimeAsync: true,
        failureKind: "unexpected_async"
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
      const outputFile = typeof response.outputFile === "string" ? response.outputFile : typeof nested.outputFile === "string" ? nested.outputFile : null;
      const isAsync = response.isAsync === true || nested.isAsync === true || response.status === "async_launched" || nested.status === "async_launched";
      const resolvedModel = typeof response.resolvedModel === "string" ? response.resolvedModel : typeof nested.resolvedModel === "string" ? nested.resolvedModel : null;
      const usageResponse = response.usage || response.totalTokens != null ? response : nested;
      const directUsage = canonicalToolResponseUsage(usageResponse);
      const completed = response.status === "completed" || nested.status === "completed";
      const totalToolUseCount = response.totalToolUseCount ?? nested.totalToolUseCount;
      updateWorkerRecord(pending.taskId, env, (current) => ({
        ...current,
        ...(agentId ? { agentId, backgroundTaskId: isAsync ? agentId : current.backgroundTaskId } : {}),
        ...(outputFile && path.isAbsolute(outputFile) && (!agentId || path.basename(outputFile).includes(agentId)) ? { outputFile, transcriptPath: outputFile } : {}),
        ...(resolvedModel ? { resolvedModel } : {}),
        ...(directUsage?.usage ? { usage: directUsage.usage, usageSource: "tool-response" } : {}),
        ...(directUsage ? { usageAvailability: directUsage.availability, reportedTotalTokens: directUsage.reportedTotalTokens } : {}),
        ...(Number.isFinite(response.totalDurationMs ?? nested.totalDurationMs) ? { durationMs: response.totalDurationMs ?? nested.totalDurationMs } : {}),
        ...(Number.isSafeInteger(totalToolUseCount) ? { toolCalls: totalToolUseCount, toolCallsSource: "tool-response" } : {}),
        transportStatus: failed ? "failed" : isAsync ? "pending_async" : completed && !isTerminalWorkerStatus(current.transportStatus) ? "done" : current.transportStatus === "dispatching" ? "running" : current.transportStatus,
        failureKind: failed ? "launch" : current.failureKind,
        finishedAt: failed || completed ? new Date().toISOString() : current.finishedAt,
        runtimeAsync: isAsync
      }));
    }
    return;
  }
  if (!isFusionWorkerAgent(input.agent_type)) {
    return;
  }
  const record = recordForAgent(input, env);
  if (!record) {
    return;
  }
  const now = new Date().toISOString();
  updateWorkerRecord(record.taskId, env, (current) => {
    const selectedTranscript = isAttributedTranscriptPath(input.transcript_path, record) ? input.transcript_path : null;
    const refreshed = selectedTranscript ? refreshWorkerTranscript(current ?? record, selectedTranscript) : current ?? record;
    const progress = !failed && !READ_ONLY_TOOLS.has(input.tool_name);
    return {
      ...refreshed,
      lastActivityAt: now,
      ...(progress ? { lastProgressAt: now, progressEvents: (refreshed.progressEvents ?? 0) + 1 } : {})
    };
  });
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
  const record = updateWorkerRecord(pending.taskId, env, (current) => ({
    ...current,
    agentId: input.agent_id,
    transportStatus: "running",
    startedAt: now,
    lastActivityAt: now,
    lastProgressAt: now
  }));
  const limits = record.limits;
  const delivery = record.completionContract === "collector"
    ? "Return the collector command output exactly, including its terminal `collector:` marker."
    : record.completionContract === "coverage"
      ? "End the completed analysis with separate lines `delivery: complete` and `coverage: complete`."
      : "End a successful execution report with separate lines `delivery: complete` and `verification: passed`.";
  writeOutput(hookOutput("SubagentStart", `Fusion task id: ${record.taskId}. Work only from the supplied isolated brief. Do not request or reconstruct the parent transcript. Budgets: ${limits.wallClockMs}ms wall clock, ${limits.stallMs}ms without execution progress, ${limits.maxTurns} turns, ${limits.maxOutputTokens} output tokens, ${limits.maxUncachedTokens} uncached tokens. Retry at most once. ${delivery}`));
}

function handleSubagentStop(input, env) {
  if (!isFusionWorkerAgent(input.agent_type)) {
    return;
  }
  const record = recordForAgent(input, env);
  if (!record) {
    return;
  }
  const refreshed = refreshRecord(record, input, env);
  const failure = workerBudgetFailure(refreshed);
  const message = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
  const complete = completedReport(refreshed, message);
  const collectorContract = refreshed.completionContract === "collector" || canonicalWorkerAgentType(refreshed.agentType) === "fusion:job-collector";
  const collectorReport = collectorContract ? structuredCollectorReport(message) : null;
  const collectorIdentityMismatch = collectorContract && collectorReport && (collectorReport.peerEngine !== refreshed.expectedPeerEngine || collectorReport.peerJobId !== refreshed.expectedPeerJobId);
  const trustedCollectorReport = collectorIdentityMismatch ? null : collectorReport;
  const legacyCollectorReport = collectorContract && complete && !collectorReport;
  const collectorProtocolFailure = legacyCollectorReport || collectorIdentityMismatch;
  if (collectorProtocolFailure && !failure && (refreshed.retryCount ?? 0) < 1 && !input.stop_hook_active) {
    updateWorkerRecord(refreshed.taskId, env, (current) => ({ ...current, retryCount: (current.retryCount ?? 0) + 1 }));
    const expected = refreshed.expectedPeerEngine && refreshed.expectedPeerJobId
      ? ` Repeat collection for exactly engine=${refreshed.expectedPeerEngine} job=${refreshed.expectedPeerJobId}.`
      : "";
    writeOutput(blockStop(`The collector returned an invalid or mismatched terminal marker.${expected} Return the exact collector command output with its terminal marker. This is the only retry.`));
    return;
  }
  if (!complete && !failure && (refreshed.retryCount ?? 0) < 1 && !input.stop_hook_active) {
    updateWorkerRecord(refreshed.taskId, env, (current) => ({ ...current, retryCount: (current.retryCount ?? 0) + 1 }));
    writeOutput(blockStop(retryInstruction(refreshed)));
    return;
  }
  const now = new Date().toISOString();
  updateWorkerRecord(refreshed.taskId, env, (current) => ({
    ...current,
    transportStatus: complete && (trustedCollectorReport?.kind === "outcome" || collectorProtocolFailure) ? "incomplete" : complete ? current.runtimeAsync ? current.userBackgroundAuthorized ? "ready_background" : "ready_uncollected" : "done" : failure ? "failed" : "incomplete",
    acceptance: "unverified",
    failureKind: failure?.failureKind ?? (trustedCollectorReport?.kind === "outcome" ? `collection_${trustedCollectorReport.collectionOutcome}` : collectorProtocolFailure ? "collection_protocol" : complete ? null : "delivery"),
    ...(trustedCollectorReport?.peerEngine ? { peerEngine: trustedCollectorReport.peerEngine } : {}),
    ...(trustedCollectorReport?.peerJobId ? { peerJobId: trustedCollectorReport.peerJobId } : {}),
    ...(trustedCollectorReport?.peerTransportStatus ? { peerTransportStatus: trustedCollectorReport.peerTransportStatus } : {}),
    ...(trustedCollectorReport?.peerSemanticStatus ? { peerSemanticStatus: trustedCollectorReport.peerSemanticStatus } : {}),
    ...(trustedCollectorReport?.collectionOutcome ? { collectionOutcome: trustedCollectorReport.collectionOutcome } : {}),
    ...(Number.isSafeInteger(trustedCollectorReport?.elapsedSeconds) ? { collectionElapsedSeconds: trustedCollectorReport.elapsedSeconds } : {}),
    finishedAt: now,
    lastActivityAt: now
  }));
}

function activeSessionRecords(sessionId, env) {
  return readWorkerRecords(env, { strict: true }).filter((record) => record.sessionId === sessionId && !isTerminalWorkerStatus(record.transportStatus));
}

function unjudgedPeerCollections(sessionId, env) {
  return readWorkerRecords(env, { strict: true }).filter((record) => record.sessionId === sessionId && isTerminalWorkerStatus(record.transportStatus) && record.completionContract === "collector" && record.peerJobId && record.peerTransportStatus && !record.acceptanceRecordedAt);
}

function unreportedCollectorFailures(sessionId, env) {
  return readWorkerRecords(env, { strict: true }).filter((record) => record.sessionId === sessionId && isTerminalWorkerStatus(record.transportStatus) && record.completionContract === "collector" && record.failureKind && !record.failureReportedAt);
}

function collectorResultCommand(record) {
  const engine = record.peerEngine ?? record.expectedPeerEngine;
  const jobId = record.peerJobId ?? record.expectedPeerJobId;
  return ["codex", "grok"].includes(engine) && /^[a-f0-9]{32}$/.test(jobId ?? "") ? `/${engine}:result ${jobId}` : null;
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
      updateWorkerRecord(record.taskId, env, (current) => ({
        ...current,
        failureReportedAt: reportedAt,
        ...(current.failureKind === "collection_protocol" ? { protocolReportedAt: reportedAt } : {})
      }));
    } else {
      updateWorkerRecord(record.taskId, env, (current) => ({ ...current, failureStopBlockCount: (current.failureStopBlockCount ?? 0) + 1 }));
      missingFailureReports.push(record);
    }
  }
  if (missingFailureReports.length > 0) {
    const commands = missingFailureReports.map(collectorResultCommand).filter(Boolean);
    const legacyCount = missingFailureReports.filter((record) => !(record.peerJobId ?? record.expectedPeerJobId)).length;
    const commandInstruction = commands.length > 0 ? ` Include ${commands.join(" or ")}.` : "";
    const legacyInstruction = legacyCount > 0 ? " For a legacy record without a peer job id, report its Fusion task id and state that the result remains uncollected; no result command is available." : "";
    writeOutput(blockStop(`Collector failure reporting is incomplete for ${missingFailureReports.map((record) => {
      const engine = record.peerEngine ?? record.expectedPeerEngine;
      const jobId = record.peerJobId ?? record.expectedPeerJobId;
      const identity = engine && jobId ? `${engine}:${jobId}` : jobId ? `job=${jobId}` : "legacy peer identity unavailable";
      return `${record.taskId} (${record.failureKind}, ${identity})`;
    }).join(", ")}. Report each Fusion task id and every available peer job id, and state explicitly that the peer result remains uncollected.${commandInstruction}${legacyInstruction}`));
    return true;
  }
  const unjudged = unjudgedPeerCollections(input.session_id, env);
  if (unjudged.length > 0) {
    const acceptanceInstructions = {
      codex: (record) => `/fusion:stats --record-acceptance ${record.peerJobId} <accepted|rejected|unverified> --source main-loop`,
      grok: (record) => `/fusion:stats --record-worker-acceptance ${record.taskId} <accepted|rejected|unverified> --source main-loop`
    };
    const instructions = unjudged.map((record) => acceptanceInstructions[record.peerEngine]?.(record) ?? `a manual resolution because the collection for Fusion task ${record.taskId} needs manual resolution`);
    writeOutput(blockStop(`Collected peer transport results still require an explicit semantic judgment before finishing: ${unjudged.map((record) => `${record.peerEngine}:${record.peerJobId} (task=${record.taskId}, transport=${record.peerTransportStatus}, semantic=${record.peerSemanticStatus ?? "unverified"})`).join(", ")}. After checking the requested completion criteria, record each judgment with ${instructions.join(" or ")}.`));
    return true;
  }
  return false;
}

function handleStop(input, env) {
  if (collectorStopGate(input, env)) {
    return;
  }
  const tasks = Array.isArray(input.background_tasks) ? input.background_tasks : [];
  const workerTasks = tasks.filter((task) => task?.type === "subagent" && isFusionWorkerAgent(task.agent_type));
  const pending = [];
  for (const record of activeSessionRecords(input.session_id, env)) {
    const task = workerTasks.find((candidate) => [record.backgroundTaskId, record.agentId].filter(Boolean).includes(candidate.id) || (!record.backgroundTaskId && canonicalWorkerAgentType(candidate.agent_type) === canonicalWorkerAgentType(record.agentType)));
    const failure = ["ready_uncollected", "ready_background"].includes(record.transportStatus) ? null : workerBudgetFailure(record);
    const updated = updateWorkerRecord(record.taskId, env, (current) => ({
      ...current,
      ...(task?.id ? { backgroundTaskId: task.id } : {}),
      transportStatus: failure ? "cancel_requested" : ["ready_uncollected", "ready_background"].includes(current.transportStatus) ? current.transportStatus : "pending_async",
      failureKind: failure?.failureKind ?? current.failureKind,
      cancelReason: failure?.reason ?? current.cancelReason,
      stopBlockCount: (current.stopBlockCount ?? 0) + 1
    }));
    pending.push(updated);
  }
  const finalMessage = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
  if (pending.length === 0) {
    return;
  }
  const unauthorized = pending.filter((record) => !record.userBackgroundAuthorized);
  const cancellations = pending.filter((record) => record.transportStatus === "cancel_requested" || (!record.userBackgroundAuthorized && !["ready_uncollected", "ready_background"].includes(record.transportStatus) && (record.stopBlockCount ?? 0) >= 6));
  if (cancellations.length > 0) {
    const now = new Date().toISOString();
    const missingRuntimeIds = cancellations.filter((record) => !record.backgroundTaskId && !record.agentId);
    for (const record of missingRuntimeIds) {
      updateWorkerRecord(record.taskId, env, (current) => ({ ...current, transportStatus: "failed", failureKind: current.failureKind ?? "owner_lost", finishedAt: now }));
    }
    const cancelIds = cancellations.map((record) => record.backgroundTaskId ?? record.agentId).filter(Boolean);
    if (cancelIds.length === 0) {
      writeOutput(blockStop(`Fusion task${missingRuntimeIds.length === 1 ? "" : "s"} ${missingRuntimeIds.map((record) => record.taskId).join(", ")} failed before a runtime task id was available. Report the failure before finishing.`));
      return;
    }
    writeOutput(blockStop(`Call TaskStop for over-budget task${cancelIds.length === 1 ? "" : "s"} ${cancelIds.join(", ")} and report the cancellation before finishing.`));
    return;
  }
  if (unauthorized.length > 0) {
    const instructions = unauthorized.map((record) => {
      if (record.transportStatus === "ready_uncollected" && record.outputFile) {
        return `Read the completed output file ${record.outputFile} for owned task ${record.taskId} before finishing.`;
      }
      const collectId = record.backgroundTaskId ?? record.agentId;
      return collectId ? `Call TaskOutput with block=true for owned task ${collectId} and collect the terminal result before finishing.` : `Collect owned task ${record.taskId} before finishing.`;
    });
    instructions.push(
      "Transport completion remains unverified until the result and verification evidence are reviewed. Record accepted or rejected explicitly through /fusion:stats."
    );
    writeOutput(blockStop(instructions.join(" ")));
    return;
  }
  const missingReceipts = pending.filter((record) => !finalMessage.includes(record.taskId) && !finalMessage.includes(record.backgroundTaskId ?? "__missing__"));
  if (missingReceipts.length > 0 && !input.stop_hook_active) {
    writeOutput(blockStop(`The user explicitly authorized background delivery, but the final response must name each pending Fusion task id and its collection path. Pending: ${missingReceipts.map((record) => `${record.taskId}${record.backgroundTaskId ? ` (${record.backgroundTaskId})` : ""}`).join(", ")}.`));
    return;
  }
  for (const record of pending.filter((candidate) => candidate.transportStatus === "ready_background")) {
    updateWorkerRecord(record.taskId, env, (current) => ({ ...current, transportStatus: "done" }));
  }
}

function handleSessionEnd(input, env) {
  const now = new Date().toISOString();
  for (const record of activeSessionRecords(input.session_id, env)) {
    updateWorkerRecord(record.taskId, env, (current) => ({
      ...current,
      transportStatus: "owner_ended",
      acceptance: "unverified",
      failureKind: current.failureKind ?? "owner_lost",
      finishedAt: now
    }));
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
      writeOutput(denyTool("Fusion lifecycle state is unavailable. Retry after restoring private worker state access."));
    } else if (input.hook_event_name === "Stop" || input.hook_event_name === "SubagentStop") {
      writeOutput(blockStop("Fusion lifecycle state is unavailable. Restore private worker state access before ending this task."));
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
