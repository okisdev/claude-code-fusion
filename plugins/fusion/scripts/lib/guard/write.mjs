import { readRoutingDefaults } from "../model-table.mjs";
import { sanitizeAuditPath } from "./dispatch.mjs";
import { createHash } from "node:crypto";
import path from "node:path";

function extractWritePath(toolInput) {
  if (!toolInput || typeof toolInput !== "object") {
    return null;
  }
  const raw = toolInput.file_path ?? toolInput.notebook_path ?? null;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function inlineWriteBytes(value) {
  if (!value || typeof value !== "object") {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.reduce((total, entry) => total + inlineWriteBytes(entry), 0);
  }
  let total = 0;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "new_string" || key === "content") && typeof entry === "string") {
      total += Buffer.byteLength(entry);
    } else if (entry && typeof entry === "object") {
      total += inlineWriteBytes(entry);
    }
  }
  return total;
}

function editReplacementBytes(toolInput) {
  return typeof toolInput?.new_string === "string" ? Buffer.byteLength(toolInput.new_string) : null;
}

function writePathSignature(filePath, cwd) {
  const base = typeof cwd === "string" && cwd ? cwd : process.cwd();
  const target = typeof filePath === "string" ? filePath : "";
  return createHash("sha256").update(path.resolve(base, target)).digest("hex");
}

function isInsideCwd(filePath, cwd) {
  if (typeof filePath !== "string" || !filePath || typeof cwd !== "string" || !cwd) {
    return false;
  }
  const resolvedFile = path.resolve(cwd, filePath);
  const resolvedCwd = path.resolve(cwd);
  const relative = path.relative(resolvedCwd, resolvedFile);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isWorkspaceWritePath(filePath, cwd) {
  if (typeof filePath !== "string" || !filePath || !path.isAbsolute(filePath)) {
    return true;
  }
  return isInsideCwd(filePath, cwd);
}

function extractAuditWritePath(filePath, cwd) {
  if (!isInsideCwd(filePath, cwd)) {
    return null;
  }
  const relative = path.relative(path.resolve(cwd), path.resolve(cwd, filePath)).split(path.sep).join("/");
  return sanitizeAuditPath(relative);
}

function budgetMultiple(writeCount, budget) {
  return Math.floor(writeCount / budget);
}

function advisoryOutput(additionalContext) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext } };
}

function denyOutput(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function postToolAdvisoryOutput(additionalContext) {
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } };
}

function buildUnverifiedLine(writeCount) {
  return `${writeCount} main loop ${writeCount === 1 ? "write is" : "writes are"} unverified in this window.`;
}

function buildLaneHint(env = process.env) {
  const { quick, volume } = readRoutingDefaults(env).codex;
  return `Lanes: quick scoped work goes to the codex quick default ${quick.model} at effort ${quick.effort}; trivial or high volume work goes to the codex volume default ${volume.model} at effort ${volume.effort}; work needing the Claude Code tool surface goes to fusion:claude-worker.`;
}

function buildAdvisoryLine(writeCount, dispatchCount, env = process.env) {
  const countSummary =
    dispatchCount === 0
      ? `${writeCount} inline writes happened this session with zero dispatches. `
      : `${writeCount} inline writes happened since the most recent dispatch; this session has ${dispatchCount} dispatch${dispatchCount === 1 ? "" : "es"}. `;
  return countSummary + buildLaneHint(env);
}

function buildUnverifiedAdvisory(writeCount, dispatchCount, env = process.env) {
  const zeroDispatchClause = dispatchCount === 0 ? " This session has not dispatched yet; if the remaining work splits into independent packages, dispatch them together in one message, and three or more convene /fusion:ultra." : "";
  return `${buildUnverifiedLine(writeCount)} Run this change's verification command once it is coherent, or hand the remaining work to a lane. ${buildLaneHint(env)}${zeroDispatchClause}`;
}

function buildTailAllowanceAdvisory(remainingTailSlots) {
  return `The inline write budget is exhausted. Tail allowance permits this small Edit to an already touched file; ${remainingTailSlots} tail ${remainingTailSlots === 1 ? "slot" : "slots"} remain in this dispatch window.`;
}

function buildZeroDispatchAdvisory(remainingWrites, remainingBytes) {
  return `The inline write budget is exhausted; this window remains within its inline relief bounds, with ${remainingWrites} ${remainingWrites === 1 ? "write" : "writes"} and ${remainingBytes} ${remainingBytes === 1 ? "byte" : "bytes"} left before enforcement resumes.`;
}

export { extractWritePath, inlineWriteBytes, editReplacementBytes, writePathSignature, isInsideCwd, isWorkspaceWritePath, extractAuditWritePath, budgetMultiple, advisoryOutput, denyOutput, postToolAdvisoryOutput, buildUnverifiedLine, buildLaneHint, buildAdvisoryLine, buildUnverifiedAdvisory, buildTailAllowanceAdvisory, buildZeroDispatchAdvisory };
