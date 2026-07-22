#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const STATE_ENV = "FUSION_INLINE_GUARD_STATE";
const BUDGET_ENV = "FUSION_INLINE_WRITE_BUDGET";
const TAIL_MAX_BYTES_ENV = "FUSION_INLINE_TAIL_MAX_BYTES";
const TAIL_ALLOWANCE_ENV = "FUSION_INLINE_TAIL_ALLOWANCE";
const ZERO_DISPATCH_MAX_BYTES_ENV = "FUSION_INLINE_ZERO_DISPATCH_MAX_BYTES";
const ZERO_DISPATCH_WRITES_ENV = "FUSION_INLINE_ZERO_DISPATCH_WRITES";
const MODE_ENV = "FUSION_INLINE_GUARD_MODE";
const AUDIT_DIR_ENV = "FUSION_INLINE_GUARD_AUDIT_DIR";
const AUDIT_RETENTION_DAYS_ENV = "FUSION_INLINE_GUARD_AUDIT_RETENTION_DAYS";
const AUDIT_MAX_BYTES_ENV = "FUSION_INLINE_GUARD_AUDIT_MAX_BYTES";
const AUDIT_MAX_FILES_ENV = "FUSION_INLINE_GUARD_AUDIT_MAX_FILES";
const FUSION_DATA_DIR_ENV = "FUSION_DATA_DIR";
const WORKER_STATE_DIR_ENV = "FUSION_WORKER_STATE_DIR";
const FLEET_WAVE_GAP_ENV = "FUSION_FLEET_WAVE_GAP_MS";
const DEFAULT_BUDGET = 5;
const DEFAULT_TAIL_MAX_BYTES = 1024;
const DEFAULT_TAIL_ALLOWANCE = 3;
const DEFAULT_ZERO_DISPATCH_MAX_BYTES = 16384;
const DEFAULT_ZERO_DISPATCH_WRITES = 10;
const DEFAULT_AUDIT_RETENTION_DAYS = 180;
const DEFAULT_AUDIT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_AUDIT_MAX_FILES = 256;
const DEFAULT_FLEET_WAVE_GAP_MS = 120000;
const LAUNCHED_DISPATCH_TTL_MS = 15 * 60 * 1000;
const AUDIT_SCHEMA_VERSION = 1;
const STALE_MS = 48 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_RETRY_MS = 10;
export const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const LOCK_TIMEOUT_ENV = "FUSION_LOCK_TIMEOUT_MS";
const LOCK_STALE_MS = 10000;
const DISPATCH_LOG_LIMIT = 200;
const DESCRIPTION_MAX_LENGTH = 120;
const AUDIT_PATH_MAX_LENGTH = 240;
const AUDIT_FILE_PATTERN = /^events-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const DELEGATION_TOOLS = new Set(["Agent", "Task"]);
const BASH_TOOL = "Bash";
const ENFORCEMENT_AUDIT_TOOLS = new Set([...WRITE_TOOLS, BASH_TOOL]);
const TASK_CONTROL_TOOLS = new Set(["TaskOutput", "TaskStop"]);
const BUILTIN_LANE = "builtin";
const MAIN_LANE = "main";
const WORKER_TERMINAL_STATUSES = new Set(["done", "incomplete", "failed", "cancelled", "owner_ended"]);
const REAPED_WORKER_TERMINAL_STATUSES = new Set(["done", "incomplete", "failed", "cancelled"]);
const NO_OP_BASH_COMMANDS = new Set(["", "true", ":"]);
const NO_OP_HEARTBEAT_REASON = "Fusion tasks are in flight for this session, so emit a text-only heartbeat instead of this no-op Bash command.";
const REAPED_WORKER_REDIRECT_AUDIT_DESCRIPTION = "reaped-worker-redirect";
const NARROW_WAVE_ADVISORY_SUFFIX = "consecutive narrow waves; fleet default applies: consider /fusion:ultra for the remaining packages or state fleet-decline: <reason>.";
const NARROW_WAVE_ADVISORY_REASON = "narrow-wave-advisory";
const MISSING_LAUNCH_RECOVERY_REASON = "missing-launch-recovered";
const TAIL_ALLOW_AUDIT_EVENT = "tail-allowed";
const ZERO_DISPATCH_SOFTENED_AUDIT_EVENT = "zero-dispatch-softened";

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

function resolveNonnegativeInteger(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
    return fallback;
  }
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveTailMaxBytes(env = process.env) {
  return resolveNonnegativeInteger(env, TAIL_MAX_BYTES_ENV, DEFAULT_TAIL_MAX_BYTES);
}

function resolveTailAllowance(env = process.env) {
  return resolveNonnegativeInteger(env, TAIL_ALLOWANCE_ENV, DEFAULT_TAIL_ALLOWANCE);
}

function resolveZeroDispatchMaxBytes(env = process.env) {
  return resolveNonnegativeInteger(env, ZERO_DISPATCH_MAX_BYTES_ENV, DEFAULT_ZERO_DISPATCH_MAX_BYTES);
}

function resolveZeroDispatchWrites(env = process.env) {
  return resolveNonnegativeInteger(env, ZERO_DISPATCH_WRITES_ENV, DEFAULT_ZERO_DISPATCH_WRITES);
}

function resolveLockTimeoutMs(env = process.env) {
  const raw = env[LOCK_TIMEOUT_ENV];
  if (raw === undefined || raw === null || (typeof raw === "string" && !String(raw).trim())) {
    return DEFAULT_LOCK_TIMEOUT_MS;
  }
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LOCK_TIMEOUT_MS;
}

function resolveMode(env = process.env) {
  return String(env[MODE_ENV] ?? "").trim().toLowerCase() === "advisory" ? "advisory" : "enforce";
}

function resolveAuditDir(env = process.env) {
  const override = env[AUDIT_DIR_ENV];
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "fusion-claude-code-fusion", "inline-guard-audit");
}

function resolveFusionDataDir(env = process.env) {
  const override = env[FUSION_DATA_DIR_ENV];
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "fusion-claude-code-fusion");
}

function resolveWorkerStateDir(env = process.env) {
  const override = env[WORKER_STATE_DIR_ENV];
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return path.join(resolveFusionDataDir(env), "workers");
}

