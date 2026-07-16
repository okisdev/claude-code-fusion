import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIRECTORY_PREFIX = "fusion-raw-args-";
const TOKEN_PATTERN = /^[a-f0-9]{48}$/;
const OWNER_FILE = "owner.json";
const MAX_OWNER_BYTES = 4096;
const MAX_RAW_ARGUMENT_BYTES = 256 * 1024;
const MAX_AGE_MS = 60 * 60 * 1000;

export class RawArgsTransportError extends Error {}

function sessionHash(sessionId) {
  return typeof sessionId === "string" && sessionId.trim() ? createHash("sha256").update(sessionId.trim()).digest("hex") : null;
}

function validateOwner(stats, label) {
  if (typeof process.getuid === "function" && Number.isInteger(stats.uid) && stats.uid !== process.getuid()) {
    throw new RawArgsTransportError(`${label} is not owned by the current user.`);
  }
}

function validatePrivateMode(stats, label) {
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new RawArgsTransportError(`${label} is not private.`);
  }
}

function shellSafeTemporaryRoot() {
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
  throw new RawArgsTransportError("No private shell safe temporary directory is available for Fusion input transport.");
}

function transportPaths(token, temporaryRoot = shellSafeTemporaryRoot()) {
  if (!TOKEN_PATTERN.test(token)) {
    throw new RawArgsTransportError("The Fusion input transport token is invalid.");
  }
  const directory = path.join(temporaryRoot, `${DIRECTORY_PREFIX}${token}`);
  return { directory, file: path.join(directory, "request"), ownerFile: path.join(directory, OWNER_FILE) };
}

function sameIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function removeVerifiedTransport(paths, identities = {}) {
  if (!identities.directory) {
    return;
  }
  for (const [file, identity] of [[paths.file, identities.file], [paths.ownerFile, identities.owner]]) {
    try {
      const current = fs.lstatSync(file);
      if (!identity || sameIdentity(current, identity)) {
        fs.unlinkSync(file);
      }
    } catch {}
  }
  try {
    const current = fs.lstatSync(paths.directory);
    if ((!identities.directory || sameIdentity(current, identities.directory)) && current.isDirectory() && !current.isSymbolicLink()) {
      fs.rmdirSync(paths.directory);
    }
  } catch {}
}

function pruneExpiredTransports(temporaryRoot, now = Date.now()) {
  let entries;
  try {
    entries = fs.readdirSync(temporaryRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(DIRECTORY_PREFIX) || !TOKEN_PATTERN.test(entry.slice(DIRECTORY_PREFIX.length))) {
      continue;
    }
    const paths = transportPaths(entry.slice(DIRECTORY_PREFIX.length), temporaryRoot);
    try {
      const stats = fs.lstatSync(paths.directory);
      validateOwner(stats, "The expired Fusion input transport directory");
      if (!stats.isDirectory() || stats.isSymbolicLink() || now - stats.mtimeMs <= MAX_AGE_MS) {
        continue;
      }
      fs.rmSync(paths.directory, { recursive: true, force: true });
    } catch {}
  }
}

export function createRawArgsTransport({ sessionId = process.env.CLAUDE_CODE_SESSION_ID, temporaryRoot = shellSafeTemporaryRoot() } = {}) {
  pruneExpiredTransports(temporaryRoot);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = randomBytes(24).toString("hex");
    const paths = transportPaths(token, temporaryRoot);
    let directoryCreated = false;
    try {
      fs.mkdirSync(paths.directory, { mode: 0o700 });
      directoryCreated = true;
      fs.chmodSync(paths.directory, 0o700);
      const descriptor = fs.openSync(paths.file, "wx", 0o600);
      fs.closeSync(descriptor);
      fs.chmodSync(paths.file, 0o600);
      fs.writeFileSync(paths.ownerFile, `${JSON.stringify({ createdAt: Date.now(), sessionHash: sessionHash(sessionId) })}\n`, { flag: "wx", mode: 0o600 });
      fs.chmodSync(paths.ownerFile, 0o600);
      return { file: paths.file, token };
    } catch (error) {
      if (directoryCreated) {
        fs.rmSync(paths.directory, { recursive: true, force: true });
      }
      if (error?.code !== "EEXIST") {
        throw new RawArgsTransportError(`Could not create private Fusion input transport: ${error.message}`);
      }
    }
  }
  throw new RawArgsTransportError("Could not allocate a unique Fusion input transport.");
}

