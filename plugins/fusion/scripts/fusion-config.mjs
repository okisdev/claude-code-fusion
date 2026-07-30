#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MODEL_TABLE_PLACEHOLDER,
  MODEL_ROUTING_SCHEMA_VERSION,
  MODEL_ROUTING_LANES,
  readModelRoutingFile,
  renderModelTable,
  resolveModelRoutingPath,
  validateId,
  validateLane,
  validateModelRoutingData
} from "./lib/model-table.mjs";
import {
  normalizePosture,
  POSTURE_ENV,
  POSTURE_VALUES,
  posturePath,
  readPostureFile,
  resolvePosture
} from "./lib/posture.mjs";
import { syncRulesToLive } from "./lib/rules-template.mjs";

class UsageError extends Error {}

const BOOLEAN_OPTIONS = new Set(["json", "yes"]);
const VALUE_OPTIONS = new Set(["intelligence", "taste", "cost", "lane", "notes"]);

function usage() {
  return [
    "Usage:",
    "  node scripts/fusion-config.mjs show [--json]",
    "  node scripts/fusion-config.mjs audit [--json]",
    "  node scripts/fusion-config.mjs rescore <id> --intelligence N --taste N --cost N [--lane L] [--notes S]",
    "  node scripts/fusion-config.mjs remove <id>",
    "  node scripts/fusion-config.mjs set-cost-profile <text>",
    "  node scripts/fusion-config.mjs set-posture <judgment|strict>",
    "  node scripts/fusion-config.mjs reset-defaults --yes"
  ].join("\n");
}

function parseCli(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    const equalsIndex = raw.indexOf("=");
    const name = equalsIndex === -1 ? raw : raw.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? null : raw.slice(equalsIndex + 1);
    if (BOOLEAN_OPTIONS.has(name)) {
      if (inlineValue != null) {
        throw new UsageError(`Option --${name} does not take a value.`);
      }
      options[name] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) {
      throw new UsageError(`Unknown option --${name}.`);
    }
    if (inlineValue != null) {
      options[name] = inlineValue;
      continue;
    }
    index += 1;
    if (index >= argv.length) {
      throw new UsageError(`Expected a value after --${name}.`);
    }
    options[name] = argv[index];
  }
  return { options, positionals };
}

function parseScore(value, flag) {
  if (!/^[1-5]$/.test(String(value))) {
    throw new UsageError(`Expected ${flag} to be an integer from 1 to 5.`);
  }
  return Number(value);
}

function requireId(value) {
  if (!validateId(value)) {
    throw new UsageError("Expected a non-empty model or lane id.");
  }
  return value.trim();
}

function ensureOnlyOptions(options, allowed, command) {
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new UsageError(`${command} does not accept --${key}.`);
    }
  }
}

function resolvePluginRoot(env) {
  if (env.CLAUDE_PLUGIN_ROOT && env.CLAUDE_PLUGIN_ROOT.trim()) {
    return path.resolve(env.CLAUDE_PLUGIN_ROOT.trim());
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function resolveCodexModelsCachePath(env) {
  const override = env.FUSION_CODEX_MODELS_CACHE;
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), ".codex", "models_cache.json");
}

function listedModelId(value) {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  for (const key of ["slug", "id"]) {
    if (typeof value[key] === "string" && value[key].trim()) {
      return value[key].trim();
    }
  }
  return null;
}

