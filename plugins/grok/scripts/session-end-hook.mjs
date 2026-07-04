#!/usr/bin/env node

import fs from "node:fs";

import { terminateProcessGroup } from "./lib/grok-exec.mjs";
import { SESSION_ID_ENV, listAllJobRecords, nowIso, resolveDataDir, updateJobRecordFile } from "./lib/state.mjs";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function main() {
  const input = readHookInput();
  const sessionId = input.session_id ?? process.env[SESSION_ID_ENV] ?? null;
  if (!sessionId) {
    return;
  }

  const dataDir = resolveDataDir();
  for (const { record, file } of listAllJobRecords(dataDir)) {
    if (record.status !== "running" || record.claudeSessionId !== sessionId) {
      continue;
    }
    try {
      const pids = new Set();
      if (record.grokPid) {
        pids.add(record.grokPid);
      }
      if (record.background || !record.grokPid) {
        pids.add(record.pid);
      }
      await Promise.all([...pids].map((pid) => terminateProcessGroup(pid)));
      updateJobRecordFile(file, {
        status: "cancelled",
        pid: null,
        grokPid: null,
        finishedAt: nowIso(),
        failureKind: "cancelled",
        cancelRequestedAt: null
      });
    } catch {
      continue;
    }
  }
}

try {
  await main();
} catch {
  process.exitCode = 0;
}
process.exit(0);
