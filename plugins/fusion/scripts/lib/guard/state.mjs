import { resolveLockTimeoutMs } from "./config.mjs";
import { DEFAULT_FLEET_WAVE_GAP_MS, LOCK_RETRY_MS, LOCK_STALE_MS, SESSION_ID_PATTERN, STALE_MS } from "./constants.mjs";
import { deriveFleetWaveState, normalizeDispatchLog, normalizeDispatches, pruneExpiredLaunchedDispatches, totalDispatches } from "./dispatch.mjs";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function normalizeSessionId(value) {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value) ? value : null;
}

function stateFile(stateDir, sessionId) {
  return path.join(stateDir, `${sessionId}.json`);
}

function readState(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    try {
      fs.lstatSync(file);
    } catch (statError) {
      if (statError?.code === "ENOENT") {
        return null;
      }
      throw statError;
    }
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Fusion inline write state must be a JSON object.");
  }
  return parsed;
}

function writeState(file, state) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tempFile = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const descriptor = fs.openSync(tempFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.fchmodSync(descriptor, 0o600);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(tempFile, file);
  fs.chmodSync(file, 0o600);
}

function waitForLock() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
}

function acquireStateLock(file) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + resolveLockTimeoutMs();
  for (;;) {
    try {
      const descriptor = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeFileSync(descriptor, String(process.pid));
      fs.fchmodSync(descriptor, 0o600);
      return () => {
        fs.closeSync(descriptor);
        fs.rmSync(lockFile, { force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") {
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for inline guard state lock");
      }
      waitForLock();
    }
  }
}

function withStateLock(file, callback) {
  const release = acquireStateLock(file);
  try {
    return callback();
  } finally {
    release();
  }
}

function withAvailableStateLock(file, callback) {
  const lockFile = `${file}.lock`;
  let descriptor;
  try {
    descriptor = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ENOENT") return;
    throw error;
  }
  try {
    callback();
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lockFile, { force: true });
  }
}

function pruneStaleState(stateDir) {
  let entries;
  try {
    entries = fs.readdirSync(stateDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const file = path.join(stateDir, entry);
    try {
      withAvailableStateLock(file, () => {
        const stat = fs.statSync(file);
        if (now - stat.mtimeMs > STALE_MS) fs.rmSync(file, { force: true });
      });
    } catch {
      void 0;
    }
  }
}

function defaultState(now) {
  return {
    writeCount: 0,
    writesSinceDispatch: 0,
    inlineWriteBytes: 0,
    tailWritesSinceDispatch: 0,
    writtenPathSignatures: [],
    confirmedPathSignatures: [],
    dispatchEpoch: 0,
    lastDispatchAt: null,
    fleetWaveWidth: 0,
    consecutiveNarrowWaves: 0,
    lastAdvisedNarrowWaveStreak: 0,
    advisedNarrowWaveSignatures: [],
    pendingWrites: [],
    dispatches: {},
    dispatchLog: [],
    advisedMultiples: [],
    advisorySignatures: {},
    createdAt: now,
    updatedAt: now
  };
}

function normalizeAdvisedMultiples(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((multiple) => Number.isInteger(multiple) && multiple > 0))];
}

function normalizeWrittenPathSignatures(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((signature) => typeof signature === "string" && /^[a-f0-9]{64}$/.test(signature)))];
}

function normalizeAdvisorySignatures(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const signatures = {};
  for (const [kind, signature] of Object.entries(value)) {
    if (/^[a-z][a-z0-9-]{0,79}$/.test(kind) && typeof signature === "string" && signature.length > 0 && signature.length <= 1024) {
      signatures[kind] = signature;
    }
  }
  return signatures;
}

