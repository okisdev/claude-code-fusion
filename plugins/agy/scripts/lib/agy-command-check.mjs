const PROGRAMS = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "stat", "grep", "rg", "find", "git"]);

function flagPolicy(bare, required = "", optional = "") {
  return new Map([bare, required, optional].flatMap((flags, arity) => flags.split(/\s+/).filter(Boolean).map((flag) => [flag, arity])));
}

const RG_FLAGS = flagPolicy(
  "--hidden --no-ignore --files --files-with-matches --count --line-number --no-line-number --ignore-case --smart-case --case-sensitive --fixed-strings --word-regexp --invert-match --multiline --json --follow --with-filename --no-heading --heading --null --only-matching -n -i -S -s -F -w -v -l -c -U -L -H -N -o -u -x",
  "--max-count --glob --iglob --type --type-not --context --before-context --after-context --max-depth --sort --regexp -e -g -t -T -A -B -C -m -M"
);
const GIT_FLAGS = {
  status: flagPolicy("-s --short -b --branch", "", "--porcelain -u --untracked-files --ignored"),
  log: flagPolicy("--oneline -p --patch --shortstat --name-only --name-status --graph --follow --all --reverse --first-parent --no-merges --abbrev-commit", "-n --max-count --format --author --since --until --after --before --grep -S -G --date", "--stat --decorate --pretty"),
  show: flagPolicy("--shortstat --name-only --name-status -p --patch --no-patch -s --abbrev-commit", "--format --date", "--stat --pretty"),
  diff: flagPolicy("--shortstat --name-only --name-status --cached --staged --no-color --numstat --summary", "", "--stat -U --unified --word-diff"),
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

function words(command) {
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
    } else if (character === "\\") {
      const escaped = command[index + 1];
      if (escaped === undefined || unsafeCharacter(escaped)) return null;
      word += escaped;
      first ||= escaped;
      index += 1;
      started = true;
    } else if ("$;|&><`{}()".includes(character)) return null;
    else if ("*?[]".includes(character)) {
      if (!first || "-*?[]".includes(first)) return null;
      word += character;
    } else {
      if (!started && "~#!=".includes(character)) return null;
      word += character;
      first ||= character;
      started = true;
    }
  }
  if (quote) return null;
  if (started) result.push(word);
  return result;
}

function allowedFlags(args, policy, { attachedValues = false, numeric = false } = {}) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") return true;
    if (!argument.startsWith("-") || argument === "-") continue;
    if (numeric && /^-\d+$/.test(argument)) continue;
    const equals = argument.indexOf("=");
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    if (policy.has(flag)) {
      const arity = policy.get(flag);
      if (equals >= 0) {
        if (!arity || equals === argument.length - 1) return false;
      } else if (arity === 1 && (++index >= args.length || !attachedValues && args[index].startsWith("-"))) return false;
      continue;
    }
    if (argument.startsWith("--")) return false;
    for (let offset = 1; offset < argument.length; offset += 1) {
      const arity = policy.get(`-${argument[offset]}`);
      if (arity === undefined) return false;
      if (!arity) continue;
      const value = argument.slice(offset + 1);
      if (value) {
        if (!attachedValues && !value.startsWith("=")) return false;
        if (value === "=") return false;
      } else if (arity === 1 && (++index >= args.length || !attachedValues && args[index].startsWith("-"))) return false;
      break;
    }
  }
  return true;
}

function allowedFind(args) {
  let index = 0;
  while (["-L", "-H", "-P"].includes(args[index])) index += 1;
  while (index < args.length && !args[index].startsWith("-") && !["(", ")", "!"].includes(args[index])) index += 1;
  for (; index < args.length; index += 1) {
    const arity = FIND_FLAGS.get(args[index]);
    if (arity === undefined || arity && ++index >= args.length) return false;
  }
  return true;
}

export function isReadOnlyCommand(command) {
  if (typeof command !== "string") return false;
  const tokens = words(command);
  if (!tokens?.length || /[/=]/.test(tokens[0]) || !PROGRAMS.has(tokens[0])) return false;
  const [program, ...args] = tokens;
  if (program === "tail") {
    const end = args.indexOf("--");
    return !args.slice(0, end < 0 ? args.length : end).some((argument) => /^--f|^-[^-]*[fF]/.test(argument));
  }
  if (program === "find") return allowedFind(args);
  if (program === "rg") return allowedFlags(args, RG_FLAGS, { attachedValues: true });
  if (program !== "git") return true;
  const [subcommand, ...flags] = args;
  if (!Object.hasOwn(GIT_FLAGS, subcommand)) return false;
  if (subcommand === "branch") {
    const end = flags.indexOf("--");
    if (!flags.slice(0, end < 0 ? flags.length : end).includes("--list") && flags.some((flag) => !flag.startsWith("-") || flag === "--" || flag === "-")) return false;
  }
  return allowedFlags(flags, GIT_FLAGS[subcommand], { numeric: subcommand === "log" });
}
