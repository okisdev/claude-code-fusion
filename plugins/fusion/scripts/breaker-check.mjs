#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ENGINES, ENGINE_IDS, PEER_RESCUE_AGENT_NAMES } from "./lib/engines.mjs";
import { engineHealth, readEngineHealthRecords } from "./lib/engine-health.mjs";
import { tagMessage } from "./lib/user-messages.mjs";

const DEFAULT_LOOKBACK_HOURS = 12;
const WORKER_BREAKER_LANES = ["fusion:claude-worker", "fusion:trivial-worker"];
const CODEX_FAILURE_PATTERNS = [
  [
    "quota",
    /quota|insufficient (?:account )?(?:balance|credit|credits|funds)|balance (?:is )?exhausted|exhausted (?:account )?balance|payment required|usage limit|billing|credit limit|http(?:\/\d(?:\.\d)?)?\s+402|status(?: code)?\s*[:=]?\s*402/i
  ],
  ["rate_limited", /rate[ _-]?limit|too many requests|\b429\b|Flex capacity unavailable\.|Policy-restricted capacity is unavailable\./i],
  ["refused", /misalignment policy|cyber policy|violat(?:ed|es|ion of) (?:the |our |an? )?[a-z ]{0,40}policy|content policy|reason: content_filter|flagged for possible (?:cybersecurity|biological) risk/i],
  ["auth", /unauthori[sz]ed|unauthenticated|authentication|auth(?:entication)? failed|invalid api key|api key/i],
  ["network", /workspace routing discovery timed out|stream disconnected before completion|error sending request for url|connection (?:refused|reset)|\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b|getaddrinfo|network is unreachable|Reconnecting\.\.\./i],
  ["missing_cli", /missing[ _-]?cli|command not found|cli not found|no such file/i],
  ["timeout", /timed?\s*out|timeout/i],
  ["stall", /\bstall(?:ed|ing)?\b|no[- ]progress/i],
  ["protocol", /collaboration policy violation|companion protocol violation|transport protocol violation/i],
  ["transport", /transport (?:preflight|initialization|handshake|failed)|broken pipe|\bEPIPE\b|failed to (?:spawn|launch)|protocol stream closed/i],
  ["permission", /\b(?:EACCES|EPERM)\b|operation not permitted|permission denied/i]
];
const VERIFIED_VERSIONS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "verified-versions.json");
const FUSION_MANIFEST_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".claude-plugin", "plugin.json");
const ENGINE_BIN_OVERRIDES = { codex: "CODEX_BIN", grok: "GROK_BIN", cursor: "CURSOR_AGENT_BIN", devin: "DEVIN_BIN", agy: "AGY_BIN" };

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
  return `fusion breaker advisory: treat the ${engine}${pool === null ? "" : ` ${pool} pool`} breaker as open unless verified recovered; last failure ${failure.failureKind} ${formatAge(failure.timestamp, now)} (${failure.kindCount} ${failure.failureKind} across ${failure.terminalCount} terminal jobs, ${hoursText}h window${failure.scope === "mode" ? `, ${failure.mode} mode` : ""}). Route new work to another eligible healthy lane.${versionAdvisorySuffix(engine, failure)}`;
}

function wrapperDeliveryAdvisory(records, now, lookbackMs) {
  if (records.length < 20) {
    return null;
  }
  let version;
  try {
    version = JSON.parse(fs.readFileSync(FUSION_MANIFEST_FILE, "utf8")).version;
  } catch {
    return null;
  }
  if (typeof version !== "string" || !version.trim()) {
    return null;
  }
  const wrappers = records.filter((record) => {
    const timestamp = Date.parse(record.finishedAt ?? record.completedAt ?? record.updatedAt ?? "");
    return PEER_RESCUE_AGENT_NAMES.has(record.agentType) && record.companionVersion === version && Number.isFinite(timestamp) && now >= timestamp && now - timestamp <= lookbackMs;
  });
  const deliveries = wrappers.filter((record) => record.failureKind === "delivery").length;
  return wrappers.length >= 20 && deliveries * 4 >= wrappers.length
    ? `wrapper delivery: ${deliveries} of ${wrappers.length} peer wrapper runs on fusion ${version} in the last ${formatLookbackHours(lookbackMs)} hours ended without a delivered report; run /fusion:smoke before more delegated work.`
    : null;
}

function engineCliAvailable(engine, env) {
  const override = env[ENGINE_BIN_OVERRIDES[engine]];
  const binary = typeof override === "string" && override.trim() ? override.trim() : engine === "cursor" ? "cursor-agent" : engine;
  const candidates = binary.includes(path.sep) ? [path.resolve(binary)] : (env.PATH ?? "").split(path.delimiter).map((directory) => path.join(directory || ".", binary));
  return candidates.some((candidate) => {
    try {
      if (!fs.statSync(candidate).isFile()) return false;
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function missingInstalledEngines(env) {
  const configuredHome = typeof env.HOME === "string" ? env.HOME.trim() : "";
  const home = path.isAbsolute(configuredHome) ? configuredHome : os.homedir();
  return ENGINE_IDS.filter((engine) => {
    const cache = path.join(home, ".claude", "plugins", "cache", "claude-code-fusion", engine);
    try {
      if (!fs.statSync(cache).isDirectory()) return false;
    } catch {
      return false;
    }
    return !engineCliAvailable(engine, env);
  });
}

function run(env = process.env, now = Date.now(), write = (text) => process.stdout.write(text)) {
  const records = readEngineHealthRecords(env, now);
  const { lookbackMs, workers: workerRecords } = records;
  const lines = [];
  const hostLines = new Set();
  for (const engine of ["grok", ...ENGINE_IDS.filter((id) => id !== "grok"), ...WORKER_BREAKER_LANES]) {
    const seen = new Set();
    const pools = new Set([null, ...(records.engines.get(engine) ?? []).map((record) => record.billingPool ?? null)]);
    for (const mode of ["consult", "write"]) {
      for (const pool of pools) {
        const health = engineHealth(engine, mode, pool, { env, now, records });
        for (const failure of health.failures) {
          const key = `${failure.scope}:${failure.mode}:${failure.pool}:${failure.failureKind}`;
          if (seen.has(key)) continue;
          seen.add(key);
          lines.push(advisoryLine(engine, failure, now, lookbackMs, failure.pool));
        }
        for (const { kind, modes, message } of health.blockers) {
          hostLines.add(`${ENGINES[engine].displayName} ${modes.join(", ")} runs are blocked on this host (${kind}): ${message}`);
        }
      }
    }
  }
  const deliveryAdvisory = wrapperDeliveryAdvisory(workerRecords, now, lookbackMs);
  if (deliveryAdvisory) {
    lines.push(deliveryAdvisory);
  }
  lines.push(...hostLines);
  const missingEngines = missingInstalledEngines(env);
  if (missingEngines.length) {
    lines.push(`fusion engines unavailable (CLI missing): ${missingEngines.join(", ")}. Skip these lanes.`);
  }
  if (lines.length > 0) {
    write(`${tagMessage("breaker-check.breaker-advisory", lines.join("\n"))}\n`);
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

export { advisoryLine, codexFailureKind, engineCliAvailable, formatAge, run };
