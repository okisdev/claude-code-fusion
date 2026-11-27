#!/usr/bin/env node
import { backgroundWatchReceipt, watchJob } from "./lib/job-watch.mjs";

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";

import { configureRawTransport, createRawCommandTransport as allocateRawCommandTransport, consumeRawCommandTransport, pruneRawCommandTransports, resolveCommandTransport } from "./lib/raw-transport.mjs";
import { awaitOutput } from "./lib/await-output.mjs";
import { resolveTimeoutMs } from "./lib/job-state.mjs";
import { codexHome, latestRolloutRateLimits } from "./lib/codex-rollout.mjs";
import { readAccountRateLimits } from "./lib/codex-rate-limits.mjs";
import { renderFailure } from "./lib/render-footers.mjs";
import { parseArgs, parseRawArgs, parseServiceTier, parseRecordAcceptanceArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  buildReviewArgs,
  buildTaskArgs,
  getCodexAvailability,
  getProcessIdentity,
  isProcessAlive,
  processIdentitiesMatch,
  processIdentityMatches,
  runCodex,
  terminateProcessTree,
  terminateProcessTreeSync
} from "./lib/codex-exec.mjs";
import {
  renderBackgroundLaunch,
  renderCancelReport,
  renderJobDetail,
  renderRunningResult,
  renderSetupReport,
  renderStatusTable,
  renderTerminalResult
} from "./lib/render.mjs";
import {
  SESSION_ID_ENV,
  TERMINAL_STATUSES,
  appendJobLog,
  canonicalWorkspaceRoot,
  createJobRecord,
  findJobRecordById,
  finishJobRecordFile,
  generateJobId,
  jobEventsPath,
  jobFilePath,
  jobLogPath,
  jobsDir,
  listAllJobRecords,
  listJobRecords,
  latestJobRecordForThread,
  markJobCollectedFile,
  nowIso,
  pruneJobState,
  readJobRecordFile,
  readLogTail,
  resolveDataDir,
  updateJobRecordFile,
  updateJobRecordFileWithCurrent,
  withThreadLock,
  withWorkspaceLock,
  writeBrief,
  writeJobRecordFile,
  writePrivateStateFile
} from "./lib/state.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SELF_PATH), "..");
const ADVERSARIAL_REVIEW_PROMPT_FILE = path.join(ROOT_DIR, "prompts", "adversarial-review.md");
const ADVERSARIAL_REVIEW_SCHEMA_FILE = path.join(ROOT_DIR, "schemas", "adversarial-review-verdict.schema.json");
const COMPANION_MANIFEST_FILE = path.join(ROOT_DIR, ".claude-plugin", "plugin.json");
const FOREGROUND_TIMEOUT_ENV = "CODEX_COMPANION_TIMEOUT_MS";
const BACKGROUND_SHELL_TIMEOUT_ENV = "CODEX_COMPANION_BACKGROUND_SHELL_TIMEOUT_MS";
const BACKGROUND_TIMEOUT_ENV = "CODEX_COMPANION_BACKGROUND_TIMEOUT_MS";
const BACKGROUND_DELIVERY_ENV = "CODEX_COMPANION_BACKGROUND_DELIVERY";
const BACKGROUND_LAUNCH_APPROVAL_TIMEOUT_ENV = "CODEX_COMPANION_LAUNCH_APPROVAL_TIMEOUT_MS";
const PIDLESS_GRACE_ENV = "CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS";
const WAIT_POLL_ENV = "CODEX_COMPANION_WAIT_POLL_MS";
const WAIT_TIMEOUT_ENV = "CODEX_COMPANION_WAIT_TIMEOUT_MS";
const DEFAULT_FOREGROUND_TIMEOUT_MS = 570000;
const DEFAULT_BACKGROUND_SHELL_TIMEOUT_MS = 900000;
const DEFAULT_BACKGROUND_TIMEOUT_MS = 1800000;
const DEFAULT_PIDLESS_GRACE_MS = 15000;
const UNVERIFIED_GROUP_RESERVATION_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_WAIT_POLL_MS = 2000;
const DEFAULT_WAIT_TIMEOUT_MS = 570000;
const MAX_WAIT_TIMEOUT_MS = 570000;
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_SCHEMA_BYTES = 256 * 1024;
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_PERSIST_INTERVAL_MS = 30000;
const BACKGROUND_LAUNCH_APPROVAL_TIMEOUT_MS = 10000;
const BACKGROUND_LAUNCH_POLL_MS = 20;
const BACKGROUND_ABORT_CLAIM_WAIT_MS = 2000;
const BACKGROUND_ABORT_CLEANUP_CONFIRM_MS = 1000;
const BACKGROUND_ABORT_CLEANUP_POLL_MS = 50;
const TESTED_VERSION_MIN = [0, 154, 0];
const TESTED_VERSION_MAX = [0, 173, 0];
const CONTINUE_PROMPT = "Continue from the current Codex thread state. Complete the next highest value step and continue until the task is resolved.";
const RESUMABLE_FAILURE_KINDS = new Set(["timeout", "policy", "patch_thrash", "died"]);
const WIND_DOWN_PROMPT = "Wind down: do not start new work. Finish the smallest coherent deliverable from the work already completed and report the files changed and the verification output.";
const JOB_ID_PATTERN = /^[a-f0-9]{32}$/;
const QUOTA_PLAN_COST_CLASS = new Map([
  ["go", "included"],
  ["plus", "included"],
  ["pro", "included"],
  ["prolite", "included"],
  ["promax", "included"],
  ["team", "included"],
  ["business", "included"],
  ["enterprise", "included"],
  ["edu", "included"],
  ["api", "metered"],
  ["usage", "metered"]
]);
const SWIFTPM_SANDBOX_NOTE = "Environment note from the Codex companion: SwiftPM cannot nest its own sandbox-exec inside this sandbox, so run SwiftPM with --disable-sandbox, for example swift build --disable-sandbox and swift test --disable-sandbox.";
let activeCommandArgv = null;
let cachedCompanionVersion = null;
let companionVersionRead = false;

class CompanionError extends Error {
  constructor(message, failureKind = "error") {
    super(message);
    this.failureKind = failureKind;
  }
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs task [--prompt-file <path>] [--output-schema <path>] [--write] [--background] [--resume <thread-id>] [--resume-last] [--fresh] [--model <id>] [--effort <level>] [--service-tier <id|none>] [--web] [--skip-git-repo-check] [--cwd <dir>] [--json] [--] [prompt]",
      "  node scripts/codex-companion.mjs review [--base <ref>] [--scope <auto|working-tree|branch>] [--focus <text>] [--background] [--model <id>] [--effort <level>] [--service-tier <id|none>] [--cwd <dir>] [--json]",
      "  node scripts/codex-companion.mjs adversarial-review [--base <ref>] [--scope <auto|working-tree|branch>] [--focus <text>] [--background] [--model <id>] [--effort <level>] [--cwd <dir>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--cwd <dir>] [--json]",
      "  node scripts/codex-companion.mjs result <job-id> [--wait] [--wait-timeout-ms <ms>] [--cwd <dir>] [--json]",
      "  node scripts/codex-companion.mjs await-output --file <path> [--slice-ms <n>]",
      "  node scripts/codex-companion.mjs wind-down --job <32 lowercase hex>",
      "  node scripts/codex-companion.mjs cancel <job-id> [--cwd <dir>] [--json]",
      "  node scripts/codex-companion.mjs record-acceptance --job-id <32 lowercase hex> --acceptance <accepted|rejected|unverified> [--reason <text>] [--failure-kind <intent_override|scope_rewrite|wrong_approach|style_mismatch>] [--source <collector|main-loop|stats>] [--accept-failed-transport]",
      "  node scripts/codex-companion.mjs history [--json]",
      "  node scripts/codex-companion.mjs watch --job <id>",
      "  node scripts/codex-companion.mjs models [--json]",
      "  node scripts/codex-companion.mjs quota [--json]",
      "  node scripts/codex-companion.mjs setup [--cwd <dir>] [--json]"
    ].join("\n") + "\n"
  );
}

function commandArgs(rawArgv, config) {
  try {
    if (rawArgv.length === 1) {
      return parseRawArgs(rawArgv[0], config);
    }
    return { ...parseArgs(rawArgv, config), positionalText: null };
  } catch (error) {
    throw new CompanionError(error.message, "input");
  }
}

function rejectPersistentEffort(value) {
  if (typeof value === "string" && value.trim().toLowerCase() === "persistent") {
    throw new CompanionError("The persistent reasoning effort switches Codex into its open ended persistent mode, which cannot run inside a bounded companion flight. Choose another effort.", "input");
  }
}

function output(value, asJson = false) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(String(value));
}

function handleModels(argv) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--json")) {
    throw new CompanionError("The models command accepts only --json.", "input");
  }
  const override = process.env.FUSION_CODEX_MODELS_CACHE;
  const filePath = override?.trim() ? path.resolve(override.trim()) : path.join(os.homedir(), ".codex", "models_cache.json");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.models)) {
      throw new Error("Expected a JSON object with a models array.");
    }
  } catch (error) {
    const message = `Could not read Codex models cache ${filePath}: ${error.message}`;
    process.stderr.write(renderFailure(message, "input", argv[0] === "--json"));
    process.exitCode = 1;
    return;
  }
  const models = new Map();
  for (const entry of data.models) {
    const id = typeof entry === "string" ? entry.trim() : entry && typeof entry === "object" && !Array.isArray(entry)
      ? [entry.slug, entry.id].find((value) => typeof value === "string" && value.trim())?.trim()
      : null;
    if (!id) {
      continue;
    }
    const displayName = [entry?.display_name, entry?.displayName, entry?.name].find((value) => typeof value === "string" && value.trim())?.trim() ?? null;
    if (!models.has(id) || (!models.get(id).displayName && displayName)) {
      models.set(id, { id, displayName });
    }
  }
  const listing = [...models.values()];
  output(argv[0] === "--json" ? { engine: "codex", models: listing, source: filePath } : `${listing.map((model) => model.id).join("\n")}${listing.length ? "\n" : ""}`, argv[0] === "--json");
}

function validQuotaPool(pool) {
  if (!pool || typeof pool !== "object" || Array.isArray(pool)) {
    return false;
  }
  const nullable = (value, valid) => value === null || valid(value);
  return typeof pool.pool === "string" && pool.pool.length > 0
    && nullable(pool.costClass, (value) => value === "included" || value === "metered")
    && nullable(pool.usedPercent, (value) => Number.isFinite(value) && value >= 0)
    && nullable(pool.windowMinutes, (value) => Number.isFinite(value) && value > 0)
    && nullable(pool.resetsAt, (value) => typeof value === "string" && Number.isFinite(Date.parse(value)))
    && nullable(pool.pacing, (value) => Number.isFinite(value) && value >= 0);
}

const LIVE_QUOTA_MAX_AGE_MS = 60_000;
const LIVE_QUOTA_REFRESH_LEASE_MS = 30_000;
const LIVE_QUOTA_FAILURE_BACKOFF_MS = 10 * 60_000;

function liveQuotaFile() {
  return path.join(resolveDataDir(), "quota-live.json");
}

function readLiveQuota(home) {
  try {
    const cached = JSON.parse(fs.readFileSync(liveQuotaFile(), "utf8"));
    return cached.home === home && cached.observation?.rateLimits && Number.isFinite(Date.parse(cached.observation.observedAt)) ? cached.observation : null;
  } catch {
    return null;
  }
}

function recentQuotaFile(file, maxAge) {
  return Date.now() - fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs < maxAge;
}

