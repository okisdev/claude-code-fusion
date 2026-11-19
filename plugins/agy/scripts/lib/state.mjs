import * as shared from "./companion-state.mjs";

export * from "./companion-state.mjs";
export { AGY_SESSION_ID_PATTERN, runConfigDir, sweepAgyRuns } from "./engine-state.mjs";

export function writeBrief(dataDir, cwd, id, brief) {
  const file = shared.writeBrief(dataDir, cwd, id, brief);
  const roles = new Set(["independence", "large-context", "burst"]);
  const lines = brief.split(/\r?\n/).filter((line) => line.trim()).slice(0, 12);
  let role = lines[0]?.trim().match(/^lane:\s*agy\s+([a-z][a-z-]*)/i)?.[1]?.toLowerCase();
  if (!roles.has(role)) {
    role = lines.map((line) => line.match(/(?:^|[\s;,|])agy-role:\s*([^\s;,|]+)/i)?.[1]?.toLowerCase()).find(Boolean);
  }
  shared.updateJobRecordFile(shared.jobFilePath(dataDir, cwd, id), { role: roles.has(role) ? role : null });
  return file;
}
