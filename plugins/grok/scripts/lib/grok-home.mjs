import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writePrivateStateFile } from "./state.mjs";

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

export function copyGrokAuth({ home, auth }) {
  const file = path.join(home, "auth.json");
  const temp = path.join(home, `.auth-${randomBytes(12).toString("hex")}.tmp`);
  let fd;
  try {
    ensurePolicyLock(home);
    try {
      fd = fs.openSync(auth, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      fs.rmSync(file, { force: true });
      return;
    }
    if (!fs.fstatSync(fd).isFile()) throw new Error(`Expected a regular auth file at ${auth}.`);
    fs.writeFileSync(temp, fs.readFileSync(fd), { flag: "wx", mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } catch (error) {
    error.failureKind = "setup";
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
  }
}

export function spawnWithGrokAuth(paths, bin, args, options) {
  return spawnSync(bin, args, { ...options, env: { ...options.env, GROK_HOME: paths.home, GROK_AUTH_PATH: paths.auth } });
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
    const homes = path.dirname(home);
    const dataDir = path.dirname(homes);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    const target = path.join(fs.realpathSync(dataDir), "homes", path.basename(home));
    if (userHome === target) throw new Error("The private Grok home must be separate from the user Grok home.");
    for (const directory of [homes, home, path.join(home, "hooks"), path.join(home, "sessions")]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Expected a real directory at ${directory}.`);
      fs.chmodSync(directory, 0o700);
    }
    if (fs.readdirSync(path.join(home, "hooks")).length) throw new Error(`Expected an empty hooks directory in ${home}.`);
    const { config, shellPolicyPresent } = privateConfig(userHome);
    writePrivateStateFile(path.join(home, "config.toml"), config);
    return shellPolicyPresent;
  } catch (error) {
    error.failureKind = "setup";
    throw error;
  }
}
