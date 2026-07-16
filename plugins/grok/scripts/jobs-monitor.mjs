#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  SESSION_ID_ENV,
  hardenPrivateStateFile,
  jobsDir,
  readJobRecordFile,
  resolveDataDir,
  workspaceStateDir,
  writePrivateStateFile
} from "./lib/state.mjs";

const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);
const DEFAULT_POLL_INTERVAL_MS = 15000;
const INTERVAL_ENV = "GROK_JOBS_MONITOR_INTERVAL_MS";
const MANAGED_GRACE_ENV = "GROK_JOBS_MONITOR_MANAGED_GRACE_MS";
const DEFAULT_MANAGED_GRACE_MS = 60000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ANNOUNCED_LEDGER_VERSION = 2;

function resolvePollIntervalMs(env = process.env) {
  const raw = env[INTERVAL_ENV];
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_MS;
}

function resolveManagedGraceMs(env = process.env) {
  const raw = Number.parseInt(String(env[MANAGED_GRACE_ENV]), 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_MANAGED_GRACE_MS;
}

function validMonitorRecord(record) {
  return Boolean(
    record &&
      typeof record.id === "string" &&
      record.id.length > 0 &&
      typeof record.status === "string" &&
      (record.cwd == null || typeof record.cwd === "string")
  );
}

function readJobsSnapshot(dir) {
  let stats;
  try {
    stats = fs.statSync(dir);
  } catch (error) {
    return { available: false, complete: error?.code === "ENOENT", records: [], unreadableIds: new Set() };
  }
  if (!stats.isDirectory()) {
    return { available: false, complete: false, records: [], unreadableIds: new Set() };
  }
  try {
    const records = [];
    const unreadableIds = new Set();
    for (const entry of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const record = readJobRecordFile(path.join(dir, entry));
      if (!validMonitorRecord(record)) {
        unreadableIds.add(path.basename(entry, ".json"));
        continue;
      }
      records.push(record);
    }
    return { available: true, complete: true, records, unreadableIds };
  } catch {
    return { available: false, complete: false, records: [], unreadableIds: new Set() };
  }
}

function readSessionJobsSnapshot(dataDir) {
  const stateRoot = path.join(dataDir, "state");
  let workspaces;
  try {
    if (!fs.statSync(stateRoot).isDirectory()) {
      return { available: false, complete: false, records: [], unreadableIds: new Set() };
    }
    workspaces = fs.readdirSync(stateRoot);
  } catch (error) {
    return { available: false, complete: error?.code === "ENOENT", records: [], unreadableIds: new Set() };
  }

  const records = [];
  const unreadableIds = new Set();
  let available = false;
  let complete = true;
  for (const workspace of workspaces) {
    const snapshot = readJobsSnapshot(path.join(stateRoot, workspace, "jobs"));
    complete &&= snapshot.complete;
    if (!snapshot.available) {
      continue;
    }
    available = true;
    records.push(...snapshot.records);
    for (const id of snapshot.unreadableIds) {
      unreadableIds.add(id);
    }
  }
  return { available, complete, records, unreadableIds };
}

function formatOutcomeLine(record, monitorCwd, forceCwd = false) {
  const failureSuffix = record.failureKind ? ` (${record.failureKind})` : "";
  const cwdSuffix = record.cwd && (forceCwd || path.resolve(record.cwd) !== monitorCwd) ? ` --cwd ${JSON.stringify(record.cwd)}` : "";
  if (record.delivery === "managed") {
    return `grok managed job ${record.id} ${record.status}${failureSuffix} without collection by its owning agent. collect with /grok:result ${record.id}${cwdSuffix}`;
  }
  return `grok job ${record.id} ${record.status}${failureSuffix}. collect with /grok:result ${record.id}${cwdSuffix} only if you launched it detached; a job owned by a subagent reports on its own`;
}

function managedDeliveryIsPending(record, graceMs, now = Date.now()) {
  if (record.delivery !== "managed" || record.deliveryCollectedAt) {
    return false;
  }
  const finishedAt = Date.parse(record.finishedAt ?? "");
  const createdAt = Date.parse(record.createdAt ?? "");
  const referenceAt = Number.isFinite(finishedAt) ? finishedAt : createdAt;
  return Number.isFinite(referenceAt) && now - referenceAt < graceMs;
}

function workspaceKey(record) {
  return typeof record.cwd === "string" ? path.resolve(record.cwd) : null;
}

function liveKey(record) {
  return JSON.stringify([workspaceKey(record), record.id]);
}

function announcementKey(record) {
  return JSON.stringify([workspaceKey(record), record.id, record.status]);
}

function announcedKeyIsLive(key, liveKeys, unreadableIds) {
  try {
    const [cwd, id] = JSON.parse(key);
    return typeof id === "string" && (liveKeys.has(JSON.stringify([cwd, id])) || unreadableIds.has(id));
  } catch {
    return false;
  }
}

function announcedStatePath(stateDir, sessionId) {
  const name = sessionId ? `jobs-monitor-announced.${sessionId}.json` : "jobs-monitor-announced.json";
  return path.join(stateDir, name);
}

function loadAnnounced(file) {
  try {
    hardenPrivateStateFile(file);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw?.version !== ANNOUNCED_LEDGER_VERSION || !Array.isArray(raw.keys)) {
      return { exists: true, announced: new Set(), reset: true };
    }
    return { exists: true, announced: new Set(raw.keys.filter((key) => typeof key === "string")), reset: false };
  } catch (error) {
    return { exists: error?.code !== "ENOENT", announced: new Set(), reset: error?.code !== "ENOENT" };
  }
}

