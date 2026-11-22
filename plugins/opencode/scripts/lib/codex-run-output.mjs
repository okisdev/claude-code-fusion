import fs from "node:fs";
import { boundedBuffer, observeStderrPatterns } from "./codex-events.mjs";

const EVENT_FLUSH_MAX_BYTES = 64 * 1024;
const OUTPUT_FLUSH_INTERVAL_MS = 1000;
const PRIVATE_FILE_MODE = 0o600;

function outputWriteError(ctx, error) {
  ctx.state.callbackError = error instanceof Error ? error : new Error(String(error));
  ctx.requestTermination();
}

function flushEvents(ctx) {
  clearTimeout(ctx.eventFlushTimer);
  ctx.eventFlushTimer = null;
  if (ctx.eventsFd == null || ctx.eventBufferedBytes === 0) return;
  const pending = Buffer.concat(ctx.eventBuffers, ctx.eventBufferedBytes);
  let written = 0;
  try {
    while (written < pending.length) {
      const count = fs.writeSync(ctx.eventsFd, pending, written, pending.length - written);
      if (count <= 0) throw new Error("Codex event ledger write made no progress.");
      written += count;
    }
    ctx.eventBuffers = [];
    ctx.eventBufferedBytes = 0;
  } catch (error) {
    ctx.eventBuffers = [pending.subarray(written)];
    ctx.eventBufferedBytes = pending.length - written;
    outputWriteError(ctx, error);
  }
}

function flushStderr(ctx) {
  clearTimeout(ctx.stderrFlushTimer);
  ctx.stderrFlushTimer = null;
  if (!ctx.options.logFile || !ctx.stderrDirty) return;
  try {
    fs.writeFileSync(ctx.options.logFile, ctx.stderr);
    fs.chmodSync(ctx.options.logFile, PRIVATE_FILE_MODE);
    ctx.stderrDirty = false;
  } catch (error) {
    outputWriteError(ctx, error);
  }
}

function flushOutputs(ctx) {
  flushEvents(ctx);
  flushStderr(ctx);
}

function writeEventLine(ctx, lineBuffer) {
  if (ctx.eventsFd != null && !ctx.state.eventsTruncated) {
    const rawLine = Buffer.concat([lineBuffer, Buffer.from("\n")]);
    if (ctx.eventsBytes + rawLine.length <= ctx.eventsMaxBytes) {
      ctx.eventBuffers.push(rawLine);
      ctx.eventBufferedBytes += rawLine.length;
      ctx.eventsBytes += rawLine.length;
      if (ctx.eventBufferedBytes >= EVENT_FLUSH_MAX_BYTES) {
        flushEvents(ctx);
      } else if (ctx.eventFlushTimer == null) {
        ctx.eventFlushTimer = setTimeout(flushEvents, OUTPUT_FLUSH_INTERVAL_MS, ctx);
        ctx.eventFlushTimer.unref?.();
      }
    } else {
      ctx.state.eventsTruncated = true;
    }
  }
}

function observeStderr(ctx, chunk) {
  const { state } = ctx;
  if (!state.timedOut) {
    const { lostProcesses, patchFailures } = observeStderrPatterns(state, chunk);
    if (!state.patchThrash && patchFailures > 0) {
      state.patchFailureCount = Math.min(3, state.patchFailureCount + patchFailures);
      if (state.patchFailureCount === 3) {
        state.patchThrash = true;
        ctx.requestTermination();
      }
    }
    if (!state.execLost && lostProcesses > 0) {
      state.lostProcessCount = Math.min(3, state.lostProcessCount + lostProcesses);
      if (state.lostProcessCount === 3) {
        state.execLost = true;
        ctx.requestTermination();
      }
    }
  }
  ctx.stderr = boundedBuffer(ctx.stderr, chunk, ctx.stderrMaxBytes);
  if (ctx.options.logFile) {
    ctx.stderrDirty = true;
    if (ctx.stderrFlushTimer == null) {
      ctx.stderrFlushTimer = setTimeout(flushStderr, OUTPUT_FLUSH_INTERVAL_MS, ctx);
      ctx.stderrFlushTimer.unref?.();
    }
  }
}

export function createRunOutput({ options, state, eventsFd, eventsMaxBytes, stderrMaxBytes, requestTermination }) {
  const ctx = {
    options, state, eventsFd, eventsMaxBytes, stderrMaxBytes, requestTermination,
    stderr: Buffer.alloc(0), eventsBytes: 0, eventBuffers: [], eventBufferedBytes: 0,
    eventFlushTimer: null, stderrFlushTimer: null, stderrDirty: false
  };
  return {
    flushOutputs: flushOutputs.bind(null, ctx),
    getStderr: () => ctx.stderr,
    observeStderr: observeStderr.bind(null, ctx),
    writeEventLine: writeEventLine.bind(null, ctx)
  };
}
