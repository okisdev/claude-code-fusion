import { isInsideCwd } from "./write.mjs";
import path from "node:path";

const READ_COMMANDS = new Set([
  "cd", "cat", "grep", "rg", "head", "tail", "ls", "wc", "nl", "jq", "tree",
  "echo", "printf", "cut", "sort", "uniq", "tr", "column", "pwd", "date", "basename", "dirname", "stat", "file", "du", "diff", "comm", "test", "[", "true", "false"
]);
const GIT_READ_SUBCOMMANDS = new Set(["diff", "show", "log", "status", "grep", "blame", "rev-parse", "ls-files", "ls-tree", "cat-file", "merge-base", "describe", "shortlog"]);
const GIT_LISTING_FLAGS = /^(?:-a|-r|-v|-vv|-l|--list|--all|--remotes|--show-current|--verbose)$/;
const GH_READ_SUBCOMMANDS = new Set(["pr:view", "pr:diff", "pr:list", "pr:checks", "pr:status", "issue:view", "issue:list", "run:view", "run:list", "repo:view", "release:view", "release:list"]);
const GH_API_WRITE_FLAGS = /^(?:-X|--method|-f|-F|--field|--raw-field|--input)(?:=|$)/;
const INLINE_INTERPRETER = /(?:^|[\s;&|(])(?:python3?|node|bun|deno|ruby|perl)(?=\s)/;
const STREAM_WRITE_CALL = /\b(?:sys\.(?:stdout|stderr)|process\.(?:stdout|stderr)|\$?std(?:out|err))\.write\(/gi;
const FILE_WRITE_CALL = /\.write\(|\bwrite_(?:text|bytes)\(|\b(?:write|append)File(?:Sync)?\(|\bFile\.write\(/;
const PATH_LITERAL = /(['"])([^'"\s\\]+)\1/g;
const HEREDOC_START = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

function splitReadSegments(command) {
  if (typeof command !== "string" || !command.trim()) return null;
  const segments = [];
  let segment = "";
  let quote = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      segment += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      segment += char;
      continue;
    }
    if (quote) {
      if (quote === '"' && (char === "`" || (char === "$" && command[index + 1] === "("))) return null;
      if (char === quote) quote = null;
      segment += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      segment += char;
      continue;
    }
    if (char === ">" && /(?:^|\s)2$/.test(segment) && /^(?:\/dev\/null|&1)(?=\s|$)/.test(command.slice(index + 1))) {
      const target = /^(?:\/dev\/null|&1)/.exec(command.slice(index + 1))[0];
      segment += `>${target}`;
      index += target.length;
      continue;
    }
    if (char === ">" || char === "<" || char === "`" || (char === "$" && command[index + 1] === "(") || (char === "&" && command[index + 1] !== "&")) return null;
    if (char === ";" || char === "|" || char === "\n" || char === "\r" || (char === "&" && command[index + 1] === "&")) {
      const doubled = (char === "&" || char === "|") && command[index + 1] === char;
      if (segment.trim()) segments.push(segment.trim());
      else if (char !== "\n" && char !== "\r") return null;
      segment = "";
      if (doubled) index += 1;
      continue;
    }
    segment += char;
  }
  if (quote || escaped) return null;
  if (segment.trim()) segments.push(segment.trim());
  return segments.length > 0 ? segments : null;
}

function gitSubcommand(args) {
  let index = 0;
  while (index < args.length) {
    if (args[index] === "-C" || args[index] === "-c") index += 2;
    else if (args[index] === "--no-pager") index += 1;
    else break;
  }
  return args.slice(index);
}

function isReadOnlyGit(rawArgs) {
  const [subcommand, ...rest] = gitSubcommand(rawArgs);
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) return true;
  if (subcommand === "worktree" || subcommand === "stash") return rest[0] === "list";
  if (subcommand === "branch" || subcommand === "tag") return rest.every((arg) => GIT_LISTING_FLAGS.test(arg));
  if (subcommand === "remote") return rest.length === 0 || rest[0] === "-v" || rest[0] === "get-url";
  if (subcommand === "config") return rest[0] === "--get";
  return false;
}

function isReadOnlyGh(args) {
  if (args[0] === "search") return true;
  if (args[0] === "api") return !args.some((arg) => GH_API_WRITE_FLAGS.test(arg));
  return GH_READ_SUBCOMMANDS.has(`${args[0]}:${args[1]}`);
}

function isReadOnlyBash(command) {
  const segments = splitReadSegments(command);
  if (!segments) return false;
  return segments.every((segment) => {
    const [name, ...rawArgs] = segment.split(/\s+/);
    const args = rawArgs.map((arg) => arg.replace(/^['"]|['"]$/g, ""));
    if (name === "awk") return !args.some((arg) => /[>|]|\bsystem\b/.test(arg));
    if (READ_COMMANDS.has(name)) return true;
    if (name === "sed") return !args.some((arg) => /^-[^-]*i/.test(arg) || arg.startsWith("--in-place") || /(?:^|[;{]|\d)\s*w(?:\s|$)|\/w(?:\s|$)/.test(arg));
    if (name === "find") return !args.some((arg) => /^-(?:delete|exec(?:dir)?|ok(?:dir)?|fprint|fprintf|fls)$/.test(arg));
    if (name === "git") return isReadOnlyGit(args);
    if (name === "gh") return isReadOnlyGh(args);
    return false;
  });
}

function splitHeredocs(command) {
  const lines = command.split("\n");
  const shell = [];
  const bodies = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    shell.push(line);
    const start = HEREDOC_START.exec(line);
    if (!start) continue;
    const body = [];
    index += 1;
    while (index < lines.length && lines[index].trim() !== start[2]) {
      body.push(lines[index]);
      index += 1;
    }
    bodies.push(body.join("\n"));
  }
  return { shell: shell.join("\n"), bodies };
}

function shellWords(text) {
  const words = [];
  let word = "";
  let quote = null;
  let quoted = false;
  const flush = () => {
    if (word || quoted) words.push(word);
    word = "";
    quoted = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
      continue;
    }
    if (char === "\\" && index + 1 < text.length) {
      word += text[index + 1];
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "(" || char === ")") {
      flush();
      const doubled = (char === "&" || char === "|") && text[index + 1] === char;
      words.push(doubled ? char + char : char);
      if (doubled) index += 1;
      continue;
    }
    if (char === ">") {
      const descriptor = /^\d*$/.test(word) ? word : null;
      if (descriptor === null) flush();
      word = "";
      const appended = text[index + 1] === ">";
      if (appended) index += 1;
      words.push(text[index + 1] === "&" ? ">&" : ">");
      if (text[index + 1] === "&") index += 1;
      continue;
    }
    word += char;
  }
  flush();
  return words;
}

function workspaceTarget(target, base, cwd) {
  if (typeof target !== "string" || !target || base === null || /^[~$]|[`*]|\$\{?\w/.test(target) || target === "/dev/null") return null;
  const resolved = path.resolve(base, target);
  return isInsideCwd(resolved, cwd) ? resolved : null;
}

function effectiveBase(words, cwd) {
  if (words[0] !== "cd") return cwd;
  const target = words[1];
  if (typeof target !== "string" || /^[~$]|\$\{?\w|`/.test(target)) return null;
  return path.resolve(cwd, target);
}

function shellWriteTarget(shell, cwd) {
  const words = shellWords(shell);
  const base = effectiveBase(words, cwd);
  let segmentStart = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if ([";", "|", "||", "&", "&&", "(", ")"].includes(word)) {
      segmentStart = index + 1;
      continue;
    }
    if (word === ">") {
      const target = workspaceTarget(words[index + 1], base, cwd);
      if (target) return target;
      continue;
    }
    const name = words[segmentStart];
    if (index !== segmentStart) continue;
    const end = words.findIndex((entry, at) => at > index && [";", "|", "||", "&", "&&", ">", ">&", ")"].includes(entry));
    const args = words.slice(index + 1, end < 0 ? words.length : end);
    if (name === "tee") {
      const target = args.map((arg) => (arg.startsWith("-") ? null : workspaceTarget(arg, base, cwd))).find(Boolean);
      if (target) return target;
    }
    const inPlace =
      (name === "sed" && args.some((arg) => /^-[^-]*i/.test(arg) || arg.startsWith("--in-place"))) ||
      (name === "perl" && args.some((arg) => /^-[^-]*i/.test(arg)));
    if (inPlace) {
      const target = workspaceTarget(args.findLast((arg) => !arg.startsWith("-")), base, cwd);
      if (target) return target;
    }
  }
  return null;
}

function scriptWriteTarget(command, cwd) {
  if (!INLINE_INTERPRETER.test(command) || !FILE_WRITE_CALL.test(command.replace(STREAM_WRITE_CALL, ""))) return null;
  for (const match of command.matchAll(PATH_LITERAL)) {
    const literal = match[2];
    if (!/^[\w.@/-]+$/.test(literal) || !(literal.includes("/") || /\.\w{1,8}$/.test(literal)) || /^-|^\.\w+$/.test(literal)) continue;
    const target = workspaceTarget(literal, cwd, cwd);
    if (target) return target;
  }
  return null;
}

function bashWriteEffect(command, cwd) {
  if (typeof command !== "string" || !command.trim() || typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  const { shell, bodies } = splitHeredocs(command);
  const target = shellWriteTarget(shell, cwd) ?? scriptWriteTarget(command, cwd);
  if (!target) return null;
  return { path: target, bytes: bodies.reduce((total, body) => total + Buffer.byteLength(body), 0) };
}

export { isReadOnlyBash, bashWriteEffect };
