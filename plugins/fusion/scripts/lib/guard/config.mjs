import { AUDIT_DIR_ENV, AUDIT_MAX_BYTES_ENV, AUDIT_MAX_FILES_ENV, AUDIT_RETENTION_DAYS_ENV, DEFAULT_AUDIT_MAX_BYTES, DEFAULT_AUDIT_MAX_FILES, DEFAULT_AUDIT_RETENTION_DAYS, STATE_ENV } from "./constants.mjs";
import { resolveFusionDataDir } from "../worker-state.mjs";
export { resolveLockTimeoutMs } from "../worker-state.mjs";
import path from "node:path";

function resolveStateDir(env = process.env) {
  const override = env[STATE_ENV];
  if (override) {
    return override;
  }
  return path.join(resolveFusionDataDir(env), "inline-guard");
}

function resolveAuditDir(env = process.env) {
  const override = env[AUDIT_DIR_ENV];
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return path.join(resolveFusionDataDir(env), "inline-guard-audit");
}

function resolvePositiveInteger(env, name, fallback) {
  const parsed = Number.parseInt(String(env[name]), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveAuditRetentionDays(env = process.env) {
  return resolvePositiveInteger(env, AUDIT_RETENTION_DAYS_ENV, DEFAULT_AUDIT_RETENTION_DAYS);
}

function resolveAuditMaxBytes(env = process.env) {
  return resolvePositiveInteger(env, AUDIT_MAX_BYTES_ENV, DEFAULT_AUDIT_MAX_BYTES);
}

function resolveAuditMaxFiles(env = process.env) {
  return resolvePositiveInteger(env, AUDIT_MAX_FILES_ENV, DEFAULT_AUDIT_MAX_FILES);
}

export { resolveStateDir, resolveAuditDir, resolvePositiveInteger, resolveAuditRetentionDays, resolveAuditMaxBytes, resolveAuditMaxFiles };
