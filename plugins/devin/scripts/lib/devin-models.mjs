import { createModelCatalog } from "./model-catalog.mjs";

function invalidCatalog() {
  throw new Error("Invalid Devin model catalog.");
}

function nonemptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function parseModelsJson(text) {
  const catalog = JSON.parse(text);
  if (!catalog || !Array.isArray(catalog.families)) invalidCatalog();
  return { families: catalog.families.map((family) => {
    if (!family || !nonemptyString(family.family_label) || !nonemptyString(family.family_uid)
      || !nonemptyString(family.slug) || !Array.isArray(family.aliases)
      || !family.aliases.every((alias) => nonemptyString(alias)) || !Array.isArray(family.variants)) invalidCatalog();
    return {
      slug: family.slug,
      label: family.family_label,
      aliases: family.aliases,
      variants: family.variants.map((variant) => {
        if (!variant || !nonemptyString(variant.model_uid) || !nonemptyString(variant.label)) invalidCatalog();
        return {
          uid: variant.model_uid, label: variant.label,
          ...(typeof variant.cost_tier === "string" ? { cost_tier: variant.cost_tier } : {}),
          ...(Number.isSafeInteger(variant.max_context_tokens) && variant.max_context_tokens > 0 ? { max_context_tokens: variant.max_context_tokens } : {})
        };
      })
    };
  }) };
}

export const readModelCatalog = createModelCatalog({
  key: "families",
  args: ["models", "list", "--format", "json"],
  directoryMode: 0o700,
  parse: (result) => parseModelsJson(result.stdout).families,
  fail(result) {
    const error = new Error(`Devin model listing failed: ${String(result.error?.message || result.stderr || result.stdout || "unknown error").trim()}`);
    error.failureKind = result.error?.code === "ENOENT" ? "missing_cli" : "error";
    throw error;
  }
});

function inputError(message) {
  const error = new Error(message);
  error.failureKind = "input";
  return error;
}

export function isPinnableFamily(family) {
  const slug = family.slug.toLowerCase();
  return slug !== "adaptive" && !slug.startsWith("fusion") && !family.variants.some((variant) => variant.uid.toLowerCase().startsWith("fusion"));
}

export function pairingForModel(requested) {
  const match = /^fusion-(.+)-sidekick-(swe-2-.+)$/.exec(String(requested ?? "").toLowerCase());
  return match ? { planner: match[1], sidekick: match[2] } : null;
}

export function findCatalogFamily(catalog, requested, { write = false } = {}) {
  const name = String(requested ?? "").toLowerCase();
  const families = catalog.families;
  const pairing = name.startsWith("fusion") ? pairingForModel(name) : null;
  if (["adaptive", "default", "auto"].includes(name) || name.startsWith("fusion") && !pairing) {
    throw inputError(`Devin model ${requested} cannot be pinned.`);
  }
  if (pairing) {
    const owner = families.find((item) => item.variants.some((variant) => variant.uid.toLowerCase() === name));
    const claudePlanner = pairing.planner === "claude" || pairing.planner.startsWith("claude-");
    if (!write || claudePlanner || !owner) {
      throw inputError(`Devin model ${requested} cannot be pinned.`);
    }
    return owner;
  }
  const family = families.find((item) => [item.slug, ...item.aliases, ...item.variants.map((variant) => variant.uid)]
    .some((value) => value.toLowerCase() === name));
  if (!family) throw inputError(`Unknown Devin model ${requested}. Available families: ${families.map((item) => item.slug).join(", ")}`);
  if (!isPinnableFamily(family)) {
    throw inputError(`Devin model ${requested} cannot be pinned.`);
  }
  return family;
}

export function createSelectionResolver({ family, effort = "default" }) {
  const resolver = ({ stage, configOptions }) => {
    if (stage === "model") {
      const model = configOptions.find((item) => item.id === "model");
      const selected = model?.options?.find((option) => family.variants.some((variant) => variant.uid === option.value));
      if (selected) return [{ configId: "model", value: selected.value }];
      const offered = model?.options?.map((option) => option.name).join(", ") || "none";
      const error = new Error(`Devin model ${family.slug} is unavailable. Account models: ${offered}`);
      error.failureKind = "setup";
      throw error;
    }
    if (stage !== "effort") throw new Error(`Unknown Devin selection stage: ${stage}`);
    resolver.effortApplied = false;
    const changes = [];
    if (effort !== "default") {
      const thought = configOptions.find((item) => item.id === "thought_level");
      if (!thought?.options?.some((option) => option.value === effort)) {
        throw inputError(`Devin model ${family.slug} does not offer effort ${effort}. Offered values: ${thought?.options?.map((option) => option.value).join(", ") || "none"}`);
      }
      changes.push({ configId: "thought_level", value: effort });
      resolver.effortApplied = true;
    }
    const speed = configOptions.find((item) => item.id === "speed");
    if (speed && speed.currentValue !== "standard") changes.push({ configId: "speed", value: "standard" });
    return changes;
  };
  resolver.effortApplied = false;
  return resolver;
}

export function createSpeedResolver() {
  const resolver = ({ stage, configOptions }) => {
    if (stage !== "effort") return [];
    const speed = configOptions.find((item) => item.id === "speed");
    return speed && speed.currentValue !== "standard" ? [{ configId: "speed", value: "standard" }] : [];
  };
  resolver.effortApplied = false;
  return resolver;
}

function poolForCostTier(tier) {
  return typeof tier === "string" && tier.toLowerCase() === "free" ? "free" : "credits";
}

export function billingPoolForModel(catalog, slugOrUid, effort = "default") {
  const name = String(slugOrUid ?? "").toLowerCase();
  for (const family of catalog.families) {
    const variant = family.variants.find((item) => item.uid.toLowerCase() === name);
    if (variant) return poolForCostTier(variant.cost_tier);
    if ([family.slug, ...family.aliases].some((value) => value.toLowerCase() === name)) {
      const suffix = `-${String(effort).toLowerCase()}`;
      const served = effort === "default" ? null : family.variants.find((item) => item.uid.toLowerCase().endsWith(suffix));
      return poolForCostTier((served ?? family.variants[0])?.cost_tier);
    }
  }
  return "credits";
}

export function costClassForPool(pool) {
  if (pool === "free" || pool === "first-party") return "free";
  return pool === "credits" ? "included" : "metered";
}
