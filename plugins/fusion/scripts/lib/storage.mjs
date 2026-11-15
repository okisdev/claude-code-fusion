import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;

function ensureDirectory(file) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function removeOwnedLock(file, owner) {
  try {
    const current = fs.statSync(file);
    if (current.dev === owner.dev && current.ino === owner.ino) {
      fs.unlinkSync(file);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function reclaimStaleLock(file, staleMs) {
  try {
    const owner = fs.statSync(file);
    if (Date.now() - owner.mtimeMs <= staleMs) return false;
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if (error?.code !== "ESRCH") return false;
      }
    }
    removeOwnedLock(file, owner);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

export function withFileLock(file, fn, { timeoutMs, staleMs = LOCK_STALE_MS } = {}) {
  const configured = Number(process.env.FUSION_LOCK_TIMEOUT_MS);
  timeoutMs ??= Number.isSafeInteger(configured) && configured > 0 ? configured : LOCK_TIMEOUT_MS;
  ensureDirectory(file);
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  let descriptor;
  for (;;) {
    try {
      descriptor = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (reclaimStaleLock(lockFile, staleMs)) continue;
      if (Date.now() >= deadline) {
        const timeout = new Error("timed out waiting for Fusion worker state lock");
        timeout.code = "ETIMEDOUT";
        throw timeout;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(LOCK_RETRY_MS, Math.max(0, deadline - Date.now())));
    }
  }
  const owner = fs.fstatSync(descriptor);
  try {
    fs.writeFileSync(descriptor, String(process.pid));
    fs.fchmodSync(descriptor, 0o600);
    return fn();
  } finally {
    fs.closeSync(descriptor);
    removeOwnedLock(lockFile, owner);
  }
}

export function writeFileAtomic(file, content, mode = 0o600) {
  ensureDirectory(file);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
    try {
      fs.writeFileSync(descriptor, content);
      fs.fchmodSync(descriptor, mode);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function readJsonFile(file, fallback) {
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try {
      fs.lstatSync(file);
    } catch (statError) {
      if (statError?.code === "ENOENT") return fallback;
      throw statError;
    }
    throw error;
  }
  return JSON.parse(content);
}
