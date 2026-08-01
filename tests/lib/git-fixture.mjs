import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function gitIsolation(root) {
  const home = path.join(root, ".git-test-home");
  const template = path.join(home, "template");
  fs.mkdirSync(template, { recursive: true, mode: 0o700 });
  return {
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_VALUE_0: "false",
    GIT_TEMPLATE_DIR: template,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, "config")
  };
}

export function git(dir, args) {
  const result = spawnSync("git", args, {
    cwd: dir,
    env: { ...process.env, ...gitIsolation(path.dirname(dir)) },
    encoding: "utf8",
  });
  assert.strictEqual(result.status, 0, result.stderr);
}

export function initCleanRepo(dir) {
  git(dir, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "app.mjs"), "export const value = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init fixture"]);
}

export function dirtyRepo(dir) {
  fs.appendFileSync(path.join(dir, "app.mjs"), "export const other = 2;\n");
  fs.writeFileSync(path.join(dir, "untracked.txt"), "new file\n");
}

export function initFixtureRepo(dir) {
  initCleanRepo(dir);
  dirtyRepo(dir);
}
