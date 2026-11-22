import { spawn } from "node:child_process";
import fs from "node:fs";
import { getProcessIdentity, processGroupAlive, processIsDirectlyAlive as directProcessAlive } from "./process-identity.mjs";
import { signalExitCode, recordProtocolError, recordResourceError, parseCodexEventStream } from "./codex-events.mjs";
import { createRunOutput } from "./codex-run-output.mjs";

const FORCED_CLOSE_MS = 2000;
const POST_CLOSE_DRAIN_MS = 10000;

function resolveForcedClose(ctx, resolve) {
  ctx.resolveForcedClose = resolve;
}

function requestTerminationIfNeeded(ctx) {
  if (!ctx.terminationRequested) void requestTermination(ctx);
}

function forwardTermination(ctx) {
  ctx.state.cancelled = true;
  void requestTermination(ctx);
}

function abort(ctx) {
  ctx.state.cancelled = true;
  void requestTermination(ctx);
}

function forceClose(ctx) {
  ctx.state.cleanupComplete = false;
  ctx.child.stdin?.destroy();
  ctx.child.stdout?.destroy();
  ctx.child.stderr?.destroy();
  ctx.child.unref();
  ctx.resolveForcedClose({ code: null, exitCode: null, forced: true, signal: null });
}

function afterTermination(ctx, terminated) {
  ctx.state.cleanupComplete = terminated;
  if (!ctx.closeResolved) {
    ctx.forcedCloseTimer = setTimeout(() => forceClose(ctx), FORCED_CLOSE_MS);
  }
  return terminated;
}

function requestTermination(ctx) {
  if (!ctx.terminationReady) return Promise.resolve(false);
  if (!ctx.terminationPromise) {
    ctx.terminationRequested = true;
    ctx.output.flushOutputs();
    ctx.terminationPromise = ctx.terminateProcessTree(ctx.child.pid, {
      allowOrphanedGroup: true,
      graceMs: ctx.options.terminationGraceMs,
      pollMs: ctx.options.terminationPollMs,
      identity: ctx.childIdentity ?? undefined,
      ownsProcessGroup: process.platform !== "win32",
      requireIdentity: Boolean(ctx.childIdentity)
    }).then((terminated) => afterTermination(ctx, terminated));
  }
  return ctx.terminationPromise;
}

function startSupervisor(ctx) {
  const { options, state, eventsFd, eventsMaxBytes, stderrMaxBytes, bin, args, env } = ctx;
  ctx.terminationRequested = false;
  ctx.terminationPromise = null;
  ctx.terminationReady = false;
  ctx.closeResolved = false;
  ctx.closedAtMs = null;
  ctx.forcedClosePromise = new Promise((resolve) => resolveForcedClose(ctx, resolve));
  ctx.forwardedSignals = process.platform === "win32" ? ["SIGTERM", "SIGINT"] : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];
  ctx.output = createRunOutput({ options, state, eventsFd, eventsMaxBytes, stderrMaxBytes,
    requestTermination: () => requestTerminationIfNeeded(ctx) });
  process.on("exit", ctx.output.flushOutputs);
  ctx.forwardTermination = () => forwardTermination(ctx);
  for (const signal of ctx.forwardedSignals) process.on(signal, ctx.forwardTermination);
  try {
    ctx.child = spawn(bin, args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true
    });
  } catch (error) {
    for (const signal of ctx.forwardedSignals) process.removeListener(signal, ctx.forwardTermination);
    process.removeListener("exit", ctx.output.flushOutputs);
    ctx.output.flushOutputs();
    if (eventsFd != null) fs.closeSync(eventsFd);
    throw error;
  }
  ctx.terminationReady = true;
}

async function identitySettled(ctx, settled) {
  if (settled) ctx.childIdentity = settled;
  try {
    await ctx.options.onIdentitySettled?.(ctx.child.pid ?? null, ctx.childIdentity);
  } catch (error) {
    ctx.state.callbackError = error instanceof Error ? error : new Error(String(error));
    void requestTermination(ctx);
  }
}