function readCodexModelListing(filePath) {
  try {
    const stats = fs.statSync(filePath);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.models)) {
      throw new Error("Expected a JSON object with a models array.");
    }
    return {
      available: true,
      path: filePath,
      mtime: stats.mtime.toISOString(),
      modelIds: [...new Set(data.models.map(listedModelId).filter(Boolean))]
    };
  } catch (error) {
    return {
      available: false,
      path: filePath,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function auditModelDrift(env) {
  const modelRoutingFile = resolveModelRoutingPath(env);
  const routing = readModelRoutingFile(modelRoutingFile);
  const listing = readCodexModelListing(resolveCodexModelsCachePath(env));
  const configuredModelIds = routing.ok ? [...new Set(routing.data.models.map((model) => model.id))] : [];
  const configuredCodexModelIds = routing.ok ? [...new Set(routing.data.models.filter((model) => model.lane === "codex").map((model) => model.id))] : [];
  const listedModelIds = new Set(listing.available ? listing.modelIds : []);
  return {
    modelRoutingFile,
    configured: !routing.missing,
    valid: Boolean(routing.ok),
    error: routing.ok || routing.missing ? null : routing.reason,
    listing,
    configuredButAbsent: listing.available && routing.ok ? configuredCodexModelIds.filter((id) => !listedModelIds.has(id)) : [],
    unconfiguredGptModels: listing.available && routing.ok ? listing.modelIds.filter((id) => id.startsWith("gpt-") && !configuredModelIds.includes(id)) : []
  };
}

function defaultData() {
  return {
    schemaVersion: MODEL_ROUTING_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    costProfile: "",
    models: []
  };
}

function loadEditableData(filePath) {
  if (!fs.existsSync(filePath)) {
    return defaultData();
  }
  const result = readModelRoutingFile(filePath);
  if (!result.ok) {
    throw new UsageError(`Cannot edit ${filePath}: ${result.reason}`);
  }
  return result.data;
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    void 0;
  }
}

function writeModelRoutingData(filePath, data) {
  data.updatedAt = new Date().toISOString();
  const validation = validateModelRoutingData(data);
  if (!validation.ok) {
    throw new UsageError(`Cannot write model routing file: ${validation.reason}`);
  }
  ensurePrivateDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(validation.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return validation.data;
}

function writePosture(filePath, posture) {
  ensurePrivateDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${posture}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function resolvePostureStatus(env) {
  const value = resolvePosture(env);
  if (normalizePosture(env[POSTURE_ENV])) {
    return { value, source: "env" };
  }
  if (readPostureFile(env)) {
    return { value, source: "file" };
  }
  return { value, source: "default" };
}

function refreshLiveRules(env, stdout) {
  const messages = [];
  const result = syncRulesToLive({
    pluginRoot: resolvePluginRoot(env),
    env,
    log(message) {
      messages.push(message);
    }
  });
  for (const message of messages) {
    stdout.write(`${message}\n`);
  }
  return result;
}

function showCommand(options, env, stdout) {
  ensureOnlyOptions(options, new Set(["json"]), "show");
  const filePath = resolveModelRoutingPath(env);
  const posture = resolvePostureStatus(env);
  const result = readModelRoutingFile(filePath);
  const table = result.ok ? renderModelTable(result.data) : result.missing ? DEFAULT_MODEL_TABLE_PLACEHOLDER : null;
  if (options.json) {
    stdout.write(
      `${JSON.stringify(
        {
          posture,
          filePath,
          configured: !result.missing,
          valid: Boolean(result.ok),
          error: result.ok || result.missing ? null : result.reason,
          table,
          data: result.ok ? result.data : null
        },
        null,
        2
      )}\n`
    );
    return;
  }
  const lines = [`Posture: ${posture.value} (${posture.source})`, `Model routing file: ${filePath}`];
  if (result.missing) {
    lines.push("Not configured: use `rescore <id> --intelligence N --taste N --cost N` with values from 1 to 5 to add your first score.");
  } else if (!result.ok) {
    lines.push(`Invalid model routing file: ${result.reason}`);
  }
  lines.push("", table);
  stdout.write(`${lines.join("\n")}\n`);
}

function auditCommand(options, env, stdout) {
  ensureOnlyOptions(options, new Set(["json"]), "audit");
  const report = auditModelDrift(env);
  if (options.json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const lines = [`Model routing file: ${report.modelRoutingFile}`];
  if (!report.configured) {
    lines.push("Model routing is not configured.");
  } else if (!report.valid) {
    lines.push(`Invalid model routing file: ${report.error}`);
  }
  if (!report.listing.available) {
    lines.push(`Codex model listing: listing unavailable (${report.listing.reason})`);
    stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  lines.push(
    `Codex model listing: ${report.listing.path}`,
    `Listing mtime: ${report.listing.mtime}`,
    `Configured but absent: ${report.configuredButAbsent.length ? report.configuredButAbsent.join(", ") : "none"}`,
    `Unconfigured gpt-* newcomers: ${report.unconfiguredGptModels.length ? report.unconfiguredGptModels.join(", ") : "none"}`
  );
  stdout.write(`${lines.join("\n")}\n`);
}

function rescoreCommand(positionals, options, env, stdout) {
  ensureOnlyOptions(options, new Set(["intelligence", "taste", "cost", "lane", "notes"]), "rescore");
  if (positionals.length !== 1) {
    throw new UsageError("Expected rescore <id>.");
  }
  const id = requireId(positionals[0]);
  const intelligence = parseScore(options.intelligence, "--intelligence");
  const taste = parseScore(options.taste, "--taste");
  const cost = parseScore(options.cost, "--cost");
  if (options.lane != null && !validateLane(options.lane)) {
    throw new UsageError(`Expected --lane to be one of ${[...MODEL_ROUTING_LANES].join(", ")}.`);
  }
  const filePath = resolveModelRoutingPath(env);
  const data = loadEditableData(filePath);
  const index = data.models.findIndex((model) => model.id === id);
  const current = index === -1 ? { id } : data.models[index];
  const next = {
    ...current,
    id,
    lane: options.lane ?? current.lane ?? "other",
    intelligence,
    taste,
    cost
  };
  if (options.notes != null) {
    const notes = options.notes.trim();
    if (notes) {
      next.notes = notes;
    } else {
      delete next.notes;
    }
  }
  if (index === -1) {
    data.models.push(next);
  } else {
    data.models[index] = next;
  }
  writeModelRoutingData(filePath, data);
  refreshLiveRules(env, stdout);
  stdout.write(`Updated model score for ${id}.\n`);
}

function removeCommand(positionals, options, env, stdout) {
  ensureOnlyOptions(options, new Set(), "remove");
  if (positionals.length !== 1) {
    throw new UsageError("Expected remove <id>.");
  }
  const id = requireId(positionals[0]);
  const filePath = resolveModelRoutingPath(env);
  if (!fs.existsSync(filePath)) {
    refreshLiveRules(env, stdout);
    stdout.write(`No model routing file exists at ${filePath}.\n`);
    return;
  }
  const data = loadEditableData(filePath);
  const before = data.models.length;
  data.models = data.models.filter((model) => model.id !== id);
  if (data.models.length === before) {
    refreshLiveRules(env, stdout);
    stdout.write(`No model score found for ${id}.\n`);
    return;
  }
  writeModelRoutingData(filePath, data);
  refreshLiveRules(env, stdout);
  stdout.write(`Removed model score for ${id}.\n`);
}

function setCostProfileCommand(positionals, options, env, stdout) {
  ensureOnlyOptions(options, new Set(), "set-cost-profile");
  const text = positionals.join(" ").trim();
  if (!text) {
    throw new UsageError("Expected set-cost-profile <text>.");
  }
  const filePath = resolveModelRoutingPath(env);
  const data = loadEditableData(filePath);
  data.costProfile = text;
  writeModelRoutingData(filePath, data);
  refreshLiveRules(env, stdout);
  stdout.write("Updated cost profile.\n");
}

function setPostureCommand(positionals, options, env, stdout) {
  ensureOnlyOptions(options, new Set(), "set-posture");
  if (positionals.length !== 1) {
    throw new UsageError(`Expected set-posture <${POSTURE_VALUES.join("|")}>.`);
  }
  const posture = normalizePosture(positionals[0]);
  if (!posture) {
    throw new UsageError(`Expected set-posture <${POSTURE_VALUES.join("|")}>.`);
  }
  const filePath = posturePath(env);
  writePosture(filePath, posture);
  stdout.write(`Updated posture to ${posture} at ${filePath}.\n`);
}

function resetDefaultsCommand(positionals, options, env, stdout) {
  if (positionals.length !== 0) {
    throw new UsageError("reset-defaults does not accept extra arguments.");
  }
  ensureOnlyOptions(options, new Set(["yes"]), "reset-defaults");
  if (!options.yes) {
    throw new UsageError("reset-defaults requires --yes to delete the model routing file.");
  }
  const filePath = resolveModelRoutingPath(env);
  fs.rmSync(filePath, { force: true });
  refreshLiveRules(env, stdout);
  stdout.write(`Reset model routing defaults at ${filePath}.\n`);
}

export function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { options, positionals } = parseCli(argv);
    const command = positionals.shift() ?? "show";
    switch (command) {
      case "show":
        if (positionals.length !== 0) {
          throw new UsageError("show does not accept positional arguments.");
        }
        showCommand(options, env, stdout);
        return 0;
      case "audit":
        if (positionals.length !== 0) {
          throw new UsageError("audit does not accept positional arguments.");
        }
        auditCommand(options, env, stdout);
        return 0;
      case "rescore":
        rescoreCommand(positionals, options, env, stdout);
        return 0;
      case "remove":
        removeCommand(positionals, options, env, stdout);
        return 0;
      case "set-cost-profile":
        setCostProfileCommand(positionals, options, env, stdout);
        return 0;
      case "set-posture":
        setPostureCommand(positionals, options, env, stdout);
        return 0;
      case "reset-defaults":
        resetDefaultsCommand(positionals, options, env, stdout);
        return 0;
      default:
        throw new UsageError(`Unknown command ${command}.\n${usage()}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`fusion-config: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  process.exitCode = main();
}
