import fs from "node:fs";
import path from "node:path";

import { engineDataDir, engineStateRoots } from "./engines.mjs";

const ENGINE_JOB_ID_PATTERN = /^[0-9a-f]{32}$/;

export function resolveGrokDataDir(env = process.env) {
  return engineDataDir("grok", env);
}

export function resolveEngineStateRoots(engine, env = process.env) {
  return engineStateRoots(engine, env);
}

export function readEngineJobRecord(engine, jobId, env = process.env) {
  if (!ENGINE_JOB_ID_PATTERN.test(jobId ?? "")) {
    return null;
  }
  for (const stateRoot of resolveEngineStateRoots(engine, env)) {
    let workspaces;
    try {
      workspaces = fs.readdirSync(stateRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) {
        continue;
      }
      try {
        const record = JSON.parse(fs.readFileSync(path.join(stateRoot, workspace.name, "jobs", `${jobId}.json`), "utf8"));
        if (record && typeof record === "object" && !Array.isArray(record)) {
          return record;
        }
      } catch {
        void 0;
      }
    }
  }
  return null;
}

export function readEngineJobFailureKind(engine, jobId, env = process.env) {
  const failureKind = readEngineJobRecord(engine, jobId, env)?.failureKind;
  return typeof failureKind === "string" && failureKind.trim() ? failureKind.trim() : null;
}