function finishLiveQuotaRefresh(lease, home, observation) {
  const dataDir = path.dirname(lease);
  const failure = path.join(dataDir, "quota-live.failed");
  try {
    if (observation) {
      writePrivateStateFile(liveQuotaFile(), `${JSON.stringify({ home, observation })}\n`);
      fs.rmSync(path.join(dataDir, "quota.json"), { force: true });
      fs.rmSync(failure, { force: true });
    } else {
      writePrivateStateFile(failure, home);
    }
  } finally {
    fs.rmSync(lease, { force: true });
  }
}

function startLiveQuotaRefresh(dataDir, home, live) {
  const lease = path.join(dataDir, "quota-live.refreshing");
  if (recentQuotaFile(lease, LIVE_QUOTA_REFRESH_LEASE_MS)) return true;
  if ((live && Date.now() - Date.parse(live.observedAt) < LIVE_QUOTA_MAX_AGE_MS) || !fs.existsSync(path.join(home, "auth.json"))) return false;
  const failure = path.join(dataDir, "quota-live.failed");
  if (recentQuotaFile(failure, LIVE_QUOTA_FAILURE_BACKOFF_MS) && fs.readFileSync(failure, "utf8") === home) return false;
  const token = generateJobId();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const existing = fs.statSync(lease, { throwIfNoEntry: false });
  if (existing) {
    if (Date.now() - existing.mtimeMs < LIVE_QUOTA_REFRESH_LEASE_MS) return true;
    fs.rmSync(lease, { force: true });
  }
  try {
    fs.writeFileSync(lease, token, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") return recentQuotaFile(lease, LIVE_QUOTA_REFRESH_LEASE_MS);
    throw error;
  }
  try {
    const child = spawn(process.execPath, [SELF_PATH, "quota-refresh", token], { env: process.env, detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    if (child.pid) return true;
  } catch {}
  finishLiveQuotaRefresh(lease, home, null);
  return false;
}

async function handleQuotaRefresh(token) {
  const home = codexHome();
  const lease = path.join(resolveDataDir(), "quota-live.refreshing");
  const observation = await readAccountRateLimits({ bin: process.env.CODEX_BIN?.trim() || "codex" }).catch(() => null);
  const owner = fs.existsSync(lease) ? fs.readFileSync(lease, "utf8") : null;
  if (owner === (token ?? null)) finishLiveQuotaRefresh(lease, home, observation);
}

function handleQuota(argv) {
  const { positionals } = commandArgs(argv, { booleanOptions: ["json"] });
  if (positionals.length) throw new CompanionError("The quota command accepts only --json.", "input");
  const at = Date.now();
  const home = codexHome();
  let file;
  let live;
  let refreshing = false;
  try {
    const dataDir = resolveDataDir();
    file = path.join(dataDir, "quota.json");
    live = readLiveQuota(home);
    refreshing = startLiveQuotaRefresh(dataDir, home, live);
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    if (cached.home === home && Number.isFinite(cached.at) && at >= cached.at && at - cached.at < 60_000 && cached.report?.engine === "codex" && cached.report.refreshing !== true && typeof cached.report.available === "boolean" && Array.isArray(cached.report.pools) && cached.report.pools.every(validQuotaPool)) {
      output(refreshing ? { ...cached.report, refreshing: true } : cached.report, true);
      return;
    }
  } catch {}
  let report = { engine: "codex", available: false, observedAt: new Date(at).toISOString(), pools: [], note: "No rate_limits telemetry found in Codex rollouts." };
  try {
    const rollout = latestRolloutRateLimits();
    const observation = [live, rollout].filter(Boolean).sort((left, right) => (Date.parse(right.observedAt ?? "") || 0) - (Date.parse(left.observedAt ?? "") || 0))[0] ?? null;
    if (observation) {
      const observedAt = observation.observedAt;
      const observedMs = Date.parse(observedAt ?? "");
      const costClass = QUOTA_PLAN_COST_CLASS.get(observation.rateLimits.plan_type) ?? null;
      const pools = [["codex", observation.rateLimits.primary], ["codex-secondary", observation.rateLimits.secondary]]
        .filter(([, window]) => window && typeof window === "object" && !Array.isArray(window))
        .map(([pool, window]) => {
          let usedPercent = Number.isFinite(window.used_percent) && window.used_percent >= 0 ? window.used_percent : null;
          const windowMinutes = Number.isFinite(window.window_minutes) && window.window_minutes > 0 ? window.window_minutes : null;
          const resetMs = Number.isFinite(window.resets_at) && window.resets_at > 0 ? window.resets_at * 1000 : NaN;
          const resetsAt = Number.isFinite(resetMs) && Math.abs(resetMs) <= 8.64e15 ? new Date(resetMs).toISOString() : null;
          if ((Number.isFinite(resetMs) && resetMs <= at) || (windowMinutes !== null && Number.isFinite(observedMs) && at - observedMs > windowMinutes * 60_000)) {
            usedPercent = null;
          }
          const elapsed = windowMinutes && resetsAt && Number.isFinite(observedMs) ? 1 - (resetMs - observedMs) / (windowMinutes * 60_000) : null;
          const pacing = usedPercent !== null && elapsed > 0 && elapsed < 1 ? usedPercent / (100 * elapsed) : null;
          return { pool, costClass, usedPercent, windowMinutes, resetsAt, pacing: Number.isFinite(pacing) ? pacing : null };
        });
      report = { ...report, available: pools.length > 0, observedAt: observedAt ?? report.observedAt, pools, note: pools.length ? null : "Codex rate_limits telemetry has no quota windows." };
    }
  } catch (error) {
    report.note = `Could not read Codex quota telemetry: ${error.message}`;
  }
  try {
    if (file && !refreshing) writePrivateStateFile(file, `${JSON.stringify({ home, at, report })}\n`);
  } catch {}
  if (refreshing) report.refreshing = true;
  output(report, true);
}

function resolveCwd(options = {}) {
  const cwd = path.resolve(process.cwd(), options.cwd ?? ".");
  let stats;
  try {
    stats = fs.statSync(cwd);
  } catch {
    throw new CompanionError(`Working directory does not exist: ${cwd}.`, "input");
  }
  if (!stats.isDirectory()) {
    throw new CompanionError(`Working directory is not a directory: ${cwd}.`, "input");
  }
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

function rejectImplicitSubdirectoryCwd(cwd, options) {
  if (options.cwd != null) {
    return;
  }
  const toplevel = canonicalWorkspaceRoot(cwd);
  if (toplevel !== cwd) {
    throw new CompanionError(`Implicit working directory ${cwd} is inside repository ${toplevel} but is not its root. Pass --cwd ${toplevel} to target the repository root, or pass --cwd ${cwd} to confirm this subdirectory as the sandbox root.`, "input");
  }
}

function hasGitAncestor(cwd) {
  let current = cwd;
  for (;;) {
    try {
      fs.lstatSync(path.join(current, ".git"));
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        return true;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

function taskGitPreflight(cwd, write, skipGitRepoCheck) {
  if (skipGitRepoCheck || hasGitAncestor(cwd)) {
    return Boolean(skipGitRepoCheck);
  }
  if (write) {
    throw new CompanionError("Codex write tasks outside a Git repository require --skip-git-repo-check. Pass --skip-git-repo-check to run this write task.", "input");
  }
  return true;
}

function hasSwiftPackage(cwd) {
  const repositoryRoot = canonicalWorkspaceRoot(cwd);
  for (let directory = cwd;; directory = path.dirname(directory)) {
    try {
      if (fs.statSync(path.join(directory, "Package.swift")).isFile()) {
        return true;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    if (directory === repositoryRoot) {
      return false;
    }
  }
}

function resolveOutputSchemaFile(cwd, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CompanionError("--output-schema requires a non-empty path.", "input");
  }
  const file = path.resolve(cwd, value);
  let stats;
  try {
    stats = fs.statSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new CompanionError(`Output schema file does not exist: ${file}.`, "input");
    }
    throw new CompanionError(`Could not read output schema file ${file}: ${error.message}`, "input");
  }
  if (!stats.isFile()) {
    throw new CompanionError(`Output schema path is not a regular file: ${file}.`, "input");
  }
  if (stats.size > MAX_OUTPUT_SCHEMA_BYTES) {
    throw new CompanionError(`Output schema file exceeds the ${MAX_OUTPUT_SCHEMA_BYTES / 1024} KiB limit: ${file}.`, "input");
  }
  let source;
  try {
    source = fs.readFileSync(file);
  } catch (error) {
    throw new CompanionError(`Could not read output schema file ${file}: ${error.message}`, "input");
  }
  if (source.byteLength > MAX_OUTPUT_SCHEMA_BYTES) {
    throw new CompanionError(`Output schema file exceeds the ${MAX_OUTPUT_SCHEMA_BYTES / 1024} KiB limit: ${file}.`, "input");
  }
  try {
    JSON.parse(source.toString("utf8"));
  } catch {
    throw new CompanionError(`Output schema file must contain valid JSON: ${file}.`, "input");
  }
  return file;
}

function nonnegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new CompanionError(`${label} must be a nonnegative integer.`, "input");
  }
  return number;
}

function resolveExecutionTimeout(background, backgroundShellBudget = false, env = process.env) {
  const name = background ? BACKGROUND_TIMEOUT_ENV : backgroundShellBudget ? BACKGROUND_SHELL_TIMEOUT_ENV : FOREGROUND_TIMEOUT_ENV;
  const fallback = background ? DEFAULT_BACKGROUND_TIMEOUT_MS : backgroundShellBudget ? DEFAULT_BACKGROUND_SHELL_TIMEOUT_MS : DEFAULT_FOREGROUND_TIMEOUT_MS;
  return resolveTimeoutMs(env[name], fallback);
}

function companionVersion() {
  if (companionVersionRead) {
    return cachedCompanionVersion;
  }
  companionVersionRead = true;
  try {
    const manifest = JSON.parse(fs.readFileSync(COMPANION_MANIFEST_FILE, "utf8"));
    cachedCompanionVersion = typeof manifest.version === "string" && manifest.version.trim() ? manifest.version.trim() : null;
  } catch {}
  return cachedCompanionVersion;
}

function backgroundDelivery(env = process.env) {
  return env[BACKGROUND_DELIVERY_ENV] === "managed" ? "managed" : "manual";
}

function resolvePidlessGrace(env = process.env) {
  return resolveTimeoutMs(env[PIDLESS_GRACE_ENV], DEFAULT_PIDLESS_GRACE_MS, 0);
}

function resolveWaitTimeout(options, env = process.env) {
  if (options["wait-timeout-ms"] != null) {
    return Math.min(nonnegativeInteger(options["wait-timeout-ms"], "--wait-timeout-ms"), MAX_WAIT_TIMEOUT_MS);
  }
  return Math.min(resolveTimeoutMs(env[WAIT_TIMEOUT_ENV], DEFAULT_WAIT_TIMEOUT_MS, 0), MAX_WAIT_TIMEOUT_MS);
}

function readStdinIfPiped() {
  if (isatty(0)) {
    return "";
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_PROMPT_BYTES + 1 - total));
      const bytesRead = fs.readSync(0, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
      if (total > MAX_PROMPT_BYTES) {
        throw new CompanionError(`Codex prompt exceeded the ${MAX_PROMPT_BYTES} byte limit.`, "resource");
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch (error) {
    if (error instanceof CompanionError) {
      throw error;
    }
    return "";
  }
}

function readPromptFile(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const buffer = Buffer.alloc(MAX_PROMPT_BYTES + 1);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_PROMPT_BYTES) {
      throw new CompanionError(`Codex prompt exceeded the ${MAX_PROMPT_BYTES} byte limit.`, "resource");
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function boundedPrompt(value) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text) > MAX_PROMPT_BYTES) {
    throw new CompanionError(`Codex prompt exceeded the ${MAX_PROMPT_BYTES} byte limit.`, "resource");
  }
  return text;
}

configureRawTransport({
  engineName: "codex",
  sessionIdEnv: SESSION_ID_ENV,
  makeError: (message, kind) => new CompanionError(message, kind),
  maxRawArgumentBytes: MAX_PROMPT_BYTES + 64 * 1024,
  cleanupOnSessionMismatch: true,
  allowBackgroundDefault: false,
  allowStdin: true
});

function createRawCommandTransport() {
  output(allocateRawCommandTransport(), true);
}

function readTaskPrompt(cwd, options, positionals, positionalText) {
  const positional = positionalText ?? positionals.join(" ").trim();
  const hasPositional = Boolean(positional.trim());
  if (hasPositional && options["prompt-file"]) {
    throw new CompanionError("Use prompt text or --prompt-file, not both.", "input");
  }
  if (hasPositional) {
    return boundedPrompt(positional);
  }
  if (options["prompt-file"]) {
    const file = path.resolve(cwd, options["prompt-file"]);
    try {
      return readPromptFile(file);
    } catch (error) {
      if (error instanceof CompanionError) {
        throw error;
      }
      throw new CompanionError(`Could not read prompt file ${file}: ${error.message}`, "input");
    }
  }
  return readStdinIfPiped();
}

export function parseTaskHeader(prompt) {
  const line = String(prompt ?? "").split(/\r?\n/).find((candidate) => candidate.trim() && candidate !== SWIFTPM_SANDBOX_NOTE);
  if (!line || !line.includes("|")) {
    return { headerModel: null, headerEffort: null };
  }
  let headerModel = null;
  let headerEffort = null;
  for (const segment of line.split("|")) {
    const model = segment.match(/^\s*model\s*:\s*(\S+)\s*$/i);
    if (model && !headerModel) {
      headerModel = model[1];
      continue;
    }
    const effort = segment.match(/^\s*effort\s*:\s*(\S+)\s*$/i);
    if (effort && !headerEffort) {
      headerEffort = effort[1];
    }
  }
  return { headerModel, headerEffort };
}

function taskModelDrift(record, prompt, resolvedModel) {
  const requestedModel = record.request?.model;
  if (typeof requestedModel === "string" && requestedModel.trim() && typeof resolvedModel === "string" && resolvedModel.trim() && requestedModel.trim() !== resolvedModel.trim()) {
    return { requestedModel, resolvedModel };
  }
  if (record.jobClass !== "task" || requestedModel != null || typeof resolvedModel !== "string" || !resolvedModel.trim()) {
    return null;
  }
  const { headerModel, headerEffort } = parseTaskHeader(prompt);
  if (!headerModel || headerModel === resolvedModel) {
    return null;
  }
  return { headerModel, headerEffort, resolvedModel };
}

function currentClaudeSessionId() {
  const value = process.env[SESSION_ID_ENV];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function oneLine(value, fallback) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? fallback;
}

function boundedTail(value, maxLines = 20) {
  return String(value ?? "")
    .slice(-64 * 1024)
    .trimEnd()
    .split(/\r?\n/)
    .slice(-maxLines)
    .join("\n");
}

function redactDiagnostic(value) {
  return String(value ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@")
    .replace(/\b(api[_-]?key|access[_-]?token|authorization|password|passwd|secret|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,})\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9+/_=-]{64,}\b/g, "[redacted]");
}

function availabilityFailure(probe) {
  const missing = probe.exitCode == null && /ENOENT|not found|no such file/i.test(probe.errorMessage ?? "");
  return new CompanionError(probe.errorMessage || "The Codex CLI is unavailable.", missing ? "missing_cli" : "error");
}

function preflightCodex(cwd) {
  const probe = getCodexAvailability({ cwd, env: process.env });
  if (!probe.available) {
    throw availabilityFailure(probe);
  }
  const version = parseVersion(probe.version);
  if (version && compareVersion(version, TESTED_VERSION_MIN) < 0) {
    throw new CompanionError(`Codex CLI version ${probe.version} is unsupported. Upgrade the Codex CLI to version ${TESTED_VERSION_MIN.join(".")} or later.`, "setup");
  }
  return probe;
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
  return Boolean(parsed) && compareVersion(parsed, TESTED_VERSION_MIN) >= 0 && compareVersion(parsed, TESTED_VERSION_MAX) < 0;
}

function findRequestedJob(dataDir, jobId, options) {
  if (options.cwd == null) {
    return findJobRecordById(dataDir, jobId);
  }
  const cwd = resolveCwd(options);
  const file = jobFilePath(dataDir, cwd, jobId);
  const record = readJobRecordFile(file);
  return record?.id === jobId ? { record, file } : null;
}

function terminalRecord(record) {
  return TERMINAL_STATUSES.has(record?.status);
}

function elapsedSince(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? Date.now() - timestamp : Number.POSITIVE_INFINITY;
}

function deadOwnerMessage(record) {
  const pids = [record.pid, record.codexPid].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (pids.length === 0) {
    return "No process id was recorded before the launch grace window elapsed.";
  }
  return `Recorded process ${pids.join(", ")} exited without recording a terminal outcome.`;
}

function recordedProcessState(record, prefix) {
  const codex = prefix === "codex";
  const pid = record[codex ? "codexPid" : "pid"];
  const identity = record[codex ? "codexPidIdentity" : "pidIdentity"];
  const identitySettled = codex ? Boolean(record.codexPidIdentitySettled) : true;
  const ownsProcessGroup = Boolean(record[codex ? "codexPidOwnsProcessGroup" : "pidOwnsProcessGroup"]);
  if (!Number.isInteger(pid) || pid <= 1) {
    return { identity, ownsProcessGroup, pid, state: "absent" };
  }
  const currentIdentity = getProcessIdentity(pid);
  if (currentIdentity) {
    if (!identity) {
      return { identity, ownsProcessGroup, pid, state: "unverified" };
    }
    if (processIdentitiesMatch(currentIdentity, identity)) {
      return { identity, ownsProcessGroup, pid, state: "owned" };
    }
    return { identity, ownsProcessGroup, pid, state: identitySettled ? "replaced" : "unverified" };
  }
  if (isProcessAlive(pid, null, ownsProcessGroup)) {
    return { identity, ownsProcessGroup, pid, state: "unverified" };
  }
  return { identity, ownsProcessGroup, pid, state: "absent" };
}

function cleanupComplete(record) {
  return [recordedProcessState(record, "owner"), recordedProcessState(record, "codex")].every(({ state }) => state === "absent" || state === "replaced");
}

export function runningRecordNeedsReconciliation(record, env = process.env) {
  if (record?.status !== "running") {
    return false;
  }
  const owner = recordedProcessState(record, "owner");
  return (owner.state === "absent" || owner.state === "replaced") && elapsedSince(record.createdAt) > resolvePidlessGrace(env);
}

function codexSpawnCheckpointPending(record) {
  return Boolean(record?.background && record.startedAt && !record.codexPidIdentitySettled);
}

const SPAWN_CHECKPOINT_SETTLE_TIMEOUT_MS = 1000;
const SPAWN_CHECKPOINT_SETTLE_POLL_MS = 25;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function awaitCodexSpawnCheckpointSettledSync(file, record) {
  const deadline = Date.now() + SPAWN_CHECKPOINT_SETTLE_TIMEOUT_MS;
  let current = record;
  while (codexSpawnCheckpointPending(current) && current.status === "running" && Date.now() < deadline) {
    sleepSync(SPAWN_CHECKPOINT_SETTLE_POLL_MS);
    current = readJobRecordFile(file) ?? current;
  }
  return current;
}

async function awaitCodexSpawnCheckpointSettled(file, record) {
  const deadline = Date.now() + SPAWN_CHECKPOINT_SETTLE_TIMEOUT_MS;
  let current = record;
  while (codexSpawnCheckpointPending(current) && current.status === "running" && Date.now() < deadline) {
    await delay(SPAWN_CHECKPOINT_SETTLE_POLL_MS);
    current = readJobRecordFile(file) ?? current;
  }
  return current;
}

function signalRecorded(record, prefix) {
  const target = recordedProcessState(record, prefix);
  if (target.state !== "owned" || !target.identity) {
    return false;
  }
  try {
    process.kill(process.platform !== "win32" && target.ownsProcessGroup ? -target.pid : target.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function deadOwnerPatch(record) {
  const message = deadOwnerMessage(record);
  const recorded = RESUMABLE_FAILURE_KINDS.has(record.failureKind) ? record.failureKind : null;
  if (!recorded) {
    return { status: "error", failureKind: "died", errorMessage: message, errorTail: message };
  }
  return {
    status: "error",
    failureKind: recorded,
    errorMessage: record.errorMessage ?? message,
    errorTail: record.errorTail ?? message
  };
}

function repairNow(env = process.env) {
  const override = Number(env.CODEX_COMPANION_TEST_NOW_MS);
  return env.CODEX_COMPANION_TEST_NOW_MS && Number.isFinite(override) && override >= 0 ? override : Date.now();
}

function staleUnverifiedGroup(record, env = process.env) {
  if (record.status !== "running" || record.phase !== "cleanup-required") {
    return null;
  }
  const since = Date.parse(record.cleanupRequiredAt ?? "");
  if (!Number.isFinite(since) || repairNow(env) - since < UNVERIFIED_GROUP_RESERVATION_GRACE_MS) {
    return null;
  }
  if (recordedProcessState(record, "owner").state === "owned") {
    return null;
  }
  for (const prefix of ["codex", "owner"]) {
    const target = recordedProcessState(record, prefix);
    if (target.ownsProcessGroup && target.state === "unverified" &&
      !isProcessAlive(target.pid, null, false) && isProcessAlive(target.pid, null, true)) {
      return target.pid;
    }
  }
  return null;
}

function orphanCleanupWarning(record, groupId) {
  return `stale Codex job ${record.id} left unverified process group ${groupId}; inspect the group manually and terminate it only after verifying ownership. No signal was sent.`;
}

function cleanupRequired(file, failureKind, message, env = process.env) {
  const record = updateJobRecordFileWithCurrent(file, (current) => ({
    cleanupRequiredAt: Number.isFinite(Date.parse(current.cleanupRequiredAt ?? ""))
      ? current.cleanupRequiredAt : new Date(repairNow(env)).toISOString(),
    errorMessage: message,
    errorTail: message,
    failureKind,
    phase: "cleanup-required"
  }));
  const groupId = staleUnverifiedGroup(record, env);
  return groupId === null ? record : updateJobRecordFile(file, { orphanCleanupWarning: orphanCleanupWarning(record, groupId) });
}

function terminateRecordedSync(record, prefix, graceMs = 250) {
  const target = recordedProcessState(record, prefix);
  if (target.state === "absent" || target.state === "replaced") {
    return true;
  }
  if (target.state !== "owned" || !target.identity) {
    return false;
  }
  return terminateProcessTreeSync(target.pid, {
    graceMs,
    identity: target.identity,
    ownsProcessGroup: target.ownsProcessGroup,
    requireIdentity: true
  });
}

async function terminateRecorded(record, prefix, graceMs = 250) {
  const target = recordedProcessState(record, prefix);
  if (target.state === "absent" || target.state === "replaced") {
    return true;
  }
  if (target.state !== "owned" || !target.identity) {
    return false;
  }
  return terminateProcessTree(target.pid, {
    graceMs,
    identity: target.identity,
    ownsProcessGroup: target.ownsProcessGroup,
    requireIdentity: true
  });
}

function currentProcessIdentity() {
  const identity = getProcessIdentity(process.pid);
  if (!identity) {
    throw new CompanionError("The companion process identity could not be verified.", "process");
  }
  return identity;
}

function shellArgument(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function timeoutResumeCommand(record, threadId) {
  return `${shellArgument(process.execPath)} ${shellArgument(SELF_PATH)} task --resume ${shellArgument(threadId)} --cwd ${shellArgument(record.cwd)}${record.mode === "write" ? " --write" : ""}`;
}

function appendResumeFooter(text, footer) {
  const value = typeof text === "string" ? text.trimEnd() : "";
  return value.split("\n").includes(footer) ? value : value ? `${value}\n\n${footer}` : footer;
}

function resumableFailurePatch(record, patch) {
  const next = { ...record, ...patch };
  const failureKind = next.failureKind;
  const threadId = next.threadId ?? next.request?.resumeThreadId;
  if (!RESUMABLE_FAILURE_KINDS.has(failureKind) || typeof threadId !== "string" || !threadId.trim()) {
    return patch;
  }
  const resumeCommand = timeoutResumeCommand(next, threadId);
  const footer = `Resume Codex job ${next.id}: ${resumeCommand}`;
  const resultText = Object.hasOwn(patch, "resultText") ? patch.resultText : record.resultText;
  const partialResultText = Object.hasOwn(patch, "partialResultText") ? patch.partialResultText : record.partialResultText;
  if (typeof resultText === "string" && resultText.trim()) {
    return { ...patch, resumable: true, resumeCommand, resultText: appendResumeFooter(resultText, footer) };
  }
  return { ...patch, resumable: true, resumeCommand, partialResultText: appendResumeFooter(partialResultText, footer) };
}

function finishJob(file, patch, env = process.env) {
  const existing = readJobRecordFile(file);
  const record = finishJobRecordFile(file, existing ? resumableFailurePatch(existing, patch) : patch);
  pruneJobState(resolveDataDir(env), { claudeSessionId: record.claudeSessionId, protectedJobFiles: [file], resumeWorkspaceJobFiles: [file] });
  return record;
}

function collectRenderedJob(file, record) {
  if (!TERMINAL_STATUSES.has(record.status)) {
    return record;
  }
  let collected;
  try {
    collected = markJobCollectedFile(file);
  } catch {
    return record;
  }
  pruneJobState(resolveDataDir(), { claudeSessionId: collected.claudeSessionId, resumeWorkspaceJobFiles: [file] });
  return collected;
}

export function repairRunningRecordSync({ record, file }, env = process.env) {
  let current = readJobRecordFile(file) ?? record;
  if (current.status !== "running") {
    return current;
  }
  current = awaitCodexSpawnCheckpointSettledSync(file, current);
  const deadline = Date.parse(current.deadlineAt ?? "");
  if (Number.isFinite(deadline) && Date.now() > deadline) {
    if (codexSpawnCheckpointPending(current)) {
      signalRecorded(current, "owner");
      return cleanupRequired(file, "timeout", "Codex exceeded its recorded execution deadline while its process identity checkpoint was incomplete. Graceful cleanup was requested without forcing the companion to exit.", env);
    }
    terminateRecordedSync(current, "codex");
    terminateRecordedSync(current, "owner");
    const refreshed = readJobRecordFile(file) ?? current;
    if (!cleanupComplete(refreshed)) {
      return cleanupRequired(file, "timeout", "Codex exceeded its recorded execution deadline, but verified process cleanup did not complete.", env);
    }
    return finishJob(file, {
      status: "error",
      failureKind: "timeout",
      errorMessage: "Codex exceeded its recorded execution deadline.",
      errorTail: "Codex exceeded its recorded execution deadline."
    });
  }
  const owner = recordedProcessState(current, "owner");
  if (owner.state === "owned") {
    return current;
  }
  if (elapsedSince(current.createdAt) <= resolvePidlessGrace(env)) {
    return current;
  }
  if (owner.state === "unverified") {
    return cleanupRequired(file, "process", "The recorded companion process is live but its identity cannot be verified. No signal was sent.", env);
  }
  if (codexSpawnCheckpointPending(current)) {
    return cleanupRequired(file, "process", "The companion exited while the Codex process identity checkpoint was incomplete. No terminal state was recorded.", env);
  }
  terminateRecordedSync(current, "owner");
  terminateRecordedSync(current, "codex");
  const refreshed = readJobRecordFile(file) ?? current;
  if (!cleanupComplete(refreshed)) {
    return cleanupRequired(file, "died", "The companion exited without a terminal outcome, but verified process cleanup did not complete.", env);
  }
  return finishJob(file, deadOwnerPatch(current));
}

export async function refreshRunningJobRecord(found, env = process.env) {
  let current = readJobRecordFile(found.file) ?? found.record;
  if (current.status !== "running") {
    return current;
  }
  current = await awaitCodexSpawnCheckpointSettled(found.file, current);
  const deadline = Date.parse(current.deadlineAt ?? "");
  if (Number.isFinite(deadline) && Date.now() > deadline) {
    if (codexSpawnCheckpointPending(current)) {
      signalRecorded(current, "owner");
      return cleanupRequired(found.file, "timeout", "Codex exceeded its recorded execution deadline while its process identity checkpoint was incomplete. Graceful cleanup was requested without forcing the companion to exit.", env);
    }
    await Promise.all([terminateRecorded(current, "codex"), terminateRecorded(current, "owner")]);
    const refreshed = readJobRecordFile(found.file) ?? current;
    if (!cleanupComplete(refreshed)) {
      return cleanupRequired(found.file, "timeout", "Codex exceeded its recorded execution deadline, but verified process cleanup did not complete.", env);
    }
    return finishJob(found.file, {
      status: "error",
      failureKind: "timeout",
      errorMessage: "Codex exceeded its recorded execution deadline.",
      errorTail: "Codex exceeded its recorded execution deadline."
    });
  }
  const owner = recordedProcessState(current, "owner");
  if (owner.state === "owned") {
    return current;
  }
  if (elapsedSince(current.createdAt) <= resolvePidlessGrace(env)) {
    return current;
  }
  if (owner.state === "unverified") {
    return cleanupRequired(found.file, "process", "The recorded companion process is live but its identity cannot be verified. No signal was sent.", env);
  }
  if (codexSpawnCheckpointPending(current)) {
    return cleanupRequired(found.file, "process", "The companion exited while the Codex process identity checkpoint was incomplete. No terminal state was recorded.", env);
  }
  await Promise.all([terminateRecorded(current, "owner"), terminateRecorded(current, "codex")]);
  const refreshed = readJobRecordFile(found.file) ?? current;
  if (!cleanupComplete(refreshed)) {
    return cleanupRequired(found.file, "died", "The companion exited without a terminal outcome, but verified process cleanup did not complete.", env);
  }
  return finishJob(found.file, deadOwnerPatch(current));
}

function latestResumeRecord(dataDir, cwd, claudeSessionId) {
  let candidates = listJobRecords(dataDir, cwd).filter(
    (record) => terminalRecord(record) && record.jobClass === "task" && typeof record.threadId === "string" && record.threadId.trim()
  );
  if (claudeSessionId) {
    candidates = candidates.filter((record) => record.claudeSessionId === claudeSessionId);
  }
  if (candidates.length === 0) {
    throw new CompanionError("No eligible finished Codex task thread was found for this workspace and Claude session.", "input");
  }
  return candidates[0];
}

function resolveResume(dataDir, cwd, options) {
  if (options.resume && options["resume-last"]) {
    throw new CompanionError("Use either --resume or --resume-last, not both.", "input");
  }
  if (options.fresh && (options.resume || options["resume-last"])) {
    throw new CompanionError("--fresh cannot be combined with --resume or --resume-last.", "input");
  }
  if (options.fresh) {
    return { threadId: null, baseline: null, sourceJobId: null };
  }
  let threadId = options.resume ?? null;
  let sourceJobId = null;
  if (options["resume-last"]) {
    const candidate = latestResumeRecord(dataDir, cwd, currentClaudeSessionId());
    threadId = candidate.threadId;
    sourceJobId = candidate.id;
  } else if (threadId) {
    sourceJobId = latestJobRecordForThread(dataDir, threadId, cwd)?.id ?? null;
  }
  return {
    threadId,
    sourceJobId
  };
}

function inheritedRouting(record, options, defaultServiceTier) {
  const source = record?.request && typeof record.request === "object" && !Array.isArray(record.request) ? record.request : {};
  const explicitModel = Object.hasOwn(options, "model");
  const explicitEffort = Object.hasOwn(options, "effort");
  const explicitServiceTier = Object.hasOwn(options, "service-tier");
  let model = explicitModel ? options.model : null;
  let effort = explicitEffort ? options.effort : null;
  let serviceTier = defaultServiceTier;
  let inherited = false;

  const sourceModel = typeof source.model === "string" && source.model.trim() ? source.model : record?.resolvedModel;
  if (!explicitModel && typeof sourceModel === "string" && sourceModel.trim()) {
    model = sourceModel;
    inherited = true;
  }
  const sourceEffort = typeof source.effort === "string" && source.effort.trim() ? source.effort : record?.resolvedEffort;
  if (!explicitEffort && typeof sourceEffort === "string" && sourceEffort.trim()) {
    effort = sourceEffort;
    inherited = true;
  }
  if (!explicitServiceTier && Object.hasOwn(source, "serviceTier")) {
    serviceTier = source.serviceTier === null ? null : parseServiceTier(source.serviceTier);
    inherited = true;
  }
  return { effort, inherited, model, serviceTier };
}

function reserveWorkspaceJob({ background, brief, codexVersion, companionVersion, cwd, dataDir, diagnostics, jobClass, mode, timeoutMs }, reservedRequest, ownerIdentity) {
  return withWorkspaceLock(dataDir, cwd, () => {
    const windDownOf = reservedRequest.ingress?.startsWith("wind-down:") ? reservedRequest.ingress.slice("wind-down:".length) : null;
    const source = windDownOf ? findRequestedJob(dataDir, windDownOf, {}) : null;
    if (windDownOf && (!source || source.record.status !== "error" || !RESUMABLE_FAILURE_KINDS.has(source.record.failureKind)
      || !source.record.threadId || source.record.threadId !== reservedRequest.resumeThreadId || source.record.windDownJobId)) {
      throw new CompanionError(`Codex job ${windDownOf} is not eligible for wind-down.`, "input");
    }
    const records = listJobRecords(dataDir, cwd).map((record) => {
      const file = jobFilePath(dataDir, cwd, record.id);
      return repairRunningRecordSync({ record, file });
    });
    const checked = records.map((record) => ({ record, groupId: staleUnverifiedGroup(record) }));
    const staleGroups = checked.filter(({ groupId }) => groupId !== null);
    const running = checked.find(({ record, groupId }) => record.status === "running" && groupId === null)?.record;
    if (running) {
      throw new CompanionError(`Codex job ${running.id} is already running in this workspace.`, "input");
    }
    const id = generateJobId();
    const briefFile = writeBrief(dataDir, cwd, id, brief);
    const record = { ...createJobRecord({
      id,
      background,
      briefFile,
      claudeSessionId: currentClaudeSessionId(),
      codexVersion,
      companionVersion,
      cwd,
      delivery: background ? backgroundDelivery() : "foreground",
      diagnostics,
      eventsFile: jobEventsPath(dataDir, cwd, id),
      jobClass,
      kind: jobClass,
      logFile: jobLogPath(dataDir, cwd, id),
      mode,
      phase: background ? "queued" : "starting",
      pid: background ? null : process.pid,
      pidIdentity: ownerIdentity,
      pidOwnsProcessGroup: false,
      request: source ? { ...reservedRequest, resumeSourceJobId: windDownOf } : reservedRequest,
      timeoutMs,
      workspaceRoot: canonicalWorkspaceRoot(cwd)
    }), ...(windDownOf ? { windDownOf } : {}), ...(staleGroups.length ? {
      orphanCleanupWarning: staleGroups.map(({ record: entry, groupId }) => orphanCleanupWarning(entry, groupId)).join(" ")
    } : {}) };
    const file = jobFilePath(dataDir, cwd, id);
    writeJobRecordFile(file, record);
    if (source) {
      try {
        updateJobRecordFileWithCurrent(source.file, (current) => {
          if (current.windDownJobId || current.status !== "error") {
            throw new CompanionError(`Codex job ${windDownOf} was already wound down.`, "input");
          }
          return { windDownJobId: id };
        }, { allowTerminal: true });
      } catch (error) {
        fs.rmSync(file, { force: true });
        fs.rmSync(briefFile, { force: true });
        throw error;
      }
    }
    return { record, file };
  });
}

function createReservedJob({ background, brief, codexVersion, companionVersion, cwd, dataDir, diagnostics = [], jobClass, mode, request, timeoutMs }) {
  brief = boundedPrompt(brief);
  const ownerIdentity = background ? null : currentProcessIdentity();
  const reservation = { background, brief, codexVersion, companionVersion, cwd, dataDir, diagnostics, jobClass, mode, timeoutMs };
  const threadId = request.resumeThreadId;
  if (!threadId) {
    return reserveWorkspaceJob(reservation, request, ownerIdentity);
  }
  return withThreadLock(dataDir, threadId, () => {
    const entries = listAllJobRecords(dataDir);
    for (const entry of entries) {
      if (entry.record.status === "running" && (entry.record.threadId === threadId || entry.record.request?.resumeThreadId === threadId)) {
        entry.record = repairRunningRecordSync(entry);
      }
    }
    const running = entries.find(
      ({ record }) => record.status === "running" && !staleUnverifiedGroup(record) && (record.threadId === threadId || record.request?.resumeThreadId === threadId)
    );
    if (running) {
      const current = repairRunningRecordSync({ file: running.file, record: readJobRecordFile(running.file) ?? running.record });
      if (current.status === "running" && !staleUnverifiedGroup(current)) {
        throw new CompanionError(`Codex thread ${threadId} is already running in job ${current.id}.`, "input");
      }
    }
    return reserveWorkspaceJob(reservation, request, ownerIdentity);
  });
}

function executionArgs(record) {
  const request = record.request ?? {};
  const common = {
    cwd: record.cwd,
    effort: request.effort,
    model: request.model,
    serviceTier: request.serviceTier,
    network: Boolean(request.network),
    skipGitRepoCheck: request.transport === "task" ? taskGitPreflight(record.cwd, request.write === true, Boolean(request.skipGitRepoCheck)) : Boolean(request.skipGitRepoCheck),
    web: Boolean(request.web)
  };
  if (request.transport === "native-review") {
    return buildReviewArgs({
      ...common,
      base: request.base ?? undefined,
      uncommitted: request.uncommitted === true
    });
  }
  return buildTaskArgs({
    ...common,
    outputSchemaFile: request.outputSchemaFile ?? undefined,
    resumeThreadId: request.resumeThreadId ?? undefined,
    write: request.write === true
  });
}

function validateExecutionRequest(cwd, request) {
  try {
    executionArgs({ cwd, request });
  } catch (error) {
    throw new CompanionError(error.message, "input");
  }
}

function failureKindForError(error) {
  if (error?.failureKind) {
    return error.failureKind;
  }
  if (error?.code === "ENOENT") {
    return "missing_cli";
  }
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return "permission";
  }
  return "error";
}

function semanticOutcome(outcome) {
  if (outcome.policyViolation) {
    return {
      semanticFailureKind: "policy",
      semanticFailureMessage: redactDiagnostic(outcome.policyViolation),
      semanticStatus: "rejected"
    };
  }
  return { semanticFailureKind: null, semanticFailureMessage: null, semanticStatus: "unverified" };
}

function structuredOutputOutcome(request, outcome) {
  if (!request.outputSchemaFile || outcome.resultSource !== "agent_message" || typeof outcome.finalResponse !== "string") {
    return {};
  }
  try {
    return { structuredOutput: JSON.parse(outcome.finalResponse), structuredOutputError: null };
  } catch (error) {
    return {
      structuredOutput: null,
      structuredOutputError: `Codex final response is not valid JSON: ${oneLine(error.message, "JSON parsing failed.")}`
    };
  }
}

function finishExecutionFailure(file, record, error, env = process.env) {
  const rawMessage = oneLine(error?.message ?? error, "Codex companion execution failed.");
  appendJobLog(record.logFile, rawMessage);
  const message = redactDiagnostic(rawMessage);
  return finishJob(file, {
    status: "error",
    failureKind: failureKindForError(error),
    errorMessage: message,
    errorTail: redactDiagnostic(readLogTail(record.logFile, 20) || message)
  }, env);
}

export function createHeartbeatTick(file, cancellation, {
  now = Date.now,
  read = readJobRecordFile,
  update = updateJobRecordFile
} = {}) {
  let lastPersistedAtMs = now();
  return () => {
    const current = read(file);
    const timeMs = now();
    const heartbeatAt = new Date(timeMs).toISOString();
    if (current?.cancelRequestedAt) {
      cancellation.abort();
    }
    if (current?.status !== "running" || timeMs - lastPersistedAtMs < HEARTBEAT_PERSIST_INTERVAL_MS) {
      return heartbeatAt;
    }
    update(file, { heartbeatAt });
    lastPersistedAtMs = timeMs;
    return heartbeatAt;
  };
}

async function executeRecord(found) {
  let record = readJobRecordFile(found.file) ?? found.record;
  if (record.status !== "running") {
    return record;
  }
  if (record.background && (!record.launchApprovedAt || record.launchAbortRequestedAt)) {
    return finishExecutionFailure(found.file, record, new CompanionError("The background worker did not receive launch approval.", "process"));
  }
  if (!record.request || typeof record.request !== "object" || !Object.hasOwn(record.request, "serviceTier")) {
    return finishExecutionFailure(found.file, record, new CompanionError("The Codex job request is unavailable.", "process"));
  }
  let ownerIdentity;
  try {
    ownerIdentity = currentProcessIdentity();
  } catch (error) {
    return finishExecutionFailure(found.file, record, error);
  }
  const timeoutMs = resolveExecutionTimeout(record.background, record.request.backgroundShellBudget);
  const startedAt = record.startedAt ?? nowIso();
  const serviceTier = record.request.serviceTier;
  record = updateJobRecordFile(found.file, {
    deadlineAt: new Date(record.request.backgroundShellBudget ? found.foregroundDeadlineMs : Date.now() + timeoutMs).toISOString(),
    heartbeatAt: nowIso(),
    phase: record.background ? "codex-spawning" : "executing",
    serviceTier,
    timeoutMs,
    pid: process.pid,
    pidIdentity: ownerIdentity,
    pidOwnsProcessGroup: record.background && process.platform !== "win32",
    startedAt
  });
  let checkpointedThreadId = record.threadId;
  const cancellation = new AbortController();
  const tickHeartbeat = createHeartbeatTick(found.file, cancellation);
  const heartbeat = setInterval(() => {
    try {
      record.heartbeatAt = tickHeartbeat();
    } catch {}
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  try {
    const prompt = record.request?.transport === "native-review" ? "" : readPromptFile(record.briefFile);
    const args = executionArgs(record);
    const windDownSourceUsage = record.windDownOf
      ? readJobRecordFile(jobFilePath(resolveDataDir(), record.cwd, record.windDownOf))?.cumulativeTokenUsage
      : null;
    const outcome = await runCodex({
      args,
      cwd: record.cwd,
      env: process.env,
      eventsFile: record.eventsFile,
      freshThread: !record.request?.resumeThreadId,
      logFile: record.logFile,
      onCheckpoint: (checkpoint) => {
        const patch = {};
        if (checkpoint.threadId && checkpoint.threadId !== checkpointedThreadId) {
          checkpointedThreadId = checkpoint.threadId;
          patch.threadId = checkpoint.threadId;
        }
        if (Object.keys(patch).length > 0) {
          updateJobRecordFile(found.file, { heartbeatAt: nowIso(), ...patch });
        }
      },
      onSpawnAttempt: (pid) => {
        updateJobRecordFile(found.file, {
          codexPid: pid,
          codexPidIdentity: null,
          codexPidIdentitySettled: false,
          codexPidOwnsProcessGroup: process.platform !== "win32",
          heartbeatAt: nowIso(),
          phase: "codex-spawning"
        });
      },
      onSpawn: (pid, identity) => {
        updateJobRecordFile(found.file, {
          codexPid: pid,
          codexPidIdentity: identity,
          codexPidIdentitySettled: false,
          codexPidOwnsProcessGroup: process.platform !== "win32",
          heartbeatAt: nowIso(),
          phase: "executing"
        });
      },
      onIdentitySettled: (pid, identity) => {
        updateJobRecordFile(found.file, {
          codexPid: pid,
          codexPidIdentity: identity,
          codexPidIdentitySettled: true,
          codexPidOwnsProcessGroup: process.platform !== "win32"
        });
      },
      prompt,
      resumeThreadId: record.request?.resumeThreadId ?? undefined,
      signal: cancellation.signal,
      deadlineMs: found.foregroundDeadlineMs,
      timeoutMs,
      windDownSourceUsage
    });
    if (!outcome.cleanupComplete) {
      const message = outcome.errorMessage || "Codex process cleanup did not complete. The verified process identifiers were retained for retry.";
      appendJobLog(record.logFile, message);
      return cleanupRequired(found.file, outcome.failureKind ?? "process", message);
    }
    const errorTail = redactDiagnostic(readLogTail(record.logFile, 20) || boundedTail(outcome.stderrTail));
    const semantic = semanticOutcome(outcome);
    const structured = structuredOutputOutcome(record.request ?? {}, outcome);
    const resolvedModel = outcome.resolvedModel ?? record.resolvedModel;
    const modelDrift = taskModelDrift(record, prompt, resolvedModel);
    const diagnostics = [...record.diagnostics, ...outcome.diagnostics.map((diagnostic) => ({ ...diagnostic, message: redactDiagnostic(diagnostic.message) }))];
    const executionErrorMessage = record.request.backgroundShellBudget && outcome.failureKind === "timeout" ? `Codex timed out after ${timeoutMs}ms.` : outcome.errorMessage;
    return finishJob(found.file, {
      cumulativeTokenUsage: outcome.cumulativeTokenUsage,
      diagnostics,
      errorMessage: executionErrorMessage ? redactDiagnostic(executionErrorMessage) : null,
      errorTail: outcome.status === "done" ? null : errorTail || executionErrorMessage,
      eventsTruncated: outcome.eventsTruncated,
      exitCode: outcome.exitCode,
      fileChangeCount: outcome.fileChangeCount,
      failureKind: outcome.failureKind,
      protocolError: outcome.protocolError ? redactDiagnostic(outcome.protocolError) : null,
      partialResultText: outcome.partialResultText ? redactDiagnostic(outcome.partialResultText) : null,
      resolvedEffort: outcome.resolvedEffort ?? record.resolvedEffort,
      resolvedModel,
      ...(modelDrift ? { modelDrift } : {}),
      rolloutRecoveryStatus: outcome.rolloutRecoveryStatus,
      result: {
        eventCount: outcome.eventCount,
        signal: outcome.signal,
        terminalEvent: outcome.terminalEvent,
        timedOut: outcome.timedOut
      },
      resultSource: outcome.resultSource,
      resultText: outcome.status === "done" ? outcome.finalResponse || null : null,
      semanticFailureKind: semantic.semanticFailureKind,
      semanticFailureMessage: semantic.semanticFailureMessage,
      semanticStatus: semantic.semanticStatus,
      status: outcome.status,
      ...structured,
      threadId: outcome.threadId,
      tokenUsage: outcome.tokenUsage,
      tokenUsageAvailability: outcome.tokenUsageAvailability,
      tokenUsageUnavailableReason: outcome.tokenUsageUnavailableReason,
      usageIsIncomplete: outcome.usageIsIncomplete,
      unknownEventCount: outcome.unknownEventCount
    });
  } catch (error) {
    return finishExecutionFailure(found.file, record, error);
  } finally {
    clearInterval(heartbeat);
  }
}

function renderRecord(record, asJson, runningReceipt = false) {
  const rendered = asJson ? `${JSON.stringify(runningReceipt && record.status === "running" && record.delivery === "manual" ? { ...record, ...backgroundWatchReceipt("codex", record.id) } : record, null, 2)}\n`
    : record.status === "running" ? runningReceipt ? renderBackgroundLaunch(record) : renderRunningResult(record)
      : renderTerminalResult(record);
  return new Promise((resolve, reject) => {
    process.stdout.once("error", reject);
    process.stdout.write(rendered, (error) => {
      setImmediate(() => process.stdout.off("error", reject));
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function spawnBackgroundWorker(found, options = {}) {
  let child;
  let identity = null;
  let approvalCommitted = false;
  try {
    child = spawn(process.execPath, [SELF_PATH, "worker", "--job-id", found.record.id, "--cwd", found.record.cwd], {
      cwd: found.record.cwd,
      detached: true,
      env: options.env ?? process.env,
      stdio: "ignore",
      windowsHide: true
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await options.beforeIdentityProbe?.(child.pid);
    identity = (options.identityReader ?? getProcessIdentity)(child.pid);
    if (!identity) {
      throw new CompanionError("The background worker process identity could not be verified.", "process");
    }
    const approved = updateJobRecordFileWithCurrent(found.file, (current) => {
      if (current.launchAbortRequestedAt || current.cancelRequestedAt) {
        throw new CompanionError("The background worker launch was cancelled before approval.", "cancelled");
      }
      if (current.pid && current.pid !== child.pid) {
        throw new CompanionError(`Codex job ${current.id} was claimed by another worker.`, "process");
      }
      if (current.pidIdentity && !processIdentityMatches(child.pid, current.pidIdentity)) {
        throw new CompanionError("The background worker claim no longer matches the spawned process.", "process");
      }
      return {
        launchApprovedAt: current.launchApprovedAt ?? nowIso(),
        phase: "launch-approved",
        pid: child.pid,
        pidIdentity: identity,
        pidOwnsProcessGroup: process.platform !== "win32"
      };
    });
    if (approved.status !== "running" || !approved.launchApprovedAt || approved.launchAbortRequestedAt) {
      throw new CompanionError("The background worker launch could not be approved.", "process");
    }
    approvalCommitted = true;
    await options.afterLaunchApproval?.(approved);
    child.unref();
    return approved;
  } catch (error) {
    const env = options.env ?? process.env;
    let current = readJobRecordFile(found.file) ?? found.record;
    if (terminalRecord(current)) {
      return current;
    }
    let currentIdentity = null;
    if (child?.pid && identity) {
      try {
        currentIdentity = (options.identityReader ?? getProcessIdentity)(child.pid);
      } catch {}
    }
    const durableApproval = Boolean(
      child?.pid &&
        identity &&
        current.launchApprovedAt &&
        !current.launchAbortRequestedAt &&
        current.pid === child.pid &&
        current.pidIdentity &&
        processIdentitiesMatch(identity, current.pidIdentity) &&
        (!currentIdentity || processIdentitiesMatch(currentIdentity, current.pidIdentity))
    );
    if (approvalCommitted || durableApproval) {
      child.unref();
      return current;
    }
    if (!identity && child?.pid && current.pid === child.pid && current.pidIdentity && processIdentityMatches(child.pid, current.pidIdentity)) {
      identity = current.pidIdentity;
    }
    try {
      current = updateJobRecordFileWithCurrent(found.file, (record) => ({
        errorMessage: `Background worker launch failed: ${oneLine(error?.message ?? error, "unknown failure")}`,
        errorTail: `Background worker launch failed: ${oneLine(error?.message ?? error, "unknown failure")}`,
        failureKind: failureKindForError(error),
        launchAbortRequestedAt: record.launchAbortRequestedAt ?? nowIso(),
        phase: "launch-aborted",
        pid: record.pid ?? child?.pid ?? null,
        pidIdentity: record.pid === child?.pid && record.pidIdentity ? record.pidIdentity : identity,
        pidOwnsProcessGroup: record.pidOwnsProcessGroup || Boolean(child?.pid && process.platform !== "win32")
      }));
    } catch {}
    const claimDeadline = Date.now() + BACKGROUND_ABORT_CLAIM_WAIT_MS;
    while (child?.pid && !identity && Date.now() < claimDeadline && isProcessAlive(child.pid, null, process.platform !== "win32")) {
      current = readJobRecordFile(found.file) ?? current;
      if (terminalRecord(current)) {
        return current;
      }
      if (current.pid === child.pid && current.pidIdentity && processIdentityMatches(child.pid, current.pidIdentity)) {
        identity = current.pidIdentity;
        break;
      }
      await delay(BACKGROUND_LAUNCH_POLL_MS);
    }
    current = readJobRecordFile(found.file) ?? current;
    if (terminalRecord(current)) {
      return current;
    }
    await terminateRecorded(current, "codex", 500);
    current = readJobRecordFile(found.file) ?? current;
    if (terminalRecord(current)) {
      return current;
    }
    let workerCleanupComplete = !child?.pid || !isProcessAlive(child.pid, null, process.platform !== "win32");
    if (!workerCleanupComplete && identity) {
      workerCleanupComplete = await terminateProcessTree(child.pid, {
        allowOrphanedGroup: true,
        graceMs: 500,
        identity,
        ownsProcessGroup: process.platform !== "win32",
        requireIdentity: true
      });
    } else if (!workerCleanupComplete) {
      workerCleanupComplete = await terminateRecorded(current, "owner", 500);
    }
    current = readJobRecordFile(found.file) ?? current;
    if (terminalRecord(current)) {
      return current;
    }
    const cleanupDeadline = Date.now() + BACKGROUND_ABORT_CLEANUP_CONFIRM_MS;
    while (Date.now() < cleanupDeadline) {
      workerCleanupComplete = workerCleanupComplete || !child?.pid || !isProcessAlive(child.pid, null, process.platform !== "win32");
      if (workerCleanupComplete && cleanupComplete(current)) {
        break;
      }
      await delay(BACKGROUND_ABORT_CLEANUP_POLL_MS);
      current = readJobRecordFile(found.file) ?? current;
      if (terminalRecord(current)) {
        return current;
      }
    }
    if (!workerCleanupComplete || !cleanupComplete(current)) {
      const message = `Background worker launch failed and verified cleanup did not complete: ${oneLine(error?.message ?? error, "unknown failure")}`;
      updateJobRecordFileWithCurrent(found.file, (current) => ({
        errorMessage: message,
        errorTail: message,
        failureKind: failureKindForError(error),
        phase: "cleanup-required",
        pid: current.pid ?? child?.pid ?? null,
        pidIdentity: current.pid === child?.pid && current.pidIdentity ? current.pidIdentity : identity,
        pidOwnsProcessGroup: current.pidOwnsProcessGroup || Boolean(child?.pid && process.platform !== "win32")
      }));
      return cleanupRequired(found.file, failureKindForError(error), message);
    }
    return finishExecutionFailure(found.file, current, error, env);
  }
}

async function dispatchJob(found, asJson) {
  if (found.record.background) {
    const launched = await spawnBackgroundWorker(found);
    const launchFailed = launched.status === "error" || launched.status === "cancelled" || launched.phase === "cleanup-required";
    await renderRecord(launched, asJson, !launchFailed);
    collectRenderedJob(found.file, launched);
    if (launchFailed) {
      process.exitCode = 1;
    }
    return;
  }
  const completed = await executeRecord(found);
  await renderRecord(completed, asJson);
  collectRenderedJob(found.file, completed);
  if (completed.status !== "done") {
    process.exitCode = 1;
  }
}

async function handleTask(rawArgv, transport = {}) {
  const taskStartedAtMs = Date.now();
  let releaseTransport = transport.release;
  try {
    const { options, positionals, positionalText } = commandArgs(rawArgv, {
      booleanOptions: ["background", "fresh", "json", "resume-last", "skip-git-repo-check", "web", "write"],
      optionsBeforePositionals: true,
      valueOptions: ["cwd", "effort", "model", "output-schema", "prompt-file", "resume", "service-tier"]
    });
    const serviceTier = parseServiceTier(options["service-tier"]);
    rejectPersistentEffort(options.effort);
    const cwd = resolveCwd(options);
    rejectImplicitSubdirectoryCwd(cwd, options);
    const dataDir = resolveDataDir();
    const resume = resolveResume(dataDir, cwd, options);
    const routing = resume.threadId ? inheritedRouting(latestJobRecordForThread(dataDir, resume.threadId), options, serviceTier) : inheritedRouting(null, options, serviceTier);
    rejectPersistentEffort(routing.effort);
    const write = options.write ?? Boolean(transport.defaultWrite);
    const background = Boolean(options.background);
    const backgroundShellBudget = Boolean(transport.backgroundShell && !background);
    const timeoutMs = resolveExecutionTimeout(background, backgroundShellBudget);
    const foregroundDeadlineMs = taskStartedAtMs + timeoutMs;
    const outputSchemaFile = options["output-schema"] ? resolveOutputSchemaFile(cwd, options["output-schema"]) : null;
    let prompt = readTaskPrompt(cwd, options, positionals, positionalText);
    if (!prompt.trim() && resume.threadId) {
      prompt = CONTINUE_PROMPT;
    }
    if (!prompt.trim()) {
      throw new CompanionError("Provide a Codex task prompt or --prompt-file.", "input");
    }
    const autoSkipGitRepoCheck = write && options.cwd != null && !hasGitAncestor(cwd) && !options["skip-git-repo-check"];
    const skipGitRepoCheck = Boolean(options["skip-git-repo-check"] || autoSkipGitRepoCheck);
    taskGitPreflight(cwd, write, skipGitRepoCheck);
    if (write && !resume.threadId && hasSwiftPackage(cwd)) {
      prompt = `${SWIFTPM_SANDBOX_NOTE}\n\n${prompt}`;
    }
    const probe = preflightCodex(cwd);
    const request = {
      backgroundShellBudget,
      effort: routing.effort,
      fresh: Boolean(options.fresh),
      ingress: transport.ingress ?? "argv",
      model: routing.model,
      network: Boolean(write),
      outputSchemaFile,
      resumeSourceJobId: resume.sourceJobId,
      resumeThreadId: resume.threadId,
      skipGitRepoCheck,
      ...(autoSkipGitRepoCheck ? { skipGitRepoCheckSource: "auto" } : {}),
      serviceTier: routing.serviceTier,
      transport: "task",
      web: Boolean(options.web),
      write: Boolean(write),
      ...(routing.inherited ? { inheritedFromThread: true } : {})
    };
    validateExecutionRequest(cwd, request);
    const found = createReservedJob({
      background,
      brief: prompt,
      codexVersion: probe.version,
      companionVersion: companionVersion(),
      cwd,
      dataDir,
      jobClass: "task",
      mode: write ? "write" : "consult",
      request,
      timeoutMs
    });
    if (!background) {
      found.foregroundDeadlineMs = foregroundDeadlineMs;
    }
    releaseTransport?.();
    releaseTransport = null;
    await dispatchJob(found, Boolean(options.json));
  } catch (error) {
    if (!/^Codex (?:job|thread) .+ is already running/.test(error?.message ?? "")) {
      releaseTransport?.();
    }
    throw error;
  }
}

function reviewTarget(options) {
  const scope = options.scope ?? "auto";
  if (!["auto", "working-tree", "branch"].includes(scope)) {
    throw new CompanionError("--scope must be auto, working-tree, or branch.", "input");
  }
  if (scope === "working-tree" && options.base) {
    throw new CompanionError("--base cannot be combined with --scope working-tree.", "input");
  }
  if (scope === "branch" && !options.base) {
    throw new CompanionError("--scope branch requires --base <ref>.", "input");
  }
  const base = scope === "working-tree" ? null : options.base ?? null;
  return {
    base,
    description: base ? `the current branch compared with ${base}` : "the current working tree changes",
    uncommitted: !base
  };
}

function focusedReviewPrompt(target, focus) {
  return [
    "Perform a read only software review of the repository.",
    `Review target: ${target.description}.`,
    `User focus: ${focus}`,
    "Inspect the relevant Git state and source directly. Report only material, actionable findings with file paths and line numbers. Do not modify files. If no substantive finding is defensible, say so explicitly."
  ].join("\n\n");
}

function adversarialReviewPrompt(target, focus) {
  let template;
  try {
    template = fs.readFileSync(ADVERSARIAL_REVIEW_PROMPT_FILE, "utf8");
  } catch (error) {
    throw new CompanionError(`Could not read the adversarial review prompt: ${error.message}`, "input");
  }
  return template.replaceAll("{{TARGET}}", target.description).replaceAll("{{FOCUS}}", focus || "No additional focus was supplied.");
}

async function handleReview(rawArgv, adversarial = false, transport = {}) {
  const foregroundDeadlineMs = Date.now() + resolveExecutionTimeout(false);
  const { options, positionals, positionalText } = commandArgs(rawArgv, {
    booleanOptions: ["background", "json"],
    valueOptions: ["base", "cwd", "effort", "focus", "model", "output-schema", "scope", "service-tier"]
  });
  if (options["output-schema"] != null) {
    throw new CompanionError("Codex review ignores --output-schema on tested CLI versions.", "input");
  }
  if (positionals.length > 0 && !options.focus) {
    throw new CompanionError("Review accepts flags only. Pass custom review instructions with --focus.", "input");
  }
  const cwd = resolveCwd(options);
  rejectImplicitSubdirectoryCwd(cwd, options);
  const serviceTier = parseServiceTier(options["service-tier"]);
  rejectPersistentEffort(options.effort);
  const probe = preflightCodex(cwd);
  const target = reviewTarget(options);
  const positionalFocus = positionalText ?? positionals.join(" ");
  const focus = [options.focus, positionalFocus].filter(Boolean).join(" ").trim();
  const usePromptTransport = adversarial || Boolean(focus);
  const brief = adversarial
    ? adversarialReviewPrompt(target, focus)
    : focus
      ? focusedReviewPrompt(target, focus)
      : "";
  const outputSchemaFile = adversarial ? resolveOutputSchemaFile(cwd, ADVERSARIAL_REVIEW_SCHEMA_FILE) : null;
  const request = {
    base: target.base,
    effort: options.effort ?? null,
    focus: focus || null,
    ingress: transport.ingress ?? "argv",
    model: options.model ?? null,
    network: false,
    outputSchemaFile,
    serviceTier,
    transport: usePromptTransport ? (adversarial ? "adversarial-review" : "focused-review") : "native-review",
    uncommitted: target.uncommitted,
    web: false,
    write: false
  };
  validateExecutionRequest(cwd, request);
  const dataDir = resolveDataDir();
  const found = createReservedJob({
    background: Boolean(options.background),
    brief,
    codexVersion: probe.version,
    companionVersion: companionVersion(),
    cwd,
    dataDir,
    jobClass: adversarial ? "adversarial-review" : "review",
    mode: "consult",
    request,
    timeoutMs: resolveExecutionTimeout(Boolean(options.background))
  });
  if (!options.background) {
    found.foregroundDeadlineMs = foregroundDeadlineMs;
  }
  await dispatchJob(found, Boolean(options.json));
}

async function waitForBackgroundLaunchApproval(file, record) {
  const deadline = Date.now() + resolveTimeoutMs(process.env[BACKGROUND_LAUNCH_APPROVAL_TIMEOUT_ENV], BACKGROUND_LAUNCH_APPROVAL_TIMEOUT_MS);
  let current = record;
  for (;;) {
    current = readJobRecordFile(file) ?? current;
    if (current.status !== "running" || current.launchAbortRequestedAt || current.cancelRequestedAt || current.phase === "cleanup-required") {
      return current;
    }
    if (current.pid !== process.pid || !current.pidIdentity) {
      return finishExecutionFailure(file, current, new CompanionError("The background worker lost its launch claim.", "process"));
    }
    if (current.launchApprovedAt && current.phase === "launch-approved") {
      return current;
    }
    if (Date.now() >= deadline) {
      const message = "The background worker launch approval timed out.";
      let committed = false;
      const completed = updateJobRecordFileWithCurrent(file, (latest) => {
        if (latest.launchApprovedAt || latest.launchAbortRequestedAt || latest.cancelRequestedAt) {
          return null;
        }
        committed = true;
        return {
          status: "error",
          failureKind: "timeout",
          errorMessage: message,
          errorTail: message
        };
      });
      if (committed) {
        appendJobLog(record.logFile, message);
        pruneJobState(resolveDataDir(), { claudeSessionId: completed.claudeSessionId, protectedJobFiles: [file], resumeWorkspaceJobFiles: [file] });
      }
      return completed;
    }
    await delay(BACKGROUND_LAUNCH_POLL_MS);
  }
}

async function handleWorker(rawArgv) {
  const { options, positionals } = commandArgs(rawArgv, {
    valueOptions: ["cwd", "job-id"]
  });
  if (positionals.length > 0 || !options["job-id"] || !options.cwd) {
    throw new CompanionError("worker requires --job-id and --cwd.", "input");
  }
  const cwd = resolveCwd(options);
  const dataDir = resolveDataDir();
  const file = jobFilePath(dataDir, cwd, options["job-id"]);
  const record = readJobRecordFile(file);
  if (!record) {
    throw new CompanionError(`No job record found for ${options["job-id"]}.`, "input");
  }
  if (!record.background) {
    throw new CompanionError("worker can execute only a background job.", "input");
  }
  const ownerIdentity = currentProcessIdentity();
  const claimed = updateJobRecordFileWithCurrent(file, (current) => {
    if (current.pid && current.pid !== process.pid) {
      const owner = recordedProcessState(current, "owner");
      if (owner.state === "owned" || owner.state === "unverified") {
        throw new CompanionError(`Codex job ${current.id} already has a live worker.`, "input");
      }
    }
    if (current.startedAt && current.pid !== process.pid) {
      throw new CompanionError(`Codex job ${current.id} has already started.`, "input");
    }
    return {
      phase: current.launchAbortRequestedAt || current.cancelRequestedAt || current.phase === "cleanup-required" ? current.phase : current.launchApprovedAt ? "launch-approved" : "awaiting-launch-approval",
      pid: process.pid,
      pidIdentity: ownerIdentity,
      pidOwnsProcessGroup: process.platform !== "win32"
    };
  });
  if (claimed.status !== "running") {
    return;
  }
  const approved = await waitForBackgroundLaunchApproval(file, claimed);
  if (approved.status !== "running" || approved.launchAbortRequestedAt || approved.cancelRequestedAt || approved.phase === "cleanup-required") {
    process.exitCode = 1;
    return;
  }
  const completed = await executeRecord({ record: approved, file });
  if (completed.status !== "done") {
    process.exitCode = 1;
  }
}

async function handleStatus(rawArgv) {
  const { options, positionals } = commandArgs(rawArgv, {
    booleanOptions: ["all", "json"],
    valueOptions: ["cwd"]
  });
  if (positionals.length > 1) {
    throw new CompanionError("status accepts at most one job id.", "input");
  }
  const dataDir = resolveDataDir();
  if (positionals[0]) {
    const found = findRequestedJob(dataDir, positionals[0], options);
    if (!found) {
      throw new CompanionError(`No job record found for ${positionals[0]}.`, "input");
    }
    const record = await refreshRunningJobRecord(found);
    output(options.json ? record : renderJobDetail(record), Boolean(options.json));
    return;
  }
  if (options.all && options.cwd) {
    throw new CompanionError("--all cannot be combined with --cwd.", "input");
  }
  const cwd = options.all ? null : resolveCwd(options);
  const entries = options.all
    ? listAllJobRecords(dataDir)
    : listJobRecords(dataDir, cwd).map((record) => ({ record, file: jobFilePath(dataDir, cwd, record.id) }));
  const records = [];
  for (const entry of entries) {
    records.push(await refreshRunningJobRecord(entry));
  }
  output(options.json ? { jobs: records } : renderStatusTable(records), Boolean(options.json));
}

async function handleHistory(rawArgv) {
  const { options, positionals } = commandArgs(rawArgv, {
    booleanOptions: ["json"]
  });
  if (positionals.length > 0) {
    throw new CompanionError("history accepts only --json.", "input");
  }
  const records = [];
  for (const entry of listAllJobRecords(resolveDataDir())) {
    records.push(await refreshRunningJobRecord(entry));
  }
  output(
    options.json
      ? { jobs: records, sidebarVisibility: "not_guaranteed_for_exec_sessions", source: "canonical" }
      : renderStatusTable(records),
    Boolean(options.json)
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForResult(found, options) {
  const deadline = Date.now() + resolveWaitTimeout(options);
  const pollMs = resolveTimeoutMs(process.env[WAIT_POLL_ENV], DEFAULT_WAIT_POLL_MS);
  let record = found.record;
  for (;;) {
    record = await refreshRunningJobRecord({ record, file: found.file });
    if (record.status !== "running") {
      return record;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return record;
    }
    await delay(Math.min(pollMs, remaining));
    record = readJobRecordFile(found.file) ?? record;
  }
}

async function handleResult(rawArgv) {
  const { options, positionals } = commandArgs(rawArgv, {
    booleanOptions: ["json", "wait"],
    valueOptions: ["cwd", "wait-timeout-ms"]
  });
  if (positionals.length !== 1) {
    throw new CompanionError("Provide exactly one Codex job id.", "input");
  }
  const dataDir = resolveDataDir();
  const found = findRequestedJob(dataDir, positionals[0], options);
  if (!found) {
    throw new CompanionError(`No job record found for ${positionals[0]}.`, "input");
  }
  const record = options.wait ? await waitForResult(found, options) : await refreshRunningJobRecord(found);
  await renderRecord(record, Boolean(options.json));
  collectRenderedJob(found.file, record);
  if (record.status === "error" || record.status === "cancelled" || record.phase === "cleanup-required") {
    process.exitCode = 1;
  }
}

async function handleWindDown(rawArgv) {
  if (rawArgv.length !== 2 || rawArgv[0] !== "--job" || !JOB_ID_PATTERN.test(rawArgv[1])) {
    throw new CompanionError("wind-down requires --job followed by a 32 character lowercase hexadecimal job id.", "input");
  }
  const jobId = rawArgv[1];
  const source = findRequestedJob(resolveDataDir(), jobId, {});
  const record = source?.record;
  if (!record || record.status !== "error" || !RESUMABLE_FAILURE_KINDS.has(record.failureKind)
    || typeof record.threadId !== "string" || !record.threadId.trim() || record.windDownJobId) {
    throw new CompanionError(`Codex job ${jobId} is not eligible for wind-down.`, "input");
  }
  const request = record.request ?? {};
  const argv = ["--resume", record.threadId, "--cwd", record.cwd];
  const model = request.model ?? record.resolvedModel;
  const effort = request.effort ?? record.resolvedEffort;
  const serviceTier = request.serviceTier;
  if (model) argv.push("--model", model);
  if (effort) argv.push("--effort", effort);
  if (serviceTier !== undefined) argv.push("--service-tier", serviceTier ?? "none");
  if (request.write === true) argv.push("--write");
  if (request.web === true) argv.push("--web");
  if (request.skipGitRepoCheck === true) argv.push("--skip-git-repo-check");
  argv.push("--", WIND_DOWN_PROMPT);
  await handleTask(argv, { ingress: `wind-down:${jobId}` });
}

async function cancelFoundJob(found) {
  let record = await refreshRunningJobRecord(found);
  if (record.status !== "running") {
    return record;
  }
  const spawnCheckpointPending = codexSpawnCheckpointPending(record);
  record = updateJobRecordFileWithCurrent(found.file, (current) => ({
    cancelRequestedAt: nowIso(),
    phase: "cancelling"
  }));
  if (record.status !== "running") {
    return record;
  }
  if (spawnCheckpointPending) {
    signalRecorded(record, "owner");
    return cleanupRequired(found.file, "cancelled", "Cancellation was requested while the Codex process identity checkpoint was incomplete. Graceful cleanup was requested without forcing the companion to exit.");
  }
  await Promise.all([terminateRecorded(record, "codex", 500), terminateRecorded(record, "owner", 500)]);
  const refreshed = readJobRecordFile(found.file) ?? record;
  if (!cleanupComplete(refreshed)) {
    return cleanupRequired(found.file, "cancelled", "Cancellation was requested, but verified process cleanup did not complete. The process identifiers were retained for retry.");
  }
  return finishJob(found.file, {
    status: "cancelled",
    failureKind: "cancelled",
    errorMessage: "Codex job was cancelled."
  });
}

async function handleCancel(rawArgv) {
  const { options, positionals } = commandArgs(rawArgv, {
    booleanOptions: ["json"],
    valueOptions: ["cwd"]
  });
  if (positionals.length !== 1) {
    throw new CompanionError("Provide exactly one Codex job id.", "input");
  }
  const dataDir = resolveDataDir();
  const found = findRequestedJob(dataDir, positionals[0], options);
  if (!found) {
    throw new CompanionError(`No job record found for ${positionals[0]}.`, "input");
  }
  const record = await cancelFoundJob(found);
  const rendered = record.status === "cancelled" ? renderCancelReport(record) : record.status === "running" ? renderRunningResult(record) : renderTerminalResult(record);
  output(options.json ? record : rendered, Boolean(options.json));
  if (record.status === "running") {
    process.exitCode = 1;
  }
}

async function handleRecordAcceptance(argv) {
  const { acceptance, acceptFailedTransport, failureKind, jobId, json, reason, source } = parseRecordAcceptanceArgs(argv);
  const found = findJobRecordById(resolveDataDir(), jobId);
  if (!found) {
    throw new CompanionError(`No job record found for ${jobId}.`, "input");
  }
  const record = updateJobRecordFileWithCurrent(found.file, (current) => {
    if (acceptance === "accepted" && current.status !== "done" && !acceptFailedTransport) {
      throw new CompanionError(`Codex job ${current.id} has transport status ${current.status}. Pass --accept-failed-transport to record accepted.`, "input");
    }
    return {
      acceptanceRecordedAt: nowIso(),
      acceptanceSource: source,
      semanticFailureKind: acceptance === "rejected" ? failureKind ?? null : null,
      semanticFailureMessage: acceptance === "rejected" ? reason : null,
      semanticStatus: acceptance
    };
  }, { allowTerminal: true });
  if (json) {
    output(`${JSON.stringify({ id: record.id, semanticStatus: record.semanticStatus, semanticFailureKind: record.semanticFailureKind ?? null, acceptanceSource: record.acceptanceSource ?? null }, null, 2)}\n`);
    return;
  }
  output(`Recorded verdict for Codex job ${record.id}: ${record.semanticStatus}.\n`);
}

function readHookInput() {
  if (isatty(0)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function handleSessionEnd() {
  const input = readHookInput();
  const sessionId = input.session_id ?? currentClaudeSessionId();
  pruneRawCommandTransports({ sessionId });
  if (!sessionId) {
    return;
  }
  const owned = listAllJobRecords(resolveDataDir()).filter(
    (found) => found.record.status === "running" && found.record.claudeSessionId === sessionId
  );
  const marked = owned.map((found) => {
    try {
      const record = updateJobRecordFileWithCurrent(found.file, (current) => ({
        cancelRequestedAt: current.cancelRequestedAt ?? nowIso(),
        phase: "cancelling"
      }));
      return { ...found, record };
    } catch {
      return found;
    }
  });
  await Promise.all(
    marked.map(async (found) => {
      try {
        await cancelFoundJob(found);
      } catch {}
    })
  );
}

async function handleResumeCandidate(rawArgv) {
  const { options, positionals } = commandArgs(rawArgv, {
    booleanOptions: ["json"],
    valueOptions: ["cwd"]
  });
  if (positionals.length > 0) {
    throw new CompanionError("task-resume-candidate accepts flags only.", "input");
  }
  const cwd = resolveCwd(options);
  const record = latestResumeRecord(resolveDataDir(), cwd, currentClaudeSessionId());
  if (options.json) {
    output({ jobId: record.id, threadId: record.threadId }, true);
    return;
  }
  output(`codex-session: ${record.threadId}\njob: ${record.id}\nstate: ${record.status}\n`);
}

function authenticationStatus(bin, cwd, env = process.env) {
  const result = spawnSync(bin, ["login", "status"], {
    cwd,
    encoding: "utf8",
    env,
    timeout: 5000,
    windowsHide: true
  });
  if (!result.error && typeof result.status === "number" && result.status !== 0 && typeof env.CODEX_API_KEY === "string" && env.CODEX_API_KEY.trim()) {
    return {
      authenticated: true,
      detail: "authenticated via CODEX_API_KEY environment variable (login status reports logged out)"
    };
  }
  return {
    authenticated: !result.error && result.status === 0,
    detail: String(result.stdout || result.stderr || result.error?.message || "").trim() || null
  };
}

function handleSetup(rawArgv) {
  const { options, positionals } = commandArgs(rawArgv, {
    booleanOptions: ["json"],
    valueOptions: ["cwd"]
  });
  if (positionals.length > 0) {
    throw new CompanionError("setup accepts flags only.", "input");
  }
  const cwd = resolveCwd(options);
  const codex = getCodexAvailability({ cwd, env: process.env });
  const auth = codex.available ? authenticationStatus(codex.bin, cwd, process.env) : { authenticated: false, detail: null };
  const compatible = codex.available && supportedVersion(codex.version);
  const installedVersion = parseVersion(codex.version);
  const newerThanTested = Boolean(installedVersion) && compareVersion(installedVersion, TESTED_VERSION_MAX) >= 0;
  const testedInterval = testedVersionInterval();
  const dataDir = resolveDataDir();
  let writable = true;
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    fs.accessSync(dataDir, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  const nextSteps = [];
  if (!codex.available) {
    nextSteps.push("Install the official OpenAI Codex CLI, then run /codex:setup again.");
  } else if (!auth.authenticated) {
    nextSteps.push("Run codex login, then run /codex:setup again.");
  }
  if (codex.available && !compatible) {
    nextSteps.push(newerThanTested ? `Codex CLI version ${codex.version} is newer than the tested interval (${testedInterval}). A verification pass is advised.` : `Use a Codex CLI version in the tested interval (${testedInterval}).`);
  }
  if (!writable) {
    nextSteps.push(`Make the adapter data directory writable: ${dataDir}.`);
  }
  const report = {
    authenticated: auth.authenticated,
    authenticationDetail: auth.detail ? redactDiagnostic(boundedTail(auth.detail, 5)) : null,
    codex: {
      ...codex,
      bin: redactDiagnostic(codex.bin),
      errorMessage: codex.errorMessage ? redactDiagnostic(boundedTail(codex.errorMessage, 5)) : null,
      rawVersion: codex.rawVersion ? redactDiagnostic(boundedTail(codex.rawVersion, 5)) : null
    },
    compatibility: compatible ? "tested" : codex.available ? newerThanTested ? `newer than the tested interval (${testedInterval})` : `outside the tested interval (${testedInterval})` : "unknown",
    dataDir,
    nextSteps,
    ready: codex.available && auth.authenticated && compatible && writable,
    writable
  };
  output(options.json ? report : renderSetupReport(report), Boolean(options.json));
  if (!report.ready) {
    process.exitCode = 1;
  }
}

async function main() {
  const [subcommand, ...receivedArgv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }
  if (subcommand === "await-output") {
    process.exitCode = await awaitOutput(receivedArgv);
    return;
  }
  if (subcommand === "watch") {
    await watchJob(receivedArgv, { engine: "codex", readJob: (id) => {
      const found = findRequestedJob(resolveDataDir(), id, {});
      return found ? refreshRunningJobRecord(found) : null;
    } });
    return;
  }
  if (subcommand === "transport-create") {
    if (receivedArgv.length > 0) {
      throw new CompanionError("transport-create accepts no arguments.", "input");
    }
    createRawCommandTransport();
    return;
  }
  if (subcommand === "transport-discard") {
    if (receivedArgv.length !== 2 || receivedArgv[0] !== "--raw-args-token") {
      throw new CompanionError("transport-discard requires exactly one raw argument token.", "input");
    }
    consumeRawCommandTransport(receivedArgv[1], { allowMissing: true });
    return;
  }
  if (subcommand === "record-acceptance") {
    activeCommandArgv = receivedArgv;
    await handleRecordAcceptance(receivedArgv);
    return;
  }
  const backgroundShell = subcommand === "task" && (receivedArgv[0] === "--transport-background-shell" ||
    (receivedArgv[0] === "--transport-default-write" && receivedArgv[1] === "--transport-background-shell"));
  const transportArgv = backgroundShell ? receivedArgv.filter((value, index) => index !== (receivedArgv[0] === "--transport-background-shell" ? 0 : 1)) : receivedArgv;
  if (backgroundShell && transportArgv[transportArgv[0] === "--transport-default-write" ? 1 : 0] !== "--raw-args-token") {
    throw new CompanionError("The background shell transport option requires a raw argument token.", "input");
  }
  const transport = { ...resolveCommandTransport(transportArgv, { retainStaged: subcommand === "task" }), backgroundShell };
  if (transport.defaultWrite && subcommand !== "task") {
    throw new CompanionError("The raw command transport write default is valid only for task.", "input");
  }
  const rawArgv = transport.argv;
  activeCommandArgv = rawArgv;
  switch (subcommand) {
    case "task":
      await handleTask(rawArgv, transport);
      break;
    case "worker":
      await handleWorker(rawArgv);
      break;
    case "review":
      await handleReview(rawArgv, false, transport);
      break;
    case "adversarial-review":
      await handleReview(rawArgv, true, transport);
      break;
    case "status":
      await handleStatus(rawArgv);
      break;
    case "history":
      await handleHistory(rawArgv);
      break;
    case "models":
      handleModels(rawArgv);
      break;
    case "quota":
      handleQuota(rawArgv);
      break;
    case "quota-refresh":
      await handleQuotaRefresh(rawArgv[0]);
      break;
    case "result":
      await handleResult(rawArgv);
      break;
    case "wind-down":
      await handleWindDown(rawArgv);
      break;
    case "cancel":
      await handleCancel(rawArgv);
      break;
    case "setup":
      handleSetup(rawArgv);
      break;
    case "task-resume-candidate":
      await handleResumeCandidate(rawArgv);
      break;
    case "session-end":
      await handleSessionEnd();
      break;
    default:
      throw new CompanionError(`Unknown subcommand: ${subcommand}.`, "input");
  }
}

function wantsJsonError() {
  const raw = activeCommandArgv ?? process.argv.slice(3);
  try {
    return (raw.length === 1 ? splitRawArgumentString(raw[0]) : raw).some((token) => token === "--json" || token === "--json=true");
  } catch {
    return raw.some((token) => token.includes("--json"));
  }
}

function renderTopLevelError(error) {
  const message = redactDiagnostic(oneLine(error?.message ?? error, "Codex companion failed."));
  const failureKind = failureKindForError(error);
  return renderFailure(message, failureKind, wantsJsonError());
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  main().catch((error) => {
    if (process.argv[2] !== "session-end") {
      process.stderr.write(renderTopLevelError(error));
      process.exitCode = 1;
    }
  });
}
