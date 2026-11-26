import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withRecordLock } from "./record-lock.mjs";
import { PRIVATE_GROK_HOME, ensurePrivateDataDir, resolveDataDir, writePrivateStateFile } from "./state.mjs";

export function grokPaths(env = process.env, cwd = process.cwd()) {
  const userHome = path.resolve(cwd, env.GROK_HOME?.trim() || path.join(env.HOME?.trim() || os.homedir(), ".grok"));
  return {
    userHome,
    home: path.join(resolveDataDir(env), PRIVATE_GROK_HOME),
    auth: path.join(userHome, "auth.json")
  };
}

function* configEntries(source) {
  let entry = "";
  let quote = "";
  let depth = 0;
  for (const line of source.split(/(?<=\n)/)) {
    entry += line;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (quote) {
        if (quote[0] === '"' && char === "\\") {
          i++;
        } else if (line.startsWith(quote, i)) {
          i += quote.length - 1;
          if (quote.length === 3) {
            while (line[i + 1] === char) i++;
          }
          quote = "";
        }
      } else if (char === "#") {
        break;
      } else if (char === '"' || char === "'") {
        quote = line.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
        i += quote.length - 1;
      } else if (char === "[" || char === "{") {
        depth++;
      } else if (char === "]" || char === "}") {
        depth--;
      }
    }
    if (!quote && depth === 0) {
      yield entry;
      entry = "";
    }
  }
  if (entry) yield entry;
}

