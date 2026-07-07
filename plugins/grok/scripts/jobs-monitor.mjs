#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { SESSION_ID_ENV, jobsDir, readJobRecordFile, resolveDataDir } from "./lib/state.mjs";

const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);
const DEFAULT_POLL_INTERVAL_MS = 15000;
const INTERVAL_ENV = "GROK_JOBS_MONITOR_INTERVAL_MS";

function resolvePollIntervalMs(env = process.env) {
  const raw = env[INTERVAL_ENV];
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_MS;
}

function listJobFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => path.join(dir, entry));
}

function formatOutcomeLine(record) {
  const failureSuffix = record.failureKind ? ` (${record.failureKind})` : "";
  return `grok job ${record.id} ${record.status}${failureSuffix}. collect with /grok:result ${record.id} only if you launched it detached; a job owned by a subagent reports on its own`;
}

function main() {
  const dataDir = resolveDataDir();
  const dir = jobsDir(dataDir, process.cwd());
  const seen = new Set();
  const ownSessionId = process.env[SESSION_ID_ENV] || null;

  for (const file of listJobFiles(dir)) {
    const record = readJobRecordFile(file);
    if (record?.id && TERMINAL_STATUSES.has(record.status)) {
      seen.add(record.id);
    }
  }

  const timer = setInterval(() => {
    try {
      for (const file of listJobFiles(dir)) {
        const record = readJobRecordFile(file);
        if (!record?.id || !TERMINAL_STATUSES.has(record.status) || seen.has(record.id)) {
          continue;
        }
        seen.add(record.id);
        if (ownSessionId && record.claudeSessionId !== ownSessionId) {
          continue;
        }
        console.log(formatOutcomeLine(record));
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
