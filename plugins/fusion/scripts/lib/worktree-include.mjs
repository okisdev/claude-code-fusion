import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function git(root, args, options = {}) {
  return execFileSync("git", args, { cwd: root, stdio: "pipe", maxBuffer: Infinity, ...options }).toString();
}

function records(output) {
  return output.split("\0").filter(Boolean);
}

function matchingPaths(root, files) {
  const patterns = path.join(root, ".worktreeinclude");
  if (!files.length || !fs.existsSync(patterns)) return [];
  const matcher = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-worktree-include-"));
  try {
    git(matcher, ["init", "-q", "--template="]);
    try {
      return records(git(matcher, ["-c", `core.excludesFile=${patterns}`, "check-ignore", "--no-index", "--stdin", "-z"], { input: files.join("\0") + "\0" }));
    } catch (error) {
      if (error.status !== 1) throw error;
      return [];
    }
  } finally {
    fs.rmSync(matcher, { recursive: true, force: true });
  }
}

export function ignoredIncludes(root) {
  const patterns = path.join(root, ".worktreeinclude");
  if (!fs.existsSync(patterns)) return [];
  const candidates = records(git(root, ["ls-files", "--others", "--ignored", `--exclude-from=${patterns}`, "-z"]));
  const directories = matchingPaths(root, records(git(root, ["ls-files", "--others", "--ignored", `--exclude-from=${patterns}`, "--directory", "-z"])).filter((file) => file.endsWith("/")));
  const paths = [...new Set([...candidates, ...directories.map((file) => file.replace(/\/$/, ""))])]
    .filter((file) => file !== ".claude" && file !== ".claude/worktrees" && !file.startsWith(".claude/worktrees/"));
  if (!paths.length) return [];
  let ignored;
  try {
    ignored = new Set(records(git(root, ["check-ignore", "--stdin", "-z"], { input: paths.join("\0") + "\0" })));
  } catch (error) {
    if (error.status !== 1) throw error;
    return [];
  }
  return [...ignored].filter((file) => {
    for (let parent = path.posix.dirname(file); parent !== "."; parent = path.posix.dirname(parent)) {
      if (ignored.has(parent)) return false;
    }
    return true;
  }).sort();
}

export function includeSymlinks(source) {
  const main = records(git(source, ["worktree", "list", "--porcelain", "-z"]))[0].slice("worktree ".length);
  if (!fs.existsSync(path.join(main, ".worktreeinclude"))) return [];
  const candidates = records(git(source, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]));
  const links = [...new Set(candidates)].filter((file) => {
    const location = path.join(source, file);
    if (!fs.lstatSync(location, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
    const target = path.resolve(path.dirname(location), fs.readlinkSync(location));
    if (target === main || target.startsWith(main + path.sep)) return true;
    if (!fs.existsSync(target)) return false;
    const resolved = fs.realpathSync(target);
    return resolved === main || resolved.startsWith(main + path.sep);
  });
  return matchingPaths(main, links.map((file) => {
    const stat = fs.statSync(path.join(source, file), { throwIfNoEntry: false });
    return file + (!stat || stat.isDirectory() ? "/" : "");
  })).map((file) => file.replace(/\/$/, ""));
}
