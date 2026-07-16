import os from "node:os";
import path from "node:path";

const CANONICAL_STATE_ENV = "FUSION_CODEX_STATE";
const COMPATIBILITY_STATE_ENV = "FUSION_CODEX_STATE_DIR";
const DATA_ENV = "CODEX_COMPANION_DATA";
const INCLUDE_LEGACY_ENV = "FUSION_CODEX_INCLUDE_LEGACY";

function configuredPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const resolved = value.trim();
  return path.isAbsolute(resolved) ? path.resolve(resolved) : null;
}

function homeDir(env) {
  return configuredPath(env.HOME) ?? os.homedir();
}

export function resolveCodexStateRoots(env = process.env) {
  const stateOverride = configuredPath(env[CANONICAL_STATE_ENV]) ?? configuredPath(env[COMPATIBILITY_STATE_ENV]);
  if (stateOverride) {
    return [stateOverride];
  }
  const dataOverride = configuredPath(env[DATA_ENV]);
  if (dataOverride) {
    return [path.join(dataOverride, "state")];
  }
  const dataRoot = path.join(homeDir(env), ".claude", "plugins", "data");
  const canonical = path.join(dataRoot, "codex-claude-code-fusion", "state");
  const includeLegacy = /^(?:1|true|yes|on)$/i.test(String(env[INCLUDE_LEGACY_ENV] ?? ""));
  return includeLegacy ? [canonical, path.join(dataRoot, "codex-openai-codex", "state")] : [canonical];
}

export function resolveCodexStateDir(env = process.env) {
  return resolveCodexStateRoots(env)[0];
}
