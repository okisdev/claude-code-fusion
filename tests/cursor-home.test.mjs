import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPrivateHome, copyChatForResume, projectHookFiles, removePrivateHome } from "../plugins/cursor/scripts/lib/cursor-home.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-home-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("private homes isolate configuration and choose each mode's sandbox", (t) => {
  const root = fixture(t);
  const realHome = path.join(root, "real");
  fs.mkdirSync(path.join(realHome, "Library", "Keychains"), { recursive: true });
  for (const mode of ["consult", "review", "write"]) {
    const homeDir = path.join(root, mode);
    const { configPath, sandboxPath } = buildPrivateHome({ homeDir, mode, cwd: root, realHome, platform: "darwin" });
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const sandbox = JSON.parse(fs.readFileSync(sandboxPath, "utf8"));
    assert.deepEqual(config, {
      version: 1,
      approvalMode: "allowlist",
      sandbox: { mode: "enabled", networkAccess: "user_config_only", networkAllowlist: [], readBoundary: "workspace" },
      autoAcceptWebSearch: false,
      attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false },
      permissions: { allow: [], deny: mode === "write" ? [] : ["Write(**)"] }
    });
    assert.equal(sandbox.type, mode === "write" ? "workspace_readwrite" : "workspace_readonly");
    assert.equal(sandbox.readBoundary, "workspace");
    assert.deepEqual(sandbox.networkPolicy, { default: "deny" });
    assert.equal(config.sandbox.networkAccess, "user_config_only");
    assert.deepEqual(config.sandbox.networkAllowlist, []);
    assert.equal(sandbox.networkPolicy.default, "deny");
    assert.equal(fs.readlinkSync(path.join(homeDir, "Library", "Keychains")), path.join(realHome, "Library", "Keychains"));
    for (const name of ["plugins", "skills-cursor"]) {
      const directory = path.join(homeDir, ".cursor", name);
      assert.deepEqual(fs.readdirSync(directory), []);
      assert.equal(fs.statSync(directory).mode & 0o777, 0o555);
    }
    removePrivateHome(homeDir);
    assert.equal(fs.existsSync(homeDir), false);
  }
  const linuxHome = path.join(root, "linux");
  buildPrivateHome({ homeDir: linuxHome, mode: "consult", cwd: root, realHome, platform: "linux" });
  assert.equal(fs.existsSync(path.join(linuxHome, "Library")), false);
  removePrivateHome(linuxHome);
});

test("private homes share one private npm cache and replace a legacy local cache", (t) => {
  const root = fixture(t);
  const data = path.join(root, "data");
  const homes = ["first", "second"].map((id) => path.join(data, "runs", id, "home"));
  const cache = path.join(data, "npm-cache");
  fs.mkdirSync(path.join(homes[0], ".npm"), { recursive: true });
  fs.writeFileSync(path.join(homes[0], ".npm", "old"), "old");
  for (const homeDir of homes) {
    buildPrivateHome({ homeDir, mode: "consult", cwd: root, realHome: root });
    const link = path.join(homeDir, ".npm");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(link), cache);
    assert.equal(fs.statSync(cache).mode & 0o777, 0o700);
  }
  assert.equal(fs.existsSync(path.join(cache, "old")), false);
  fs.writeFileSync(path.join(homes[0], ".npm", "shared"), "cache");
  assert.equal(fs.readFileSync(path.join(homes[1], ".npm", "shared"), "utf8"), "cache");
  removePrivateHome(homes[0]);
  assert.equal(fs.readFileSync(path.join(cache, "shared"), "utf8"), "cache");
});

test("write sandbox adds installed runtimes and linked worktree Git directories", (t) => {
  const root = fixture(t);
  const installs = path.join(root, "mise", "installs");
  fs.mkdirSync(installs, { recursive: true });
  const repo = path.join(root, "repo");
  const cwd = path.join(root, "linked");
  fs.mkdirSync(repo);
  const git = (args, at = repo) => {
    const result = spawnSync("git", args, { cwd: at, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git(["init", "-q"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
  git(["worktree", "add", "-q", "--detach", cwd]);
  assert.equal(fs.statSync(path.join(cwd, ".git")).isFile(), true);
  const gitPaths = git(["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"], cwd).trim().split("\n");
  const homeDir = path.join(root, "home");
  const { sandboxPath } = buildPrivateHome({ homeDir, mode: "write", cwd, realHome: root, env: { MISE_DATA_DIR: path.dirname(installs) } });
  const sandbox = JSON.parse(fs.readFileSync(sandboxPath, "utf8"));
  assert.deepEqual(sandbox.additionalReadonlyPaths, [installs, gitPaths[0]]);
  assert.deepEqual(sandbox.additionalReadwritePaths, [gitPaths[1]]);
  removePrivateHome(homeDir);
});

test("resume copies only the matching workspace chat", (t) => {
  const root = fixture(t);
  const cwd = path.join(root, "workspace");
  const fromHome = path.join(root, "from");
  const toHome = path.join(root, "to");
  const hash = createHash("md5").update(path.resolve(cwd)).digest("hex");
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const chat = path.join(fromHome, ".cursor", "chats", hash, sessionId);
  fs.mkdirSync(chat, { recursive: true });
  fs.writeFileSync(path.join(chat, "state.json"), "chat");
  assert.equal(copyChatForResume({ fromHome, toHome, cwd, sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }), false);
  assert.equal(copyChatForResume({ fromHome, toHome, cwd, sessionId }), true);
  assert.equal(fs.readFileSync(path.join(toHome, ".cursor", "chats", hash, sessionId, "state.json"), "utf8"), "chat");
});

test("resume rejects traversal session ids before reading or copying", (t) => {
  const root = fixture(t);
  for (const sessionId of ["../..", "a/../../b"]) {
    assert.throws(() => copyChatForResume({ fromHome: root, toHome: path.join(root, "to"), cwd: root, sessionId }), (error) => error.failureKind === "input");
  }
  assert.equal(fs.existsSync(path.join(root, "to")), false);
});

test("project hook scan reports only nonempty hook objects", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".cursor"));
  fs.mkdirSync(path.join(root, ".claude"));
  fs.writeFileSync(path.join(root, ".cursor", "hooks.json"), '{"hooks":{"SessionStart":[{"command":"ok"}]}}');
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), '{"hooks":{}}');
  fs.writeFileSync(path.join(root, ".claude", "settings.local.json"), '{"hooks":{"Stop":[]}}');
  assert.deepEqual(projectHookFiles(root), [".cursor/hooks.json", ".claude/settings.local.json"]);
});
