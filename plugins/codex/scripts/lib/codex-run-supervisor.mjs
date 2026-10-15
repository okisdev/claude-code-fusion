import { spawn } from "node:child_process";
import fs from "node:fs";
import { getProcessIdentity, processGroupAlive, processIsDirectlyAlive as directProcessAlive } from "./process-identity.mjs";
import { signalExitCode, recordProtocolError, recordResourceError, parseCodexEventStream } from "./codex-events.mjs";
import { createRunOutput } from "./codex-run-output.mjs";

const FORCED_CLOSE_MS = 2000;
const POST_CLOSE_DRAIN_MS = 10000;

function startSupervisor(ctx) {
  const { options, state, eventsFd, eventsMaxBytes, stderrMaxBytes, bin, args, env, terminateProcessTree } = ctx;
  ctx.terminationRequested = false;
  ctx.terminationPromise = null;
  ctx.closeResolved = false;
  ctx.closedAtMs = null;
  ctx.forcedClosePromise = new Promise((resolve) => { ctx.resolveForcedClose = resolve; });
  ctx.forwardedSignals = process.platform === "win32" ? ["SIGTERM", "SIGINT"] : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];
  ctx.requestTermination = () => Promise.resolve(false);
  ctx.output = createRunOutput({ options, state, eventsFd, eventsMaxBytes, stderrMaxBytes,
    requestTermination: () => { if (!ctx.terminationRequested) void ctx.requestTermination(); } });
  process.on("exit", ctx.output.flushOutputs);
  ctx.forwardTermination = () => {
    state.cancelled = true;
    void ctx.requestTermination();
  };
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
  ctx.requestTermination = () => {
    if (!ctx.terminationPromise) {
      ctx.terminationRequested = true;
      ctx.output.flushOutputs();
      ctx.terminationPromise = terminateProcessTree(ctx.child.pid, {
        allowOrphanedGroup: true,
        graceMs: options.terminationGraceMs,
        pollMs: options.terminationPollMs,
        identity: ctx.childIdentity ?? undefined,
        ownsProcessGroup: process.platform !== "win32",
        requireIdentity: Boolean(ctx.childIdentity)
      }).then((terminated) => {
        state.cleanupComplete = terminated;
        if (!ctx.closeResolved) {
          ctx.forcedCloseTimer = setTimeout(() => {
            state.cleanupComplete = false;
            ctx.child.stdin?.destroy();
            ctx.child.stdout?.destroy();
            ctx.child.stderr?.destroy();
            ctx.child.unref();
            ctx.resolveForcedClose({ code: null, exitCode: null, forced: true, signal: null });
          }, FORCED_CLOSE_MS);
        }
        return terminated;
      });
    }
    return ctx.terminationPromise;
  };
}