function readPrivateFile(file, maximumBytes, label) {
  const pathStats = fs.lstatSync(file);
  if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1 || pathStats.size > maximumBytes) {
    throw new RawArgsTransportError(`${label} is invalid.`);
  }
  validateOwner(pathStats, label);
  validatePrivateMode(pathStats, label);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const openedStats = fs.fstatSync(descriptor);
    if (!openedStats.isFile() || openedStats.nlink !== 1 || !sameIdentity(openedStats, pathStats)) {
      throw new RawArgsTransportError(`${label} changed before it could be read.`);
    }
    validateOwner(openedStats, label);
    validatePrivateMode(openedStats, label);
    const buffer = Buffer.alloc(maximumBytes + 1);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > maximumBytes) {
      throw new RawArgsTransportError(`${label} exceeded the ${maximumBytes} byte limit.`);
    }
    return { bytes: buffer.subarray(0, bytesRead), identity: openedStats };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function consumeRawArgsTransport(token, { sessionId = process.env.CLAUDE_CODE_SESSION_ID, temporaryRoot = shellSafeTemporaryRoot() } = {}) {
  const paths = transportPaths(token, temporaryRoot);
  const identities = {};
  try {
    const directoryStats = fs.lstatSync(paths.directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new RawArgsTransportError("The Fusion input transport directory is invalid.");
    }
    validateOwner(directoryStats, "The Fusion input transport directory");
    validatePrivateMode(directoryStats, "The Fusion input transport directory");
    identities.directory = directoryStats;

    const owner = readPrivateFile(paths.ownerFile, MAX_OWNER_BYTES, "The Fusion input transport owner record");
    identities.owner = owner.identity;
    let ownerRecord;
    try {
      ownerRecord = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(owner.bytes));
    } catch {
      throw new RawArgsTransportError("The Fusion input transport owner record is invalid.");
    }
    if (ownerRecord?.sessionHash !== sessionHash(sessionId)) {
      throw new RawArgsTransportError("The Fusion input transport belongs to another Claude session.");
    }
    if (!Number.isFinite(ownerRecord?.createdAt) || Date.now() - ownerRecord.createdAt > MAX_AGE_MS) {
      throw new RawArgsTransportError("The Fusion input transport expired.");
    }

    const request = readPrivateFile(paths.file, MAX_RAW_ARGUMENT_BYTES, "The Fusion input transport file");
    identities.file = request.identity;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(request.bytes);
    } catch {
      throw new RawArgsTransportError("Fusion input must be valid UTF-8.");
    }
  } catch (error) {
    if (error instanceof RawArgsTransportError) {
      throw error;
    }
    throw new RawArgsTransportError(`Could not read Fusion input transport: ${error.message}`);
  } finally {
    removeVerifiedTransport(paths, identities);
  }
}

export function splitRawArgs(value) {
  const input = String(value ?? "");
  if (input.includes("\0")) {
    throw new RawArgsTransportError("Fusion input arguments cannot contain NUL bytes.");
  }
  const tokens = [];
  let token = "";
  let started = false;
  let quote = null;
  let escaping = false;
  for (const character of input) {
    if (escaping) {
      token += character;
      escaping = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += character;
    started = true;
  }
  if (escaping || quote) {
    throw new RawArgsTransportError("Fusion input arguments contain an unterminated escape or quote.");
  }
  if (started) {
    tokens.push(token);
  }
  return tokens;
}

export function resolveRawArgsTransport(argv, options = {}) {
  if (argv[0] !== "--raw-args-token") {
    if (argv.includes("--raw-args-token")) {
      throw new RawArgsTransportError("The Fusion input transport cannot be combined with normal arguments.");
    }
    return { argv, ingress: "argv" };
  }
  if (argv.length !== 2) {
    throw new RawArgsTransportError("The Fusion input transport requires exactly one token.");
  }
  return { argv: splitRawArgs(consumeRawArgsTransport(argv[1], options)), ingress: "staged_file" };
}
