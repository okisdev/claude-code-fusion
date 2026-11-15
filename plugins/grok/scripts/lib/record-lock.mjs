import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  getProcessIdentity,
  processIdentitiesMatch,
  processIdentityMatches,
  processIsDirectlyAlive,
  validProcessIdentity
} from "./process-identity.mjs";

const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 10000;
const PRIVATE_FILE_MODE = 0o600;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let recordLockDeps;

export function configureRecordLock({ atomicWriteFile, ensurePrivateDir, ensurePrivateStatePath, resolveLockTimeoutMs, reaperClaimPath = reaperClaimSlot, onReleaseError }) {
  recordLockDeps = { atomicWriteFile, ensurePrivateDir, ensurePrivateStatePath, resolveLockTimeoutMs, reaperClaimPath, onReleaseError };
}

function lockOwnerDir(lockDir, token) {
  return `${lockDir}.owner.${token}`;
}

function validLockRecord(record) {
  return Boolean(
    record &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      record.version === 1 &&
      typeof record.token === "string" &&
      /^[a-f0-9]{32}$/.test(record.token) &&
      Number.isInteger(record.ownerPid) &&
      record.ownerPid > 1 &&
      validProcessIdentity(record.ownerIdentity)
  );
}

function lockOwnerIdentity() {
  const identity = getProcessIdentity(process.pid);
  if (!validProcessIdentity(identity)) {
    throw new Error(`Unable to verify lock owner process ${process.pid}.`);
  }
  return identity;
}

function readLockRecord(lockDir) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    return validLockRecord(record) ? record : null;
  } catch {
    return null;
  }
}

function lockOwnerWasReplaced(record) {
  if (processIdentityMatches(record.ownerPid, record.ownerIdentity)) {
    return false;
  }
  const currentIdentity = getProcessIdentity(record.ownerPid);
  if (currentIdentity) {
    return !processIdentitiesMatch(currentIdentity, record.ownerIdentity);
  }
  return !processIsDirectlyAlive(record.ownerPid);
}

function lockTargetsToken(lockDir, token) {
  try {
    return fs.lstatSync(lockDir).isSymbolicLink() && path.resolve(path.dirname(lockDir), fs.readlinkSync(lockDir)) === lockOwnerDir(lockDir, token);
  } catch {
    return false;
  }
}