function inFlightWorkerTaskSignature(sessionId, env = process.env) {
  const jobsDir = path.join(resolveWorkerStateDir(env), "jobs");
  let entries;
  try {
    entries = fs.readdirSync(jobsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const workers = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("fusion-") || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      const record = JSON.parse(fs.readFileSync(path.join(jobsDir, entry.name), "utf8"));
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        continue;
      }
      if (record.sessionId !== sessionId) {
        continue;
      }
      const status = record.transportStatus;
      if (typeof status === "string" && !WORKER_TERMINAL_STATUSES.has(status)) {
        workers.push(`${record.taskId ?? entry.name}:${status}`);
      }
    } catch {
      continue;
    }
  }
  return workers.length > 0 ? workers.sort().join(",") : null;
}

function extractTaskControlId(toolInput) {
  if (!toolInput || typeof toolInput !== "object") {
    return null;
  }
  return typeof toolInput.task_id === "string" && toolInput.task_id.length > 0 ? toolInput.task_id : null;
}

function findWorkerRecordForTaskControlId(taskId, env = process.env) {
  const jobsDir = path.join(resolveWorkerStateDir(env), "jobs");
  let entries;
  try {
    entries = fs.readdirSync(jobsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("fusion-") || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      const record = JSON.parse(fs.readFileSync(path.join(jobsDir, entry.name), "utf8"));
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        continue;
      }
      if (record.backgroundTaskId === taskId || record.agentId === taskId) {
        matches.push(record);
      }
    } catch {
      continue;
    }
  }
  return matches.find((record) => !REAPED_WORKER_TERMINAL_STATUSES.has(record.transportStatus)) ?? matches[0] ?? null;
}

function reapedWorkerRedirectReason(record, taskId) {
  const settlementTaskId = typeof record.taskId === "string" && record.taskId.length > 0 ? record.taskId : taskId;
  const settlement = `/fusion:stats --record ${settlementTaskId}=<verdict>`;
  if (typeof record.outputFile === "string" && record.outputFile.length > 0) {
    return `This worker already completed and was reaped; its result is at ${record.outputFile}; Read that file and settle via ${settlement} instead of probing the reaped agent.`;
  }
  if (typeof record.transcriptPath === "string" && record.transcriptPath.length > 0) {
    return `This worker already completed and was reaped; its transcript is at ${record.transcriptPath}; Read that file and settle via ${settlement} instead of probing the reaped agent.`;
  }
  return `This worker already completed and was reaped; settle via ${settlement} instead of probing the reaped agent.`;
}

function extractBashCommand(toolInput) {
  if (!toolInput || typeof toolInput !== "object") {
    return null;
  }
  return typeof toolInput.command === "string" ? toolInput.command.trim() : null;
}

function resolvePositiveInteger(env, name, fallback) {
  const parsed = Number.parseInt(String(env[name]), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveAuditRetentionDays(env = process.env) {
  return resolvePositiveInteger(env, AUDIT_RETENTION_DAYS_ENV, DEFAULT_AUDIT_RETENTION_DAYS);
}

function resolveAuditMaxBytes(env = process.env) {
  return resolvePositiveInteger(env, AUDIT_MAX_BYTES_ENV, DEFAULT_AUDIT_MAX_BYTES);
}

function resolveAuditMaxFiles(env = process.env) {
  return resolvePositiveInteger(env, AUDIT_MAX_FILES_ENV, DEFAULT_AUDIT_MAX_FILES);
}

function resolveFleetWaveGapMs(env = process.env) {
  return resolvePositiveInteger(env, FLEET_WAVE_GAP_ENV, DEFAULT_FLEET_WAVE_GAP_MS);
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

function normalizeSessionId(value) {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value) ? value : null;
}

function stateFile(stateDir, sessionId) {
  return path.join(stateDir, `${sessionId}.json`);
}

function readState(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    try {
      fs.lstatSync(file);
    } catch (statError) {
      if (statError?.code === "ENOENT") {
        return null;
      }
      throw statError;
    }
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Fusion inline write state must be a JSON object.");
  }
  return parsed;
}

function writeState(file, state) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tempFile = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const descriptor = fs.openSync(tempFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.fchmodSync(descriptor, 0o600);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(tempFile, file);
  fs.chmodSync(file, 0o600);
}

function waitForLock() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
}

