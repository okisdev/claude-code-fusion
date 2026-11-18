import fs from "node:fs";
import path from "node:path";
import { withRecordLock } from "./record-lock.mjs";

const ORPHAN_AGE_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export function createRunSweep({ markerName, jobState, maintainRecord, removeRun, beforeSweep, runsDirectory }) {
  return function sweepRuns(dataDir, now = Date.now()) {
    const marker = path.join(dataDir, markerName);
    return withRecordLock(marker, () => {
      const records = jobState.listAllJobRecords(dataDir).map(({ record }) => record);
      beforeSweep?.(dataDir, records, now);
      const last = jobState.readJobRecordFile(marker)?.sweptAt;
      if (Number.isFinite(last) && now - last < SWEEP_INTERVAL_MS) return false;
      try { jobState.pruneJobRecords(dataDir, now); } catch {}
      const recorded = new Set(records.map((record) => record.id));
      for (const record of records) maintainRecord(dataDir, record, now);
      const runs = path.join(dataDir, "runs");
      if (runsDirectory(runs)) {
        for (const entry of fs.readdirSync(runs, { withFileTypes: true })) {
          if (!entry.isDirectory() || recorded.has(entry.name)) continue;
          const directory = path.join(runs, entry.name);
          if (now - fs.statSync(directory).mtimeMs >= ORPHAN_AGE_MS) removeRun(dataDir, entry.name);
        }
      }
      jobState.writePrivateStateFile(marker, `${JSON.stringify({ id: path.basename(markerName, ".json").slice(1), sweptAt: now })}\n`);
      return true;
    });
  };
}
