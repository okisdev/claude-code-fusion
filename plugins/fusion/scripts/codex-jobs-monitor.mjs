#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { FILE_ENGINE_DESCRIPTORS } from "./fusion-stats.mjs";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_POLL_INTERVAL_MS = 15000;
const INTERVAL_ENV = "CODEX_JOBS_MONITOR_INTERVAL_MS";
const SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";
const ERROR_MESSAGE_MAX_LENGTH = 80;

function resolvePollIntervalMs(env = process.env) {
  const raw = env[INTERVAL_ENV];
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_MS;
}

function resolveStateRoot(env = process.env) {
  const descriptor = FILE_ENGINE_DESCRIPTORS.codex;
  const override = env[descriptor.stateEnvVar];
  return override || descriptor.defaultStateRoot(env);
}

function resolveWorkspaceRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (result.status === 0) {
    const root = result.stdout.trim();
    if (root) {
      return root;
    }
  }
  return cwd;
}

function listWorkspaceJobs(root, workspaceRoot) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const descriptor = FILE_ENGINE_DESCRIPTORS.codex;
  return descriptor.enumerateJobs(root).filter((job) => descriptor.matchesWorkspace(job, workspaceRoot));
}

function truncateErrorMessage(message) {
  const firstLine = String(message).split("\n")[0].trim();
  if (firstLine.length <= ERROR_MESSAGE_MAX_LENGTH) {
    return firstLine;
  }
  return `${firstLine.slice(0, ERROR_MESSAGE_MAX_LENGTH)}...`;
}

function formatOutcomeLine(record) {
  const isFailureLike = record.status === "failed" || record.status === "cancelled";
  const failureSuffix = isFailureLike && record.errorMessage ? ` (${truncateErrorMessage(record.errorMessage)})` : "";
  return `codex job ${record.id} ${record.status}${failureSuffix}. collect with /codex:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function main() {
  const root = resolveStateRoot();
  const cwd = process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const seen = new Set();
  const deadReported = new Set();
  const ownSessionId = process.env[SESSION_ID_ENV] || null;

  for (const record of listWorkspaceJobs(root, workspaceRoot)) {
    if (record?.id && TERMINAL_STATUSES.has(record.status)) {
      seen.add(record.id);
    }
  }

  const timer = setInterval(() => {
    try {
      for (const record of listWorkspaceJobs(root, workspaceRoot)) {
        if (!record?.id) {
          continue;
        }
        if (TERMINAL_STATUSES.has(record.status)) {
          if (seen.has(record.id)) {
            continue;
          }
          seen.add(record.id);
          if (ownSessionId && record.sessionId !== ownSessionId) {
            continue;
          }
          console.log(formatOutcomeLine(record));
          continue;
        }
        if (record.status === "running" && !deadReported.has(record.id) && !isPidAlive(record.pid)) {
          deadReported.add(record.id);
          if (ownSessionId && record.sessionId !== ownSessionId) {
            continue;
          }
          console.log(`codex job ${record.id} appears dead (process gone, status still running)`);
        }
      }
    } catch {}
  }, resolvePollIntervalMs());

  const shutdown = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);
}

main();
