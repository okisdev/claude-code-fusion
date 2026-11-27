import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ignoredIncludes } from "./lib/worktree-include.mjs";

function main(args) {
  const [repo, topic] = args;
  if (args.length !== 2 || !repo || !topic) throw new Error("Usage: node create-worktree.mjs <repo root> <topic>");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", maxBuffer: Infinity }).toString().replace(/\n$/, "");
  const root = git(repo, "rev-parse", "--show-toplevel");
  git(root, "check-ref-format", "--branch", topic);
  const directory = path.join(root, ".claude", "worktrees");
  const worktree = path.resolve(directory, topic);
  if (!worktree.startsWith(directory + path.sep)) throw new Error("Topic must name a path inside .claude/worktrees.");
  const includes = ignoredIncludes(root);
  const exclude = git(root, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
  const contents = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  if (!contents.split(/\r?\n/).includes("**/.claude/worktrees/")) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${contents && !contents.endsWith("\n") ? "\n" : ""}**/.claude/worktrees/\n`);
  }
  git(root, "worktree", "add", "-q", "-b", topic, worktree, "HEAD");
  try {
    for (const file of includes) {
      const source = path.join(root, file);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(worktree, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(source, destination, fs.statSync(source).isDirectory() ? "dir" : "file");
    }
  } catch (error) {
    git(root, "worktree", "remove", "--force", worktree);
    git(root, "branch", "-D", topic);
    throw error;
  }
  console.log(worktree);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.stderr?.length ? error.stderr.toString().trimEnd() : error.message);
  process.exitCode = 1;
}
