import fs from "node:fs";
import path from "node:path";
import { createJobState } from "./job-state.mjs";
import { createRunSweep } from "./run-maintenance.mjs";

const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);

export const AGY_SESSION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

const jobState = createJobState({
  engine: "agy",
  engineName: "Antigravity",
  pidField: "agyPid",
  dataDirEnv: "AGY_COMPANION_DATA",
  lockTimeoutEnv: "AGY_COMPANION_LOCK_TIMEOUT_MS",
  dataDirName: "agy-claude-code-fusion",
  sweepMarker: ".agy-run-sweep.json",
  recordFields: (fields) => ({
    billingPool: "subscription",
    resolvedEffort: fields.resolvedEffort ?? null,
    stopReason: fields.stopReason ?? null,
    agentVersion: fields.agentVersion ?? null,
    permissionsAllowed: fields.permissionsAllowed ?? 0,
    permissionsRejected: fields.permissionsRejected ?? 0,
    toolCalls: fields.toolCalls ?? 0,
    configDir: fields.configDir ?? null
  }),
  requiredRecordFields: ["configDir", "stopReason", "permissionsAllowed", "permissionsRejected"],
  cancelledRecordFields: (existing, success, terminalAttribution) => ({
    resolvedEffort: terminalAttribution.resolvedEffort ?? success.resolvedEffort ?? existing.resolvedEffort ?? null,
    stopReason: success.stopReason ?? existing.stopReason ?? null,
    permissionsAllowed: success.permissionsAllowed ?? existing.permissionsAllowed ?? 0,
    permissionsRejected: success.permissionsRejected ?? existing.permissionsRejected ?? 0
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

export const sweepAgyRuns = createRunSweep({
  markerName: ".agy-run-sweep.json",
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
