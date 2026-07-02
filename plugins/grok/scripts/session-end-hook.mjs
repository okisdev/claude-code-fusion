#!/usr/bin/env node

import fs from "node:fs";

import { terminateProcessGroup } from "./lib/grok-exec.mjs";
import { SESSION_ID_ENV, listAllJobRecords, resolveDataDir, writeJobRecordFile } from "./lib/state.mjs";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function main() {
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
      if (record.grokPid) {
        terminateProcessGroup(record.grokPid);
      }
      if (record.background || !record.grokPid) {
        terminateProcessGroup(record.pid);
      }
      writeJobRecordFile(file, {
        ...record,
        status: "cancelled",
        pid: null,
        grokPid: null,
        finishedAt: new Date().toISOString()
      });
    } catch {
      continue;
    }
  }
}

try {
  main();
} catch {
  process.exitCode = 0;
}
process.exit(0);
