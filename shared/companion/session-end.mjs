import fs from "node:fs";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export async function runSessionEnd({ state, sweep, cancelJobRecord, cleanupRawCommandTransportsForSession }) {
  try {
    const input = readHookInput();
    const sessionId = input.session_id ?? process.env[state.SESSION_ID_ENV] ?? null;
    const dataDir = state.resolveDataDir();
    sweep(dataDir);
    if (!sessionId) return;
    cleanupRawCommandTransportsForSession(sessionId);
    for (const found of state.listAllJobRecords(dataDir)) {
      if (found.record.status !== "running" || found.record.claudeSessionId !== sessionId) continue;
      try { await cancelJobRecord(found); } catch {}
    }
  } catch {}
}
