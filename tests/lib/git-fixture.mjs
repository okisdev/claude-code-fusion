import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const gitIsolation = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export function git(dir, args) {
  const result = spawnSync("git", args, {
    cwd: dir,
    env: { ...process.env, ...gitIsolation },
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
