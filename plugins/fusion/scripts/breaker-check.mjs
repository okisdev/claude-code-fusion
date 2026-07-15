#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCodexStateDir, resolveCodexStateRoots } from "./lib/codex-state-roots.mjs";

const GROK_DATA_ENV = "GROK_COMPANION_DATA";
const LOOKBACK_ENV = "FUSION_BREAKER_LOOKBACK_HOURS";
const DEFAULT_LOOKBACK_HOURS = 12;
const GROK_FAILURE_KINDS = new Set(["quota", "auth", "missing_cli", "rate_limited"]);
const CODEX_BREAKER_FAILURE_KINDS = new Set([...GROK_FAILURE_KINDS, "protocol"]);
const GROK_FAILURE_STATUSES = new Set(["error", "failed"]);
const CODEX_FAILURE_STATUSES = new Set(["error", "failed"]);
const SUCCESS_STATUSES = new Set(["done", "completed"]);
const TERMINAL_STATUSES = new Set([...GROK_FAILURE_STATUSES, ...SUCCESS_STATUSES, "cancelled"]);
const CODEX_FAILURE_PATTERNS = [
  [
    "quota",
    /quota|insufficient (?:account )?(?:balance|credit|credits|funds)|balance (?:is )?exhausted|exhausted (?:account )?balance|payment required|usage limit|billing|credit limit|http(?:\/\d(?:\.\d)?)?\s+402|status(?: code)?\s*[:=]?\s*402/i
  ],
  ["auth", /unauthori[sz]ed|unauthenticated|authentication|auth(?:entication)? failed|invalid api key|api key/i],
  ["missing_cli", /missing[ _-]?cli|command not found|cli not found|no such file/i],
  ["rate_limited", /rate[ _-]?limit|too many requests|\b429\b/i]
];

function resolveGrokDataDir(env = process.env) {
  const override = env[GROK_DATA_ENV];
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "grok-claude-code-fusion");
}

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
        const recordFile = path.join(jobsDir, entry.name);
        const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
        if (record && typeof record === "object" && !Array.isArray(record)) {
          Object.defineProperty(record, "_fusionRecordFile", { value: recordFile });
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

function grokFailure(record, now, lookbackMs) {
  if (!GROK_FAILURE_STATUSES.has(record.status)) {
    return null;
  }
  const recordedFailureKind = typeof record.failureKind === "string" ? record.failureKind.trim().toLowerCase() : "";
  let failureKind = recordedFailureKind;
  const recoverLegacyFailure = !recordedFailureKind || recordedFailureKind === "error";
  if (recoverLegacyFailure) {
    failureKind = codexFailureKind([record.errorMessage, record.errorTail].filter((value) => typeof value === "string").join("\n"));
  }
  if (recoverLegacyFailure && !GROK_FAILURE_KINDS.has(failureKind) && typeof record._fusionRecordFile === "string") {
    try {
      const log = fs.readFileSync(record._fusionRecordFile.replace(/\.json$/, ".log"), "utf8");
      failureKind = codexFailureKind(log.slice(-64 * 1024));
    } catch {
      void 0;
    }
  }
  const timestamp = finishedAtMs(record.finishedAt);
  if (!GROK_FAILURE_KINDS.has(failureKind) || timestamp == null || !isWithinLookback(timestamp, now, lookbackMs)) {
    return null;
  }
  return { failureKind, timestamp };
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

function codexFailure(record, now, lookbackMs) {
  if (!CODEX_FAILURE_STATUSES.has(record.status)) {
    return null;
  }
  const recordedFailureKind = typeof record.failureKind === "string" ? record.failureKind.trim().toLowerCase() : "";
  const recoverLegacyFailure = !recordedFailureKind || recordedFailureKind === "error";
  const failureKind = recoverLegacyFailure
    ? codexFailureKind([record.errorMessage, record.errorTail].filter((value) => typeof value === "string").join("\n"))
    : recordedFailureKind;
  const timestamp = finishedAtMs(record.finishedAt ?? record.completedAt ?? record.updatedAt);
  if (!CODEX_BREAKER_FAILURE_KINDS.has(failureKind) || timestamp == null || !isWithinLookback(timestamp, now, lookbackMs)) {
    return null;
  }
  return { failureKind, timestamp };
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

function latestBreakerFailure(records, failureReader, now, lookbackMs) {
  let immediate = null;
  const outcomes = [];
  for (const record of records) {
    const timestamp = recordTimestamp(record);
    if (timestamp == null || !isWithinLookback(timestamp, now, lookbackMs)) {
      continue;
    }
    const failure = failureReader(record, now, lookbackMs);
    if (failure?.failureKind !== "rate_limited") {
      immediate = newerFailure(immediate, failure);
    }
    if (TERMINAL_STATUSES.has(record.status)) {
      outcomes.push({
        failureKind: failure?.failureKind ?? null,
        status: record.status,
        timestamp
      });
    }
  }
  outcomes.sort((left, right) => left.timestamp - right.timestamp);
  let previousRateLimit = null;
  let repeatedRateLimit = null;
  for (const outcome of outcomes) {
    if (SUCCESS_STATUSES.has(outcome.status)) {
      previousRateLimit = null;
      repeatedRateLimit = null;
      continue;
    }
    if (outcome.failureKind !== "rate_limited") {
      continue;
    }
    if (previousRateLimit && outcome.timestamp - previousRateLimit.timestamp <= lookbackMs) {
      repeatedRateLimit = { failureKind: "rate_limited", timestamp: outcome.timestamp };
    }
    previousRateLimit = outcome;
  }
  return newerFailure(immediate, repeatedRateLimit);
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

function advisoryLine(engine, failure, now) {
  return `fusion breaker advisory: treat the ${engine} breaker as open unless verified recovered; last failure ${failure.failureKind} ${formatAge(failure.timestamp, now)}.`;
}

function run(env = process.env, now = Date.now()) {
  const lookbackMs = resolveLookbackMs(env);
  const grok = latestBreakerFailure(readJobRecords(path.join(resolveGrokDataDir(env), "state")), grokFailure, now, lookbackMs);
  const codex = latestBreakerFailure(readDeduplicatedJobRecords(resolveCodexStateRoots(env)), codexFailure, now, lookbackMs);
  const lines = [];
  if (grok) {
    lines.push(advisoryLine("grok", grok, now));
  }
  if (codex) {
    lines.push(advisoryLine("codex", codex, now));
  }
  if (lines.length > 0) {
    process.stdout.write(`${lines.join("\n")}\n`);
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

export {
  advisoryLine,
  codexFailureKind,
  finishedAtMs,
  formatAge,
  resolveCodexStateDir,
  resolveCodexStateRoots,
  resolveGrokDataDir,
  resolveLookbackMs,
  run
};
