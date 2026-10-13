import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ENGINES, isEngineId } from "./engines.mjs";

export class EnginePluginUpgradeRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnginePluginUpgradeRequiredError";
    this.code = "ENGINE_PLUGIN_UPGRADE_REQUIRED";
  }
}

function configuredHome(env = process.env) {
  const candidate = typeof env.HOME === "string" ? env.HOME.trim() : "";
  return candidate && path.isAbsolute(candidate) ? candidate : os.homedir();
}

function regularFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function requireEngine(engine) {
  if (!isEngineId(engine)) {
    throw new TypeError(`Unknown engine id: ${engine}`);
  }
  return ENGINES[engine];
}

export function newestEngineCompanion(engine, env = process.env) {
  const { companionEnv, companionFile, id } = requireEngine(engine);
  const override = typeof env[companionEnv] === "string" ? env[companionEnv].trim() : "";
  if (override && path.isAbsolute(override) && regularFile(override)) {
    return override;
  }
  const base = path.join(configuredHome(env), ".claude", "plugins", "cache", "claude-code-fusion", id);
  try {
    const candidates = fs
      .readdirSync(base)
      .map((version) => path.join(base, version, "scripts", companionFile))
      .filter((candidate) => fs.existsSync(candidate))
      .map((candidate) => ({ candidate, mtime: fs.statSync(candidate).mtimeMs }))
      .sort((left, right) => right.mtime - left.mtime || left.candidate.localeCompare(right.candidate));
    if (candidates.length > 0) {
      return candidates[0].candidate;
    }
  } catch {
    void 0;
  }
  const sibling = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", id, "scripts", companionFile);
  return fs.existsSync(sibling) ? sibling : null;
}

function companionFailureMessage(result) {
  return [result.stderr, result.stdout, result.error?.message].filter((value) => typeof value === "string" && value.trim()).join("\n").trim();
}

function acceptanceSubcommandUnavailable(result) {
  if (result.error) {
    return true;
  }
  const message = companionFailureMessage(result);
  return /\b(?:unknown|unsupported|unrecognized)\s+(?:subcommand|command)\b/i.test(message) || /\brecord-acceptance\b.*\b(?:unknown|unsupported|unavailable|not found|not supported)\b/i.test(message) || /\b(?:cannot find module|ERR_MODULE_NOT_FOUND)\b/i.test(message);
}

export function recordEngineAcceptance({ engine, jobId, acceptance, source, reason, failureKind, acceptFailedTransport = false, workspaceRoot, asJson = false, env = process.env, requireUpdate = true }) {
  const { displayName } = requireEngine(engine);
  const bin = newestEngineCompanion(engine, env);
  let updated = false;
  if (bin) {
    const argv = [bin, "record-acceptance", "--job-id", jobId, "--acceptance", acceptance, ...(source ? ["--source", source] : []), ...(reason ? ["--reason", reason] : []), ...(failureKind ? ["--failure-kind", failureKind] : []), ...(acceptFailedTransport ? ["--accept-failed-transport"] : []), ...(asJson ? ["--json"] : [])];
    const result = spawnSync(process.execPath, argv, { cwd: workspaceRoot, encoding: "utf8", env });
    if (!result.error && result.status === 0) {
      updated = true;
    } else if (!acceptanceSubcommandUnavailable(result)) {
      throw new Error(companionFailureMessage(result) || `${displayName} acceptance record update failed.`);
    }
  }
  if (!updated && requireUpdate) {
    throw new EnginePluginUpgradeRequiredError(`The ${displayName} job was found, but its companion is unavailable or does not support record-acceptance. Upgrade the ${displayName} plugin and retry.`);
  }
  return { updated };
}