function acquireStateLock(file) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + resolveLockTimeoutMs();
  for (;;) {
    try {
      const descriptor = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeFileSync(descriptor, String(process.pid));
      fs.fchmodSync(descriptor, 0o600);
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
      } catch (statError) {
        if (statError?.code === "ENOENT") {
          continue;
        }
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

function auditSegmentName(date, index) {
  return index === 0 ? `events-${date}.jsonl` : `events-${date}.${index}.jsonl`;
}

function listAuditSegments(auditDir) {
  let entries;
  try {
    entries = fs.readdirSync(auditDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const segments = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = AUDIT_FILE_PATTERN.exec(entry.name);
    if (!match) {
      continue;
    }
    const file = path.join(auditDir, entry.name);
    try {
      const stat = fs.statSync(file);
      segments.push({ file, name: entry.name, date: match[1], index: Number.parseInt(match[2] ?? "0", 10), mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      void 0;
    }
  }
  return segments;
}

function pruneExpiredAuditSegments(auditDir, nowMs, retentionDays) {
  const cutoff = nowMs - retentionDays * DAY_MS;
  for (const segment of listAuditSegments(auditDir)) {
    if (segment.mtimeMs < cutoff) {
      try {
        fs.rmSync(segment.file, { force: true });
      } catch {
        void 0;
      }
    }
  }
}

function fileNeedsLineBreak(file) {
  let descriptor;
  try {
    const stat = fs.statSync(file);
    if (stat.size === 0) {
      return false;
    }
    descriptor = fs.openSync(file, "r");
    const buffer = Buffer.allocUnsafe(1);
    fs.readSync(descriptor, buffer, 0, 1, stat.size - 1);
    return buffer[0] !== 10;
  } finally {
    if (descriptor != null) {
      fs.closeSync(descriptor);
    }
  }
}

function selectAuditSegment(auditDir, date, maxBytes, lineBytes) {
  const matching = listAuditSegments(auditDir)
    .filter((segment) => segment.date === date)
    .sort((left, right) => left.index - right.index);
  const latest = matching.at(-1);
  if (!latest) {
    return path.join(auditDir, auditSegmentName(date, 0));
  }
  const separatorBytes = latest.size > 0 && fileNeedsLineBreak(latest.file) ? 1 : 0;
  if (latest.size > 0 && latest.size + separatorBytes + lineBytes > maxBytes) {
    return path.join(auditDir, auditSegmentName(date, latest.index + 1));
  }
  return latest.file;
}

function appendAuditLine(file, line) {
  const needsLineBreak = fs.existsSync(file) && fileNeedsLineBreak(file);
  const descriptor = fs.openSync(file, "a", 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
    if (needsLineBreak) {
      fs.writeSync(descriptor, "\n", null, "utf8");
    }
    fs.writeSync(descriptor, line, null, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function enforceAuditFileLimit(auditDir, maxFiles, activeFile) {
  const segments = listAuditSegments(auditDir).sort((left, right) => left.date.localeCompare(right.date) || left.index - right.index);
  while (segments.length > maxFiles) {
    const index = segments.findIndex((segment) => segment.file !== activeFile);
    const [oldest] = segments.splice(index >= 0 ? index : 0, 1);
    try {
      fs.rmSync(oldest.file, { force: true });
    } catch {
      void 0;
    }
  }
}

function appendAuditEvent(event, env = process.env) {
  const normalized = normalizeAuditEvent(event);
  if (!normalized) {
    return;
  }
  const auditDir = resolveAuditDir(env);
  const line = `${JSON.stringify(normalized)}\n`;
  const nowMs = Date.parse(normalized.at);
  const date = normalized.at.slice(0, 10);
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(auditDir, 0o700);
  withStateLock(path.join(auditDir, ".append"), () => {
    pruneExpiredAuditSegments(auditDir, Number.isFinite(nowMs) ? nowMs : Date.now(), resolveAuditRetentionDays(env));
    const file = selectAuditSegment(auditDir, date, resolveAuditMaxBytes(env), Buffer.byteLength(line));
    appendAuditLine(file, line);
    enforceAuditFileLimit(auditDir, resolveAuditMaxFiles(env), file);
  });
}

function normalizeAuditEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event) || (event.schemaVersion != null && event.schemaVersion !== AUDIT_SCHEMA_VERSION)) {
    return null;
  }
  const atMs = Date.parse(event.at);
  const session = normalizeSessionId(event.session);
  if (!Number.isFinite(atMs) || !session) {
    return null;
  }
  if (event.event === "write" && WRITE_TOOLS.has(event.tool) && event.lane === MAIN_LANE) {
    const safePath = sanitizeAuditPath(event.path);
    return { schemaVersion: AUDIT_SCHEMA_VERSION, at: new Date(atMs).toISOString(), session, event: "write", lane: MAIN_LANE, tool: event.tool, ...(safePath ? { path: safePath } : {}) };
  }
  if (
    (event.event === TAIL_ALLOW_AUDIT_EVENT || event.event === ZERO_DISPATCH_SOFTENED_AUDIT_EVENT) &&
    WRITE_TOOLS.has(event.tool) &&
    event.lane === MAIN_LANE &&
    Number.isInteger(event.writeCount) &&
    event.writeCount >= 0 &&
    Number.isInteger(event.dispatchCount) &&
    event.dispatchCount >= 0 &&
    Number.isInteger(event.budget) &&
    event.budget > 0 &&
    event.mode === "enforce"
  ) {
    const safePath = sanitizeAuditPath(event.path);
    if (event.event === TAIL_ALLOW_AUDIT_EVENT && Number.isInteger(event.remainingTailSlots) && event.remainingTailSlots >= 0) {
      return {
        schemaVersion: AUDIT_SCHEMA_VERSION,
        at: new Date(atMs).toISOString(),
        session,
        event: TAIL_ALLOW_AUDIT_EVENT,
        lane: MAIN_LANE,
        tool: event.tool,
        ...(safePath ? { path: safePath } : {}),
        writeCount: event.writeCount,
        dispatchCount: event.dispatchCount,
        budget: event.budget,
        mode: "enforce",
        remainingTailSlots: event.remainingTailSlots,
        ...(event.suppressed === true ? { suppressed: true } : {})
      };
    }
    if (
      event.event === ZERO_DISPATCH_SOFTENED_AUDIT_EVENT &&
      Number.isInteger(event.remainingZeroDispatchWrites) &&
      event.remainingZeroDispatchWrites >= 0 &&
      Number.isInteger(event.remainingZeroDispatchBytes) &&
      event.remainingZeroDispatchBytes >= 0
    ) {
      return {
        schemaVersion: AUDIT_SCHEMA_VERSION,
        at: new Date(atMs).toISOString(),
        session,
        event: ZERO_DISPATCH_SOFTENED_AUDIT_EVENT,
        lane: MAIN_LANE,
        tool: event.tool,
        ...(safePath ? { path: safePath } : {}),
        writeCount: event.writeCount,
        dispatchCount: event.dispatchCount,
        budget: event.budget,
        mode: "enforce",
        remainingZeroDispatchWrites: event.remainingZeroDispatchWrites,
        remainingZeroDispatchBytes: event.remainingZeroDispatchBytes,
        ...(event.suppressed === true ? { suppressed: true } : {})
      };
    }
    return null;
  }
  if (event.event === "dispatch" && DELEGATION_TOOLS.has(event.tool)) {
    const lane = normalizeLane(event.lane);
    const description = sanitizeAuditText(event.description);
    return lane ? { schemaVersion: AUDIT_SCHEMA_VERSION, at: new Date(atMs).toISOString(), session, event: "dispatch", lane, tool: event.tool, ...(description ? { description } : {}) } : null;
  }
  if (event.event === "warn" && DELEGATION_TOOLS.has(event.tool) && (event.reason === MISSING_LAUNCH_RECOVERY_REASON || event.reason === NARROW_WAVE_ADVISORY_REASON)) {
    const lane = normalizeLane(event.lane);
    return lane
      ? {
          schemaVersion: AUDIT_SCHEMA_VERSION,
          at: new Date(atMs).toISOString(),
          session,
          event: "warn",
          lane,
          tool: event.tool,
          reason: event.reason,
          ...(event.suppressed === true ? { suppressed: true } : {})
        }
      : null;
  }
  if (
    (event.event === "deny" || event.event === "warn") &&
    TASK_CONTROL_TOOLS.has(event.tool) &&
    event.lane === MAIN_LANE &&
    event.description === REAPED_WORKER_REDIRECT_AUDIT_DESCRIPTION &&
    (event.mode === "enforce" || event.mode === "advisory")
  ) {
    return {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      at: new Date(atMs).toISOString(),
      session,
      event: event.event,
      lane: MAIN_LANE,
      tool: event.tool,
      description: REAPED_WORKER_REDIRECT_AUDIT_DESCRIPTION,
      mode: event.mode,
      ...(event.event === "warn" && event.suppressed === true ? { suppressed: true } : {})
    };
  }
  if (
    (event.event === "deny" || event.event === "warn") &&
    ENFORCEMENT_AUDIT_TOOLS.has(event.tool) &&
    event.lane === MAIN_LANE &&
    Number.isInteger(event.writeCount) &&
    event.writeCount >= 0 &&
    Number.isInteger(event.dispatchCount) &&
    event.dispatchCount >= 0 &&
    Number.isInteger(event.budget) &&
    event.budget > 0 &&
    (event.mode === "enforce" || event.mode === "advisory")
  ) {
    const safePath = WRITE_TOOLS.has(event.tool) ? sanitizeAuditPath(event.path) : null;
    return {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      at: new Date(atMs).toISOString(),
      session,
      event: event.event,
      lane: MAIN_LANE,
      tool: event.tool,
      ...(safePath ? { path: safePath } : {}),
      writeCount: event.writeCount,
      dispatchCount: event.dispatchCount,
      budget: event.budget,
      mode: event.mode,
      ...(event.event === "warn" && event.suppressed === true ? { suppressed: true } : {})
    };
  }
  return null;
}

function auditBoundaryMs(value, fallback) {
  if (value == null) {
    return fallback;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readAuditEvents({ auditDir, env = process.env, sessionId = null, sinceMs = null, untilMs = null, since = null, until = null } = {}) {
  const root = auditDir ? path.resolve(auditDir) : resolveAuditDir(env);
  const lowerBound = auditBoundaryMs(sinceMs ?? since, Number.NEGATIVE_INFINITY);
  const upperBound = auditBoundaryMs(untilMs ?? until, Number.POSITIVE_INFINITY);
  const session = sessionId == null ? null : normalizeSessionId(sessionId);
  if (sessionId != null && !session) {
    return { events: [], malformedCount: 0 };
  }
  const events = [];
  let malformedCount = 0;
  const segments = listAuditSegments(root).sort((left, right) => left.date.localeCompare(right.date) || left.index - right.index);
  for (const segment of segments) {
    let text;
    try {
      text = fs.readFileSync(segment.file, "utf8");
    } catch {
      malformedCount += 1;
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = normalizeAuditEvent(JSON.parse(line));
        const atMs = Date.parse(event?.at);
        if (!event) {
          malformedCount += 1;
          continue;
        }
        if (atMs < lowerBound || atMs > upperBound || (session && event.session !== session)) {
          continue;
        }
        events.push(event);
      } catch {
        malformedCount += 1;
      }
    }
  }
  events.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  return { events, malformedCount };
}

function recordAuditEvent(event, env = process.env) {
  try {
    appendAuditEvent(event, env);
  } catch {
    void 0;
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
  return createHash("sha256").update(path.resolve(cwd, filePath)).digest("hex");
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

function extractAuditWritePath(filePath, cwd) {
  if (!isInsideCwd(filePath, cwd)) {
    return null;
  }
  const relative = path.relative(path.resolve(cwd), path.resolve(cwd, filePath)).split(path.sep).join("/");
  return sanitizeAuditPath(relative);
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
    return normalizeLane(subagentType) ?? BUILTIN_LANE;
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

function sanitizeIdentifier(value, maxLength = DESCRIPTION_MAX_LENGTH) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    !/^[A-Za-z0-9:_./-]+$/.test(value) ||
    /(?:^|[:._/-])(?:api[_-]?key|token|secret|password)(?:[:._/-]|$)/i.test(value) ||
    /(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}/.test(value) ||
    /[A-Za-z0-9_]{48,}/.test(value)
  ) {
    return null;
  }
  return value;
}

function normalizeLane(value) {
  if (value === BUILTIN_LANE || value === "grok" || value === "codex") {
    return value;
  }
  return typeof value === "string" && value.startsWith("fusion:") ? sanitizeIdentifier(value, 80) : null;
}

function sanitizeAuditText(value, maxLength = DESCRIPTION_MAX_LENGTH) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  let sanitized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  sanitized = sanitized.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  sanitized = sanitized.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@");
  sanitized = sanitized.replace(/\b(api[_-]?key|access[_-]?token|authorization|password|passwd|secret|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]");
  sanitized = sanitized.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,})\b/g, "[redacted]");
  sanitized = sanitized.replace(/\b[A-Za-z0-9+/_=-]{64,}\b/g, "[redacted]");
  return sanitized ? sanitized.slice(0, maxLength) : null;
}

function sanitizeAuditPath(value) {
  if (typeof value !== "string" || /(?:^|[:._/-])(?:api[_-]?key|access[_-]?token|authorization|password|passwd|secret|token)(?:[:._/-]|$)/i.test(value)) {
    return null;
  }
  const sanitized = sanitizeAuditText(value, AUDIT_PATH_MAX_LENGTH)?.replace(/\\/g, "/");
  if (!sanitized || sanitized.includes("[redacted]") || path.posix.isAbsolute(sanitized) || sanitized.split("/").includes("..")) {
    return null;
  }
  return sanitized;
}

function extractDispatchDescription(toolInput) {
  if (!toolInput || typeof toolInput !== "object") {
    return null;
  }
  return sanitizeAuditText(toolInput.description ?? null);
}

function totalDispatches(dispatches) {
  return Object.values(dispatches ?? {}).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

function budgetMultiple(writeCount, budget) {
  return Math.floor(writeCount / budget);
}

function defaultState(now) {
  return {
    writeCount: 0,
    writesSinceDispatch: 0,
    inlineWriteBytes: 0,
    tailWritesSinceDispatch: 0,
    writtenPathSignatures: [],
    dispatchEpoch: 0,
    lastDispatchAt: null,
    fleetWaveWidth: 0,
    consecutiveNarrowWaves: 0,
    lastAdvisedNarrowWaveStreak: 0,
    dispatches: {},
    dispatchLog: [],
    advisedMultiples: [],
    advisorySignatures: {},
    createdAt: now,
    updatedAt: now
  };
}

function normalizeDispatches(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const dispatches = {};
  for (const [lane, count] of Object.entries(value)) {
    const safeLane = normalizeLane(lane) ?? BUILTIN_LANE;
    if (Number.isFinite(count) && count >= 0) {
      dispatches[safeLane] = (dispatches[safeLane] ?? 0) + Math.floor(count);
    }
  }
  return dispatches;
}

function normalizeDispatchLog(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries = [];
  for (const raw of value.slice(-DISPATCH_LOG_LIMIT)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const atMs = Date.parse(raw.at);
    const lane = normalizeLane(raw.lane) ?? BUILTIN_LANE;
    const subagentType = sanitizeIdentifier(raw.subagentType);
    const description = sanitizeAuditText(raw.description);
    const toolUseId = sanitizeIdentifier(raw.toolUseId, 200);
    const phase = raw.phase === "launched" ? "launched" : "confirmed";
    entries.push({
      at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : null,
      lane,
      phase,
      ...(toolUseId ? { toolUseId } : {}),
      ...(subagentType ? { subagentType } : {}),
      ...(description ? { description } : {})
    });
  }
  return entries;
}

function pruneExpiredLaunchedDispatches(dispatchLog, now) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    return dispatchLog;
  }
  return dispatchLog.filter((entry) => {
    if (entry.phase === "confirmed") {
      return true;
    }
    const launchedAtMs = Date.parse(entry.at);
    return Number.isFinite(launchedAtMs) && nowMs - launchedAtMs <= LAUNCHED_DISPATCH_TTL_MS;
  });
}

function normalizeAdvisedMultiples(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((multiple) => Number.isInteger(multiple) && multiple > 0))];
}

function normalizeWrittenPathSignatures(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((signature) => typeof signature === "string" && /^[a-f0-9]{64}$/.test(signature)))];
}