function privateConfig(userHome) {
  const file = path.join(userHome, "config.toml");
  let source = "";
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let topLevel = true;
  let skipTable = false;
  let shellPolicyPresent = false;
  let config = "";
  for (const entry of configEntries(source)) {
    const line = entry.trimStart();
    const header = line.startsWith("[");
    if (header || topLevel) {
      const key = header ? line.replace(/^\[\[?\s*/, "") : line;
      const root = /^(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([\w-]+))\s*([.=\]])/.exec(key);
      if (header && (!root || !/\]\s*(?:#[^\n]*)?$/.test(line.trimEnd()))) {
        throw new Error(`Invalid Grok config table header in ${file}.`);
      }
      if (!root) {
        config += entry;
        continue;
      }
      const [, quoted, literal, bare, separator] = root;
      const name = quoted?.replace(/\\(?:x[\da-fA-F]{2}|u[\da-fA-F]{4}|U[\da-fA-F]{8}|.)/g,
        (escape) => escape.length > 2 ? String.fromCodePoint(parseInt(escape.slice(2), 16)) : escape) ?? literal ?? bare;
      const excluded = name === "plugins" || name === "hooks";
      if (header) {
        topLevel = false;
        skipTable = excluded;
        if (name === "shell_environment_policy" && separator === "]" && !line.startsWith("[[")) shellPolicyPresent = true;
      } else if (excluded) {
        continue;
      }
    }
    if (!skipTable) config += entry;
  }
  return { config, shellPolicyPresent };
}

function ensurePolicyLock(home) {
  const file = path.join(home, "managed_config.lock");
  const { O_CREAT, O_RDWR, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const fd = fs.openSync(file, O_CREAT | O_RDWR | O_NOFOLLOW | O_NONBLOCK, 0o644);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Expected a regular private policy lock at ${file}.`);
    if (stat.size) fs.ftruncateSync(fd);
    if ((stat.mode & 0o7777) !== 0o644) fs.fchmodSync(fd, 0o644);
  } finally {
    fs.closeSync(fd);
  }
}

function readAuth(file, privateCopy = false) {
  let fd;
  try {
    const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (privateCopy ? fs.constants.O_NOFOLLOW : 0);
    fd = fs.openSync(file, flags);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Expected a regular auth file at ${file}.`);
    if (privateCopy && stat.nlink !== 1) return null;
    const content = fs.readFileSync(fd);
    return { content, hash: createHash("sha256").update(content).digest("hex"), mode: stat.mode & 0o7777, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error.code === "ENOENT" || (privateCopy && error.code === "ELOOP")) return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function installAuth(file, content, expectedHash) {
  let staging;
  try {
    staging = fs.mkdtempSync(path.join(path.dirname(file), ".login-"));
    const copy = path.join(staging, "auth.json");
    fs.writeFileSync(copy, content, { mode: 0o600 });
    fs.chmodSync(copy, 0o600);
    if (expectedHash !== undefined && readAuth(file)?.hash !== expectedHash) return;
    fs.renameSync(copy, file);
  } catch (error) {
    if (expectedHash === undefined || error.code !== "ENOENT") throw error;
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function copyGrokAuth({ home, auth }, startedWith, deadline) {
  const startedAt = Date.now();
  try {
    const file = path.join(home, "auth.json");
    const stamp = path.join(path.dirname(home), "auth-copy.json");
    if (![auth, file, stamp].some((entry) => fs.lstatSync(entry, { throwIfNoEntry: false }))) return null;
    return withRecordLock(stamp, () => {
      const saved = fs.existsSync(stamp) ? JSON.parse(fs.readFileSync(stamp, "utf8")) : null;
      const copy = readAuth(file, true);
      let user = readAuth(auth);
      const base = saved?.auth === auth ? saved.hash : null;
      if (copy && saved && saved.auth !== auth && copy.hash !== saved.hash) {
        throw new Error(`A private credential update is pending for ${saved.auth}. Use its Grok home to synchronize it first.`);
      }
      if (!saved && copy && user && copy.hash !== user.hash && copy.mtimeMs > user.mtimeMs) {
        throw new Error("The newer private Grok login has no recorded source digest. Run grok login in the user home to select the current login.");
      }
      const userUnchanged = user && user.hash === base && (startedWith === undefined || startedWith?.hash === base);
      const touched = copy && startedWith && copy.mtimeMs > startedWith.privateMtimeMs;
      if (copy && userUnchanged && (copy.hash !== base || touched)) {
        installAuth(auth, copy.content, base);
        user = readAuth(auth);
      }
      if (!user) {
        fs.rmSync(file, { force: true });
        fs.rmSync(stamp, { force: true });
        return null;
      }
      if (copy?.hash !== user.hash || copy.mode !== 0o600) installAuth(file, user.content);
      if (base !== user.hash) writePrivateStateFile(stamp, JSON.stringify({ auth, hash: user.hash }));
      return { hash: user.hash, userMtimeMs: user.mtimeMs, privateMtimeMs: fs.statSync(file).mtimeMs };
    });
  } catch (error) {
    error.failureKind = "setup";
    throw error;
  } finally {
    if (deadline) deadline.expiresAt += Date.now() - startedAt;
  }
}

export function spawnWithGrokAuth(paths, bin, args, options, deadline) {
  const before = copyGrokAuth(paths, undefined, deadline);
  let result;
  let after;
  try {
    result = spawnSync(bin, args, options);
  } finally {
    after = copyGrokAuth(paths, before, deadline);
  }
  const authRefreshed = before !== null && after !== null && (after.hash !== before.hash || after.userMtimeMs > before.userMtimeMs);
  return { ...result, authRefreshed };
}

export function spawnGrokVersion(bin, options) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-companion-version-"));
  try {
    return spawnSync(bin, ["--version"], { ...options, env: { ...options.env, GROK_HOME: home } });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

export function ensureGrokHome({ home, userHome }) {
  try {
    const dataDir = path.dirname(home);
    ensurePrivateDataDir(dataDir);
    const target = path.join(fs.realpathSync(dataDir), path.basename(home));
    if (home === userHome || (fs.existsSync(userHome) && fs.realpathSync(userHome) === target)) {
      throw new Error("The private Grok home must be separate from the user Grok home.");
    }
    for (const directory of [home, path.join(home, "hooks"), path.join(home, "sessions")]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Expected a real directory at ${directory}.`);
      fs.chmodSync(directory, 0o700);
    }
    if (fs.readdirSync(path.join(home, "hooks")).length) throw new Error(`Expected an empty hooks directory in ${home}.`);
    ensurePolicyLock(home);
    const { config, shellPolicyPresent } = privateConfig(userHome);
    writePrivateStateFile(path.join(home, "config.toml"), config);
    return shellPolicyPresent;
  } catch (error) {
    error.failureKind = "setup";
    throw error;
  }
}
