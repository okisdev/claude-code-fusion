import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CURSOR_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildPrivateHome({ homeDir, mode, cwd, env = process.env, realHome = os.homedir(), platform = process.platform }) {
  if (!["consult", "review", "write"].includes(mode)) {
    throw new Error(`Invalid Cursor mode: ${mode}`);
  }
  const cursorDir = path.join(homeDir, ".cursor");
  fs.mkdirSync(cursorDir, { recursive: true });
  if (platform === "darwin") {
    const keychains = path.join(realHome, "Library", "Keychains");
    if (fs.existsSync(keychains)) {
      fs.mkdirSync(path.join(homeDir, "Library"), { recursive: true });
      fs.symlinkSync(keychains, path.join(homeDir, "Library", "Keychains"));
    }
  }
  const configPath = path.join(cursorDir, "cli-config.json");
  const sandboxPath = path.join(cursorDir, "sandbox.json");
  const config = {
    version: 1,
    approvalMode: "allowlist",
    sandbox: { mode: "enabled", networkAccess: "user_config_only", readBoundary: "workspace" },
    autoAcceptWebSearch: false,
    attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false },
    permissions: { allow: [], deny: mode === "write" ? [] : ["Write(**)"] }
  };
  const sandbox = {
    type: mode === "write" ? "workspace_readwrite" : "workspace_readonly",
    readBoundary: "workspace",
    networkPolicy: { default: "deny" }
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
    fs.mkdirSync(path.join(cursorDir, name), { mode: 0o555 });
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
  const relative = path.join(".cursor", "chats", createHash("md5").update(path.resolve(cwd)).digest("hex"), sessionId);
  const source = path.join(fromHome, relative);
  if (!fs.existsSync(source)) {
    return false;
  }
  fs.mkdirSync(path.dirname(path.join(toHome, relative)), { recursive: true });
  fs.cpSync(source, path.join(toHome, relative), { recursive: true });
  return true;
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
  if (!fs.existsSync(homeDir)) {
    return;
  }
  for (const name of ["plugins", "skills-cursor"]) {
    const directory = path.join(homeDir, ".cursor", name);
    if (fs.existsSync(directory)) {
      fs.chmodSync(directory, fs.statSync(directory).mode | 0o200);
    }
  }
  fs.rmSync(homeDir, { recursive: true, force: true });
}
