import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  getProcessIdentity,
  processIdentitiesMatch,
  processIdentityMatches,
  processIsDirectlyAlive,
  validProcessIdentity
} from "./process-identity.mjs";
import { appendJobLog } from "./state.mjs";

const BIN_ENV = "GROK_BIN";
const TIMEOUT_ENV = "GROK_COMPANION_TIMEOUT_MS";
const PIDLESS_RUNNING_GRACE_ENV = "GROK_COMPANION_PIDLESS_RUNNING_GRACE_MS";
const CONSULT_ALLOW_ENV = "GROK_CONSULT_ALLOW";
const CAPABILITIES_ENV = "GROK_COMPANION_CAPABILITIES";
const DEFAULT_FOREGROUND_TIMEOUT_MS = 570000;
const BACKGROUND_TIMEOUT_CAP_MS = 1800000;
const DEFAULT_PIDLESS_RUNNING_GRACE_MS = 15000;
const TERMINATION_GRACE_MS = 2000;
const TERMINATION_POLL_MS = 50;
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
const GROK_BUILDER_LOG_FILTER = "xai_grok_agent::builder=debug,xai_grok_sandbox=warn";
const USD_TICKS = 10_000_000_000;
const STDIN_PROMPT_FILE = "/dev/stdin";
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITY_PATTERN = /--[a-z0-9][a-z0-9-]*/gi;

const capabilityCache = new Map();

