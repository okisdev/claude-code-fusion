import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

export function readModelCatalog({ dataDir, bin, env = process.env, maxAgeMs = 3600000, now = Date.now(), run = spawnSync }) {
  const cachePath = path.join(dataDir, "models-cache.json");
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (Array.isArray(cached.models) && Number.isFinite(cached.fetchedAt) && now >= cached.fetchedAt && now - cached.fetchedAt < maxAgeMs) {
      return { models: cached.models, fetchedAt: cached.fetchedAt, source: "cache" };
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
  const result = run(bin, ["models"], { env, encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  const models = result.status === 0 ? parseModelsListing(result.stdout) : [];
  if (result.error || result.status !== 0 || models.length === 0) {
    const detail = String(result.error?.message || result.stderr || result.stdout || "Model listing was empty.").trim();
    const error = new Error(`Cursor model listing failed: ${detail}`);
    const kind = classifyCursorFailure({
      exitCode: result.status === 0 ? 1 : result.status,
      stderrTail: detail,
      spawnError: result.error,
      protocolError: null
    });
    error.failureKind = ["auth", "network", "missing_cli"].includes(kind) ? kind : "error";
    throw error;
  }
  const catalog = { models, fetchedAt: now };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(catalog)}\n`, { mode: 0o600 });
  fs.chmodSync(cachePath, 0o600);
  return { ...catalog, source: "cli" };
}

export function billingPoolForModel(id) {
  return id.startsWith("composer-") ? "first-party" : "api";
}

export function resolveCursorModel({ catalog, model, effort = "default" }) {
  const requested = String(model ?? "");
  const models = Array.isArray(catalog) ? catalog : catalog.models;
  const identifiers = new Set(models.map((item) => item.id));
  const effortToken = "(?:none|minimal|low|medium|high|xhigh|extra-high|max)";
  const inputError = () => {
    const base = requested.replace(new RegExp(`-${effortToken}(?:-fast)?$`), "").replace(/-fast$/, "");
    const variants = [...identifiers].filter((id) => id === base || id.startsWith(`${base}-`));
    const error = new Error(`Unknown Cursor model ${requested}. Available variants for ${base}: ${variants.join(", ") || "none"}`);
    error.failureKind = "input";
    throw error;
  };
  if (requested === "auto" || requested === "default") {
    inputError();
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
    inputError();
  }
  return { variant, effortApplied, billingPool: billingPoolForModel(variant) };
}
