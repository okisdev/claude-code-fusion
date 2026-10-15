import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveGrokBin } from "../grok-exec.mjs";
import { output, errorWithFailure, oneLineSummary, commandArgs } from "./base.mjs";
import { inputError } from "./session.mjs";
import { classifyFailure } from "./execution.mjs";

function modelsChildEnv() {
  const env = { ...process.env };
  const authKeys = new Set(["XAI_API_KEY", "GROK_CODE_XAI_API_KEY", "GROK_AUTH", "GROK_AUTH_PATH", "GROK_AUTH_PROVIDER_COMMAND", "GROK_AUTH_PROVIDER_LABEL", "GROK_AUTH_TOKEN_TTL", "GROK_AUTH_EARLY_INVALIDATION_SECS", "GROK_DISABLE_API_KEY_AUTH", "GROK_LOCAL_AUTH"]);
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_") || key.startsWith("CLAUDE_PLUGIN_") || key.startsWith("GROK_COMPANION_") || (!authKeys.has(key) && (/(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|AUTH|COOKIE)(?:_|$)/i.test(key) || /(?:^|_)(?:DATABASE_URL|DB_URL|POSTGRES(?:QL)?_URL|MYSQL_URL|MARIADB_URL|MONGO(?:DB)?(?:_URI|_URL)|REDIS_URL|VALKEY_URL|AMQP_URL|RABBITMQ_URL|KAFKA_URL|ELASTICSEARCH_URL|OPENSEARCH_URL|CLICKHOUSE_URL|SNOWFLAKE_URL|SENTRY_DSN|DSN|CONNECTION_STRING)(?:_|$)/i.test(key) || ["DOCKER_AUTH_CONFIG", "GPG_AGENT_INFO", "KUBECONFIG", "SSH_AUTH_SOCK"].includes(key)))) {
      delete env[key];
    }
  }
  for (const key of ["GROK_CLAUDE_MARKER_OVERRIDE", "_GROK_CLAUDE_MARKER_OVERRIDE", "GROK_TEST_VERSION", "GROK_SANDBOX", "GROK_LEADER_SOCKET", "GROK_FILE_ACCELERATION_ROUTES", "GROK_SANDBOX_MODE", "GROK_ARTIFACTS_BIND_REMOUNT", "GROK_CURSOR_WORKER_API_BASE", "GROK_CURSOR_WORKER_COMMAND", "GROK_SUBAGENTS_MAX_DEPTH", "GROK_WEB_FETCH_PROXY", "GROK_WEB_FETCH_ALLOW_LOCAL"]) {
    delete env[key];
  }
  env.GROK_AUTO_WAKE = "false";
  env.GROK_TURN_SUMMARY = "false";
  env.GROK_FILE_ACCELERATION = "false";
  env.RUST_LOG = "xai_grok_agent::builder=debug,xai_grok_sandbox=warn,xai_grok_shell::session::acp_session::turn=warn";
  env.GROK_DISABLE_AUTOUPDATER = "1";
  env.GROK_MANAGED_MCPS_ENABLED = "false";
  env.GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED = "false";
  env.GROK_WEB_FETCH = "0";
  env.GROK_MEMORY = "0";
  env.GROK_SUBAGENTS = "0";
  for (const engine of ["CLAUDE", "CURSOR", "CODEX"]) {
    for (const feature of ["SKILLS", "RULES", "AGENTS", "MCPS", "HOOKS", "SESSIONS"]) {
      env[`GROK_${engine}_${feature}_ENABLED`] = "false";
    }
  }
  return env;
}

function parseGrokModels(text) {
  const models = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || /^(?:available models:|default model:|you are logged in|\d{4}-\d{2}-\d{2}T)/i.test(line)) {
      continue;
    }
    line = line.replace(/^(?:[-*•])\s+/, "").replace(/\s+\(default\)$/i, "");
    let columns;
    if (line.includes("|")) {
      columns = line.split("|").map((part) => part.trim()).filter(Boolean);
    } else if (/\s{2,}/.test(line)) {
      columns = line.split(/\s{2,}/);
    } else {
      columns = line.split(/\s+-\s+/, 2);
    }
    const id = columns[0];
    if (!id || /^(?:model|model id|id|name|display name)$/i.test(id) || !/^[a-z0-9][a-z0-9._\/-]*$/i.test(id)) {
      continue;
    }
    const displayName = columns[1] && !/^[-:]+$/.test(columns[1]) ? columns[1] : null;
    if (!models.has(id) || (!models.get(id).displayName && displayName)) {
      models.set(id, { id, displayName });
    }
  }
  return [...models.values()];
}

function handleModels(argv, transport = {}) {
  const { options, positionals, positionalText } = commandArgs(argv, { booleanOptions: ["json"] }, transport);
  if (positionals.length || positionalText) {
    throw inputError("The models command accepts only --json.");
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-companion-models-"));
  let result;
  try {
    result = spawnSync(resolveGrokBin(), ["models"], { cwd: tempDir, env: { ...modelsChildEnv(), TMPDIR: tempDir }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (result.error || result.status !== 0) {
    const diagnostic = String(result.stderr || result.stdout || result.error?.message || `Grok exited with code ${result.status ?? 1}.`).trim();
    const classified = classifyFailure({ spawnError: result.error, result: { exitCode: result.status, errorMessage: diagnostic, stderrTail: result.stderr, stdoutTail: result.stdout }, logTail: diagnostic });
    const failureKind = /unrecognized subcommand|unknown subcommand|unexpected argument.*models/i.test(diagnostic) ? "setup" : /not logged in|\b401\b/i.test(diagnostic) ? "auth" : ["missing_cli", "auth", "setup"].includes(classified) ? classified : "error";
    throw errorWithFailure(`Could not list Grok models: ${oneLineSummary(diagnostic)}`, failureKind);
  }
  const models = parseGrokModels(result.stdout);
  if (!models.length) {
    throw errorWithFailure("Could not parse the grok models listing.", "error");
  }
  output(options.json ? { engine: "grok", models, source: "grok models" } : `${models.map((model) => model.id).join("\n")}\n`, Boolean(options.json));
}

export { handleModels };
