#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { consumeRawArgsTransport, createRawArgsTransport } from "./lib/raw-args-transport.mjs";

export class UsageError extends Error {}

const SELF_PATH = fileURLToPath(import.meta.url);
const DEFAULT_INTERVAL_MS = 20_000;
const DEFAULT_CAP_MS = 540_000;
const MAX_CAP_MS = 540_000;
const STDERR_TAIL_LINES = 20;
const JOB_ID_PATTERN = /^[a-f0-9]{32}$/;
const TOKEN_PATTERN = /^[a-f0-9]{48}$/;
const ENGINES = new Set(["codex", "grok"]);
const TERMINAL_STATES = new Set(["done", "error", "cancelled", "completed", "failed"]);
const SEMANTIC_STATES = new Set(["accepted", "rejected", "unverified"]);
const FOOTER_FIELD = /^\s*(?:[a-z][a-z0-9_-]*-session|job|delivery|semantic|state|failure)\s*:\s*/i;
const REQUEST_FIELDS = new Set(["engine", "jobId", "json", "intervalMs", "capMs", "deadRerunStatus"]);

function usage() {
  return "Usage: node job-collect.mjs transport-create | transport-discard --raw-args-token <token> | --raw-args-token <token>";
}

function regularFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function companionMetadata(engine) {
  if (!ENGINES.has(engine)) {
    throw new UsageError("The collection engine must be codex or grok.");
  }
  const upper = engine.toUpperCase();
  return {
    environmentKey: `FUSION_${upper}_COMPANION`,
    filename: `${engine}-companion.mjs`
  };
}

function configuredHome(env) {
  const candidate = typeof env.HOME === "string" ? env.HOME.trim() : "";
  return candidate && path.isAbsolute(candidate) ? candidate : os.homedir();
}

export function resolveCompanion(engine, { env = process.env, selfPath = SELF_PATH } = {}) {
  const { environmentKey, filename } = companionMetadata(engine);
  const override = typeof env[environmentKey] === "string" ? env[environmentKey].trim() : "";
  if (override) {
    if (!path.isAbsolute(override) || !regularFile(override)) {
      throw new UsageError(`${environmentKey} must name an absolute companion file.`);
    }
    return override;
  }

  const cacheBase = path.join(configuredHome(env), ".claude", "plugins", "cache", "claude-code-fusion", engine);
  try {
    const candidates = fs
      .readdirSync(cacheBase)
      .map((version) => path.join(cacheBase, version, "scripts", filename))
      .filter(regularFile)
      .map((candidate) => ({ candidate, modifiedAt: fs.statSync(candidate).mtimeMs }))
      .sort((left, right) => right.modifiedAt - left.modifiedAt || left.candidate.localeCompare(right.candidate));
    if (candidates.length > 0) {
      return candidates[0].candidate;
    }
  } catch {}

  const sibling = path.resolve(path.dirname(selfPath), "..", "..", engine, "scripts", filename);
  if (regularFile(sibling)) {
    return sibling;
  }
  throw new UsageError(`No ${engine} companion was found in the plugin cache or repository plugins.`);
}

function parseInteger(value, fallback, field) {
  if (value == null) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UsageError(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function parseBoolean(value, fallback, field) {
  if (value == null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new UsageError(`${field} must be a boolean.`);
  }
  return value;
}

function parseCollectionRequest(raw) {
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    throw new UsageError("The collection request must be valid JSON.");
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new UsageError("The collection request must be a JSON object.");
  }
  for (const field of Object.keys(request)) {
    if (!REQUEST_FIELDS.has(field)) {
      throw new UsageError(`Unknown collection request field ${field}.`);
    }
  }
  if (!ENGINES.has(request.engine)) {
    throw new UsageError("The collection request engine must be codex or grok.");
  }
  if (typeof request.jobId !== "string" || !JOB_ID_PATTERN.test(request.jobId)) {
    throw new UsageError("The collection request jobId must be exactly 32 lowercase hexadecimal characters.");
  }
  const capMs = parseInteger(request.capMs, DEFAULT_CAP_MS, "capMs");
  if (capMs > MAX_CAP_MS) {
    throw new UsageError(`capMs cannot exceed ${MAX_CAP_MS}.`);
  }
  return {
    engine: request.engine,
    jobId: request.jobId,
    json: parseBoolean(request.json, false, "json"),
    intervalMs: parseInteger(request.intervalMs, DEFAULT_INTERVAL_MS, "intervalMs"),
    capMs,
    deadRerunStatus: parseBoolean(request.deadRerunStatus, false, "deadRerunStatus")
  };
}

function tokenFromArgv(argv) {
  if (argv.length !== 2 || argv[0] !== "--raw-args-token" || !TOKEN_PATTERN.test(argv[1])) {
    throw new UsageError("Collection requires exactly one valid raw argument token.");
  }
  return argv[1];
}

function signalChild(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return false;
  }
  try {
    if (process.platform !== "win32" && child.pid > 1) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
    return true;
  } catch {}
  return false;
}

