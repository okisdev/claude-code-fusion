#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ENGINES, ENGINE_IDS, engineStateRoots } from "./lib/engines.mjs";
import { canonicalWorkerAgentType, readWorkerRecords } from "./lib/worker-state.mjs";
import { tagMessage } from "./lib/user-messages.mjs";

const LOOKBACK_ENV = "FUSION_BREAKER_LOOKBACK_HOURS";
const DEFAULT_LOOKBACK_HOURS = 12;
const WORKER_BREAKER_LANES = ["fusion:claude-worker", "fusion:trivial-worker"];
const HARD_FAILURE_KINDS = new Set(["quota", "auth", "missing_cli", "setup", "protocol", "transport", "sandbox"]);
const REPEATED_FAILURE_KINDS = new Set(["rate_limited", "timeout", "stall", "network", "process", "died", "patch_thrash", "exec_lost"]);
const POOL_SCOPED_KINDS = new Set(["quota", "rate_limited"]);
const BREAKER_FAILURE_KINDS = new Set([...HARD_FAILURE_KINDS, ...REPEATED_FAILURE_KINDS, "permission"]);
const FAILURE_STATUSES = new Set(["error", "failed"]);
const SUCCESS_STATUSES = new Set(["done", "completed"]);
const TERMINAL_STATUSES = new Set([...FAILURE_STATUSES, ...SUCCESS_STATUSES, "cancelled"]);
const CODEX_FAILURE_PATTERNS = [
  [
    "quota",
    /quota|insufficient (?:account )?(?:balance|credit|credits|funds)|balance (?:is )?exhausted|exhausted (?:account )?balance|payment required|usage limit|billing|credit limit|http(?:\/\d(?:\.\d)?)?\s+402|status(?: code)?\s*[:=]?\s*402/i
  ],
  ["auth", /unauthori[sz]ed|unauthenticated|authentication|auth(?:entication)? failed|invalid api key|api key/i],
  ["missing_cli", /missing[ _-]?cli|command not found|cli not found|no such file/i],
  ["rate_limited", /rate[ _-]?limit|too many requests|\b429\b/i],
  ["timeout", /timed?\s*out|timeout/i],
  ["stall", /\bstall(?:ed|ing)?\b|no[- ]progress/i],
  ["protocol", /collaboration policy violation|companion protocol violation|transport protocol violation/i],
  ["transport", /transport (?:preflight|initialization|handshake|failed)|broken pipe|\bEPIPE\b|failed to (?:spawn|launch)|protocol stream closed/i],
  ["permission", /\b(?:EACCES|EPERM)\b|operation not permitted|permission denied/i]
];
const TRANSPORT_PERMISSION_PATTERN = /(?:sandbox|seatbelt|landlock).*(?:init|initializ|profile|policy)|(?:operation not permitted|\bEACCES\b|\bEPERM\b|permission denied).*(?:brief|prompt|transport|state|plugin|sandbox)|(?:brief|prompt|transport|state|plugin|sandbox).*(?:operation not permitted|\bEACCES\b|\bEPERM\b|permission denied)/i;
const VERIFIED_VERSIONS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "verified-versions.json");

function resolveLookbackMs(env = process.env) {
  const parsed = Number.parseFloat(String(env[LOOKBACK_ENV] ?? ""));
  const hours = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOOKBACK_HOURS;
  return hours * 60 * 60 * 1000;
}

function readJobRecords(stateRoot) {
  const records = [];
  let workspaces;
  try {
    workspaces = fs.readdirSync(stateRoot, { withFileTypes: true });
  } catch {
    return records;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) {
      continue;
    }
    const jobsDir = path.join(stateRoot, workspace.name, "jobs");
    let entries;
    try {
      entries = fs.readdirSync(jobsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      try {
        const record = JSON.parse(fs.readFileSync(path.join(jobsDir, entry.name), "utf8"));
        if (record && typeof record === "object" && !Array.isArray(record)) {
          records.push(record);
        }
      } catch {
        void 0;
      }
    }
  }
  return records;
}

function readDeduplicatedJobRecords(stateRoots) {
  const recordsWithoutIds = [];
  const byId = new Map();
  for (const root of stateRoots) {
    for (const record of readJobRecords(root)) {
      const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : null;
      if (!id) {
        recordsWithoutIds.push(record);
        continue;
      }
      const current = byId.get(id);
      if (!current || (TERMINAL_STATUSES.has(record.status) && !TERMINAL_STATUSES.has(current.status)) || (TERMINAL_STATUSES.has(record.status) === TERMINAL_STATUSES.has(current.status) && (recordTimestamp(record) ?? Number.NEGATIVE_INFINITY) > (recordTimestamp(current) ?? Number.NEGATIVE_INFINITY))) {
        byId.set(id, record);
      }
    }
  }
  return [...recordsWithoutIds, ...byId.values()];
}