function normalizeAdvisorySignatures(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const signatures = {};
  for (const [kind, signature] of Object.entries(value)) {
    if (/^[a-z][a-z0-9-]{0,79}$/.test(kind) && typeof signature === "string" && signature.length > 0 && signature.length <= 1024) {
      signatures[kind] = signature;
    }
  }
  return signatures;
}

function extractToolUseId(input) {
  return sanitizeIdentifier(input?.tool_use_id, 200);
}

function latestConfirmedDispatchAt(dispatchLog) {
  let latestAtMs = null;
  for (const entry of dispatchLog) {
    if (entry.phase !== "confirmed") {
      continue;
    }
    const atMs = Date.parse(entry.at);
    if (Number.isFinite(atMs) && (latestAtMs === null || atMs > latestAtMs)) {
      latestAtMs = atMs;
    }
  }
  return latestAtMs === null ? null : new Date(latestAtMs).toISOString();
}

function findLaunchedDispatch(dispatchLog, toolUseId, lane) {
  if (toolUseId) {
    const byToolUseId = dispatchLog.findLast((entry) => entry.phase === "launched" && entry.toolUseId === toolUseId);
    if (byToolUseId) {
      return byToolUseId;
    }
  }
  return dispatchLog.findLast((entry) => entry.phase === "launched" && entry.lane === lane) ?? null;
}

