import fs from "node:fs";
import path from "node:path";
import { buildAgyChildEnv, classifyAgyFailure, runAgy } from "./agy-exec.mjs";
import { prepareGeminiDirectory } from "./agy-home.mjs";
import { writePrivateStateFile } from "./state.mjs";

const EFFORTS = ["low", "medium", "high", "xhigh"];
export const DEFAULT_MODEL = "gemini-4-neon";

function inputError(message) {
  return Object.assign(new Error(message), { failureKind: "input" });
}

export function isGoogleModel(value) {
  return typeof value === "string" && value.startsWith("gemini-") && !value.startsWith("gemini-pro-orchestrator-");
}

export function resolveModelRequest(model, effort) {
  if (model != null && !isGoogleModel(model)) throw inputError(`Antigravity model ${model} cannot be pinned to a Google model.`);
  const suffix = model?.match(/-(low|medium|high|xhigh)$/);
  const selectedEffort = effort ?? suffix?.[1] ?? "default";
  if (selectedEffort !== "default" && !EFFORTS.includes(selectedEffort)) throw inputError(`Invalid Antigravity effort ${selectedEffort}. Offered values: ${EFFORTS.join(", ")}`);
  return { model: suffix ? model.slice(0, -suffix[0].length) : model ?? null, effort: selectedEffort };
}

export function usableModels(configOptions) {
  return (configOptions?.find((option) => option.id === "model")?.options ?? [])
    .filter((option) => isGoogleModel(option.value)).map((option) => ({ id: option.value, displayName: option.name || option.value }));
}

export function createSelectionResolver({ model = null, effort = "default", preserveModel = false } = {}) {
  const resolver = ({ stage, configOptions }) => {
    if (stage === "model") {
      const selected = model ?? (preserveModel ? configOptions?.find((option) => option.id === "model")?.currentValue : DEFAULT_MODEL);
      if (!isGoogleModel(selected)) throw inputError(`Antigravity model ${selected} cannot be pinned to a Google model.`);
      const offered = usableModels(configOptions);
      if (!offered.some((option) => option.id === selected)) {
        throw Object.assign(new Error(`Antigravity model ${selected} is unavailable. Account models: ${offered.map((option) => option.id).join(", ") || "none"}`), { failureKind: "setup" });
      }
      return [{ configId: "model", value: selected }];
    }
    if (stage !== "effort") throw new Error(`Unknown Antigravity selection stage: ${stage}`);
    resolver.effortApplied = false;
    const thought = configOptions?.find((option) => option.id === "thought_level");
    const offered = (thought?.options ?? []).map((option) => option.value).filter((value) => EFFORTS.includes(value));
    const selected = effort === "default" ? thought?.currentValue : effort;
    if (!offered.includes(selected)) throw inputError(`Antigravity does not offer effort ${selected}. Offered values: ${offered.join(", ") || "none"}`);
    resolver.effortApplied = effort !== "default";
    return [{ configId: "thought_level", value: selected }];
  };
  resolver.effortApplied = false;
  return resolver;
}

export async function readModelCatalog({ dataDir, bin, cwd = process.cwd(), env = buildAgyChildEnv(), maxAgeMs = 3600000, now = Date.now(), run = runAgy }) {
  const cachePath = path.join(dataDir, "models-cache.json");
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (Array.isArray(cached?.models) && cached.models.length > 0 && cached.models.every((model) => isGoogleModel(model?.id) && typeof model.displayName === "string")
      && Number.isFinite(cached.fetchedAt) && now >= cached.fetchedAt && now - cached.fetchedAt < maxAgeMs) {
      return { models: cached.models, source: "cache" };
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const { geminiDir } = prepareGeminiDirectory({ dataDir });
  const outcome = await run({ bin, cwd, env, geminiDir, mode: "consult", sessionOnly: true, timeoutMs: 60000 });
  const kind = classifyAgyFailure(outcome);
  if (kind) throw Object.assign(new Error(`Antigravity model listing failed: ${outcome.setupError || outcome.rpcError?.message || outcome.protocolError || outcome.stderrTail || kind}`), { failureKind: kind });
  const models = usableModels(outcome.configOptions);
  if (!models.length) throw Object.assign(new Error("Antigravity offers no usable Google models."), { failureKind: "setup" });
  writePrivateStateFile(cachePath, `${JSON.stringify({ models, fetchedAt: now })}\n`);
  return { models, source: "cli" };
}
