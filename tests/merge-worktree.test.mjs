import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gitIsolation } from "./lib/git-fixture.mjs";

const script = path.resolve(import.meta.dirname, "../plugins/fusion/scripts/merge-worktree.mjs");
const write = (dir, file, content) => fs.writeFileSync(path.join(dir, file), content);
const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");

function fixture(t, files = { file: "base\n" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "merge-worktree-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, "main tree");
  const peer = path.join(root, "peer tree");
  const env = { ...process.env, ...gitIsolation(root) };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" });
  fs.mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  for (const [file, content] of Object.entries(files)) write(main, file, content);
  git(main, "add", "-A");
  git(main, "commit", "-qm", "base");
  git(main, "worktree", "add", "-qb", "peer", peer);

  function merge(status = 0, ...args) {
    const result = spawnSync(process.execPath, [script, peer, ...args], { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, status, result.error?.message ?? (result.stderr + result.stdout));
    return result;
  }
  return { main, peer, git, merge };
}

test("merges tracked and new files into the default main tree and leaves the peer staged", (t) => {
  const { main, peer, git, merge } = fixture(t);
  write(peer, "file", "first draft\n");
  git(peer, "add", "file");
  write(peer, "file", "final\n");
  write(peer, "new", "new content\n");

  assert.equal(merge().stdout, "merged file\nmerged new\n");
  assert.equal(read(main, "file"), "final\n");
  assert.equal(read(main, "new"), "new content\n");
  assert.equal(git(main, "status", "--porcelain"), " M file\n?? new\n");
  assert.equal(git(peer, "status", "--porcelain"), "M  file\nA  new\n");
  assert.equal(git(peer, "branch", "--show-current"), "peer\n");
});

test("keeps independent unstaged edits in both the patched file and an unrelated file", (t) => {
  const { main, peer, git, merge } = fixture(t, { file: "one\ntwo\nthree\n", other: "base\n" });
  write(main, "file", "main\ntwo\nthree\n");
  write(main, "other", "also main\n");
  write(peer, "file", "one\ntwo\npeer\n");

  assert.equal(merge().stdout, "merged file\n");
  assert.equal(read(main, "file"), "main\ntwo\npeer\n");
  assert.equal(read(main, "other"), "also main\n");
  assert.equal(git(main, "diff", "--cached"), "");
});

test("keeps a patched pre-staged file staged and preserves partial staging elsewhere", (t) => {
  const { main, peer, git, merge } = fixture(t, { file: "one\ntwo\nthree\n", other: "base\n" });
  write(main, "file", "staged\ntwo\nthree\n");
  write(main, "other", "other staged\n");
  git(main, "add", "file", "other");
  write(main, "file", "working\ntwo\nthree\n");
  write(main, "other", "other working\n");
  write(peer, "file", "one\ntwo\npeer\n");

  merge();
  assert.equal(read(main, "file"), "working\ntwo\npeer\n");
  assert.equal(git(main, "show", ":file"), read(main, "file"));
  assert.equal(git(main, "show", ":other"), "other staged\n");
  assert.equal(read(main, "other"), "other working\n");
});

test("applies a binary patch byte for byte", (t) => {
  const { main, peer, git, merge } = fixture(t, { image: Buffer.from([0, 1, 2, 255]) });
  const bytes = Buffer.from([0, 254, 13, 10, 128, 255]);
  write(peer, "image", bytes);

  assert.equal(merge().stdout, "merged image\n");
  assert.deepEqual(fs.readFileSync(path.join(main, "image")), bytes);
  assert.equal(git(main, "diff", "--cached"), "");
});

test("handles both rename paths literally and reports one line per path", (t) => {
  const old = "before[1]";
  const next = "after\tname\n";
  const { main, peer, git, merge } = fixture(t, { [old]: "base\n", before1: "other\n" });
  fs.renameSync(path.join(peer, old), path.join(peer, next));
  write(main, old, "local edit\n");
  write(main, "before1", "other edit\n");

  assert.deepEqual(merge().stdout.trimEnd().split("\n").sort(), [`merged ${JSON.stringify(next)}`, `merged ${old}`]);
  assert.equal(fs.existsSync(path.join(main, old)), false);
  assert.equal(read(main, next), "local edit\n");
  assert.equal(git(main, "diff", "--cached"), "");
});

test("removes a deleted file from the target working tree", (t) => {
  const { main, peer, git, merge } = fixture(t);
  fs.unlinkSync(path.join(peer, "file"));

  assert.equal(merge().stdout, "merged file\n");
  assert.equal(fs.existsSync(path.join(main, "file")), false);
  assert.equal(git(main, "status", "--porcelain"), " D file\n");
});

test("keeps conflict markers and unmerged stages while unstaging clean paths", (t) => {
  const { main, peer, git, merge } = fixture(t, { a: "base\n", b: "base\n", c: "base\n" });
  for (const file of ["a", "b"]) write(main, file, "main\n");
  for (const file of ["a", "b", "c"]) write(peer, file, "peer\n");

  assert.equal(merge(1).stdout, "conflicted a\nconflicted b\nmerged c\n");
  for (const file of ["a", "b"]) {
    assert.match(read(main, file), /<<<<<<< .*\nmain\n=======\npeer\n>>>>>>> /);
    assert.equal(git(main, "show", `:2:${file}`), "main\n");
    assert.equal(git(main, "show", `:3:${file}`), "peer\n");
  }
  assert.equal(read(main, "c"), "peer\n");
  assert.equal(git(main, "status", "--porcelain"), "UU a\nUU b\n M c\n");
  assert.match(merge(1).stderr, /already conflicted a/);
  assert.equal(git(main, "show", ":2:a"), "main\n");
});

test("returns success for an empty source diff", (t) => {
  const { main, git, merge } = fixture(t);
  write(main, "file", "main\n");
  assert.equal(merge().stdout, "nothing to merge\n");
  assert.equal(git(main, "status", "--porcelain"), " M file\n");
});

test("uses --into and reports diverging HEADs while merging changes from both trees", (t) => {
  const { main, peer, git, merge } = fixture(t, { file: "one\ntwo\nthree\n" });
  const into = path.join(path.dirname(main), "other worktree");
  git(main, "worktree", "add", "-qb", "other", into);
  write(into, "file", "other\ntwo\nthree\n");
  git(into, "commit", "-qam", "move target");
  write(peer, "file", "one\ntwo\npeer\n");

  const targetHead = git(into, "rev-parse", "HEAD").trim();
  const sourceHead = git(peer, "rev-parse", "HEAD").trim();
  assert.equal(merge(0, "--into", into).stdout, `target HEAD ${targetHead} differs from worktree HEAD ${sourceHead}\nmerged file\n`);
  assert.equal(read(into, "file"), "other\ntwo\npeer\n");
  assert.equal(git(into, "diff", "--cached"), "");
  assert.equal(git(main, "status", "--porcelain"), "");
});

test("preserves intent to add when the peer adds the same file", (t) => {
  const { main, peer, git, merge } = fixture(t);
  write(main, "new", "shared\n");
  git(main, "add", "-N", "new");
  write(peer, "new", "shared\n");

  assert.equal(merge().stdout, "merged new\n");
  assert.equal(git(main, "status", "--porcelain"), " A new\n");
});

test("keeps a staged deletion beneath a new file when the target HEAD has moved", (t) => {
  const { main, peer, git, merge } = fixture(t);
  fs.mkdirSync(path.join(main, "entry"));
  write(main, "entry/child", "only in main\n");
  git(main, "add", "entry/child");
  git(main, "commit", "-qm", "add child");
  git(main, "rm", "entry/child");
  write(peer, "entry", "from peer\n");

  merge();
  assert.equal(read(main, "entry"), "from peer\n");
  assert.equal(git(main, "status", "--porcelain"), "D  entry/child\n?? entry\n");
});

test("restores partial staging, intent to add and unstaged deletions on a hard failure", (t) => {
  const { main, peer, git, merge } = fixture(t, { file: "base\n", missing: "base\n" });
  write(main, "file", "staged\n");
  git(main, "add", "file");
  write(main, "file", "working\n");
  write(main, "new", "intent\n");
  git(main, "add", "-N", "new");
  fs.unlinkSync(path.join(main, "missing"));
  for (const file of ["file", "new", "missing"]) write(peer, file, "peer\n");
  const indexPath = path.join(main, ".git", "index");
  const before = fs.readFileSync(indexPath);

  const result = merge(1);
  assert.match(result.stderr, /error: missing:/);
  assert.doesNotMatch(result.stdout, /merged |conflicted /);
  assert.deepEqual(fs.readFileSync(indexPath), before);
  assert.equal(read(main, "file"), "working\n");
  assert.equal(read(main, "new"), "intent\n");
  assert.equal(fs.existsSync(path.join(main, "missing")), false);
});
