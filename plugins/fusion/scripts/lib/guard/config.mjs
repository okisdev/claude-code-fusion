import { STRICT_POSTURE, resolvePosture } from "../posture.mjs";
import { AUDIT_DIR_ENV, AUDIT_MAX_BYTES_ENV, AUDIT_MAX_FILES_ENV, AUDIT_RETENTION_DAYS_ENV, BUDGET_ENV, DEFAULT_AUDIT_MAX_BYTES, DEFAULT_AUDIT_MAX_FILES, DEFAULT_AUDIT_RETENTION_DAYS, DEFAULT_BUDGET, DEFAULT_FLEET_WAVE_GAP_MS, DEFAULT_LOCK_TIMEOUT_MS, DEFAULT_TAIL_ALLOWANCE, DEFAULT_TAIL_MAX_BYTES, DEFAULT_ZERO_DISPATCH_MAX_BYTES, DEFAULT_ZERO_DISPATCH_WRITES, FLEET_WAVE_GAP_ENV, LOCK_TIMEOUT_ENV, STATE_ENV, TAIL_ALLOWANCE_ENV, TAIL_MAX_BYTES_ENV, ZERO_DISPATCH_MAX_BYTES_ENV, ZERO_DISPATCH_WRITES_ENV } from "./constants.mjs";
import os from "node:os";
import path from "node:path";

function resolveStateDir(env = process.env) {
  const override = env[STATE_ENV];
  if (override) {
    return override;
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "fusion-claude-code-fusion", "inline-guard");
}

function resolveBudget(env = process.env) {
  const parsed = Number.parseInt(String(env[BUDGET_ENV]), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_BUDGET;
}

function resolveNonnegativeInteger(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
    return fallback;
  }
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveTailMaxBytes(env = process.env) {
  return resolveNonnegativeInteger(env, TAIL_MAX_BYTES_ENV, DEFAULT_TAIL_MAX_BYTES);
}

function resolveTailAllowance(env = process.env) {
  return resolveNonnegativeInteger(env, TAIL_ALLOWANCE_ENV, DEFAULT_TAIL_ALLOWANCE);
}

function resolveZeroDispatchMaxBytes(env = process.env) {
  return resolveNonnegativeInteger(env, ZERO_DISPATCH_MAX_BYTES_ENV, DEFAULT_ZERO_DISPATCH_MAX_BYTES);
}

function resolveZeroDispatchWrites(env = process.env) {
  return resolveNonnegativeInteger(env, ZERO_DISPATCH_WRITES_ENV, DEFAULT_ZERO_DISPATCH_WRITES);
}

function resolveLockTimeoutMs(env = process.env) {
  const raw = env[LOCK_TIMEOUT_ENV];
  if (raw === undefined || raw === null || (typeof raw === "string" && !String(raw).trim())) {
    return DEFAULT_LOCK_TIMEOUT_MS;
  }
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LOCK_TIMEOUT_MS;
}

function resolveMode(env = process.env) {
  return resolvePosture(env) === STRICT_POSTURE ? "enforce" : "advisory";
}

function resolveAuditDir(env = process.env) {
  const override = env[AUDIT_DIR_ENV];
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "fusion-claude-code-fusion", "inline-guard-audit");
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

function resolveFleetWaveGapMs(env = process.env) {
  return resolvePositiveInteger(env, FLEET_WAVE_GAP_ENV, DEFAULT_FLEET_WAVE_GAP_MS);
}

export { resolveStateDir, resolveBudget, resolveNonnegativeInteger, resolveTailMaxBytes, resolveTailAllowance, resolveZeroDispatchMaxBytes, resolveZeroDispatchWrites, resolveLockTimeoutMs, resolveMode, resolveAuditDir, resolvePositiveInteger, resolveAuditRetentionDays, resolveAuditMaxBytes, resolveAuditMaxFiles, resolveFleetWaveGapMs };
