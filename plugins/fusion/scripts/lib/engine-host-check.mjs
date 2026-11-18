import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newestEngineCompanion } from "./engine-acceptance.mjs";
import { ENGINES } from "./engines.mjs";
import { readJsonFile, withFileLock, writeFileAtomic } from "./storage.mjs";
import { resolveFusionDataDir } from "./worker-state.mjs";

function validBlockers(blockers) {
  return Array.isArray(blockers) && blockers.every((blocker) =>
    blocker &&
    typeof blocker.kind === "string" && blocker.kind.trim() && !/[\r\n]/.test(blocker.kind) &&
    Array.isArray(blocker.modes) && blocker.modes.length > 0 &&
    blocker.modes.every((mode) => ["consult", "write", "review"].includes(mode)) &&
    typeof blocker.message === "string" && blocker.message.trim() && !/[\r\n]/.test(blocker.message)
  );
}

export function engineHostBlockers(engine, env, now = Date.now()) {
  const descriptor = ENGINES[engine];
  if (!descriptor?.hostCheck) return [];
  try {
    const override = typeof env[descriptor.companionEnv] === "string" ? env[descriptor.companionEnv].trim() : "";
    if (override && (!path.isAbsolute(override) || !fs.statSync(override).isFile())) return [];
    const companion = newestEngineCompanion(engine, env);
    if (!companion) return [];
    const configuredHome = typeof env.HOME === "string" ? env.HOME.trim() : "";
    const home = path.isAbsolute(configuredHome) ? configuredHome : os.homedir();
    const cacheRoot = path.join(home, ".claude", "plugins", "cache", "claude-code-fusion", engine);
    if (!override && !companion.startsWith(`${cacheRoot}${path.sep}`)) return [];
    const modifiedAt = fs.statSync(companion).mtimeMs;
    const file = path.join(resolveFusionDataDir(env), `host-check-${engine}.json`);
    const check = () => {
      let cached;
      try {
        cached = readJsonFile(file);
      } catch {
        cached = null;
      }
      if (cached?.companion === companion && cached.modifiedAt === modifiedAt && Number.isFinite(cached.at) && now >= cached.at && now - cached.at < 60_000 && validBlockers(cached.blockers)) {
        return cached.blockers;
      }
      const result = spawnSync(process.execPath, [companion, "host-check", "--json"], { encoding: "utf8", env, timeout: 2000 });
      if (result.error || result.status !== 0) return [];
      let value;
      try {
        value = JSON.parse(result.stdout);
      } catch {
        return [];
      }
      if (!validBlockers(value?.blockers)) return [];
      try {
        writeFileAtomic(file, `${JSON.stringify({ companion, modifiedAt, at: now, blockers: value.blockers })}\n`);
      } catch {}
      return value.blockers;
    };
    try {
      return withFileLock(file, check);
    } catch {
      return check();
    }
  } catch {
    return [];
  }
}
