import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { withRecordLock } from "./record-lock.mjs";
import { listAllJobRecords } from "./state.mjs";
import { processGroupAlive, processIdentityMatches, processIsDirectlyAlive, validProcessIdentity } from "./process-identity.mjs";

const SESSION_TABLES = ["sessions", "message_nodes", "tool_call_state", "live_row_times", "subagent_heads", "prompt_history", "rendered_commits"];
const ORDER_KEYS = { message_nodes: "row_id", prompt_history: "id", rendered_commits: "id" };

function jobMayBeLive(record) {
  if (record.status !== "running") return false;
  const processes = [[record.pid, record.pidIdentity], [record.devinPid, record.devinPidIdentity]]
    .filter(([pid]) => Number.isInteger(pid) && pid > 1);
  if (processes.some(([pid, identity]) => validProcessIdentity(identity) && processIdentityMatches(pid, identity)
    || processIsDirectlyAlive(pid) || processGroupAlive(pid))) return true;
  if (processes.length) return false;
  const createdAt = Date.parse(record.createdAt);
  return Number.isFinite(createdAt) && Date.now() - createdAt < 15000;
}

function tableColumns(db, schema, table) {
  const present = db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  return present ? db.prepare(`PRAGMA ${schema}.table_info("${table}")`).all().map((column) => column.name) : [];
}

function mergeSessions(privateFile, realFile) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const source = new DatabaseSync(privateFile, { timeout: 5000 });
  try {
    const checkpoint = source.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint.busy) throw new Error("Private session database checkpoint is busy");
    if (!fs.existsSync(realFile)) {
      source.prepare("VACUUM INTO ?").run(realFile);
      return;
    }
  } finally {
    source.close();
  }
  const real = new DatabaseSync(realFile, { timeout: 5000 });
  try {
    real.prepare("ATTACH DATABASE ? AS private_store").run(privateFile);
    real.exec("BEGIN IMMEDIATE");
    try {
      if (!tableColumns(real, "main", "sessions").includes("id") || !tableColumns(real, "private_store", "sessions").includes("id")) throw new Error("Missing sessions table");
      real.exec("CREATE TEMP TABLE missing_sessions AS SELECT p.id FROM private_store.sessions AS p WHERE NOT EXISTS (SELECT 1 FROM main.sessions AS r WHERE r.id = p.id)");
      for (const table of SESSION_TABLES) {
        const sourceColumns = tableColumns(real, "private_store", table);
        const targetColumns = tableColumns(real, "main", table);
        if (!sourceColumns.length || !targetColumns.length) continue;
        if (table !== "sessions" && (!sourceColumns.includes("session_id") || !targetColumns.includes("session_id"))) continue;
        const key = ORDER_KEYS[table];
        const columns = sourceColumns.filter((column) => targetColumns.includes(column) && column !== key);
        if (!columns.length) continue;
        const quoted = columns.map((column) => `"${column.replaceAll('"', '""')}"`);
        const joinColumn = table === "sessions" ? "id" : "session_id";
        const order = key && sourceColumns.includes(key) ? ` ORDER BY p."${key}"` : "";
        real.exec(`INSERT INTO main."${table}" (${quoted.join(", ")}) SELECT ${quoted.map((column) => `p.${column}`).join(", ")} FROM private_store."${table}" AS p JOIN missing_sessions AS m ON m.id = p."${joinColumn}"${order}`);
      }
      real.exec("COMMIT");
    } catch (error) {
      real.exec("ROLLBACK");
      throw error;
    }
  } finally {
    real.close();
  }
}

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
  const privateCli = path.join(homeDir, ".local", "share", "devin", "cli");
  const privateSessions = path.join(privateCli, "sessions.db");
  const realCli = path.join(path.dirname(target), "cli");
  const realSessions = path.join(realCli, "sessions.db");
  fs.mkdirSync(privateCli, { recursive: true, mode: 0o700 });
  fs.chmodSync(privateCli, 0o700);
  fs.mkdirSync(realCli, { recursive: true });
  try {
    withRecordLock(path.join(dataDir, ".devin-session-migration.json"), () => {
      const existing = fs.lstatSync(privateSessions, { throwIfNoEntry: false });
      if (existing?.isFile()) {
        if (listAllJobRecords(dataDir).some(({ record }) => jobMayBeLive(record))) return;
        try {
          mergeSessions(privateSessions, realSessions);
        } catch {
          return;
        }
        for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${privateSessions}${suffix}`, { force: true });
      } else if (existing && (!existing.isSymbolicLink() || fs.readlinkSync(privateSessions) !== realSessions)) {
        fs.rmSync(privateSessions, { recursive: true, force: true });
      }
      if (!fs.lstatSync(privateSessions, { throwIfNoEntry: false })) fs.symlinkSync(realSessions, privateSessions);
    });
  } catch {}
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
    ...(homeDir ? ["credentials.toml", "cli/sessions.db"].map((file) => `Read(${path.join(homeDir, ".local", "share", "devin", file)})`) : [])
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
