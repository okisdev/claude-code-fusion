import { resolveAuditDir, resolveAuditMaxBytes, resolveAuditMaxFiles, resolveAuditRetentionDays } from "./config.mjs";
import { AUDIT_FILE_PATTERN, AUDIT_SCHEMA_VERSION, BASH_TOOL, DAY_MS, DELEGATION_TOOLS, ENFORCEMENT_AUDIT_TOOLS, MAIN_LANE, MISSING_LAUNCH_RECOVERY_REASON, READ_STREAK_ADVISORY_REASON, REAPED_WORKER_REDIRECT_AUDIT_DESCRIPTION, TASK_CONTROL_TOOLS } from "./constants.mjs";
import { normalizeLane, sanitizeAuditPath, sanitizeAuditText } from "./dispatch.mjs";
import { REPLAY_KINDS } from "./replay.mjs";
import { normalizeSessionId } from "./state.mjs";
import { withFileLock, writeFileAtomic } from "../storage.mjs";
import { normalizeMessageId } from "./verification.mjs";
import fs from "node:fs";
import path from "node:path";

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

function readAuditPointer(auditDir, date) {
  try {
    const name = fs.readFileSync(path.join(auditDir, ".current"), "utf8").trim();
    const match = AUDIT_FILE_PATTERN.exec(name);
    if (match?.[1] !== date) return null;
    const file = path.join(auditDir, name);
    const stat = fs.statSync(file);
    return { file, date, index: Number.parseInt(match[2] ?? "0", 10), size: stat.size };
  } catch {
    return null;
  }
}

