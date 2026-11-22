import { createJobState } from "./job-state.mjs";

export const OPENCODE_SESSION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

const state = createJobState({
  engine: "opencode",
  engineName: "OpenCode",
  pidField: "opencodePid",
  dataDirEnv: "OPENCODE_COMPANION_DATA",
  lockTimeoutEnv: "OPENCODE_COMPANION_LOCK_TIMEOUT_MS",
  dataDirName: "opencode-claude-code-fusion",
  sweepMarker: ".opencode-run-sweep.json",
  recordFields: (fields) => ({
    codexVersion: fields.codexVersion ?? null,
    codexBuildPath: fields.codexBuildPath ?? null,
    resolvedEffort: fields.resolvedEffort ?? null
  }),
  requiredRecordFields: ["codexVersion", "codexBuildPath", "resolvedEffort"],
  cancelledRecordFields: (existing, outcome) => ({ resolvedEffort: outcome.resolvedEffort ?? existing.resolvedEffort })
});

export const sweepOpencodeRuns = (dataDir) => state.pruneJobRecords(dataDir);
export default state;
