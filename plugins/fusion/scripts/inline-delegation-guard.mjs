#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_ENV = "FUSION_INLINE_GUARD_STATE";
const BUDGET_ENV = "FUSION_INLINE_WRITE_BUDGET";
const DEFAULT_BUDGET = 5;
const STALE_MS = 48 * 60 * 60 * 1000;
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const DELEGATION_TOOLS = new Set(["Agent", "Task"]);

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

function denyOutput(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  };
}

function buildDenyReason(sessionId) {
  const scriptPath = fileURLToPath(import.meta.url);
  return (
    "fusion routing checkpoint: the inline write budget for this session is spent. Stop editing in the main loop, " +
    "declare implement posture, write the verification command, and dispatch the remaining work as packages. If " +
    "inline is genuinely right (the user explicitly asked for inline work or a skill owns this flow), grant a " +
    `fresh budget with: node ${scriptPath} allow ${sessionId}`
  );
}

function runAllowCommand(sessionId, env = process.env) {
  if (!sessionId) {
    process.stdout.write("fusion inline delegation guard: a session id is required\n");
    process.exitCode = 1;
    return;
  }
  const stateDir = resolveStateDir(env);
  const file = stateFile(stateDir, sessionId);
  const now = new Date().toISOString();
  writeState(file, { count: 0, lastResetReason: "manual-allow", createdAt: now, updatedAt: now });
  process.stdout.write(`fusion inline delegation guard: fresh write budget granted for session ${sessionId}\n`);
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
    const existing = readState(file);
    writeState(file, {
      count: 0,
      lastResetReason: "delegation-dispatched",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
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

  const existing = readState(file);
  const nextCount = (existing?.count ?? 0) + 1;
  writeState(file, {
    count: nextCount,
    lastResetReason: existing?.lastResetReason ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  });

  const budget = resolveBudget(env);
  if (nextCount > budget) {
    process.stdout.write(`${JSON.stringify(denyOutput(buildDenyReason(sessionId)))}\n`);
  }
}

function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand === "allow") {
    runAllowCommand(argv[0]);
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

export { buildDenyReason, extractWritePath, isInsideCwd, isSubagentPayload, resolveBudget, resolveStateDir };
