import path from "node:path";
import { createJobState } from "./job-state.mjs";

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
    toolCalls: fields.toolCalls ?? 0
  }),
  requiredRecordFields: ["stopReason", "permissionsAllowed", "permissionsRejected"],
  migrate(record) {
    if (record?.engine !== "agy" || !Object.hasOwn(record, "configDir")) return record;
    const { configDir, ...job } = record;
    return job;
  },
  cancelledRecordFields: (existing, success, terminalAttribution) => ({
    resolvedEffort: terminalAttribution.resolvedEffort ?? success.resolvedEffort ?? existing.resolvedEffort ?? null,
    stopReason: success.stopReason ?? existing.stopReason ?? null,
    permissionsAllowed: success.permissionsAllowed ?? existing.permissionsAllowed ?? 0,
    permissionsRejected: success.permissionsRejected ?? existing.permissionsRejected ?? 0
  })
});

export function runConfigDir(dataDir, jobId) {
  return path.join(dataDir, "runs", jobId, "config");
}

export const sweepAgyRuns = jobState.pruneJobRecords;

export default jobState;
