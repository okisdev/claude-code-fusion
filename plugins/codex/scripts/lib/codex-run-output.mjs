import fs from "node:fs";
import { boundedBuffer, observeStderrPatterns } from "./codex-events.mjs";

const EVENT_FLUSH_MAX_BYTES = 64 * 1024;
const OUTPUT_FLUSH_INTERVAL_MS = 1000;
const PRIVATE_FILE_MODE = 0o600;

export function createRunOutput({ options, state, eventsFd, eventsMaxBytes, stderrMaxBytes, requestTermination }) {
  let stderr = Buffer.alloc(0);
  let eventsBytes = 0;
  let eventBuffers = [];
  let eventBufferedBytes = 0;
  let eventFlushTimer = null;
  let stderrFlushTimer = null;
  let stderrDirty = false;
  const outputWriteError = (error) => {
    state.callbackError = error instanceof Error ? error : new Error(String(error));
    requestTermination();
  };
  const flushEvents = () => {
    clearTimeout(eventFlushTimer);
    eventFlushTimer = null;
    if (eventsFd == null || eventBufferedBytes === 0) return;
    const pending = Buffer.concat(eventBuffers, eventBufferedBytes);
    let written = 0;
    try {
      while (written < pending.length) {
        const count = fs.writeSync(eventsFd, pending, written, pending.length - written);
        if (count <= 0) throw new Error("Codex event ledger write made no progress.");
        written += count;
      }
      eventBuffers = [];
      eventBufferedBytes = 0;
    } catch (error) {
      eventBuffers = [pending.subarray(written)];
      eventBufferedBytes = pending.length - written;
      outputWriteError(error);
    }
  };
  const flushStderr = () => {
    clearTimeout(stderrFlushTimer);
    stderrFlushTimer = null;
    if (!options.logFile || !stderrDirty) return;
    try {
      fs.writeFileSync(options.logFile, stderr);
      fs.chmodSync(options.logFile, PRIVATE_FILE_MODE);
      stderrDirty = false;
    } catch (error) {
      outputWriteError(error);
    }
  };
  const flushOutputs = () => {
    flushEvents();
    flushStderr();
  };
  const writeEventLine = (lineBuffer) => {
    if (eventsFd != null && !state.eventsTruncated) {
      const rawLine = Buffer.concat([lineBuffer, Buffer.from("\n")]);
      if (eventsBytes + rawLine.length <= eventsMaxBytes) {
        eventBuffers.push(rawLine);
        eventBufferedBytes += rawLine.length;
        eventsBytes += rawLine.length;
        if (eventBufferedBytes >= EVENT_FLUSH_MAX_BYTES) {
          flushEvents();
        } else if (eventFlushTimer == null) {
          eventFlushTimer = setTimeout(flushEvents, OUTPUT_FLUSH_INTERVAL_MS);
          eventFlushTimer.unref?.();
        }
      } else {
        state.eventsTruncated = true;
      }
    }
  };
  const observeStderr = (chunk) => {
    if (!state.timedOut) {
      const { lostProcesses, patchFailures } = observeStderrPatterns(state, chunk);
      if (!state.patchThrash && patchFailures > 0) {
        state.patchFailureCount = Math.min(3, state.patchFailureCount + patchFailures);
        if (state.patchFailureCount === 3) {
          state.patchThrash = true;
          requestTermination();
        }
      }
      if (!state.execLost && lostProcesses > 0) {
        state.lostProcessCount = Math.min(3, state.lostProcessCount + lostProcesses);
        if (state.lostProcessCount === 3) {
          state.execLost = true;
          requestTermination();
        }
      }
    }
    stderr = boundedBuffer(stderr, chunk, stderrMaxBytes);
    if (options.logFile) {
      stderrDirty = true;
      if (stderrFlushTimer == null) {
        stderrFlushTimer = setTimeout(flushStderr, OUTPUT_FLUSH_INTERVAL_MS);
        stderrFlushTimer.unref?.();
      }
    }
  };
  return { flushOutputs, getStderr: () => stderr, observeStderr, writeEventLine };
}
