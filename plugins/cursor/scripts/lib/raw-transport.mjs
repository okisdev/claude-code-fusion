import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isatty } from "node:tty";

const transportTokenPattern = /^[a-f0-9]{48}$/;
const transportOwnerFile = "owner.json";
const transportOwnerMaxBytes = 4096;
const transportMaxAgeMs = 60 * 60 * 1000;

// All three companions use the same private temporary transport. Job data directories
// remain the responsibility of their callers; they do not hold staged requests.
let rawTransportConfig;

export function configureRawTransport(config) {
  const {
    engineName,
    sessionIdEnv,
    makeError,
    maxRawArgumentBytes,
    allowUnwrittenByDefault = true,
    cleanupOnSessionMismatch = false,
    allowBackgroundDefault = true,
    allowStdin = false
  } = config;
  rawTransportConfig = {
    engineName,
    sessionIdEnv,
    makeError,
    maxRawArgumentBytes,
    allowUnwrittenByDefault,
    cleanupOnSessionMismatch,
    allowBackgroundDefault,
    allowStdin,
    transportDirectoryPrefix: `${engineName}-companion-input-`
  };
}

function shellSafeTemporaryRoot(errorWithFailure) {
  const candidates = [os.tmpdir(), process.platform === "win32" ? "C:\\Windows\\Temp" : "/private/tmp", "/tmp"];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate) || !/^[A-Za-z0-9_./:\\-]+$/.test(candidate)) {
      continue;
    }
    try {
      const stats = fs.lstatSync(candidate);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        continue;
      }
      fs.accessSync(candidate, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  throw errorWithFailure("No private shell safe temporary directory is available for raw command transport.", "resource");
}

function transportPaths(token, config) {
  const { transportDirectoryPrefix, makeError: errorWithFailure } = config;
  if (!transportTokenPattern.test(token)) {
    throw errorWithFailure("The raw command transport token is invalid.", "input");
  }
  const directory = path.join(shellSafeTemporaryRoot(errorWithFailure), `${transportDirectoryPrefix}${token}`);
  return { directory, file: path.join(directory, "request"), ownerFile: path.join(directory, transportOwnerFile) };
}

function validateOwnedPath(stats, label, errorWithFailure) {
  if (typeof process.getuid === "function" && Number.isInteger(stats.uid) && stats.uid !== process.getuid()) {
    throw errorWithFailure(`${label} is not owned by the current user.`, "permission");
  }
}

function transportSessionHash(sessionId) {
  return typeof sessionId === "string" && sessionId.trim()
    ? createHash("sha256").update(sessionId.trim()).digest("hex")
    : null;
}

function sameFileIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function readTransportOwner(ownerFile, errorWithFailure) {
  let descriptor;
  try {
    const pathStats = fs.lstatSync(ownerFile);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1 || pathStats.size > transportOwnerMaxBytes) {
      throw errorWithFailure("The raw command transport owner record is invalid.", "permission");
    }
    validateOwnedPath(pathStats, "The raw command transport owner record", errorWithFailure);
    if (process.platform !== "win32" && (pathStats.mode & 0o077) !== 0) {
      throw errorWithFailure("The raw command transport owner record is not private.", "permission");
    }
    descriptor = fs.openSync(ownerFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const openedStats = fs.fstatSync(descriptor);
    if (!openedStats.isFile() || openedStats.nlink !== 1 || !sameFileIdentity(openedStats, pathStats)) {
      throw errorWithFailure("The raw command transport owner record changed before it could be read.", "permission");
    }
    const buffer = Buffer.alloc(transportOwnerMaxBytes + 1);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > transportOwnerMaxBytes) {
      throw errorWithFailure("The raw command transport owner record is invalid.", "permission");
    }
    const record = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (!Number.isSafeInteger(record?.createdAt) || record.createdAt <= 0 || (record.sessionHash !== null && !/^[a-f0-9]{64}$/.test(record.sessionHash))) {
      throw errorWithFailure("The raw command transport owner record is invalid.", "permission");
    }
    return { identity: pathStats, record };
  } catch (error) {
    if (error?.failureKind) {
      throw error;
    }
    throw errorWithFailure(`Could not read raw command transport owner record: ${error.message}`, "permission");
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function cleanupVerifiedTransport(directory, file, ownerFile, directoryIdentity, fileIdentity, ownerIdentity, errorWithFailure, { requirePrivateFile = false } = {}) {
  if (!directoryIdentity || !fileIdentity || !ownerIdentity) {
    return;
  }
  try {
    const currentDirectory = fs.lstatSync(directory);
    if (!currentDirectory.isDirectory() || currentDirectory.isSymbolicLink() || !sameFileIdentity(currentDirectory, directoryIdentity)) {
      return;
    }
    validateOwnedPath(currentDirectory, "The raw command transport directory", errorWithFailure);
    if (process.platform !== "win32" && (currentDirectory.mode & 0o077) !== 0) {
      return;
    }
    const currentFile = fs.lstatSync(file);
    if (!currentFile.isFile() || currentFile.isSymbolicLink() || currentFile.nlink !== 1 || !sameFileIdentity(currentFile, fileIdentity)) {
      return;
    }
    validateOwnedPath(currentFile, "The raw command transport file", errorWithFailure);
    if (requirePrivateFile && process.platform !== "win32" && (currentFile.mode & 0o077) !== 0) {
      return;
    }
    const currentOwner = fs.lstatSync(ownerFile);
    if (!currentOwner.isFile() || currentOwner.isSymbolicLink() || currentOwner.nlink !== 1 || !sameFileIdentity(currentOwner, ownerIdentity)) {
      return;
    }
    validateOwnedPath(currentOwner, "The raw command transport owner record", errorWithFailure);
    if (process.platform !== "win32" && (currentOwner.mode & 0o077) !== 0) {
      return;
    }
    fs.unlinkSync(file);
    fs.unlinkSync(ownerFile);
    fs.rmdirSync(directory);
  } catch {}
}

function cleanupRawCommandTransports(options, config) {
  const { transportDirectoryPrefix, makeError: errorWithFailure } = config;
  let root;
  let entries;
  try {
    root = shellSafeTemporaryRoot(errorWithFailure);
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const sessionHash = options.sessionHash ?? null;
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(transportDirectoryPrefix)) {
      continue;
    }
    const token = entry.name.slice(transportDirectoryPrefix.length);
    if (!transportTokenPattern.test(token)) {
      continue;
    }
    const { directory, file, ownerFile } = transportPaths(token, config);
    try {
      const directoryIdentity = fs.lstatSync(directory);
      if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink()) {
        continue;
      }
      validateOwnedPath(directoryIdentity, "The raw command transport directory", errorWithFailure);
      if (process.platform !== "win32" && (directoryIdentity.mode & 0o077) !== 0) {
        continue;
      }
      const { identity: ownerIdentity, record } = readTransportOwner(ownerFile, errorWithFailure);
      const fileIdentity = fs.lstatSync(file);
      if (!fileIdentity.isFile() || fileIdentity.isSymbolicLink() || fileIdentity.nlink !== 1) {
        continue;
      }
      validateOwnedPath(fileIdentity, "The raw command transport file", errorWithFailure);
      if (process.platform !== "win32" && (fileIdentity.mode & 0o077) !== 0) {
        continue;
      }
      if (options.expiredOnly) {
        const ageMs = now - record.createdAt;
        if (ageMs < 0 || ageMs <= transportMaxAgeMs) {
          continue;
        }
      } else if (!sessionHash || record.sessionHash !== sessionHash) {
        continue;
      }
      cleanupVerifiedTransport(directory, file, ownerFile, directoryIdentity, fileIdentity, ownerIdentity, errorWithFailure, { requirePrivateFile: true });
    } catch {}
  }
}

export function cleanupRawCommandTransportsForSession(sessionId) {
  const config = rawTransportConfig;
  const sessionHash = transportSessionHash(sessionId);
  if (!sessionHash) {
    return;
  }
  cleanupRawCommandTransports({ sessionHash }, config);
}

