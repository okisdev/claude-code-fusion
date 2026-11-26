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

function refusePaths(message, files) {
  if (files.length) throw new Error(files.map((file) => `${message} ${display(file)}`).join("\n"));
}

function changedPaths(run, ...args) {
  return new Set(records(run(["diff", "--no-renames", "--name-only", "-z", ...args])));
}

function updatePaths(run, args, files, excluded = []) {
  if (!files.length) return;
  const specs = [...files.map((file) => `:(literal)${file}`), ...excluded.map((file) => `:(exclude,literal)${file}`)];
  run([...args, "--pathspec-from-file=-", "--pathspec-file-nul"], specs.join("\0") + "\0");
}

function withLockedIndex(cwd, operation) {
  const index = line(git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]));
  const lock = index + ".lock";
  const env = { ...process.env, GIT_INDEX_FILE: lock };
  const run = (args, input) => git(cwd, args, { env, input });
  fs.closeSync(fs.openSync(lock, "wx"));
  let committed = false;
  try {
    if (fs.existsSync(index)) {
      // Git treats entries as racily clean only relative to the index file's own mtime.
      const { atime, mtime } = fs.statSync(index);
      fs.copyFileSync(index, lock);
      fs.utimesSync(lock, atime, mtime);
    } else run(["read-tree", "--empty"]);

    return operation(run, () => {
      fs.renameSync(lock, index);
      committed = true;
    });
  } finally {
    if (!committed) fs.unlinkSync(lock);
  }
}

function checkPartial(sourceGit, candidates) {
  if (!candidates.size) return;
  const untracked = new Set(records(sourceGit(["ls-files", "--others", "--exclude-standard", "-z"])).map((file) => file.replace(/\/$/, "")));
  const stagedDeletes = changedPaths(sourceGit, "--cached", "--diff-filter=D", "HEAD");
  const recreated = [...candidates].filter((file) => stagedDeletes.has(file) && untracked.has(file));
  updatePaths(sourceGit, ["reset", "-q", "HEAD"], recreated);
  const tracked = changedPaths(sourceGit, "--ignore-submodules=dirty", "HEAD");
  for (const file of recreated) untracked.delete(file);
  refusePaths("partially staged", [...candidates].filter((file) => tracked.has(file) || untracked.has(file)));
}

function mergeInto(target, sourceGit, stageSource) {
  return withLockedIndex(target, (run, commit) => {
    const existingFile = (file) => {
      const stat = fs.lstatSync(path.join(target, file), { throwIfNoEntry: false });
      return stat && !stat.isDirectory();
    };

    const staged = changedPaths(run, "--cached", "--ita-invisible-in-index", "HEAD");
    const workingChanges = changedPaths(run);
    const stagedDeletes = changedPaths(run, "--cached", "--diff-filter=D", "HEAD");
    const unmerged = changedPaths(run, "--diff-filter=U");
    const partial = new Set([...staged].filter((file) => !unmerged.has(file) &&
      (workingChanges.has(file) || (stagedDeletes.has(file) && existingFile(file)))));
    checkPartial(sourceGit, partial);

    sourceGit(["add", "-A"]);
    const patch = sourceGit(["diff", "--cached", "--binary", "--find-renames", "--default-prefix", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD"]);
    if (!patch.length) {
      stageSource();
      console.log("nothing to merge");
      return 0;
    }
    const numstat = records(run(["apply", "--numstat", "-z"], patch));
    const removed = changedPaths(sourceGit, "--cached", "--diff-filter=D", "HEAD");
    const paths = [...new Set([...numstat.map((row) => row.replace(/^[^\t]+\t[^\t]+\t/, "")), ...removed])];
    refusePaths("already conflicted", paths.filter((file) => unmerged.has(file)));
    refusePaths("partially staged", paths.filter((file) => partial.has(file)));
    stageSource();

    const intentToAdd = changedPaths(run, "--diff-filter=A", "--ita-invisible-in-index");
    const deleted = changedPaths(run, "--diff-filter=D");
    updatePaths(run, ["add"], paths.filter((file) => existingFile(file) || deleted.has(file)));

    let conflicts = new Set();
    try {
      run(["apply", "--3way", "--whitespace=nowarn"], patch);
    } catch (error) {
      const after = changedPaths(run, "--diff-filter=U");
      conflicts = new Set(paths.filter((file) => after.has(file)));
      if (!conflicts.size) throw error;
    }

    const unstaged = paths.filter((file) => !staged.has(file) && !conflicts.has(file));
    const descendants = [...new Set([...staged, ...conflicts])].filter((file) => unstaged.some((parent) => file.startsWith(parent + "/")));
    updatePaths(run, ["reset", "-q", "HEAD"], unstaged, descendants);
    updatePaths(run, ["add", "-N"], unstaged.filter((file) => intentToAdd.has(file) && existingFile(file)));
    commit();
    for (const file of paths) console.log(`${conflicts.has(file) ? "conflicted" : "merged"} ${display(file)}`);
    return conflicts.size ? 1 : 0;
  });
}

function main(args) {
  const [worktree, option, into] = args;
  if (!worktree || (args.length !== 1 && !(args.length === 3 && option === "--into" && into))) {
    throw new Error("usage: node merge-worktree.mjs <worktree> [--into <dir>]");
  }
  const root = (dir) => line(git(dir, ["rev-parse", "--show-toplevel"]));
  const source = root(worktree);
  const target = root(into ?? process.cwd());
  if (source === target) throw new Error("Source and target are the same worktree.");
  const commonDir = (dir) => line(git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (commonDir(source) !== commonDir(target)) throw new Error("Source and target must share a Git common directory.");

  return withLockedIndex(source, (run, stageSource) => {
    const problems = [...changedPaths(run, "--cached", "--diff-filter=U")].map((file) => `source has unresolved conflict ${display(file)}`);
    const sourceHead = line(run(["rev-parse", "HEAD"]));
    const targetHead = line(git(target, ["rev-parse", "HEAD"]));
    if (sourceHead !== targetHead) {
      const count = line(run(["rev-list", "--count", `${targetHead}..${sourceHead}`]));
      if (count !== "0") {
        const branch = line(run(["branch", "--show-current"])) || `detached HEAD ${sourceHead}`;
        problems.push(`Source ${branch} has ${count} commit${count === "1" ? "" : "s"} missing from target HEAD.`);
      }
    }
    if (problems.length) throw new Error(problems.join("\n"));
    if (sourceHead !== targetHead) console.log(`target HEAD ${targetHead} differs from worktree HEAD ${sourceHead}`);
    return mergeInto(target, run, stageSource);
  });
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error.stderr?.length ? error.stderr.toString().trimEnd() : error.message);
  process.exitCode = 1;
}
