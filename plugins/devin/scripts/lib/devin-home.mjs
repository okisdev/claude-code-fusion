import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function realCredentialsPath({ env = process.env, realHome = os.homedir() }) {
  const dataHome = path.isAbsolute(env.XDG_DATA_HOME || "") ? env.XDG_DATA_HOME : path.join(realHome, ".local", "share");
  return path.join(dataHome, "devin", "credentials.toml");
}

export function ensurePrivateHome({ dataDir, env = process.env, realHome = os.homedir() }) {
  const homeDir = path.join(dataDir, "home");
  for (const directory of [
    homeDir,
    path.join(homeDir, ".local"),
    path.join(homeDir, ".local", "share"),
    path.join(homeDir, ".local", "share", "devin"),
    path.join(homeDir, ".local", "state"),
    path.join(homeDir, ".cache")
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  const link = path.join(homeDir, ".local", "share", "devin", "credentials.toml");
  const target = realCredentialsPath({ env, realHome });
  const stats = fs.lstatSync(link, { throwIfNoEntry: false });
  if (stats && (!stats.isSymbolicLink() || fs.readlinkSync(link) !== target)) fs.rmSync(link, { recursive: true, force: true });
  if (!fs.lstatSync(link, { throwIfNoEntry: false })) fs.symlinkSync(target, link);
  return { homeDir };
}

export function buildJobConfig({ configDir, mode, cwd, realHome = os.homedir(), gitDirs = {}, env = process.env, homeDir = null }) {
  if (!["consult", "review", "write"].includes(mode)) throw new Error(`Invalid Devin mode: ${mode}`);
  const devinDir = path.join(configDir, "devin");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(devinDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(configDir, 0o700);
  fs.chmodSync(devinDir, 0o700);
  const sensitiveDirs = [
    ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config", ".local/share",
    ".claude", ".codex", ".grok", ".cursor", ".devin", "Library/Keychains", "Library/Application Support"
  ];
  const deny = [
    "Fetch(*)",
    ...sensitiveDirs.map((directory) => `Read(${path.join(realHome, directory)}/**)`),
    ...[".netrc", ".npmrc", ".git-credentials"].map((file) => `Read(${path.join(realHome, file)})`),
    `Read(${path.dirname(realCredentialsPath({ env, realHome }))}/**)`,
    ...(homeDir ? [`Read(${path.join(homeDir, ".local", "share", "devin", "credentials.toml")})`] : [])
  ];
  if (mode !== "write") deny.push("edit", "exec");
  const permissions = { ask: [], deny };
  if (mode === "write") {
    permissions.allow = [`Write(${path.resolve(cwd)}/**)`];
    if (gitDirs.worktreeGitDir) permissions.allow.push(`Write(${gitDirs.worktreeGitDir}/**)`);
  }
  const config = {
    auto_update: false,
    attribution: false,
    subagents_enabled: false,
    notify: "never",
    read_config_from: {
      agents_standard: true,
      cursor: false,
      windsurf: false,
      claude: false,
      copilot: false,
      opencode: false,
      zed: false,
      cloud: false
    },
    permissions
  };
  for (const [name, value] of [["config.json", config], ["mcp_config.json", { mcpServers: {} }]]) {
    const filename = path.join(devinDir, name);
    fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(filename, 0o600);
  }
  return { configDir };
}

export function worktreeGitDirs(cwd) {
  if (!fs.lstatSync(path.join(cwd, ".git"), { throwIfNoEntry: false })?.isFile()) {
    return { worktreeGitDir: null, commonDir: null };
  }
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], {
    cwd, encoding: "utf8"
  });
  if (result.error || result.status !== 0) throw new Error(`Unable to resolve worktree Git directories: ${result.error?.message || result.stderr?.trim()}`);
  const [worktreeGitDir, commonDir] = result.stdout.trim().split(/\r?\n/);
  if (!path.isAbsolute(worktreeGitDir || "") || !path.isAbsolute(commonDir || "")) throw new Error("Git returned nonabsolute worktree directories.");
  if (worktreeGitDir === commonDir) return { worktreeGitDir: null, commonDir: null };
  return { worktreeGitDir, commonDir };
}

export function projectConfigFiles(cwd) {
  return ["config.json", "config.local.json", "mcp_config.json", "mcp_config.local.json"]
    .map((name) => path.resolve(cwd, ".devin", name))
    .filter((filename) => fs.statSync(filename, { throwIfNoEntry: false })?.isFile());
}

export function removeJobConfig(configDir) {
  fs.rmSync(configDir, { recursive: true, force: true });
}
