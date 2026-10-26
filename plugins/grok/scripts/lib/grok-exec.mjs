import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  getProcessIdentity,
  processGroupAlive as liveProcessGroup,
  processIdentitiesMatch,
  processIdentityMatches,
  processIsDirectlyAlive,
  validProcessIdentity
} from "./process-identity.mjs";
import { appendJobLog, resolveDataDir, writePrivateDataFile } from "./state.mjs";

const BIN_ENV = "GROK_BIN";
const TIMEOUT_ENV = "GROK_COMPANION_TIMEOUT_MS";
const PIDLESS_RUNNING_GRACE_ENV = "GROK_COMPANION_PIDLESS_RUNNING_GRACE_MS";
const CONSULT_ALLOW_ENV = "GROK_CONSULT_ALLOW";
const CAPABILITIES_ENV = "GROK_COMPANION_CAPABILITIES";
const RUNTIME_SOCKET_CANDIDATES_ENV = "GROK_COMPANION_RUNTIME_SOCKET_CANDIDATES";
const UNDENIED_RUNTIME_SOCKET_CANDIDATES_ENV = "GROK_COMPANION_UNDENIED_SOCKET_CANDIDATES";
const DEFAULT_FOREGROUND_TIMEOUT_MS = 570000;
const BACKGROUND_TIMEOUT_CAP_MS = 1800000;
const DEFAULT_PIDLESS_RUNNING_GRACE_MS = 15000;
const TERMINATION_GRACE_MS = 2000;
const TERMINATION_POLL_MS = 50;
const MANAGED_CLEANUP_RESERVE_MS = 200;
const STDOUT_CAPTURE_MAX_BYTES = 32 * 1024 * 1024;
const STDOUT_TAIL_MAX_BYTES = 8192;
const STDERR_CAPTURE_MAX_BYTES = 64 * 1024;
const SESSION_SUMMARY_MAX_BYTES = 64 * 1024;
const SESSION_CWD_MAX_BYTES = 16 * 1024;
const SESSION_SCAN_MAX_ENTRIES = 4096;
const SANDBOX_EVENT_DELTA_MAX_BYTES = 512 * 1024;
const SANDBOX_EVENT_MARKER_MAX_BYTES = 4096;
const SANDBOX_HANDSHAKE_TIMEOUT_MS = 15000;
const SANDBOX_HANDSHAKE_TIMEOUT_ENV = "GROK_COMPANION_SANDBOX_HANDSHAKE_MS";
const SANDBOX_HANDSHAKE_POLL_MS = 20;
const DEFAULT_MAX_TURNS = { consult: 60, write: 60 };
const MAX_TURNS_REACHED_PATTERN = /\bmax turns reached\b/i;
const SANDBOX_FAILURE_PATTERN = /(?:sandbox (?:could not be applied|initialization failed|not supported on this platform)|sandbox enforcement unavailable \(built without ['"]?enforce['"]? feature\)|failed to parse sandbox config)/i;
const TOOL_POLICY_FAILURE_PATTERN = /(?:tools allowlist had unmappable entries; keeping full grok toolset|disallowedTools entry matched nothing)/i;
const TOOL_POLICY_APPLIED_PATTERN = /tools? allowlist applied/i;
const AUTH_RETRY_FAILURE_PATTERN = /auth 401 retry: no credential was sent/i;
const AUTH_RETRY_FAILURE_MESSAGE = "Grok sent its model request without a credential and entered its re-authentication retry loop, so the companion stopped it instead of waiting out the retries. Under the strict sandbox this usually means the stored OIDC token expired: grok 1.0.14 and later can write only `~/.grok/sessions` inside the Grok home under strict, so a managed run cannot refresh the token. Run grok once outside the sandbox, for example `grok -p ok`, to refresh it, then rerun.";
const AUTH_REFRESH_FAILURE_MESSAGE = "The companion ran `grok models` outside the sandbox to refresh the stored token and it did not refresh, so the refresh token itself may have expired: run `grok login` once, then rerun.";
const AUTH_STALE_MS = 5 * 60 * 60 * 1000;
const AUTH_REFRESH_RETRY_MS = 30 * 60 * 1000;
const AUTH_REFRESH_ATTEMPT_FILE = "auth-refresh-attempt.json";
const GROK_BUILDER_LOG_FILTER = "xai_grok_agent::builder=debug,xai_grok_sandbox=warn,xai_grok_shell::session::acp_session::turn=warn";
const USD_TICKS = 10_000_000_000;
const STDIN_PROMPT_FILE = "/dev/stdin";
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITY_PATTERN = /--[a-z0-9][a-z0-9-]*/gi;
const CAPABILITY_CACHE_FILE = "capabilities.json";
const REQUIRED_CAPABILITY_PROBES = [
  ["--prompt-file", "--prompt-file=/dev/null"],
  ["--output-format", "--output-format=json"],
  ["--sandbox", "--sandbox=strict"],
  ["--tools", "--tools=read_file"],
  ["--disallowed-tools", "--disallowed-tools=Agent"],
  ["--deny", "--deny=x"],
  ["--max-turns", "--max-turns=1"],
  ["--no-auto-update", "--no-auto-update"],
  ["--permission-mode", "--permission-mode=default"],
  ["--allow", "--allow=x"],
  ["--always-approve", "--always-approve"],
  ["--disable-web-search", "--disable-web-search"],
  ["--json-schema", "--json-schema={}"],
  ["--no-wait-for-background", "--no-wait-for-background"]
];

const capabilityCache = new Map();
const directCapabilityIdentity = new Map();

function deadlineRemaining(deadline) {
  return deadline == null ? Infinity : Math.max(0, deadline - Date.now());
}

function runTimeoutError() {
  const error = new Error("The managed Grok run exceeded its deadline.");
  error.failureKind = "timeout";
  return error;
}

function requireDeadline(deadline) {
  if (deadlineRemaining(deadline) <= 0) throw runTimeoutError();
}

function probeTimeout(deadline, capMs) {
  requireDeadline(deadline);
  return Math.max(1, Math.min(capMs, deadlineRemaining(deadline)));
}

function cleanupGraceMs(deadline) {
  return Math.min(TERMINATION_GRACE_MS, Math.floor(deadlineRemaining(deadline) / 2));
}

function resolvedBinaryIdentity(bin, env, cwd) {
  const candidates = path.isAbsolute(bin) || bin.includes(path.sep)
    ? [path.resolve(cwd, bin)]
    : String(env.PATH ?? process.env.PATH ?? "").split(path.delimiter).map((dir) => path.resolve(cwd, dir || ".", bin));
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      const stats = fs.statSync(resolved);
      if (stats.isFile() && (stats.mode & 0o111) !== 0) {
        return { path: resolved, mtimeMs: stats.mtimeMs, size: stats.size };
      }
    } catch {}
  }
  const error = capabilityError(`Unable to locate the Grok CLI binary: ${bin}`);
  error.failureKind = "missing_cli";
  throw error;
}

export function normalizeGrokSessionId(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return SESSION_ID_PATTERN.test(normalized) ? normalized.toLowerCase() : null;
}

export function normalizeStopReason(value) {
  return typeof value === "string" ? value.replaceAll("_", "").toLowerCase() : "";
}

const CONSULT_TOOL_IDS = ["read_file", "grep", "list_dir"];
const CONSULT_WEB_TOOL_IDS = ["web_search", "web_fetch"];
const WRITE_TOOL_IDS = ["read_file", "grep", "list_dir", "search_replace", "run_terminal_cmd"];
const CONSULT_ALLOW_RULES = ["Read", "Grep"];

const CONSULT_WEB_ALLOW_RULES = ["WebSearch", "WebFetch"];

export const NESTED_ENGINE_CLI_DENY_NAMES = ["grok", "claude", "codex"];

const NESTED_ENGINE_CLI_DENY_RULES = NESTED_ENGINE_CLI_DENY_NAMES.map((name) => `Bash(${name}*)`);

const DISALLOWED_META_TOOL_IDS = ["search_tool", "use_tool", "ask_user_question"];

const CONSULT_DENY_RULES = ["Edit", "Write", "Bash", "MCPTool(*)"];

const WRITE_DENY_RULES = [
  "Bash(sudo*)",
  "Bash(rm -rf*)",
  "Bash(git push*)",
  "Bash(gh*)",
  "MCPTool(*)",
  ...NESTED_ENGINE_CLI_DENY_RULES
];

function permissionRuleContent(value) {
  if (/[\r\n*?\[\],]/.test(value)) {
    throw capabilityError("The Grok home path contains permission glob metacharacters and cannot be denied safely.");
  }
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function privateGrokReadDenyRules(env, cwd) {
  const grokHome = permissionRuleContent(resolveChildGrokHome(env, cwd));
  return [
    `Read(${grokHome}/auth.json)`,
    `Read(${grokHome}/mcp_credentials.json)`,
    `Read(${grokHome}/config.toml)`,
    `Read(${grokHome}/sessions/**)`,
    `Read(${grokHome}/memory/**)`,
    `Read(${grokHome}/logs/**)`,
    `Read(${grokHome}/debug/**)`,
    "Read(**/.grok/auth.json)",
    "Read(**/.grok/mcp_credentials.json)",
    "Read(**/.grok/config.toml)",
    "Read(**/.grok/sessions/**)",
    "Read(**/.grok/memory/**)",
    "Read(**/.grok/logs/**)",
    "Read(**/.grok/debug/**)"
  ];
}

const COMPATIBILITY_ENV_KEYS = [
  "GROK_CLAUDE_SKILLS_ENABLED",
  "GROK_CLAUDE_RULES_ENABLED",
  "GROK_CLAUDE_AGENTS_ENABLED",
  "GROK_CLAUDE_MCPS_ENABLED",
  "GROK_CLAUDE_HOOKS_ENABLED",
  "GROK_CLAUDE_SESSIONS_ENABLED",
  "GROK_CURSOR_SKILLS_ENABLED",
  "GROK_CURSOR_RULES_ENABLED",
  "GROK_CURSOR_AGENTS_ENABLED",
  "GROK_CURSOR_MCPS_ENABLED",
  "GROK_CURSOR_HOOKS_ENABLED",
  "GROK_CURSOR_SESSIONS_ENABLED",
  "GROK_CODEX_SKILLS_ENABLED",
  "GROK_CODEX_RULES_ENABLED",
  "GROK_CODEX_AGENTS_ENABLED",
  "GROK_CODEX_MCPS_ENABLED",
  "GROK_CODEX_HOOKS_ENABLED",
  "GROK_CODEX_SESSIONS_ENABLED"
];

const GROK_AUTH_ENV_KEYS = new Set([
  "XAI_API_KEY",
  "GROK_CODE_XAI_API_KEY",
  "GROK_AUTH",
  "GROK_AUTH_PATH",
  "GROK_AUTH_PROVIDER_COMMAND",
  "GROK_AUTH_PROVIDER_LABEL",
  "GROK_AUTH_TOKEN_TTL",
  "GROK_AUTH_EARLY_INVALIDATION_SECS",
  "GROK_DISABLE_API_KEY_AUTH",
  "GROK_LOCAL_AUTH"
]);
const SENSITIVE_ENV_KEY_PATTERN = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|AUTH|COOKIE)(?:_|$)/i;
const SENSITIVE_CONNECTION_KEY_PATTERN = /(?:^|_)(?:DATABASE_URL|DB_URL|POSTGRES(?:QL)?_URL|MYSQL_URL|MARIADB_URL|MONGO(?:DB)?(?:_URI|_URL)|REDIS_URL|VALKEY_URL|AMQP_URL|RABBITMQ_URL|KAFKA_URL|ELASTICSEARCH_URL|OPENSEARCH_URL|CLICKHOUSE_URL|SNOWFLAKE_URL|SENTRY_DSN|DSN|CONNECTION_STRING)(?:_|$)/i;
const SENSITIVE_ENV_KEYS = new Set(["DOCKER_AUTH_CONFIG", "GPG_AGENT_INFO", "KUBECONFIG", "SSH_AUTH_SOCK"]);

export function resolveGrokBin(env = process.env) {
  const override = env[BIN_ENV];
  return override && override.trim() ? override.trim() : "grok";
}

export function resolveTimeoutMs({ background = false, env = process.env } = {}) {
  const raw = Number(env[TIMEOUT_ENV]);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  if (background) {
    return Math.min(configured ?? BACKGROUND_TIMEOUT_CAP_MS, BACKGROUND_TIMEOUT_CAP_MS);
  }
  return configured ?? DEFAULT_FOREGROUND_TIMEOUT_MS;
}

function resolvePidlessRunningGraceMs(env = process.env) {
  const raw = Number(env[PIDLESS_RUNNING_GRACE_ENV]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_PIDLESS_RUNNING_GRACE_MS;
}

export function sandboxProfileForMode(mode) {
  return "strict";
}

function resolveConsultAllowRules(env = process.env) {
  const raw = env[CONSULT_ALLOW_ENV];
  if (raw == null || !String(raw).trim()) {
    return [];
  }
  return String(raw)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^(?:Read|Grep|WebSearch|WebFetch)(?:\([^(),\r\n]*\))?$/.test(entry));
}

function buildGrokChildEnv(env = process.env, { memory = false, web = false } = {}) {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (
      key.startsWith("CLAUDE_CODE_") ||
      key.startsWith("CLAUDE_PLUGIN_") ||
      key.startsWith("GROK_COMPANION_") ||
      (!GROK_AUTH_ENV_KEYS.has(key) && (SENSITIVE_ENV_KEYS.has(key) || SENSITIVE_ENV_KEY_PATTERN.test(key) || SENSITIVE_CONNECTION_KEY_PATTERN.test(key)))
    ) {
      delete childEnv[key];
    }
  }
  delete childEnv.GROK_CLAUDE_MARKER_OVERRIDE;
  delete childEnv._GROK_CLAUDE_MARKER_OVERRIDE;
  delete childEnv.GROK_TEST_VERSION;
  delete childEnv.GROK_SANDBOX;
  delete childEnv.GROK_LEADER_SOCKET;
  delete childEnv.GROK_FILE_ACCELERATION_ROUTES;
  delete childEnv.GROK_SANDBOX_MODE;
  delete childEnv.GROK_ARTIFACTS_BIND_REMOUNT;
  delete childEnv.GROK_CURSOR_WORKER_API_BASE;
  delete childEnv.GROK_CURSOR_WORKER_COMMAND;
  childEnv.GROK_AUTO_WAKE = "false";
  childEnv.GROK_TURN_SUMMARY = "false";
  childEnv.GROK_FILE_ACCELERATION = "false";
  delete childEnv.GROK_SUBAGENTS_MAX_DEPTH;
  delete childEnv.GROK_WEB_FETCH_PROXY;
  delete childEnv.GROK_WEB_FETCH_ALLOW_LOCAL;
  childEnv.RUST_LOG = GROK_BUILDER_LOG_FILTER;
  childEnv.GROK_DISABLE_AUTOUPDATER = "1";
  childEnv.GROK_MANAGED_MCPS_ENABLED = "false";
  childEnv.GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED = "false";
  childEnv.GROK_WEB_FETCH = web ? "1" : "0";
  childEnv.GROK_MEMORY = memory ? "1" : "0";
  childEnv.GROK_SUBAGENTS = "0";
  for (const key of COMPATIBILITY_ENV_KEYS) {
    childEnv[key] = "false";
  }
  return childEnv;
}

