import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ENGINES, ENGINE_IDS, isEngineId } from "./engines.mjs";

export const MODEL_TABLE_START = "<!-- fusion:model-table:start -->";
export const MODEL_TABLE_END = "<!-- fusion:model-table:end -->";
export const MODEL_ROUTING_SCHEMA_VERSION = 1;
export const MODEL_ROUTING_LANES = new Set([...ENGINE_IDS, "claude-trivial", "claude-fast", "claude-deep", "other"]);
export const DEFAULT_ROUTING_DEFAULTS = {
  codex: {
    quick: { model: "gpt-6-sol", effort: "xhigh" },
    volume: { model: "gpt-6-luna", effort: "xhigh" },
    flagship: { model: "gpt-6-astra", effort: "xhigh" }
  },
  grok: {
    burst: { model: "grok-4.7-build-fast", effort: "low" },
    independence: { model: "grok-4.7-build-fast", effort: "high" },
    "live-web": { model: "grok-4.7-build-fast", effort: "high" },
    "large-context": { model: "grok-4.6", effort: "medium" }
  },
  cursor: {
    diversity: { model: "muse-spark-1.3", effort: "xhigh" },
    burst: { model: "composer-2.5", effort: "default" }
  }
};
const ROUTING_DEFAULT_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function laneEfforts(lane) {
  return isEngineId(lane) ? new Set(ENGINES[lane].efforts) : ROUTING_DEFAULT_EFFORTS;
}
export const DEFAULT_MODEL_TABLE_PLACEHOLDER =
  "Engine capability table: run /fusion:config to score your configured engines (intelligence, taste, cost, 1 to 5) and regenerate this block. Until scored, route by the qualitative lane descriptions in this document.";
const MODEL_TABLE_PRIORITY_SENTENCE =
  "Scores feed the routing priorities above: intelligence proxies correctness and safety, taste is user facing quality, cost applies only as the final tie breaker.";
const MODEL_TABLE_SCORE_SENTENCE = "Scores are user-assigned via /fusion:config; re-score when the model lineup changes.";

export function resolveModelRoutingPath(env = process.env) {
  const override = env.FUSION_MODEL_ROUTING;
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "fusion-claude-code-fusion", "model-routing.json");
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

export function validateModelRoutingData(value) {
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
  if (!Array.isArray(value.models)) {
    return invalid("Expected models to be an array.");
  }

  const models = [];
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
    if (model.lane === "cursor" && model.family === undefined) {
      return invalid(`Expected models[${index}].family for the cursor lane.`);
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
      cost: model.cost
    };
    if (model.notes != null && model.notes.trim()) {
      sanitized.notes = model.notes.trim();
    }
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
        defaults[lane][role] = { model, effort: choice.effort };
      }
    }
  }

  return {
    ok: true,
    data: {
      schemaVersion: MODEL_ROUTING_SCHEMA_VERSION,
      updatedAt: value.updatedAt,
      costProfile: value.costProfile,
      models,
      ...(defaults === undefined ? {} : { defaults })
    }
  };
}

function mergeRoutingDefaults(defaults = {}) {
  return Object.fromEntries(
    ENGINE_IDS.map((lane) => [
      lane,
      Object.fromEntries(ENGINES[lane].roles.map((role) => [role, defaults[lane]?.[role] ?? { ...DEFAULT_ROUTING_DEFAULTS[lane][role] }]))
    ])
  );
}

export function readRoutingDefaults(env = process.env, { warn = console.error } = {}) {
  const filePath = resolveModelRoutingPath(env);
  const result = readModelRoutingFile(filePath);
  if (!result.ok && !result.missing && warn) {
    warn(modelRoutingWarning(filePath, result.reason));
  }
  return mergeRoutingDefaults(result.ok ? result.data.defaults : undefined);
}

export function readModelRoutingFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, missing: true, reason: "Model routing file does not exist." };
  }
  try {
    return { missing: false, ...readModelRoutingContents(fs.readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { ok: false, missing: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function readModelRoutingContents(contents) {
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    return { ok: false, missing: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return validateModelRoutingData(parsed);
}

function tableCell(value) {
  return String(value).replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

export function renderModelTable(data) {
  const lines = [];
  const costProfile = data.costProfile.trim();
  if (costProfile) {
    lines.push(`Cost profile: ${tableCell(costProfile)}`, "");
  }
  lines.push("| Engine | Lane | Family | Intelligence | Taste | Cost | Notes |");
  lines.push("|---|---|---|---:|---:|---:|---|");
  for (const model of data.models) {
    const family = model.family ?? (isEngineId(model.lane) ? ENGINES[model.lane].family : model.lane.startsWith("claude-") ? "anthropic" : null);
    lines.push(
      `| ${tableCell(model.id)} | ${tableCell(model.lane)} | ${tableCell(family ?? "")} | ${model.intelligence} | ${model.taste} | ${model.cost} | ${tableCell(model.notes ?? "")} |`
    );
  }
  const defaults = mergeRoutingDefaults(data.defaults);
  const defaultSentence = ENGINE_IDS.map((lane) => ENGINES[lane].roles.map((role, index) => `${index === 0 ? `${lane} ` : ""}${role} ${tableCell(defaults[lane][role].model)}@${defaults[lane][role].effort}`).join(", ")).join("; ");
  lines.push(
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

export function renderModelTableFromFile(filePath, fallbackText = DEFAULT_MODEL_TABLE_PLACEHOLDER, { warn = console.error } = {}) {
  const result = readModelRoutingFile(filePath);
  if (result.ok) {
    return renderModelTable(result.data);
  }
  if (!result.missing && warn) {
    warn(modelRoutingWarning(filePath, result.reason));
  }
  return fallbackText;
}

export function renderModelTableFromContents(contents, fallbackText = DEFAULT_MODEL_TABLE_PLACEHOLDER) {
  const result = readModelRoutingContents(contents);
  return result.ok ? renderModelTable(result.data) : fallbackText;
}