function recordSpawnError(ctx, error) {
  ctx.spawnError = error;
}

function childClosed(ctx, resolve, code, signal) {
  ctx.closeResolved = true;
  ctx.closedAtMs = Date.now();
  ctx.output.flushOutputs();
  clearTimeout(ctx.executionTimer);
  clearTimeout(ctx.forcedCloseTimer);
  resolve({ code, exitCode: Number.isInteger(code) ? code : signalExitCode(signal), signal });
}

function attachCloseListener(ctx, resolve) {
  ctx.child.once("close", (code, signal) => childClosed(ctx, resolve, code, signal));
}

function settle(ctx, resolve) {
  if (!ctx.stdinSettledResolved) {
    ctx.stdinSettledResolved = true;
    resolve();
  }
}

function stdinError(ctx, resolve, error) {
  if (ctx.prompt) {
    ctx.state.stdinError = error;
    void requestTermination(ctx);
  }
  settle(ctx, resolve);
}

function attachStdin(ctx, resolve) {
  if (!ctx.child.stdin) {
    if (ctx.prompt) {
      ctx.state.stdinError = new Error("Codex process did not expose stdin.");
      void requestTermination(ctx);
    }
    resolve();
    return;
  }
  ctx.stdinSettledResolved = false;
  ctx.child.stdin.once("error", (error) => stdinError(ctx, resolve, error));
  ctx.child.stdin.once("close", () => settle(ctx, resolve));
  ctx.child.stdin.end(ctx.prompt);
}

function abandonOutput(ctx) {
  ctx.state.outputAbandoned = true;
  ctx.child.stdout?.destroy();
  ctx.child.stderr?.destroy();
}

function executionTimedOut(ctx) {
  if (ctx.closeResolved) return;
  if ((ctx.child.exitCode !== null || ctx.child.signalCode !== null) &&
    (process.platform === "win32" || !processGroupAlive(ctx.child.pid))) {
    ctx.forcedCloseTimer = setTimeout(() => abandonOutput(ctx), FORCED_CLOSE_MS);
    return;
  }
  ctx.state.timedOut = true;
  void requestTermination(ctx);
}

function attachChildLifecycle(ctx) {
  const { child, state, options, settleProcessIdentity, executionTimeoutMs, terminationReserveMs } = ctx;
  try {
    options.onSpawnAttempt?.(child.pid ?? null);
  } catch (error) {
    state.callbackError = error instanceof Error ? error : new Error(String(error));
    void requestTermination(ctx);
  }
  ctx.childIdentity = Number.isInteger(child.pid) ? getProcessIdentity(child.pid) : null;
  if (Number.isInteger(child.pid) && !ctx.childIdentity) {
    state.callbackError = new Error("Codex process identity could not be verified.");
    void requestTermination(ctx);
  } else if (state.cancelled) {
    void requestTermination(ctx);
  }
  ctx.identitySettlePromise = ctx.childIdentity
    ? settleProcessIdentity(child.pid).then((settled) => identitySettled(ctx, settled))
    : Promise.resolve();
  child.once("error", (error) => recordSpawnError(ctx, error));
  ctx.closePromise = new Promise((resolve) => attachCloseListener(ctx, resolve));
  ctx.stdinSettled = new Promise((resolve) => attachStdin(ctx, resolve));
  const timerMs = options.deadlineMs == null
    ? executionTimeoutMs
    : Math.max(0, Math.min(executionTimeoutMs, options.deadlineMs - Date.now() - terminationReserveMs));
  ctx.executionTimer = setTimeout(() => executionTimedOut(ctx), timerMs);
  ctx.executionTimer.unref?.();
}

