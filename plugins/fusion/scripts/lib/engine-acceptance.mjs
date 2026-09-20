import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ENGINES } from "./engines.mjs";

export class GrokPluginUpgradeRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "GrokPluginUpgradeRequiredError";
    this.code = "GROK_PLUGIN_UPGRADE_REQUIRED";
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

function newestCompanion(engine, env = process.env) {
  const { companionEnv, companionFile, id } = ENGINES[engine];
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

export function newestGrokCompanion(env = process.env) {
  return newestCompanion(ENGINES.grok.id, env);
}

export function newestCodexCompanion(env = process.env) {
  return newestCompanion(ENGINES.codex.id, env);
}

function companionFailureMessage(result) {
  return [result.stderr, result.stdout, result.error?.message].filter((value) => typeof value === "string" && value.trim()).join("\n").trim();
}

function codexAcceptanceSubcommandUnavailable(result) {
  if (result.error) {
    return true;
  }
  const message = companionFailureMessage(result);
  return /\b(?:unknown|unsupported|unrecognized)\s+(?:subcommand|command)\b/i.test(message) || /\brecord-acceptance\b.*\b(?:unknown|unsupported|unavailable|not found|not supported)\b/i.test(message) || /\b(?:cannot find module|ERR_MODULE_NOT_FOUND)\b/i.test(message);
}

function grokAcceptanceSubcommandUnavailable(result) {
  if (result.error) {
    return false;
  }
  const message = companionFailureMessage(result);
  return /\b(?:unknown|unsupported|unrecognized)\s+(?:subcommand|command)\b/i.test(message) || /\brecord-acceptance\b.*\b(?:unknown|unsupported|unavailable|not found|not supported)\b/i.test(message) || /\b(?:cannot find module|ERR_MODULE_NOT_FOUND)\b/i.test(message);
}

function recordCodexCompanionAcceptance({ jobId, acceptance, source, reason, failureKind, acceptFailedTransport, workspaceRoot, env }) {
  const bin = newestCodexCompanion(env);
  if (!bin) {
    return { updated: false };
  }
  const argv = [bin, "record-acceptance", "--job-id", jobId, "--acceptance", acceptance, ...(source ? ["--source", source] : []), ...(reason ? ["--reason", reason] : []), ...(failureKind ? ["--failure-kind", failureKind] : []), ...(acceptFailedTransport ? ["--accept-failed-transport"] : [])];
  const result = spawnSync(process.execPath, argv, { cwd: workspaceRoot, encoding: "utf8", env });
  if (!result.error && result.status === 0) {
    return { updated: true };
  }
  if (codexAcceptanceSubcommandUnavailable(result)) {
    return { updated: false };
  }
  throw new Error(companionFailureMessage(result) || "Codex acceptance record update failed.");
}

function recordGrokCompanionAcceptance({ jobId, acceptance, reason, failureKind, acceptFailedTransport, workspaceRoot, asJson, env }) {
  const bin = newestGrokCompanion(env);
  if (!bin) {
    throw new GrokPluginUpgradeRequiredError("The Grok job was found, but its companion is unavailable. Upgrade the Grok plugin and retry.");
  }
  const argv = [bin, "record-acceptance", "--job-id", jobId, "--acceptance", acceptance, ...(reason ? ["--reason", reason] : []), ...(failureKind ? ["--failure-kind", failureKind] : []), ...(acceptFailedTransport ? ["--accept-failed-transport"] : []), ...(asJson ? ["--json"] : [])];
  const result = spawnSync(process.execPath, argv, { cwd: workspaceRoot, encoding: "utf8", env });
  if (!result.error && result.status === 0) {
    return { updated: true };
  }
  if (grokAcceptanceSubcommandUnavailable(result)) {
    throw new GrokPluginUpgradeRequiredError("The installed Grok plugin does not support record-acceptance. Upgrade the Grok plugin and retry.");
  }
  throw new Error(companionFailureMessage(result) || "Grok acceptance record update failed.");
}

export function recordEngineAcceptance({ engine, jobId, acceptance, source, reason, failureKind, acceptFailedTransport = false, workspaceRoot, asJson = false, env = process.env, requireUpdate = true }) {
  if (engine === ENGINES.grok.id) {
    return recordGrokCompanionAcceptance({ jobId, acceptance, reason, failureKind, acceptFailedTransport, workspaceRoot, asJson, env });
  }
  const result = recordCodexCompanionAcceptance({ jobId, acceptance, source, reason, failureKind, acceptFailedTransport, workspaceRoot, env });
  if (!result.updated && requireUpdate) {
    throw new Error("Codex job record was not updated because the companion or subcommand is unavailable.");
  }
  return result;
}