function saveAnnounced(file, announced) {
  writePrivateStateFile(file, `${JSON.stringify({ version: ANNOUNCED_LEDGER_VERSION, keys: [...announced] })}\n`);
}

function pruneAnnounced(announced, liveKeys, unreadableIds) {
  let dirty = false;
  for (const key of [...announced]) {
    if (!announcedKeyIsLive(key, liveKeys, unreadableIds)) {
      announced.delete(key);
      dirty = true;
    }
  }
  return dirty;
}

function pruneOldStateFiles(stateDir, currentFile) {
  let entries;
  try {
    entries = fs.readdirSync(stateDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith("jobs-monitor-announced") || path.join(stateDir, entry) === currentFile) {
      continue;
    }
    const file = path.join(stateDir, entry);
    try {
      if (now - fs.statSync(file).mtimeMs > RETENTION_MS) {
        fs.rmSync(file, { force: true });
      }
    } catch {}
  }
}

function safeWriteLine(line) {
  try {
    const buffer = Buffer.from(`${line}\n`);
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(process.stdout.fd, buffer, offset, buffer.length - offset);
      if (written <= 0) {
        throw new Error("Unable to write the Grok job notification to stdout.");
      }
      offset += written;
    }
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
  const dataDir = resolveDataDir();
  const cwd = process.cwd();
  const dir = jobsDir(dataDir, cwd);
  const stateDir = workspaceStateDir(dataDir, cwd);
  const ownSessionId = process.env[SESSION_ID_ENV] || null;
  const stateFile = announcedStatePath(stateDir, ownSessionId);
  const loaded = loadAnnounced(stateFile);
  const announced = loaded.announced;
  let resetPending = loaded.reset;
  const managedGraceMs = resolveManagedGraceMs();
  const readSnapshot = ownSessionId ? () => readSessionJobsSnapshot(dataDir) : () => readJobsSnapshot(dir);
  let startupPending = true;

  pruneOldStateFiles(stateDir, stateFile);

  const processSnapshot = (snapshot) => {
    if (!snapshot.available) {
      return;
    }
    const liveKeys = new Set();
    const duplicateWorkspacesById = new Map();
    for (const record of snapshot.records) {
      if (!record?.id) {
        continue;
      }
      const workspace = workspaceKey(record);
      liveKeys.add(liveKey(record));
      if (workspace == null) {
        continue;
      }
      const workspaces = duplicateWorkspacesById.get(record.id) ?? new Set();
      workspaces.add(workspace);
      duplicateWorkspacesById.set(record.id, workspaces);
    }
    const duplicateIds = new Set(
      [...duplicateWorkspacesById].filter(([, workspaces]) => workspaces.size > 1).map(([id]) => id),
    );
    let dirty = resetPending;
    for (const record of snapshot.records) {
      if (!record?.id) {
        continue;
      }
      if (ownSessionId && record.claudeSessionId !== ownSessionId) {
        continue;
      }
      if (!TERMINAL_STATUSES.has(record.status)) {
        continue;
      }
      if (managedDeliveryIsPending(record, managedGraceMs)) {
        continue;
      }
      const key = announcementKey(record);
      if (announced.has(key)) {
        continue;
      }
      if (startupPending && !loaded.exists && record.delivery !== "managed") {
        announced.add(key);
        dirty = true;
        continue;
      }
      if (record.background !== true) {
        announced.add(key);
        dirty = true;
        continue;
      }
      if (record.delivery === "managed" && record.deliveryCollectedAt) {
        announced.add(key);
        dirty = true;
        continue;
      }
      safeWriteLine(formatOutcomeLine(record, cwd, duplicateIds.has(record.id)));
      announced.add(key);
      dirty = true;
    }
    if (snapshot.complete && pruneAnnounced(announced, liveKeys, snapshot.unreadableIds)) {
      dirty = true;
    }
    if (startupPending && !loaded.exists) {
      dirty = true;
    }
    if (dirty) {
      saveAnnounced(stateFile, announced);
      resetPending = false;
    }
    if (snapshot.complete) {
      startupPending = false;
    }
  };

  try {
    const initialSnapshot = readSnapshot();
    processSnapshot(initialSnapshot);
    if (!initialSnapshot.available && initialSnapshot.complete) {
      startupPending = false;
    }
  } catch {}

  const timer = setInterval(() => {
    try {
      processSnapshot(readSnapshot());
    } catch {}
  }, resolvePollIntervalMs());

  installExitHandlers(timer);
}

main();