function capabilityError(message) {
  const error = new Error(message);
  error.failureKind = "setup";
  return error;
}

function parseCapabilityList(value) {
  return new Set(
    String(value)
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => /^--[a-z0-9][a-z0-9-]*$/i.test(entry))
  );
}

export function resolveGrokCapabilities(bin, env = process.env, deadline = null, cwd = process.cwd(), required = []) {
  if (Object.hasOwn(env, CAPABILITIES_ENV)) {
    return parseCapabilityList(env[CAPABILITIES_ENV]);
  }
  const probeEnv = buildGrokChildEnv(env);
  if (deadline == null && capabilityCache.has(bin)) {
    return capabilityCache.get(bin);
  }
  // A preceding direct probe can fail a run closed without launching another probe.
  // Successful managed runs still validate the version and disk cache key below.
  if (deadline != null && required.length > 0) {
    const direct = capabilityCache.get(bin);
    if (direct instanceof Set && required.some((flag) => !direct.has(flag)) &&
        isDeepStrictEqual(directCapabilityIdentity.get(bin), resolvedBinaryIdentity(bin, env, cwd))) {
      return direct;
    }
  }
  let key = null;
  let dataDir = null;
  let cacheFile = null;
  if (deadline != null) {
    const identity = resolvedBinaryIdentity(bin, env, cwd);
    const versionProbe = spawnSync(bin, ["--version"], {
      encoding: "utf8", cwd, env: probeEnv, timeout: probeTimeout(deadline, 5000), maxBuffer: 2 * 1024 * 1024
    });
    requireDeadline(deadline);
    if (versionProbe.error || versionProbe.status !== 0) {
      throw capabilityError(`Unable to inspect Grok CLI version: ${versionProbe.error?.message ?? String(versionProbe.stderr || versionProbe.stdout || "command failed").trim()}`);
    }
    key = { ...identity, version: String(versionProbe.stdout || versionProbe.stderr || "").trim() };
    dataDir = resolveDataDir(env);
    cacheFile = path.join(dataDir, CAPABILITY_CACHE_FILE);
    let cached = capabilityCache.get(cacheFile);
    if (!cached) {
      try {
        cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      } catch {}
    }
    if (cached && isDeepStrictEqual(cached.key, key) && Array.isArray(cached.flags) &&
        cached.flags.every((flag) => /^--[a-z0-9][a-z0-9-]*$/i.test(flag))) {
      capabilityCache.set(cacheFile, cached);
      return new Set(cached.flags);
    }
  }
  const probeOptions = {
    encoding: "utf8",
    cwd,
    env: probeEnv,
    timeout: probeTimeout(deadline, 5000),
    maxBuffer: 2 * 1024 * 1024
  };
  const probe = spawnSync(bin, ["--help"], probeOptions);
  requireDeadline(deadline);
  if (probe.error) {
    throw capabilityError(`Unable to inspect Grok CLI capabilities: ${probe.error.message}`);
  }
  if (probe.status !== 0) {
    const detail = String(probe.stderr || probe.stdout || "").trim().slice(-1024);
    throw capabilityError(`Unable to inspect Grok CLI capabilities with --help${detail ? `: ${detail}` : "."}`);
  }
  const capabilities = new Set(`${probe.stdout ?? ""}\n${probe.stderr ?? ""}`.match(CAPABILITY_PATTERN) ?? []);
  for (const [flag, probeFlag] of REQUIRED_CAPABILITY_PROBES) {
    if (!capabilities.has(flag) && spawnSync(bin, [probeFlag, "--help"], { ...probeOptions, timeout: probeTimeout(deadline, 5000) }).status === 0) {
      capabilities.add(flag);
    }
    requireDeadline(deadline);
  }
  if (deadline == null) {
    capabilityCache.set(bin, capabilities);
    try {
      directCapabilityIdentity.set(bin, resolvedBinaryIdentity(bin, env, cwd));
    } catch {}
  } else {
    const entry = { key, flags: [...capabilities] };
    writePrivateDataFile(dataDir, CAPABILITY_CACHE_FILE, `${JSON.stringify(entry)}\n`);
    capabilityCache.set(cacheFile, entry);
  }
  return capabilities;
}

function requireGrokCapabilities(capabilities, flags) {
  const missing = flags.filter((flag) => !capabilities.has(flag));
  if (missing.length > 0) {
    throw capabilityError(`The installed Grok CLI is missing required safety capabilities: ${missing.join(", ")}. Upgrade Grok before running this task.`);
  }
}

function supportsCapability(capabilities, flag) {
  return capabilities == null || capabilities.has(flag);
}

export function buildGrokArgs(options) {
  const mode = options.mode === "write" ? "write" : "consult";
  const web = options.web === true;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS[mode];
  const capabilities = options.capabilities ?? null;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const args = [];

  if (options.resumeSessionId) {
    args.push("-r", options.resumeSessionId);
  }

  args.push(
    "--prompt-file",
    STDIN_PROMPT_FILE,
    "--output-format",
    "json",
    "--sandbox",
    sandboxProfileForMode(mode)
  );
  if (supportsCapability(capabilities, "--no-auto-update")) {
    args.push("--no-auto-update");
  }
  if (supportsCapability(capabilities, "--no-subagents")) {
    args.push("--no-subagents");
  }
  if (supportsCapability(capabilities, "--no-wait-for-background")) {
    args.push("--no-wait-for-background");
  }
  if (!web) {
    args.push("--disable-web-search");
  }
  args.push("--max-turns", String(maxTurns));

  if (options.model) {
    args.push("-m", options.model);
  }
  if (options.effort) {
    args.push("--effort", options.effort);
  }

  if (options.jsonSchema) {
    if (!supportsCapability(capabilities, "--json-schema")) {
      throw capabilityError("The installed Grok CLI does not support required structured output through --json-schema.");
    }
    const schema = typeof options.jsonSchema === "string" ? options.jsonSchema : JSON.stringify(options.jsonSchema);
    if (!schema || Buffer.byteLength(schema) > 256 * 1024) {
      throw capabilityError("The Grok structured output schema is empty or exceeds 256 KiB.");
    }
    args.push("--json-schema", schema);
  }

  const disallowedTools = ["Agent", ...DISALLOWED_META_TOOL_IDS];

  if (mode === "consult") {
    args.push(
      "--permission-mode",
      "default",
      "--tools",
      [...CONSULT_TOOL_IDS, ...(web ? CONSULT_WEB_TOOL_IDS : [])].join(","),
      "--disallowed-tools",
      disallowedTools.join(",")
    );
    for (const rule of CONSULT_ALLOW_RULES) {
      args.push("--allow", rule);
    }
    if (web) {
      for (const rule of CONSULT_WEB_ALLOW_RULES) {
        args.push("--allow", rule);
      }
    }
    for (const rule of resolveConsultAllowRules(env)) {
      args.push("--allow", rule);
    }
    for (const rule of CONSULT_DENY_RULES) {
      args.push("--deny", rule);
    }
    for (const rule of privateGrokReadDenyRules(env, cwd)) {
      args.push("--deny", rule);
    }
  } else {
    args.push(
      "--always-approve",
      "--tools",
      [...WRITE_TOOL_IDS, ...(web ? CONSULT_WEB_TOOL_IDS : [])].join(","),
      "--disallowed-tools",
      disallowedTools.join(",")
    );
    for (const rule of WRITE_DENY_RULES) {
      args.push("--deny", rule);
    }
    for (const rule of privateGrokReadDenyRules(env, cwd)) {
      args.push("--deny", rule);
    }
  }

  return args;
}

function tryParseObject(text) {
  if (!text || !text.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseGrokOutput(stdout) {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const whole = tryParseObject(trimmed);
  if (whole) {
    return whole;
  }
  const lines = trimmed.split(/\r?\n/);
  let lastObject = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = tryParseObject(lines[index].trim());
    if (parsed) {
      lastObject ??= parsed;
      if (isGrokEnvelope(parsed)) {
        return parsed;
      }
    }
  }
  return lastObject;
}

function maxTurnsReachedEvent(stdout) {
  return iterJsonObjects(stdout).some((object) => object.type === "max_turns_reached");
}

function maxTurnsReachedError(stderr) {
  const lines = String(stderr ?? "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (MAX_TURNS_REACHED_PATTERN.test(lines[index])) {
      return lines[index].trim();
    }
  }
  return null;
}

