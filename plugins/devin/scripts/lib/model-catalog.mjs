import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function createModelCatalog({ key, args, parse, fail, includeFetchedAt = false, directoryMode }) {
  return function readModelCatalog({ dataDir, bin, env = process.env, maxAgeMs = 3600000, now = Date.now(), run = spawnSync }) {
    const cachePath = path.join(dataDir, "models-cache.json");
    const resultCatalog = (catalog, source) => ({ [key]: catalog[key], ...(includeFetchedAt ? { fetchedAt: catalog.fetchedAt } : {}), source });
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (Array.isArray(cached[key]) && Number.isFinite(cached.fetchedAt) && now >= cached.fetchedAt && now - cached.fetchedAt < maxAgeMs) {
        return resultCatalog(cached, "cache");
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const result = run(bin, args, { env, encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    if (result.error || result.status !== 0) fail(result);
    const catalog = { [key]: parse(result), fetchedAt: now };
    fs.mkdirSync(dataDir, { recursive: true, ...(directoryMode === undefined ? {} : { mode: directoryMode }) });
    fs.writeFileSync(cachePath, `${JSON.stringify(catalog)}\n`, { mode: 0o600 });
    fs.chmodSync(cachePath, 0o600);
    return resultCatalog(catalog, "cli");
  };
}
