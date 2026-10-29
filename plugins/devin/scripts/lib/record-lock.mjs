import { randomBytes } from "node:crypto";
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

export function configureRecordLock({ atomicWriteFile, ensurePrivateDir, ensurePrivateStatePath, resolveLockTimeoutMs }) {
  recordLockDeps = { atomicWriteFile, ensurePrivateDir, ensurePrivateStatePath, resolveLockTimeoutMs };
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

function createLinkedOwner(linkPath, record, deps) {
  const ownerDir = lockOwnerDir(linkPath, record.token);
  const preparedDir = `${ownerDir}.prepare.${process.pid}.${randomBytes(8).toString("hex")}`;
  deps.ensurePrivateDir(preparedDir);
  try {
    deps.atomicWriteFile(path.join(preparedDir, "owner.json"), `${JSON.stringify(record)}\n`);
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

function reaperClaimSlot(lockDir, token) {
  return `${lockDir}.reap.${token}`;
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
  const primarySlot = reaperClaimSlot(lockDir, ownerToken);
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
        const candidate = createLinkedOwner(slot, claim, deps);
        if (candidate.published) {
          if (!lockTargetsToken(lockDir, ownerToken)) {
            releaseLock(slot, claim.token);
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
    slot = `${primarySlot}.successor-${existing.token}`;
  }
}

function cleanupReaperClaims(lockDir, ownerToken) {
  const dir = path.dirname(lockDir);
  const prefix = path.basename(reaperClaimSlot(lockDir, ownerToken));
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry !== prefix && !entry.startsWith(`${prefix}.`)) {
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
        releaseLock(claim.slot, claim.token);
      } catch {}
      cleanupReaperClaims(lockDir, observed.token);
    } else {
      releaseLock(claim.slot, claim.token);
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

function releaseLock(lockDir, token) {
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
  } catch {}
  return true;
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
  let candidateDir = publishLockCandidate(lockDir, record, deps);
  try {
    while (candidateDir) {
      const observed = readLockRecord(lockDir);
      if (reclaimReplacedLock(lockDir, observed, deps)) {
        if (publishPreparedLock(lockDir, candidateDir)) {
          candidateDir = null;
          break;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the job record lock at ${file}.`);
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
        releaseLock(lockDir, token);
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
