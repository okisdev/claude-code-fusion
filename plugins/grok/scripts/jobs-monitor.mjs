#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { SESSION_ID_ENV, jobsDir, readJobRecordFile, resolveDataDir, workspaceStateDir } from "./lib/state.mjs";

const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);
const DEFAULT_POLL_INTERVAL_MS = 15000;
const INTERVAL_ENV = "GROK_JOBS_MONITOR_INTERVAL_MS";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function resolvePollIntervalMs(env = process.env) {
  const raw = env[INTERVAL_ENV];
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_MS;
}

function readJobsSnapshot(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) {
      return { available: false, records: [] };
    }
    const records = [];
    for (const entry of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const record = readJobRecordFile(path.join(dir, entry));
      if (!record) {
        return { available: false, records: [] };
      }
      records.push(record);
    }
    return { available: true, records };
  } catch {
    return { available: false, records: [] };
  }
}

function formatOutcomeLine(record) {
  const failureSuffix = record.failureKind ? ` (${record.failureKind})` : "";
  return `grok job ${record.id} ${record.status}${failureSuffix}. collect with /grok:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`;
}

function announcementKey(id, status) {
  return `${id}:${status}`;
}

function announcedStatePath(stateDir, sessionId) {
  const name = sessionId ? `jobs-monitor-announced.${sessionId}.json` : "jobs-monitor-announced.json";
  return path.join(stateDir, name);
}

function loadAnnounced(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const keys = Array.isArray(raw) ? raw : Array.isArray(raw?.keys) ? raw.keys : null;
    if (!keys) {
      return { exists: true, announced: new Set() };
    }
    return { exists: true, announced: new Set(keys.filter((key) => typeof key === "string")) };
  } catch (error) {
    return { exists: error?.code !== "ENOENT", announced: new Set() };
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
  const dataDir = resolveDataDir();
  const cwd = process.cwd();
  const dir = jobsDir(dataDir, cwd);
  const stateDir = workspaceStateDir(dataDir, cwd);
  const ownSessionId = process.env[SESSION_ID_ENV] || null;
  const stateFile = announcedStatePath(stateDir, ownSessionId);
  const loaded = loadAnnounced(stateFile);
  const announced = loaded.announced;
  let startupPending = true;

  pruneOldStateFiles(stateDir, stateFile);

  const processSnapshot = (snapshot) => {
    if (!snapshot.available) {
      return;
    }
    const liveIds = new Set();
    let dirty = false;
    for (const record of snapshot.records) {
      if (!record?.id) {
        continue;
      }
      liveIds.add(record.id);
      if (!TERMINAL_STATUSES.has(record.status)) {
        continue;
      }
      const key = announcementKey(record.id, record.status);
      if (announced.has(key)) {
        continue;
      }
      announced.add(key);
      dirty = true;
      if (startupPending && !loaded.exists) {
        continue;
      }
      if (ownSessionId && record.claudeSessionId !== ownSessionId) {
        continue;
      }
      if (record.background !== true) {
        continue;
      }
      safeWriteLine(formatOutcomeLine(record));
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
    const initialSnapshot = readJobsSnapshot(dir);
    processSnapshot(initialSnapshot);
    if (!initialSnapshot.available) {
      startupPending = false;
    }
  } catch {}

  const timer = setInterval(() => {
    try {
      processSnapshot(readJobsSnapshot(dir));
    } catch {}
  }, resolvePollIntervalMs());

  installExitHandlers(timer);
}

main();
