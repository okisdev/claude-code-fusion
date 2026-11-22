import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { resolveFusionDataDir } from "./worker-state.mjs";
import { BREADTH_ENGINE_IDS, DEFAULT_BREADTH_ENGINE, ENGINES, ENGINE_IDS, engineDataDir, fixedEnginePool, isEngineId, routedEngineIds } from "./engines.mjs";
import { newestEngineCompanion } from "./engine-acceptance.mjs";

const require = createRequire(import.meta.url);

export const MODEL_TABLE_START = "<!-- fusion:model-table:start -->";
export const MODEL_TABLE_END = "<!-- fusion:model-table:end -->";
export const MODEL_ROUTING_SCHEMA_VERSION = 2;
export const MODEL_ROUTING_LANES = new Set([...ENGINE_IDS, "claude-trivial", "claude-fast", "claude-deep", "other"]);
export const DEFAULT_ROUTING_DEFAULTS = Object.fromEntries(Object.entries({
  codex: {
    quick: { model: "gpt-6-sol", effort: "xhigh" },
    volume: { model: "gpt-6-sol", effort: "high" },
    flagship: { model: "gpt-6.1-sol", effort: "xhigh" }
  },
  grok: {
    burst: { model: "grok-4.7-build-fast", effort: "low" },
    independence: { model: "grok-4.7-build-fast", effort: "low" },
    "live-web": { model: "grok-4.7-build-fast", effort: "high" },
    "large-context": { model: "grok-4.6", effort: "medium" }
  },
  cursor: {
    diversity: { model: "muse-spark-1.3", effort: "xhigh" },
    burst: { model: "composer-2.5", effort: "default" }
  },
  devin: {
    diversity: { model: "kimi-k3.1-pro", effort: "high" },
    burst: { model: "swe-2", effort: "high" }
  },
  agy: {
    independence: { model: "gemini-4-neon", effort: "high" },
    "large-context": { model: "gemini-4-neon", effort: "high" },
    burst: { model: "gemini-4-neon", effort: "medium" }
  },
  opencode: {
    bulk: { model: "deepseek-v4.1-flash", effort: "high" },
    "blind-check": { model: "glm-5.3-flash", effort: "high" }
  }
}).map(([lane, roles]) => [lane, Object.fromEntries(Object.entries(roles).map(([role, choice]) => [role, { ...choice, ...modelBilling(lane, choice.model, null) }]))]));
export const DEFAULT_MODEL_ROUTING_MODELS = [
  { id: "gemini-4-neon", lane: "agy", family: ENGINES.agy.family, intelligence: 5, taste: 4, cost: 4, pool: "agy", costClass: "included" },
  { id: "gemini-4-hydrogen", lane: "agy", family: ENGINES.agy.family, intelligence: 4, taste: 3, cost: 5, pool: "agy", costClass: "included" },
  { id: "gemini-4-argon", lane: "agy", family: ENGINES.agy.family, intelligence: 4, taste: 3, cost: 4, pool: "agy", costClass: "included" },
  { id: "deepseek-v4.1-flash", lane: "opencode", family: "deepseek", intelligence: 3, taste: 3, cost: 5, pool: "opencode", costClass: "included" },
  { id: "glm-5.3-flash", lane: "opencode", family: "zhipu", intelligence: 3, taste: 3, cost: 5, pool: "opencode", costClass: "included" }
];
const ROUTING_DEFAULT_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function laneEfforts(lane) {
  return isEngineId(lane) ? new Set(ENGINES[lane].efforts) : ROUTING_DEFAULT_EFFORTS;
}
export const DEFAULT_MODEL_TABLE_PLACEHOLDER =
  "Engine capability table: run /fusion:config to score your configured engines (intelligence, taste, cost, 1 to 5) and regenerate this block. Until scored, route by the qualitative lane descriptions in this document.";
const MODEL_TABLE_PRIORITY_SENTENCE =
  "Scores feed the routing priorities above: intelligence proxies correctness and safety, taste is user facing quality, cost applies only as the final tie breaker.";
const MODEL_TABLE_SCORE_SENTENCE = "Scores are user-assigned via /fusion:config; re-score when the model lineup changes.";
const BREADTH_DIVERSITY_EXCLUSION = `Breadth diversity excludes the claude family and the ${ENGINES.agy.family} family served by ${ENGINES.agy.displayName} (${ENGINES.agy.id}); route ${ENGINES.agy.family} consults to ${ENGINES.agy.rescueAgent}.`;

