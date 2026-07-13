#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_ENV = "FUSION_INLINE_GUARD_STATE";
const BUDGET_ENV = "FUSION_INLINE_WRITE_BUDGET";
const DEFAULT_BUDGET = 5;
const STALE_MS = 48 * 60 * 60 * 1000;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 10000;
const DISPATCH_LOG_LIMIT = 200;
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const DELEGATION_TOOLS = new Set(["Agent", "Task"]);
const BUILTIN_LANE = "builtin";

function resolveStateDir(env = process.env) {
  const override = env[STATE_ENV];
  if (override) {
    return override;
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "fusion-claude-code-fusion", "inline-guard");
}

function resolveBudget(env = process.env) {
  const parsed = Number.parseInt(String(env[BUDGET_ENV]), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_BUDGET;
}

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

function isSubagentPayload(input) {
  return typeof input.agent_id === "string" && input.agent_id.length > 0;
}

function stateFile(stateDir, sessionId) {
  return path.join(stateDir, `${sessionId}.json`);
}

function readState(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    void 0;
  }
  return null;
}

function writeState(file, state) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tempFile = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tempFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, file);
}

function waitForLock() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
}

function acquireStateLock(file) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const descriptor = fs.openSync(lockFile, "wx");
      fs.writeFileSync(descriptor, String(process.pid));
      return () => {
        fs.closeSync(descriptor);
        fs.rmSync(lockFile, { force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for inline guard state lock");
      }
      waitForLock();
    }
  }
}

function withStateLock(file, callback) {
  const release = acquireStateLock(file);
  try {
    return callback();
  } finally {
    release();
  }
}

function pruneStaleState(stateDir) {
  let entries;
  try {
    entries = fs.readdirSync(stateDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const file = path.join(stateDir, entry);
    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs > STALE_MS) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      void 0;
    }
  }
}