function deriveFleetWaveState(dispatchLog, waveGapMs) {
  let fleetWaveWidth = 0;
  let consecutiveNarrowWaves = 0;
  let previousDispatchAtMs = null;
  for (const entry of dispatchLog) {
    if (entry.phase !== "confirmed") {
      continue;
    }
    const dispatchAtMs = Date.parse(entry.at);
    if (!Number.isFinite(dispatchAtMs)) {
      continue;
    }
    if (previousDispatchAtMs !== null && Math.abs(dispatchAtMs - previousDispatchAtMs) <= waveGapMs) {
      fleetWaveWidth += 1;
    } else {
      if (fleetWaveWidth > 0) {
        consecutiveNarrowWaves = fleetWaveWidth <= 2 ? consecutiveNarrowWaves + 1 : 0;
      }
      fleetWaveWidth = 1;
    }
    previousDispatchAtMs = dispatchAtMs;
  }
  return { fleetWaveWidth, consecutiveNarrowWaves };
}

function normalizeState(existing, now, waveGapMs = DEFAULT_FLEET_WAVE_GAP_MS) {
  if (!existing || typeof existing !== "object") {
    return defaultState(now);
  }
  const writeCount = Number.isFinite(existing.writeCount) && existing.writeCount >= 0 ? Math.floor(existing.writeCount) : 0;
  const dispatches = normalizeDispatches(existing.dispatches);
  const dispatchCount = totalDispatches(dispatches);
  const writesSinceDispatch = Number.isFinite(existing.writesSinceDispatch) && existing.writesSinceDispatch >= 0 ? Math.floor(existing.writesSinceDispatch) : 0;
  const inlineWriteBytes = Number.isSafeInteger(existing.inlineWriteBytes) && existing.inlineWriteBytes >= 0 ? existing.inlineWriteBytes : 0;
  const tailWritesSinceDispatch =
    Number.isSafeInteger(existing.tailWritesSinceDispatch) && existing.tailWritesSinceDispatch >= 0 ? existing.tailWritesSinceDispatch : 0;
  const writtenPathSignatures = normalizeWrittenPathSignatures(existing.writtenPathSignatures);
  const advisedMultiples = normalizeAdvisedMultiples(existing.advisedMultiples);
  const advisorySignatures = normalizeAdvisorySignatures(existing.advisorySignatures);
  const dispatchLog = pruneExpiredLaunchedDispatches(normalizeDispatchLog(existing.dispatchLog), now);
  const createdAtMs = Date.parse(existing.createdAt);
  const lastDispatchAtMs = Date.parse(existing.lastDispatchAt);
  const derivedFleetWaveState = deriveFleetWaveState(dispatchLog, waveGapMs);
  const fleetWaveWidth = Number.isInteger(existing.fleetWaveWidth) && existing.fleetWaveWidth >= 0 ? existing.fleetWaveWidth : derivedFleetWaveState.fleetWaveWidth;
  const consecutiveNarrowWaves =
    Number.isInteger(existing.consecutiveNarrowWaves) && existing.consecutiveNarrowWaves >= 0 ? existing.consecutiveNarrowWaves : derivedFleetWaveState.consecutiveNarrowWaves;
  const lastAdvisedNarrowWaveStreak =
    Number.isInteger(existing.lastAdvisedNarrowWaveStreak) && existing.lastAdvisedNarrowWaveStreak >= 0 ? existing.lastAdvisedNarrowWaveStreak : 0;
  return {
    writeCount,
    writesSinceDispatch,
    inlineWriteBytes,
    tailWritesSinceDispatch,
    writtenPathSignatures,
    dispatchEpoch: Number.isInteger(existing.dispatchEpoch) && existing.dispatchEpoch >= 0 ? existing.dispatchEpoch : dispatchCount,
    lastDispatchAt: Number.isFinite(lastDispatchAtMs) ? new Date(lastDispatchAtMs).toISOString() : null,
    fleetWaveWidth,
    consecutiveNarrowWaves,
    lastAdvisedNarrowWaveStreak,
    dispatches,
    dispatchLog,
    advisedMultiples,
    advisorySignatures,
    createdAt: Number.isFinite(createdAtMs) ? new Date(createdAtMs).toISOString() : now,
    updatedAt: now
  };
}