export function resolveModelRoutingPath(env = process.env) {
  const override = env.FUSION_MODEL_ROUTING;
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(resolveFusionDataDir(env), "model-routing.json");
}

function isValidScore(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

export function validateLane(value) {
  return typeof value === "string" && MODEL_ROUTING_LANES.has(value);
}

export function validateId(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateIsoDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function invalid(reason) {
  return { ok: false, reason };
}

function devinModelCatalog(env) {
  try {
    const companion = newestEngineCompanion("devin", env);
    const models = require(path.join(path.dirname(companion), "lib", "devin-models.mjs"));
    const catalog = models.readModelCatalog({ dataDir: engineDataDir("devin", env), env, maxAgeMs: Infinity, run() { throw new Error("Model cache unavailable."); } });
    return { ...models, catalog };
  } catch {
    return null;
  }
}

function modelBilling(lane, model, devin, effort = "default") {
  if (fixedEnginePool(lane)) return { pool: lane, costClass: "included" };
  if (lane === "cursor") {
    const pool = model.startsWith("composer-") ? "first-party" : "api";
    return { pool, costClass: pool === "first-party" ? "included" : "metered" };
  }
  if (lane === "devin" && devin) {
    try {
      const family = devin.findCatalogFamily(devin.catalog, model, { write: true });
      const familyName = [family.slug, ...family.aliases].includes(model);
      const pools = new Set(family.variants.map((variant) => devin.billingPoolForModel(devin.catalog, variant.uid)));
      const pool = familyName && effort === "default" && pools.size > 1 ? "credits" : devin.billingPoolForModel(devin.catalog, model, effort);
      return { pool, costClass: devin.costClassForPool(pool) };
    } catch {}
  }
  return { pool: null, costClass: null };
}

export function validateModelRoutingData(value, { env = process.env } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("Expected a JSON object.");
  }
  if (value.schemaVersion !== MODEL_ROUTING_SCHEMA_VERSION) {
    return invalid(`Expected schemaVersion ${MODEL_ROUTING_SCHEMA_VERSION}.`);
  }
  if (!validateIsoDate(value.updatedAt)) {
    return invalid("Expected updatedAt to be an ISO date string.");
  }
  if (typeof value.costProfile !== "string") {
    return invalid("Expected costProfile to be a string.");
  }
  if (value.breadth !== undefined && !BREADTH_ENGINE_IDS.includes(value.breadth)) {
    return invalid(`Expected breadth to be one of ${BREADTH_ENGINE_IDS.join(", ")}.`);
  }
  if (!Array.isArray(value.models)) {
    return invalid("Expected models to be an array.");
  }

  const models = [];
  const modelKeys = new Set();
  const catalog = devinModelCatalog(env);
  for (const [index, model] of value.models.entries()) {
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      return invalid(`Expected models[${index}] to be an object.`);
    }
    if (!validateId(model.id)) {
      return invalid(`Expected models[${index}].id to be a non-empty string.`);
    }
    if (!validateLane(model.lane)) {
      return invalid(`Expected models[${index}].lane to be one of ${[...MODEL_ROUTING_LANES].join(", ")}.`);
    }
    if (model.family !== undefined && (typeof model.family !== "string" || !/^[a-z][a-z0-9-]*$/.test(model.family))) {
      return invalid(`Expected models[${index}].family to be a lowercase slug.`);
    }
    if (isEngineId(model.lane) && ENGINES[model.lane].family === null && model.family === undefined) {
      return invalid(`Expected models[${index}].family for the ${model.lane} lane.`);
    }
    if (!isValidScore(model.intelligence)) {
      return invalid(`Expected models[${index}].intelligence to be an integer from 1 to 5.`);
    }
    if (!isValidScore(model.taste)) {
      return invalid(`Expected models[${index}].taste to be an integer from 1 to 5.`);
    }
    if (!isValidScore(model.cost)) {
      return invalid(`Expected models[${index}].cost to be an integer from 1 to 5.`);
    }
    if (model.notes != null && typeof model.notes !== "string") {
      return invalid(`Expected models[${index}].notes to be a string when present.`);
    }
    const sanitized = {
      id: model.id.trim(),
      lane: model.lane,
      ...(model.family === undefined ? {} : { family: model.family }),
      intelligence: model.intelligence,
      taste: model.taste,
      cost: model.cost,
      ...modelBilling(model.lane, model.id.trim(), catalog)
    };
    if (model.notes != null && model.notes.trim()) {
      sanitized.notes = model.notes.trim();
    }
    const modelKey = `${sanitized.lane}\0${sanitized.id}`;
    if (modelKeys.has(modelKey)) {
      return invalid(`Duplicate model routing row for lane ${sanitized.lane} and id ${sanitized.id}.`);
    }
    modelKeys.add(modelKey);
    models.push(sanitized);
  }

  let defaults;
  if (value.defaults !== undefined) {
    if (!value.defaults || typeof value.defaults !== "object" || Array.isArray(value.defaults)) {
      return invalid("Expected defaults to be an object.");
    }
    defaults = {};
    for (const [lane, roles] of Object.entries(value.defaults)) {
      if (!isEngineId(lane)) {
        return invalid(`Expected defaults lane to be one of ${ENGINE_IDS.join(", ")}.`);
      }
      if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
        return invalid(`Expected defaults.${lane} to be an object.`);
      }
      defaults[lane] = {};
      for (const [role, choice] of Object.entries(roles)) {
        if (!ENGINES[lane].roles.includes(role)) {
          return invalid(`Expected defaults.${lane} role to be one of ${ENGINES[lane].roles.join(", ")}.`);
        }
        if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
          return invalid(`Expected defaults.${lane}.${role} to be an object.`);
        }
        if (!validateId(choice.model)) {
          return invalid(`Expected defaults.${lane}.${role}.model to be a non-empty string.`);
        }
        if (!laneEfforts(lane).has(choice.effort)) {
          return invalid(`Expected defaults.${lane}.${role}.effort to be one of ${[...laneEfforts(lane)].join(", ")}.`);
        }
        const model = choice.model.trim();
        if (!models.some((row) => row.lane === lane && row.id === model)) {
          return invalid(`Expected defaults.${lane}.${role}.model to match a model in the ${lane} lane.`);
        }
        if (ENGINES[lane].seat === "breadth" && role === "diversity") {
          const family = models.find((row) => row.lane === lane && row.id === model).family;
          if (["claude", "anthropic", ENGINES.agy.family].includes(family)) {
            return invalid(`Expected defaults.${lane}.${role}.model to use a family eligible for breadth diversity. ${BREADTH_DIVERSITY_EXCLUSION}`);
          }
        }
        const { pool, costClass } = lane === "devin" ? modelBilling(lane, model, catalog, choice.effort) : models.find((row) => row.lane === lane && row.id === model);
        defaults[lane][role] = { model, effort: choice.effort, pool, costClass };
      }
    }
  }

  return {
    ok: true,
    data: {
      schemaVersion: MODEL_ROUTING_SCHEMA_VERSION,
      updatedAt: value.updatedAt,
      costProfile: value.costProfile,
      ...(value.breadth === undefined ? {} : { breadth: value.breadth }),
      models,
      ...(defaults === undefined ? {} : { defaults })
    }
  };
}

