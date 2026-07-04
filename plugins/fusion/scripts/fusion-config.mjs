#!/usr/bin/env node

import fs from "node:fs";
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
import { syncRulesToLive } from "./lib/rules-template.mjs";

class UsageError extends Error {}

const BOOLEAN_OPTIONS = new Set(["json", "yes"]);
const VALUE_OPTIONS = new Set(["intelligence", "taste", "cost", "lane", "notes"]);

function usage() {
  return [
    "Usage:",
    "  node scripts/fusion-config.mjs show [--json]",
    "  node scripts/fusion-config.mjs rescore <id> --intelligence N --taste N --cost N [--lane L] [--notes S]",
    "  node scripts/fusion-config.mjs remove <id>",
    "  node scripts/fusion-config.mjs set-cost-profile <text>",
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

function writeModelRoutingData(filePath, data) {
  data.updatedAt = new Date().toISOString();
  const validation = validateModelRoutingData(data);
  if (!validation.ok) {
    throw new UsageError(`Cannot write model routing file: ${validation.reason}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(validation.data, null, 2)}\n`, "utf8");
  return validation.data;
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
  const result = readModelRoutingFile(filePath);
  const table = result.ok ? renderModelTable(result.data) : result.missing ? DEFAULT_MODEL_TABLE_PLACEHOLDER : null;
  if (options.json) {
    stdout.write(
      `${JSON.stringify(
        {
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
  const lines = [`Model routing file: ${filePath}`];
  if (result.missing) {
    lines.push("Not configured: use `rescore <id> --intelligence N --taste N --cost N` with values from 1 to 5 to add your first score.");
  } else if (!result.ok) {
    lines.push(`Invalid model routing file: ${result.reason}`);
  }
  lines.push("", table);
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
      case "rescore":
        rescoreCommand(positionals, options, env, stdout);
        return 0;
      case "remove":
        removeCommand(positionals, options, env, stdout);
        return 0;
      case "set-cost-profile":
        setCostProfileCommand(positionals, options, env, stdout);
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
