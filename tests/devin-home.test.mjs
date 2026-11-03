import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildJobConfig, ensurePrivateHome, projectConfigFiles, realCredentialsPath, removeJobConfig, worktreeGitDirs } from "../plugins/devin/scripts/lib/devin-home.mjs";
import { createJobRecord, jobFilePath } from "../plugins/devin/scripts/lib/state.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devin-home-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("credential path uses absolute XDG data home and otherwise the real home", (t) => {
  const root = fixture(t);
  const realHome = path.join(root, "real");
  assert.equal(realCredentialsPath({ env: { XDG_DATA_HOME: path.join(root, "xdg") }, realHome }), path.join(root, "xdg", "devin", "credentials.toml"));
  for (const env of [{}, { XDG_DATA_HOME: "relative/data" }]) {
    assert.equal(realCredentialsPath({ env, realHome }), path.join(realHome, ".local", "share", "devin", "credentials.toml"));
  }
});

test("private home creates only its XDG directories and repairs credentials link", (t) => {
  const root = fixture(t);
  const dataDir = path.join(root, "data");
  const realHome = path.join(root, "real");
  const target = path.join(root, "external", "devin", "credentials.toml");
  const homeDir = path.join(dataDir, "home");
  const link = path.join(homeDir, ".local", "share", "devin", "credentials.toml");
  const sessionLink = path.join(homeDir, ".local", "share", "devin", "cli", "sessions.db");
  const sessionTarget = path.join(root, "external", "devin", "cli", "sessions.db");
  const args = { dataDir, env: { XDG_DATA_HOME: path.join(root, "external") }, realHome };
  assert.deepEqual(ensurePrivateHome(args), { homeDir });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), target);
  assert.equal(fs.readlinkSync(sessionLink), sessionTarget);
  assert.equal(fs.statSync(path.dirname(sessionTarget)).isDirectory(), true);
  for (const directory of [homeDir, path.join(homeDir, ".local"), path.join(homeDir, ".local", "share"), path.join(homeDir, ".local", "share", "devin"), path.join(homeDir, ".local", "state"), path.join(homeDir, ".cache")]) {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
  assert.deepEqual(fs.readdirSync(homeDir).sort(), [".cache", ".local"]);
  fs.rmSync(link);
  fs.symlinkSync(path.join(root, "wrong"), link);
  ensurePrivateHome(args);
  assert.equal(fs.readlinkSync(link), target);
  fs.rmSync(link);
  fs.writeFileSync(link, "wrong credential");
  ensurePrivateHome(args);
  assert.equal(fs.readlinkSync(link), target);
  fs.rmSync(sessionLink);
  fs.symlinkSync(path.join(root, "wrong-session"), sessionLink);
  ensurePrivateHome(args);
  assert.equal(fs.readlinkSync(sessionLink), sessionTarget);
  fs.rmSync(sessionLink);
  fs.mkdirSync(sessionLink);
  ensurePrivateHome(args);
  assert.equal(fs.readlinkSync(sessionLink), sessionTarget);
});

function sessionFixture(t) {
  const root = fixture(t);
  const dataDir = path.join(root, "data");
  const realHome = path.join(root, "real");
  const privateFile = path.join(dataDir, "home", ".local", "share", "devin", "cli", "sessions.db");
  const realFile = path.join(realHome, ".local", "share", "devin", "cli", "sessions.db");
  const args = { dataDir, realHome, env: {} };
  fs.mkdirSync(path.dirname(privateFile), { recursive: true });
  return { dataDir, privateFile, realFile, args };
}