function mergeRoutingDefaults(defaults = {}, env = process.env) {
  const catalog = devinModelCatalog(env);
  return Object.fromEntries(
    ENGINE_IDS.map((lane) => [
      lane,
      Object.fromEntries(ENGINES[lane].roles.map((role) => {
        const choice = defaults[lane]?.[role] ?? DEFAULT_ROUTING_DEFAULTS[lane][role];
        return [role, { ...choice, ...modelBilling(lane, choice.model, catalog, choice.effort) }];
      }))
    ])
  );
}

export function readRoutingDefaults(env = process.env, { warn = console.error } = {}) {
  const filePath = resolveModelRoutingPath(env);
  const result = readModelRoutingFile(filePath, { env });
  if (!result.ok && !result.missing && warn) {
    warn(modelRoutingWarning(filePath, result.reason));
  }
  return { breadth: result.ok ? result.data.breadth ?? DEFAULT_BREADTH_ENGINE : DEFAULT_BREADTH_ENGINE, ...mergeRoutingDefaults(result.ok ? result.data.defaults : undefined, env) };
}

export function readModelRoutingFile(filePath, { env = process.env } = {}) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, missing: true, reason: "Model routing file does not exist." };
  }
  try {
    return { missing: false, ...readModelRoutingContents(fs.readFileSync(filePath, "utf8"), { env }) };
  } catch (error) {
    return { ok: false, missing: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function readModelRoutingContents(contents, options) {
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    return { ok: false, missing: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (parsed?.schemaVersion === 1) parsed.schemaVersion = MODEL_ROUTING_SCHEMA_VERSION;
  return validateModelRoutingData(parsed, options);
}

function tableCell(value) {
  return String(value).replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

export function renderModelTable(data, { includeNotes = false, env = process.env } = {}) {
  const lines = [];
  const breadth = data.breadth ?? DEFAULT_BREADTH_ENGINE;
  const otherBreadth = BREADTH_ENGINE_IDS.find((id) => id !== breadth);
  const costProfile = data.costProfile.trim();
  if (costProfile) {
    lines.push(`Cost profile: ${tableCell(costProfile)}`, "");
  }
  lines.push(`| Engine | Lane | Family | Intelligence | Taste | Cost | Cost class |${includeNotes ? " Pool | Notes |" : ""}`);
  lines.push(`|---|---|---|---:|---:|---:|---|${includeNotes ? "---|---|" : ""}`);
  for (const model of data.models) {
    if (isEngineId(model.lane) && ENGINES[model.lane].seat === "breadth" && model.lane !== breadth) {
      continue;
    }
    const family = model.family ?? (isEngineId(model.lane) ? ENGINES[model.lane].family : model.lane.startsWith("claude-") ? "anthropic" : null);
    lines.push(
      `| ${tableCell(model.id)} | ${tableCell(model.lane)} | ${tableCell(family ?? "")} | ${model.intelligence} | ${model.taste} | ${model.cost} | ${tableCell(model.costClass ?? "unknown")} |${includeNotes ? ` ${tableCell(model.pool ?? "unknown")} | ${tableCell(model.notes ?? "")} |` : ""}`
    );
  }
  const defaults = mergeRoutingDefaults(data.defaults, env);
  const defaultSentence = routedEngineIds(breadth).map((lane) => ENGINES[lane].roles.map((role, index) => {
    const choice = defaults[lane][role];
    return `${index === 0 ? `${lane} ` : ""}${role} ${tableCell(choice.model)}@${choice.effort}${includeNotes ? ` (pool: ${tableCell(choice.pool ?? "unknown")}, cost class: ${tableCell(choice.costClass ?? "unknown")})` : choice.costClass === "metered" ? " (metered)" : ""}`;
  }).join(", ")).join("; ");
  lines.push(
    `Breadth engine: ${ENGINES[breadth].displayName} (${breadth}); its briefs go to ${ENGINES[breadth].rescueAgent} with \`${breadth}-role: diversity\` or \`${breadth}-role: burst\`, and ${ENGINES[otherBreadth].displayName} holds no routing seat.`,
    BREADTH_DIVERSITY_EXCLUSION,
    ...(includeNotes ? [] : ["Model notes (benchmarks, prices, latency) live in model-routing.json; `/fusion:config` shows them."]),
    "",
    `Lane defaults: ${defaultSentence}.`,
    "",
    MODEL_TABLE_PRIORITY_SENTENCE,
    MODEL_TABLE_SCORE_SENTENCE
  );
  return lines.join("\n");
}

export function modelRoutingWarning(filePath, reason) {
  return `fusion: model routing file invalid at ${filePath}: ${reason}`;
}

export function renderModelTableFromFile(filePath, fallbackText = DEFAULT_MODEL_TABLE_PLACEHOLDER, { warn = console.error, env = process.env } = {}) {
  const result = readModelRoutingFile(filePath, { env });
  if (result.ok) {
    return renderModelTable(result.data, { env });
  }
  if (!result.missing && warn) {
    warn(modelRoutingWarning(filePath, result.reason));
  }
  return fallbackText;
}

export function renderModelTableFromContents(contents, fallbackText = DEFAULT_MODEL_TABLE_PLACEHOLDER, { env = process.env } = {}) {
  const result = readModelRoutingContents(contents, { env });
  return result.ok ? renderModelTable(result.data, { env }) : fallbackText;
}
