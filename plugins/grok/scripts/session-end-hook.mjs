#!/usr/bin/env node

import fs from "node:fs";

import { cleanupRawCommandTransportsForSession } from "./grok-companion.mjs";
import { recordedProcessGroupsClean, terminalRecordAttribution, terminateRecordedProcessGroups } from "./lib/grok-exec.mjs";
import { SESSION_ID_ENV, listAllJobRecords, nowIso, resolveDataDir, updateJobRecordFileWithCurrent } from "./lib/state.mjs";

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

  cleanupRawCommandTransportsForSession(sessionId);
  const dataDir = resolveDataDir();
  for (const { record, file } of listAllJobRecords(dataDir)) {
    if (record.status !== "running" || record.claudeSessionId !== sessionId) {
      continue;
    }
    try {
      const requested = updateJobRecordFileWithCurrent(file, (current) => {
        if (current.status !== "running" || current.claudeSessionId !== sessionId) {
          return current;
        }
        return { ...current, cancelRequestedAt: nowIso() };
      });
      if (requested.status !== "running") {
        continue;
      }
      const terminated = await terminateRecordedProcessGroups(requested);
      updateJobRecordFileWithCurrent(file, (current) => {
        if (current.status !== "running") {
          return current;
        }
        if (!terminated || !recordedProcessGroupsClean(current)) {
          const message = "Session cleanup was requested, but verified process cleanup did not complete. The process identifiers were retained for retry.";
          return {
            ...current,
            ...terminalRecordAttribution(current),
            cleanupRequired: true,
            errorMessage: message,
            errorTail: message,
            failureKind: "cancelled"
          };
        }
        return {
          ...current,
          ...terminalRecordAttribution(current),
          status: "cancelled",
          finishedAt: nowIso(),
          failureKind: "cancelled",
          cancelRequestedAt: null
        };
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