export function runCompanion(companion, command, options, timeoutMs) {
  const args = [companion, command, options.jobId];
  if (command === "result") {
    args.push("--wait");
  }
  if (options.json) {
    args.push("--json");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { detached: process.platform !== "win32", shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let killTimer = null;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (signalChild(child, "SIGTERM")) {
        killTimer = setTimeout(() => signalChild(child, "SIGKILL"), 100);
      }
    }, Math.max(1, timeoutMs));
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("exit", () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resolve({
        code: code ?? (signal ? 1 : 0),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut
      });
    });
  });
}

function parsedJson(output) {
  try {
    const value = JSON.parse(String(output));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function terminalMetadata(output, json = false) {
  if (json) {
    const record = parsedJson(output);
    const state = typeof record?.status === "string" ? record.status.toLowerCase() : typeof record?.transportStatus === "string" ? record.transportStatus.toLowerCase() : null;
    if (!state || !TERMINAL_STATES.has(state)) {
      return null;
    }
    const semantic = typeof record?.semanticStatus === "string" ? record.semanticStatus.toLowerCase() : null;
    return { state, semantic: semantic && SEMANTIC_STATES.has(semantic) ? semantic : "unverified" };
  }
  const lines = String(output).trimEnd().split(/\r?\n/);
  let index = lines.length - 1;
  const footer = [];
  while (index >= 0 && FOOTER_FIELD.test(lines[index])) {
    footer.unshift(lines[index]);
    index -= 1;
  }
  const states = footer.flatMap((line) => {
    const match = line.match(/^\s*state:\s*([^\s]+)\s*$/i);
    return match ? [match[1].toLowerCase()] : [];
  });
  if (states.length !== 1 || !TERMINAL_STATES.has(states[0])) {
    return null;
  }
  const semantics = footer.flatMap((line) => {
    const match = line.match(/^\s*semantic:\s*([^\s]+)\s*$/i);
    return match ? [match[1].toLowerCase()] : [];
  });
  const semantic = semantics.length === 1 && SEMANTIC_STATES.has(semantics[0]) ? semantics[0] : "unverified";
  return { state: states[0], semantic };
}

function terminalState(output, json = false) {
  return terminalMetadata(output, json)?.state ?? null;
}

function reportsDead(output, json = false) {
  if (json) {
    const record = parsedJson(output);
    return record?.failureKind === "died" || record?.failure === "died";
  }
  if (/^\s*(?:failure(?:\s+kind)?|failureKind)\s*:\s*died\b/im.test(output)) {
    return true;
  }
  if (!/^\s*status:\s*running\b/im.test(output)) {
    return false;
  }
  return output.split(/\r?\n/).some((line) => {
    if (!/\bpid\b/i.test(line)) {
      return false;
    }
    return /\b(?:dead|died|gone)\b|\bnot\s+(?:alive|running)\b|\b(?:alive|running)\s*:\s*false\b/i.test(line);
  });
}

function stderrTail(stderr) {
  const lines = stderr.trimEnd().split(/\r?\n/);
  return lines.slice(-STDERR_TAIL_LINES).join("\n");
}

function elapsedSeconds(startedAt) {
  return Math.floor((Date.now() - startedAt) / 1000);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function writeOutputWithFinalLine(output, line) {
  if (output) {
    process.stdout.write(output);
    if (!output.endsWith("\n")) {
      process.stdout.write("\n");
    }
  }
  process.stdout.write(`${line}\n`);
}

function collectorTerminalLine(options, metadata, startedAt) {
  return `collector: state=${metadata.state} semantic=${metadata.semantic} engine=${options.engine} job=${options.jobId} elapsed=${elapsedSeconds(startedAt)}s`;
}

function collectorOutcomeLine(options, outcome, startedAt) {
  return `collector: ${outcome} engine=${options.engine} job=${options.jobId} elapsed=${elapsedSeconds(startedAt)}s`;
}

export async function collect(options, { env = process.env } = {}) {
  const companion = resolveCompanion(options.engine, { env });
  const startedAt = Date.now();
  let consecutiveStatusErrors = 0;
  let lastStatusOutput = "";

  for (;;) {
    const remaining = options.capMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      writeOutputWithFinalLine(lastStatusOutput, collectorOutcomeLine(options, "timeout", startedAt));
      return 2;
    }
    const status = await runCompanion(companion, "status", options, remaining);
    if (status.stdout) {
      lastStatusOutput = status.stdout;
    }
    if (status.timedOut) {
      writeOutputWithFinalLine(lastStatusOutput, collectorOutcomeLine(options, "timeout", startedAt));
      return 2;
    }
    if (status.code === 0) {
      consecutiveStatusErrors = 0;
    } else {
      consecutiveStatusErrors += 1;
      if (consecutiveStatusErrors >= 2) {
        writeOutputWithFinalLine(stderrTail(status.stderr), collectorOutcomeLine(options, "status-error", startedAt));
        return 4;
      }
    }

    if (reportsDead(lastStatusOutput, options.json)) {
      if (options.deadRerunStatus) {
        const refreshRemaining = options.capMs - (Date.now() - startedAt);
        if (refreshRemaining <= 0) {
          writeOutputWithFinalLine(lastStatusOutput, collectorOutcomeLine(options, "timeout", startedAt));
          return 2;
        }
        const refreshed = await runCompanion(companion, "status", options, refreshRemaining);
        if (refreshed.timedOut) {
          writeOutputWithFinalLine(refreshed.stdout || lastStatusOutput, collectorOutcomeLine(options, "timeout", startedAt));
          return 2;
        }
        if (refreshed.stdout) {
          lastStatusOutput = refreshed.stdout;
        }
      }
      writeOutputWithFinalLine(lastStatusOutput, collectorOutcomeLine(options, "dead", startedAt));
      return 3;
    }

    const terminal = terminalMetadata(lastStatusOutput, options.json);
    if (terminal) {
      const resultRemaining = options.capMs - (Date.now() - startedAt);
      if (resultRemaining <= 0) {
        writeOutputWithFinalLine(lastStatusOutput, collectorOutcomeLine(options, "timeout", startedAt));
        return 2;
      }
      const result = await runCompanion(companion, "result", options, resultRemaining);
      if (result.timedOut) {
        writeOutputWithFinalLine(lastStatusOutput, collectorOutcomeLine(options, "timeout", startedAt));
        return 2;
      }
      writeOutputWithFinalLine(result.stdout, collectorTerminalLine(options, terminal, startedAt));
      return result.code;
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= options.capMs) {
      writeOutputWithFinalLine(lastStatusOutput, collectorOutcomeLine(options, "timeout", startedAt));
      return 2;
    }
    await sleep(Math.min(options.intervalMs, options.capMs - elapsed));
  }
}

export async function runCli(argv, { env = process.env } = {}) {
  if (argv[0] === "transport-create") {
    if (argv.length !== 1) {
      throw new UsageError("transport-create accepts no arguments.");
    }
    process.stdout.write(`${JSON.stringify(createRawArgsTransport({ sessionId: env.CLAUDE_CODE_SESSION_ID }))}\n`);
    return 0;
  }
  if (argv[0] === "transport-discard") {
    const token = tokenFromArgv(argv.slice(1));
    consumeRawArgsTransport(token, { sessionId: env.CLAUDE_CODE_SESSION_ID });
    return 0;
  }
  const token = tokenFromArgv(argv);
  const request = parseCollectionRequest(consumeRawArgsTransport(token, { sessionId: env.CLAUDE_CODE_SESSION_ID }));
  return collect(request, { env });
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n${usage()}\n`);
    process.exitCode = 1;
  }
}