function internalErrorFromStderr(stderr) {
  const text = String(stderr ?? "");
  let error = null;
  for (const match of text.matchAll(/Internal error:\s*\{/gi)) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end += 1) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') {
        quoted = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}" && --depth === 0) {
        const body = tryParseObject(text.slice(start, end + 1));
        if (typeof body?.message === "string" && body.message.trim()) {
          error = {
            message: body.message.trim().replace(/\s+/g, " ").slice(0, 500),
            httpStatus: Number.isInteger(body.http_status) && body.http_status >= 100 && body.http_status <= 599 ? body.http_status : null
          };
        }
        break;
      }
    }
  }
  return error;
}

const DENIED_TOOL_STDERR_PATTERNS = [
  /\b(?:tool|rule)\s+[`'"]?([A-Za-z_][\w./:-]*(?:\([^)\r\n]*\))?)[`'"]?\s+(?:(?:is|was)\s+)?(?:not allowed|denied|disallowed|blocked|rejected)/i,
  /\b(?:denied|disallowed|blocked|rejected)\s+(?:tool|rule)\s*[:=]?\s*[`'"]?([A-Za-z_][\w./:-]*(?:\([^)\r\n]*\))?)[`'"]?/i,
  /\bpermission\s+denied(?:\s+(?:for|to))?\s+(?:tool\s+)?[`'"]?([A-Za-z_][\w./:-]*(?:\([^)\r\n]*\))?)[`'"]?/i,
  /\bnot\s+allowed\s+to\s+(?:use\s+)?(?:tool\s+)?[`'"]?([A-Za-z_][\w./:-]*(?:\([^)\r\n]*\))?)[`'"]?/i,
  /\b(?:deny|denied)\s+(?:matched\s+)?rule\s*[:=]?\s*[`'"]?([A-Za-z_][\w./()*: -]*)[`'"]?/i
];
const DENIED_TOOL_STDERR_NOISE = /^(?:operation|os|error|permission|access|for|to|the|a|an|by)$/i;

export function extractDeniedToolFromStderr(stderr) {
  const lines = String(stderr ?? "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    for (const pattern of DENIED_TOOL_STDERR_PATTERNS) {
      const match = line.match(pattern);
      const candidate = match?.[1]?.trim();
      if (candidate && !DENIED_TOOL_STDERR_NOISE.test(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function formatDeniedToolDetail(toolName) {
  if (typeof toolName !== "string" || !toolName.trim()) {
    return "";
  }
  return `; denied tool: ${toolName.trim()}`;
}

function iterJsonObjects(stdout) {
  const trimmed = String(stdout ?? "").trim();
  if (!trimmed) {
    return [];
  }
  const whole = tryParseObject(trimmed);
  if (whole) {
    return [whole];
  }
  const objects = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const parsed = tryParseObject(line.trim());
    if (parsed) {
      objects.push(parsed);
    }
  }
  return objects;
}

function sessionUpdatePayload(object) {
  if (!object || typeof object !== "object") {
    return null;
  }
  if (object.sessionUpdate) {
    return object;
  }
  if (object.update && typeof object.update === "object" && object.update.sessionUpdate) {
    return object.update;
  }
  if (object.params?.update && typeof object.params.update === "object" && object.params.update.sessionUpdate) {
    return object.params.update;
  }
  return null;
}

function toolNameFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const metaTool = payload._meta?.["x.ai/tool"];
  const candidates = [
    payload.name,
    payload.toolName,
    payload.tool_name,
    payload.title,
    payload.rawInput?.variant,
    metaTool?.label,
    metaTool?.name
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function toolArgsFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (payload.rawInput != null) {
    return payload.rawInput;
  }
  if (payload.input != null) {
    return payload.input;
  }
  if (payload.args != null) {
    return payload.args;
  }
  if (typeof payload.command === "string") {
    return payload.command;
  }
  if (typeof payload.arguments === "string") {
    return payload.arguments;
  }
  return null;
}

function stringifyToolArgs(args) {
  if (args == null) {
    return "";
  }
  if (typeof args === "string") {
    return args;
  }
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function isPermissionFailureUpdate(payload) {
  if (!payload || payload.sessionUpdate !== "tool_call_update") {
    return false;
  }
  if (payload.status !== "failed") {
    return false;
  }
  const chunks = [];
  if (Array.isArray(payload.content)) {
    for (const entry of payload.content) {
      const text = entry?.content?.text ?? entry?.text;
      if (typeof text === "string") {
        chunks.push(text);
      }
    }
  }
  const joined = chunks.join("\n");
  return /permission|denied|cancelled|canceled|not allowed|allow list|allowlist/i.test(joined);
}

function extractBlockedPermissionCall(stdout, envelope = null) {
  const objects = iterJsonObjects(stdout);
  if (envelope && typeof envelope === "object" && !objects.includes(envelope)) {
    objects.push(envelope);
  }

  for (const object of objects) {
    const directName =
      (typeof object.blockedTool === "string" && object.blockedTool) ||
      (typeof object.blocked_tool === "string" && object.blocked_tool) ||
      (typeof object.deniedTool === "string" && object.deniedTool) ||
      null;
    if (directName) {
      return {
        tool: directName.trim(),
        args: object.blockedArgs ?? object.blocked_args ?? object.deniedArgs ?? object.input ?? object.args ?? null
      };
    }
  }

  const toolCallsById = new Map();
  let lastToolCall = null;
  let deniedToolCall = null;

  for (const object of objects) {
    const payload = sessionUpdatePayload(object) ?? object;
    const sessionUpdate = payload.sessionUpdate ?? (object.type === "tool_call" ? "tool_call" : null);

    if (sessionUpdate === "tool_call" || object.type === "tool_call") {
      const tool = toolNameFromPayload(payload) ?? toolNameFromPayload(object);
      const args = toolArgsFromPayload(payload) ?? toolArgsFromPayload(object);
      if (!tool) {
        continue;
      }
      const entry = { tool, args };
      const id = payload.toolCallId ?? object.toolCallId ?? object.id ?? null;
      if (id) {
        toolCallsById.set(id, entry);
      }
      lastToolCall = entry;
      continue;
    }

    if (isPermissionFailureUpdate(payload)) {
      const id = payload.toolCallId ?? null;
      deniedToolCall = (id && toolCallsById.get(id)) || {
        tool: toolNameFromPayload(payload) || lastToolCall?.tool || "unknown",
        args: toolArgsFromPayload(payload) ?? lastToolCall?.args ?? null
      };
    }
  }

  return deniedToolCall ?? lastToolCall;
}

export function formatBlockedPermissionCall(blocked) {
  if (!blocked || typeof blocked.tool !== "string" || !blocked.tool.trim()) {
    return "; blocked call not reported by the CLI";
  }
  const argsText = stringifyToolArgs(blocked.args).slice(0, 80);
  return `; blocked call: ${blocked.tool.trim()}(${argsText})`;
}

function appendBounded(value, chunk, maxBytes) {
  const next = `${value}${chunk.toString()}`;
  if (Buffer.byteLength(next) <= maxBytes) {
    return next;
  }
  return Buffer.from(next).subarray(-maxBytes).toString("utf8");
}

function stdoutTail(stdout) {
  return String(stdout ?? "").trim().slice(-STDOUT_TAIL_MAX_BYTES);
}

function findSecurityFailure(stderr) {
  const lines = String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim());
  const sandbox = lines.find((line) => SANDBOX_FAILURE_PATTERN.test(line));
  if (sandbox) {
    return { kind: "sandbox", line: sandbox };
  }
  const toolPolicy = lines.find((line) => TOOL_POLICY_FAILURE_PATTERN.test(line));
  if (toolPolicy) {
    return { kind: "policy", line: toolPolicy };
  }
  const authRetry = lines.find((line) => AUTH_RETRY_FAILURE_PATTERN.test(line));
  return authRetry ? { kind: "auth", line: authRetry } : null;
}

function toolPolicyApplied(stderr) {
  return TOOL_POLICY_APPLIED_PATTERN.test(String(stderr ?? ""));
}

function securityError(kind, message) {
  const error = new Error(message);
  error.failureKind = kind;
  return error;
}

export function runtimeSocketEndpoints({ env = process.env, platform = process.platform, uid = typeof process.getuid === "function" ? process.getuid() : null } = {}) {
  if (Object.hasOwn(env, RUNTIME_SOCKET_CANDIDATES_ENV)) {
    return String(env[RUNTIME_SOCKET_CANDIDATES_ENV] ?? "")
      .split(":")
      .filter(Boolean);
  }
  const home = typeof env.HOME === "string" && env.HOME.trim() ? env.HOME : os.homedir();
  const endpoints = [
    "/run/docker.sock",
    "/var/run/docker.sock",
    "/run/podman/podman.sock",
    "/var/run/podman/podman.sock",
    "/run/containerd/containerd.sock",
    "/var/run/containerd/containerd.sock",
    path.join(home, ".docker", "desktop", "docker.sock"),
    path.join(home, ".docker", "run", "docker.sock")
  ];
  if (platform === "linux" && Number.isInteger(uid) && uid >= 0) {
    const runtimeDir = `/run/user/${uid}`;
    endpoints.push(
      path.join(runtimeDir, "docker.sock"),
      path.join(runtimeDir, "podman", "podman.sock"),
      path.join(runtimeDir, "containerd", "containerd.sock")
    );
  }
  return endpoints;
}

export function undeniedRuntimeSocketCandidates(env = process.env) {
  if (Object.hasOwn(env, UNDENIED_RUNTIME_SOCKET_CANDIDATES_ENV)) {
    return [...new Set(String(env[UNDENIED_RUNTIME_SOCKET_CANDIDATES_ENV] ?? "").split(":").filter(Boolean))];
  }
  const home = typeof env.HOME === "string" && env.HOME.trim() ? env.HOME : os.homedir();
  return [path.join(home, ".orbstack", "run", "docker.sock")];
}

export function existingUnixSockets(candidates, lstat = fs.lstatSync) {
  const sockets = [];
  for (const candidate of candidates) {
    try {
      if (lstat(candidate).isSocket()) {
        sockets.push(candidate);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return sockets;
}

export function undeniedRuntimeSocketRemedy() {
  return "Quit the container engine (for OrbStack, run `orb stop`), or route the package to Codex, whose sandbox blocks the connect. Grok write runs are refused while the socket exists.";
}

export function runtimeSocketSymlinkEndpoints(candidates, lstat = fs.lstatSync) {
  const symlinks = [];
  for (const endpoint of candidates) {
    try {
      if (lstat(endpoint).isSymbolicLink()) {
        symlinks.push(endpoint);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return symlinks;
}

export function runtimeSocketEngine(endpoint, readlink = fs.readlinkSync) {
  let target;
  try {
    target = String(readlink(endpoint));
  } catch {
    return null;
  }
  if (target.includes("/.orbstack/")) {
    return "orbstack";
  }
  if (target.includes("/.docker/run/") || target.includes("/.docker/desktop/")) {
    return "docker-desktop";
  }
  return null;
}

export function runtimeSocketRemedy(endpoint, engine) {
  if (engine === "orbstack") {
    return `OrbStack creates ${endpoint} through its admin helper. Run \`orb config set setup.use_admin false\`, remove the symlink with \`sudo rm ${endpoint}\`, and restart OrbStack; the docker CLI keeps working through the orbstack context, while features that need admin, such as host ports below 1024, stop until the setting is restored. Do not downgrade the sandbox.`;
  }
  if (engine === "docker-desktop") {
    return `Docker Desktop creates ${endpoint} while "Allow the default Docker socket to be used" is enabled under Settings, Advanced. Disable it, remove the symlink with \`sudo rm ${endpoint}\`, and restart Docker Desktop; the docker CLI keeps working through the desktop context. Do not downgrade the sandbox.`;
  }
  return `Stop the Docker engine that creates ${endpoint}, or remove the symlink. Do not downgrade the sandbox.`;
}

export function preflightRuntimeSocketEndpoints({ candidates = runtimeSocketEndpoints(), lstat = fs.lstatSync, readlink = fs.readlinkSync } = {}) {
  let symlinks;
  try {
    symlinks = runtimeSocketSymlinkEndpoints(candidates, lstat);
  } catch (error) {
    throw securityError("sandbox", `Unable to inspect Grok runtime-socket deny path: ${error.message}`);
  }
  if (symlinks.length > 0) {
    const endpoint = symlinks[0];
    throw securityError(
      "sandbox",
      `Grok strict sandbox (runtime-socket deny policy, 1.0.4 through 1.0.41) refuses to start while ${endpoint} exists as a symlink. ${runtimeSocketRemedy(endpoint, runtimeSocketEngine(endpoint, readlink))}`
    );
  }
  return symlinks;
}

function createManagedRunTempDir() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grok-companion-run-"));
  try {
    fs.chmodSync(directory, 0o700);
    return fs.realpathSync.native(directory);
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function removeManagedRunTempDir(directory) {
  if (!directory) {
    return;
  }
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {}
}

function sandboxHandshakeTimeoutMs(env) {
  const configured = Number(env[SANDBOX_HANDSHAKE_TIMEOUT_ENV]);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(Math.floor(configured), SANDBOX_HANDSHAKE_TIMEOUT_MS)
    : SANDBOX_HANDSHAKE_TIMEOUT_MS;
}

function resolveChildGrokHome(env, cwd) {
  if (typeof env.GROK_HOME === "string" && env.GROK_HOME.trim()) {
    return path.resolve(cwd, env.GROK_HOME.trim());
  }
  const home = typeof env.HOME === "string" && env.HOME.trim()
    ? path.resolve(cwd, env.HOME.trim())
    : os.homedir();
  return path.join(home, ".grok");
}

function resolveGrokAuthPaths(env, cwd) {
  const resolved = { ...env };
  for (const key of ["GROK_HOME", "GROK_AUTH_PATH"]) {
    if (typeof resolved[key] === "string" && resolved[key].trim()) {
      resolved[key] = path.resolve(cwd, resolved[key].trim());
    }
  }
  return resolved;
}

function staleRefreshRecentlyFailed(dataDir, file) {
  try {
    const attempt = JSON.parse(fs.readFileSync(path.join(dataDir, AUTH_REFRESH_ATTEMPT_FILE), "utf8"));
    const elapsed = Date.now() - Date.parse(attempt.attemptedAt);
    return attempt.file === file && attempt.outcome === "failed" &&
      Number.isFinite(elapsed) && elapsed >= 0 && elapsed < AUTH_REFRESH_RETRY_MS;
  } catch {
    return false;
  }
}

export function grokAuthStatus(env = process.env, cwd = process.cwd()) {
  const file = typeof env.GROK_AUTH_PATH === "string" && env.GROK_AUTH_PATH.trim()
    ? path.resolve(cwd, env.GROK_AUTH_PATH.trim())
    : path.join(resolveChildGrokHome(env, cwd), "auth.json");
  try {
    const ageMs = Math.max(0, Date.now() - fs.statSync(file).mtimeMs);
    return { file, ageSeconds: Math.floor(ageMs / 1000), stale: ageMs > AUTH_STALE_MS };
  } catch {
    return { file, ageSeconds: null, stale: true };
  }
}

function refreshGrokAuth({ bin, env, cwd, capabilities, reason, deadline }) {
  requireDeadline(deadline);
  const { file } = grokAuthStatus(env, cwd);
  let beforeMtime = null;
  try {
    beforeMtime = fs.statSync(file).mtimeMs;
  } catch {}
  const attemptedAt = new Date().toISOString();
  const args = capabilities.has("--no-auto-update") ? ["--no-auto-update", "models"] : ["models"];
  const refreshDir = createManagedRunTempDir();
  try {
    spawnSync(bin, args, {
      cwd: refreshDir,
      env: { ...env, TMPDIR: refreshDir },
      stdio: "ignore",
      timeout: probeTimeout(deadline, 30000)
    });
  } finally {
    removeManagedRunTempDir(refreshDir);
  }
  let refreshed = false;
  try {
    refreshed = beforeMtime !== null && fs.statSync(file).mtimeMs > beforeMtime;
  } catch {}
  return { attemptedAt, refreshed, reason };
}

function openSandboxEventLog(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) {
      throw securityError("sandbox", "The Grok sandbox event log is not a regular file.");
    }
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw securityError("sandbox", "The Grok sandbox event log is not owned by the current user.");
    }
    if ((stats.mode & 0o022) !== 0) {
      throw securityError("sandbox", "The Grok sandbox event log is writable by another user or group.");
    }
    return { descriptor, stats };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function captureSandboxEventLog(grokHome) {
  const file = path.join(grokHome, "sessions", "sandbox-events.jsonl");
  try {
    const opened = openSandboxEventLog(file);
    try {
      const markerLength = Math.min(opened.stats.size, SANDBOX_EVENT_MARKER_MAX_BYTES);
      const marker = Buffer.alloc(markerLength);
      const markerPosition = opened.stats.size - markerLength;
      let markerOffset = 0;
      while (markerOffset < marker.length) {
        const read = fs.readSync(
          opened.descriptor,
          marker,
          markerOffset,
          marker.length - markerOffset,
          markerPosition + markerOffset
        );
        if (read === 0) {
          break;
        }
        markerOffset += read;
      }
      if (markerOffset !== marker.length) {
        throw securityError("sandbox", "Unable to snapshot the Grok sandbox event log marker.");
      }
      return {
        file,
        identity: { dev: opened.stats.dev, ino: opened.stats.ino },
        offset: opened.stats.size,
        scanned: 0,
        partial: Buffer.alloc(0),
        markerPosition,
        marker
      };
    } finally {
      fs.closeSync(opened.descriptor);
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { file, identity: null, offset: 0, scanned: 0, partial: Buffer.alloc(0), markerPosition: 0, marker: Buffer.alloc(0) };
    }
    throw securityError("sandbox", `Unable to snapshot the Grok sandbox event log: ${error.message}`);
  }
}

function sameFileIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function readSandboxEventDelta(snapshot) {
  let opened;
  try {
    opened = openSandboxEventLog(snapshot.file);
  } catch (error) {
    if (error?.code === "ENOENT" && snapshot.identity == null) {
      return null;
    }
    throw securityError("sandbox", "The Grok sandbox event log disappeared or rotated during startup.");
  }
  try {
    const identity = { dev: opened.stats.dev, ino: opened.stats.ino };
    if (snapshot.identity && !sameFileIdentity(snapshot.identity, identity)) {
      throw securityError("sandbox", "The Grok sandbox event log rotated during startup.");
    }
    if (!snapshot.identity) {
      snapshot.identity = identity;
    }
    if (opened.stats.size < snapshot.offset) {
      throw securityError("sandbox", "The Grok sandbox event log was truncated during startup.");
    }
    if (snapshot.marker.length > 0) {
      const marker = Buffer.alloc(snapshot.marker.length);
      const read = fs.readSync(
        opened.descriptor,
        marker,
        0,
        marker.length,
        snapshot.markerPosition
      );
      if (read !== marker.length || !marker.equals(snapshot.marker)) {
        throw securityError("sandbox", "The Grok sandbox event log was truncated or rewritten during startup.");
      }
    }
    const length = opened.stats.size - snapshot.offset;
    if (length === 0) {
      return null;
    }
    if (snapshot.scanned + length > SANDBOX_EVENT_DELTA_MAX_BYTES) {
      throw securityError("sandbox", "The Grok sandbox event log grew beyond the startup verification limit.");
    }
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(opened.descriptor, bytes, offset, bytes.length - offset, snapshot.offset + offset);
      if (read === 0) {
        break;
      }
      offset += read;
    }
    if (offset !== bytes.length) {
      throw securityError("sandbox", "Unable to read the complete Grok sandbox startup evidence.");
    }
    snapshot.offset += length;
    snapshot.scanned += length;
    return bytes;
  } finally {
    fs.closeSync(opened.descriptor);
  }
}

function sandboxEventType(event) {
  return typeof event?.event_type === "string" ? event.event_type.replaceAll("_", "").toLowerCase() : "";
}

function normalizedEventPath(value) {
  return typeof value === "string" ? normalizedFilesystemPath(value) : null;
}

function inspectSandboxStartupEvidence(snapshot, expected) {
  const delta = readSandboxEventDelta(snapshot);
  if (!delta) {
    return { status: "pending" };
  }
  const bytes = snapshot.partial.length ? Buffer.concat([snapshot.partial, delta]) : delta;
  let start = 0;
  for (let end = bytes.indexOf(10, start); end !== -1; end = bytes.indexOf(10, start)) {
    const line = bytes.subarray(start, end).toString("utf8").replace(/\r$/, "");
    start = end + 1;
    if (!line.trim()) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return { status: "failed", reason: "The Grok sandbox event log contains malformed startup evidence." };
    }
    const type = sandboxEventType(event);
    const workspace = normalizedEventPath(event.workspace);
    if (workspace !== expected.workspace || event.profile !== expected.profile) {
      continue;
    }
    if (type !== "profileapplied") {
      continue;
    }
    const writablePaths = Array.isArray(event.read_write_paths)
      ? event.read_write_paths.map(normalizedEventPath).filter(Boolean)
      : [];
    if (!writablePaths.includes(expected.tempDir)) {
      continue;
    }
    if (event.enforced !== true) {
      return { status: "failed", reason: "Grok reported a sandbox profile that was not enforced." };
    }
    if (event.restrict_network !== expected.restrictNetwork) {
      return { status: "failed", reason: "Grok reported unexpected sandbox network restrictions." };
    }
    return { status: "verified" };
  }
  snapshot.partial = Buffer.from(bytes.subarray(start));
  return { status: "pending" };
}

function createStdoutSpool() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "grok-companion-stdout-"));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, "stdout.json");
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
    return { directory: null, descriptor, bytes: 0 };
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function closeStdoutSpool(spool) {
  if (spool.descriptor == null) {
    return;
  }
  fs.closeSync(spool.descriptor);
  spool.descriptor = null;
}

function appendStdoutSpool(spool, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const written = fs.writeSync(spool.descriptor, chunk, offset, chunk.length - offset);
    if (written <= 0) {
      throw new Error("Unable to write the Grok stdout spool.");
    }
    offset += written;
  }
  spool.bytes += chunk.length;
}

function readStdoutSpool(spool) {
  const stats = fs.fstatSync(spool.descriptor);
  if (!stats.isFile() || stats.size > STDOUT_CAPTURE_MAX_BYTES) {
    throw new Error("Grok stdout spool is invalid or exceeds the capture limit.");
  }
  const bytes = Buffer.alloc(stats.size);
  let offset = 0;
  while (offset < bytes.length) {
    const read = fs.readSync(spool.descriptor, bytes, offset, bytes.length - offset, offset);
    if (read === 0) {
      break;
    }
    offset += read;
  }
  if (offset !== bytes.length) {
    throw new Error("Unable to read the complete Grok stdout spool.");
  }
  return bytes.toString("utf8");
}

function removeStdoutSpool(spool) {
  try {
    closeStdoutSpool(spool);
  } catch {}
  try {
    if (spool.directory) {
      fs.rmSync(spool.directory, { recursive: true, force: true });
    }
  } catch {}
}

function expectsJsonOutput(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--output-format" && args[index + 1] === "json") {
      return true;
    }
    if (token === "--output-format=json") {
      return true;
    }
  }
  return false;
}

function isGrokEnvelope(value) {
  return Boolean(value) && typeof value.text === "string" && typeof value.stopReason === "string";
}

function objectField(value, ...keys) {
  for (const key of keys) {
    const field = value?.[key];
    if (field && typeof field === "object" && !Array.isArray(field)) {
      return field;
    }
  }
  return null;
}

function stringField(value, ...keys) {
  for (const key of keys) {
    if (typeof value?.[key] === "string" && value[key].trim()) {
      return value[key].trim();
    }
  }
  return null;
}

function observedField(value, ...keys) {
  const observed = [];
  for (const key of keys) {
    if (value && Object.hasOwn(value, key)) {
      observed.push({ key, value: value[key] });
    }
  }
  if (observed.length === 0) {
    return { present: false, value: null, conflict: false };
  }
  return {
    present: true,
    value: observed[0].value,
    conflict: observed.slice(1).some((entry) => !isDeepStrictEqual(entry.value, observed[0].value))
  };
}

function nonNegativeSafeIntegerField(value, names) {
  const observed = [];
  for (const name of names) {
    if (Object.hasOwn(value, name)) {
      observed.push(value[name]);
    }
  }
  if (observed.length === 0) {
    return { present: false, valid: false, value: null };
  }
  const conflict = observed.slice(1).some((candidate) => !isDeepStrictEqual(candidate, observed[0]));
  return { present: true, valid: !conflict && Number.isSafeInteger(observed[0]) && observed[0] >= 0, value: observed[0] };
}

function headlessTokenUsageObservation(value) {
  const observed = observedField(value, "usage");
  if (!observed.present) {
    return { error: null, complete: false, usage: null };
  }
  if (!observed.value || typeof observed.value !== "object" || Array.isArray(observed.value)) {
    return { error: "Grok returned an invalid usage object in its JSON envelope." };
  }
  const usage = {};
  for (const [field, names] of Object.entries({
    input: ["input_tokens", "inputTokens"],
    cacheRead: ["cache_read_input_tokens", "cacheReadInputTokens", "cachedReadTokens"],
    cacheCreation: ["cache_creation_input_tokens", "cacheCreationInputTokens"],
    output: ["output_tokens", "outputTokens"],
    reasoning: ["reasoning_tokens", "reasoningTokens"],
    total: ["total_tokens", "totalTokens"]
  })) {
    const metric = nonNegativeSafeIntegerField(observed.value, names);
    if (metric.present && !metric.valid) {
      return { error: `Grok returned an invalid usage.${names[0]} value in its JSON envelope.` };
    }
    if (metric.present) {
      usage[field] = metric.value;
    }
  }
  const complete = ["input", "cacheRead", "output", "reasoning", "total"].every((field) => Object.hasOwn(usage, field));
  if (Object.keys(usage).length === 0) {
    return { error: "Grok returned an empty usage object in its JSON envelope." };
  }
  if (usage.reasoning != null && usage.output != null && usage.reasoning > usage.output) {
    return { error: "Grok returned usage.reasoning_tokens greater than usage.output_tokens in its JSON envelope." };
  }
  if (complete && BigInt(usage.input) + BigInt(usage.cacheRead) + BigInt(usage.cacheCreation ?? 0) + BigInt(usage.output) !== BigInt(usage.total)) {
    return { error: "Grok returned inconsistent token totals in its JSON envelope." };
  }
  return { error: null, complete, usage };
}

function headlessModelUsageObservation(value) {
  const observed = observedField(value, "modelUsage", "model_usage");
  if (!observed.present) {
    return { error: null, complete: false, totals: null };
  }
  if (observed.conflict) {
    return { error: "Grok returned conflicting modelUsage aliases in its JSON envelope." };
  }
  if (!observed.value || typeof observed.value !== "object" || Array.isArray(observed.value) || Object.keys(observed.value).length === 0) {
    return { error: "Grok returned an invalid modelUsage object in its JSON envelope." };
  }
  const totals = { input: 0n, cacheRead: 0n, output: 0n };
  let complete = true;
  for (const [model, row] of Object.entries(observed.value)) {
    if (!model.trim() || !row || typeof row !== "object" || Array.isArray(row)) {
      return { error: "Grok returned an invalid modelUsage row in its JSON envelope." };
    }
    const fields = {
      input: nonNegativeSafeIntegerField(row, ["inputTokens", "input_tokens"]),
      cacheRead: nonNegativeSafeIntegerField(row, ["cacheReadInputTokens", "cachedReadTokens", "cache_read_input_tokens"]),
      output: nonNegativeSafeIntegerField(row, ["outputTokens", "output_tokens"]),
      modelCalls: nonNegativeSafeIntegerField(row, ["modelCalls", "model_calls"])
    };
    if (Object.values(fields).some((field) => field.present && !field.valid)) {
      return { error: `Grok returned invalid counters for modelUsage.${model} in its JSON envelope.` };
    }
    if (Object.values(fields).every((field) => !field.present)) {
      return { error: `Grok returned an empty modelUsage.${model} row in its JSON envelope.` };
    }
    if (Object.hasOwn(row, "costUSD") && (!Number.isFinite(row.costUSD) || row.costUSD < 0)) {
      return { error: `Grok returned an invalid modelUsage.${model}.costUSD value in its JSON envelope.` };
    }
    if (!Object.values(fields).every((field) => field.present)) {
      complete = false;
      continue;
    }
    totals.input += BigInt(fields.input.value);
    totals.cacheRead += BigInt(fields.cacheRead.value);
    totals.output += BigInt(fields.output.value);
  }
  return { error: null, complete, totals };
}

function headlessMetricsObservation(value) {
  const numTurns = observedField(value, "num_turns", "numTurns");
  const totalCostUsd = observedField(value, "total_cost_usd", "totalCostUsd");
  const totalCostUsdTicks = observedField(value, "total_cost_usd_ticks", "totalCostUsdTicks");
  const costIsPartial = observedField(value, "cost_is_partial", "costIsPartial");
  const usageIsIncomplete = observedField(value, "usage_is_incomplete", "usageIsIncomplete");
  for (const [field, observed] of [
    ["num_turns", numTurns],
    ["total_cost_usd", totalCostUsd],
    ["total_cost_usd_ticks", totalCostUsdTicks],
    ["cost_is_partial", costIsPartial],
    ["usage_is_incomplete", usageIsIncomplete]
  ]) {
    if (observed.conflict) {
      return { error: `Grok returned conflicting aliases for ${field} in its JSON envelope.` };
    }
  }
  const tokenUsage = headlessTokenUsageObservation(value);
  if (tokenUsage.error) {
    return { error: tokenUsage.error };
  }
  const modelUsage = headlessModelUsageObservation(value);
  if (modelUsage.error) {
    return { error: modelUsage.error };
  }
  if (tokenUsage.complete && modelUsage.complete && (
    modelUsage.totals.input !== BigInt(tokenUsage.usage.input) ||
    modelUsage.totals.cacheRead !== BigInt(tokenUsage.usage.cacheRead) ||
    modelUsage.totals.output !== BigInt(tokenUsage.usage.output)
  )) {
    return { error: "Grok returned modelUsage counters that do not match its usage totals." };
  }
  if (numTurns.present && (!Number.isSafeInteger(numTurns.value) || numTurns.value < 0)) {
    return { error: "Grok returned an invalid num_turns value in its JSON envelope." };
  }
  for (const [field, observed] of [
    ["cost_is_partial", costIsPartial],
    ["usage_is_incomplete", usageIsIncomplete]
  ]) {
    if (observed.present && typeof observed.value !== "boolean") {
      return { error: `Grok returned an invalid ${field} value in its JSON envelope.` };
    }
  }
  if (totalCostUsd.present !== totalCostUsdTicks.present) {
    return { error: "Grok returned only one member of the total cost pair in its JSON envelope." };
  }
  if (totalCostUsd.present) {
    if (
      !Number.isFinite(totalCostUsd.value) ||
      totalCostUsd.value <= 0 ||
      !Number.isSafeInteger(totalCostUsdTicks.value) ||
      totalCostUsdTicks.value <= 0
    ) {
      return { error: "Grok returned an invalid total cost pair in its JSON envelope." };
    }
    if (costIsPartial.value === true || usageIsIncomplete.value === true) {
      return { error: "Grok returned an exact total cost pair for incomplete usage in its JSON envelope." };
    }
    const derivedUsd = totalCostUsdTicks.value / USD_TICKS;
    const tolerance = Math.max(1e-12, Math.abs(derivedUsd) * Number.EPSILON * 8);
    if (Math.abs(totalCostUsd.value - derivedUsd) > tolerance) {
      return { error: "Grok returned inconsistent USD and tick totals in its JSON envelope." };
    }
    if (!tokenUsage.complete || !modelUsage.complete) {
      return { error: "Grok returned an exact total cost pair without complete token and model usage in its JSON envelope." };
    }
  }
  return {
    error: null,
    numTurns: numTurns.present ? numTurns.value : null,
    totalCostUsd: totalCostUsd.present ? totalCostUsd.value : null,
    totalCostUsdTicks: totalCostUsdTicks.present ? totalCostUsdTicks.value : null,
    costIsPartial: costIsPartial.present ? costIsPartial.value : null,
    usageIsIncomplete: usageIsIncomplete.present ? usageIsIncomplete.value : null
  };
}

function readSmallFile(file, maxBytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size <= 0 || stats.size > maxBytes) {
      return null;
    }
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) {
        break;
      }
      offset += read;
    }
    return offset === bytes.length ? bytes.toString("utf8") : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function normalizedFilesystemPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value.trim())) {
    return null;
  }
  let normalized = path.resolve(value.trim());
  try {
    normalized = fs.realpathSync.native(normalized);
  } catch {}
  return normalized;
}

function encodeSessionCwd(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodedSessionCwd(directory) {
  try {
    const encoded = normalizedFilesystemPath(decodeURIComponent(path.basename(directory)));
    if (encoded) {
      return encoded;
    }
  } catch {}
  const metadata = readSmallFile(path.join(directory, ".cwd"), SESSION_CWD_MAX_BYTES);
  return metadata == null ? null : normalizedFilesystemPath(metadata);
}

function safeSessionDirectory(directory, sessionId) {
  try {
    const workspaceStats = fs.lstatSync(directory);
    if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink()) {
      return null;
    }
    const sessionDirectory = path.join(directory, sessionId);
    const sessionStats = fs.lstatSync(sessionDirectory);
    return sessionStats.isDirectory() && !sessionStats.isSymbolicLink() ? sessionDirectory : null;
  } catch {
    return null;
  }
}

function readSessionSummary(sessionDirectory) {
  try {
    const content = readSmallFile(path.join(sessionDirectory, "summary.json"), SESSION_SUMMARY_MAX_BYTES);
    if (content == null) {
      return null;
    }
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return {
      model: stringField(parsed, "current_model_id", "currentModelId", "model", "modelId"),
      effort: stringField(parsed, "reasoning_effort", "reasoningEffort", "effort")
    };
  } catch {
    return null;
  }
}

function readResolvedSessionMetadata(cwd, sessionId, env) {
  const normalizedSessionId = normalizeGrokSessionId(sessionId);
  if (!cwd || !normalizedSessionId) {
    return null;
  }
  const grokHome = resolveChildGrokHome(env, cwd);
  const sessionCwd = normalizedFilesystemPath(cwd);
  const sessionsRoot = path.join(grokHome, "sessions");
  if (!sessionCwd) {
    return null;
  }
  try {
    const rootStats = fs.lstatSync(sessionsRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      return null;
    }
  } catch {
    return null;
  }
  const encodedCwd = encodeSessionCwd(sessionCwd);
  if (Buffer.byteLength(encodedCwd) <= 255) {
    const sessionDirectory = safeSessionDirectory(path.join(sessionsRoot, encodedCwd), normalizedSessionId);
    return sessionDirectory ? readSessionSummary(sessionDirectory) : null;
  }
  const matching = [];
  let directory;
  try {
    directory = fs.opendirSync(sessionsRoot);
    for (let count = 0; ; count += 1) {
      const entry = directory.readSync();
      if (!entry) {
        break;
      }
      if (count >= SESSION_SCAN_MAX_ENTRIES) {
        return null;
      }
      if (!entry.isDirectory()) {
        continue;
      }
      const workspaceDirectory = path.join(sessionsRoot, entry.name);
      const sessionDirectory = safeSessionDirectory(workspaceDirectory, normalizedSessionId);
      if (sessionDirectory && decodedSessionCwd(workspaceDirectory) === sessionCwd) {
        matching.push(sessionDirectory);
        if (matching.length > 1) {
          return null;
        }
      }
    }
  } catch {
    return null;
  } finally {
    try {
      directory?.closeSync();
    } catch {}
  }
  return matching.length === 1 ? readSessionSummary(matching[0]) : null;
}

function resolvedOutputMetadata(parsed, cwd, env = process.env) {
  const sessionId = normalizeGrokSessionId(stringField(parsed, "sessionId", "session_id"));
  const summary = readResolvedSessionMetadata(cwd, sessionId, env);
  const modelUsage = objectField(parsed, "modelUsage", "model_usage");
  const modelNames = modelUsage ? Object.keys(modelUsage).filter((name) => name.trim()) : [];
  return {
    model:
      stringField(parsed, "model", "modelId", "model_id", "currentModelId", "current_model_id") ??
      stringField(parsed?._meta, "model", "modelId", "model_id") ??
      (modelNames.length === 1 ? modelNames[0] : null) ??
      summary?.model,
    effort:
      stringField(parsed, "effort", "reasoningEffort", "reasoning_effort") ??
      stringField(parsed?._meta, "effort", "reasoningEffort", "reasoning_effort") ??
      summary?.effort
  };
}

export function terminalRecordAttribution(record, patch = {}, env = process.env) {
  const resultPayload = patch?.resultPayload ?? record?.resultPayload;
  const partialEnvelope =
    patch?.parsedEnvelope ??
    patch?.partialEnvelope ??
    (resultPayload && typeof resultPayload === "object" && !Array.isArray(resultPayload) ? resultPayload : null);
  const sessionId =
    patch?.sessionId ??
    partialEnvelope?.sessionId ??
    partialEnvelope?.session_id ??
    record?.sessionId ??
    record?.request?.resumeSessionId ??
    null;
  const resolved = resolvedOutputMetadata(
    {
      ...partialEnvelope,
      sessionId,
      model: patch?.resolvedModel ?? partialEnvelope?.model ?? partialEnvelope?.resolvedModel ?? record?.resolvedModel ?? undefined,
      effort: patch?.resolvedEffort ?? partialEnvelope?.effort ?? partialEnvelope?.resolvedEffort ?? record?.resolvedEffort ?? undefined
    },
    record?.cwd,
    env
  );
  return {
    resolvedModel: patch?.resolvedModel ?? record?.resolvedModel ?? resolved.model ?? record?.request?.model ?? null,
    resolvedEffort: patch?.resolvedEffort ?? record?.resolvedEffort ?? resolved.effort ?? record?.request?.effort ?? null
  };
}

function canSignalProcess(pid, identity, allowExitedLeader) {
  return identity == null || processIdentityMatches(pid, identity) || (allowExitedLeader && !processIsDirectlyAlive(pid));
}

function signalProcessGroup(pid, signal, identity = null, options = {}) {
  const allowExitedLeader = options.allowExitedLeader === true;
  const fallbackToPid = options.fallbackToPid !== false;
  const kill = options.kill ?? process.kill.bind(process);
  if (!Number.isInteger(pid) || pid <= 1 || !canSignalProcess(pid, identity, allowExitedLeader)) {
    return false;
  }
  try {
    kill(-pid, signal);
    return true;
  } catch {
    if (!canSignalProcess(pid, identity, allowExitedLeader) || !fallbackToPid) {
      return false;
    }
    try {
      kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function processGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  return liveProcessGroup(pid) || processIsDirectlyAlive(pid);
}

function exitedLeaderProcessGroupAlive(pid, kill = null) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  if (!kill) {
    return liveProcessGroup(pid);
  }
  try {
    kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function terminateExitedLeaderProcessGroup(pid, identity = null, options = {}) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  const graceMs = options.graceMs ?? TERMINATION_GRACE_MS;
  const pollMs = options.pollMs ?? TERMINATION_POLL_MS;
  const kill = options.kill ?? process.kill.bind(process);
  if (!exitedLeaderProcessGroupAlive(pid, options.kill)) {
    return true;
  }
  if (!signalProcessGroup(pid, "SIGTERM", identity, { allowExitedLeader: true, fallbackToPid: false, kill })) {
    return !exitedLeaderProcessGroupAlive(pid, options.kill);
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!exitedLeaderProcessGroupAlive(pid, options.kill)) {
      return true;
    }
    await waitMs(pollMs);
  }
  if (exitedLeaderProcessGroupAlive(pid, options.kill) && !signalProcessGroup(pid, "SIGKILL", identity, { allowExitedLeader: true, fallbackToPid: false, kill })) {
    return !exitedLeaderProcessGroupAlive(pid, options.kill);
  }
  while (Date.now() < deadline + graceMs) {
    if (!exitedLeaderProcessGroupAlive(pid, options.kill)) {
      return true;
    }
    await waitMs(pollMs);
  }
  return !exitedLeaderProcessGroupAlive(pid, options.kill);
}

function normalizedPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

export function recordedProcessState(pid, identity = null) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return "absent";
  }
  const currentIdentity = getProcessIdentity(pid);
  if (currentIdentity) {
    if (!validProcessIdentity(identity)) {
      return "unverified";
    }
    return processIdentityMatches(pid, identity) ? "owned" : "replaced";
  }
  if (processIsDirectlyAlive(pid) || processGroupAlive(pid)) {
    return "unverified";
  }
  return "absent";
}

