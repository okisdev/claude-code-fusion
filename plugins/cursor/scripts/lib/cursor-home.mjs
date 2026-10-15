import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CURSOR_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sharedNpmCache(homeDir) {
  const runDir = path.dirname(homeDir);
  const dataDir = path.basename(homeDir) === "home" && path.basename(path.dirname(runDir)) === "runs"
    ? path.dirname(path.dirname(runDir)) : path.dirname(homeDir);
  const cache = path.join(dataDir, "npm-cache");
  const stats = fs.lstatSync(cache, { throwIfNoEntry: false });
  if (stats && (!stats.isDirectory() || stats.isSymbolicLink())) throw new Error(`Invalid Cursor npm cache: ${cache}`);
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  fs.chmodSync(cache, 0o700);
  return cache;
}

export function buildPrivateHome({ homeDir, mode, cwd, env = process.env, realHome = os.homedir(), platform = process.platform }) {
  if (!["consult", "review", "write"].includes(mode)) {
    throw new Error(`Invalid Cursor mode: ${mode}`);
  }
  const cursorDir = path.join(homeDir, ".cursor");
  fs.mkdirSync(cursorDir, { recursive: true });
  const cache = sharedNpmCache(homeDir);
  const npmLink = path.join(homeDir, ".npm");
  const npmStats = fs.lstatSync(npmLink, { throwIfNoEntry: false });
  if (npmStats && (!npmStats.isSymbolicLink() || fs.readlinkSync(npmLink) !== cache)) removePrivateHome(npmLink);
  if (!fs.lstatSync(npmLink, { throwIfNoEntry: false })) fs.symlinkSync(cache, npmLink, "dir");
  if (platform === "darwin") {
    const keychains = path.join(realHome, "Library", "Keychains");
    if (fs.existsSync(keychains)) {
      fs.mkdirSync(path.join(homeDir, "Library"), { recursive: true });
      const link = path.join(homeDir, "Library", "Keychains");
      let current;
      try { current = fs.lstatSync(link); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (current && (!current.isSymbolicLink() || fs.readlinkSync(link) !== keychains)) {
        removePrivateHome(link);
        current = null;
      }
      if (!current) fs.symlinkSync(keychains, link);
    }
  }
  const configPath = path.join(cursorDir, "cli-config.json");
  const sandboxPath = path.join(cursorDir, "sandbox.json");
  const networkPolicy = { default: "deny" };
  const config = {
    version: 1,
    approvalMode: "allowlist",
    sandbox: { mode: "enabled", networkAccess: "user_config_only", networkAllowlist: [], readBoundary: "workspace" },
    autoAcceptWebSearch: false,
    attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false },
    permissions: { allow: [], deny: mode === "write" ? [] : ["Write(**)"] }
  };
  const sandbox = {
    type: mode === "write" ? "workspace_readwrite" : "workspace_readonly",
    readBoundary: "workspace",
    networkPolicy
  };
  if (mode === "write") {
    const readonly = [];
    const installs = path.join(env.MISE_DATA_DIR || path.join(realHome, ".local", "share", "mise"), "installs");
    if (fs.existsSync(installs)) {
      readonly.push(installs);
    }
    if (fs.statSync(path.join(cwd, ".git"), { throwIfNoEntry: false })?.isFile()) {
      const gitPaths = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"], {
        cwd,
        encoding: "utf8"
      });
      if (gitPaths.status !== 0) {
        throw new Error(`Unable to resolve worktree Git directories: ${gitPaths.stderr?.trim() || gitPaths.error?.message}`);
      }
      const [commonDir, gitDir] = gitPaths.stdout.trim().split(/\r?\n/);
      if (!path.isAbsolute(commonDir) || !path.isAbsolute(gitDir)) {
        throw new Error("Git returned nonabsolute worktree directories.");
      }
      readonly.push(commonDir);
      sandbox.additionalReadwritePaths = [gitDir];
    }
    if (readonly.length) {
      sandbox.additionalReadonlyPaths = readonly;
    }
  }
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(sandboxPath, `${JSON.stringify(sandbox, null, 2)}\n`, { mode: 0o600 });
  for (const name of ["plugins", "skills-cursor"]) {
    fs.mkdirSync(path.join(cursorDir, name), { recursive: true, mode: 0o555 });
    fs.chmodSync(path.join(cursorDir, name), 0o555);
  }
  return { homeDir, configPath, sandboxPath };
}

export function copyChatForResume({ fromHome, toHome, cwd, sessionId }) {
  if (!CURSOR_SESSION_ID_PATTERN.test(sessionId)) {
    const error = new Error("Invalid Cursor session id.");
    error.failureKind = "input";
    throw error;
  }
  const relative = path.relative(fromHome, cursorChatDir(fromHome, cwd, sessionId));
  const source = path.join(fromHome, relative);
  if (!fs.lstatSync(source, { throwIfNoEntry: false })?.isDirectory()) {
    return false;
  }
  fs.mkdirSync(path.dirname(path.join(toHome, relative)), { recursive: true });
  fs.cpSync(source, path.join(toHome, relative), { recursive: true });
  return true;
}

export function cursorChatDir(homeDir, cwd, sessionId) {
  if (!CURSOR_SESSION_ID_PATTERN.test(sessionId)) {
    const error = new Error("Invalid Cursor session id.");
    error.failureKind = "input";
    throw error;
  }
  return path.join(homeDir, ".cursor", "chats", createHash("md5").update(path.resolve(cwd)).digest("hex"), sessionId);
}

export function projectHookFiles(cwd) {
  return [".cursor/hooks.json", ".claude/settings.json", ".claude/settings.local.json"].filter((relative) => {
    try {
      const hooks = JSON.parse(fs.readFileSync(path.join(cwd, relative), "utf8")).hooks;
      return hooks && typeof hooks === "object" && !Array.isArray(hooks) && Object.keys(hooks).length > 0;
    } catch (error) {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  });
}

export function removePrivateHome(homeDir) {
  let stats;
  try { stats = fs.lstatSync(homeDir); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (stats.isDirectory()) {
    fs.chmodSync(homeDir, stats.mode | 0o700);
    for (const name of fs.readdirSync(homeDir)) removePrivateHome(path.join(homeDir, name));
  }
  fs.rmSync(homeDir, { recursive: true, force: true });
}

function pruneHomeDirectory(directory, retained) {
  if (directory === retained) return;
  for (const name of fs.readdirSync(directory)) {
    const child = path.join(directory, name);
    if (child === retained) continue;
    if (retained.startsWith(`${child}${path.sep}`) && fs.lstatSync(child).isDirectory()) pruneHomeDirectory(child, retained);
    else removePrivateHome(child);
  }
}

export function prunePrivateHome(homeDir, cwd, sessionId) {
  const retained = sessionId && CURSOR_SESSION_ID_PATTERN.test(sessionId) ? cursorChatDir(homeDir, cwd, sessionId) : null;
  if (!retained || !fs.lstatSync(retained, { throwIfNoEntry: false })?.isDirectory()) {
    removePrivateHome(homeDir);
    return;
  }
  pruneHomeDirectory(homeDir, retained);
}