function normalizeState(existing, now, waveGapMs = DEFAULT_FLEET_WAVE_GAP_MS) {
  if (!existing || typeof existing !== "object") {
    return defaultState(now);
  }
  const writeCount = Number.isFinite(existing.writeCount) && existing.writeCount >= 0 ? Math.floor(existing.writeCount) : 0;
  const dispatches = normalizeDispatches(existing.dispatches);
  const dispatchCount = totalDispatches(dispatches);
  const writesSinceDispatch = Number.isFinite(existing.writesSinceDispatch) && existing.writesSinceDispatch >= 0 ? Math.floor(existing.writesSinceDispatch) : 0;
  const inlineWriteBytes = Number.isSafeInteger(existing.inlineWriteBytes) && existing.inlineWriteBytes >= 0 ? existing.inlineWriteBytes : 0;
  const tailWritesSinceDispatch =
    Number.isSafeInteger(existing.tailWritesSinceDispatch) && existing.tailWritesSinceDispatch >= 0 ? existing.tailWritesSinceDispatch : 0;
  const writtenPathSignatures = normalizeWrittenPathSignatures(existing.writtenPathSignatures);
  const confirmedPathSignatures = normalizeWrittenPathSignatures(existing.confirmedPathSignatures ?? existing.writtenPathSignatures);
  const advisedMultiples = normalizeAdvisedMultiples(existing.advisedMultiples);
  const advisorySignatures = normalizeAdvisorySignatures(existing.advisorySignatures);
  const dispatchLog = pruneExpiredLaunchedDispatches(normalizeDispatchLog(existing.dispatchLog), now);
  const createdAtMs = Date.parse(existing.createdAt);
  const lastDispatchAtMs = Date.parse(existing.lastDispatchAt);
  const derivedFleetWaveState = deriveFleetWaveState(dispatchLog, waveGapMs);
  const fleetWaveWidth = Number.isInteger(existing.fleetWaveWidth) && existing.fleetWaveWidth >= 0 ? existing.fleetWaveWidth : derivedFleetWaveState.fleetWaveWidth;
  const consecutiveNarrowWaves =
    Number.isInteger(existing.consecutiveNarrowWaves) && existing.consecutiveNarrowWaves >= 0 ? existing.consecutiveNarrowWaves : derivedFleetWaveState.consecutiveNarrowWaves;
  const lastAdvisedNarrowWaveStreak =
    Number.isInteger(existing.lastAdvisedNarrowWaveStreak) && existing.lastAdvisedNarrowWaveStreak >= 0 ? existing.lastAdvisedNarrowWaveStreak : 0;
  const advisedNarrowWaveSignatures = Array.isArray(existing.advisedNarrowWaveSignatures)
    ? existing.advisedNarrowWaveSignatures.filter((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) : [];
  const pendingWrites = Array.isArray(existing.pendingWrites) ? existing.pendingWrites.filter((entry) =>
    entry && typeof entry.id === "string" && Number.isInteger(entry.epoch) && Number.isSafeInteger(entry.bytes) &&
    typeof entry.signature === "string" && typeof entry.tail === "boolean") : [];
  return {
    writeCount,
    writesSinceDispatch,
    inlineWriteBytes,
    tailWritesSinceDispatch,
    writtenPathSignatures,
    confirmedPathSignatures,
    dispatchEpoch: Number.isInteger(existing.dispatchEpoch) && existing.dispatchEpoch >= 0 ? existing.dispatchEpoch : dispatchCount,
    lastDispatchAt: Number.isFinite(lastDispatchAtMs) ? new Date(lastDispatchAtMs).toISOString() : null,
    fleetWaveWidth,
    consecutiveNarrowWaves,
    lastAdvisedNarrowWaveStreak,
    advisedNarrowWaveSignatures,
    pendingWrites,
    dispatches,
    dispatchLog,
    advisedMultiples,
    advisorySignatures,
    createdAt: Number.isFinite(createdAtMs) ? new Date(createdAtMs).toISOString() : now,
    updatedAt: now
  };
}

function stableAdvisorySignature(values) {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function claimAdvisory(file, kind, signature, now, waveGapMs, isCurrent = () => true) {
  try {
    return withStateLock(file, () => {
      const state = normalizeState(readState(file), now, waveGapMs);
      if (!isCurrent(state)) {
        return { skipped: true, suppressed: false };
      }
      const suppressed = state.advisorySignatures[kind] === signature;
      state.advisorySignatures[kind] = signature;
      writeState(file, state);
      return { skipped: false, suppressed };
    });
  } catch {
    return { skipped: false, suppressed: false };
  }
}

function resetWriteWindow(state) {
  state.writesSinceDispatch = 0;
  state.tailWritesSinceDispatch = 0;
  state.writtenPathSignatures = [];
  state.confirmedPathSignatures = [];
  state.advisedMultiples = [];
}

export { normalizeSessionId, stateFile, readState, writeState, waitForLock, acquireStateLock, withStateLock, withAvailableStateLock, pruneStaleState, defaultState, normalizeAdvisedMultiples, normalizeWrittenPathSignatures, normalizeAdvisorySignatures, normalizeState, stableAdvisorySignature, claimAdvisory, resetWriteWindow };