function createSessionDb(file, { older = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT${older ? "" : ", newer TEXT"});
    CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, node_id TEXT, body TEXT${older ? "" : ", newer TEXT"}, UNIQUE(session_id, node_id));
    CREATE TABLE prompt_history (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, prompt TEXT);
    CREATE TABLE rendered_commits (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, body TEXT);
    ${older ? "" : "CREATE TABLE live_row_times (session_id TEXT, value TEXT);"}
  `);
  return db;
}

function rows(db, sql) {
  return db.prepare(sql).all().map((row) => ({ ...row }));
}

test("private session database moves into a missing real database", (t) => {
  const { privateFile, realFile, args } = sessionFixture(t);
  const db = createSessionDb(privateFile);
  db.exec("INSERT INTO sessions VALUES ('first', 'title', 'new'); INSERT INTO message_nodes (session_id, node_id, body, newer) VALUES ('first', 'node', 'body', 'new')");
  db.close();
  ensurePrivateHome(args);
  assert.equal(fs.lstatSync(privateFile).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(privateFile), realFile);
  const real = new DatabaseSync(realFile);
  assert.deepEqual(rows(real, "SELECT id, title, newer FROM sessions"), [{ id: "first", title: "title", newer: "new" }]);
  assert.deepEqual(rows(real, "SELECT session_id, node_id, body FROM message_nodes"), [{ session_id: "first", node_id: "node", body: "body" }]);
  real.close();
  for (const suffix of ["-wal", "-shm"]) assert.equal(fs.existsSync(`${privateFile}${suffix}`), false);
});

test("private sessions merge into older real schema by new session and common columns", (t) => {
  const { privateFile, realFile, args } = sessionFixture(t);
  const real = createSessionDb(realFile, { older: true });
  real.exec("INSERT INTO sessions VALUES ('existing', 'real'); INSERT INTO message_nodes (session_id, node_id, body) VALUES ('existing', 'same', 'real body')");
  real.close();
  const privateDb = createSessionDb(privateFile);
  privateDb.exec(`
    INSERT INTO sessions VALUES ('existing', 'private', 'new');
    INSERT INTO sessions VALUES ('fresh', 'private fresh', 'new');
    INSERT INTO message_nodes (session_id, node_id, body, newer) VALUES ('existing', 'same', 'private body', 'new');
    INSERT INTO message_nodes (session_id, node_id, body, newer) VALUES ('fresh', 'second', 'two', 'new');
    INSERT INTO message_nodes (session_id, node_id, body, newer) VALUES ('fresh', 'first', 'one', 'new');
    INSERT INTO prompt_history (session_id, prompt) VALUES ('fresh', 'prompt two'), ('fresh', 'prompt one');
    INSERT INTO rendered_commits (session_id, body) VALUES ('fresh', 'commit');
    INSERT INTO live_row_times VALUES ('fresh', 'time');
  `);
  privateDb.close();
  ensurePrivateHome(args);
  assert.equal(fs.readlinkSync(privateFile), realFile);
  const merged = new DatabaseSync(realFile);
  assert.deepEqual(rows(merged, "SELECT id, title FROM sessions ORDER BY id"), [{ id: "existing", title: "real" }, { id: "fresh", title: "private fresh" }]);
  assert.deepEqual(rows(merged, "SELECT session_id, node_id, body FROM message_nodes ORDER BY row_id"), [
    { session_id: "existing", node_id: "same", body: "real body" },
    { session_id: "fresh", node_id: "second", body: "two" },
    { session_id: "fresh", node_id: "first", body: "one" }
  ]);
  assert.deepEqual(rows(merged, "SELECT prompt FROM prompt_history ORDER BY id"), [{ prompt: "prompt two" }, { prompt: "prompt one" }]);
  assert.deepEqual(rows(merged, "SELECT body FROM rendered_commits"), [{ body: "commit" }]);
  assert.equal(merged.prepare("SELECT 1 FROM sqlite_master WHERE name = 'live_row_times'").get(), undefined);
  merged.close();
  for (const suffix of ["-wal", "-shm"]) assert.equal(fs.existsSync(`${privateFile}${suffix}`), false);
});

test("failed session merge keeps the private store for retry", (t) => {
  const { privateFile, realFile, args } = sessionFixture(t);
  const privateDb = createSessionDb(privateFile);
  privateDb.exec("INSERT INTO sessions VALUES ('fresh', 'private', 'new')");
  privateDb.close();
  fs.mkdirSync(path.dirname(realFile), { recursive: true });
  const real = new DatabaseSync(realFile);
  real.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, required TEXT NOT NULL)");
  real.close();
  ensurePrivateHome(args);
  assert.equal(fs.lstatSync(privateFile).isFile(), true);
  const retry = new DatabaseSync(privateFile);
  assert.deepEqual(rows(retry, "SELECT id FROM sessions"), [{ id: "fresh" }]);
  retry.close();
  const unchanged = new DatabaseSync(realFile);
  assert.equal(unchanged.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
  unchanged.close();
});

test("live companion job defers private session migration", (t) => {
  const { dataDir, privateFile, realFile, args } = sessionFixture(t);
  const db = createSessionDb(privateFile);
  db.exec("INSERT INTO sessions VALUES ('fresh', 'private', 'new')");
  db.close();
  const cwd = path.join(path.dirname(dataDir), "workspace");
  const id = "other-job";
  const file = jobFilePath(dataDir, cwd, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(createJobRecord({ id, cwd, mode: "consult", pid: process.pid })));
  ensurePrivateHome(args);
  assert.equal(fs.lstatSync(privateFile).isFile(), true);
  assert.equal(fs.existsSync(realFile), false);
});

test("job config contains the exact base policy and consult or review tool denies", (t) => {
  const root = fixture(t);
  const realHome = path.join(root, "real");
  const sensitive = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config", ".local/share", ".claude", ".codex", ".grok", ".cursor", ".devin", "Library/Keychains", "Library/Application Support"];
  const baseDeny = ["Fetch(*)", ...sensitive.map((dir) => `Read(${path.join(realHome, dir)}/**)`), ...[".netrc", ".npmrc", ".git-credentials"].map((file) => `Read(${path.join(realHome, file)})`), `Read(${path.join(realHome, ".local", "share", "devin")}/**)`];
  for (const mode of ["consult", "review", "write"]) {
    const configDir = path.join(root, mode, "config");
    assert.deepEqual(buildJobConfig({ configDir, mode, cwd: root, realHome, env: {} }), { configDir });
    const configPath = path.join(configDir, "devin", "config.json");
    const mcpPath = path.join(configDir, "devin", "mcp_config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(config, {
      auto_update: false,
      attribution: false,
      subagents_enabled: false,
      notify: "never",
      read_config_from: { agents_standard: true, cursor: false, windsurf: false, claude: false, copilot: false, opencode: false, zed: false, cloud: false },
      permissions: {
        ask: [],
        deny: mode === "write" ? baseDeny : [...baseDeny, "edit", "exec"],
        ...(mode === "write" ? { allow: [`Write(${root}/**)`] } : {})
      }
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(mcpPath, "utf8")), { mcpServers: {} });
    for (const filename of [configPath, mcpPath]) assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    for (const directory of [configDir, path.join(configDir, "devin")]) assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    removeJobConfig(configDir);
    assert.equal(fs.existsSync(configDir), false);
    removeJobConfig(configDir);
  }
  assert.throws(() => buildJobConfig({ configDir: path.join(root, "bad"), mode: "unknown", cwd: root, realHome }), /Invalid Devin mode/);
});

test("write mode grants only workspace and linked worktree Git directory", (t) => {
  const root = fixture(t);
  const configDir = path.join(root, "config");
  const cwd = path.join(root, "workspace");
  const worktreeGitDir = path.join(root, "repo", ".git", "worktrees", "linked");
  const commonDir = path.join(root, "repo", ".git");
  buildJobConfig({ configDir, mode: "write", cwd, realHome: root, gitDirs: { worktreeGitDir, commonDir } });
  const config = JSON.parse(fs.readFileSync(path.join(configDir, "devin", "config.json"), "utf8"));
  assert.deepEqual(config.permissions.allow, [`Write(${cwd}/**)`, `Write(${worktreeGitDir}/**)`]);
  assert.equal(config.permissions.allow.some((rule) => rule.includes(commonDir + "/**)")), false);
});

test("linked worktree Git directories are absolute and ordinary repositories return null", (t) => {
  const root = fixture(t);
  const repo = path.join(root, "repo");
  const linked = path.join(root, "linked");
  fs.mkdirSync(repo);
  const git = (args, cwd = repo) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  };
  git(["init", "-q"]);
  assert.deepEqual(worktreeGitDirs(repo), { worktreeGitDir: null, commonDir: null });
  git(["worktree", "add", "--orphan", "-b", "linked", linked]);
  const [worktreeGitDir, commonDir] = git(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], linked).split(/\r?\n/);
  assert.deepEqual(worktreeGitDirs(linked), { worktreeGitDir, commonDir });
  assert.notEqual(worktreeGitDir, commonDir);
  git(["worktree", "remove", "--force", linked]);
});

test("project config scan reports existing Devin configuration files as absolute paths", (t) => {
  const root = fixture(t);
  const devinDir = path.join(root, ".devin");
  fs.mkdirSync(devinDir);
  assert.deepEqual(projectConfigFiles(root), []);
  for (const name of ["config.json", "config.local.json", "mcp_config.json", "mcp_config.local.json"]) fs.writeFileSync(path.join(devinDir, name), "{}");
  assert.deepEqual(projectConfigFiles(root), ["config.json", "config.local.json", "mcp_config.json", "mcp_config.local.json"].map((name) => path.join(devinDir, name)));
  fs.rmSync(path.join(devinDir, "mcp_config.local.json"));
  assert.deepEqual(projectConfigFiles(root), ["config.json", "config.local.json", "mcp_config.json"].map((name) => path.join(devinDir, name)));
});

test("job config denies the resolved credential directory and its private home link", (t) => {
  const root = fixture(t);
  const realHome = path.join(root, "real");
  const xdg = path.join(root, "account-data");
  const homeDir = path.join(root, "private-home");
  const configDir = path.join(root, "config");
  buildJobConfig({ configDir, mode: "write", cwd: root, realHome, env: { XDG_DATA_HOME: xdg }, homeDir });
  const { deny } = JSON.parse(fs.readFileSync(path.join(configDir, "devin", "config.json"), "utf8")).permissions;
  assert.ok(deny.includes(`Read(${path.join(xdg, "devin")}/**)`));
  assert.ok(deny.includes(`Read(${path.join(homeDir, ".local", "share", "devin", "credentials.toml")})`));
  assert.ok(deny.includes(`Read(${path.join(homeDir, ".local", "share", "devin", "cli", "sessions.db")})`));
});
