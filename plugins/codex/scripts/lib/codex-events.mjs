import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeCumulativeUsage } from "./codex-usage.mjs";

const PATCH_VERIFICATION_FAILURE = "apply_patch verification failed";
const UNKNOWN_PROCESS_ID = "unknownprocessid";
const STDERR_PARTIAL_LINE_TAIL_LENGTH = Math.max(PATCH_VERIFICATION_FAILURE.length, UNKNOWN_PROCESS_ID.length) - 1;
const MAX_DIAGNOSTICS = 64;
const MAX_DIAGNOSTIC_MESSAGE_BYTES = 4096;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function observedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function boundedBuffer(current, chunk, maxBytes) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  return combined.length <= maxBytes ? combined : combined.subarray(combined.length - maxBytes);
}

function stderrPatternOccurrences(text, pattern, previousTailLength) {
  let count = 0;
  let offset = 0;
  for (;;) {
    const index = text.indexOf(pattern, offset);
    if (index === -1) {
      return count;
    }
    if (index + pattern.length > previousTailLength) {
      count += 1;
    }
    offset = index + pattern.length;
  }
}

export function observeStderrPatterns(state, chunk) {
  const previousTail = state.stderrPartialLine;
  const text = `${previousTail}${Buffer.from(chunk).toString("utf8")}`;
  const lowerCaseText = text.toLowerCase();
  const previousTailLength = previousTail.length;
  const patchFailures = stderrPatternOccurrences(lowerCaseText, PATCH_VERIFICATION_FAILURE, previousTailLength);
  const lostProcesses = stderrPatternOccurrences(lowerCaseText, UNKNOWN_PROCESS_ID, previousTailLength);
  const lastNewline = text.lastIndexOf("\n");
  const partialLine = lastNewline === -1 ? text : text.slice(lastNewline + 1);
  state.stderrPartialLine = partialLine.slice(-STDERR_PARTIAL_LINE_TAIL_LENGTH);
  return { lostProcesses, patchFailures };
}

function boundedMessage(message) {
  const buffer = Buffer.from(String(message ?? ""));
  return (buffer.length <= MAX_DIAGNOSTIC_MESSAGE_BYTES ? buffer : buffer.subarray(0, MAX_DIAGNOSTIC_MESSAGE_BYTES)).toString("utf8");
}

export function resourceError(message) {
  const error = new Error(message);
  error.failureKind = "resource";
  return error;
}

export function safeDiagnosticMessage(message) {
  const redacted = String(message ?? "")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{20,}\b/g, "[redacted]")
    .replace(/\bxai-[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\bBearer\s+\S{20,}/gi, "Bearer [redacted]")
    .replace(/((?:OPENAI_API_KEY|CODEX_API_KEY|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(["']?(?:api_key|access_token|refresh_token|authorization)["']?\s*:\s*["'])[^"']+/gi, "$1[redacted]");
  return boundedMessage(redacted);
}

export function signalExitCode(signal) {
  const number = signal ? os.constants.signals[signal] : null;
  return Number.isInteger(number) ? 128 + number : 1;
}

export function outputPaths(options) {
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

export function checkpointState(state, event = null) {
  return {
    policyViolation: state.policyViolation,
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
  recordDiagnostic(state, diagnostic);
}

export function recordDiagnostic(state, diagnostic) {
  state.diagnostics.push({ ...diagnostic, message: safeDiagnosticMessage(diagnostic.message) });
  if (state.diagnostics.length > MAX_DIAGNOSTICS) {
    state.diagnostics.splice(0, state.diagnostics.length - MAX_DIAGNOSTICS);
  }
}

export function recordProtocolError(state, message) {
  if (!state.protocolError) {
    state.protocolError = boundedMessage(message);
  }
}

export function recordResourceError(state, message) {
  if (!state.resourceError) {
    state.resourceError = boundedMessage(message);
  }
}

export function validateEvent(state, event) {
  if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string" || !event.type) {
    recordProtocolError(state, "Codex emitted a JSONL value without a valid event type.");
    return;
  }
  state.eventCount += 1;
  classifyDiagnostic(state, event);
  switch (event.type) {
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
        state.policyViolation = `Delegated Codex execution attempted the disabled ${tool} tool.`;
      }
      if (event.type === "item.completed" && event.item.type === "file_change") {
        state.fileChangeCount += 1;
        state.patchFailureCount = 0;
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

async function processLine(ctx, lineBuffer) {
  const { state, writeEventLine, requestTermination, options } = ctx;
  const line = (lineBuffer.at(-1) === 13 ? lineBuffer.subarray(0, -1) : lineBuffer).toString("utf8");
  writeEventLine(lineBuffer);
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
  if (state.protocolError || state.resourceError || state.policyViolation) {
    void requestTermination();
  }
  try {
    await options.onCheckpoint?.(checkpointState(state, event));
  } catch (error) {
    state.callbackError = error instanceof Error ? error : new Error(String(error));
    void requestTermination();
  }
}

async function consumeCodexEventStream(ctx) {
  const { child, state, spawnCheckpointPromise, eventLineMaxBytes, requestTermination } = ctx;
  if (!child.stdout) {
    recordProtocolError(state, "Codex process did not expose stdout.");
    void requestTermination();
    return;
  }
  await spawnCheckpointPromise;
  let segments = [];
  let segmentBytes = 0;
  let skippingOversizedEvent = false;
  try {
    for await (const rawChunk of child.stdout) {
      const chunk = Buffer.from(rawChunk);
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        const segment = chunk.subarray(offset, end);
        if (skippingOversizedEvent) {
          if (newline === -1) {
            break;
          }
          skippingOversizedEvent = false;
          offset = newline + 1;
          continue;
        }
        if (segmentBytes + segment.length > eventLineMaxBytes) {
          state.oversizedEventsSkipped += 1;
          if (state.oversizedEventsSkipped === 1) {
            recordDiagnostic(state, { type: "warning", message: `Skipped a JSONL event larger than the ${eventLineMaxBytes} byte limit.` });
          }
          segments = [];
          segmentBytes = 0;
          if (newline === -1) {
            skippingOversizedEvent = true;
            break;
          }
          offset = newline + 1;
          continue;
        }
        if (segment.length > 0) {
          segments.push(segment);
          segmentBytes += segment.length;
        }
        if (newline === -1) {
          break;
        }
        await processLine(ctx, Buffer.concat(segments, segmentBytes));
        segments = [];
        segmentBytes = 0;
        offset = newline + 1;
      }
    }
  } catch (error) {
    if ((state.cleanupComplete && !state.outputAbandoned) || error?.code !== "ERR_STREAM_PREMATURE_CLOSE") {
      state.callbackError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (segmentBytes > 0) {
    await processLine(ctx, Buffer.concat(segments, segmentBytes));
  }
}

export function parseCodexEventStream({ child, state, spawnCheckpointPromise, options, eventLineMaxBytes, writeEventLine, requestTermination }) {
  return consumeCodexEventStream({ child, state, spawnCheckpointPromise, options, eventLineMaxBytes, writeEventLine, requestTermination });
}
