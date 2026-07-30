import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const POSTURE_ENV = "FUSION_POSTURE";
const DATA_DIR_ENV = "FUSION_DATA_DIR";
const POSTURE_FILE = "posture";
const JUDGMENT_POSTURE = "judgment";
const STRICT_POSTURE = "strict";
const POSTURE_VALUES = [JUDGMENT_POSTURE, STRICT_POSTURE];
const DEFAULT_POSTURE = JUDGMENT_POSTURE;

function resolveFusionDataDir(env = process.env) {
  const override = env[DATA_DIR_ENV];
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "fusion-claude-code-fusion");
}

function normalizePosture(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return POSTURE_VALUES.includes(normalized) ? normalized : null;
}

function posturePath(env = process.env) {
  return path.join(resolveFusionDataDir(env), POSTURE_FILE);
}

function readPostureFile(env = process.env) {
  try {
    return normalizePosture(fs.readFileSync(posturePath(env), "utf8"));
  } catch {
    return null;
  }
}

function resolvePosture(env = process.env) {
  return normalizePosture(env[POSTURE_ENV]) ?? readPostureFile(env) ?? DEFAULT_POSTURE;
}

function isStrictPosture(env = process.env) {
  return resolvePosture(env) === STRICT_POSTURE;
}

export {
  DEFAULT_POSTURE,
  JUDGMENT_POSTURE,
  POSTURE_ENV,
  POSTURE_FILE,
  POSTURE_VALUES,
  STRICT_POSTURE,
  isStrictPosture,
  normalizePosture,
  posturePath,
  readPostureFile,
  resolveFusionDataDir,
  resolvePosture
};
