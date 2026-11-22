# OpenCode companion contract

This document is the OpenCode instance of the engine agnostic [companion contract](companion-contract.md). It pins how the OpenCode plugin runs bulk generation on the user's OpenCode Go subscription: the harness, the private Codex home and generated model catalog, the credential boundary, roles and models, quota, failure classification, and the residual boundaries. The provider settings and sandbox observations below come from live probes against OpenCode Go with Codex CLI `0.171.0` on macOS.

## Role in Fusion

OpenCode Go is a prepaid subscription that serves open weight models (DeepSeek, GLM, Kimi, MiniMax, Qwen and others) against one monthly allowance. Fusion uses it as the bulk lane: high volume generation whose acceptance is a verification command the main session reruns, so correctness comes from the check rather than the model. It owns two protected roles.

- `bulk` writes files inside an orchestrator owned worktree and runs the brief's verification command there. Default model `deepseek-v4.1-flash`.
- `blind-check` is read only. It answers a staged artifact whose answers were removed, so the main session can diff its answers against the generated keys. Default model `glm-5.3-flash`, a family other than the `bulk` default.

A brief header names its role with `opencode-role: <role>`. OpenCode is never seated on a panel, a review, or an `independence` consult, and it is never a general implementation lane: a healthy OpenCode lane does not satisfy the `no-healthy-lane` gate for ordinary implementation.

## Harness

The companion drives the Codex CLI, resolved as `codex` on `PATH` or from `OPENCODE_CODEX_BIN`, because Codex's `workspace-write` sandbox confines shell writes to the workspace (a probe write outside it fails with `Operation not permitted`). The opencode CLI is not used: it has no sandbox. The tested Codex interval is the one pinned for the Codex plugin; the recorded version field is `codexVersion`.

Every run executes `codex exec --json --sandbox <mode> --cd <cwd> --skip-git-repo-check -m <model> -c model_reasoning_effort=<effort> -c 'model_providers.opencode.http_headers={"x-opencode-session"="<job id>"}' <brief>` with stdin closed. `bulk` uses `workspace-write`; `blind-check` uses `read-only`. The session header value is the job id, never a repository name or path.

## Private Codex home

`CODEX_HOME` is `<data>/codex-home`, owned by the companion and shared by every job. It isolates the user's `~/.codex` configuration, MCP servers, skills and profiles from the run, and keeps OpenCode rollouts out of the Codex plugin's quota telemetry, which reads the newest rollouts under the user's Codex home. The companion writes `config.toml` there before each run:

```toml
model_provider = "opencode"
model_catalog_json = "<data>/codex-home/model-catalog.json"

[model_providers.opencode]
name = "OpenCode Go"
base_url = "https://opencode.ai/inference/go/v1"
env_key = "OPENCODE_GO_API_KEY"
wire_api = "responses"

[shell_environment_policy]
exclude = ["OPENCODE_*"]
```

No `auth.json` is needed; the provider authenticates with `env_key`.

## Model catalog

Codex treats a model missing from its catalog with fallback metadata: a 272000 token context ceiling and tool output truncated at 10 KB. A probe run on that fallback compacted nine times in sixteen minutes and wrote nothing. The companion therefore generates `model-catalog.json` from the installed binary's own catalog, `codex debug models --bundled`, regenerating it whenever `codexVersion` changes. Each OpenCode model is the bundled `gpt-5.5` entry with exactly these fields replaced:

| Field | Value |
|---|---|
| `slug`, `display_name` | the Go model id and name |
| `description` | `<name> through OpenCode Go.` |
| `context_window`, `max_context_window` | the Go model's `limit.context` |
| `auto_compact_token_limit` | `null` |
| `apply_patch_tool_type` | `freeform` (the 0.171.0 parser rejects any other value) |
| `web_search_tool_type`, `input_modalities` | `text`, `["text"]` |
| `truncation_policy` | `{ "mode": "tokens", "limit": 10000 }` |
| `prefer_websockets`, `use_responses_lite`, `supports_parallel_tool_calls`, `supports_reasoning_effort_updates`, `support_verbosity`, `supports_reasoning_summary_parameter`, `supports_image_detail_original` | `false` |
| `default_reasoning_summary` | `none` |
| `supported_reasoning_levels`, `default_reasoning_level` | the Go model's `capabilities.reasoning.effort` values, default `high` |
| `experimental_supported_tools`, `service_tiers`, `additional_speed_tiers` | `[]` |

and `tool_mode`, `multi_agent_version`, `multi_agent_reasoning_effort`, `available_in_plans`, and `comp_hash` removed. A bundled catalog without `gpt-5.5` fails preflight as `setup`. The catalog lists the models of the Go model listing that support tools.

## Credential

The key is `OPENCODE_GO_API_KEY` from the companion's environment when it is set and not blank, otherwise the `opencode-go` entry of the opencode CLI's credential store, `$XDG_DATA_HOME/opencode/auth.json` (default `~/.local/share/opencode/auth.json`), which `opencode auth login` writes as `{ "opencode-go": { "type": "api", "key": "..." } }`. Any other entry type, a blank key, or an unreadable or malformed file counts as no key. The companion reads the store and never writes it. It passes the key to the Codex child as `OPENCODE_GO_API_KEY`, never writes it to disk, a job record, or a log, and never prints it. The generated `shell_environment_policy` keeps it out of every shell command the model runs; without that exclusion Codex passes the full environment to tool subprocesses. A missing key fails before launch as `auth`.

## Models and quota

`models --json` reads `GET https://opencode.ai/inference/go/v1/models` (cached for one hour at `<data>/models-cache.json`) and lists the models whose `capabilities.tools.supported` is `true`, taking `limit.context` and `capabilities.reasoning.effort` from each `data[]` entry. Every request to the Go API carries `x-opencode-session`.

`quota --json` reads `GET https://opencode.ai/inference/go/v1/usage` with the key, whose body is `{ usage: { rolling, weekly, monthly } }` with `percent` and `resetsAt` per window, and reports three pools, all named `opencode` with cost class `included`: `rolling` (300 minute window, pacing null because the window starts at first use), `weekly` (resets Monday 00:00 UTC), and `monthly`, each from that window's `percent` and `resetsAt`. Without a key the result is `available: false` with a note. Setup advises turning off Extra Usage in the OpenCode console, because with it on the pool silently bills a pay as you go balance and stops being `included`.

## Failure kinds

Failure classification of the Codex event stream follows the [Codex contract](codex-contract.md). On top of it, HTTP 401 or 403 from the provider is `auth`, a Go usage or allowance limit is `quota`, and HTTP 429 is `rate_limited`. Quota and rate limit failures carry `billingPool: "opencode"`; every other engine scoped kind closes only the OpenCode engine, never Codex.

## Residual boundaries

- Prompts, workspace content read by tools, and results pass through OpenCode's gateway to the serving model vendor under the retention terms the Go documentation lists per model. Never delegate secrets or credentials to this lane.
- Repository instructions (`AGENTS.md`) still load, as they do for Codex.
- Reads outside the workspace remain possible under `workspace-write`; the sandbox confines writes, not reads.
