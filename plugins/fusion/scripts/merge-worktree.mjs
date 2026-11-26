import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd, stdio: "pipe", maxBuffer: Infinity, ...options
  });
}

function records(output) {
  return output.toString().split("\0").filter(Boolean);
}

function line(output) {
  return output.toString().replace(/\n$/, "");
}

function display(file) {
  return /[\x00-\x1f\x7f]/.test(file) ? JSON.stringify(file) : file;
}

function mergeIndex(target, paths, patch) {
  const index = line(git(target, ["rev-parse", "--path-format=absolute", "--git-path", "index"]));
  const lock = index + ".lock";
  const env = { ...process.env, GIT_INDEX_FILE: lock };
  const run = (args, input) => git(target, args, { env, input });
  const names = (...args) => new Set(records(run(["diff", "--no-renames", "--name-only", "-z", ...args])));
  const update = (args, files, excluded = []) => {
    if (!files.length) return;
    const specs = [...files.map((file) => `:(literal)${file}`), ...excluded.map((file) => `:(exclude,literal)${file}`)];
    run([...args, "--pathspec-from-file=-", "--pathspec-file-nul"], specs.join("\0") + "\0");
  };
  const existingFile = (file) => {
    const stat = fs.lstatSync(path.join(target, file), { throwIfNoEntry: false });
    return stat && !stat.isDirectory();
  };

  fs.closeSync(fs.openSync(lock, "wx"));
  let conflicts;
  try {
    if (fs.existsSync(index)) {
      // Git treats entries as racily clean only relative to the index file's own mtime.
      const { atime, mtime } = fs.statSync(index);
      fs.copyFileSync(index, lock);
      fs.utimesSync(lock, atime, mtime);
    } else run(["read-tree", "--empty"]);

    const unmerged = names("--diff-filter=U");
    const unresolved = paths.filter((file) => unmerged.has(file));
    if (unresolved.length) throw new Error(unresolved.map((file) => `already conflicted ${display(file)}`).join("\n"));

    const staged = names("--cached", "--ita-invisible-in-index", "HEAD");
    const intentToAdd = names("--diff-filter=A", "--ita-invisible-in-index");
    const deleted = names("--diff-filter=D");
    update(["add"], paths.filter((file) => existingFile(file) || deleted.has(file)));

    conflicts = new Set();
    try {
      run(["apply", "--3way", "--whitespace=nowarn"], patch);
    } catch (error) {
      const after = names("--diff-filter=U");
      conflicts = new Set(paths.filter((file) => after.has(file)));
      if (!conflicts.size) throw error;
    }

    const unstaged = paths.filter((file) => !staged.has(file) && !conflicts.has(file));
    const descendants = [...new Set([...staged, ...conflicts])].filter((file) => unstaged.some((parent) => file.startsWith(parent + "/")));
    update(["reset", "-q", "HEAD"], unstaged, descendants);
    update(["add", "-N"], unstaged.filter((file) => intentToAdd.has(file) && existingFile(file)));
    fs.renameSync(lock, index);
  } catch (error) {
    fs.unlinkSync(lock);
    throw error;
  }
  return conflicts;
}

function main(args) {
  const [worktree, option, into] = args;
  if (!worktree || (args.length !== 1 && !(args.length === 3 && option === "--into" && into))) {
    throw new Error("usage: node merge-worktree.mjs <worktree> [--into <dir>]");
  }
  const root = (dir) => line(git(dir, ["rev-parse", "--show-toplevel"]));
  const source = root(worktree);
  const mainTree = () => records(git(source, ["worktree", "list", "--porcelain", "-z"]))[0].slice("worktree ".length);
  const target = root(into ?? mainTree());
  if (source === target) throw new Error("Source and target are the same worktree.");

  git(source, ["add", "-A"]);
  const sourceHead = line(git(source, ["rev-parse", "HEAD"]));
  const targetHead = line(git(target, ["rev-parse", "HEAD"]));
  if (sourceHead !== targetHead) console.log(`target HEAD ${targetHead} differs from worktree HEAD ${sourceHead}`);

  const patch = git(source, ["diff", "--cached", "--binary", "--find-renames", "--default-prefix", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD"]);
  if (!patch.length) {
    console.log("nothing to merge");
    return 0;
  }

  const numstat = records(git(target, ["apply", "--numstat", "-z"], { input: patch }));
  const removed = records(git(source, ["diff", "--cached", "--no-renames", "--diff-filter=D", "--name-only", "-z", "HEAD"]));
  const paths = [...new Set([...numstat.map((row) => row.replace(/^[^\t]+\t[^\t]+\t/, "")), ...removed])];
  const conflicts = mergeIndex(target, paths, patch);
  for (const file of paths) console.log(`${conflicts.has(file) ? "conflicted" : "merged"} ${display(file)}`);
  return conflicts.size ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error.stderr?.length ? error.stderr.toString().trimEnd() : error.message);
  process.exitCode = 1;
}