function stableAdvisorySignature(values) {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function claimAdvisory(file, kind, signature, now, waveGapMs, isCurrent = () => true) {
  try {
    return withStateLock(file, () => {
      const state = normalizeState(readState(file), now, waveGapMs);
      if (!isCurrent(state)) {
        return { skipped: true, suppressed: false };
      }
      const suppressed = state.advisorySignatures[kind] === signature;
      state.advisorySignatures[kind] = signature;
      writeState(file, state);
      return { skipped: false, suppressed };
    });
  } catch {
    return { skipped: false, suppressed: false };
  }
}

function allowOutput(reason, additionalContext) {
  const hookSpecificOutput = { hookEventName: "PreToolUse", permissionDecision: "allow" };
  if (reason) {
    hookSpecificOutput.permissionDecisionReason = reason;
  }
  if (additionalContext) {
    hookSpecificOutput.additionalContext = additionalContext;
  }
  return { hookSpecificOutput };
}

function denyOutput(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function postToolAdvisoryOutput(additionalContext) {
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } };
}

function buildAdvisoryLine(writeCount, dispatchCount) {
  const countSummary =
    dispatchCount === 0
      ? `${writeCount} inline writes happened this session with zero dispatches. `
      : `${writeCount} inline writes happened since the most recent dispatch; this session has ${dispatchCount} dispatch${dispatchCount === 1 ? "" : "es"}. `;
  return (
    countSummary +
    "The next package belongs in a lane: quick scoped work goes to the codex quick tier gpt-5.6-terra at effort xhigh; " +
    "trivial or high-volume work goes to gpt-5.6-luna at effort xhigh; work needing the Claude Code tool surface goes to fusion:fast-worker."
  );
}

function buildTailAllowanceAdvisory(remainingTailSlots) {
  return `The inline write budget is exhausted. Tail allowance permits this small Edit to an already touched file; ${remainingTailSlots} tail ${remainingTailSlots === 1 ? "slot" : "slots"} remain in this dispatch window.`;
}

function buildZeroDispatchAdvisory(remainingWrites, remainingBytes) {
  return `The inline write budget is exhausted, but this zero dispatch session remains within its inline relief bounds; ${remainingWrites} ${remainingWrites === 1 ? "write" : "writes"} and ${remainingBytes} ${remainingBytes === 1 ? "byte" : "bytes"} remain before enforcement resumes.`;
}

function runAllowCommand() {
  process.stdout.write("fusion inline delegation guard: the allow escape hatch is retired; dispatch an Agent or Task to open a new write window, or set FUSION_INLINE_GUARD_MODE=advisory for compatibility\n");
}

