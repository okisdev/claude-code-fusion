import fs from "node:fs";
import path from "node:path";
import { createJobState } from "./job-state.mjs";
import { withRecordLock } from "./record-lock.mjs";
import { prunePrivateHome, removePrivateHome } from "./cursor-home.mjs";

const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);
const ORPHAN_AGE_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const PRIVATE_DIR_MODE = 0o700;
const HOME_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const NPM_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const NPM_CACHE_CLEAR_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const {
  SESSION_ID_ENV,
  DEFAULT_LOCK_TIMEOUT_MS,
  resolveLockTimeoutMs,
  resolveDataDir,
  workspaceSlug,
  workspaceStateDir,
  jobsDir,
  briefsDir,
  jobFilePath,
  jobLogPath,
  briefPath,
  resumeSessionLeasePath,
  generateJobId,
  nowIso,
  createJobRecord,
  ensurePrivateDataDir,
  writePrivateStateFile,
  hardenPrivateStateFile,
  createJobRecordFile,
  writeJobRecordFile,
  markManagedDeliveryCollectedFile,
  markDeliveryCollectedFile,
  readJobRecordFile,
  claimResumeSessionLease,
  updateJobRecordFile,
  launchRunningJobProcess,
  updateJobRecordFileWithCurrent,
  finishSuccessfulJobRecordFile,
  listJobRecords,
  listAllJobRecords,
  findJobRecordById,
  writeBrief,
  writePrivateDataFile,
  appendJobLog,
  readLogTail
} = createJobState({
  engine: "cursor",
  engineName: "Cursor",
  pidField: "cursorPid",
  dataDirEnv: "CURSOR_COMPANION_DATA",
  lockTimeoutEnv: "CURSOR_COMPANION_LOCK_TIMEOUT_MS",
  dataDirName: "cursor-claude-code-fusion",
  sweepMarker: ".cursor-home-sweep.json",
  recordFields: (fields) => ({ homeDir: fields.homeDir ?? null }),
  requiredRecordFields: ["homeDir"],
  maintainTerminalRecord: maintainTerminalHome
});

export function runHomeDir(dataDir, jobId) {
  return path.join(dataDir, "runs", jobId, "home");
}

export function homeRetentionExpired(record, now = Date.now()) {
  const finished = Date.parse(record.finishedAt ?? "");
  return TERMINAL_STATUSES.has(record.status) && Number.isFinite(finished) && now - finished >= HOME_RETENTION_MS;
}

function maintainTerminalHome(file, record) {
  if (!TERMINAL_STATUSES.has(record.status)) return;
  const dataDir = path.resolve(path.dirname(file), "../../..");
  if (record.homeDir !== runHomeDir(dataDir, record.id)) return;
  if (homeRetentionExpired(record)) removePrivateHome(record.homeDir);
  else prunePrivateHome(record.homeDir, record.cwd, record.sessionId);
}

function directoryBytes(directory, limit) {
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const stats = fs.lstatSync(child);
    bytes += stats.isDirectory() && !stats.isSymbolicLink() ? directoryBytes(child, limit - bytes) : stats.size;
    if (bytes > limit) break;
  }
  return bytes;
}

function maintainNpmCache(dataDir, records, now) {
  const cache = path.join(dataDir, "npm-cache");
  const stats = fs.lstatSync(cache, { throwIfNoEntry: false });
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) return;
  const marker = path.join(dataDir, ".cursor-npm-cache-clear.json");
  const last = readJobRecordFile(marker)?.clearedAt;
  if (Number.isFinite(last) && now - last < NPM_CACHE_CLEAR_INTERVAL_MS) return;
  if (records.some((record) => record.status === "running")) return;
  if (directoryBytes(cache, NPM_CACHE_MAX_BYTES) <= NPM_CACHE_MAX_BYTES) return;
  removePrivateHome(cache);
  fs.mkdirSync(cache, { mode: PRIVATE_DIR_MODE });
  writePrivateStateFile(marker, `${JSON.stringify({ clearedAt: now })}\n`);
}

export function sweepCursorHomes(dataDir, now = Date.now()) {
  const marker = path.join(dataDir, ".cursor-home-sweep.json");
  return withRecordLock(marker, () => {
    const records = listAllJobRecords(dataDir).map(({ record }) => record);
    maintainNpmCache(dataDir, records, now);
    const last = readJobRecordFile(marker)?.sweptAt;
    if (Number.isFinite(last) && now - last < SWEEP_INTERVAL_MS) return false;
    const recorded = new Set(records.map((record) => record.id));
    for (const record of records) {
      if (!TERMINAL_STATUSES.has(record.status) || record.homeDir !== runHomeDir(dataDir, record.id)) continue;
      if (homeRetentionExpired(record, now)) removePrivateHome(record.homeDir);
      else prunePrivateHome(record.homeDir, record.cwd, record.sessionId);
    }
    const runs = path.join(dataDir, "runs");
    if (fs.lstatSync(runs, { throwIfNoEntry: false })?.isDirectory()) {
      for (const entry of fs.readdirSync(runs, { withFileTypes: true })) {
        if (!entry.isDirectory() || recorded.has(entry.name)) continue;
        const directory = path.join(runs, entry.name);
        if (now - fs.statSync(directory).mtimeMs >= ORPHAN_AGE_MS) removePrivateHome(directory);
      }
    }
    writePrivateStateFile(marker, `${JSON.stringify({ id: "cursor-home-sweep", sweptAt: now })}\n`);
    return true;
  });
}