function publishPreparedLock(lockDir, ownerDir) {
  try {
    fs.symlinkSync(path.basename(ownerDir), lockDir, "dir");
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

function createLinkedOwner(linkPath, record, deps, retryMissingDirectory = true) {
  const ownerDir = lockOwnerDir(linkPath, record.token);
  const preparedDir = `${ownerDir}.prepare.${process.pid}.${randomBytes(8).toString("hex")}`;
  deps.ensurePrivateDir(preparedDir);
  try {
    deps.atomicWriteFile(path.join(preparedDir, "owner.json"), `${JSON.stringify(record)}\n`, retryMissingDirectory);
    fs.renameSync(preparedDir, ownerDir);
    return { ownerDir, published: publishPreparedLock(linkPath, ownerDir) };
  } catch (error) {
    try {
      fs.rmSync(ownerDir, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(preparedDir, { recursive: true, force: true });
    } catch {}
    throw error;
  }
}

function publishLockCandidate(lockDir, record, deps) {
  const candidate = createLinkedOwner(lockDir, record, deps);
  if (candidate.published) {
    return null;
  }
  return candidate.ownerDir;
}

function linkedPathExists(linkPath) {
  try {
    fs.lstatSync(linkPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function reaperClaimSlot(lockDir, token, predecessorToken) {
  return `${lockDir}.reap.${token}${predecessorToken ? `.successor-${predecessorToken}` : ""}`;
}

function claimTeardownError(error) {
  return ["ENOENT", "EINVAL", "ENOTDIR", "ENOTEMPTY"].includes(error?.code);
}

function acquireReaperClaim(lockDir, ownerToken, deps) {
  if (!lockTargetsToken(lockDir, ownerToken)) return null;
  const claim = {
    version: 1,
    token: randomBytes(16).toString("hex"),
    ownerPid: process.pid,
    ownerIdentity: lockOwnerIdentity()
  };
  const primarySlot = deps.reaperClaimPath(lockDir, ownerToken);
  let slot = primarySlot;
  const observedTokens = new Set();
  for (;;) {
    if (!lockTargetsToken(lockDir, ownerToken)) return null;
    const existing = readLockRecord(slot);
    if (!existing) {
      try {
        if (linkedPathExists(slot)) {
          return null;
        }
        const candidate = createLinkedOwner(slot, claim, deps, false);
        if (candidate.published) {
          if (!lockTargetsToken(lockDir, ownerToken)) {
            releaseLock(slot, claim.token, deps);
            return null;
          }
          return { slot, token: claim.token };
        }
        fs.rmSync(candidate.ownerDir, { recursive: true, force: true });
      } catch (error) {
        if (claimTeardownError(error)) {
          return null;
        }
        throw error;
      }
      continue;
    }
    if (!lockTargetsToken(lockDir, ownerToken) || !lockTargetsToken(slot, existing.token) || !lockOwnerWasReplaced(existing)) {
      return null;
    }
    if (observedTokens.has(existing.token)) {
      return null;
    }
    observedTokens.add(existing.token);
    slot = deps.reaperClaimPath(lockDir, ownerToken, existing.token);
  }
}

function cleanupReaperClaims(lockDir, ownerToken, deps) {
  const dir = path.dirname(lockDir);
  const prefix = path.basename(deps.reaperClaimPath(lockDir, ownerToken));
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry !== prefix && !entry.startsWith(`${prefix}.`) && !entry.startsWith(`${prefix}-successor-`)) {
      continue;
    }
    try {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    } catch {}
  }
}

function reclaimReplacedLock(lockDir, observed, deps) {
  if (!observed || !lockOwnerWasReplaced(observed)) {
    return false;
  }
  const claim = acquireReaperClaim(lockDir, observed.token, deps);
  if (!claim) {
    return false;
  }
  let reaped = false;
  try {
    const current = readLockRecord(lockDir);
    if (current?.token !== observed.token || !lockTargetsToken(lockDir, observed.token) || !lockOwnerWasReplaced(current)) {
      return false;
    }
    fs.unlinkSync(lockDir);
    reaped = true;
    try {
      fs.rmSync(lockOwnerDir(lockDir, observed.token), { recursive: true, force: true });
    } catch {}
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }
    throw error;
  } finally {
    if (reaped) {
      try {
        releaseLock(claim.slot, claim.token, deps);
      } catch {}
      cleanupReaperClaims(lockDir, observed.token, deps);
    } else {
      releaseLock(claim.slot, claim.token, deps);
    }
  }
}

function linkedOwnerDir(linkPath) {
  try {
    if (!fs.lstatSync(linkPath).isSymbolicLink()) {
      return null;
    }
    const ownerDir = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
    if (path.dirname(ownerDir) !== path.dirname(linkPath) || !path.basename(ownerDir).startsWith(`${path.basename(linkPath)}.owner.`)) {
      return null;
    }
    return ownerDir;
  } catch {
    return null;
  }
}

function scavengeOrphanOwnerDirs(lockDir) {
  const dir = path.dirname(lockDir);
  const prefix = `${path.basename(lockDir)}.owner.`;
  const activeOwner = linkedOwnerDir(lockDir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const ownerDir = path.join(dir, entry);
    if (ownerDir === activeOwner) {
      continue;
    }
    let stats;
    try {
      stats = fs.lstatSync(ownerDir);
    } catch {
      continue;
    }
    if (Date.now() - stats.mtimeMs < LOCK_STALE_MS) {
      continue;
    }
    const prepared = entry.includes(".prepare.");
    const released = fs.existsSync(path.join(ownerDir, ".released"));
    const record = readLockRecord(ownerDir);
    if (!prepared && !released && (!record || !lockOwnerWasReplaced(record))) {
      continue;
    }
    if (linkedOwnerDir(lockDir) === ownerDir) {
      continue;
    }
    const claimedDir = `${ownerDir}.scavenged.${randomBytes(8).toString("hex")}`;
    try {
      fs.renameSync(ownerDir, claimedDir);
      fs.rmSync(claimedDir, { recursive: true, force: true });
    } catch {}
  }
}

function releaseLock(lockDir, token, deps) {
  const ownerDir = lockOwnerDir(lockDir, token);
  try {
    fs.writeFileSync(path.join(ownerDir, ".released"), `${token}\n`, { flag: "wx", mode: PRIVATE_FILE_MODE });
  } catch {}
  if (!lockTargetsToken(lockDir, token)) {
    try {
      fs.rmSync(ownerDir, { recursive: true, force: true });
    } catch {}
    return false;
  }
  try {
    fs.unlinkSync(lockDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  try {
    fs.rmSync(ownerDir, { recursive: true, force: true });
  } catch (error) {
    deps.onReleaseError?.(error);
  }
  return true;
}

function lockHolderCommand(pid) {
  try {
    if (process.platform === "linux") {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
    }
    const result = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2000, windowsHide: true });
    return result.status === 0 ? String(result.stdout ?? "").trim() : "";
  } catch {
    return "";
  }
}

function describeLockHolder(lockDir, observed) {
  if (!observed) {
    return " No owner record was readable.";
  }
  let heldSeconds = null;
  try {
    heldSeconds = Math.round((Date.now() - fs.statSync(lockOwnerDir(lockDir, observed.token)).mtimeMs) / 100) / 10;
  } catch {}
  const alive = processIsDirectlyAlive(observed.ownerPid);
  const current = alive ? getProcessIdentity(observed.ownerPid) : null;
  const state = !alive ? "not running" : !current ? "alive, identity unreadable" : processIdentityMatches(observed.ownerPid, observed.ownerIdentity) ? "alive" : "alive with a different identity";
  const command = alive ? lockHolderCommand(observed.ownerPid).slice(0, 200) : "";
  return ` Held by pid ${observed.ownerPid} (${state})${heldSeconds == null ? "" : ` for ${heldSeconds}s`}${command ? `: ${command}` : ""}.`;
}

export function withRecordLock(file, fn) {
  const deps = recordLockDeps;
  deps.ensurePrivateStatePath(path.dirname(file));
  const lockDir = `${file}.lock`;
  scavengeOrphanOwnerDirs(lockDir);
  const deadline = Date.now() + deps.resolveLockTimeoutMs();
  const token = randomBytes(16).toString("hex");
  const record = {
    version: 1,
    token,
    ownerPid: process.pid,
    ownerIdentity: lockOwnerIdentity()
  };
  let candidateDir = null;
  try {
    for (;;) {
      try {
        candidateDir = publishLockCandidate(lockDir, record, deps);
        break;
      } catch (error) {
        if (error?.code !== "ENOENT" || Date.now() >= deadline) {
          throw error;
        }
        deps.ensurePrivateStatePath(path.dirname(file));
      }
    }
    while (candidateDir) {
      const observed = readLockRecord(lockDir);
      if (reclaimReplacedLock(lockDir, observed, deps)) {
        if (publishPreparedLock(lockDir, candidateDir)) {
          candidateDir = null;
          break;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the job record lock at ${file}.${describeLockHolder(lockDir, readLockRecord(lockDir))}`);
      }
      sleepMs(LOCK_RETRY_MS);
      if (publishPreparedLock(lockDir, candidateDir)) {
        candidateDir = null;
      }
    }
    let callbackError = null;
    try {
      return fn();
    } catch (error) {
      callbackError = error;
      throw error;
    } finally {
      try {
        releaseLock(lockDir, token, deps);
      } catch (error) {
        if (!callbackError) {
          throw error;
        }
      }
    }
  } finally {
    if (candidateDir) {
      try {
        fs.rmSync(candidateDir, { recursive: true, force: true });
      } catch {}
    }
    scavengeOrphanOwnerDirs(lockDir);
  }
}
