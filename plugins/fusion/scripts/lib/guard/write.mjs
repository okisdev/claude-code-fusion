import { sanitizeAuditPath } from "./dispatch.mjs";
import path from "node:path";

function extractWritePath(toolInput) {
  if (!toolInput || typeof toolInput !== "object") {
    return null;
  }
  const raw = toolInput.file_path ?? toolInput.notebook_path ?? null;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
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

function advisoryOutput(additionalContext) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext } };
}

function denyOutput(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function postToolAdvisoryOutput(additionalContext) {
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } };
}

export { extractWritePath, isInsideCwd, isWorkspaceWritePath, extractAuditWritePath, advisoryOutput, denyOutput, postToolAdvisoryOutput };