export function normalizeGrokSessionId(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return SESSION_ID_PATTERN.test(normalized) ? normalized.toLowerCase() : null;
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

export function resolvePidlessRunningGraceMs(env = process.env) {
  const raw = Number(env[PIDLESS_RUNNING_GRACE_ENV]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_PIDLESS_RUNNING_GRACE_MS;
}

export function sandboxProfileForMode(mode) {
  return "strict";
}

export function resolveConsultAllowRules(env = process.env) {
  const raw = env[CONSULT_ALLOW_ENV];
  if (raw == null || !String(raw).trim()) {
    return [];
  }
  return String(raw)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^(?:Read|Grep|WebSearch|WebFetch)(?:\([^(),\r\n]*\))?$/.test(entry));
}

export function buildGrokChildEnv(env = process.env, { memory = false } = {}) {
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
  childEnv.RUST_LOG = GROK_BUILDER_LOG_FILTER;
  childEnv.GROK_DISABLE_AUTOUPDATER = "1";
  childEnv.GROK_MANAGED_MCPS_ENABLED = "false";
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

export function resolveGrokCapabilities(bin, env = process.env) {
  if (Object.hasOwn(env, CAPABILITIES_ENV)) {
    return parseCapabilityList(env[CAPABILITIES_ENV]);
  }
  if (capabilityCache.has(bin)) {
    return capabilityCache.get(bin);
  }
  const probeEnv = buildGrokChildEnv(env);
  const probeOptions = {
    encoding: "utf8",
    env: probeEnv,
    timeout: 5000,
    maxBuffer: 2 * 1024 * 1024
  };
  const probe = spawnSync(bin, ["--help"], probeOptions);
  if (probe.error) {
    throw capabilityError(`Unable to inspect Grok CLI capabilities: ${probe.error.message}`);
  }
  if (probe.status !== 0) {
    const detail = String(probe.stderr || probe.stdout || "").trim().slice(-1024);
    throw capabilityError(`Unable to inspect Grok CLI capabilities with --help${detail ? `: ${detail}` : "."}`);
  }
  const capabilities = new Set(`${probe.stdout ?? ""}\n${probe.stderr ?? ""}`.match(CAPABILITY_PATTERN) ?? []);
  for (const [flag, probeArgs] of [
    ["--no-wait-for-background", ["--no-wait-for-background", "--help"]],
    ["--no-auto-update", ["--no-auto-update", "--help"]]
  ]) {
    if (!capabilities.has(flag) && spawnSync(bin, probeArgs, probeOptions).status === 0) {
      capabilities.add(flag);
    }
  }
  capabilityCache.set(bin, capabilities);
  return capabilities;
}

function requireGrokCapabilities(capabilities, flags) {
  const missing = flags.filter((flag) => !capabilities.has(flag));
  if (missing.length > 0) {
    throw capabilityError(`The installed Grok CLI is missing required safety capabilities: ${missing.join(", ")}. Upgrade Grok before running this task.`);
  }
}

export function buildGrokArgs(options) {
  const mode = options.mode === "write" ? "write" : "consult";
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS[mode];
  const capabilities = options.capabilities ?? null;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const supports = (flag) => capabilities == null || capabilities.has(flag);
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
  if (supports("--no-auto-update")) {
    args.push("--no-auto-update");
  }
  if (supports("--no-subagents")) {
    args.push("--no-subagents");
  }
  if (supports("--no-wait-for-background")) {
    args.push("--no-wait-for-background");
  }
  if (!options.web) {
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
    if (!supports("--json-schema")) {
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
      [...CONSULT_TOOL_IDS, ...(options.web ? CONSULT_WEB_TOOL_IDS : [])].join(","),
      "--disallowed-tools",
      disallowedTools.join(",")
    );
    for (const rule of CONSULT_ALLOW_RULES) {
      args.push("--allow", rule);
    }
    if (options.web) {
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
      [...WRITE_TOOL_IDS, ...(options.web ? CONSULT_WEB_TOOL_IDS : [])].join(","),
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

export function parseGrokOutput(stdout) {
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

export function extractBlockedPermissionCall(stdout, envelope = null) {
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
  return toolPolicy ? { kind: "policy", line: toolPolicy } : null;
}

function toolPolicyApplied(stderr) {
  return TOOL_POLICY_APPLIED_PATTERN.test(String(stderr ?? ""));
}

function securityError(kind, message) {
  const error = new Error(message);
  error.failureKind = kind;
  return error;
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
  const file = path.join(grokHome, "sandbox-events.jsonl");
  try {
    const opened = openSandboxEventLog(file);
    try {
      const markerLength = Math.min(opened.stats.size, SANDBOX_EVENT_MARKER_MAX_BYTES);
      const marker = Buffer.alloc(markerLength);
      let markerOffset = 0;
      while (markerOffset < marker.length) {
        const read = fs.readSync(
          opened.descriptor,
          marker,
          markerOffset,
          marker.length - markerOffset,
          opened.stats.size - marker.length + markerOffset
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
        marker
      };
    } finally {
      fs.closeSync(opened.descriptor);
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { file, identity: null, offset: 0, marker: Buffer.alloc(0) };
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
        snapshot.offset - marker.length
      );
      if (read !== marker.length || !marker.equals(snapshot.marker)) {
        throw securityError("sandbox", "The Grok sandbox event log was truncated or rewritten during startup.");
      }
    }
    const length = opened.stats.size - snapshot.offset;
    if (length === 0) {
      return null;
    }
    if (length > SANDBOX_EVENT_DELTA_MAX_BYTES) {
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
    return bytes.toString("utf8");
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
  const complete = delta.endsWith("\n");
  const lines = delta.split(/\r?\n/);
  if (!complete) {
    lines.pop();
  }
  for (const line of lines) {
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

function booleanField(value, ...keys) {
  for (const key of keys) {
    if (typeof value?.[key] === "boolean") {
      return value[key];
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
  const complete = Object.keys(usage).length === 5;
  if (Object.keys(usage).length === 0) {
    return { error: "Grok returned an empty usage object in its JSON envelope." };
  }
  if (usage.reasoning != null && usage.output != null && usage.reasoning > usage.output) {
    return { error: "Grok returned usage.reasoning_tokens greater than usage.output_tokens in its JSON envelope." };
  }
  if (complete && BigInt(usage.input) + BigInt(usage.cacheRead) + BigInt(usage.output) !== BigInt(usage.total)) {
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

export function resolvedOutputMetadata(parsed, cwd, env = process.env) {
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

function signalProcessGroup(pid, signal, identity = null, options = {}) {
  const allowExitedLeader = options.allowExitedLeader === true;
  const fallbackToPid = options.fallbackToPid !== false;
  const kill = options.kill ?? process.kill.bind(process);
  const canSignal = () => identity == null || processIdentityMatches(pid, identity) || (allowExitedLeader && !processIsDirectlyAlive(pid));
  if (!Number.isInteger(pid) || pid <= 1 || !canSignal()) {
    return false;
  }
  try {
    kill(-pid, signal);
    return true;
  } catch {
    if (!canSignal() || !fallbackToPid) {
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
  try {
    process.kill(-pid, 0);
    return true;
  } catch (groupError) {
    if (groupError?.code === "EPERM") {
      return true;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (pidError) {
      if (pidError?.code === "EPERM") {
        return true;
      }
      return false;
    }
  }
}

function exitedLeaderProcessGroupAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
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
  const targetAlive = () => exitedLeaderProcessGroupAlive(pid, kill);
  const signalGroup = (signal) => signalProcessGroup(pid, signal, identity, {
    allowExitedLeader: true,
    fallbackToPid: false,
    kill
  });
  if (!targetAlive()) {
    return true;
  }
  if (!signalGroup("SIGTERM")) {
    return !targetAlive();
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!targetAlive()) {
      return true;
    }
    await waitMs(pollMs);
  }
  if (targetAlive() && !signalGroup("SIGKILL")) {
    return !targetAlive();
  }
  while (Date.now() < deadline + graceMs) {
    if (!targetAlive()) {
      return true;
    }
    await waitMs(pollMs);
  }
  return !targetAlive();
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
    if (identity == null) {
      return "legacy";
    }
    if (!validProcessIdentity(identity)) {
      return "unverified";
    }
    return processIdentityMatches(pid, identity) ? "owned" : "replaced";
  }
  if (processIsDirectlyAlive(pid) || processGroupAlive(pid)) {
    return identity == null ? "legacy" : "unverified";
  }
  return "absent";
}

export function recordedProcessTargets(record) {
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
    return previous;
  }
  for (let attempt = 0; attempt < retries; attempt += 1) {
    waitSync(intervalMs);
    const current = capture(pid);
    if (!current) {
      return current;
    }
    if (processIdentitiesMatch(current, previous)) {
      return current;
    }
    previous = current;
  }
  return previous;
}

export function terminateProcessGroupSync(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  const graceMs = options.graceMs ?? TERMINATION_GRACE_MS;
  const pollMs = options.pollMs ?? TERMINATION_POLL_MS;
  const identity = options.identity ?? null;
  const targetAlive = () => {
    if (identity == null) {
      return processGroupAlive(pid);
    }
    const currentIdentity = getProcessIdentity(pid);
    if (currentIdentity) {
      return processIdentityMatches(pid, identity);
    }
    return processGroupAlive(pid);
  };
  if (!signalProcessGroup(pid, "SIGTERM", identity)) {
    return !targetAlive();
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!targetAlive()) {
      return true;
    }
    waitSync(pollMs);
  }
  if (options.gracefulOnly === true) {
    return !targetAlive();
  }
  if (targetAlive() && !signalProcessGroup(pid, "SIGKILL", identity)) {
    return !targetAlive();
  }
  while (Date.now() < deadline + graceMs) {
    if (!targetAlive()) {
      return true;
    }
    waitSync(pollMs);
  }
  return !targetAlive();
}

export async function terminateProcessGroup(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  const graceMs = options.graceMs ?? TERMINATION_GRACE_MS;
  const pollMs = options.pollMs ?? TERMINATION_POLL_MS;
  const identity = options.identity ?? null;
  const targetAlive = () => {
    if (identity == null) {
      return processGroupAlive(pid);
    }
    const currentIdentity = getProcessIdentity(pid);
    if (currentIdentity) {
      return processIdentityMatches(pid, identity);
    }
    return processGroupAlive(pid);
  };
  if (!signalProcessGroup(pid, "SIGTERM", identity)) {
    return !targetAlive();
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!targetAlive()) {
      return true;
    }
    await waitMs(pollMs);
  }
  if (options.gracefulOnly === true) {
    return !targetAlive();
  }
  if (targetAlive() && !signalProcessGroup(pid, "SIGKILL", identity)) {
    return !targetAlive();
  }
  while (Date.now() < deadline + graceMs) {
    if (!targetAlive()) {
      return true;
    }
    await waitMs(pollMs);
  }
  return !targetAlive();
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
      gracefulOnly: state === "legacy"
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
      gracefulOnly: state === "legacy"
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

export function runGrok(options) {
  const env = options.env ?? process.env;
  const bin = options.bin ?? resolveGrokBin(env);
  const timeoutMs = options.timeoutMs ?? resolveTimeoutMs({ background: Boolean(options.background), env });
  const managedRun = !options.args;
  const requestedMode = options.mode === "write" ? "write" : "consult";
  let capabilities = null;
  if (managedRun) {
    capabilities = resolveGrokCapabilities(bin, env);
    requireGrokCapabilities(capabilities, ["--prompt-file", "--output-format", "--sandbox", "--tools", "--disallowed-tools", "--deny", "--max-turns", "--no-auto-update"]);
    if (requestedMode === "consult") {
      requireGrokCapabilities(capabilities, ["--permission-mode", "--allow"]);
    } else {
      requireGrokCapabilities(capabilities, ["--always-approve"]);
    }
    if (!options.web) {
      requireGrokCapabilities(capabilities, ["--disable-web-search"]);
    }
    if (options.jsonSchema) {
      requireGrokCapabilities(capabilities, ["--json-schema"]);
    }
    requireGrokCapabilities(capabilities, ["--no-wait-for-background"]);
  }
  const args = options.args ?? buildGrokArgs({ ...options, capabilities, timeoutMs });
  const childEnv = buildGrokChildEnv(env, { memory: options.memory === true });
  const captureProcessIdentity = options.captureProcessIdentity ?? getProcessIdentity;
  let prompt = typeof options.prompt === "string" ? options.prompt : null;
  if (managedRun && prompt == null && options.briefFile) {
    prompt = fs.readFileSync(options.briefFile, "utf8");
  }
  if (managedRun && prompt == null) {
    throw capabilityError("A managed Grok run requires a prompt for /dev/stdin transport.");
  }
  let managedTempDir = null;
  let sandboxLogSnapshot = null;
  let stdoutSpool = null;
  try {
    if (managedRun) {
      managedTempDir = createManagedRunTempDir();
      childEnv.TMPDIR = managedTempDir;
      sandboxLogSnapshot = captureSandboxEventLog(resolveChildGrokHome(childEnv, options.cwd));
    }
    stdoutSpool = createStdoutSpool();
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

  return new Promise((resolve, reject) => {
    let child = null;
    let childIdentity = null;
    let launchError = null;
    const spawnChild = () => {
      child = spawn(bin, args, {
        cwd: options.cwd,
        env: childEnv,
        stdio: [prompt == null ? "ignore" : "pipe", "pipe", "pipe"],
        detached: true
      });
      childIdentity = Number.isInteger(child.pid) ? settleProcessIdentitySync(child.pid, captureProcessIdentity) : null;
      return { child, pid: child.pid ?? null, identity: childIdentity };
    };
    try {
      if (typeof options.launchProcess === "function") {
        const launched = options.launchProcess(spawnChild);
        child = launched?.child ?? child;
        childIdentity = launched?.identity ?? childIdentity;
      } else {
        const launched = spawnChild();
        const publication = options.onSpawn?.(launched.pid, launched.identity);
        if (publication?.status && publication.status !== "running") {
          const error = new Error(`Grok process ownership could not be recorded because job ${publication.id ?? "unknown"} is already ${publication.status}.`);
          error.failureKind = publication.failureKind ?? (publication.status === "cancelled" ? "cancelled" : "error");
          throw error;
        }
      }
    } catch (error) {
      launchError = error;
    }
    if (!child) {
      removeStdoutSpool(stdoutSpool);
      removeManagedRunTempDir(managedTempDir);
      reject(launchError ?? new Error("Grok process launch did not create a child process."));
      return;
    }

    let stdoutTailBuffer = "";
    let stderr = "";
    let securityScanRemainder = "";
    let stderrLogRemainder = "";
    let securityFailure = null;
    let promptTransportError = null;
    let supervisionError = null;
    let terminationPromise = null;
    let timedOut = false;
    let cancelledByCompanion = false;
    let settled = false;
    let timer = null;
    let sandboxPollTimer = null;
    let sandboxVerified = !managedRun;
    let policyApplied = !managedRun;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      if (sandboxPollTimer) {
        clearTimeout(sandboxPollTimer);
      }
      process.removeListener("SIGTERM", forwardTermination);
      process.removeListener("SIGINT", forwardTermination);
      removeManagedRunTempDir(managedTempDir);
      managedTempDir = null;
    };
    const cleanupFailure = ({ residual = false } = {}) => {
      const error = new Error(residual
        ? "Verified Grok process-group cleanup did not complete after the CLI exited."
        : "Verified Grok process cleanup did not complete after the run was aborted.");
      error.failureKind = timedOut ? "timeout" : cancelledByCompanion ? "cancelled" : supervisionError?.failureKind ?? "error";
      error.cleanupRequired = true;
      error.processRole = "grok";
      error.pid = child.pid ?? null;
      error.pidIdentity = residual ? null : childIdentity;
      return error;
    };
    const finishReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      removeStdoutSpool(stdoutSpool);
      reject(error);
    };
    const terminateChild = () => {
      if (!Number.isInteger(child.pid) || child.pid <= 1) {
        terminationPromise ??= Promise.resolve(true);
        return terminationPromise;
      }
      terminationPromise ??= terminateProcessGroup(
        child.pid,
        childIdentity ? { identity: childIdentity } : {}
      ).catch(() => false);
      void terminationPromise.then((cleaned) => {
        if (!cleaned) {
          finishReject(cleanupFailure());
        }
      });
      return terminationPromise;
    };
    const forwardTermination = () => {
      cancelledByCompanion = true;
      terminateChild();
    };
    process.once("SIGTERM", forwardTermination);
    process.once("SIGINT", forwardTermination);
    timer = setTimeout(() => {
      timedOut = true;
      terminateChild();
    }, timeoutMs);
    timer.unref?.();

    const recordPromptTransportError = (error) => {
      if (!promptTransportError) {
        promptTransportError = error instanceof Error ? error : new Error(String(error));
        terminateChild();
      }
    };
    const sendPrompt = () => {
      if (prompt == null) {
        return;
      }
      if (!child.stdin) {
        recordPromptTransportError(new Error("Grok stdin is unavailable for prompt transport."));
        return;
      }
      child.stdin.once("error", recordPromptTransportError);
      child.stdin.end(prompt, "utf8", (error) => {
        if (error) {
          recordPromptTransportError(error);
        }
      });
    };
    const failSandboxHandshake = (reason) => {
      if (!securityFailure) {
        securityFailure = { kind: "sandbox", line: reason };
      }
      terminateChild();
    };
    const sandboxDeadline = Date.now() + sandboxHandshakeTimeoutMs(env);
    const pollSandboxHandshake = () => {
      if (settled || sandboxVerified || securityFailure) {
        return;
      }
      let evidence;
      try {
        evidence = inspectSandboxStartupEvidence(sandboxLogSnapshot, expectedSandbox);
      } catch (error) {
        failSandboxHandshake(error instanceof Error ? error.message : String(error));
        return;
      }
      if (evidence.status === "verified") {
        sandboxVerified = true;
        sendPrompt();
        return;
      }
      if (evidence.status === "failed") {
        failSandboxHandshake(evidence.reason);
        return;
      }
      if (Date.now() >= sandboxDeadline) {
        failSandboxHandshake("Grok did not publish verified sandbox startup evidence before the handshake deadline.");
        return;
      }
      sandboxPollTimer = setTimeout(pollSandboxHandshake, SANDBOX_HANDSHAKE_POLL_MS);
      sandboxPollTimer.unref?.();
    };
    const appendFilteredStderrLog = (chunk = "", flush = false) => {
      stderrLogRemainder += chunk.toString();
      const boundary = flush ? stderrLogRemainder.length : stderrLogRemainder.lastIndexOf("\n") + 1;
      if (boundary === 0) {
        if (Buffer.byteLength(stderrLogRemainder) > STDERR_CAPTURE_MAX_BYTES) {
          appendJobLog(options.logFile, stderrLogRemainder);
          stderrLogRemainder = "";
        }
        return;
      }
      const complete = stderrLogRemainder.slice(0, boundary);
      stderrLogRemainder = stderrLogRemainder.slice(boundary);
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
        appendJobLog(options.logFile, filtered);
      }
    };

    child.stdout.on("data", (chunk) => {
      stdoutTailBuffer = appendBounded(stdoutTailBuffer, chunk, STDOUT_TAIL_MAX_BYTES);
      if (supervisionError) {
        return;
      }
      if (stdoutSpool.bytes + chunk.length > STDOUT_CAPTURE_MAX_BYTES) {
        supervisionError = new Error(`Grok stdout exceeded the ${STDOUT_CAPTURE_MAX_BYTES}-byte capture limit.`);
        supervisionError.failureKind = "transport";
        terminateChild();
        return;
      }
      try {
        appendStdoutSpool(stdoutSpool, chunk);
      } catch (error) {
        supervisionError = error;
        supervisionError.failureKind ??= "transport";
        terminateChild();
      }
    });
    child.stderr.on("data", (chunk) => {
      const securityWindow = `${securityScanRemainder}${chunk.toString()}`;
      securityScanRemainder = securityWindow.slice(-512);
      stderr = appendBounded(stderr, chunk, STDERR_CAPTURE_MAX_BYTES);
      if (!policyApplied && toolPolicyApplied(securityWindow)) {
        policyApplied = true;
      }
      const detectedSecurityFailure = securityFailure ?? findSecurityFailure(securityWindow);
      if (!securityFailure && detectedSecurityFailure) {
        securityFailure = detectedSecurityFailure;
        terminateChild();
      }
      if (!supervisionError) {
        try {
          appendFilteredStderrLog(chunk);
        } catch (error) {
          supervisionError = error;
          terminateChild();
        }
      }
    });
    child.on("error", (error) => {
      finishReject(error);
    });
    child.on("close", async (code, signal) => {
      if (settled) {
        return;
      }
      if (managedRun && !sandboxVerified && !securityFailure) {
        securityFailure = {
          kind: "sandbox",
          line: "Grok exited before publishing verified sandbox startup evidence."
        };
      }
      if (managedRun && sandboxVerified && !policyApplied && !securityFailure) {
        securityFailure = {
          kind: "policy",
          line: "Grok exited without confirming that the requested tool allowlist was applied."
        };
      }
      if (!supervisionError) {
        try {
          appendFilteredStderrLog("", true);
        } catch (error) {
          supervisionError = error;
        }
      }
      cleanup();
      if (terminationPromise && !(await terminationPromise)) {
        finishReject(cleanupFailure());
        return;
      }
      if (!terminationPromise && Number.isInteger(child.pid) && child.pid > 1) {
        const cleaned = await terminateExitedLeaderProcessGroup(child.pid, childIdentity).catch(() => false);
        if (!cleaned) {
          finishReject(cleanupFailure({ residual: true }));
          return;
        }
      }
      if (supervisionError) {
        finishReject(supervisionError);
        return;
      }
      let stdout;
      try {
        stdout = readStdoutSpool(stdoutSpool);
      } catch (error) {
        error.failureKind ??= "transport";
        finishReject(error);
        return;
      } finally {
        removeStdoutSpool(stdoutSpool);
      }
      const parsed = parseGrokOutput(stdout);
      const exitCode = code ?? exitCodeFromSignal(signal);
      const turnLimitReached = MAX_TURNS_REACHED_PATTERN.test(stderr) || maxTurnsReachedEvent(stdout);
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
      const recognizedEnvelope = envelopeShapeIsValid || structuredErrorMessage != null;
      const metrics = recognizedEnvelope ? headlessMetricsObservation(parsed) : { error: null };
      const resolved = resolvedOutputMetadata(parsed, options.cwd, childEnv);
      const errorMessage = securityFailure?.kind === "sandbox"
        ? `Grok sandbox enforcement failed; refusing the result: ${securityFailure.line}`
        : securityFailure?.kind === "policy"
          ? `Grok tool policy enforcement failed; refusing the result: ${securityFailure.line}`
        : promptTransportError
          ? `Grok prompt transport failed before stdin was accepted: ${promptTransportError.message}`
          : structuredErrorMessage ?? maxTurnsReachedError(stderr);
      const parseError = metrics.error ?? (
        exitCode === 0 && !timedOut && !errorMessage && expectsJsonOutput(args) && !validEnvelope
          ? invalidSessionId
            ? "Grok returned an invalid session identifier in its JSON envelope."
            : "Grok did not return a valid JSON envelope for --output-format json."
          : null
      );
      const stopReason = validEnvelope ? parsed.stopReason : null;
      const blockedPermissionCall =
        stopReason === "Cancelled" ? extractBlockedPermissionCall(stdout, validEnvelope ? parsed : null) : null;
      const structuredOutput = parsed && Object.hasOwn(parsed, "structuredOutput") ? parsed.structuredOutput : undefined;
      const structuredOutputError = parsed && Object.hasOwn(parsed, "structuredOutputError")
        ? parsed.structuredOutputError
        : structuredOutput !== undefined
          ? null
          : undefined;
      settled = true;
      resolve({
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
        securityFailureKind: securityFailure?.kind ?? null,
        exitCode,
        timedOut,
        turnLimitReached,
        parseError,
        stdoutTail: stdoutTail(stdoutTailBuffer),
        cancelledByCompanion,
        promptTransportError: Boolean(promptTransportError),
        blockedPermissionCall
      });
    });

    if (launchError) {
      supervisionError = launchError;
      terminateChild();
    } else if (managedRun) {
      pollSandboxHandshake();
    } else {
      sendPrompt();
    }
  });
}
