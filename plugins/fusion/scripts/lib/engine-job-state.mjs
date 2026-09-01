import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveCodexStateRoots } from "./codex-state-roots.mjs";

const GROK_DATA_ENV = "GROK_COMPANION_DATA";
const ENGINE_JOB_ID_PATTERN = /^[0-9a-f]{32}$/;

function configuredPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return path.resolve(value.trim());
}

function homeDir(env) {
  return configuredPath(env.HOME) ?? os.homedir();
}

export function resolveGrokDataDir(env = process.env) {
  return configuredPath(env[GROK_DATA_ENV]) ?? path.join(homeDir(env), ".claude", "plugins", "data", "grok-claude-code-fusion");
}

export function resolveEngineStateRoots(engine, env = process.env) {
  if (engine === "codex") {
    return resolveCodexStateRoots(env);
  }
  if (engine === "grok") {
    return [path.join(resolveGrokDataDir(env), "state")];
  }
  return [];
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
