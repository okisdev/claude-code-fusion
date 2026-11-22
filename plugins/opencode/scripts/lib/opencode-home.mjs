import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirectories } from "./private-home.mjs";
import { writePrivateStateFile } from "./companion-state.mjs";
import { errorWithFailure } from "./companion-commands.mjs";
import { GO_API_BASE_URL } from "./opencode-provider.mjs";

export function buildModelCatalog(bundled, models) {
  const entries = Array.isArray(bundled) ? bundled : bundled?.models;
  const template = Array.isArray(entries) ? entries.find((model) => model?.slug === "gpt-5.5") : null;
  if (!template) throw errorWithFailure("The bundled Codex catalog is missing gpt-5.5. Upgrade or repair Codex.", "setup");
  return { models: models.filter((model) => model.capabilities?.tools === true).map((model) => {
    const effort = model.capabilities.reasoning?.effort ?? [];
    const entry = { ...template,
      slug: model.id, display_name: model.name, description: `${model.name} through OpenCode Go.`,
      context_window: model.limit.context, max_context_window: model.limit.context, auto_compact_token_limit: null,
      apply_patch_tool_type: "freeform", web_search_tool_type: "text", input_modalities: ["text"],
      truncation_policy: { mode: "tokens", limit: 10000 },
      prefer_websockets: false, use_responses_lite: false, supports_parallel_tool_calls: false,
      supports_reasoning_effort_updates: false, support_verbosity: false, supports_reasoning_summary_parameter: false,
      supports_image_detail_original: false, default_reasoning_summary: "none",
      supported_reasoning_levels: effort.map((value) => ({ effort: value, description: template.supported_reasoning_levels?.find((level) => level.effort === value)?.description ?? value })),
      default_reasoning_level: "high", experimental_supported_tools: [], service_tiers: [], additional_speed_tiers: []
    };
    for (const field of ["tool_mode", "multi_agent_version", "multi_agent_reasoning_effort", "available_in_plans", "comp_hash"]) delete entry[field];
    return entry;
  }) };
}

export function ensurePrivateHome({ dataDir, bin, codexVersion, models, env = process.env, run = spawnSync }) {
  const homeDir = path.join(dataDir, "codex-home");
  const catalogPath = path.join(homeDir, "model-catalog.json");
  const stampPath = path.join(homeDir, "catalog-version.json");
  ensurePrivateDirectories([dataDir, homeDir]);
  let stamp;
  let catalog;
  try {
    stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
    catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  const modelSignature = JSON.stringify(models);
  if (stamp?.codexVersion !== codexVersion || stamp?.modelSignature !== modelSignature || !Array.isArray(catalog?.models)) {
    const result = run(bin, ["debug", "models", "--bundled"], { env: { ...env, CODEX_HOME: homeDir }, encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw errorWithFailure("Could not read the bundled Codex model catalog.", "setup");
    let bundled;
    try { bundled = JSON.parse(result.stdout); }
    catch { throw errorWithFailure("Codex returned an invalid bundled model catalog.", "setup"); }
    catalog = buildModelCatalog(bundled, models);
    writePrivateStateFile(catalogPath, `${JSON.stringify(catalog)}\n`);
    writePrivateStateFile(stampPath, `${JSON.stringify({ codexVersion, modelSignature })}\n`);
  }
  const config = [
    'model_provider = "opencode"', `model_catalog_json = ${JSON.stringify(catalogPath)}`, "",
    "[model_providers.opencode]", 'name = "OpenCode Go"', `base_url = ${JSON.stringify(GO_API_BASE_URL)}`,
    'env_key = "OPENCODE_GO_API_KEY"', 'wire_api = "responses"', "",
    "[shell_environment_policy]", 'exclude = ["OPENCODE_*"]', ""
  ].join("\n");
  writePrivateStateFile(path.join(homeDir, "config.toml"), config);
  return { homeDir, catalogPath, catalog };
}
