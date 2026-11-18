import fs from "node:fs";
import path from "node:path";
import { createJobState } from "./job-state.mjs";
import { createRunSweep } from "./run-maintenance.mjs";

const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);

export const DEVIN_SESSION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+){1,5}$/;

const jobState = createJobState({
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

export const sweepDevinRuns = createRunSweep({
  markerName: ".devin-run-sweep.json",
  jobState,
  maintainRecord(dataDir, record) {
    if (TERMINAL_STATUSES.has(record.status) && record.configDir === runConfigDir(dataDir, record.id)) removeRunDirectory(dataDir, record.id);
  },
  removeRun: removeRunDirectory,
  runsDirectory(runs) {
    const stats = fs.lstatSync(runs, { throwIfNoEntry: false });
    return stats?.isDirectory() && !stats.isSymbolicLink();
  }
});

export default jobState;
