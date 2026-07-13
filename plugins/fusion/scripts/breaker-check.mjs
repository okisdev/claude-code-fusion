#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GROK_DATA_ENV = "GROK_COMPANION_DATA";
const CODEX_STATE_ENV = "FUSION_CODEX_STATE_DIR";
const LOOKBACK_ENV = "FUSION_BREAKER_LOOKBACK_HOURS";
const DEFAULT_LOOKBACK_HOURS = 12;
const GROK_FAILURE_KINDS = new Set(["quota", "auth", "missing_cli", "rate_limited"]);
const GROK_TERMINAL_STATUSES = new Set(["done", "error", "failed", "cancelled"]);
const CODEX_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "error"]);
const CODEX_FAILURE_PATTERNS = [
  ["quota", /quota|payment required|balance exhausted|insufficient balance|billing|credit limit/i],
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

function resolveCodexStateDir(env = process.env) {
  const override = env[CODEX_STATE_ENV];
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "codex-openai-codex", "state");
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
  if (!GROK_TERMINAL_STATUSES.has(record.status)) {
    return null;
  }
  const failureKind = typeof record.failureKind === "string" ? record.failureKind.trim().toLowerCase() : "";
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
  if (!CODEX_TERMINAL_STATUSES.has(record.status)) {
    return null;
  }
  const failureKind = codexFailureKind(record.errorMessage);
  const timestamp = finishedAtMs(record.completedAt ?? record.updatedAt);
  if (failureKind == null || timestamp == null || !isWithinLookback(timestamp, now, lookbackMs)) {
    return null;
  }
  return { failureKind, timestamp };
}

function latestFailure(records, failureReader, now, lookbackMs) {
  let latest = null;
  for (const record of records) {
    const failure = failureReader(record, now, lookbackMs);
    if (failure && (latest == null || failure.timestamp > latest.timestamp)) {
      latest = failure;
    }
  }
  return latest;
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
  const grok = latestFailure(readJobRecords(path.join(resolveGrokDataDir(env), "state")), grokFailure, now, lookbackMs);
  const codex = latestFailure(readJobRecords(resolveCodexStateDir(env)), codexFailure, now, lookbackMs);
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
  resolveGrokDataDir,
  resolveLookbackMs,
  run
};