function runHook(env = process.env, input = readHookInput()) {
  if (!input) {
    return;
  }
  if (isSubagentPayload(input)) {
    return;
  }
  const sessionId = normalizeSessionId(input.session_id);
  const toolName = input.tool_name;
  const cwd = input.cwd;
  if (!sessionId || typeof toolName !== "string" || !toolName) {
    return;
  }

  const stateDir = resolveStateDir(env);
  pruneStaleState(stateDir);
  const file = stateFile(stateDir, sessionId);
  const now = new Date().toISOString();

  if (DELEGATION_TOOLS.has(toolName)) {
    if (input.hook_event_name && input.hook_event_name !== "PreToolUse" && input.hook_event_name !== "PostToolUse") {
      return;
    }
    const subagentType = extractSubagentType(input.tool_input);
    const safeSubagentType = sanitizeIdentifier(subagentType);
    const lane = laneForSubagentType(subagentType);
    const description = extractDispatchDescription(input.tool_input);
    const toolUseId = extractToolUseId(input);
    const waveGapMs = resolveFleetWaveGapMs(env);

    if (input.hook_event_name === "PreToolUse") {
      withStateLock(file, () => {
        const state = normalizeState(readState(file), now, waveGapMs);
        state.dispatchLog.push({
          at: now,
          lane,
          phase: "launched",
          ...(toolUseId ? { toolUseId } : {}),
          ...(safeSubagentType ? { subagentType: safeSubagentType } : {}),
          ...(description ? { description } : {})
        });
        if (state.dispatchLog.length > DISPATCH_LOG_LIMIT) {
          state.dispatchLog.splice(0, state.dispatchLog.length - DISPATCH_LOG_LIMIT);
        }
        writeState(file, state);
      });
      return;
    }

    const confirmation = withStateLock(file, () => {
      const state = normalizeState(readState(file), now, waveGapMs);
      let launched = findLaunchedDispatch(state.dispatchLog, toolUseId, lane);
      const recoveredMissingLaunch = launched === null;
      if (recoveredMissingLaunch) {
        launched = {
          at: now,
          lane,
          phase: "confirmed",
          ...(toolUseId ? { toolUseId } : {}),
          ...(safeSubagentType ? { subagentType: safeSubagentType } : {}),
          ...(description ? { description } : {})
        };
        state.dispatchLog.push(launched);
        if (state.dispatchLog.length > DISPATCH_LOG_LIMIT) {
          state.dispatchLog.splice(0, state.dispatchLog.length - DISPATCH_LOG_LIMIT);
        }
      } else {
        launched.phase = "confirmed";
        if (description) {
          launched.description = description;
        }
      }
      const fleetWaveState = deriveFleetWaveState(state.dispatchLog, waveGapMs);
      state.fleetWaveWidth = fleetWaveState.fleetWaveWidth;
      state.consecutiveNarrowWaves = fleetWaveState.consecutiveNarrowWaves;
      if (state.consecutiveNarrowWaves === 0) {
        state.lastAdvisedNarrowWaveStreak = 0;
      }
      const shouldAdvise =
        state.consecutiveNarrowWaves > 0 &&
        state.consecutiveNarrowWaves % 2 === 0 &&
        state.lastAdvisedNarrowWaveStreak !== state.consecutiveNarrowWaves;
      if (shouldAdvise) {
        state.lastAdvisedNarrowWaveStreak = state.consecutiveNarrowWaves;
      }
      state.dispatches[launched.lane] = (state.dispatches[launched.lane] ?? 0) + 1;
      state.dispatchEpoch += 1;
      state.lastDispatchAt = latestConfirmedDispatchAt(state.dispatchLog);
      state.writesSinceDispatch = 0;
      state.tailWritesSinceDispatch = 0;
      state.writtenPathSignatures = [];
      state.advisedMultiples = [];
      writeState(file, state);
      return {
        shouldAdvise,
        streak: state.consecutiveNarrowWaves,
        fleetWaveWidth: state.fleetWaveWidth,
        dispatchEpoch: state.dispatchEpoch,
        lane: launched.lane,
        description: launched.description ?? description,
        recoveredMissingLaunch
      };
    });
    if (confirmation.recoveredMissingLaunch) {
      recordAuditEvent(
        { at: now, session: sessionId, event: "warn", lane: confirmation.lane, tool: toolName, reason: MISSING_LAUNCH_RECOVERY_REASON },
        env
      );
    }
    recordAuditEvent(
      { at: now, session: sessionId, event: "dispatch", lane: confirmation.lane, tool: toolName, ...(confirmation.description ? { description: confirmation.description } : {}) },
      env
    );
    if (confirmation.shouldAdvise) {
      const advisory = claimAdvisory(
        file,
        "narrow-wave",
        stableAdvisorySignature([confirmation.streak, confirmation.fleetWaveWidth]),
        now,
        waveGapMs,
        (state) => state.dispatchEpoch === confirmation.dispatchEpoch && state.consecutiveNarrowWaves === confirmation.streak
      );
      if (!advisory.skipped) {
        recordAuditEvent(
          {
            at: now,
            session: sessionId,
            event: "warn",
            lane: confirmation.lane,
            tool: toolName,
            reason: NARROW_WAVE_ADVISORY_REASON,
            ...(advisory.suppressed ? { suppressed: true } : {})
          },
          env
        );
        if (!advisory.suppressed) {
          process.stdout.write(`${JSON.stringify(postToolAdvisoryOutput(`${confirmation.streak} ${NARROW_WAVE_ADVISORY_SUFFIX}`))}\n`);
        }
      }
    }
    return;
  }

  if (TASK_CONTROL_TOOLS.has(toolName)) {
    if (input.hook_event_name && input.hook_event_name !== "PreToolUse") {
      return;
    }
    const taskId = extractTaskControlId(input.tool_input);
    const record = taskId ? findWorkerRecordForTaskControlId(taskId, env) : null;
    if (!record || !REAPED_WORKER_TERMINAL_STATUSES.has(record.transportStatus)) {
      return;
    }
    const mode = resolveMode(env);
    const reason = reapedWorkerRedirectReason(record, taskId);
    const advisory =
      mode === "advisory"
        ? claimAdvisory(
            file,
            "reaped-worker-redirect",
            stableAdvisorySignature([toolName, taskId, record.taskId ?? null, record.transportStatus, record.outputFile ?? null, record.transcriptPath ?? null]),
            now,
            resolveFleetWaveGapMs(env)
          )
        : { skipped: false, suppressed: false };
    recordAuditEvent(
      {
        at: now,
        session: sessionId,
        event: mode === "advisory" ? "warn" : "deny",
        lane: MAIN_LANE,
        tool: toolName,
        description: REAPED_WORKER_REDIRECT_AUDIT_DESCRIPTION,
        mode,
        ...(advisory.suppressed ? { suppressed: true } : {})
      },
      env
    );
    if (mode !== "advisory" || !advisory.suppressed) {
      process.stdout.write(`${JSON.stringify(mode === "advisory" ? allowOutput(reason) : denyOutput(reason))}\n`);
    }
    return;
  }

  if (toolName === BASH_TOOL) {
    if (input.hook_event_name && input.hook_event_name !== "PreToolUse") {
      return;
    }
    const command = extractBashCommand(input.tool_input);
    const inFlightSignature = sessionId ? inFlightWorkerTaskSignature(sessionId, env) : null;
    if (command === null || !NO_OP_BASH_COMMANDS.has(command) || !inFlightSignature) {
      return;
    }
    const mode = resolveMode(env);
    const budget = resolveBudget(env);
    let writeCount = 0;
    let dispatchCount = 0;
    let dispatchEpoch = 0;
    try {
      const snapshot = withStateLock(file, () => normalizeState(readState(file), now, resolveFleetWaveGapMs(env)));
      writeCount = snapshot.writesSinceDispatch;
      dispatchCount = totalDispatches(snapshot.dispatches);
      dispatchEpoch = snapshot.dispatchEpoch;
    } catch {
      void 0;
    }
    const auditEvent = {
      at: now,
      session: sessionId,
      event: mode === "advisory" ? "warn" : "deny",
      lane: MAIN_LANE,
      tool: BASH_TOOL,
      writeCount,
      dispatchCount,
      budget,
      mode
    };
    const advisory =
      mode === "advisory"
        ? claimAdvisory(
            file,
            "heartbeat",
            stableAdvisorySignature([inFlightSignature, writeCount, dispatchCount, dispatchEpoch, budget]),
            now,
            resolveFleetWaveGapMs(env)
          )
        : { skipped: false, suppressed: false };
    if (advisory.suppressed) {
      auditEvent.suppressed = true;
    }
    recordAuditEvent(auditEvent, env);
    if (mode === "advisory") {
      if (!advisory.suppressed) {
        process.stdout.write(`${JSON.stringify(allowOutput(NO_OP_HEARTBEAT_REASON))}\n`);
      }
      return;
    }
    process.stdout.write(`${JSON.stringify(denyOutput(NO_OP_HEARTBEAT_REASON))}\n`);
    return;
  }

  if (!WRITE_TOOLS.has(toolName)) {
    return;
  }

  const targetPath = extractWritePath(input.tool_input);
  if (!isInsideCwd(targetPath, cwd)) {
    return;
  }

  const auditPath = extractAuditWritePath(targetPath, cwd);
  const budget = resolveBudget(env);
  const mode = resolveMode(env);
  const writeBytes = inlineWriteBytes(input.tool_input);
  const replacementBytes = toolName === "Edit" ? editReplacementBytes(input.tool_input) : null;
  const pathSignature = writePathSignature(targetPath, cwd);
  const tailMaxBytes = resolveTailMaxBytes(env);
  const tailAllowance = resolveTailAllowance(env);
  const zeroDispatchMaxBytes = resolveZeroDispatchMaxBytes(env);
  const zeroDispatchWrites = resolveZeroDispatchWrites(env);
  const decision = withStateLock(file, () => {
    const state = normalizeState(readState(file), now, resolveFleetWaveGapMs(env));
    const dispatchCount = totalDispatches(state.dispatches);
    let relief = null;
    if (mode === "enforce" && state.writesSinceDispatch >= budget) {
      const tailAllowed =
        toolName === "Edit" &&
        replacementBytes !== null &&
        replacementBytes <= tailMaxBytes &&
        tailAllowance > 0 &&
        state.tailWritesSinceDispatch < tailAllowance &&
        state.writtenPathSignatures.includes(pathSignature);
      const zeroDispatchAllowed =
        !tailAllowed &&
        dispatchCount === 0 &&
        state.writeCount < zeroDispatchWrites &&
        state.inlineWriteBytes + writeBytes < zeroDispatchMaxBytes;
      if (!tailAllowed && !zeroDispatchAllowed) {
        return { denied: true, writeCount: state.writesSinceDispatch, dispatchCount };
      }
      relief = tailAllowed ? TAIL_ALLOW_AUDIT_EVENT : ZERO_DISPATCH_SOFTENED_AUDIT_EVENT;
    }
    state.writeCount += 1;
    state.writesSinceDispatch += 1;
    state.inlineWriteBytes += writeBytes;
    if (!state.writtenPathSignatures.includes(pathSignature)) {
      state.writtenPathSignatures.push(pathSignature);
    }
    if (relief === TAIL_ALLOW_AUDIT_EVENT) {
      state.tailWritesSinceDispatch += 1;
    }
    const multiple = budgetMultiple(state.writesSinceDispatch, budget);
    let candidate = null;
    if (multiple >= 1 && !state.advisedMultiples.includes(multiple)) {
      state.advisedMultiples.push(multiple);
      if (!relief) {
        candidate = { multiple, writeCount: state.writesSinceDispatch, dispatchEpoch: state.dispatchEpoch };
      }
    }
    writeState(file, state);
    return {
      denied: false,
      writeCount: state.writesSinceDispatch,
      dispatchCount,
      candidate,
      relief,
      dispatchEpoch: state.dispatchEpoch,
      remainingTailSlots: tailAllowance - state.tailWritesSinceDispatch,
      remainingZeroDispatchWrites: zeroDispatchWrites - state.writeCount,
      remainingZeroDispatchBytes: zeroDispatchMaxBytes - state.inlineWriteBytes
    };
  });

  if (decision.denied) {
    recordAuditEvent(
      {
        at: now,
        session: sessionId,
        event: "deny",
        lane: MAIN_LANE,
        tool: toolName,
        ...(auditPath ? { path: auditPath } : {}),
        writeCount: decision.writeCount,
        dispatchCount: decision.dispatchCount,
        budget,
        mode
      },
      env
    );
    const advisory = buildAdvisoryLine(decision.writeCount, decision.dispatchCount);
    process.stdout.write(`${JSON.stringify(denyOutput(`${advisory} The inline write budget is exhausted. Dispatch an Agent or Task before another main-loop write.`))}\n`);
    return;
  }

  recordAuditEvent({ at: now, session: sessionId, event: "write", lane: MAIN_LANE, tool: toolName, ...(auditPath ? { path: auditPath } : {}) }, env);
  if (decision.relief) {
    const advisory = claimAdvisory(
      file,
      decision.relief,
      stableAdvisorySignature(
        decision.relief === TAIL_ALLOW_AUDIT_EVENT
          ? [decision.dispatchEpoch, decision.remainingTailSlots]
          : [decision.remainingZeroDispatchWrites, decision.remainingZeroDispatchBytes]
      ),
      now,
      resolveFleetWaveGapMs(env)
    );
    const auditEvent = {
      at: now,
      session: sessionId,
      event: decision.relief,
      lane: MAIN_LANE,
      tool: toolName,
      ...(auditPath ? { path: auditPath } : {}),
      writeCount: decision.writeCount,
      dispatchCount: decision.dispatchCount,
      budget,
      mode
    };
    if (decision.relief === TAIL_ALLOW_AUDIT_EVENT) {
      auditEvent.remainingTailSlots = decision.remainingTailSlots;
    } else {
      auditEvent.remainingZeroDispatchWrites = decision.remainingZeroDispatchWrites;
      auditEvent.remainingZeroDispatchBytes = decision.remainingZeroDispatchBytes;
    }
    if (advisory.suppressed) {
      auditEvent.suppressed = true;
    }
    recordAuditEvent(auditEvent, env);
    if (!advisory.suppressed) {
      const line =
        decision.relief === TAIL_ALLOW_AUDIT_EVENT
          ? buildTailAllowanceAdvisory(decision.remainingTailSlots)
          : buildZeroDispatchAdvisory(decision.remainingZeroDispatchWrites, decision.remainingZeroDispatchBytes);
      process.stdout.write(`${JSON.stringify(allowOutput(line, line))}\n`);
    }
    return;
  }
  if (decision.candidate) {
    const advisory = claimAdvisory(
      file,
      "write-budget",
      stableAdvisorySignature([decision.candidate.multiple, budget, decision.candidate.dispatchEpoch]),
      now,
      resolveFleetWaveGapMs(env),
      (state) => state.dispatchEpoch === decision.candidate.dispatchEpoch && state.advisedMultiples.includes(decision.candidate.multiple)
    );
    if (!advisory.skipped) {
      recordAuditEvent(
        {
          at: now,
          session: sessionId,
          event: "warn",
          lane: MAIN_LANE,
          tool: toolName,
          ...(auditPath ? { path: auditPath } : {}),
          writeCount: decision.writeCount,
          dispatchCount: decision.dispatchCount,
          budget,
          mode,
          ...(advisory.suppressed ? { suppressed: true } : {})
        },
        env
      );
      if (!advisory.suppressed) {
        const line = buildAdvisoryLine(decision.writeCount, decision.dispatchCount);
        process.stdout.write(`${JSON.stringify(allowOutput(line))}\n`);
      }
    }
  }
}

