import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAncestorOfSensitiveHomeDirectory, isReadablePath } from "./sensitive-paths.mjs";

const PROGRAMS = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "stat", "grep", "rg", "find", "git"]);
const GIT_PATHSPEC_COMMANDS = new Set(["ls-files", "grep", "log", "diff", "show"]);

function flagPolicy(bare, required = "", optional = "") {
  return new Map([bare, required, optional].flatMap((flags, arity) => flags.split(/\s+/).filter(Boolean).map((flag) => [flag, arity])));
}

const RG_FLAGS = flagPolicy(
  "--hidden --no-ignore --files --files-with-matches --count --line-number --no-line-number --ignore-case --smart-case --case-sensitive --fixed-strings --word-regexp --invert-match --multiline --json --follow --with-filename --no-heading --heading --null --only-matching --text -n -i -S -s -F -w -v -l -c -U -L -H -N -o -u -x -a",
  "--max-count --glob --iglob --type --type-not --context --before-context --after-context --max-depth --sort --regexp -e -g -t -T -A -B -C -m -M"
);
const GIT_FLAGS = {
  status: flagPolicy("-s --short -b --branch", "", "--porcelain -u --untracked-files --ignored"),
  log: flagPolicy("--oneline -p --patch --shortstat --name-only --name-status --graph --follow --all --reverse --first-parent --no-merges --abbrev-commit", "-n --max-count --format --author --since --until --after --before --grep -S -G --date", "--stat --decorate --pretty"),
  show: flagPolicy("--shortstat --name-only --name-status -p --patch --no-patch -s --abbrev-commit", "--format --date", "--stat --pretty"),
  diff: flagPolicy("--shortstat --name-only --name-status --cached --staged --no-color --numstat --summary", "-U", "--stat --unified --word-diff -M"),
  "ls-files": flagPolicy("-c --cached -m --modified -o --others -i --ignored --exclude-standard -s --stage -z"),
  grep: flagPolicy("-n --line-number -i --ignore-case -w --word-regexp -l --files-with-matches -c --count -E -F -P --cached --untracked -I", "-e --max-depth"),
  blame: flagPolicy("-w --porcelain -s -e", "-L", "-M -C"),
  "rev-parse": flagPolicy("--show-toplevel --verify --git-dir --is-inside-work-tree", "", "--abbrev-ref --short"),
  branch: flagPolicy("--list -a --all -r --remotes -v -vv --show-current")
};
const FIND_FLAGS = flagPolicy(
  "-empty -print -print0 -prune -not -a -o -and -or -ls ( ) !",
  "-name -iname -path -ipath -wholename -regex -iregex -type -maxdepth -mindepth -size -mtime -mmin -newer"
);

function unsafeCharacter(character) {
  return character !== " " && character !== "\t" && /[\s\x00-\x1f\x7f-\x9f\u200b-\u200d\u2060\ufeff]/u.test(character);
}

function words(command, globs, homePaths) {
  const result = [];
  let word = "";
  let first = "";
  let quote = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (unsafeCharacter(character)) return null;
    if (quote === "'") {
      if (character === "'") quote = null;
      else {
        word += character;
        first ||= character;
      }
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if ("$`".includes(character)) return null;
      else if (character === "\\" && index + 1 < command.length && '$`"\\'.includes(command[index + 1])) {
        word += command[index + 1];
        first ||= command[index + 1];
        index += 1;
      } else {
        word += character;
        first ||= character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === " " || character === "\t") {
      if (started) result.push(word);
      word = "";
      first = "";
      started = false;
    } else if (!started && character === "2" && /^2>\/dev\/null[ \t]*$/.test(command.slice(index))) {
      return result;
    } else if (character === "\\") {
      const escaped = command[index + 1];
      if (escaped === undefined || unsafeCharacter(escaped)) return null;
      word += escaped;
      first ||= escaped;
      index += 1;
      started = true;
    } else if ("$;|&><`{}()".includes(character)) return null;
    else if ("*?[]".includes(character)) {
      if (first === "-") return null;
      globs[result.length] ??= !first || "*?[]".includes(first) ? "leading" : word.length;
      word += character;
      first ||= character;
      started = true;
    } else {
      if (!started && character === "~") {
        if (result[0] !== "find" || command[index + 1] !== "/") return null;
        homePaths.push(result.length);
      } else if (!started && "#!=".includes(character)) return null;
      word += character;
      first ||= character;
      started = true;
    }
  }
  if (quote) return null;
  if (started) result.push(word);
  return result;
}

