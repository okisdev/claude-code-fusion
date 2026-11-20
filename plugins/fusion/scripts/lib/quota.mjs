import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { newestEngineCompanion } from "./engine-acceptance.mjs";
import { ENGINES, isEngineId, routedEngineIds } from "./engines.mjs";
import { readRoutingDefaults } from "./model-table.mjs";
import { writeFileAtomic } from "./storage.mjs";
import { resolveFusionDataDir } from "./worker-state.mjs";

function validResult(value, engine = value?.engine) {
  const nullableNumber = (number) => number === null || (Number.isFinite(number) && number >= 0);
  const isoDate = (date) => typeof date === "string" && Number.isFinite(Date.parse(date));
  return isEngineId(engine) && value?.engine === engine && typeof value.available === "boolean" && isoDate(value.observedAt) &&
    (value.note === null || typeof value.note === "string") && Array.isArray(value.pools) && value.pools.every((pool) =>
      pool && typeof pool.pool === "string" && pool.pool.trim() && !/[\r\n]/.test(pool.pool) &&
      ["free", "included", "metered"].includes(pool.costClass) && nullableNumber(pool.usedPercent) &&
      nullableNumber(pool.windowMinutes) && nullableNumber(pool.pacing) && (pool.resetsAt === null || isoDate(pool.resetsAt))
    );
}

export function quotaResults(env = process.env, { engines, timeoutMs = 1000 } = {}) {
  const routed = routedEngineIds(readRoutingDefaults(env, { warn: null }).breadth);
  const selected = engines === undefined ? routed : routed.filter((engine) => engines.includes(engine));
  if (!selected.length) return [];
  const file = path.join(resolveFusionDataDir(env), `quota-${[...selected].sort().join("-")}.json`);
  const sources = selected.map((engine) => {
    try {
      const override = env[ENGINES[engine].companionEnv]?.trim();
      if (override && (!path.isAbsolute(override) || !fs.statSync(override).isFile())) return null;
      const companion = newestEngineCompanion(engine, env);
      if (!companion) return null;
      const stat = fs.statSync(companion, { bigint: true });
      return { engine, companion, mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), size: String(stat.size) };
    } catch {
      return null;
    }
  });
  const source = JSON.stringify(sources);
  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    const age = Date.now() - cached.fetchedAt;
    if (cached.source === source && age >= 0 && age < 60_000 && Array.isArray(cached.results) &&
        cached.results.every((result) => selected.includes(result?.engine) && validResult(result))) return cached.results;
  } catch {}
  const results = [];
  for (const [index, engine] of selected.entries()) {
    try {
      const companion = sources[index]?.companion;
      if (!companion) continue;
      const result = spawnSync(process.execPath, [companion, "quota", "--json"], { encoding: "utf8", env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
      if (result.error || result.status !== 0) continue;
      const value = JSON.parse(result.stdout);
      if (validResult(value, engine)) results.push(value);
    } catch {}
  }
  try {
    writeFileAtomic(file, `${JSON.stringify({ source, fetchedAt: Date.now(), results })}\n`);
  } catch {}
  return results;
}

function windowLabel(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440} day`;
  if (minutes % 60 === 0) return `${minutes / 60} hour`;
  return `${minutes} minute`;
}

export function pacingLines(results) {
  const lines = [];
  for (const result of results) {
    if (!validResult(result) || !result.available) continue;
    for (const pool of result.pools) {
      if (pool.resetsAt !== null && Date.parse(pool.resetsAt) <= Date.now()) continue;
      if (!(pool.pacing > 1.15 || pool.usedPercent >= 85)) continue;
      const elapsed = pool.usedPercent !== null && pool.pacing > 0 ? pool.usedPercent / pool.pacing : null;
      const usage = pool.usedPercent === null ? "usage percentage unknown" : `${Number(pool.usedPercent.toFixed(1))}% used`;
      const window = pool.windowMinutes > 0 ? `its ${windowLabel(pool.windowMinutes)} window` : "its window";
      const elapsedText = elapsed === null || elapsed > 100 ? "" : ` with ${Math.round(elapsed)}% of ${window} elapsed`;
      const pacing = pool.pacing === null ? "" : ` (pacing ${pool.pacing.toFixed(1)})`;
      const reset = pool.resetsAt === null ? "" : `, resets ${new Date(pool.resetsAt).toISOString().slice(0, 10)}`;
      lines.push(`${ENGINES[result.engine].displayName} pool ${pool.pool} is ${pool.pacing > 1.15 ? "over pace" : "near capacity"}: ${usage}${elapsedText}${pacing}${reset}. Prefer free or included pools for quick and volume shapes until it is back on pace.`);
    }
  }
  return lines;
}
