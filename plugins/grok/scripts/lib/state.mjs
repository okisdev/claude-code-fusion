import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR_ENV = "GROK_COMPANION_DATA";
const JOB_LOG_MAX_BYTES = 1024 * 1024;
const LOG_TAIL_MAX_BYTES = 64 * 1024;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_RETRY_MS = 20;
const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);

export const SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";

export function resolveDataDir(env = process.env) {
  const override = env[DATA_DIR_ENV];
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "grok-claude-code-fusion");
}

export function workspaceSlug(cwd) {
  const absolute = path.resolve(cwd);
  const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 16);
  return `${path.basename(absolute)}-${hash}`;
}

export function workspaceStateDir(dataDir, cwd) {
  return path.join(dataDir, "state", workspaceSlug(cwd));
}

export function jobsDir(dataDir, cwd) {
  return path.join(workspaceStateDir(dataDir, cwd), "jobs");
}

export function briefsDir(dataDir, cwd) {
  return path.join(workspaceStateDir(dataDir, cwd), "briefs");
}

export function jobFilePath(dataDir, cwd, jobId) {
  return path.join(jobsDir(dataDir, cwd), `${jobId}.json`);
}

export function jobLogPath(dataDir, cwd, jobId) {
  return path.join(jobsDir(dataDir, cwd), `${jobId}.log`);
}

export function briefPath(dataDir, cwd, name) {
  return path.join(briefsDir(dataDir, cwd), `${name}.md`);
}

export function generateJobId() {
  return randomBytes(4).toString("hex");
}

export function nowIso() {
  return new Date().toISOString();
}

export function createJobRecord(fields) {
  return {
    id: fields.id,
    pid: fields.pid ?? null,
    grokPid: null,
    status: fields.status ?? "running",
    mode: fields.mode,
    cwd: fields.cwd,
    briefFile: fields.briefFile,
    background: Boolean(fields.background),
    claudeSessionId: fields.claudeSessionId ?? null,
    createdAt: fields.createdAt ?? nowIso(),
    finishedAt: null,
    exitCode: null,
    sessionId: null,
    resultText: null,
    errorTail: null,
    failureKind: null,
    cancelRequestedAt: null,
    request: fields.request ?? null
  };
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function atomicWriteFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, content, "utf8");
    fs.renameSync(temp, file);
  } finally {
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
  }
}

function withRecordLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lockDir = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() >= deadline) {
        throw error;
      }
      sleepMs(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {}
  }
}

function preserveTerminalRecord(existing, next) {
  if (!existing || !TERMINAL_STATUSES.has(existing.status)) {
    return next;
  }
  if (next.status !== existing.status) {
    return existing;
  }
  return next;
}

export function writeJobRecordFile(file, record) {
  withRecordLock(file, () => {
    const existing = readJobRecordFile(file);
    const next = preserveTerminalRecord(existing, record);
    atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
  });
  return file;
}

export function readJobRecordFile(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJobRecord(dataDir, cwd, record) {
  return writeJobRecordFile(jobFilePath(dataDir, cwd, record.id), record);
}

export function readJobRecord(dataDir, cwd, jobId) {
  return readJobRecordFile(jobFilePath(dataDir, cwd, jobId));
}

export function updateJobRecordFile(file, patch) {
  return withRecordLock(file, () => {
    const existing = readJobRecordFile(file);
    if (!existing) {
      throw new Error(`No job record found at ${file}.`);
    }
    if (TERMINAL_STATUSES.has(existing.status) && !Object.hasOwn(patch, "status")) {
      return existing;
    }
    const next = preserveTerminalRecord(existing, { ...existing, ...patch });
    atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function finishSuccessfulJobRecordFile(file, successPatch) {
  return withRecordLock(file, () => {
    const existing = readJobRecordFile(file);
    if (!existing) {
      throw new Error(`No job record found at ${file}.`);
    }
    if (TERMINAL_STATUSES.has(existing.status)) {
      return existing;
    }
    const treatAsCancelled =
      existing.status === "cancelled" || existing.cancelRequestedAt != null;
    const patch = treatAsCancelled
      ? {
          status: "cancelled",
          pid: null,
          grokPid: null,
          finishedAt: successPatch.finishedAt ?? nowIso(),
          exitCode: successPatch.exitCode ?? null,
          sessionId: successPatch.sessionId ?? null,
          resultText: successPatch.resultText ?? null,
          errorTail: null,
          failureKind: "cancelled",
          cancelRequestedAt: null
        }
      : { ...successPatch, cancelRequestedAt: null };
    const next = preserveTerminalRecord(existing, { ...existing, ...patch });
    atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function listJobRecords(dataDir, cwd) {
  const dir = jobsDir(dataDir, cwd);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const records = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const record = readJobRecordFile(path.join(dir, entry));
    if (record?.id) {
      records.push(record);
    }
  }
  return records.sort((left, right) =>
    String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? ""))
  );
}

export function listAllJobRecords(dataDir) {
  const stateRoot = path.join(dataDir, "state");
  if (!fs.existsSync(stateRoot)) {
    return [];
  }
  const results = [];
  for (const workspace of fs.readdirSync(stateRoot)) {
    const dir = path.join(stateRoot, workspace, "jobs");
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const file = path.join(dir, entry);
      const record = readJobRecordFile(file);
      if (record?.id) {
        results.push({ record, file });
      }
    }
  }
  return results;
}

export function findJobRecordById(dataDir, jobId) {
  return listAllJobRecords(dataDir).find((entry) => entry.record.id === jobId) ?? null;
}

export function writeBrief(dataDir, cwd, name, content) {
  const file = briefPath(dataDir, cwd, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = String(content ?? "");
  fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  return file;
}

export function appendJobLog(logFile, text) {
  if (!logFile) {
    return;
  }
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const raw = String(text ?? "");
  const value = raw.endsWith("\n") ? raw : `${raw}\n`;
  fs.appendFileSync(logFile, value.slice(-JOB_LOG_MAX_BYTES), "utf8");
  const size = fs.statSync(logFile).size;
  if (size > JOB_LOG_MAX_BYTES) {
    const fd = fs.openSync(logFile, "r");
    try {
      const keep = Buffer.alloc(JOB_LOG_MAX_BYTES);
      fs.readSync(fd, keep, 0, JOB_LOG_MAX_BYTES, size - JOB_LOG_MAX_BYTES);
      atomicWriteFile(logFile, keep.toString("utf8"));
    } finally {
      fs.closeSync(fd);
    }
  }
}

export function readLogTail(logFile, maxLines = 20) {
  if (!logFile || !fs.existsSync(logFile)) {
    return "";
  }
  const size = fs.statSync(logFile).size;
  const bytes = Math.min(size, LOG_TAIL_MAX_BYTES);
  const buffer = Buffer.alloc(bytes);
  const fd = fs.openSync(logFile, "r");
  try {
    fs.readSync(fd, buffer, 0, bytes, size - bytes);
  } finally {
    fs.closeSync(fd);
  }
  const content = buffer.toString("utf8").trimEnd();
  if (!content) {
    return "";
  }
  return content.split(/\r?\n/).slice(-maxLines).join("\n");
}
