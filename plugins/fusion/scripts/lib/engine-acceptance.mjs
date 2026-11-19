import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ENGINES, isEngineId } from "./engines.mjs";
import { readEngineJobRecord } from "./engine-job-state.mjs";
import { RESUMABLE_CODEX_FAILURE_KINDS } from "./stats/evidence.mjs";
import { withFileLock } from "./storage.mjs";
import { readWorkerRecord, readWorkerRecords, readWorkerSessionState, updateWorkerRecord, workerRecordFile } from "./worker-state.mjs";

const ACCEPTANCE_TIMEOUT_MS = 10_000;
const DELIVERY_ATTEMPT_LIMIT = 5;

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

export function recordEngineAcceptance({ engine, jobId, acceptance, source, reason, failureKind, acceptFailedTransport = false, asJson = false, env = process.env, requireUpdate = true, timeoutMs = ACCEPTANCE_TIMEOUT_MS }) {
  const { displayName } = requireEngine(engine);
  const bin = newestEngineCompanion(engine, env);
  let updated = false;
  if (bin) {
    const argv = [bin, "record-acceptance", "--job-id", jobId, "--acceptance", acceptance, ...(source ? ["--source", source] : []), ...(reason ? ["--reason", reason] : []), ...(failureKind ? ["--failure-kind", failureKind] : []), ...(acceptFailedTransport ? ["--accept-failed-transport"] : []), ...(asJson ? ["--json"] : [])];
    const result = spawnSync(process.execPath, argv, { cwd: path.dirname(bin), encoding: "utf8", env, timeout: timeoutMs, killSignal: "SIGKILL" });
    if (result.error?.code === "ETIMEDOUT") {
      return { updated: false, error: new Error(`${displayName} acceptance record update timed out after ${timeoutMs / 1000} seconds.`) };
    }
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

function deliveryState(entries) {
  const failures = entries.filter((entry) => entry.status === "failed");
  return {
    status: entries.every((entry) => entry.status === "delivered" || entry.status === "skipped") ? entries.some((entry) => entry.status === "skipped") ? "skipped" : "delivered" : failures.length ? "failed" : "pending",
    attempts: entries.reduce((total, entry) => total + entry.attempts, 0),
    lastError: failures.map((entry) => `${entry.jobId}: ${entry.lastError}`).join("; ") || null,
    updatedAt: new Date().toISOString(),
    entries
  };
}

function withDeliveryState(record, entries) {
  const state = deliveryState(entries);
  const { engineSettlementError: _engineSettlementError, ...updated } = record;
  return { ...updated, engineAcceptanceDelivery: state, ...(state.lastError ? { engineSettlementError: state.lastError } : {}) };
}

export function prepareEngineAcceptanceDelivery(record, { jobs, acceptFailedTransport = false }) {
  const entries = [...(record.engineAcceptanceDelivery?.entries ?? [])];
  for (const { engine, jobId } of jobs) {
    const payload = { engine, jobId, acceptance: record.acceptance, source: record.acceptanceSource, reason: record.acceptanceReason ?? null, failureKind: record.acceptanceFailureKind ?? null, acceptFailedTransport };
    const index = entries.findIndex((entry) => entry.engine === engine && entry.jobId === jobId);
    if (index >= 0 && Object.entries(payload).every(([key, value]) => entries[index][key] === value)) {
      continue;
    }
    const entry = { ...payload, id: randomUUID(), status: "pending", attempts: 0, failures: 0, lastError: null, updatedAt: new Date().toISOString() };
    if (index >= 0) entries[index] = entry;
    else entries.push(entry);
  }
  return { ...record, engineAcceptanceDelivery: deliveryState(entries) };
}

function deliveryFailures(entry) {
  return entry.failures ?? Math.max(0, entry.attempts - Number(Boolean(entry.attemptId)));
}

function retryableDelivery(entry, env, respectBackoff) {
  if (!["pending", "failed"].includes(entry.status) || deliveryFailures(entry) >= DELIVERY_ATTEMPT_LIMIT
    || (entry.attemptId && !(Date.now() - Date.parse(entry.updatedAt) > ACCEPTANCE_TIMEOUT_MS + 1_000))) return false;
  if (!respectBackoff || entry.attempts === 0) return true;
  const configured = Number(env.FUSION_ACCEPTANCE_RETRY_BACKOFF_MS);
  const backoffMs = Number.isSafeInteger(configured) && configured >= 0 ? configured : 1000;
  const delayMs = Math.min(backoffMs * 2 ** Math.max(0, entry.attempts - 1), 60 * 60 * 1000);
  return Date.now() - Date.parse(entry.updatedAt) >= delayMs;
}

export function deliverWorkerEngineAcceptance({ taskId, env = process.env, asJson = false, timeoutMs = ACCEPTANCE_TIMEOUT_MS, deadline = Infinity, respectBackoff = false }) {
  const snapshot = readWorkerRecord(taskId, env);
  const lockOptions = Number.isFinite(deadline) ? { timeoutMs: 0 } : undefined;
  for (const candidate of snapshot?.engineAcceptanceDelivery?.entries ?? []) {
    if (Date.now() >= deadline) break;
    if (!["pending", "failed"].includes(candidate.status)) continue;
    const lock = path.join(path.dirname(workerRecordFile(taskId, env)), `.acceptance-${candidate.engine}-${candidate.jobId}`);
    let acquired = false;
    try {
      withFileLock(lock, () => {
        acquired = true;
        for (;;) {
          if (Date.now() >= deadline) break;
          let claimed = null;
          updateWorkerRecord(taskId, env, (record) => {
            const entries = record?.engineAcceptanceDelivery?.entries;
            const current = entries?.find((entry) => entry.engine === candidate.engine && entry.jobId === candidate.jobId);
            if (!current || !["pending", "failed"].includes(current.status)) return null;
            if (readEngineJobRecord(current.engine, current.jobId, env) === null) {
              return withDeliveryState(record, entries.map((entry) => entry.id === current.id
                ? { ...entry, status: "skipped", skipReason: "record-missing", lastError: null, attemptId: null, updatedAt: new Date().toISOString() }
                : entry));
            }
            if (!retryableDelivery(current, env, respectBackoff)) return null;
            claimed = { ...current, status: "pending", attempts: current.attempts + 1, failures: deliveryFailures(current), attemptId: randomUUID(), updatedAt: new Date().toISOString() };
            return { ...record, engineAcceptanceDelivery: deliveryState(entries.map((entry) => entry.id === claimed.id ? claimed : entry)) };
          }, lockOptions);
          if (!claimed) break;
          let lastError = null;
          try {
            const transport = engineAcceptanceTransport({ ...claimed, env });
            const result = recordEngineAcceptance({ ...claimed, acceptFailedTransport: transport.acceptFailedTransport, asJson, env, timeoutMs: Math.max(1, Math.min(timeoutMs, deadline - Date.now())) });
            if (!result.updated) throw result.error ?? new Error("Engine acceptance record update failed.");
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
          let recordMissing = false;
          if (lastError !== null) {
            try { recordMissing = readEngineJobRecord(claimed.engine, claimed.jobId, env) === null; } catch { void 0; }
          }
          let replaced = false;
          updateWorkerRecord(taskId, env, (record) => {
            const entries = record?.engineAcceptanceDelivery?.entries;
            replaced = entries?.some((entry) => entry.engine === claimed.engine && entry.jobId === claimed.jobId && entry.id !== claimed.id);
            if (!entries?.some((entry) => entry.id === claimed.id && entry.attemptId === claimed.attemptId)) return null;
            const updatedEntries = entries.map((entry) => entry.id === claimed.id && entry.attemptId === claimed.attemptId
              ? { ...entry, status: recordMissing ? "skipped" : lastError ? "failed" : "delivered", ...(recordMissing ? { skipReason: "record-missing" } : {}), failures: claimed.failures + Number(lastError !== null), lastError: recordMissing ? null : lastError, attemptId: null, updatedAt: new Date().toISOString() }
              : entry);
            return withDeliveryState(record, updatedEntries);
          }, lockOptions);
          if (!replaced) break;
        }
      }, { timeoutMs: 0, staleMs: ACCEPTANCE_TIMEOUT_MS + 1_000 });
    } catch (error) {
      if (acquired || error?.code !== "ETIMEDOUT") throw error;
    }
  }
  return readWorkerRecord(taskId, env);
}

export function retryWorkerEngineAcceptances({ env = process.env, skipTaskIds = new Set(), sessionId = null } = {}) {
  const respectBackoff = sessionId !== null;
  const configuredTimeout = Number(env.FUSION_ACCEPTANCE_RETRY_TIMEOUT_MS);
  const timeoutMs = sessionId === null ? ACCEPTANCE_TIMEOUT_MS : Math.min(Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 500, 500);
  const deadline = sessionId === null ? Infinity : Date.now() + 2000;
  const candidates = sessionId === null ? readWorkerRecords(env) : (readWorkerSessionState(sessionId, env)?.engineAcceptanceTaskIds ?? []);
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;
    const record = sessionId === null ? candidate : readWorkerRecord(candidate, env);
    if (!record) continue;
    if (sessionId !== null && record.sessionId !== sessionId) continue;
    if (skipTaskIds.has(record.taskId) || !record.engineAcceptanceDelivery?.entries?.some((entry) => ["pending", "failed"].includes(entry.status))) continue;
    try {
      deliverWorkerEngineAcceptance({ taskId: record.taskId, env, timeoutMs, deadline, respectBackoff });
    } catch {
      continue;
    }
  }
}
