import os from "node:os";
import { formatBlockedPermissionCall, formatDeniedToolDetail, normalizeStopReason, terminalRecordAttribution } from "../grok-exec.mjs";
import { clearQuotaCooldown, readJobRecordFile, readLogTail, resolveDataDir, updateJobRecordFile } from "../state.mjs";
import { recordQuotaCooldown } from "./version.mjs";
import { boundedTextTail } from "./base.mjs";

const PERMISSION_FAILURE_MESSAGE =
  "Grok's turn was cancelled by the consult-mode permission gate (a tool call outside the hard read-only tool set). Re-dispatch with --write if repository changes or command execution are acceptable, or rewrite the brief to use file reading and search only.";
const REQUIRED_VERSION_POLICY_FAILURE_PATTERNS = [
  { direction: "below", pattern: /\bis older than the minimum required by your organization\b/i },
  { direction: "above", pattern: /\bis newer than the maximum allowed by your organization\b/i }
];
const REQUIRED_VERSION_POLICY_FAILURE_MESSAGES = {
  below: "The installed Grok binary is older than your organization's required minimum version. Upgrade Grok, then rerun /grok:setup.",
  above: "The installed Grok binary is newer than your organization's allowed maximum version. Install an approved Grok build at or below that ceiling (for example `grok update --version <approved>`), then rerun /grok:setup."
};

function isPermissionCancelled(result) {
  return Boolean(result) && result.exitCode === 0 && !result.timedOut && normalizeStopReason(result.stopReason) === "cancelled";
}

function permissionFailureMessage(result) {
  const blocked = result?.blockedPermissionCall ?? null;
  const hasBlockedTool = Boolean(blocked && typeof blocked.tool === "string" && blocked.tool.trim());
  const deniedToolDetail = formatDeniedToolDetail(result?.deniedToolFromStderr ?? null);
  if (hasBlockedTool) {
    return PERMISSION_FAILURE_MESSAGE + formatBlockedPermissionCall(blocked) + deniedToolDetail;
  }
  if (deniedToolDetail) {
    return PERMISSION_FAILURE_MESSAGE + deniedToolDetail;
  }
  return PERMISSION_FAILURE_MESSAGE + formatBlockedPermissionCall(null);
}

function requiredVersionPolicyDirection(stderr) {
  const text = String(stderr ?? "");
  return REQUIRED_VERSION_POLICY_FAILURE_PATTERNS.find(({ pattern }) => pattern.test(text))?.direction ?? null;
}

function isRequiredVersionPolicyFailure(result, stderr) {
  return Boolean(
    result &&
      result.exitCode !== 0 &&
      !result.timedOut &&
      result.hasJsonEnvelope === false &&
      requiredVersionPolicyDirection(stderr)
  );
}

function grokFailureMessage(result, timeoutMs, failureKind, tail = "") {
  if (failureKind === "permission") {
    return permissionFailureMessage(result);
  }
  if (failureKind === "setup" && isRequiredVersionPolicyFailure(result, result?.stderrTail)) {
    return REQUIRED_VERSION_POLICY_FAILURE_MESSAGES[requiredVersionPolicyDirection(result.stderrTail)];
  }
  if (result.parseError) {
    return result.parseError;
  }
  if (result.errorMessage) {
    if (/\{\s*$/.test(String(result.errorMessage).trim())) {
      const recovered = jsonErrorMessage(tail, result.stderrTail, result.stdoutTail, result.text);
      if (recovered) return recovered.slice(0, 500);
    }
    return result.errorMessage;
  }
  return result.timedOut
    ? `Grok timed out after ${timeoutMs}ms and was terminated.`
    : `Grok exited with code ${result.exitCode}.`;
}

function jsonErrorMessage(...sources) {
  for (const source of sources) {
    const text = String(source ?? "");
    for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let end = start; end < text.length; end += 1) {
        const char = text[end];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') {
          quoted = true;
        } else if (char === "{") {
          depth += 1;
        } else if (char === "}" && --depth === 0) {
          try {
            const body = JSON.parse(text.slice(start, end + 1));
            const nested = body?.error?.message;
            const message = typeof nested === "string" && nested.trim() ? nested : body?.message;
            if (typeof message === "string" && message.trim()) return message.trim().replace(/\s+/g, " ");
          } catch {}
          break;
        }
      }
    }
  }
  return null;
}

