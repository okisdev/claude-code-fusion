import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const repoRoot = path.resolve(import.meta.dirname, "../..");
export const goModels = [
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", limit: { context: 1048576 }, capabilities: { tools: true, reasoning: { effort: ["low", "medium", "high"] } } },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", limit: { context: 202752 }, capabilities: { tools: true, reasoning: { effort: ["medium", "high"] } } },
  { id: "text-only", name: "Text Only", limit: { context: 32000 }, capabilities: { tools: false } }
];
export const goApiModels = goModels.map(({ capabilities, ...model }) => ({ ...model,
  capabilities: { tools: { supported: capabilities.tools }, ...(capabilities.reasoning ? { reasoning: { supported: true, ...capabilities.reasoning } } : {}) } }));
export const bundledCatalog = { models: [{
  slug: "gpt-5.5", display_name: "GPT-5.5", description: "Bundled model.",
  context_window: 272000, max_context_window: 272000, auto_compact_token_limit: 200000,
  apply_patch_tool_type: "freeform", web_search_tool_type: "text", input_modalities: ["text", "image"],
  truncation_policy: { mode: "bytes", limit: 10000 }, prefer_websockets: true, use_responses_lite: true,
  supports_parallel_tool_calls: true, supports_reasoning_effort_updates: true, support_verbosity: true,
  supports_reasoning_summary_parameter: true, supports_image_detail_original: true, default_reasoning_summary: "auto",
  supported_reasoning_levels: [{ effort: "high", description: "High reasoning." }], default_reasoning_level: "medium",
  experimental_supported_tools: ["image_generation"], service_tiers: ["priority"], additional_speed_tiers: ["fast"],
  tool_mode: "responses", multi_agent_version: "v2", multi_agent_reasoning_effort: "high", available_in_plans: ["pro"], comp_hash: "bundled-hash",
  base_instructions: "Keep these bundled instructions.", shell_type: "shell_command", visibility: "list", priority: 0
}] };
export const goUsage = {
  rolling: { percent: 20, resetsAt: "2026-11-19T04:00:00Z" },
  weekly: { percent: 75, resetsAt: "2026-11-23T00:00:00Z" },
  monthly: { percent: 50, resetsAt: "2026-12-01T00:00:00Z" }
};
export const goApiUsage = { usage: goUsage };

export function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-test-")));
  const dataDir = path.join(root, "data");
  const cwd = path.join(root, "workspace");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }));
  return { root, dataDir, cwd };
}

export function harness(t, extraEnv = {}) {
  const box = sandbox(t);
  const plugin = path.join(box.root, "plugin");
  fs.cpSync(path.join(repoRoot, "plugins/opencode/scripts"), path.join(plugin, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "opencode", version: "0.0.0-test" }));
  const home = path.join(box.root, "home");
  fs.mkdirSync(home);
  const companion = path.join(plugin, "scripts/opencode-companion.mjs");
  const env = {
    PATH: process.env.PATH, HOME: home, TMPDIR: box.root,
    OPENCODE_COMPANION_DATA: box.dataDir, OPENCODE_CODEX_BIN: path.join(repoRoot, "tests/fake-opencode-codex"),
    OPENCODE_GO_API_KEY: "opencode-test-credential", OPENCODE_COMPANION_WAIT_POLL_MS: "10",
    FAKE_OPENCODE_LOG: path.join(box.root, "codex.jsonl"), FAKE_OPENCODE_FETCH_LOG: path.join(box.root, "fetch.jsonl"),
    NODE_OPTIONS: `--import=${path.join(repoRoot, "tests/fixtures/opencode-fetch.mjs")}`,
    ...extraEnv
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const run = (args, input = "") => spawnSync(process.execPath, [companion, ...args], { env, cwd: box.cwd, input, encoding: "utf8", timeout: 30000 });
  const logs = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const jobs = () => {
    const state = path.join(box.dataDir, "state");
    if (!fs.existsSync(state)) return [];
    return fs.readdirSync(state).flatMap((workspace) => {
      const dir = path.join(state, workspace, "jobs");
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))) : [];
    });
  };
  return { ...box, env, companion, plugin, run, jobs, invocations: () => logs(env.FAKE_OPENCODE_LOG), requests: () => logs(env.FAKE_OPENCODE_FETCH_LOG) };
}
