import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isatty } from "node:tty";
import { parseArgs, parseRawArgs } from "../args.mjs";
import { terminateProcessGroup } from "../grok-exec.mjs";
import { getProcessIdentity } from "../process-identity.mjs";
import { SESSION_ID_ENV, findJobRecordById, jobFilePath, launchRunningJobProcess, readJobRecordFile, writePrivateDataFile } from "../state.mjs";
import { STOP_GATE_OPTION_ENV, CONTINUITY_POLICY_ENV, WAIT_POLL_ENV, WAIT_TIMEOUT_ENV, BACKGROUND_DELIVERY_ENV, DEFAULT_WAIT_POLL_MS, DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS, JOB_ID_PATTERN, MAX_HISTORY_LIMIT, CONTINUITY_POLICIES, MAX_JSON_SCHEMA_BYTES, GROK_ROLES } from "./config.mjs";
import { inputError } from "./session.mjs";

const commandContext = { argv: null, config: null, ingress: "argv", options: null };

function output(value, asJson) {
  const text = asJson ? `${JSON.stringify(value, null, 2)}\n` : String(value);
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(process.stdout.fd, buffer, offset, buffer.length - offset);
    if (written <= 0) {
      throw new Error("Unable to write the Grok companion result to stdout.");
    }
    offset += written;
  }
}

function errorWithFailure(message, failureKind) {
  const error = new Error(message);
  error.failureKind = failureKind;
  return error;
}