function recordedProcessTargets(record) {
  const targets = new Map();
  const grokPid = normalizedPid(record?.grokPid);
  const pid = normalizedPid(record?.pid);
  if (grokPid) {
    targets.set(grokPid, { pid: grokPid, identity: record?.grokPidIdentity ?? null });
  }
  if (record?.background || !grokPid) {
    if (pid) {
      targets.set(pid, { pid, identity: record?.pidIdentity ?? null });
    }
  }
  return [...targets.values()];
}

export function recordedProcessGroupsClean(record) {
  return recordedProcessTargets(record).every(({ pid, identity }) => {
    const state = recordedProcessState(pid, identity);
    return state === "absent" || state === "replaced";
  });
}

function launchTimestampMs(record) {
  const value = record?.startedAt ?? record?.createdAt;
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function runningJobLiveness(record, options = {}) {
  if (record?.status !== "running") {
    return { alive: true, pids: [], deadPids: [] };
  }
  const pid = normalizedPid(record.pid);
  const grokPid = normalizedPid(record.grokPid);
  const targets = pid
    ? [{ pid, identity: record.pidIdentity ?? null }]
    : grokPid
      ? [{ pid: grokPid, identity: record.grokPidIdentity ?? null }]
      : [];
  const pids = targets.map((target) => target.pid);
  if (pids.length === 0) {
    const launchedAt = launchTimestampMs(record);
    const now = options.now ?? Date.now();
    const graceMs = options.pidlessGraceMs ?? resolvePidlessRunningGraceMs(options.env ?? process.env);
    return { alive: launchedAt == null || now - launchedAt <= graceMs, pids, deadPids: [] };
  }
  const deadPids = targets
    .filter(({ pid: processPid, identity }) => {
      const state = recordedProcessState(processPid, identity);
      return state === "absent" || state === "replaced";
    })
    .map((target) => target.pid);
  return { alive: deadPids.length !== pids.length, pids, deadPids };
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function settleProcessIdentitySync(pid, capture, options = {}) {
  const retries = options.retries ?? 40;
  const intervalMs = options.intervalMs ?? 4;
  let previous = capture(pid);
  if (!previous) {
    for (let attempt = 0; attempt < 4 && processIsDirectlyAlive(pid); attempt += 1) {
      waitSync(50);
      if (!processIsDirectlyAlive(pid)) {
        return null;
      }
      previous = capture(pid);
      if (previous) {
        break;
      }
    }
    if (!previous) {
      return null;
    }
  }
  for (let attempt = 0; attempt < retries; attempt += 1) {
    waitSync(intervalMs);
    const current = capture(pid);
    if (!current) {
      if (!processIsDirectlyAlive(pid)) {
        return null;
      }
      continue;
    }
    if (processIdentitiesMatch(current, previous)) {
      return current;
    }
    previous = current;
  }
  return previous;
}

function terminationTargetAlive(pid, identity) {
  if (identity == null) {
    return processGroupAlive(pid);
  }
  const currentIdentity = getProcessIdentity(pid);
  if (currentIdentity) {
    return processIdentityMatches(pid, identity);
  }
  return processGroupAlive(pid);
}

export function terminateProcessGroupSync(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  const graceMs = options.graceMs ?? TERMINATION_GRACE_MS;
  const pollMs = options.pollMs ?? TERMINATION_POLL_MS;
  const identity = options.identity ?? null;
  if (!signalProcessGroup(pid, "SIGTERM", identity)) {
    return !terminationTargetAlive(pid, identity);
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!terminationTargetAlive(pid, identity)) {
      return true;
    }
    waitSync(pollMs);
  }
  if (options.gracefulOnly === true) {
    return !terminationTargetAlive(pid, identity);
  }
  if (terminationTargetAlive(pid, identity) && !signalProcessGroup(pid, "SIGKILL", identity)) {
    return !terminationTargetAlive(pid, identity);
  }
  while (Date.now() < deadline + graceMs) {
    if (!terminationTargetAlive(pid, identity)) {
      return true;
    }
    waitSync(pollMs);
  }
  return !terminationTargetAlive(pid, identity);
}

export async function terminateProcessGroup(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  const graceMs = options.graceMs ?? TERMINATION_GRACE_MS;
  const pollMs = options.pollMs ?? TERMINATION_POLL_MS;
  const identity = options.identity ?? null;
  if (!signalProcessGroup(pid, "SIGTERM", identity)) {
    return !terminationTargetAlive(pid, identity);
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!terminationTargetAlive(pid, identity)) {
      return true;
    }
    await waitMs(pollMs);
  }
  if (options.gracefulOnly === true) {
    return !terminationTargetAlive(pid, identity);
  }
  if (terminationTargetAlive(pid, identity) && !signalProcessGroup(pid, "SIGKILL", identity)) {
    return !terminationTargetAlive(pid, identity);
  }
  while (Date.now() < deadline + graceMs) {
    if (!terminationTargetAlive(pid, identity)) {
      return true;
    }
    await waitMs(pollMs);
  }
  return !terminationTargetAlive(pid, identity);
}

