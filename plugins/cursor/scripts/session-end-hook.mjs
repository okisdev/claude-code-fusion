#!/usr/bin/env node

import fs from "node:fs";

import { cancelJobRecord, cleanupRawCommandTransportsForSession } from "./cursor-companion.mjs";
import { SESSION_ID_ENV, listAllJobRecords, resolveDataDir, sweepCursorHomes } from "./lib/state.mjs";

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
  const dataDir = resolveDataDir();
  sweepCursorHomes(dataDir);
  if (!sessionId) return;
  cleanupRawCommandTransportsForSession(sessionId);
  for (const found of listAllJobRecords(dataDir)) {
    if (found.record.status !== "running" || found.record.claudeSessionId !== sessionId) continue;
    try { await cancelJobRecord(found); } catch {}
  }
}

try { await main(); } catch {}
process.exit(0);