function main() {
  const [subcommand] = process.argv.slice(2);
  if (subcommand === "allow") {
    runAllowCommand();
    return;
  }
  const input = readHookInput();
  try {
    runHook(process.env, input);
  } catch {
    const targetPath = extractWritePath(input?.tool_input);
    if (resolveMode(process.env) === "enforce" && input && !isSubagentPayload(input) && WRITE_TOOLS.has(input.tool_name) && isInsideCwd(targetPath, input.cwd)) {
      process.stdout.write(`${JSON.stringify(denyOutput("Fusion inline write state is unavailable. Retry after restoring private guard state access."))}\n`);
    }
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
  extractAuditWritePath,
  extractWritePath,
  isInsideCwd,
  isSubagentPayload,
  laneForSubagentType,
  listAuditSegments,
  normalizeAuditEvent,
  normalizeSessionId,
  readAuditEvents,
  resolveAuditDir,
  resolveAuditMaxBytes,
  resolveAuditMaxFiles,
  resolveAuditRetentionDays,
  resolveBudget,
  resolveLockTimeoutMs,
  resolveMode,
  resolveStateDir,
  resolveTailAllowance,
  resolveTailMaxBytes,
  resolveZeroDispatchMaxBytes,
  resolveZeroDispatchWrites,
  sanitizeAuditPath,
  sanitizeAuditText,
  stateFile,
  totalDispatches
};
