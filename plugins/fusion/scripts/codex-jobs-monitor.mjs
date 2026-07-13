#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  FILE_ENGINE_DESCRIPTORS,
  loadModelAuditObservations,
  resolveFusionDataDir,
  fusionWorkspaceKey
} from "./fusion-stats.mjs";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_POLL_INTERVAL_MS = 15000;
const INTERVAL_ENV = "CODEX_JOBS_MONITOR_INTERVAL_MS";
const PS_COMMAND_ENV = "CODEX_JOBS_MONITOR_PS_COMMAND";
const SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";
const ERROR_MESSAGE_MAX_LENGTH = 80;
const DEAD_STATUS_KEY = "dead";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MODEL_AUDIT_FILENAME = "model-audit.jsonl";

function resolvePollIntervalMs(env = process.env) {
  const raw = env[INTERVAL_ENV];
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_MS;
}

function resolveStateRoot(env = process.env) {
  const descriptor = FILE_ENGINE_DESCRIPTORS.codex;
  const override = env[descriptor.stateEnvVar];
  return override || descriptor.defaultStateRoot(env);
}

function resolveWorkspaceRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (result.status === 0) {
    const root = result.stdout.trim();
    if (root) {
      return root;
    }
  }
  return cwd;
}

function workspaceRootInScope(recordedRoot, workspaceRoot) {
  if (typeof recordedRoot !== "string" || !recordedRoot) {
    return false;
  }
  const relative = path.relative(workspaceRoot, recordedRoot);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readWorkspaceJobsSnapshot(root, workspaceRoot, requiredJobDirs = new Set()) {
  try {
    if (!fs.statSync(root).isDirectory()) {
      return { available: false, records: [] };
    }
    const records = [];
    const sourceDirs = new Set();
    const enumeratedJobDirs = new Set();
    for (const workspace of fs.readdirSync(root, { withFileTypes: true })) {
      if (!workspace.isDirectory()) {
        continue;
      }
      const dir = path.join(root, workspace.name, "jobs");
      enumeratedJobDirs.add(dir);
      let entries;
      try {
        entries = fs.readdirSync(dir).filter((entry) => entry.endsWith(".json"));
      } catch (error) {
        if (error?.code === "ENOENT") {
          if (requiredJobDirs.has(dir)) {
            return { available: false, records: [], sourceDirs: new Set() };
          }
          continue;
        }
        return { available: false, records: [], sourceDirs: new Set() };
      }
      for (const entry of entries) {
        try {
          const record = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8"));
          if (workspaceRootInScope(record?.workspaceRoot, workspaceRoot)) {
            records.push(record);
            sourceDirs.add(dir);
          }
        } catch {
          return { available: false, records: [], sourceDirs: new Set() };
        }
      }
    }
    for (const required of requiredJobDirs) {
      if (!enumeratedJobDirs.has(required)) {
        return { available: false, records: [], sourceDirs: new Set() };
      }
    }
    return { available: true, records, sourceDirs };
  } catch {
    return { available: false, records: [], sourceDirs: new Set() };
  }
}

function truncateErrorMessage(message) {
  const firstLine = String(message).split("\n")[0].trim();
  if (firstLine.length <= ERROR_MESSAGE_MAX_LENGTH) {
    return firstLine;
  }
  return `${firstLine.slice(0, ERROR_MESSAGE_MAX_LENGTH)}...`;
}

function formatOutcomeLine(record) {
  const isFailureLike = record.status === "failed" || record.status === "cancelled";
  const failureSuffix = isFailureLike && record.errorMessage ? ` (${truncateErrorMessage(record.errorMessage)})` : "";
  return `codex job ${record.id} ${record.status}${failureSuffix}. collect with /codex:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function nonEmptyRequestField(value) {
  if (value == null) {
    return false;
  }
  return String(value).trim() !== "";
}

function recordLacksModelOrEffort(record) {
  const request = record?.request;
  if (!request || typeof request !== "object") {
    return true;
  }
  return !nonEmptyRequestField(request.model) || !nonEmptyRequestField(request.effort);
}

function readProcessArgv(pid, env = process.env) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const command = env[PS_COMMAND_ENV] || "ps";
  try {
    const result = spawnSync(command, ["-o", "args=", "-p", String(pid)], {
      encoding: "utf8"
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    const args = String(result.stdout ?? "").trim();
    return args || null;
  } catch {
    return null;
  }
}

function parseModelAndEffortFromArgv(argvLine) {
  if (!argvLine || !String(argvLine).trim()) {
    return null;
  }
  const tokens = String(argvLine).trim().split(/\s+/).filter(Boolean);
  let model = null;
  let effort = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--model" || token === "-m") {
      const value = tokens[index + 1];
      if (value && !value.startsWith("-")) {
        model = value;
        index += 1;
      }
      continue;
    }
    if (token.startsWith("--model=")) {
      const value = token.slice("--model=".length);
      if (value) {
        model = value;
      }
      continue;
    }
    if (token === "--effort") {
      const value = tokens[index + 1];
      if (value && !value.startsWith("-")) {
        effort = value;
        index += 1;
      }
      continue;
    }
    if (token.startsWith("--effort=")) {
      const value = token.slice("--effort=".length);
      if (value) {
        effort = value;
      }
    }
  }
  if (model == null && effort == null) {
    return null;
  }
  return { model, effort };
}

function modelAuditSidecarPath(workspaceRoot, env = process.env) {
  return path.join(resolveFusionDataDir(env), "observations", fusionWorkspaceKey(workspaceRoot), MODEL_AUDIT_FILENAME);
}

function appendModelAuditObservation(sidecarPath, observation) {
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  const lockPath = `${sidecarPath}.lock`;
  let lock;
  try {
    lock = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    if (loadModelAuditObservations(sidecarPath).has(observation.jobId)) {
      return true;
    }
    fs.appendFileSync(sidecarPath, `${JSON.stringify(observation)}\n`, "utf8");
    return true;
  } finally {
    fs.closeSync(lock);
    fs.rmSync(lockPath, { force: true });
  }
}

function maybeCaptureModelAudit(record, seenJobIds, sidecarPath, env = process.env) {
  if (!record?.id || seenJobIds.has(record.id)) {
    return;
  }
  if (record.status !== "running" || !recordLacksModelOrEffort(record)) {
    return;
  }
  const argvLine = readProcessArgv(record.pid, env);
  if (!argvLine) {
    return;
  }
  const parsed = parseModelAndEffortFromArgv(argvLine);
  if (!parsed) {
    return;
  }
  const observation = {
    jobId: record.id,
    engine: "codex",
    model: parsed.model,
    effort: parsed.effort,
    source: "argv",
    observedAt: new Date().toISOString()
  };
  try {
    if (appendModelAuditObservation(sidecarPath, observation)) {
      seenJobIds.add(record.id);
    }
  } catch {
    void 0;
  }
}

function announcementKey(id, status) {
  return `${id}:${status}`;
}

function workspaceKey(workspaceRoot) {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}

function announcedStatePath(stateRoot, sessionId, workspaceRoot) {
  const sessionPart = sessionId ? `.${sessionId}` : "";
  return path.join(stateRoot, `codex-jobs-monitor-announced${sessionPart}.${workspaceKey(workspaceRoot)}.json`);
}

function quarantineMalformed(file) {
  const quarantine = `${file}.corrupt.${Date.now()}.${process.pid}`;
  try {
    fs.renameSync(file, quarantine);
  } catch {}
  return quarantine;
}

function loadAnnounced(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { exists: error?.code !== "ENOENT", malformed: false, announced: new Set() };
  }
  try {
    const raw = JSON.parse(text);
    const keys = Array.isArray(raw) ? raw : Array.isArray(raw?.keys) ? raw.keys : null;
    if (!keys) {
      throw new TypeError("invalid announcement state");
    }
    return { exists: true, malformed: false, announced: new Set(keys.filter((key) => typeof key === "string")) };
  } catch {
    quarantineMalformed(file);
    return { exists: true, malformed: true, announced: new Set() };
  }
}

function saveAnnounced(file, announced) {
  const dir = path.dirname(file);
  if (!fs.statSync(dir).isDirectory()) {
    return;
  }
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify([...announced])}\n`, "utf8");
  fs.renameSync(temp, file);
}