function extractWritePath(toolInput) {
  if (!toolInput || typeof toolInput !== "object") {
    return null;
  }
  const raw = toolInput.file_path ?? toolInput.notebook_path ?? null;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function isInsideCwd(filePath, cwd) {
  if (!filePath || !cwd) {
    return false;
  }
  const resolvedFile = path.resolve(cwd, filePath);
  const resolvedCwd = path.resolve(cwd);
  const relative = path.relative(resolvedCwd, resolvedFile);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function laneForSubagentType(subagentType) {
  if (typeof subagentType !== "string" || subagentType.length === 0) {
    return BUILTIN_LANE;
  }
  if (subagentType.startsWith("grok:")) {
    return "grok";
  }
  if (subagentType.startsWith("codex:")) {
    return "codex";
  }
  if (subagentType.startsWith("fusion:")) {
    return subagentType;
  }
  return BUILTIN_LANE;
}

function extractSubagentType(toolInput) {
  if (!toolInput || typeof toolInput !== "object") {
    return null;
  }
  const raw = toolInput.subagent_type ?? null;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function extractDispatchDescription(toolInput) {
  if (!toolInput || typeof toolInput !== "object") {
    return null;
  }
  const raw = toolInput.description ?? null;
  return typeof raw === "string" && raw.length > 0 ? raw.slice(0, 120) : null;
}

function totalDispatches(dispatches) {
  return Object.values(dispatches ?? {}).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

function budgetMultiple(writeCount, budget) {
  return Math.floor(writeCount / budget);
}

function defaultState(now) {
  return { writeCount: 0, dispatches: {}, dispatchLog: [], advisedMultiples: [], createdAt: now, updatedAt: now };
}

function normalizeState(existing, now) {
  if (!existing || typeof existing !== "object") {
    return defaultState(now);
  }
  return {
    writeCount: Number.isFinite(existing.writeCount) ? existing.writeCount : 0,
    dispatches: existing.dispatches && typeof existing.dispatches === "object" ? { ...existing.dispatches } : {},
    dispatchLog: Array.isArray(existing.dispatchLog) ? existing.dispatchLog.slice(-DISPATCH_LOG_LIMIT) : [],
    advisedMultiples: Array.isArray(existing.advisedMultiples) ? existing.advisedMultiples.slice() : [],
    createdAt: existing.createdAt ?? now,
    updatedAt: now
  };
}

function allowOutput(reason) {
  const hookSpecificOutput = { hookEventName: "PreToolUse", permissionDecision: "allow" };
  if (reason) {
    hookSpecificOutput.permissionDecisionReason = reason;
  }
  return { hookSpecificOutput };
}

function buildAdvisoryLine(writeCount, dispatchCount) {
  return (
    `${writeCount} inline writes happened this session with ${dispatchCount === 0 ? "zero" : dispatchCount} dispatches. ` +
    "The next package belongs in a lane: quick scoped work goes to the codex quick tier gpt-5.6-terra at effort xhigh; " +
    "trivial or high-volume work goes to gpt-5.6-luna at effort xhigh; work needing the Claude Code tool surface goes to fusion:fast-worker."
  );
}

function runAllowCommand() {
  process.stdout.write(
    "fusion inline delegation guard: the allow escape hatch is retired, the guard only advises now and never denies\n"
  );
}

function runHook(env = process.env) {
  const input = readHookInput();
  if (!input) {
    return;
  }
  if (isSubagentPayload(input)) {
    return;
  }
  const sessionId = input.session_id;
  const toolName = input.tool_name;
  const cwd = input.cwd;
  if (typeof sessionId !== "string" || !sessionId || typeof toolName !== "string" || !toolName) {
    return;
  }

  const stateDir = resolveStateDir(env);
  pruneStaleState(stateDir);
  const file = stateFile(stateDir, sessionId);
  const now = new Date().toISOString();

  if (DELEGATION_TOOLS.has(toolName)) {
    withStateLock(file, () => {
      const state = normalizeState(readState(file), now);
      const subagentType = extractSubagentType(input.tool_input);
      const lane = laneForSubagentType(subagentType);
      state.dispatches[lane] = (state.dispatches[lane] ?? 0) + 1;
      const description = extractDispatchDescription(input.tool_input);
      state.dispatchLog.push({ at: now, lane, ...(subagentType ? { subagentType } : {}), ...(description ? { description } : {}) });
      if (state.dispatchLog.length > DISPATCH_LOG_LIMIT) {
        state.dispatchLog.splice(0, state.dispatchLog.length - DISPATCH_LOG_LIMIT);
      }
      writeState(file, state);
    });
    return;
  }

  if (!WRITE_TOOLS.has(toolName)) {
    return;
  }

  const targetPath = extractWritePath(input.tool_input);
  if (!isInsideCwd(targetPath, cwd)) {
    return;
  }

  const budget = resolveBudget(env);
  const advisoryCandidate = withStateLock(file, () => {
    const state = normalizeState(readState(file), now);
    state.writeCount += 1;
    const multiple = budgetMultiple(state.writeCount, budget);
    const dispatchCount = totalDispatches(state.dispatches);
    let candidate = null;
    if (multiple >= 1 && dispatchCount === 0 && !state.advisedMultiples.includes(multiple)) {
      state.advisedMultiples.push(multiple);
      candidate = { multiple, writeCount: state.writeCount };
    }
    writeState(file, state);
    return candidate;
  });

  if (advisoryCandidate) {
    withStateLock(file, () => {
      const latest = normalizeState(readState(file), new Date().toISOString());
      const dispatchCount = totalDispatches(latest.dispatches);
      if (dispatchCount === 0 && latest.advisedMultiples.includes(advisoryCandidate.multiple)) {
        const advisory = buildAdvisoryLine(advisoryCandidate.writeCount, dispatchCount);
        process.stdout.write(`${JSON.stringify(allowOutput(advisory))}\n`);
      }
    });
  }
}

function main() {
  const [subcommand] = process.argv.slice(2);
  if (subcommand === "allow") {
    runAllowCommand();
    return;
  }
  try {
    runHook();
  } catch {
    void 0;
  }
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  main();
}

export {
  buildAdvisoryLine,
  budgetMultiple,
  extractDispatchDescription,
  extractWritePath,
  isInsideCwd,
  isSubagentPayload,
  laneForSubagentType,
  resolveBudget,
  resolveStateDir,
  stateFile,
  totalDispatches
};