function finishedAtMs(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isWithinLookback(timestamp, now, lookbackMs) {
  const ageMs = now - timestamp;
  return ageMs >= 0 && ageMs <= lookbackMs;
}

function recordFailureText(record) {
  return [record?.errorMessage, record?.errorTail, record?.cancelReason].filter((value) => typeof value === "string").join("\n");
}

function permissionBreaksTransport(record, failureKind) {
  return failureKind === "permission" && TRANSPORT_PERMISSION_PATTERN.test(recordFailureText(record));
}

function supportedBreakerFailure(record, failureKind) {
  if (failureKind === "permission") {
    return permissionBreaksTransport(record, failureKind);
  }
  return BREAKER_FAILURE_KINDS.has(failureKind);
}

function normalizedRecordedFailureKind(record, value) {
  const failureKind = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (failureKind === "policy" && /collaboration policy violation|companion protocol violation|transport protocol violation|delegated Codex execution attempted the disabled \w+ tool/i.test(recordFailureText(record))) {
    return "protocol";
  }
  return failureKind;
}

function engineFailure(engine, record, now, lookbackMs) {
  if (!FAILURE_STATUSES.has(record.status)) {
    return null;
  }
  const failureKind = normalizedRecordedFailureKind(record, record.failureKind);
  const timestamp = recordTimestamp(record);
  if (!supportedBreakerFailure(record, failureKind) || timestamp == null || !isWithinLookback(timestamp, now, lookbackMs)) {
    return null;
  }
  const version = record[ENGINES[engine].versionField];
  return {
    failureKind,
    timestamp,
    version: typeof version === "string" && version.trim() ? version.trim() : null
  };
}

function codexFailureKind(errorMessage) {
  if (typeof errorMessage !== "string" || !errorMessage.trim()) {
    return null;
  }
  for (const [failureKind, pattern] of CODEX_FAILURE_PATTERNS) {
    if (pattern.test(errorMessage)) {
      return failureKind;
    }
  }
  return null;
}

function recordTimestamp(record) {
  return finishedAtMs(record.finishedAt ?? record.completedAt ?? record.updatedAt);
}

function newerFailure(left, right) {
  if (left == null) {
    return right;
  }
  if (right == null) {
    return left;
  }
  return right.timestamp > left.timestamp ? right : left;
}

function latestBreakerFailure(records, failureReader, now, lookbackMs, includesFailure = () => true) {
  const outcomes = [];
  for (const record of records) {
    const timestamp = recordTimestamp(record);
    if (timestamp == null || !isWithinLookback(timestamp, now, lookbackMs)) {
      continue;
    }
    const failure = failureReader(record, now, lookbackMs);
    if (TERMINAL_STATUSES.has(record.status)) {
      const ignored = FAILURE_STATUSES.has(record.status) && !includesFailure(failure?.failureKind ?? normalizedRecordedFailureKind(record, record.failureKind));
      outcomes.push({
        failureKind: ignored ? null : failure?.failureKind ?? null,
        ignored,
        status: record.status,
        timestamp,
        version: failure?.version ?? null
      });
    }
  }
  outcomes.sort((left, right) => left.timestamp - right.timestamp);
  let immediate = null;
  let previousTransientFailure = null;
  let repeatedTransientFailure = null;
  for (const outcome of outcomes) {
    if (SUCCESS_STATUSES.has(outcome.status)) {
      immediate = null;
      previousTransientFailure = null;
      repeatedTransientFailure = null;
      continue;
    }
    if (outcome.ignored) {
      continue;
    }
    if (HARD_FAILURE_KINDS.has(outcome.failureKind) || outcome.failureKind === "permission") {
      immediate = { failureKind: outcome.failureKind, timestamp: outcome.timestamp, version: outcome.version };
      previousTransientFailure = null;
      repeatedTransientFailure = null;
      continue;
    }
    if (!REPEATED_FAILURE_KINDS.has(outcome.failureKind)) {
      previousTransientFailure = null;
      repeatedTransientFailure = null;
      continue;
    }
    if (previousTransientFailure && previousTransientFailure.failureKind === outcome.failureKind && outcome.timestamp - previousTransientFailure.timestamp <= lookbackMs) {
      repeatedTransientFailure = { failureKind: outcome.failureKind, timestamp: outcome.timestamp, version: outcome.version };
    }
    previousTransientFailure = outcome;
  }
  const failure = newerFailure(immediate, repeatedTransientFailure);
  if (failure == null) {
    return null;
  }
  const kindCount = outcomes.filter((outcome) => outcome.failureKind === failure.failureKind).length;
  const terminalCount = outcomes.length;
  return { ...failure, kindCount, terminalCount };
}

function formatAge(timestamp, now) {
  const totalMinutes = Math.floor((now - timestamp) / 60000);
  if (totalMinutes < 1) {
    return "less than 1 minute ago";
  }
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"} ago`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    return `${totalHours} hour${totalHours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(totalHours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function formatLookbackHours(lookbackMs) {
  const hours = lookbackMs / (60 * 60 * 1000);
  return hours % 1 === 0 ? String(hours) : hours.toFixed(1);
}

function verifiedEngineVersion(engine) {
  try {
    const versions = JSON.parse(fs.readFileSync(VERIFIED_VERSIONS_FILE, "utf8"));
    const version = versions?.[ENGINES[engine]?.verifiedVersionKey];
    return typeof version === "string" && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

function versionAdvisorySuffix(engine, failure) {
  const installed = typeof failure?.version === "string" && failure.version.trim() ? failure.version.trim() : null;
  const verified = installed ? verifiedEngineVersion(engine) : null;
  return installed && verified && installed !== verified ? `; ${engine} ${installed} installed, contract verified on ${verified}` : "";
}

function advisoryLine(engine, failure, now, lookbackMs = DEFAULT_LOOKBACK_HOURS * 60 * 60 * 1000, pool = null) {
  const hoursText = formatLookbackHours(lookbackMs);
  return `fusion breaker advisory: treat the ${engine}${pool === null ? "" : ` ${pool} pool`} breaker as open unless verified recovered; last failure ${failure.failureKind} ${formatAge(failure.timestamp, now)} (${failure.kindCount} ${failure.failureKind} across ${failure.terminalCount} terminal jobs, ${hoursText}h window). Route new work to another eligible healthy lane.${versionAdvisorySuffix(engine, failure)}`;
}

function workerFailure(record, now, lookbackMs) {
  if (!new Set(["failed", "incomplete", "owner_ended"]).has(record.transportStatus)) {
    return null;
  }
  const failureKind = typeof record.failureKind === "string" ? record.failureKind.trim().toLowerCase() : "";
  const timestamp = finishedAtMs(record.finishedAt ?? record.updatedAt);
  if (!REPEATED_FAILURE_KINDS.has(failureKind) || timestamp == null || !isWithinLookback(timestamp, now, lookbackMs)) {
    return null;
  }
  return { failureKind, timestamp };
}

function workerBreakerRecords(records, lane) {
  return records
    .filter((record) => canonicalWorkerAgentType(record.agentType) === lane)
    .map((record) => ({ ...record, status: record.transportStatus === "done" ? "done" : ["failed", "incomplete", "owner_ended"].includes(record.transportStatus) ? "failed" : record.transportStatus }));
}

function run(env = process.env, now = Date.now()) {
  const lookbackMs = resolveLookbackMs(env);
  const engineLines = new Map();
  for (const engine of ENGINE_IDS) {
    const lines = [];
    const records = readDeduplicatedJobRecords(engineStateRoots(engine, env));
    const failureReader = (record, at, window) => engineFailure(engine, record, at, window);
    const pools = new Map();
    for (const record of records) {
      const pool = typeof record.billingPool === "string" ? record.billingPool : null;
      if (!pools.has(pool)) {
        pools.set(pool, []);
      }
      pools.get(pool).push(record);
    }
    if (!pools.size || (pools.size === 1 && pools.has(null))) {
      const failure = latestBreakerFailure(records, failureReader, now, lookbackMs);
      if (failure) {
        lines.push(advisoryLine(engine, failure, now, lookbackMs));
      }
      engineLines.set(engine, lines);
      continue;
    }
    const engineFailureResult = latestBreakerFailure(records, failureReader, now, lookbackMs, (kind) => !POOL_SCOPED_KINDS.has(kind));
    if (engineFailureResult) {
      lines.push(advisoryLine(engine, engineFailureResult, now, lookbackMs));
    }
    for (const [pool, poolRecords] of pools) {
      const poolFailure = latestBreakerFailure(poolRecords, failureReader, now, lookbackMs, (kind) => POOL_SCOPED_KINDS.has(kind));
      if (poolFailure) {
        lines.push(advisoryLine(engine, poolFailure, now, lookbackMs, pool));
      }
    }
    engineLines.set(engine, lines);
  }
  const lines = [...(engineLines.get("grok") ?? []), ...ENGINE_IDS.filter((engine) => engine !== "grok").flatMap((engine) => engineLines.get(engine) ?? [])];
  const workerRecords = readWorkerRecords(env, { modifiedSinceMs: now - lookbackMs, modifiedBeforeMs: now });
  for (const lane of WORKER_BREAKER_LANES) {
    const worker = latestBreakerFailure(workerBreakerRecords(workerRecords, lane), workerFailure, now, lookbackMs);
    if (worker) {
      lines.push(advisoryLine(lane, worker, now, lookbackMs));
    }
  }
  if (lines.length > 0) {
    process.stdout.write(`${tagMessage("breaker-check.breaker-advisory", lines.join("\n"))}\n`);
  }
}

function main() {
  try {
    run();
  } catch {
    void 0;
  }
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  main();
}

export { advisoryLine, codexFailureKind, formatAge, run };