function allowedFlags(args, policy, { attachedValues = false, numeric = false, globs = [], needsPattern = false } = {}) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") return !needsPattern || globs[index + 1] !== "leading";
    if (!argument.startsWith("-") || argument === "-") {
      if (needsPattern && globs[index] === "leading") return false;
      needsPattern = false;
      continue;
    }
    if (numeric && /^-\d+$/.test(argument)) continue;
    const equals = argument.indexOf("=");
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    if (policy.has(flag)) {
      if (flag === "-e") needsPattern = false;
      const arity = policy.get(flag);
      if (equals >= 0) {
        if (!arity || equals === argument.length - 1) return false;
      } else if (arity === 1 && (++index >= args.length || globs[index] === "leading" || !attachedValues && args[index].startsWith("-"))) return false;
      continue;
    }
    if (argument.startsWith("--")) return false;
    for (let offset = 1; offset < argument.length; offset += 1) {
      const shortFlag = `-${argument[offset]}`;
      const arity = policy.get(shortFlag);
      if (arity === undefined) return false;
      if (shortFlag === "-e") needsPattern = false;
      if (!arity) continue;
      const value = argument.slice(offset + 1);
      if (value) {
        if (!attachedValues && !value.startsWith("=") && !/^\d+$/.test(value)) return false;
        if (value === "=") return false;
      } else if (arity === 1 && (++index >= args.length || globs[index] === "leading" || !attachedValues && args[index].startsWith("-"))) return false;
      break;
    }
  }
  return true;
}