export function terminateRecordedProcessGroupsSync(record, options = {}) {
  const results = recordedProcessTargets(record).map(({ pid, identity }) => {
    const state = recordedProcessState(pid, identity);
    if (state === "absent" || state === "replaced") {
      return true;
    }
    if (state === "unverified") {
      return false;
    }
    return terminateProcessGroupSync(pid, {
      ...options,
      identity: state === "owned" ? identity : null,
      gracefulOnly: false
    });
  });
  return results.every(Boolean);
}

export async function terminateRecordedProcessGroups(record, options = {}) {
  const results = await Promise.all(recordedProcessTargets(record).map(async ({ pid, identity }) => {
    const state = recordedProcessState(pid, identity);
    if (state === "absent" || state === "replaced") {
      return true;
    }
    if (state === "unverified") {
      return false;
    }
    return terminateProcessGroup(pid, {
      ...options,
      identity: state === "owned" ? identity : null,
      gracefulOnly: false
    });
  }));
  return results.every(Boolean);
}

function exitCodeFromSignal(signal) {
  if (!signal) {
    return 1;
  }
  const signalNumber = os.constants.signals[signal];
  return Number.isInteger(signalNumber) ? 128 + signalNumber : 1;
}

function spawnChild(run) {
  run.child = spawn(run.bin, run.args, {
    cwd: run.options.cwd,
    env: run.childEnv,
    stdio: [run.prompt == null ? "ignore" : "pipe", "pipe", "pipe"],
    detached: true
  });
  run.childIdentity = Number.isInteger(run.child.pid)
    ? settleProcessIdentitySync(run.child.pid, run.captureProcessIdentity) : null;
  return { child: run.child, pid: run.child.pid ?? null, identity: run.childIdentity };
}

