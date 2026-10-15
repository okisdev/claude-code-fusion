import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readQuotaCooldown, resolveDataDir, writeQuotaCooldown } from "../state.mjs";
import { TESTED_VERSION_MIN, TESTED_VERSION_MAX, GROK_VERSION_PROBE_TIMEOUT_MS, DEFAULT_QUOTA_COOLDOWN_MS } from "./config.mjs";
import { output, errorWithFailure, oneLineSummary } from "./base.mjs";
import { SELF_PATH } from "./paths.mjs";

let cachedGrokCompanionVersion;
const grokVersionCache = new Map();

function resolvePluginRoot(env = process.env) {
  if (env.CLAUDE_PLUGIN_ROOT && env.CLAUDE_PLUGIN_ROOT.trim()) {
    return path.resolve(env.CLAUDE_PLUGIN_ROOT.trim());
  }
  return path.resolve(path.dirname(SELF_PATH), "..");
}

function resolveGrokCompanionVersion(env = process.env) {
  if (cachedGrokCompanionVersion !== undefined) {
    return cachedGrokCompanionVersion;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(resolvePluginRoot(env), ".claude-plugin", "plugin.json"), "utf8"));
    cachedGrokCompanionVersion = typeof manifest?.version === "string" ? manifest.version : null;
  } catch {
    cachedGrokCompanionVersion = null;
  }
  return cachedGrokCompanionVersion;
}

function probeGrokVersion(bin, env = process.env) {
  if (grokVersionCache.has(bin)) {
    return grokVersionCache.get(bin);
  }
  const result = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    env,
    timeout: GROK_VERSION_PROBE_TIMEOUT_MS,
    windowsHide: true
  });
  const rawVersion = String(result.stdout || result.stderr || "").trim();
  const match = rawVersion.match(/\b\d+\.\d+\.\d+\b/);
  const probe = {
    available: !result.error && result.status === 0,
    bin,
    spawnErrorCode: result.error?.code ?? null,
    version: match?.[0] ?? null,
    rawVersion: rawVersion || null,
    exitCode: result.status,
    errorMessage: result.error?.message || (result.status !== 0 ? rawVersion || `Grok exited with code ${result.status ?? 1}.` : null)
  };
  grokVersionCache.set(bin, probe);
  return probe;
}

function requireTestedGrokFloor(probe) {
  if (["ENOENT", "EACCES", "ENOEXEC"].includes(probe.spawnErrorCode)) {
    return;
  }
  const version = parseVersion(probe.version);
  if (!version) {
    throw errorWithFailure(`Could not parse grok --version output (${probe.rawVersion || probe.errorMessage || "empty output"}). Run /grok:setup and verify the installed Grok CLI.`, "setup");
  }
  if (!probe.available) {
    throw errorWithFailure(`Could not verify grok --version (${probe.errorMessage || probe.rawVersion || "command failed"}). Run /grok:setup and verify the installed Grok CLI.`, "setup");
  }
  if (compareVersion(version, TESTED_VERSION_MIN) < 0) {
    throw errorWithFailure(`Grok CLI version ${probe.version} is unsupported. Upgrade Grok to version ${TESTED_VERSION_MIN.join(".")} or later.`, "setup");
  }
}

function parseVersion(value) {
  const match = String(value ?? "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersion(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

function testedVersionInterval() {
  return `${TESTED_VERSION_MIN.join(".")} to before ${TESTED_VERSION_MAX.join(".")}`;
}

function supportedVersion(value) {
  const parsed = parseVersion(value);
  return Boolean(parsed) && compareVersion(parsed, TESTED_VERSION_MIN) >= 0;
}

function quotaCooldownMs(env = process.env) {
  const raw = env.GROK_QUOTA_COOLDOWN_MS;
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_QUOTA_COOLDOWN_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_QUOTA_COOLDOWN_MS;
}

function activeQuotaCooldown(dataDir) {
  if (quotaCooldownMs() === 0) return null;
  const cooldown = readQuotaCooldown(dataDir);
  return cooldown && Date.parse(cooldown.expiresAt) > Date.now() ? cooldown : null;
}

function requireQuotaAvailable(dataDir) {
  const cooldown = activeQuotaCooldown(dataDir);
  if (cooldown) {
    throw errorWithFailure(`Grok quota cooldown is active until ${cooldown.expiresAt}, set by job ${cooldown.jobId}: ${cooldown.message}. Run /grok:setup --clear-quota-cooldown to clear it.`, "quota");
  }
}

function recordQuotaCooldown(record, message) {
  const duration = quotaCooldownMs();
  if (duration === 0) return;
  const setAt = new Date();
  writeQuotaCooldown(resolveDataDir(), {
    setAt: setAt.toISOString(),
    expiresAt: new Date(setAt.getTime() + duration).toISOString(),
    jobId: record.id,
    message: oneLineSummary(message).slice(0, 500)
  });
}

export { cachedGrokCompanionVersion, grokVersionCache, resolvePluginRoot, resolveGrokCompanionVersion, probeGrokVersion, requireTestedGrokFloor, parseVersion, compareVersion, testedVersionInterval, supportedVersion, quotaCooldownMs, activeQuotaCooldown, requireQuotaAvailable, recordQuotaCooldown };
