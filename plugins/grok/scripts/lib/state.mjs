import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR_ENV = "GROK_COMPANION_DATA";

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
    request: fields.request ?? null
  };
}

export function writeJobRecordFile(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
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
  const existing = readJobRecordFile(file);
  if (!existing) {
    throw new Error(`No job record found at ${file}.`);
  }
  const next = { ...existing, ...patch };
  writeJobRecordFile(file, next);
  return next;
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
  const value = String(text ?? "");
  fs.appendFileSync(logFile, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

export function readLogTail(logFile, maxLines = 20) {
  if (!logFile || !fs.existsSync(logFile)) {
    return "";
  }
  const content = fs.readFileSync(logFile, "utf8").trimEnd();
  if (!content) {
    return "";
  }
  return content.split(/\r?\n/).slice(-maxLines).join("\n");
}