function cleanup(run) {
  if (run.timer) {
    clearTimeout(run.timer);
  }
  if (run.sandboxPollTimer) {
    clearTimeout(run.sandboxPollTimer);
  }
  process.removeListener("SIGTERM", run.forwardTermination);
  process.removeListener("SIGINT", run.forwardTermination);
  removeManagedRunTempDir(run.managedTempDir);
  run.managedTempDir = null;
}

function cleanupFailure(run, { residual = false } = {}) {
  const message = !run.childIdentity
    ? "Grok process identity could not be verified; process cleanup requires manual inspection."
    : residual
      ? "Verified Grok process-group cleanup did not complete after the CLI exited."
      : "Verified Grok process cleanup did not complete after the run was aborted.";
  const error = new Error(message);
  error.failureKind = run.timedOut ? "timeout" : run.cancelledByCompanion ? "cancelled" : run.supervisionError?.failureKind ?? "error";
  error.cleanupRequired = true;
  error.processRole = "grok";
  error.pid = run.child.pid ?? null;
  error.pidIdentity = residual ? null : run.childIdentity;
  return error;
}

function finishReject(run, error) {
  if (run.settled) {
    return;
  }
  run.settled = true;
  cleanup(run);
  run.child.stdout?.destroy();
  run.child.stderr?.destroy();
  run.child.unref();
  removeStdoutSpool(run.stdoutSpool);
  run.reject(error);
}

