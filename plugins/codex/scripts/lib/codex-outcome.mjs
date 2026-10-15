import { safeDiagnosticMessage } from "./codex-events.mjs";
import { normalizeCumulativeUsage, subtractUsage, ZERO_USAGE } from "./codex-usage.mjs";

export function usageOutcome(state, options) {
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
  if (/rate[ _-]?limit|too many requests|http(?:\/\d(?:\.\d)?)?\s+429|status(?: code)?\s*[:=]?\s*429/i.test(text) || text.includes("Flex capacity unavailable.")) {
    return "rate_limited";
  }
  if (/misalignment policy|cyber policy|violat(?:ed|es|ion of) (?:the |our |an? )?[a-z ]{0,40}policy|content policy/i.test(text) || [
    "stream disconnected before completion: Incomplete response returned, reason: content_filter",
    "This request has been flagged for possible cybersecurity risk.",
    "This content was flagged for possible biological risk."
  ].some((message) => text.includes(message))) {
    return "refused";
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

export function failureOutcome(state, processOutcome, stderrTail) {
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
  if (state.policyViolation) {
    return { status: "error", failureKind: "policy", errorMessage: state.policyViolation };
  }
  if (state.patchThrash) {
    return {
      status: "error",
      failureKind: "patch_thrash",
      errorMessage: `Codex could not land a patch because its context lines did not match the file on disk after ${state.patchFailureCount} consecutive apply_patch verification failures.`
    };
  }
  if (state.execLost) {
    return {
      status: "error",
      failureKind: "exec_lost",
      errorMessage: `The sandbox lost the spawned process after ${state.lostProcessCount} UnknownProcessId errors.`
    };
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

export function timeoutOutcome(state) {
  return {
    status: state.cleanupComplete ? "error" : "running",
    failureKind: "timeout",
    errorMessage: `Codex timed out after ${state.timeoutMs}ms.`
  };
}

export function buildRunOutcome({ state, options, args, stderr, processOutcome, spawnError, child, childIdentity }) {
  const usage = usageOutcome(state, { ...options, args });
  if ((state.timedOut || state.cancelled) && usage.tokenUsage) {
    usage.tokenUsageAvailability = "partial";
    usage.tokenUsageUnavailableReason = null;
  }
  const stderrTail = stderr.toString("utf8");
  const failure = state.timedOut && !state.patchThrash && !state.execLost
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
    policyViolation: state.policyViolation,
    threadId: state.threadId,
    terminalEvent: state.terminalEvent?.type ?? null,
    finalResponse: state.finalResponse,
    partialResultText: state.timedOut || state.cancelled ? state.finalResponse || null : null,
    resultSource: state.resultSource,
    cumulativeTokenUsage: state.cumulativeTokenUsage,
    resolvedEffort: state.resolvedEffort,
    resolvedModel: state.resolvedModel,
    rolloutRecoveryStatus: state.rolloutRecoveryStatus,
    semanticStatus: state.policyViolation ? "rejected" : "unverified",
    usageIsIncomplete: state.timedOut || state.cancelled || state.terminalEvent?.type !== "turn.completed",
    ...usage,
    eventCount: state.eventCount,
    eventsTruncated: state.eventsTruncated,
    fileChangeCount: state.fileChangeCount,
    unknownEventCount: state.unknownEventCount,
    diagnostics: state.diagnostics,
    protocolError: state.protocolError,
    resourceError: state.resourceError,
    stderrTail: safeDiagnosticMessage(stderrTail),
    spawnError
  };
}