const STDERR_FAILURE_KINDS = [
  ["sandbox", /sandbox (?:enforcement failed|could not be applied|initialization failed)/i],
  ["turn_limit", /max turns reached/i],
  ["permission", /operation not permitted|permission denied|\bEACCES\b|\bEPERM\b|os error 1/i],
  ["transport", /prompt transport failed|closed stdin|broken pipe|\bEPIPE\b|valid JSON envelope/i],
  [
    "quota",
    /quota|insufficient (?:account )?(?:balance|credit|credits|funds)|balance (?:is )?exhausted|exhausted (?:account )?balance|payment required|usage limit|billing|credit limit|http(?:\/\d(?:\.\d)?)?\s+402|status(?: code)?\s*[:=]?\s*402/i
  ],
  ["rate_limited", /rate.?limit|429|too many requests/i],
  ["network", /getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/i],
  ["auth", /auth|unauthori[sz]ed|forbidden|login required/i]
];

function classifyFailure({ spawnError = null, result = null, logTail = "" } = {}) {
  if (spawnError?.failureKind) {
    return spawnError.failureKind;
  }
  if (result?.securityFailureKind) {
    return result.securityFailureKind;
  }
  if (spawnError?.code === "ENOENT") {
    return "missing_cli";
  }
  if (spawnError?.code === "EACCES" || spawnError?.code === "EPERM") {
    return "permission";
  }
  if (result?.timedOut) {
    return "timeout";
  }
  if (result?.cancelledByCompanion) {
    return "cancelled";
  }
  if (result?.turnLimitReached) {
    return "turn_limit";
  }
  if (isPermissionCancelled(result)) {
    return "permission";
  }
  if (result?.promptTransportError || result?.parseError) {
    return "transport";
  }
  if (isRequiredVersionPolicyFailure(result, result?.stderrTail)) {
    return "setup";
  }
  const resultEvidence = resultFailed(result)
    ? [result?.errorMessage, boundedTextTail(result?.text), boundedTextTail(result?.stdoutTail)].filter(Boolean).join("\n")
    : "";
  const tail = [String(logTail ?? ""), resultEvidence].filter(Boolean).join("\n");
  for (const [kind, pattern] of STDERR_FAILURE_KINDS) {
    if (pattern.test(tail)) {
      return kind;
    }
  }
  return "error";
}

function finishJobRecord(jobFile, patch) {
  const current = readJobRecordFile(jobFile);
  if (current?.status === "done" || current?.status === "error" || current?.status === "cancelled") {
    return current;
  }
  const terminalAttribution = patch?.status === "error" || patch?.status === "cancelled"
    ? terminalRecordAttribution(current, patch)
    : {};
  const finished = updateJobRecordFile(jobFile, { ...patch, ...terminalAttribution });
  if (finished.status === "error" && finished.failureKind === "quota" &&
      !finished.errorMessage?.startsWith("Grok quota cooldown is active")) {
    recordQuotaCooldown(finished, finished.errorMessage ?? finished.errorTail ?? "Grok quota exhausted.");
  } else if (finished.status === "done") {
    clearQuotaCooldown(resolveDataDir());
  }
  return finished;
}

function resultFailed(result) {
  if (result == null) return false;
  return Boolean(result.parseError) || Boolean(result.errorMessage) || result.exitCode !== 0 || result.timedOut || isPermissionCancelled(result);
}

function failureTail(logFile, result) {
  const tail = readLogTail(logFile, 20);
  const stdoutDiagnostic = result?.errorMessage || (result?.parseError ? result.stdoutTail : "");
  if (!stdoutDiagnostic) {
    return tail;
  }
  return [tail, result?.parseError ? "Stdout tail:" : "", stdoutDiagnostic].filter(Boolean).join("\n");
}

export { PERMISSION_FAILURE_MESSAGE, REQUIRED_VERSION_POLICY_FAILURE_PATTERNS, REQUIRED_VERSION_POLICY_FAILURE_MESSAGES, isPermissionCancelled, permissionFailureMessage, requiredVersionPolicyDirection, isRequiredVersionPolicyFailure, grokFailureMessage, jsonErrorMessage, STDERR_FAILURE_KINDS, classifyFailure, finishJobRecord, resultFailed, failureTail };