async function observeSpawnCheckpoint(ctx) {
  try {
    if (ctx.childIdentity) await ctx.options.onSpawn?.(ctx.child.pid ?? null, ctx.childIdentity);
  } catch (error) {
    ctx.state.callbackError = error instanceof Error ? error : new Error(String(error));
    void requestTermination(ctx);
  }
}

function attachStreams(ctx) {
  const { child, state, options, eventLineMaxBytes } = ctx;
  child.stderr?.on("data", ctx.output.observeStderr);
  const spawnCheckpointPromise = observeSpawnCheckpoint(ctx);
  ctx.abort = () => abort(ctx);
  if (options.signal?.aborted) abort(ctx);
  else options.signal?.addEventListener("abort", ctx.abort, { once: true });
  ctx.parsePromise = parseCodexEventStream({ child, state, spawnCheckpointPromise, options, eventLineMaxBytes,
    writeEventLine: ctx.output.writeEventLine, requestTermination: () => requestTermination(ctx) });
}

async function drainSupervisor(ctx) {
  await ctx.stdinSettled;
  await ctx.parsePromise;
  await ctx.identitySettlePromise;
  if (ctx.terminationPromise) await ctx.terminationPromise;
}

function drainSucceeded(ctx) {
  return true;
}

function setDrainTimer(ctx, resolve) {
  const remainingMs = Math.max(0, (ctx.closedAtMs ?? Date.now()) + POST_CLOSE_DRAIN_MS - Date.now());
  ctx.drainTimer = setTimeout(resolve, remainingMs, false);
}

async function finishSupervisor(ctx) {
  const { child, state, options, eventsFd, eventLineMaxBytes } = ctx;
  const processOutcome = await Promise.race([ctx.closePromise, ctx.forcedClosePromise]);
  clearTimeout(ctx.executionTimer);
  if (!ctx.terminationPromise && ctx.childIdentity && process.platform !== "win32" && !directProcessAlive(child.pid) && processGroupAlive(child.pid)) {
    void requestTermination(ctx);
  }
  try {
    const drain = drainSupervisor(ctx);
    const drained = await Promise.race([
      drain.then(() => drainSucceeded(ctx)),
      new Promise((resolve) => setDrainTimer(ctx, resolve))
    ]);
    clearTimeout(ctx.drainTimer);
    if (!drained) {
      state.callbackError = new Error(`Codex output did not finish draining within ${POST_CLOSE_DRAIN_MS}ms after close.`);
      child.stdout?.destroy();
    }
  } finally {
    clearTimeout(ctx.executionTimer);
    ctx.output.flushOutputs();
    process.removeListener("exit", ctx.output.flushOutputs);
    for (const signal of ctx.forwardedSignals) process.removeListener(signal, ctx.forwardTermination);
    options.signal?.removeEventListener("abort", ctx.abort);
  }
  if (eventsFd != null) fs.closeSync(eventsFd);
  if (!state.timedOut && !state.cancelled && !ctx.spawnError && !state.callbackError && processOutcome.exitCode === 0 && !processOutcome.signal) {
    const protocolIncomplete = !state.threadStarted || !state.turnStarted || !state.terminalEvent;
    if (protocolIncomplete && state.oversizedEventsSkipped > 0) {
      recordResourceError(state, `Codex emitted a JSONL event larger than the ${eventLineMaxBytes} byte limit.`);
    } else if (!state.threadStarted) {
      recordProtocolError(state, "Codex exited without thread.started.");
    } else if (!state.turnStarted) {
      recordProtocolError(state, "Codex exited without turn.started.");
    } else if (!state.terminalEvent) {
      recordProtocolError(state, "Codex reached EOF without a terminal turn event.");
    }
  }
  return { processOutcome, child, childIdentity: ctx.childIdentity, spawnError: ctx.spawnError, stderr: ctx.output.getStderr() };
}

export async function superviseCodex(ctx) {
  startSupervisor(ctx);
  attachChildLifecycle(ctx);
  attachStreams(ctx);
  return finishSupervisor(ctx);
}
