import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gitIsolation } from "./lib/git-fixture.mjs";

const scripts = path.resolve(import.meta.dirname, "../plugins/fusion/scripts");

function fixture(t, patterns) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "create-worktree-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, "main tree");
  fs.mkdirSync(main);
  const env = { ...process.env, ...gitIsolation(root) };
  const git = (...args) => execFileSync("git", args, { cwd: main, env, encoding: "utf8", stdio: "pipe" });
  const write = (file, contents = "artifact\n") => {
    const destination = path.join(main, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  };
  git("init", "-q", "-b", "main");
  write("source", "base\n");
  write("native/Tracked.framework/header", "tracked\n");
  git("add", "-A");
  write(".gitignore", "native/\n*.a\ncache/\n");
  if (patterns !== undefined) write(".worktreeinclude", patterns);
  git("add", "-A");
  git("commit", "-qm", "base");
  const create = (topic = "peer", status = 0) => {
    const result = spawnSync(process.execPath, [path.join(scripts, "create-worktree.mjs"), main, topic], { env, encoding: "utf8" });
    assert.equal(result.status, status, result.stderr + result.stdout);
    return result;
  };
  return { main, env, git, write, create };
}

test("creates a branch from HEAD without an include file and excludes worktrees once", (t) => {
  const { main, git, create } = fixture(t);
  const exclude = path.join(main, ".git/info/exclude");
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.writeFileSync(exclude, "# existing rule\nlocal-only");
  for (const topic of ["peer", "second"]) {
    const worktree = path.join(main, ".claude/worktrees", topic);
    assert.equal(create(topic).stdout, worktree + "\n");
    assert.equal(git("-C", worktree, "rev-parse", "HEAD"), git("rev-parse", "HEAD"));
    assert.equal(git("-C", worktree, "branch", "--show-current"), topic + "\n");
    assert.equal(fs.readFileSync(path.join(worktree, "source"), "utf8"), "base\n");
  }
  assert.equal(fs.readFileSync(exclude, "utf8"), "# existing rule\nlocal-only\n**/.claude/worktrees/\n");
  assert.equal(git("status", "--porcelain"), "");
});

test("links only ignored existing matches with Git patterns, comments, escapes and negation", (t) => {
  const { main, write, create } = fixture(t, "# artifacts\r\n/native/**/*.framework/\r\n/native/**/*.a\r\n!native/**/skip.a\r\n*.a\r\n!skip.a\r\n\\#generated.a\r\nmissing/\r\nordinary.txt\r\nsource\r\n");
  for (const file of ["native/Prebuilt.framework/binary", "native/deep/lib.a", "native/deep/skip.a", "native/unselected.txt", "lib space.a", "skip.a", "#generated.a", "ordinary.txt"]) write(file);
  const peer = create().stdout.trimEnd();
  for (const file of ["native/Prebuilt.framework", "native/deep/lib.a", "lib space.a", "#generated.a"]) {
    const destination = path.join(peer, file);
    assert.equal(fs.lstatSync(destination).isSymbolicLink(), true, file);
    assert.equal(fs.readlinkSync(destination), path.join(main, file));
  }
  for (const file of ["native/deep/skip.a", "native/unselected.txt", "skip.a", "ordinary.txt", "missing"]) {
    assert.equal(fs.existsSync(path.join(peer, file)), false, file);
  }
  for (const file of ["source", "native/Tracked.framework", "native/Tracked.framework/header"]) {
    assert.equal(fs.lstatSync(path.join(peer, file)).isSymbolicLink(), false, file);
  }
});

test("selects ignored files inside an included directory without linking ordinary siblings", (t) => {
  const { write, create } = fixture(t, "assets/\n");
  write("assets/native.a");
  write("assets/ordinary.txt");
  const peer = create().stdout.trimEnd();
  assert.equal(fs.lstatSync(path.join(peer, "assets/native.a")).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(peer, "assets")).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(peer, "assets/ordinary.txt")), false);
});

test("links the matching file when every file in its parent matches a glob", (t) => {
  const { write, create } = fixture(t, "*.a\n");
  write("assets/lib.a");
  const peer = create().stdout.trimEnd();
  assert.equal(fs.lstatSync(path.join(peer, "assets")).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(path.join(peer, "assets/lib.a")).isSymbolicLink(), true);
});

test("links an ignored directory without copying it or replacing tracked descendants", (t) => {
  const { main, write, create } = fixture(t, "native/\ncache/\n");
  write("native/Tracked.framework/generated.a");
  write("native/Prebuilt.framework/binary");
  write("cache/generated/binding");
  fs.mkdirSync(path.join(main, "cache/empty"));
  const peer = create().stdout.trimEnd();
  assert.equal(fs.lstatSync(path.join(peer, "cache")).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(path.join(peer, "cache")), path.join(main, "cache"));
  assert.equal(fs.lstatSync(path.join(peer, "native/Tracked.framework")).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(path.join(peer, "native/Tracked.framework/generated.a")).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(peer, "native/Prebuilt.framework")).isSymbolicLink(), true);
});

test("reports invalid topics and existing branches without replacing their worktrees", (t) => {
  const { main, git, create } = fixture(t);
  assert.match(create("../escape", 1).stderr, /valid branch|inside .claude\/worktrees/i);
  const peer = create().stdout.trimEnd();
  assert.match(create("peer", 1).stderr, /already exists/i);
  assert.equal(fs.readFileSync(path.join(peer, "source"), "utf8"), "base\n");
  assert.equal(git("branch", "--show-current"), "main\n");
  assert.equal(fs.existsSync(path.join(main, ".claude/escape")), false);
});

test("includes ignored files under .claude without linking worktrees into themselves", (t) => {
  const { main, write, create } = fixture(t, ".claude/\n");
  write(".claude/local.a");
  for (const topic of ["peer", "second"]) {
    const peer = create(topic).stdout.trimEnd();
    assert.equal(fs.lstatSync(path.join(peer, ".claude/local.a")).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(peer, ".claude/worktrees")), false);
  }
  assert.equal(fs.lstatSync(path.join(main, ".claude/worktrees")).isSymbolicLink(), false);
});

test("merges edits while keeping included directory and forced staged file links out of the patch", (t) => {
  const { main, env, git, write, create } = fixture(t, "native/\n*.a\n");
  write("native/Prebuilt.framework/binary");
  write("lib.a");
  const peer = create().stdout.trimEnd();
  fs.writeFileSync(path.join(peer, "source"), "peer\n");
  git("-C", peer, "add", "-f", "lib.a", "native/Prebuilt.framework");
  const result = spawnSync(process.execPath, [path.join(scripts, "merge-worktree.mjs"), peer], { cwd: main, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "merged source\n");
  assert.equal(fs.readFileSync(path.join(main, "source"), "utf8"), "peer\n");
  assert.equal(git("status", "--porcelain"), " M source\n");
  assert.equal(fs.lstatSync(path.join(peer, "native/Prebuilt.framework")).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(main, "native/Prebuilt.framework/binary"), "utf8"), "artifact\n");
});