function attachChildLifecycle(ctx) {
  const { child, state, options, prompt, settleProcessIdentity, executionTimeoutMs, terminationReserveMs } = ctx;
  try {
    options.onSpawnAttempt?.(child.pid ?? null);
  } catch (error) {
    state.callbackError = error instanceof Error ? error : new Error(String(error));
    void ctx.requestTermination();
  }
  ctx.childIdentity = Number.isInteger(child.pid) ? getProcessIdentity(child.pid) : null;
  if (Number.isInteger(child.pid) && !ctx.childIdentity) {
    state.callbackError = new Error("Codex process identity could not be verified.");
    void ctx.requestTermination();
  } else if (state.cancelled) {
    void ctx.requestTermination();
  }
  ctx.identitySettlePromise = ctx.childIdentity
    ? settleProcessIdentity(child.pid).then(async (settled) => {
        if (settled) ctx.childIdentity = settled;
        try {
          await options.onIdentitySettled?.(child.pid ?? null, ctx.childIdentity);
        } catch (error) {
          state.callbackError = error instanceof Error ? error : new Error(String(error));
          void ctx.requestTermination();
        }
      })
    : Promise.resolve();
  child.once("error", (error) => { ctx.spawnError = error; });
  ctx.closePromise = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      ctx.closeResolved = true;
      ctx.closedAtMs = Date.now();
      ctx.output.flushOutputs();
      clearTimeout(ctx.executionTimer);
      clearTimeout(ctx.forcedCloseTimer);
      resolve({ code, exitCode: Number.isInteger(code) ? code : signalExitCode(signal), signal });
    });
  });
  ctx.stdinSettled = new Promise((resolve) => {
    if (!child.stdin) {
      if (prompt) {
        state.stdinError = new Error("Codex process did not expose stdin.");
        void ctx.requestTermination();
      }
      resolve();
      return;
    }
    let settled = false;
    const settle = () => { if (!settled) { settled = true; resolve(); } };
    child.stdin.once("error", (error) => {
      if (prompt) {
        state.stdinError = error;
        void ctx.requestTermination();
      }
      settle();
    });
    child.stdin.once("close", settle);
    child.stdin.end(prompt);
  });
  const timerMs = options.deadlineMs == null
    ? executionTimeoutMs
    : Math.max(0, Math.min(executionTimeoutMs, options.deadlineMs - Date.now() - terminationReserveMs));
  ctx.executionTimer = setTimeout(() => {
    if (ctx.closeResolved) return;
    if ((child.exitCode !== null || child.signalCode !== null) &&
      (process.platform === "win32" || !processGroupAlive(child.pid))) {
      ctx.forcedCloseTimer = setTimeout(() => {
        state.outputAbandoned = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, FORCED_CLOSE_MS);
      return;
    }
    state.timedOut = true;
    void ctx.requestTermination();
  }, timerMs);
  ctx.executionTimer.unref?.();
}

async function observeSpawnCheckpoint(ctx) {
  try {
    if (ctx.childIdentity) await ctx.options.onSpawn?.(ctx.child.pid ?? null, ctx.childIdentity);
  } catch (error) {
    ctx.state.callbackError = error instanceof Error ? error : new Error(String(error));
    void ctx.requestTermination();
  }
}

function attachStreams(ctx) {
  const { child, state, options, eventLineMaxBytes } = ctx;
  child.stderr?.on("data", ctx.output.observeStderr);
  const spawnCheckpointPromise = observeSpawnCheckpoint(ctx);
  ctx.abort = () => {
    state.cancelled = true;
    void ctx.requestTermination();
  };
  if (options.signal?.aborted) ctx.abort();
  else options.signal?.addEventListener("abort", ctx.abort, { once: true });
  ctx.parsePromise = parseCodexEventStream({ child, state, spawnCheckpointPromise, options, eventLineMaxBytes,
    writeEventLine: ctx.output.writeEventLine, requestTermination: ctx.requestTermination });
}

async function drainSupervisor(ctx) {
  await ctx.stdinSettled;
  await ctx.parsePromise;
  await ctx.identitySettlePromise;
  if (ctx.terminationPromise) await ctx.terminationPromise;
}

async function finishSupervisor(ctx) {
  const { child, state, options, eventsFd, eventLineMaxBytes } = ctx;
  const processOutcome = await Promise.race([ctx.closePromise, ctx.forcedClosePromise]);
  clearTimeout(ctx.executionTimer);
  if (!ctx.terminationPromise && ctx.childIdentity && process.platform !== "win32" && !directProcessAlive(child.pid) && processGroupAlive(child.pid)) {
    void ctx.requestTermination();
  }
  try {
    const drain = drainSupervisor(ctx);
    let drainTimer;
    const drained = await Promise.race([
      drain.then(() => true),
      new Promise((resolve) => {
        const remainingMs = Math.max(0, (ctx.closedAtMs ?? Date.now()) + POST_CLOSE_DRAIN_MS - Date.now());
        drainTimer = setTimeout(() => resolve(false), remainingMs);
      })
    ]);
    clearTimeout(drainTimer);
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