export function createRawCommandTransport() {
  const config = rawTransportConfig;
  const { sessionIdEnv, makeError: errorWithFailure } = config;
  cleanupRawCommandTransports({ expiredOnly: true }, config);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = randomBytes(24).toString("hex");
    const { directory, file, ownerFile } = transportPaths(token, config);
    let directoryCreated = false;
    let fileCreated = false;
    let ownerCreated = false;
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      directoryCreated = true;
      fs.chmodSync(directory, 0o700);
      const descriptor = fs.openSync(file, "wx", 0o600);
      fileCreated = true;
      fs.closeSync(descriptor);
      fs.chmodSync(file, 0o600);
      fs.writeFileSync(ownerFile, `${JSON.stringify({ createdAt: Date.now(), sessionHash: transportSessionHash(process.env[sessionIdEnv] ?? null) })}\n`, {
        flag: "wx",
        mode: 0o600
      });
      ownerCreated = true;
      fs.chmodSync(ownerFile, 0o600);
      return { file, token };
    } catch (error) {
      if (ownerCreated || directoryCreated) {
        try {
          fs.unlinkSync(ownerFile);
        } catch {}
      }
      if (fileCreated) {
        try {
          fs.unlinkSync(file);
        } catch {}
      }
      if (directoryCreated) {
        try {
          fs.rmdirSync(directory);
        } catch {}
      }
      if (error?.code !== "EEXIST") {
        throw errorWithFailure(`Could not create private raw command transport: ${error.message}`, "permission");
      }
    }
  }
  throw errorWithFailure("Could not allocate a unique raw command transport.", "resource");
}

function readBoundedDescriptor(descriptor, limit, errorWithFailure) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
    if (bytesRead === 0) {
      break;
    }
    total += bytesRead;
    if (total > limit) {
      throw errorWithFailure(`Raw command arguments exceeded the ${limit} byte limit.`, "resource");
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

function releaseVerifiedTransport(directory, file, ownerFile, identities, errorWithFailure) {
  cleanupVerifiedTransport(directory, file, ownerFile, identities.directory, identities.file, identities.owner, errorWithFailure);
}

export function consumeRawCommandTransport(token, { allowUnwritten = rawTransportConfig.allowUnwrittenByDefault, retain = false } = {}) {
  const config = rawTransportConfig;
  const { sessionIdEnv, cleanupOnSessionMismatch, maxRawArgumentBytes, makeError: errorWithFailure } = config;
  const { directory, file, ownerFile } = transportPaths(token, config);
  let descriptor;
  const identities = { directory: null, file: null, owner: null };
  let retained = false;
  const release = releaseVerifiedTransport.bind(null, directory, file, ownerFile, identities, errorWithFailure);
  try {
    const directoryStats = fs.lstatSync(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw errorWithFailure("The raw command transport directory is invalid.", "permission");
    }
    validateOwnedPath(directoryStats, "The raw command transport directory", errorWithFailure);
    if (process.platform !== "win32" && (directoryStats.mode & 0o077) !== 0) {
      throw errorWithFailure("The raw command transport directory is not private.", "permission");
    }
    identities.directory = directoryStats;
    const owner = readTransportOwner(ownerFile, errorWithFailure);
    identities.owner = owner.identity;
    const sessionMismatch = owner.record.sessionHash !== transportSessionHash(process.env[sessionIdEnv] ?? null);
    if (sessionMismatch && !cleanupOnSessionMismatch) {
      throw errorWithFailure("The raw command transport belongs to another Claude session.", "permission");
    }
    const pathStats = fs.lstatSync(file);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1) {
      throw errorWithFailure("The raw command transport must be a regular private file.", "permission");
    }
    validateOwnedPath(pathStats, "The raw command transport file", errorWithFailure);
    identities.file = pathStats;
    if (sessionMismatch) {
      throw errorWithFailure("The raw command transport belongs to another Claude session.", "permission");
    }
    const transportAgeMs = Date.now() - owner.record.createdAt;
    if (transportAgeMs < 0 || transportAgeMs > transportMaxAgeMs) {
      throw errorWithFailure("The raw command transport has expired.", "input");
    }
    if (process.platform !== "win32" && (pathStats.mode & 0o077) !== 0) {
      throw errorWithFailure("The raw command transport file is not private.", "permission");
    }
    if (pathStats.size > maxRawArgumentBytes) {
      throw errorWithFailure(`Raw command arguments exceeded the ${maxRawArgumentBytes} byte limit.`, "resource");
    }
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const openedStats = fs.fstatSync(descriptor);
    if (!openedStats.isFile() || openedStats.nlink !== 1 || !sameFileIdentity(openedStats, pathStats)) {
      throw errorWithFailure("The raw command transport changed before it could be read.", "permission");
    }
    validateOwnedPath(openedStats, "The raw command transport file", errorWithFailure);
    if (process.platform !== "win32" && (openedStats.mode & 0o077) !== 0) {
      throw errorWithFailure("The raw command transport file is not private.", "permission");
    }
    const bytes = readBoundedDescriptor(descriptor, maxRawArgumentBytes, errorWithFailure);
    let value;
    if (bytes.length === 0) {
      if (!allowUnwritten) {
        throw errorWithFailure("The raw command transport is unwritten.", "input");
      }
      value = "";
    } else {
      try {
        value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw errorWithFailure("Raw command arguments must be valid UTF-8.", "input");
      }
    }
    if (retain) {
      retained = true;
      return { value, release };
    }
    return value;
  } catch (error) {
    if (error?.failureKind) {
      throw error;
    }
    throw errorWithFailure(`Could not read raw command transport: ${error.message}`, error?.code === "ENOENT" ? "input" : "permission");
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if (!retained) release();
  }
}