function terminationFailed() {
  return false;
}

function terminateChild(run) {
  if (!Number.isInteger(run.child.pid) || run.child.pid <= 1) {
    run.terminationPromise ??= Promise.resolve(true);
    return run.terminationPromise;
  }
  run.terminationPromise ??= terminateProcessGroup(
    run.child.pid,
    { ...(run.childIdentity ? { identity: run.childIdentity } : {}),
      ...(run.managedRun ? { graceMs: cleanupGraceMs(run.deadline) } : {}) }
  ).catch(terminationFailed);
  void run.terminationPromise.then((cleaned) => finishTermination(run, cleaned));
  return run.terminationPromise;
}

function finishTermination(run, cleaned) {
  if (!cleaned) {
    finishReject(run, cleanupFailure(run));
  }
}

function forwardTermination(run) {
  run.cancelledByCompanion = true;
  terminateChild(run);
}

function expireGrokRun(run) {
  run.timedOut = true;
  terminateChild(run);
}

function recordPromptTransportError(run, error) {
  if (!run.promptTransportError) {
    run.promptTransportError = error instanceof Error ? error : new Error(String(error));
    terminateChild(run);
  }
}

function finishPromptWrite(run, error) {
  if (error) {
    recordPromptTransportError(run, error);
  }
}

function sendPrompt(run) {
  if (run.prompt == null) {
    return;
  }
  if (!run.child.stdin) {
    recordPromptTransportError(run, new Error("Grok stdin is unavailable for prompt transport."));
    return;
  }
  run.child.stdin.once("error", (error) => recordPromptTransportError(run, error));
  run.child.stdin.end(run.prompt, "utf8", (error) => finishPromptWrite(run, error));
}

function failSandboxHandshake(run, reason) {
  if (!run.securityFailure) {
    run.securityFailure = { kind: "sandbox", line: reason };
  }
  terminateChild(run);
}

function pollSandboxHandshake(run) {
  if (run.settled || run.sandboxVerified || run.securityFailure) {
    return;
  }
  let evidence;
  try {
    evidence = inspectSandboxStartupEvidence(run.sandboxLogSnapshot, run.expectedSandbox);
  } catch (error) {
    failSandboxHandshake(run, error instanceof Error ? error.message : String(error));
    return;
  }
  if (evidence.status === "verified") {
    run.sandboxVerified = true;
    sendPrompt(run);
    return;
  }
  if (evidence.status === "failed") {
    failSandboxHandshake(run, evidence.reason);
    return;
  }
  if (Date.now() >= run.sandboxDeadline) {
    failSandboxHandshake(run, "Grok did not publish verified sandbox startup evidence before the handshake deadline.");
    return;
  }
  run.sandboxPollTimer = setTimeout(() => pollSandboxHandshake(run), SANDBOX_HANDSHAKE_POLL_MS);
  run.sandboxPollTimer.unref?.();
}

function appendFilteredStderrLog(run, chunk = "", flush = false) {
  run.stderrLogRemainder += chunk.toString();
  const boundary = flush ? run.stderrLogRemainder.length : run.stderrLogRemainder.lastIndexOf("\n") + 1;
  if (boundary === 0) {
    if (Buffer.byteLength(run.stderrLogRemainder) > STDERR_CAPTURE_MAX_BYTES) {
      appendJobLog(run.options.logFile, run.stderrLogRemainder);
      run.stderrLogRemainder = "";
    }
    return;
  }
  const complete = run.stderrLogRemainder.slice(0, boundary);
  run.stderrLogRemainder = run.stderrLogRemainder.slice(boundary);
  let filtered = "";
  let offset = 0;
  while (offset < complete.length) {
    const newline = complete.indexOf("\n", offset);
    const end = newline === -1 ? complete.length : newline + 1;
    const line = complete.slice(offset, end);
    if (!TOOL_POLICY_APPLIED_PATTERN.test(line)) {
      filtered += line;
    }
    offset = end;
  }
  if (filtered) {
    appendJobLog(run.options.logFile, filtered);
  }
}

function observeGrokStdout(run, chunk) {
  run.stdoutTailBuffer = appendBounded(run.stdoutTailBuffer, chunk, STDOUT_TAIL_MAX_BYTES);
  if (run.supervisionError) {
    return;
  }
  if (run.stdoutSpool.bytes + chunk.length > STDOUT_CAPTURE_MAX_BYTES) {
    run.supervisionError = new Error(`Grok stdout exceeded the ${STDOUT_CAPTURE_MAX_BYTES}-byte capture limit.`);
    run.supervisionError.failureKind = "transport";
    terminateChild(run);
    return;
  }
  try {
    appendStdoutSpool(run.stdoutSpool, chunk);
  } catch (error) {
    run.supervisionError = error;
    run.supervisionError.failureKind ??= "transport";
    terminateChild(run);
  }
}

function observeGrokStderr(run, chunk) {
  const securityWindow = `${run.securityScanRemainder}${chunk.toString()}`;
  run.securityScanRemainder = securityWindow.slice(-512);
  run.stderr = appendBounded(run.stderr, chunk, STDERR_CAPTURE_MAX_BYTES);
  if (!run.policyApplied && toolPolicyApplied(securityWindow)) {
    run.policyApplied = true;
  }
  const detectedSecurityFailure = run.securityFailure ?? findSecurityFailure(securityWindow);
  if (!run.securityFailure && detectedSecurityFailure) {
    run.securityFailure = detectedSecurityFailure;
    terminateChild(run);
  }
  if (!run.supervisionError) {
    try {
      appendFilteredStderrLog(run, chunk);
    } catch (error) {
      run.supervisionError = error;
      terminateChild(run);
    }
  }
}

