import fs from "node:fs";
import path from "node:path";

import { engineStateRoots } from "./engines.mjs";
import { JOB_ID_PATTERN as ENGINE_JOB_ID_PATTERN } from "./job-id.mjs";

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
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
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
        throw new TypeError(`Invalid ${engine} job record for ${jobId}.`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return null;
}

export function readEngineJobFailureKind(engine, jobId, env = process.env) {
  let failureKind;
  try {
    failureKind = readEngineJobRecord(engine, jobId, env)?.failureKind;
  } catch {
    return null;
  }
  return typeof failureKind === "string" && failureKind.trim() ? failureKind.trim() : null;
}
