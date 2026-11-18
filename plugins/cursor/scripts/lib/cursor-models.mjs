import { createModelCatalog } from "./model-catalog.mjs";

import { classifyCursorFailure } from "./cursor-exec.mjs";

export function parseModelsListing(text) {
  const models = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.trim().match(/^([\w.\-[\]]+) - (.+?)(?: \((current|default)\))?$/);
    if (!match) {
      continue;
    }
    models.push({ id: match[1], displayName: match[2], current: match[3] === "current", isDefault: match[3] === "default" });
  }
  return models;
}

function failModelListing(result) {
  const detail = String(result.error?.message || result.stderr || result.stdout || "Model listing was empty.").trim();
  const error = new Error(`Cursor model listing failed: ${detail}`);
  const kind = classifyCursorFailure({
    exitCode: result.status === 0 ? 1 : result.status,
    stderrTail: detail,
    spawnError: result.error,
    protocolError: null
  });
  error.failureKind = ["auth", "network", "missing_cli", "quota", "rate_limited"].includes(kind) ? kind : "error";
  throw error;
}

export const readModelCatalog = createModelCatalog({
  key: "models",
  args: ["models"],
  includeFetchedAt: true,
  fail: failModelListing,
  parse(result) {
    const models = parseModelsListing(result.stdout);
    if (!models.length) failModelListing(result);
    return models;
  }
});

export function billingPoolForModel(id) {
  return id.startsWith("composer-") ? "first-party" : "api";
}

function throwModelInputError(requested, identifiers, effortToken) {
  const base = requested.replace(new RegExp(`-${effortToken}(?:-fast)?$`), "").replace(/-fast$/, "");
  const variants = [...identifiers].filter((id) => id === base || id.startsWith(`${base}-`));
  const error = new Error(`Unknown Cursor model ${requested}. Available variants for ${base}: ${variants.join(", ") || "none"}`);
  error.failureKind = "input";
  throw error;
}

export function resolveCursorModel({ catalog, model, effort = "default" }) {
  const requested = String(model ?? "");
  const models = Array.isArray(catalog) ? catalog : catalog.models;
  const identifiers = new Set(models.map((item) => item.id));
  const effortToken = "(?:none|minimal|low|medium|high|xhigh|extra-high|max)";
  if (requested === "auto" || requested === "default") {
    throwModelInputError(requested, identifiers, effortToken);
  }
  if (requested.includes("[")) {
    return { variant: requested, effortApplied: effort !== "default", billingPool: billingPoolForModel(requested) };
  }
  const encodedEffort = new RegExp(`-${effortToken}(?:-fast)?$`).test(requested);
  let variant = null;
  let effortApplied = false;
  if (identifiers.has(requested) && (effort === "default" || encodedEffort)) {
    variant = requested;
    effortApplied = effort !== "default" && encodedEffort;
  } else if (effort !== "default") {
    const effortNames = effort === "xhigh" ? ["xhigh", "extra-high"] : [effort];
    for (const name of effortNames) {
      const candidates = requested.endsWith("-fast")
        ? [`${requested}-${name}`, `${requested.slice(0, -5)}-${name}-fast`]
        : [`${requested}-${name}`];
      variant = candidates.find((candidate) => identifiers.has(candidate)) ?? null;
      if (variant) {
        effortApplied = true;
        break;
      }
    }
    const base = requested.replace(/-fast$/, "");
    const availableEfforts = [...identifiers].filter((id) => new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-${effortToken}(?:-fast)?$`).test(id));
    if (!variant && identifiers.has(requested) && availableEfforts.length === 0) {
      variant = requested;
    }
  }
  if (!variant) {
    throwModelInputError(requested, identifiers, effortToken);
  }
  return { variant, effortApplied, billingPool: billingPoolForModel(variant) };
}
