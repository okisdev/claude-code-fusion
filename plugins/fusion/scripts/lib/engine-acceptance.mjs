import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ENGINES, isEngineId } from "./engines.mjs";
import { readEngineJobRecord } from "./engine-job-state.mjs";
import { RESUMABLE_CODEX_FAILURE_KINDS } from "./stats/evidence.mjs";

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

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

function fusionVersion() {
  const pluginRoot = path.resolve(moduleDirectory, "..", "..");
  if (path.basename(pluginRoot) !== "fusion") {
    return path.basename(pluginRoot);
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).version;
  } catch {
    return null;
  }
}

function semanticVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  return match ? { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split(".") ?? [] } : null;
}

function compareVersions(left, right) {
  const a = semanticVersion(left);
  const b = semanticVersion(right);
  if (!a || !b) {
    return a ? 1 : b ? -1 : 0;
  }
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index] - b.core[index];
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Number(b.prerelease.length > 0) - Number(a.prerelease.length > 0);
  }
  for (let index = 0; index < Math.min(a.prerelease.length, b.prerelease.length); index += 1) {
    const first = a.prerelease[index];
    const second = b.prerelease[index];
    const firstNumeric = /^\d+$/.test(first);
    const secondNumeric = /^\d+$/.test(second);
    if (firstNumeric && secondNumeric) {
      const difference = Number(first) - Number(second);
      if (difference) {
        return difference;
      }
    } else if (firstNumeric !== secondNumeric) {
      return firstNumeric ? -1 : 1;
    } else if (first !== second) {
      return first < second ? -1 : 1;
    }
  }
  return a.prerelease.length - b.prerelease.length;
}

export function engineAcceptanceTransport({ engine, jobId, acceptance, acceptFailedTransport = false, env = process.env }) {
  const record = readEngineJobRecord(engine, jobId, env);
  const failedTransport = record?.status === "error" || record?.transportStatus === "error";
  const salvage = failedTransport && RESUMABLE_CODEX_FAILURE_KINDS.has(record.failureKind);
  return { failedTransport, salvage, acceptFailedTransport: acceptFailedTransport || (acceptance === "accepted" && salvage) };
}

export function newestEngineCompanion(engine, env = process.env) {
  const { companionEnv, companionFile, id } = requireEngine(engine);
  const override = typeof env[companionEnv] === "string" ? env[companionEnv].trim() : "";
  if (override && path.isAbsolute(override) && regularFile(override)) {
    return override;
  }
  const base = path.join(configuredHome(env), ".claude", "plugins", "cache", "claude-code-fusion", id);
  try {
    const runningVersion = fusionVersion();
    const candidates = fs
      .readdirSync(base)
      .map((version) => ({ version, candidate: path.join(base, version, "scripts", companionFile) }))
      .filter(({ candidate }) => regularFile(candidate))
      .map((entry) => ({ ...entry, mtime: fs.statSync(entry.candidate).mtimeMs }))
      .sort((left, right) => Number(right.version === runningVersion) - Number(left.version === runningVersion) || compareVersions(right.version, left.version) || right.mtime - left.mtime || left.candidate.localeCompare(right.candidate));
    if (candidates.length > 0) {
      return candidates[0].candidate;
    }
  } catch {
    void 0;
  }
  const sibling = path.resolve(moduleDirectory, "..", "..", "..", id, "scripts", companionFile);
  return fs.existsSync(sibling) ? sibling : null;
}

function companionFailureMessage(result) {
  return [result.stderr, result.stdout, result.error?.message].filter((value) => typeof value === "string" && value.trim()).join("\n").trim();
}

function acceptanceSubcommandUnavailable(result) {
  const message = companionFailureMessage(result);
  return /\b(?:unknown|unsupported|unrecognized)\s+(?:subcommand|command)\b/i.test(message) || /\brecord-acceptance\b.*\b(?:unknown|unsupported|unavailable|not found|not supported)\b/i.test(message) || /\b(?:cannot find module|ERR_MODULE_NOT_FOUND)\b/i.test(message);
}

export function recordEngineAcceptance({ engine, jobId, acceptance, source, reason, failureKind, acceptFailedTransport = false, asJson = false, env = process.env, requireUpdate = true }) {
  const { displayName } = requireEngine(engine);
  const bin = newestEngineCompanion(engine, env);
  let updated = false;
  if (bin) {
    const argv = [bin, "record-acceptance", "--job-id", jobId, "--acceptance", acceptance, ...(source ? ["--source", source] : []), ...(reason ? ["--reason", reason] : []), ...(failureKind ? ["--failure-kind", failureKind] : []), ...(acceptFailedTransport ? ["--accept-failed-transport"] : []), ...(asJson ? ["--json"] : [])];
    const result = spawnSync(process.execPath, argv, { cwd: path.dirname(bin), encoding: "utf8", env });
    if (result.error) {
      throw result.error;
    }
    if (result.status === 0) {
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