async function closeGrokChild(run, code, signal) {
  if (run.settled) {
    return;
  }
  if (run.managedRun && !run.sandboxVerified && !run.securityFailure) {
    run.securityFailure = {
      kind: "sandbox",
      line: "Grok exited before publishing verified sandbox startup evidence."
    };
  }
  if (run.managedRun && run.sandboxVerified && !run.policyApplied && !run.securityFailure) {
    run.securityFailure = {
      kind: "policy",
      line: "Grok exited without confirming that the requested tool allowlist was applied."
    };
  }
  if (!run.supervisionError) {
    try {
      appendFilteredStderrLog(run, "", true);
    } catch (error) {
      run.supervisionError = error;
    }
  }
  cleanup(run);
  if (run.terminationPromise && !(await run.terminationPromise)) {
    finishReject(run, cleanupFailure(run));
    return;
  }
  if (!run.terminationPromise && Number.isInteger(run.child.pid) && run.child.pid > 1) {
    const cleaned = await terminateExitedLeaderProcessGroup(run.child.pid, run.childIdentity,
      run.managedRun ? { graceMs: cleanupGraceMs(run.deadline) } : {}).catch(terminationFailed);
    if (!cleaned) {
      finishReject(run, cleanupFailure(run, { residual: true }));
      return;
    }
  }
  if (run.supervisionError) {
    finishReject(run, run.supervisionError);
    return;
  }
  let stdout;
  try {
    stdout = readStdoutSpool(run.stdoutSpool);
  } catch (error) {
    error.failureKind ??= "transport";
    finishReject(run, error);
    return;
  } finally {
    removeStdoutSpool(run.stdoutSpool);
  }
  const parsed = parseGrokOutput(stdout);
  const exitCode = code ?? exitCodeFromSignal(signal);
  const turnLimitReached = MAX_TURNS_REACHED_PATTERN.test(run.stderr) || maxTurnsReachedEvent(stdout);
  const envelopeShapeIsValid = isGrokEnvelope(parsed);
  const reportedSessionValue = parsed?.sessionId ?? parsed?.session_id;
  const sessionId = normalizeGrokSessionId(reportedSessionValue);
  const invalidSessionId =
    envelopeShapeIsValid &&
    reportedSessionValue !== undefined &&
    reportedSessionValue !== null &&
    reportedSessionValue !== "" &&
    !sessionId;
  const validEnvelope = envelopeShapeIsValid && !invalidSessionId;
  const structuredErrorMessage =
    parsed?.type === "error" && typeof parsed.message === "string" && parsed.message.trim()
      ? parsed.message.trim()
      : null;
  const stderrError = exitCode !== 0 ? internalErrorFromStderr(run.stderr) : null;
  const terminalErrorMessage = structuredErrorMessage && !/^Internal error:\s*\{$/i.test(structuredErrorMessage)
    ? structuredErrorMessage
    : stderrError?.message ?? structuredErrorMessage;
  if (stderrError?.httpStatus != null) {
    appendJobLog(run.options.logFile, `HTTP ${stderrError.httpStatus}`);
  }
  const recognizedEnvelope = envelopeShapeIsValid || structuredErrorMessage != null;
  const metrics = recognizedEnvelope ? headlessMetricsObservation(parsed) : { error: null };
  const resolved = resolvedOutputMetadata(parsed, run.options.cwd, run.childEnv);
  const errorMessage = run.securityFailure?.kind === "sandbox"
    ? `Grok sandbox enforcement failed; refusing the result: ${run.securityFailure.line}`
    : run.securityFailure?.kind === "policy"
      ? `Grok tool policy enforcement failed; refusing the result: ${run.securityFailure.line}`
    : run.securityFailure?.kind === "auth"
      ? AUTH_RETRY_FAILURE_MESSAGE
    : run.promptTransportError
      ? `Grok prompt transport failed before stdin was accepted: ${run.promptTransportError.message}`
      : terminalErrorMessage ?? maxTurnsReachedError(run.stderr);
  const parseError = metrics.error ?? (
    exitCode === 0 && !run.timedOut && !errorMessage && expectsJsonOutput(run.args) && !validEnvelope
      ? invalidSessionId
        ? "Grok returned an invalid session identifier in its JSON envelope."
        : "Grok did not return a valid JSON envelope for --output-format json."
      : null
  );
  const stopReason = validEnvelope ? parsed.stopReason : null;
  const blockedPermissionCall =
    normalizeStopReason(stopReason) === "cancelled" ? extractBlockedPermissionCall(stdout, validEnvelope ? parsed : null) : null;
  const deniedToolFromStderr = extractDeniedToolFromStderr(run.stderr);
  const structuredOutput = parsed && Object.hasOwn(parsed, "structuredOutput") ? parsed.structuredOutput : undefined;
  const structuredOutputError = parsed && Object.hasOwn(parsed, "structuredOutputError")
    ? parsed.structuredOutputError
    : structuredOutput !== undefined
      ? null
      : undefined;
  run.settled = true;
  run.resolve({
    text: validEnvelope ? parsed.text : stdoutTail(stdout),
    sessionId: validEnvelope ? sessionId : null,
    requestId: recognizedEnvelope ? stringField(parsed, "requestId", "request_id") : null,
    stopReason,
    thought: validEnvelope ? stringField(parsed, "thought") : null,
    usage: objectField(parsed, "usage"),
    modelUsage: objectField(parsed, "modelUsage", "model_usage"),
    numTurns: metrics.numTurns ?? null,
    totalCostUsd: metrics.totalCostUsd ?? null,
    totalCostUsdTicks: metrics.totalCostUsdTicks ?? null,
    costIsPartial: metrics.costIsPartial ?? null,
    resolvedModel: resolved.model,
    resolvedEffort: resolved.effort,
    usageIsIncomplete: metrics.usageIsIncomplete ?? null,
    structuredOutput,
    structuredOutputError,
    errorMessage,
    securityFailureKind: run.securityFailure?.kind ?? null,
    hasJsonEnvelope: validEnvelope,
    exitCode,
    timedOut: run.timedOut,
    turnLimitReached,
    parseError,
    stdoutTail: stdoutTail(run.stdoutTailBuffer),
    stderrTail: stdoutTail(run.stderr),
    cancelledByCompanion: run.cancelledByCompanion,
    promptTransportError: Boolean(run.promptTransportError),
    blockedPermissionCall,
    deniedToolFromStderr
  });
}

function startGrokRun(run, resolve, reject) {
  run.resolve = resolve;
  run.reject = reject;
  if (deadlineRemaining(run.deadline) <= 0) {
    removeStdoutSpool(run.stdoutSpool);
    removeManagedRunTempDir(run.managedTempDir);
    reject(runTimeoutError());
    return;
  }
  try {
    if (typeof run.options.launchProcess === "function") {
      const launched = run.options.launchProcess(() => spawnChild(run));
      run.child = launched?.child ?? run.child;
      run.childIdentity = launched?.identity ?? run.childIdentity;
    } else {
      const launched = spawnChild(run);
      const publication = run.options.onSpawn?.(launched.pid, launched.identity);
      if (publication?.status && publication.status !== "running") {
        const error = new Error(`Grok process ownership could not be recorded because job ${publication.id ?? "unknown"} is already ${publication.status}.`);
        error.failureKind = publication.failureKind ?? (publication.status === "cancelled" ? "cancelled" : "error");
        throw error;
      }
    }
  } catch (error) {
    run.launchError = error;
  }
  if (!run.child) {
    removeStdoutSpool(run.stdoutSpool);
    removeManagedRunTempDir(run.managedTempDir);
    reject(run.launchError ?? new Error("Grok process launch did not create a child process."));
    return;
  }

  run.forwardTermination = () => forwardTermination(run);
  process.once("SIGTERM", run.forwardTermination);
  process.once("SIGINT", run.forwardTermination);
  run.timer = setTimeout(() => expireGrokRun(run), run.managedRun
    ? Math.max(0, deadlineRemaining(run.deadline) - MANAGED_CLEANUP_RESERVE_MS) : run.timeoutMs);
  run.timer.unref?.();

  run.sandboxDeadline = Math.min(Date.now() + sandboxHandshakeTimeoutMs(run.env), run.deadline ?? Infinity);
  run.child.stdout.on("data", (chunk) => observeGrokStdout(run, chunk));
  run.child.stderr.on("data", (chunk) => observeGrokStderr(run, chunk));
  run.child.on("error", (error) => finishReject(run, error));
  run.child.on("close", (code, signal) => closeGrokChild(run, code, signal));

  if (run.launchError) {
    run.supervisionError = run.launchError;
    terminateChild(run);
  } else if (run.managedRun) {
    pollSandboxHandshake(run);
  } else {
    sendPrompt(run);
  }
}

async function finishGrokResult(run, result) {
  const failed = result.exitCode !== 0 || result.timedOut || Boolean(result.errorMessage || result.parseError);
  const authEvidence = [result.stderrTail, result.errorMessage].filter(Boolean).join("\n");
  const authFailure = result.securityFailureKind === "auth" || (
    failed && !result.securityFailureKind && !result.timedOut && !result.parseError && !result.cancelledByCompanion &&
    /auth|unauthori[sz]ed|forbidden|login required/i.test(authEvidence) &&
    !/getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|quota|balance|billing|payment required|\b402\b|rate.?limit|\b429\b/i.test(authEvidence)
  );
  if (!run.managedRun || !authFailure) {
    return { ...result, ...(run.authRefresh ? { authRefresh: run.authRefresh } : {}), ...(run.options.authRetry ? { authRetry: true } : {}) };
  }
  if (deadlineRemaining(run.deadline) <= 0) {
    return { ...result, timedOut: true, ...(run.authRefresh ? { authRefresh: run.authRefresh } : {}) };
  }
  if (!run.authRefresh && !run.options.authRetry) {
    run.authRefresh = refreshGrokAuth({ bin: run.bin, env: run.childEnv, cwd: run.options.cwd, capabilities: run.capabilities, reason: "auth-failure", deadline: run.deadline });
    if (run.authRefresh.refreshed && (result.securityFailureKind === "auth" || run.options.mode !== "write")) {
      const retry = await runGrok({ ...run.options, authRefresh: run.authRefresh, authRetry: true, managedDeadline: run.deadline });
      if (retry.exitCode === 0 && !retry.timedOut && !retry.errorMessage && !retry.parseError) {
        return retry;
      }
      result = retry;
    }
  }
  return {
    ...result,
    securityFailureKind: "auth",
    errorMessage: `${AUTH_RETRY_FAILURE_MESSAGE} ${AUTH_REFRESH_FAILURE_MESSAGE}`,
    authRefresh: run.authRefresh,
    ...(run.options.authRetry || result.authRetry ? { authRetry: true } : {})
  };
}

export function runGrok(options) {
  const startedAt = Date.now();
  const env = resolveGrokAuthPaths(options.env ?? process.env, options.cwd ?? process.cwd());
  const bin = options.bin ?? resolveGrokBin(env);
  const timeoutMs = options.timeoutMs ?? resolveTimeoutMs({ background: Boolean(options.background), env });
  const managedRun = !options.args;
  const deadline = managedRun ? options.managedDeadline ?? startedAt + timeoutMs : null;
  requireDeadline(deadline);
  const requestedMode = options.mode === "write" ? "write" : "consult";
  let capabilities = null;
  if (managedRun) {
    const required = ["--prompt-file", "--output-format", "--sandbox", "--tools", "--disallowed-tools", "--deny", "--max-turns", "--no-auto-update", "--no-wait-for-background"];
    if (requestedMode === "consult") {
      required.push("--permission-mode", "--allow");
    } else {
      required.push("--always-approve");
    }
    if (options.web !== true) {
      required.push("--disable-web-search");
    }
    if (options.jsonSchema) {
      required.push("--json-schema");
    }
    capabilities = resolveGrokCapabilities(bin, env, deadline, options.cwd ?? process.cwd(), required);
    requireGrokCapabilities(capabilities, required);
    preflightRuntimeSocketEndpoints({
      candidates: options.runtimeSocketEndpoints ?? runtimeSocketEndpoints({ env }),
      lstat: options.runtimeSocketLstat ?? fs.lstatSync
    });
    if (requestedMode === "write") {
      let sockets;
      try {
        sockets = existingUnixSockets(undeniedRuntimeSocketCandidates(env));
      } catch (error) {
        throw securityError("sandbox", `Unable to inspect undenied Grok runtime sockets: ${error.message}`);
      }
      if (sockets.length > 0) {
        throw securityError("sandbox", `Grok's strict runtime-socket deny list does not cover ${sockets[0]}, so a write shell could drive that container engine and write outside the workspace. ${undeniedRuntimeSocketRemedy()}`);
      }
    }
    requireDeadline(deadline);
  }
  const args = options.args ?? buildGrokArgs({ ...options, capabilities, timeoutMs });
  const childEnv = buildGrokChildEnv(env, { memory: options.memory === true, web: options.web === true });
  const captureProcessIdentity = options.captureProcessIdentity ?? getProcessIdentity;
  let prompt = typeof options.prompt === "string" ? options.prompt : null;
  if (managedRun && prompt == null && options.briefFile) {
    prompt = fs.readFileSync(options.briefFile, "utf8");
  }
  if (managedRun && prompt == null) {
    throw capabilityError("A managed Grok run requires a prompt for /dev/stdin transport.");
  }
  let authRefresh = options.authRefresh ?? null;
  let managedTempDir = null;
  let sandboxLogSnapshot = null;
  let stdoutSpool = null;
  try {
    if (managedRun) {
      managedTempDir = createManagedRunTempDir();
      childEnv.TMPDIR = managedTempDir;
      if (!options.authRetry && !authRefresh) {
        const auth = grokAuthStatus(childEnv, options.cwd);
        const dataDir = resolveDataDir(env);
        if (auth.ageSeconds !== null && auth.stale && !staleRefreshRecentlyFailed(dataDir, auth.file)) {
          authRefresh = refreshGrokAuth({ bin, env: childEnv, cwd: options.cwd, capabilities, reason: "stale", deadline });
          const outcome = authRefresh.refreshed ? "refreshed" : "failed";
          writePrivateDataFile(dataDir, AUTH_REFRESH_ATTEMPT_FILE, `${JSON.stringify({ file: auth.file, ...authRefresh, outcome })}\n`);
          requireDeadline(deadline);
        }
      }
      sandboxLogSnapshot = captureSandboxEventLog(resolveChildGrokHome(childEnv, options.cwd));
    }
    requireDeadline(deadline);
    stdoutSpool = createStdoutSpool();
    requireDeadline(deadline);
  } catch (error) {
    removeManagedRunTempDir(managedTempDir);
    if (stdoutSpool) {
      removeStdoutSpool(stdoutSpool);
    }
    throw error;
  }
  const requestedSandboxProfile = sandboxProfileForMode(requestedMode);
  const expectedSandbox = managedRun
    ? {
        workspace: normalizedFilesystemPath(path.resolve(options.cwd)),
        profile: requestedSandboxProfile,
        restrictNetwork: requestedSandboxProfile !== "workspace",
        tempDir: managedTempDir
      }
    : null;

  const run = {
    options, env, bin, timeoutMs, managedRun, deadline, capabilities, args, childEnv,
    captureProcessIdentity, prompt, authRefresh, managedTempDir, sandboxLogSnapshot,
    stdoutSpool, expectedSandbox,
    resolve: null, reject: null,
    child: null, childIdentity: null, launchError: null,
    stdoutTailBuffer: "", stderr: "", securityScanRemainder: "", stderrLogRemainder: "",
    securityFailure: null, promptTransportError: null, supervisionError: null,
    terminationPromise: null, timedOut: false, cancelledByCompanion: false, settled: false,
    timer: null, sandboxPollTimer: null, sandboxDeadline: null, forwardTermination: null,
    sandboxVerified: !managedRun, policyApplied: !managedRun
  };
  return new Promise((resolve, reject) => startGrokRun(run, resolve, reject))
    .then((result) => finishGrokResult(run, result));
}