function selectAuditSegment(auditDir, date, maxBytes, lineBytes) {
  const latest = readAuditPointer(auditDir, date) ?? listAuditSegments(auditDir)
    .filter((segment) => segment.date === date)
    .sort((left, right) => left.index - right.index).at(-1);
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
  const stamp = path.join(auditDir, ".retention-stamp");
  const currentTime = Date.now();
  let due = true;
  try {
    due = currentTime - fs.statSync(stamp).mtimeMs >= 60 * 60 * 1000;
  } catch { void 0; }
  if (due) {
    withFileLock(path.join(auditDir, ".retention"), () => {
      let last = -Infinity;
      try { last = fs.statSync(stamp).mtimeMs; } catch { void 0; }
      if (currentTime - last < 60 * 60 * 1000) return;
      pruneExpiredAuditSegments(auditDir, Number.isFinite(nowMs) ? nowMs : currentTime, resolveAuditRetentionDays(env));
      writeFileAtomic(stamp, "");
      fs.utimesSync(stamp, new Date(currentTime), new Date(currentTime));
    });
  }
  const rotated = withFileLock(path.join(auditDir, ".append"), () => {
    const previous = readAuditPointer(auditDir, date)?.file;
    const file = selectAuditSegment(auditDir, date, resolveAuditMaxBytes(env), Buffer.byteLength(line));
    appendAuditLine(file, line);
    writeFileAtomic(path.join(auditDir, ".current"), path.basename(file));
    return file !== previous;
  });
  if (rotated) {
    withFileLock(path.join(auditDir, ".retention"), () => {
      const active = fs.readFileSync(path.join(auditDir, ".current"), "utf8").trim();
      enforceAuditFileLimit(auditDir, resolveAuditMaxFiles(env), path.join(auditDir, active));
    });
  }
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
  const replay = Number.isSafeInteger(event.replayTokens) && event.replayTokens >= 0 ? { replayTokens: event.replayTokens } : {};
  const digest = Number.isInteger(event.messageCode) && event.messageCode >= 1000 && event.messageCode <= 9999 ? { messageCode: event.messageCode } : {};
  if (event.event === "write" && ENFORCEMENT_AUDIT_TOOLS.has(event.tool) && event.lane === MAIN_LANE) {
    const safePath = sanitizeAuditPath(event.path);
    return {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      at: new Date(atMs).toISOString(),
      session,
      event: "write",
      lane: MAIN_LANE,
      tool: event.tool,
      ...digest,
      ...(safePath ? { path: safePath } : {}),
      ...(Number.isSafeInteger(event.writeCount) && event.writeCount >= 0 ? { writeCount: event.writeCount } : {}),
      ...replay,
      ...(Number.isSafeInteger(event.budget) && event.budget > 0 ? { budget: event.budget } : {})
    };
  }
  if (
    event.event === "verification" &&
    event.tool === BASH_TOOL &&
    event.lane === MAIN_LANE &&
    Number.isInteger(event.writeCount) &&
    event.writeCount >= 0 &&
    Number.isInteger(event.dispatchCount) &&
    event.dispatchCount >= 0 &&
    Number.isInteger(event.budget) &&
    event.budget > 0 &&
    (event.mode === undefined || event.mode === "enforce" || event.mode === "advisory")
  ) {
    return {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      at: new Date(atMs).toISOString(),
      session,
      event: "verification",
      lane: MAIN_LANE,
      tool: BASH_TOOL,
      writeCount: event.writeCount,
      dispatchCount: event.dispatchCount,
      budget: event.budget,
      ...replay,
      ...(event.mode ? { mode: event.mode } : {}),
      ...digest,
      ...(event.evidence === "exit-status" || event.evidence === "output-summary" ? { evidence: event.evidence } : {})
    };
  }
  if (["tail-allowed", "zero-dispatch-softened"].includes(event.event) && ENFORCEMENT_AUDIT_TOOLS.has(event.tool) && event.lane === MAIN_LANE) {
    const safePath = sanitizeAuditPath(event.path);
    return { schemaVersion: AUDIT_SCHEMA_VERSION, at: new Date(atMs).toISOString(), session, event: event.event, lane: MAIN_LANE, tool: event.tool, ...digest, ...(safePath ? { path: safePath } : {}) };
  }
  if (event.event === "dispatch" && DELEGATION_TOOLS.has(event.tool)) {
    const lane = normalizeLane(event.lane);
    const description = sanitizeAuditText(event.description);
    const messageId = normalizeMessageId(event.messageId);
    return lane
      ? { schemaVersion: AUDIT_SCHEMA_VERSION, at: new Date(atMs).toISOString(), session, event: "dispatch", lane, tool: event.tool, ...digest, ...(messageId ? { messageId } : {}), ...(description ? { description } : {}) }
      : null;
  }
  if (event.event === "warn" && DELEGATION_TOOLS.has(event.tool) && event.reason === MISSING_LAUNCH_RECOVERY_REASON) {
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
          ...digest,
        }
      : null;
  }
  if (event.event === "replay" && event.lane === MAIN_LANE && typeof event.tool === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(event.tool) &&
    typeof event.turn === "string" && /^[A-Za-z0-9_:-]{1,160}$/.test(event.turn) && REPLAY_KINDS.includes(event.kind) &&
    Number.isSafeInteger(event.tokens) && event.tokens > 0 && typeof event.measured === "boolean") {
    return {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      at: new Date(atMs).toISOString(),
      session,
      event: "replay",
      lane: MAIN_LANE,
      tool: event.tool,
      turn: event.turn,
      kind: event.kind,
      tokens: event.tokens,
      measured: event.measured
    };
  }
  if (event.event === "warn" && event.reason === READ_STREAK_ADVISORY_REASON && event.lane === MAIN_LANE &&
    (event.tool === BASH_TOOL || ["Read", "Grep", "Glob"].includes(event.tool)) &&
    (event.replayTokens === undefined || Number.isSafeInteger(event.replayTokens) && event.replayTokens >= 0)) {
    return {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      at: new Date(atMs).toISOString(),
      session,
      event: "warn",
      reason: READ_STREAK_ADVISORY_REASON,
      ...replay,
      ...(replay.replayTokens !== undefined && Number.isSafeInteger(event.budget) && event.budget > 0 ? { budget: event.budget } : {}),
      ...digest,
      lane: MAIN_LANE,
      tool: event.tool
    };
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
      ...(event.mode ? { mode: event.mode } : {}),
      ...digest,
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
    const safePath = sanitizeAuditPath(event.path);
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
      ...replay,
      ...(event.mode ? { mode: event.mode } : {}),
      ...digest,
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

export { auditSegmentName, listAuditSegments, pruneExpiredAuditSegments, fileNeedsLineBreak, readAuditPointer, selectAuditSegment, appendAuditLine, enforceAuditFileLimit, appendAuditEvent, normalizeAuditEvent, auditBoundaryMs, readAuditEvents, recordAuditEvent };
