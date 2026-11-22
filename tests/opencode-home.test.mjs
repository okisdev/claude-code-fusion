import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildModelCatalog, ensurePrivateHome } from "../plugins/opencode/scripts/lib/opencode-home.mjs";
import { bundledCatalog, goModels, sandbox } from "./lib/opencode-harness.mjs";

test("catalog replaces the contract fields, removes incompatible metadata, and retains bundled instructions", () => {
  const catalog = buildModelCatalog(bundledCatalog, goModels);
  assert.equal(catalog.models.length, 2);
  for (const [index, model] of catalog.models.entries()) {
    const source = goModels[index];
    assert.equal(model.slug, source.id);
    assert.equal(model.display_name, source.name);
    assert.equal(model.description, `${source.name} through OpenCode Go.`);
    assert.equal(model.context_window, source.limit.context);
    assert.equal(model.max_context_window, source.limit.context);
    assert.equal(model.auto_compact_token_limit, null);
    assert.equal(model.apply_patch_tool_type, "freeform");
    assert.equal(model.web_search_tool_type, "text");
    assert.deepEqual(model.input_modalities, ["text"]);
    assert.deepEqual(model.truncation_policy, { mode: "tokens", limit: 10000 });
    for (const field of ["prefer_websockets", "use_responses_lite", "supports_parallel_tool_calls", "supports_reasoning_effort_updates", "support_verbosity", "supports_reasoning_summary_parameter", "supports_image_detail_original"]) assert.equal(model[field], false, field);
    assert.equal(model.default_reasoning_summary, "none");
    assert.equal(model.default_reasoning_level, "high");
    assert.deepEqual(model.supported_reasoning_levels.map((level) => level.effort), source.capabilities.reasoning.effort);
    for (const field of ["experimental_supported_tools", "service_tiers", "additional_speed_tiers"]) assert.deepEqual(model[field], []);
    for (const field of ["tool_mode", "multi_agent_version", "multi_agent_reasoning_effort", "available_in_plans", "comp_hash"]) assert.equal(Object.hasOwn(model, field), false, field);
    assert.equal(model.base_instructions, bundledCatalog.models[0].base_instructions);
  }
  assert.equal(bundledCatalog.models[0].prefer_websockets, true);
});

test("missing gpt-5.5 fails catalog preflight as setup", () => {
  for (const bundled of [null, {}, { models: {} }, { models: [{ slug: "gpt-5" }] }]) {
    assert.throws(() => buildModelCatalog(bundled, goModels), { failureKind: "setup", message: /gpt-5\.5/ });
  }
});

test("private Codex home writes the provider and shell exclusion, refreshes config, and regenerates catalog on version changes", (t) => {
  const box = sandbox(t);
  const invocations = [];
  const options = { dataDir: box.dataDir, bin: "fake-codex", codexVersion: "0.171.0", models: goModels, env: { PATH: "/test" }, run: (bin, args, opts) => {
    invocations.push({ bin, args, env: opts.env });
    return { status: 0, stdout: JSON.stringify(bundledCatalog) };
  } };
  const home = ensurePrivateHome(options);
  assert.equal(home.homeDir, path.join(box.dataDir, "codex-home"));
  assert.deepEqual(invocations[0].args, ["debug", "models", "--bundled"]);
  assert.equal(invocations[0].env.CODEX_HOME, home.homeDir);
  const configFile = path.join(home.homeDir, "config.toml");
  const config = fs.readFileSync(configFile, "utf8");
  assert.equal(config, [
    'model_provider = "opencode"', `model_catalog_json = ${JSON.stringify(home.catalogPath)}`, "",
    "[model_providers.opencode]", 'name = "OpenCode Go"', 'base_url = "https://opencode.ai/inference/go/v1"',
    'env_key = "OPENCODE_GO_API_KEY"', 'wire_api = "responses"', "", "[shell_environment_policy]", 'exclude = ["OPENCODE_*"]', ""
  ].join("\n"));
  fs.writeFileSync(configFile, "corrupted");
  ensurePrivateHome(options);
  assert.equal(invocations.length, 1);
  assert.equal(fs.readFileSync(configFile, "utf8"), config);
  ensurePrivateHome({ ...options, codexVersion: "0.172.0" });
  assert.equal(invocations.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home.homeDir, "catalog-version.json"), "utf8")).codexVersion, "0.172.0");
  ensurePrivateHome({ ...options, codexVersion: "0.172.0", models: goModels.slice(0, 1) });
  assert.equal(invocations.length, 3);
  assert.equal(fs.existsSync(path.join(home.homeDir, "auth.json")), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(home.homeDir).mode & 0o777, 0o700);
    for (const file of [configFile, home.catalogPath]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test("unusable bundled catalogs fail as setup", (t) => {
  const box = sandbox(t);
  for (const result of [{ status: 1 }, { error: new Error("unavailable") }, { status: 0, stdout: "bad json" }, { status: 0, stdout: '{"models":[]}' }]) {
    assert.throws(() => ensurePrivateHome({ dataDir: box.dataDir, bin: "fake", codexVersion: "0.171.0", models: goModels, env: {}, run: () => result }), { failureKind: "setup" });
  }
});