export function pruneRawCommandTransports({ sessionId } = {}) {
  const config = rawTransportConfig;
  const sessionHash = transportSessionHash(sessionId);
  cleanupRawCommandTransports(sessionHash ? { sessionHash } : { expiredOnly: true }, config);
}

function consumeRawCommandStdin(config) {
  const { maxRawArgumentBytes, makeError: errorWithFailure } = config;
  if (isatty(0)) {
    throw errorWithFailure("Raw command stdin requires a piped request.", "input");
  }
  const bytes = readBoundedDescriptor(0, maxRawArgumentBytes, errorWithFailure);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw errorWithFailure("Raw command arguments must be valid UTF-8.", "input");
  }
}

export function resolveCommandTransport(rawArgv, { retainStaged = false } = {}) {
  const config = rawTransportConfig;
  const { allowBackgroundDefault, allowStdin, makeError: errorWithFailure } = config;
  const defaults = { defaultWrite: false };
  if (allowBackgroundDefault) defaults.defaultBackground = false;
  const transportArgv = [...rawArgv];
  if (allowBackgroundDefault) {
    while (transportArgv[0] === "--transport-default-write" || transportArgv[0] === "--transport-default-background") {
      const option = transportArgv.shift();
      defaults[option === "--transport-default-write" ? "defaultWrite" : "defaultBackground"] = true;
    }
  } else if (transportArgv[0] === "--transport-default-write") {
    transportArgv.shift();
    defaults.defaultWrite = true;
  }
  if (allowStdin && transportArgv[0] === "--request-stdin") {
    if (transportArgv.length !== 1) {
      throw errorWithFailure("Raw command stdin must not be combined with normal arguments.", "input");
    }
    return { argv: [consumeRawCommandStdin(config)], ...defaults, ingress: "stdin" };
  }
  if (transportArgv[0] !== "--raw-args-token") {
    if (transportArgv.some((value) => value === "--raw-args-token" || (allowStdin && value === "--request-stdin")) ||
        defaults.defaultWrite || defaults.defaultBackground) {
      throw errorWithFailure("Raw command transport options must not be combined with normal arguments.", "input");
    }
    return { argv: rawArgv, ...defaults, ingress: "argv" };
  }
  if (transportArgv.length !== 2) {
    throw errorWithFailure("Raw command transport requires exactly one token.", "input");
  }
  const consumed = consumeRawCommandTransport(transportArgv[1], { retain: retainStaged });
  return retainStaged
    ? { argv: [consumed.value], ...defaults, ingress: "staged_file", release: consumed.release }
    : { argv: [consumed], ...defaults, ingress: "staged_file" };
}