function pruneAnnounced(announced, liveIds) {
  let dirty = false;
  for (const key of [...announced]) {
    const id = key.slice(0, key.indexOf(":"));
    if (!id || !liveIds.has(id)) {
      announced.delete(key);
      dirty = true;
    }
  }
  return dirty;
}

function pruneOldStateFiles(stateRoot, currentFile) {
  let entries;
  try {
    entries = fs.readdirSync(stateRoot);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith("codex-jobs-monitor-announced") || path.join(stateRoot, entry) === currentFile) {
      continue;
    }
    const file = path.join(stateRoot, entry);
    try {
      if (now - fs.statSync(file).mtimeMs > RETENTION_MS) {
        fs.rmSync(file, { force: true });
      }
    } catch {}
  }
}

function safeWriteLine(line) {
  try {
    process.stdout.write(`${line}\n`);
  } catch (error) {
    if (error?.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  }
}

function installExitHandlers(timer) {
  const shutdown = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);
  process.stdout.on("error", (error) => {
    if (error?.code === "EPIPE") {
      clearInterval(timer);
      process.exit(0);
    }
  });
}

function main() {
  const root = resolveStateRoot();
  const cwd = process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const ownSessionId = process.env[SESSION_ID_ENV] || null;
  const stateFile = announcedStatePath(root, ownSessionId, workspaceRoot);
  const loaded = loadAnnounced(stateFile);
  const announced = loaded.announced;
  const knownJobDirs = new Set();
  const auditStates = new Map();
  let startupPending = true;

  pruneOldStateFiles(root, stateFile);

  const processSnapshot = (snapshot) => {
    if (!snapshot.available) {
      return;
    }
    for (const sourceDir of snapshot.sourceDirs) {
      knownJobDirs.add(sourceDir);
    }
    const liveIds = new Set();
    const terminalJobIds = new Set(snapshot.records.filter((record) => record?.id && TERMINAL_STATUSES.has(record.status)).map((record) => record.id));
    let dirty = false;
    for (const record of snapshot.records) {
      if (!record?.id) {
        continue;
      }
      liveIds.add(record.id);
      if (TERMINAL_STATUSES.has(record.status)) {
        const key = announcementKey(record.id, record.status);
        if (!announced.has(key)) {
          announced.add(key);
          dirty = true;
          if (!(startupPending && !loaded.exists) && (!ownSessionId || record.sessionId === ownSessionId)) {
            safeWriteLine(formatOutcomeLine(record));
          }
        }
        continue;
      }
      const recordWorkspaceRoot = record.workspaceRoot;
      if (!auditStates.has(recordWorkspaceRoot)) {
        const sidecarPath = modelAuditSidecarPath(recordWorkspaceRoot);
        auditStates.set(recordWorkspaceRoot, {
          sidecarPath,
          seenJobIds: new Set(loadModelAuditObservations(sidecarPath).keys())
        });
      }
      const auditState = auditStates.get(recordWorkspaceRoot);
      maybeCaptureModelAudit(record, auditState.seenJobIds, auditState.sidecarPath);
      if (record.status === "running" && !isPidAlive(record.pid)) {
        if (terminalJobIds.has(record.id)) {
          continue;
        }
        const key = announcementKey(record.id, DEAD_STATUS_KEY);
        if (startupPending && loaded.malformed) {
          if (!announced.has(key)) {
            announced.add(key);
            dirty = true;
          }
          continue;
        }
        if (startupPending && !loaded.exists) {
          continue;
        }
        if (!announced.has(key)) {
          announced.add(key);
          dirty = true;
          if (!ownSessionId || record.sessionId === ownSessionId) {
            safeWriteLine(`codex job ${record.id} appears dead (process gone, status still running)`);
          }
        }
      }
    }
    if (pruneAnnounced(announced, liveIds)) {
      dirty = true;
    }
    if (startupPending && !loaded.exists) {
      dirty = true;
    }
    if (dirty) {
      saveAnnounced(stateFile, announced);
    }
    startupPending = false;
  };

  try {
    const initialSnapshot = readWorkspaceJobsSnapshot(root, workspaceRoot, knownJobDirs);
    processSnapshot(initialSnapshot);
    if (!initialSnapshot.available) {
      startupPending = false;
    }
  } catch {}

  const timer = setInterval(() => {
    try {
      processSnapshot(readWorkspaceJobsSnapshot(root, workspaceRoot, knownJobDirs));
    } catch {}
  }, resolvePollIntervalMs());

  installExitHandlers(timer);
}

main();
