const PATTERN_ENV = "FUSION_VERIFICATION_PATTERN";
const PATTERN_MAX_LENGTH = 512;
const COMMAND_MAX_LENGTH = 16384;

const SEGMENT_SEPARATOR = /(?:&&|\|\||;|\||\n|\r)+/;

const WRAPPER_HEADS = new Set(["time", "nice", "command", "npx", "bunx", "uvx", "dotenv", "cross-env"]);
const WRAPPER_SUBCOMMANDS = new Map([
  ["npm", new Set(["exec"])],
  ["pnpm", new Set(["exec", "dlx"])],
  ["yarn", new Set(["exec", "dlx"])],
  ["bun", new Set(["x", "run"])],
  ["uv", new Set(["run"])],
  ["poetry", new Set(["run"])],
  ["pipenv", new Set(["run"])],
  ["rye", new Set(["run"])],
  ["hatch", new Set(["run"])],
  ["mise", new Set(["exec", "run"])]
]);

const NAVIGATION_HEADS = new Set(["cd", "pushd", "popd", "export", "set", "source", "."]);

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "deno"]);
const MUTATING_SUBCOMMANDS = new Set([
  "add",
  "create",
  "dedupe",
  "i",
  "init",
  "install",
  "link",
  "outdated",
  "pack",
  "publish",
  "remove",
  "rm",
  "uninstall",
  "unlink",
  "up",
  "update",
  "upgrade",
  "why"
]);

const VERIFICATION_SCRIPTS = new Set([
  "check",
  "checks",
  "coverage",
  "lint",
  "spec",
  "test",
  "tests",
  "type-check",
  "typecheck",
  "types",
  "unit",
  "verify"
]);
const VERIFICATION_SCRIPT_PREFIX = /^(?:test|tests|spec|unit|lint|check|typecheck|type-check|verify|coverage|e2e)[:._-]/;

const UNCONDITIONAL_RUNNERS = new Set([
  "ava",
  "ctest",
  "eslint",
  "jest",
  "mocha",
  "mypy",
  "nox",
  "oxlint",
  "phpstan",
  "phpunit",
  "psalm",
  "pyright",
  "pytest",
  "rspec",
  "rubocop",
  "shellcheck",
  "stylelint",
  "tap",
  "tox",
  "tsc",
  "tsd",
  "tsgo",
  "vitest"
]);

const CONDITIONAL_RUNNERS = new Map([
  ["bazel", new Set(["test"])],
  ["biome", new Set(["check", "ci", "lint"])],
  ["cargo", new Set(["check", "clippy", "nextest", "test"])],
  ["cypress", new Set(["run"])],
  ["deno", new Set(["check", "lint", "test"])],
  ["dotnet", new Set(["test"])],
  ["flutter", new Set(["analyze", "test"])],
  ["go", new Set(["test", "vet"])],
  ["gradle", new Set(["check", "test"])],
  ["gradlew", new Set(["check", "test"])],
  ["just", new Set(["check", "ci", "lint", "test", "typecheck", "verify"])],
  ["make", new Set(["check", "ci", "lint", "test", "typecheck", "verify"])],
  ["mvn", new Set(["test", "verify"])],
  ["mvnw", new Set(["test", "verify"])],
  ["playwright", new Set(["test"])],
  ["rake", new Set(["spec", "test"])],
  ["ruff", new Set(["check"])],
  ["swift", new Set(["test"])],
  ["xcodebuild", new Set(["test"])]
]);

const FLAG_GATED_RUNNERS = new Map([
  ["node", new Set(["--test"])],
  ["prettier", new Set(["--check", "-c"])]
]);

function commandHead(token) {
  const withoutPath = token.split("/").pop() ?? token;
  return withoutPath.toLowerCase();
}

function isEnvAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function tokenize(segment) {
  return segment
    .split(/\s+/)
    .filter((token) => token.length > 0 && !isEnvAssignment(token));
}

function stripWrappers(tokens) {
  let current = tokens;
  for (let depth = 0; depth < 4 && current.length > 0; depth += 1) {
    const head = commandHead(current[0]);
    if (WRAPPER_HEADS.has(head)) {
      current = current.slice(1);
      continue;
    }
    const subcommands = WRAPPER_SUBCOMMANDS.get(head);
    if (!subcommands) {
      return current;
    }
    const index = current.findIndex((token, position) => position > 0 && subcommands.has(token.toLowerCase()));
    if (index === -1) {
      return current;
    }
    if (head === "bun" && current[index].toLowerCase() === "run") {
      return current;
    }
    current = current.slice(index + 1);
  }
  return current;
}

function positionalTokens(tokens) {
  const positionals = [];
  for (const token of tokens.slice(1)) {
    if (token === "--") {
      break;
    }
    if (!token.startsWith("-")) {
      positionals.push(token.toLowerCase());
    }
  }
  return positionals;
}

function matchesPackageManager(head, tokens) {
  if (!PACKAGE_MANAGERS.has(head)) {
    return false;
  }
  const positionals = positionalTokens(tokens);
  if (positionals.some((token) => MUTATING_SUBCOMMANDS.has(token))) {
    return false;
  }
  return positionals.some(
    (token) =>
      VERIFICATION_SCRIPTS.has(token) ||
      VERIFICATION_SCRIPT_PREFIX.test(token) ||
      UNCONDITIONAL_RUNNERS.has(commandHead(token))
  );
}

function matchesRunner(head, tokens) {
  if (UNCONDITIONAL_RUNNERS.has(head)) {
    return true;
  }
  const conditional = CONDITIONAL_RUNNERS.get(head);
  if (conditional) {
    return positionalTokens(tokens).some((token) => conditional.has(token));
  }
  const flags = FLAG_GATED_RUNNERS.get(head);
  if (flags) {
    return tokens.slice(1).some((token) => flags.has(token.toLowerCase()));
  }
  return false;
}

function customPattern(env) {
  const raw = env[PATTERN_ENV];
  if (typeof raw !== "string" || !raw.trim() || raw.length > PATTERN_MAX_LENGTH) {
    return null;
  }
  try {
    return new RegExp(raw.trim());
  } catch {
    return null;
  }
}

function isVerificationSegment(segment, pattern) {
  if (pattern?.test(segment)) {
    return true;
  }
  const tokens = stripWrappers(tokenize(segment));
  if (tokens.length === 0) {
    return false;
  }
  const head = commandHead(tokens[0]);
  if (NAVIGATION_HEADS.has(head)) {
    return false;
  }
  return matchesPackageManager(head, tokens) || matchesRunner(head, tokens);
}

function isVerificationCommand(command, env = process.env) {
  if (typeof command !== "string") {
    return false;
  }
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > COMMAND_MAX_LENGTH) {
    return false;
  }
  const pattern = customPattern(env);
  return trimmed
    .split(SEGMENT_SEPARATOR)
    .some((segment) => segment.trim().length > 0 && isVerificationSegment(segment.trim(), pattern));
}

export { PATTERN_ENV, isVerificationCommand };