function readableFindPath(word, cwd, realHome, fromHome = false, globOffset) {
  if (!word) return false;
  const prefixEnd = globOffset === undefined ? word.length : word.lastIndexOf("/", globOffset) + 1;
  const prefix = word.slice(0, prefixEnd);
  let requested = prefix || ".";
  if (fromHome) requested = `${realHome}${prefix.slice(1)}`;
  else if (!path.isAbsolute(requested)) requested = `${cwd}${path.sep}${requested}`;
  if (!isReadablePath(requested, realHome) || isAncestorOfSensitiveHomeDirectory(requested, realHome)) return false;
  try {
    if (fromHome) {
      const home = fs.realpathSync.native(realHome);
      const resolved = fs.realpathSync.native(requested);
      const relative = path.relative(home, resolved);
      if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    }
    if (globOffset === undefined) return true;
    const suffix = word.slice(prefixEnd);
    const literal = `${requested}${path.sep}${suffix}`;
    if (fs.existsSync(literal) && !readableFindPath(word, cwd, realHome, fromHome)) return false;
    let matches = ["."];
    for (const segment of suffix.split(path.sep).filter(Boolean)) {
      const dots = segment.startsWith(".") ? [".", ".."].filter((entry) => path.matchesGlob(`x${entry}`, `x${segment}`)) : [];
      matches = matches.flatMap((match) => {
        const entries = fs.globSync(segment, { cwd: `${requested}${path.sep}${match}` });
        return [...new Set([...dots, ...entries])].map((entry) => `${match}${path.sep}${entry}`);
      });
      if (!matches.every((match) => readableFindPath(`${prefix}${match}`, cwd, realHome, fromHome))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function allowedFind(tokens, globs, homePaths, cwd, realHome) {
  const directory = path.isAbsolute(cwd) ? cwd : `${process.cwd()}${path.sep}${cwd}`;
  let index = 1;
  while (["-H", "-P"].includes(tokens[index])) index += 1;
  const firstPath = index;
  while (index < tokens.length && !tokens[index].startsWith("-") && !["(", ")", "!"].includes(tokens[index])) {
    if (!readableFindPath(tokens[index], directory, realHome, homePaths.includes(index), globs[index])) return false;
    index += 1;
  }
  if (index === firstPath && !readableFindPath(".", directory, realHome)) return false;
  if (homePaths.some((position) => position >= index)) return false;
  for (; index < tokens.length; index += 1) {
    const arity = FIND_FLAGS.get(tokens[index]);
    if (arity === undefined || arity && ++index >= tokens.length) return false;
  }
  return true;
}

function resolveGitMetadataPath(file, directory, prefix = "") {
  if (!fs.statSync(file).isFile()) return null;
  const line = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file)).replace(/[\r\n]+$/, "");
  if (!line.startsWith(prefix)) return null;
  const target = line.slice(prefix.length);
  if (!target || target.includes("\0")) return null;
  return fs.realpathSync.native(path.isAbsolute(target) ? target : `${directory}${path.sep}${target}`);
}

function gitCommonDir(gitDir) {
  const head = fs.lstatSync(path.join(gitDir, "HEAD"), { throwIfNoEntry: false });
  if (!head?.isFile() && !head?.isSymbolicLink()) return null;
  const marker = path.join(gitDir, "commondir");
  const commonDir = fs.lstatSync(marker, { throwIfNoEntry: false }) ? resolveGitMetadataPath(marker, gitDir) : gitDir;
  if (!commonDir || (commonDir !== gitDir && path.dirname(gitDir) !== path.join(commonDir, "worktrees"))) return null;
  if (!["objects", "refs"].every((entry) => fs.statSync(path.join(commonDir, entry), { throwIfNoEntry: false })?.isDirectory())) return null;
  return commonDir;
}

function discoverGitCommonDir(start) {
  let directory = fs.realpathSync.native(start);
  while (true) {
    const marker = path.join(directory, ".git");
    if (fs.lstatSync(marker, { throwIfNoEntry: false })) {
      const gitDir = fs.statSync(marker).isDirectory()
        ? fs.realpathSync.native(marker)
        : resolveGitMetadataPath(marker, directory, "gitdir: ");
      return gitDir && gitCommonDir(gitDir);
    }
    const exists = (entry) => fs.lstatSync(path.join(directory, entry), { throwIfNoEntry: false });
    if (exists("HEAD") && (exists("commondir") || (exists("objects") && exists("refs")))) return gitCommonDir(directory);
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export function isReadOnlyCommand(command, { cwd = process.cwd(), realHome = os.homedir() } = {}) {
  if (typeof command !== "string") return false;
  const globs = [];
  const homePaths = [];
  const tokens = words(command, globs, homePaths);
  if (!tokens?.length || /[/=]/.test(tokens[0]) || !PROGRAMS.has(tokens[0])) return false;
  const [program, ...args] = tokens;
  if (program !== "git" && globs.includes("leading")) return false;
  if (program === "tail") {
    const end = args.indexOf("--");
    return !args.slice(0, end < 0 ? args.length : end).some((argument) => /^--f|^-[^-]*[fF]/.test(argument));
  }
  if (program === "find") return allowedFind(tokens, globs, homePaths, cwd, realHome);
  if (program === "rg") return allowedFlags(args, RG_FLAGS, { attachedValues: true });
  if (program !== "git") return true;
  let directory = cwd;
  let commonDir;
  let index = 1;
  while (tokens[index] === "-C") {
    const target = tokens[index + 1];
    if (!target || globs[index + 1]) return false;
    const requested = path.isAbsolute(target) ? target : `${directory}${path.sep}${target}`;
    try {
      if (!isReadablePath(requested, realHome)) return false;
      directory = fs.realpathSync.native(requested);
      if (!fs.statSync(directory).isDirectory()) return false;
      commonDir ??= discoverGitCommonDir(cwd);
      if (!commonDir || discoverGitCommonDir(directory) !== commonDir) return false;
    } catch {
      return false;
    }
    index += 2;
  }
  const subcommand = tokens[index];
  if (!Object.hasOwn(GIT_FLAGS, subcommand)) return false;
  const flags = tokens.slice(index + 1);
  const flagGlobs = globs.slice(index + 1);
  if (flagGlobs.includes("leading")) {
    if (!GIT_PATHSPEC_COMMANDS.has(subcommand)) return false;
    const separator = flags.indexOf("--");
    if (flagGlobs.slice(0, separator < 0 ? flags.length : separator).includes("leading")) {
      try {
        // The shell expands globs in its original directory before Git sees any arguments.
        if (fs.readdirSync(cwd).some((entry) => entry.startsWith("-"))) return false;
      } catch {
        return false;
      }
    }
  }
  if (subcommand === "branch") {
    const end = flags.indexOf("--");
    if (!flags.slice(0, end < 0 ? flags.length : end).includes("--list") && flags.some((flag) => !flag.startsWith("-") || flag === "--" || flag === "-")) return false;
  }
  return allowedFlags(flags, GIT_FLAGS[subcommand], { numeric: subcommand === "log", globs: flagGlobs, needsPattern: subcommand === "grep" });
}
