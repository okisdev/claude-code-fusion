import fs from "node:fs";
import path from "node:path";
import { createJobState } from "./job-state.mjs";
import { withRecordLock } from "./record-lock.mjs";

const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);
const ORPHAN_AGE_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export const DEVIN_SESSION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+){1,5}$/;

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
  engine: "devin",
  engineName: "Devin",
  pidField: "devinPid",
  dataDirEnv: "DEVIN_COMPANION_DATA",
  lockTimeoutEnv: "DEVIN_COMPANION_LOCK_TIMEOUT_MS",
  dataDirName: "devin-claude-code-fusion",
  sweepMarker: ".devin-run-sweep.json",
  recordFields: (fields) => ({
    resolvedEffort: fields.resolvedEffort ?? null,
    stopCause: fields.stopCause ?? null,
    configDir: fields.configDir ?? null
  }),
  requiredRecordFields: ["configDir", "stopCause"],
  cancelledRecordFields: (existing, success, terminalAttribution) => ({
    resolvedEffort: terminalAttribution.resolvedEffort ?? success.resolvedEffort ?? existing.resolvedEffort ?? null,
    stopCause: success.stopCause ?? existing.stopCause ?? null
  }),
  maintainTerminalRecord: maintainTerminalConfig
});

export function runConfigDir(dataDir, jobId) {
  return path.join(dataDir, "runs", jobId, "config");
}

function removeRunDirectory(dataDir, jobId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(jobId)) return;
  const runs = path.join(dataDir, "runs");
  const runsStats = fs.lstatSync(runs, { throwIfNoEntry: false });
  if (!runsStats?.isDirectory() || runsStats.isSymbolicLink()) return;
  const directory = path.join(dataDir, "runs", jobId);
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stats?.isDirectory() && !stats.isSymbolicLink()) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function maintainTerminalConfig(file, record) {
  if (!TERMINAL_STATUSES.has(record.status)) return;
  const dataDir = path.resolve(path.dirname(file), "../../..");
  if (record.configDir !== runConfigDir(dataDir, record.id)) return;
  removeRunDirectory(dataDir, record.id);
}

export function sweepDevinRuns(dataDir, now = Date.now()) {
  const marker = path.join(dataDir, ".devin-run-sweep.json");
  return withRecordLock(marker, () => {
    const records = listAllJobRecords(dataDir).map(({ record }) => record);
    const last = readJobRecordFile(marker)?.sweptAt;
    if (Number.isFinite(last) && now - last < SWEEP_INTERVAL_MS) return false;
    const recorded = new Set(records.map((record) => record.id));
    for (const record of records) {
      if (!TERMINAL_STATUSES.has(record.status) || record.configDir !== runConfigDir(dataDir, record.id)) continue;
      removeRunDirectory(dataDir, record.id);
    }
    const runs = path.join(dataDir, "runs");
    const runsStats = fs.lstatSync(runs, { throwIfNoEntry: false });
    if (runsStats?.isDirectory() && !runsStats.isSymbolicLink()) {
      for (const entry of fs.readdirSync(runs, { withFileTypes: true })) {
        if (!entry.isDirectory() || recorded.has(entry.name)) continue;
        const directory = path.join(runs, entry.name);
        if (now - fs.statSync(directory).mtimeMs >= ORPHAN_AGE_MS) removeRunDirectory(dataDir, entry.name);
      }
    }
    writePrivateStateFile(marker, `${JSON.stringify({ id: "devin-run-sweep", sweptAt: now })}\n`);
    return true;
  });
}
