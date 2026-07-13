#!/usr/bin/env node

import { spawn } from "node:child_process";

class UsageError extends Error {}

const DEFAULT_INTERVAL_MS = 20_000;
const DEFAULT_CAP_MS = 2_400_000;
const STDERR_TAIL_LINES = 20;
const TERMINAL_STATES = new Set(["done", "error", "cancelled"]);

function usage() {
  return 'Usage: node job-collect.mjs --status-cmd "<shell command>" --result-cmd "<shell command>" [--interval-ms 20000] [--cap-ms 2400000] [--dead-rerun-status]';
}

function parseCli(argv) {
  const options = {};
  const valueOptions = new Set(["status-cmd", "result-cmd", "interval-ms", "cap-ms"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new UsageError(`Unexpected argument ${arg}.`);
    }
    const separator = arg.indexOf("=");
    const name = arg.slice(2, separator === -1 ? undefined : separator);
    const inlineValue = separator === -1 ? null : arg.slice(separator + 1);
    if (name === "dead-rerun-status") {
      if (inlineValue != null) {
        throw new UsageError("Option --dead-rerun-status does not take a value.");
      }
      options[name] = true;
      continue;
    }
    if (!valueOptions.has(name)) {
      throw new UsageError(`Unknown option --${name}.`);
    }
    if (inlineValue != null) {
      options[name] = inlineValue;
      continue;
    }
    index += 1;
    if (index >= argv.length) {
      throw new UsageError(`Expected a value after --${name}.`);
    }
    options[name] = argv[index];
  }
  if (!options["status-cmd"]) {
    throw new UsageError("Missing --status-cmd.");
  }
  if (!options["result-cmd"]) {
    throw new UsageError("Missing --result-cmd.");
  }
  return {
    statusCommand: options["status-cmd"],
    resultCommand: options["result-cmd"],
    intervalMs: parseMilliseconds(options["interval-ms"], DEFAULT_INTERVAL_MS, "--interval-ms"),
    capMs: parseMilliseconds(options["cap-ms"], DEFAULT_CAP_MS, "--cap-ms"),
    deadRerunStatus: options["dead-rerun-status"] === true
  };
}

function parseMilliseconds(value, fallback, flag) {
  if (value == null) {
    return fallback;
  }
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new UsageError(`${flag} must be a non-negative integer.`);
  }
  return Number(value);
}

function runShell(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        code: code ?? (signal ? 1 : 0),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function terminalState(output) {
  const stateLines = [...output.matchAll(/^\s*state:\s*([^\s]+).*$/gim)];
  if (stateLines.length > 0) {
    return stateLines.map((match) => match[1].toLowerCase()).find((state) => TERMINAL_STATES.has(state)) ?? null;
  }
  return output.match(/\b(completed|failed|cancelled|done|error)\b/i)?.[1]?.toLowerCase() ?? null;
}

function reportsDead(output) {
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

async function collect(options) {
  const startedAt = Date.now();
  let consecutiveStatusErrors = 0;
  let lastStatusOutput = "";

  for (;;) {
    const status = await runShell(options.statusCommand);
    lastStatusOutput = status.stdout;
    if (status.code === 0) {
      consecutiveStatusErrors = 0;
    } else {
      consecutiveStatusErrors += 1;
      if (consecutiveStatusErrors >= 2) {
        writeOutputWithFinalLine(stderrTail(status.stderr), `collector: status-error elapsed=${elapsedSeconds(startedAt)}s`);
        return 4;
      }
    }

    if (reportsDead(lastStatusOutput)) {
      if (options.deadRerunStatus) {
        const refreshed = await runShell(options.statusCommand);
        if (refreshed.stdout) {
          lastStatusOutput = refreshed.stdout;
        }
      }
      writeOutputWithFinalLine(lastStatusOutput, `collector: dead elapsed=${elapsedSeconds(startedAt)}s`);
      return 3;
    }

    const state = terminalState(lastStatusOutput);
    if (state) {
      const result = await runShell(options.resultCommand);
      writeOutputWithFinalLine(result.stdout, `collector: state=${state} elapsed=${elapsedSeconds(startedAt)}s`);
      return 0;
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= options.capMs) {
      writeOutputWithFinalLine(lastStatusOutput, `collector: timeout elapsed=${elapsedSeconds(startedAt)}s`);
      return 2;
    }
    await sleep(Math.min(options.intervalMs, options.capMs - elapsed));
  }
}

try {
  const exitCode = await collect(parseCli(process.argv.slice(2)));
  process.exitCode = exitCode;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n${usage()}\n`);
  process.exitCode = 1;
}