function oneLineSummary(value, fallback = "Grok companion failed.") {
  const line = String(value ?? "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return line || fallback;
}

function boundedTextTail(value, maxLines = 20) {
  return String(value ?? "")
    .slice(-64 * 1024)
    .trimEnd()
    .split(/\r?\n/)
    .slice(-maxLines)
    .join("\n");
}

function failureOutcomeMessage({ message, detail, record, status = "error", failureKind = "error" }) {
  const lines = [String(message ?? "").trim() || "Grok companion failed."];
  const diagnostic = String(detail ?? "").trim();
  if (diagnostic && diagnostic !== lines[0]) {
    lines.push("", diagnostic);
  }
  if (record) {
    lines.push("", `job: ${record.id}`, `sandbox: ${record.cwd}`);
    lines.push(`delivery: ${record.delivery}`, `semantic: ${record.semanticStatus}`);
  }
  lines.push(`state: ${status}`, `failure: ${failureKind}`);
  return lines.join("\n");
}

function resolveCwd(options) {
  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  let stats;
  try {
    stats = fs.statSync(cwd);
  } catch {
    throw errorWithFailure(`Working directory does not exist: ${cwd}.`, "input");
  }
  if (!stats.isDirectory()) {
    throw errorWithFailure(`Working directory is not a directory: ${cwd}.`, "input");
  }
  return cwd;
}

function bestEffortRealpath(cwd) {
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

function validateImplicitRepositoryCwd(options, cwd, repositoryTopLevel) {
  if (options.cwd !== undefined || repositoryTopLevel === null) {
    return;
  }
  if (bestEffortRealpath(cwd) !== bestEffortRealpath(repositoryTopLevel)) {
    throw inputError(`Implicit working directory ${cwd} is inside repository ${repositoryTopLevel} but is not its root. Pass --cwd ${repositoryTopLevel} to target the repository root, or pass --cwd ${cwd} to confirm this subdirectory as the sandbox root.`);
  }
}

function findRequestedJobRecord(dataDir, jobId, options) {
  if (!JOB_ID_PATTERN.test(String(jobId ?? ""))) {
    throw inputError("Grok job ids must be exactly 32 lowercase hexadecimal characters.");
  }
  if (options.cwd === undefined) {
    return findJobRecordById(dataDir, jobId);
  }
  const cwd = resolveCwd(options);
  const file = jobFilePath(dataDir, cwd, jobId);
  const record = readJobRecordFile(file);
  return record?.id === jobId ? { record, file } : null;
}

function currentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function configFilePath(dataDir) {
  return path.join(dataDir, "config.json");
}

function readConfig(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFilePath(dataDir), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeConfig(dataDir, patch) {
  const next = { ...readConfig(dataDir), ...patch };
  writePrivateDataFile(dataDir, "config.json", `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function isStopGateEnabled(dataDir, env = process.env) {
  const raw = env[STOP_GATE_OPTION_ENV];
  if (raw !== undefined) {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  return Boolean(readConfig(dataDir).stopGate);
}

function continuityPolicy(dataDir, env = process.env) {
  const overridden = String(env[CONTINUITY_POLICY_ENV] ?? "").trim();
  if (CONTINUITY_POLICIES.has(overridden)) {
    return overridden;
  }
  const configured = String(readConfig(dataDir).continuityPolicy ?? "").trim();
  return CONTINUITY_POLICIES.has(configured) ? configured : "manual";
}

function parseContinuityPolicy(value) {
  const normalized = String(value ?? "").trim();
  if (!CONTINUITY_POLICIES.has(normalized)) {
    throw inputError("Expected --continuity to be manual or claude-session.");
  }
  return normalized;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw inputError(`Expected a positive integer for ${flag}.`);
  }
  return parsed;
}

function parseHistoryLimit(value) {
  const normalized = String(value ?? "");
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw inputError("Expected a positive integer for --limit.");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_HISTORY_LIMIT) {
    throw inputError(`Expected --limit between 1 and ${MAX_HISTORY_LIMIT}.`);
  }
  return parsed;
}

function parseNonnegativeInteger(value, flag) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw inputError(`Expected a non-negative integer for ${flag}.`);
  }
  return parsed;
}

function parseJsonSchema(value) {
  const schema = String(value ?? "");
  if (Buffer.byteLength(schema, "utf8") > MAX_JSON_SCHEMA_BYTES) {
    throw inputError("The --json-schema value exceeds the 256 KiB limit.");
  }
  try {
    JSON.parse(schema);
  } catch (error) {
    throw inputError(`The --json-schema value must be valid inline JSON: ${oneLineSummary(error.message, "invalid JSON")}`);
  }
  return schema;
}

function commandArgs(argv, config, transport) {
  commandContext.config = config;
  commandContext.options = null;
  try {
    const parsed = transport?.ingress === "staged_file" ? parseRawArgs(argv[0] ?? "", config) : { ...parseArgs(argv, config), positionalText: null };
    commandContext.options = parsed.options;
    return parsed;
  } catch (error) {
    if (error?.failureKind) {
      throw error;
    }
    throw inputError(error instanceof Error ? error.message : String(error));
  }
}

function resolveWaitPollMs(env = process.env) {
  const raw = Number(env[WAIT_POLL_ENV]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_WAIT_POLL_MS;
}

function resolveWaitTimeoutMs(options = {}, env = process.env) {
  if (options["wait-timeout-ms"] !== undefined) {
    return Math.min(parseNonnegativeInteger(options["wait-timeout-ms"], "--wait-timeout-ms"), MAX_WAIT_TIMEOUT_MS);
  }
  const value = env[WAIT_TIMEOUT_ENV];
  const raw = Number(value);
  const configured =
    value !== undefined && String(value).trim() && Number.isFinite(raw) && raw >= 0
      ? Math.floor(raw)
      : DEFAULT_WAIT_TIMEOUT_MS;
  return Math.min(configured, MAX_WAIT_TIMEOUT_MS);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readStdinIfPiped() {
  if (isatty(0)) {
    return "";
  }
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  for (;;) {
    let bytes;
    try {
      bytes = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error.code === "EAGAIN") {
        sleepMs(20);
        continue;
      }
      break;
    }
    if (bytes === 0) {
      break;
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytes)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readTaskPrompt(cwd, options, positionals, positionalText = null) {
  const positionalPrompt = positionalText ?? positionals.join(" ").trim();
  if (positionalPrompt.trim()) {
    return positionalPrompt;
  }
  if (options["prompt-file"]) {
    const promptFile = path.resolve(cwd, options["prompt-file"]);
    try {
      return fs.readFileSync(promptFile, "utf8").trim();
    } catch (error) {
      const failureKind = error?.code === "EACCES" || error?.code === "EPERM" ? "permission" : "input";
      throw errorWithFailure(`Could not read prompt file ${promptFile}: ${error.message}`, failureKind);
    }
  }
  return readStdinIfPiped().trim();
}

function isFusionRoutedPrompt(prompt) {
  return String(prompt ?? "")
    .split(/\r?\n/)
    .slice(0, 12)
    .some((line) => /^\s*(?:fusion-brief:\s*v1|grok-role:|lane:\s*panel\b)/i.test(line));
}

function grokRoleFromPrompt(prompt) {
  for (const line of String(prompt ?? "").split(/\r?\n/).slice(0, 12)) {
    const match = /\bgrok-role:\s*([^\s;,]+)/i.exec(line);
    if (match) {
      return GROK_ROLES.has(match[1]) ? match[1] : null;
    }
  }
  return null;
}

function backgroundDelivery(env = process.env) {
  return env[BACKGROUND_DELIVERY_ENV] === "managed" ? "managed" : "manual";
}

function waitForChildSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function spawnBackgroundWorker(args, jobFile) {
  let child = null;
  let identity = null;
  try {
    const launched = launchRunningJobProcess(
      jobFile,
      () => {
        child = spawn(process.execPath, args, {
          detached: true,
          stdio: "ignore"
        });
        identity = Number.isInteger(child.pid) ? getProcessIdentity(child.pid) : null;
        return { child, pid: child.pid ?? null, identity };
      },
      { processRole: "worker" }
    );
    child = launched.child ?? child;
    identity = launched.identity ?? identity;
    await waitForChildSpawn(child);
    child.unref();
    return child;
  } catch (error) {
    if (Number.isInteger(child?.pid) && child.pid > 1) {
      const cleaned = await terminateProcessGroup(
        child.pid,
        identity ? { identity } : {}
      ).catch(() => false);
      if (!cleaned) {
        const cleanupError = new Error("Verified background worker cleanup did not complete after launch failed.");
        cleanupError.failureKind = error?.failureKind ?? "error";
        cleanupError.cleanupRequired = true;
        cleanupError.processRole = "worker";
        cleanupError.pid = child.pid;
        cleanupError.pidIdentity = identity;
        child.unref();
        throw cleanupError;
      }
    }
    throw error;
  }
}

export { commandContext, output, errorWithFailure, oneLineSummary, boundedTextTail, failureOutcomeMessage, resolveCwd, bestEffortRealpath, validateImplicitRepositoryCwd, findRequestedJobRecord, currentClaudeSessionId, configFilePath, readConfig, writeConfig, isStopGateEnabled, continuityPolicy, parseContinuityPolicy, parsePositiveInteger, parseHistoryLimit, parseNonnegativeInteger, parseJsonSchema, commandArgs, resolveWaitPollMs, resolveWaitTimeoutMs, sleepMs, delayMs, readStdinIfPiped, readTaskPrompt, isFusionRoutedPrompt, grokRoleFromPrompt, backgroundDelivery, waitForChildSpawn, spawnBackgroundWorker };
