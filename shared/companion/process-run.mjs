import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const STDERR_MAX_BYTES = 64 * 1024;
const STREAM_MAX_BYTES = 2 * 1024 * 1024;
const CHILD_ENV_KEYS = ["PATH", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TMPDIR", "TZ", "USER", "LOGNAME", "SHELL", "JAVA_HOME", "GOROOT", "GOPATH", "CARGO_HOME", "RUSTUP_HOME", "PNPM_HOME", "BUN_INSTALL", "VOLTA_HOME", "MISE_DATA_DIR", "MISE_CONFIG_DIR", "MISE_CACHE_DIR", "ANDROID_HOME", "ANDROID_SDK_ROOT", "DEVELOPER_DIR", "SDKROOT"];

export function executablePath(bin, env, engineName) {
  const candidates = bin.includes(path.sep) ? [path.resolve(bin)] : String(env.PATH || "").split(path.delimiter).map((directory) => path.join(directory || ".", bin));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {}
  }
  const error = new Error(`${engineName} CLI executable not found: ${bin}`);
  error.failureKind = "missing_cli";
  throw error;
}

export function inheritChildEnv(env, extraKeys) {
  const allowed = new Set([...CHILD_ENV_KEYS, ...extraKeys]);
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key) || key.startsWith("LC_")));
}

function groupSignalable(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function clearRunTimers(run) {
  for (const timer of ["runTimer", "exitTimer", "killTimer", "drainTimer", "deadlineTimer"]) clearTimeout(run[timer]);
}

export function settleRun(run, release) {
  if (run.settled) return;
  run.settled = true;
  clearRunTimers(run);
  release?.(run);
  run.options.signal?.removeEventListener("abort", run.abort);
  run.resolve(run.outcome);
}

export function destroyRunStreams(run) {
  run.child.stdout.destroy();
  run.child.stderr.destroy();
  run.child.stdin.destroy();
}

export function runProcess(options, { outcome, state, start, abort }) {
  const run = {
    options,
    outcome: {
      exitCode: null, signal: null, sessionId: null, requestId: null, resultText: null,
      usage: null, observedModel: null, resultSeen: false, protocolError: null,
      policyViolation: null, timedOut: false, lateClose: false, cancelled: false, stderrTail: "", ...outcome
    },
    child: undefined, pid: undefined, resolve: undefined, abort: undefined,
    closed: false, settled: false, draining: false, stdoutRemainder: "",
    runTimer: undefined, exitTimer: undefined, killTimer: undefined, drainTimer: undefined, deadlineTimer: undefined,
    ...state
  };
  run.abort = () => abort(run);
  return new Promise((resolve) => start(run, resolve));
}

export function createProcessTransport({ processLine, onStreamOverflow, streamLength = (text) => text.length, preserveStderrUtf8 = false }) {
  function appendTail(previous, chunk) {
    const combined = Buffer.from(previous + chunk, "utf8");
    let start = Math.max(0, combined.length - STDERR_MAX_BYTES);
    if (preserveStderrUtf8) {
      while (start < combined.length && (combined[start] & 0xc0) === 0x80) start += 1;
    }
    return combined.subarray(start).toString("utf8");
  }

  function signalRunGroup(run, signal) {
    if (!Number.isInteger(run.pid) || run.pid <= 1) return;
    try {
      process.kill(-run.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") run.outcome.stderrTail = appendTail(run.outcome.stderrTail, `\n${error.message}`);
    }
  }

  function terminateRun(run, afterKill) {
    signalRunGroup(run, "SIGTERM");
    run.killTimer ??= setTimeout(() => {
      signalRunGroup(run, "SIGKILL");
      afterKill?.(run);
    }, run.options.killGraceMs);
  }

  async function finishProcessGroup(run) {
    signalRunGroup(run, "SIGTERM");
    const deadline = Date.now() + run.options.killGraceMs;
    while (groupSignalable(run.pid) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, Math.min(50, deadline - Date.now())));
    }
    if (groupSignalable(run.pid)) signalRunGroup(run, "SIGKILL");
  }

  function handleStdoutData(run, chunk) {
    run.stdoutRemainder += chunk;
    let newline;
    while ((newline = run.stdoutRemainder.indexOf("\n")) !== -1) {
      const line = run.stdoutRemainder.slice(0, newline).replace(/\r$/, "");
      run.stdoutRemainder = run.stdoutRemainder.slice(newline + 1);
      processLine(run, line);
    }
    if (streamLength(run.stdoutRemainder) > STREAM_MAX_BYTES) {
      run.stdoutRemainder = "";
      onStreamOverflow(run);
    }
  }

  function startProcess(run, resolve, args, handlers) {
    run.resolve = resolve;
    const { bin, cwd, env, launchProcess } = run.options;
    let spawned;
    const launch = () => {
      spawned = spawn(bin, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      spawned.on("error", () => {});
      return spawned;
    };
    try {
      run.child = launchProcess ? launchProcess(launch) : launch();
    } catch (error) {
      handlers.launchError(run, error, spawned);
      return false;
    }
    run.pid = run.child.pid;
    run.child.stdout.setEncoding("utf8");
    run.child.stderr.setEncoding("utf8");
    run.child.stdout.on("data", (chunk) => handleStdoutData(run, chunk));
    run.child.stderr.on("data", (chunk) => { run.outcome.stderrTail = appendTail(run.outcome.stderrTail, chunk); });
    run.child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") run.outcome.stderrTail = appendTail(run.outcome.stderrTail, `\n${error.message}`);
      handlers.stdinError?.(run, error);
    });
    run.child.on("error", (error) => {
      run.outcome.spawnError = error;
      run.outcome.stderrTail = appendTail(run.outcome.stderrTail, error.message);
      handlers.error?.(run, error);
    });
    run.child.on("exit", (code, signal) => handlers.exit(run, code, signal));
    run.child.on("close", (code, signal) => handlers.close(run, code, signal));
    if (handlers.spawn) run.child.once("spawn", () => handlers.spawn(run));
    return true;
  }

  return { appendTail, signalRunGroup, terminateRun, finishProcessGroup, startProcess };
}
