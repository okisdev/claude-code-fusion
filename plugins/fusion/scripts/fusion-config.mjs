#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MODEL_TABLE_PLACEHOLDER,
  MODEL_ROUTING_SCHEMA_VERSION,
  MODEL_ROUTING_LANES,
  readModelRoutingFile,
  readRoutingDefaults,
  renderModelTable,
  resolveModelRoutingPath,
  validateId,
  validateLane,
  validateModelRoutingData
} from "./lib/model-table.mjs";
import { newestEngineCompanion } from "./lib/engine-acceptance.mjs";
import { BREADTH_ENGINE_IDS, ENGINES, ENGINE_IDS, isEngineId, routedEngineIds } from "./lib/engines.mjs";
import { withFileLock, writeFileAtomic } from "./lib/storage.mjs";

class UsageError extends Error {}

const BOOLEAN_OPTIONS = new Set(["json", "yes"]);
const VALUE_OPTIONS = new Set(["intelligence", "taste", "cost", "lane", "family", "notes"]);

function usage() {
  return [
    "Usage:",
    "  node scripts/fusion-config.mjs show [--json]",
    "  node scripts/fusion-config.mjs audit [--json]",
    "  node scripts/fusion-config.mjs rescore <id> --intelligence N --taste N --cost N [--lane L] [--family F] [--notes S]",
    "  node scripts/fusion-config.mjs set-default <lane> <role> <model> <effort>",
    `  node scripts/fusion-config.mjs set-breadth <${BREADTH_ENGINE_IDS.join("|")}>`,
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

function readEngineModelListing(engine, env) {
  const override = typeof env[ENGINES[engine].companionEnv] === "string" ? env[ENGINES[engine].companionEnv].trim() : "";
  if (override && (!path.isAbsolute(override) || !fs.existsSync(override) || !fs.statSync(override).isFile())) {
    return { available: false, reason: `companion missing at ${override}` };
  }
  const companion = newestEngineCompanion(engine, env);
  if (!companion) {
    return { available: false, reason: "companion missing" };
  }
  const result = spawnSync(process.execPath, [companion, "models", "--json"], { encoding: "utf8", env, timeout: 60_000 });
  if (result.error || result.status !== 0) {
    return { available: false, reason: result.error?.message || result.stderr.trim() || `exit ${result.status}` };
  }
  try {
    const data = JSON.parse(result.stdout);
    if (!data || data.engine !== engine || !Array.isArray(data.models) || typeof data.source !== "string" || !data.models.every((model) => model && typeof model.id === "string" && model.id.trim() && (model.displayName === null || typeof model.displayName === "string"))) {
      throw new Error("expected an engine model listing with engine, models, and source");
    }
    return { available: true, source: data.source, modelIds: [...new Set(data.models.map((model) => model.id.trim()))] };
  } catch (error) {
    return { available: false, reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function matchesListing(engine, id, listedIds) {
  return listedIds.some((listed) => listed === id || (ENGINES[engine].seat === "breadth" && listed.startsWith(`${id}-`)));
}

function auditModelDrift(env) {
  const modelRoutingFile = resolveModelRoutingPath(env);
  const routing = readModelRoutingFile(modelRoutingFile);
  const defaults = readRoutingDefaults(env, { warn: null });
  const routed = new Set(routedEngineIds(defaults.breadth));
  const engines = Object.fromEntries(ENGINE_IDS.map((engine) => {
    const listing = readEngineModelListing(engine, env);
    const scored = routing.ok ? [...new Set(routing.data.models.filter((row) => row.lane === engine).map((row) => row.id))] : [];
    const listedIds = listing.available ? listing.modelIds : [];
    return [engine, {
      listing,
      configuredButAbsent: routed.has(engine) && listing.available && routing.ok ? scored.filter((id) => !matchesListing(engine, id, listedIds)) : [],
      defaultsAbsent: routed.has(engine) && listing.available ? Object.entries(defaults[engine]).filter(([, choice]) => !matchesListing(engine, choice.model, listedIds)).map(([role, choice]) => ({ role, model: choice.model })) : [],
      unscored: routed.has(engine) && listing.available ? listedIds.filter((id) => !scored.some((base) => matchesListing(engine, base, [id]))) : []
    }];
  }));
  return {
    modelRoutingFile,
    configured: !routing.missing,
    valid: Boolean(routing.ok),
    error: routing.ok || routing.missing ? null : routing.reason,
    breadth: defaults.breadth,
    defaults: Object.fromEntries(routedEngineIds(defaults.breadth).map((engine) => [engine, defaults[engine]])),
    engines
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

function writeModelRoutingData(filePath, data) {
  data.updatedAt = new Date().toISOString();
  const validation = validateModelRoutingData(data);
  if (!validation.ok) {
    throw new UsageError(`Cannot write model routing file: ${validation.reason}`);
  }
  writeFileAtomic(filePath, `${JSON.stringify(validation.data, null, 2)}\n`);
  return validation.data;
}

function showCommand(options, env, stdout) {
  ensureOnlyOptions(options, new Set(["json"]), "show");
  const filePath = resolveModelRoutingPath(env);
  const result = readModelRoutingFile(filePath);
  const table = result.ok ? renderModelTable(result.data, { includeNotes: true }) : result.missing ? DEFAULT_MODEL_TABLE_PLACEHOLDER : null;
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
  for (const [lane, roles] of Object.entries(report.defaults)) {
    lines.push(`${lane} defaults: ${Object.entries(roles).map(([role, choice]) => `${role} ${choice.model}@${choice.effort}`).join(", ")}`);
  }
  for (const engine of ENGINE_IDS) {
    const { listing, configuredButAbsent, defaultsAbsent, unscored } = report.engines[engine];
    const name = ENGINES[engine].displayName;
    if (!listing.available) {
      lines.push(`${name} listing unavailable: ${listing.reason}`);
      continue;
    }
    lines.push(
      `${name} model listing: ${listing.source}`,
      `${name} configured but absent: ${configuredButAbsent.length ? configuredButAbsent.join(", ") : "none"}`,
      `${name} defaults absent: ${defaultsAbsent.length ? defaultsAbsent.map(({ role, model }) => `${role} ${model}`).join(", ") : "none"}`,
      `${name} unscored models (no routing seat): ${unscored.length ? unscored.join(", ") : "none"}`
    );
    if (engine === "codex") {
      const newcomers = unscored.filter((id) => id.startsWith("gpt-"));
      lines.push(`Unconfigured gpt-* newcomers: ${newcomers.length ? newcomers.join(", ") : "none"}`);
    }
  }
  stdout.write(`${lines.join("\n")}\n`);
}

function setDefaultCommand(positionals, options, env, stdout) {
  ensureOnlyOptions(options, new Set(), "set-default");
  if (positionals.length !== 4) {
    throw new UsageError("Expected set-default <lane> <role> <model> <effort>.");
  }
  const [lane, role, rawModel, effort] = positionals;
  if (!isEngineId(lane) || !ENGINES[lane].roles.includes(role)) {
    throw new UsageError(`Expected ${ENGINE_IDS.map((id) => `${id} role (${ENGINES[id].roles.join(", ")})`).join(" or ")}.`);
  }
  const model = requireId(rawModel);
  const filePath = resolveModelRoutingPath(env);
  const data = loadEditableData(filePath);
  data.defaults ??= {};
  data.defaults[lane] ??= {};
  data.defaults[lane][role] = { model, effort };
  const validation = validateModelRoutingData(data);
  if (!validation.ok) {
    throw new UsageError(`Cannot write model routing file: ${validation.reason}`);
  }
  const listing = readEngineModelListing(lane, env);
  if (listing.available) {
    if (!matchesListing(lane, model, listing.modelIds)) {
      throw new UsageError(`Model ${model} is absent from the ${ENGINES[lane].displayName} model listing (${listing.source}).`);
    }
  } else {
    stdout.write(`fusion-config: ${ENGINES[lane].displayName} model listing unavailable; model availability was not checked.\n`);
  }
  writeModelRoutingData(filePath, data);
  stdout.write(`Updated ${lane} ${role} default to ${model}@${effort}.\n`);
}

function setBreadthCommand(positionals, options, env, stdout) {
  ensureOnlyOptions(options, new Set(), "set-breadth");
  if (positionals.length !== 1 || !BREADTH_ENGINE_IDS.includes(positionals[0])) {
    throw new UsageError(`Expected set-breadth <${BREADTH_ENGINE_IDS.join("|")}>.`);
  }
  const breadth = positionals[0];
  const filePath = resolveModelRoutingPath(env);
  const data = loadEditableData(filePath);
  data.breadth = breadth;
  writeModelRoutingData(filePath, data);
  stdout.write(`Updated breadth engine to ${ENGINES[breadth].displayName} (${breadth}).\n`);
}

function rescoreCommand(positionals, options, env, stdout) {
  ensureOnlyOptions(options, new Set(["intelligence", "taste", "cost", "lane", "family", "notes"]), "rescore");
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
  if (options.family != null) {
    next.family = options.family;
  }
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
    stdout.write(`No model routing file exists at ${filePath}.\n`);
    return;
  }
  const data = loadEditableData(filePath);
  const before = data.models.length;
  data.models = data.models.filter((model) => model.id !== id);
  if (data.models.length === before) {
    stdout.write(`No model score found for ${id}.\n`);
    return;
  }
  writeModelRoutingData(filePath, data);
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
  stdout.write(`Reset model routing defaults at ${filePath}.\n`);
}

export function main(argv = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { options, positionals } = parseCli(argv);
    const command = positionals.shift() ?? "show";
    const runCommand = () => {
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
        case "set-default":
          setDefaultCommand(positionals, options, env, stdout);
          return 0;
        case "set-breadth":
          setBreadthCommand(positionals, options, env, stdout);
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
    };
    if (!["rescore", "set-default", "set-breadth", "remove", "set-cost-profile", "reset-defaults"].includes(command)) {
      return runCommand();
    }
    return withFileLock(resolveModelRoutingPath(env), () => {
      const status = runCommand();
      showCommand({}, env, stdout);
      stdout.write("Routing changes take effect in new sessions or after /compact.\n");
      return status;
    });
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
