# Devin companion contract

This document is the Devin instance of the engine agnostic [companion contract](companion-contract.md). It pins how the Devin plugin drives the Devin CLI headlessly over the Agent Client Protocol: binary resolution, the private home and per job configuration that isolate every run, session setup, model and effort resolution, tool and sandbox policy, the protocol stream, process supervision, failure classification, the job record, session continuity, review output, and the residual boundaries the adapter cannot close. The contract was verified against Devin CLI `3000.11.228` on macOS by live probes on a Devin Pro account.

## Role in Fusion

Devin is a multi family harness: one CLI, one Devin account, and one plan allowance serving Cognition's SWE models and models from Anthropic, OpenAI, Google, Moonshot, Zhipu, Meta, DeepSeek, xAI, and NVIDIA. It fills the same breadth seat as Cursor, and Fusion routes to exactly one of the two: the breadth engine selected with `/fusion:config set-breadth <cursor|devin>`. The selected engine owns two protected roles. `diversity` runs a read only consult on a model family that no other installed lane serves. `burst` runs bounded implementation on Cognition's SWE models inside orchestrator owned worktrees when the Codex slot is occupied. A Devin brief header names its role with `devin-role: <role>` or `lane: devin <role>`. Fusion routed dispatches always carry an explicit model and effort from the routing table; direct `/devin:*` commands without `--model` use the account's default model.

## Binary and version

The companion resolves the CLI as `devin` on `PATH`; `DEVIN_BIN` overrides the path, which the test suite uses for its fake CLI. Preflight runs `devin --version`, which prints `devin <version> (<commit>)`, and records the version as `devinVersion` and the resolved executable path as `devinBuildPath` on every job. The tested interval is `[3000.11, 3000.12)` by major and minor version. A build below the floor fails preflight as `setup`; a build at or past the ceiling runs and `/devin:setup` reports it as newer than the tested interval. The generated configuration disables background auto update, so a build change between jobs is visible through the recorded version rather than assumed away.

## Private home and configuration

The Devin CLI reads configuration, rules, skills, hooks, MCP servers, and plugins from the home directory and imports them from other tools: `~/.config/devin`, `~/.config/cognition/skills`, `~/.agents/skills`, `~/.claude`, `~/.claude.json`, `~/.codeium`, `~/.copilot`, `~/.config/opencode`, `~/.config/zed`, and personal plugins and MCP servers from the Devin Cloud account. The companion therefore runs every job with `HOME` and the XDG base directories pointing at directories it owns.

- `HOME` is `<data>/home`, shared by every job and otherwise empty, so no home scoped source exists.
- `XDG_DATA_HOME` is `<data>/home/.local/share`, shared by every job. It holds the CLI's session database (`devin/cli/sessions.db`), logs, and session locks, which is what lets `session/load` resume a session in a later job. `devin/credentials.toml` inside it is a symbolic link to the real user's credentials file (`$XDG_DATA_HOME/devin/credentials.toml`, else `~/.local/share/devin/credentials.toml`). The companion never reads or copies the credential.
- `XDG_STATE_HOME` and `XDG_CACHE_HOME` are `<data>/home/.local/state` and `<data>/home/.cache`.
- `XDG_CONFIG_HOME` is `<data>/runs/<job-id>/config`, private to the job. It contains `devin/config.json`, generated per mode, and `devin/mcp_config.json` with an empty `mcpServers` object.

The generated `config.json` sets `auto_update` to `false`, `attribution` to `false`, `subagents_enabled` to `false`, `notify` to `"never"`, and `read_config_from` with `agents_standard` `true` and `cursor`, `windsurf`, `claude`, `copilot`, `opencode`, `zed`, and `cloud` all `false`. `permissions.ask` is empty. `permissions.deny` holds `Fetch(*)` and a `Read(<path>/**)` rule for each sensitive directory of the real user's home: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.config`, `.local/share`, `.claude`, `.codex`, `.grok`, `.cursor`, `.devin`, `Library/Keychains`, and `Library/Application Support`, plus `Read(<home>/.netrc)`, `Read(<home>/.npmrc)`, and `Read(<home>/.git-credentials)`. Consult and review add `edit` and `exec` to `permissions.deny`. Write mode sets `permissions.allow` to `["Write(<cwd>/**)"]`, and for a linked worktree also the worktree's own Git directory; the repository's Git common directory stays read only.

The child environment inherits only `PATH`, `LANG`, `LANGUAGE`, `TERM`, `COLORTERM`, `TMPDIR`, `TZ`, `USER`, `LOGNAME`, `SHELL`, every `LC_*` variable, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` (and their lowercase forms), and the toolchain roots listed in the Cursor contract. `DEVIN_MODEL`, `DEVIN_REFUSAL_FALLBACK`, `DEVIN_PERMISSION_MODE`, and every other `DEVIN_*` variable are never inherited, because each would change the model or the permission posture outside the companion's control. The companion sets `RUST_LOG=error` and, in write mode, `DEVIN_SANDBOX=true`.

Live probes confirmed that with this layout the credential loads through the link, the user's own hooks and configuration do not load, a workspace `CLAUDE.md` is not read while a workspace `AGENTS.md` is, and a session created by one job resumes in another.

## Invocation

Every run executes `devin acp` with the workspace as its working directory and speaks JSON-RPC 2.0 over newline delimited stdio. The companion is the ACP client and sends, in order:

1. `initialize` with `protocolVersion: 1` and `clientCapabilities` `{ fs: { readTextFile: false, writeTextFile: false }, terminal: false }`. The agent must answer with `protocolVersion: 1`.
2. `session/new` with `{ cwd, mcpServers: [] }`, or `session/load` with `{ sessionId, cwd, mcpServers: [] }` when resuming. The result carries `sessionId` (a slug such as `artistic-breeze`) and `configOptions`.
3. `session/set_config_option` for `mode`, then `model`, then `thought_level`, then `speed` when present, as described below. Each result returns the updated `configOptions`; the companion verifies every `currentValue` it set and fails before prompting when one differs.
4. `session/prompt` with `{ sessionId, prompt: [{ type: "text", text: <brief> }] }`. The brief travels only inside this message, never in process arguments or files the CLI can see.

After the prompt result arrives the companion closes stdin, and the CLI exits. The companion never passes `--cloud`, `--agent-type`, `--model`, or `--refusal-fallback`.

| Mode | `DEVIN_SANDBOX` | `mode` option | Tools the companion accepts |
|---|---|---|---|
| consult | unset | `ask` | `read`, `grep`, `glob`, `find_file_by_name`, `notebook_read`, `todo_write` |
| review | unset | `ask` | the consult list |
| write | `true` | `autonomous` | the consult list plus `edit`, `write`, `notebook_edit`, `exec`, `get_output`, `kill_shell`, `write_to_process` |

Every `session/request_permission` request from the agent is answered `{ outcome: { outcome: "cancelled" } }`, so any action that the configuration and the sandbox do not already allow is refused rather than prompted. The tool name of a `tool_call` update is `_meta["cognition.ai/inferenceToolName"]`; a `tool_call` naming a tool outside the mode's list (`web_search`, `webfetch`, `mcp_*`, `skill`, `request_scope`, `run_subagent`, and anything new) terminates the process group and fails the job as `policy`. In write mode the OS sandbox (Seatbelt on macOS, bubblewrap on Linux) confines shell writes to the workspace and granted `Write(...)` scopes, and the CLI fails closed when the sandbox cannot start.

Live probes of this build confirmed: in consult mode a file write and a shell command are refused and the agent continues; in write mode a write tool edit and a shell write inside the workspace succeed without a permission request, a shell write outside the workspace fails inside the sandbox, a write tool edit outside the workspace raises a permission request that the companion's refusal blocks, an outbound network connection from a shell raises a network permission request that the refusal blocks, and a shell read that matches a `Read(...)` deny rule is refused and ends the turn with `cause: "tool_rejected"`. A shell read of an unlisted path under the real home succeeds, which is why the deny list exists.

## Models

`devin models list --format json` prints `{ families: [{ family_label, family_uid, slug, aliases, variants: [{ model_uid, label, description, cost_summary, is_new, is_beta }] }] }`. The companion caches the parsed catalog at `<data>/models-cache.json` for one hour and exposes it through `models --json`, listing each family slug with its display name.

The account's usable models are the `model` option of the new session's `configOptions`: one value per family, which is that family's default variant uid (for example `kimi-k3-high`, `glm-5-2`, `swe-2-high`, `muse-wonder-1-0-high`). Effort is a separate `thought_level` option whose values depend on the selected model (for example `low`, `high`, `max` for Kimi K3 and `minimal` through `max` for Muse Wonder), and some models expose a `speed` option of `standard` or `fast`.

Resolution of a requested model and effort:

1. The requested model may be a family slug (`kimi-k3`, `glm-5.2`, `swe-2`), a family alias, or a variant uid. A name that matches no catalog family fails before job creation as `input` and lists the catalog's families. Inside the run, the companion selects the session `model` option whose value is one of that family's variant uids; a family the account cannot use has no such option and fails the job as `setup`, listing the account's usable families.
2. After setting the model, `default` effort leaves `thought_level` at the model's default; any other effort must be one of the `thought_level` values, and an effort the model does not offer fails the job as `input` listing the offered values. A model without a `thought_level` option records `effortApplied: false`.
3. `speed` is always set to `standard` when offered, because `fast` bills at a multiple of the list price.
4. `adaptive` and every `fusion-*` pairing are refused as `input`, because they route to models the session does not pin.

The agent reports the model that served the turn in `_cognition.ai/agent_stopped` (`stats.modelLabel`) and `_cognition.ai/turn_stats`. The companion records it as `observedModel`; when it differs from the selected option's display name the companion renders a `model_mismatch` warning and keeps the transport outcome. `billingPool` is `first-party` for `swe-*` models and `api` for every other model.

## Protocol stream

Stdout carries JSON-RPC responses to the companion's requests, `session/update` notifications, agent requests (`session/request_permission`), and Cognition extension notifications whose methods start with `_cognition.ai/`. The companion handles:

- `session/update` with `sessionUpdate` `agent_message_chunk` (`content.text`): appended to the result text, but only for chunks that arrive after `session/prompt` was sent, because `session/load` replays the earlier conversation as chunks first.
- `tool_call` and `tool_call_update`: checked against the tool policy and counted.
- `usage_update`: ignored; usage comes from the prompt result.
- `_cognition.ai/agent_stopped` with `params.cause` (`complete`, `tool_rejected`, `auth_required`, and others) and `params.stats` (`modelLabel`, `toolCalls`, `filesChanged`, `commandsRun`, `inputTokens`, `outputTokens`, `totalTimeMs`, `requestId`).
- Everything else (`agent_thought_chunk`, `plan`, `config_option_update`, `current_mode_update`, `available_commands_update`, `session_info_update`, other `_cognition.ai/*` notifications) is ignored.

The `session/prompt` result is `{ stopReason, usage: { totalTokens, inputTokens, outputTokens, cachedReadTokens? } }`. A successful run has `stopReason: "end_turn"` and an `agent_stopped` cause of `complete`. The job records `usage` exactly as reported, without zero filling an absent `cachedReadTokens`, and never reports cost. A JSON-RPC error on any request carries `{ code, message, data? }` and is classified below. Malformed stdout lines, a response for an unknown request id, a missing `sessionId`, or an exit before the prompt result fail the job as `protocol`. Stderr is diagnostic log output only.

## Process supervision

`devin acp` is a native executable started in its own process group; shell commands it runs are its descendants. After the prompt result the companion closes stdin and waits up to `DEVIN_COMPANION_EXIT_GRACE_MS` (default 15000) for exit, then sends `SIGTERM` to the group and `SIGKILL` after five more seconds, recording a `late_close` warning while keeping the transport outcome. The run timeout is `DEVIN_COMPANION_TIMEOUT_MS` (default 540000). A timeout or cancellation first sends `session/cancel` and then terminates the group with the same escalation. Cancellation, signal forwarding, died detection, pidless grace, process identity verification, the background worker's pid wait, and owner signal forwarding follow the Cursor contract unchanged; the identity recorded at spawn is the CLI itself, so no refresh is needed.

## Failure kinds

| Kind | Evidence |
|---|---|
| `missing_cli` | the executable cannot be found or spawned |
| `setup` | the version is below the floor or unparseable, `initialize` returns a protocol version other than 1, the sandbox cannot start, or a requested model is not among the account's usable models |
| `auth` | `agent_stopped` cause `auth_required`, or an error message containing `log in`, `not logged in`, `unauthorized`, or HTTP 401 or 403 |
| `quota` | usage limit, quota, allowance, spend limit, insufficient credit, or HTTP 402 text |
| `rate_limited` | rate limit, too many requests, or HTTP 429 text |
| `network` | DNS failure, connection refused or reset, or fetch failure before the prompt result |
| `permission` | `agent_stopped` cause `tool_rejected`, meaning a deny rule refused a tool call and the agent ended the turn |
| `policy` | a tool outside the mode's list appeared in the stream |
| `refused` | `stopReason: "refusal"`; the breaker ignores it, as for Codex |
| `protocol` | malformed stream, unexpected response id, or an exit before the prompt result |
| `timeout` | the run timeout elapsed and the group was terminated |
| `process` | an unexpected signal the companion did not request |
| `cancelled`, `died`, `input`, `resource`, `error` | as defined by the shared contract |

Quota and rate limit failures carry the job's `billingPool`. Authentication, missing CLI, setup, sandbox, protocol, permission, and policy failures are engine wide.

## Job record

Records live at `<data>/state/<workspace>/jobs/<id>.json`, where `<data>` is `DEVIN_COMPANION_DATA` or `~/.claude/plugins/data/devin-claude-code-fusion`, and follow the Cursor companion's record shape with `engine: "devin"`. Devin specific fields are `devinVersion`, `devinBuildPath`, `sessionId`, `requestId`, `requestedModel`, `resolvedModel` (the session option value), `observedModel`, `requestedEffort`, `effortApplied`, `billingPool`, `mode`, `role`, `usage`, `stopCause` (the `agent_stopped` cause), `configDir`, and `warnings`. The footer session line is `devin-session: <session-id>`.

## Sessions

Sessions live in the shared session database, so `--resume <session-id>` and `--resume-last` call `session/load` on the parent job's session, and resume only a terminal job of the same workspace and mode. A resumed session keeps its model unless the request names one. `--fresh` ignores continuity. A job's config directory is removed when the job reaches a terminal status. A sweep at task start and SessionEnd removes run directories without job records once they are older than one hour, at most once every 10 minutes per data root. The CLI owns retention of its session database.

## Review

`review` collects the working tree diff or branch range the same way the Cursor companion does, interpolates it into `plugins/devin/prompts/review.md`, and runs a review mode job. The reply must contain one JSON object with `verdict` (`approve` or `request_changes`), `summary`, and `findings` (each with `severity`, `file`, `line`, `title`, and `body`); a missing or invalid object fails the review as `error`.

## Commands

`plugins/devin/scripts/devin-companion.mjs` implements the same subcommands, options, raw arguments transport, and internal workers as the Cursor companion, with `devin` in place of `cursor` in every name, environment variable, and footer. `setup` reports the binary path, the version against the tested interval, authentication from `devin auth status`, the plan tier, the catalog refresh, and the project configuration advisory for the working directory. Defaults: `DEVIN_COMPANION_TIMEOUT_MS` 540000, `DEVIN_COMPANION_EXIT_GRACE_MS` 15000, and the pidless grace and wait variables under the `DEVIN_COMPANION_` prefix with the Cursor defaults.

## Residual boundaries

- Project scoped sources still load: `AGENTS.md`, `AGENTS.local.md`, `AGENT.md`, `.windsurfrules`, and project skills under `.devin/skills`, `.cognition/skills`, and `.agents/skills`. They are the repository's own instructions, as they are for Codex.
- A project `.devin/config.json`, `.devin/config.local.json`, `.devin/mcp_config.json`, or `.devin/mcp_config.local.json` still loads and can add permissions, hooks, MCP servers, or re-enable imports. The companion detects these files before launch and renders a `warning:` line naming them.
- Organization level team settings (model allowlist, enforced permissions, sandbox enforcement) are delivered by Devin's backend and apply to every session.
- Reads outside the deny list remain possible for the agent's own read tool and for shell commands. The deny list covers credential and agent configuration locations, not the whole home directory.
- Prompts, workspace content read by tools, and results pass through Devin's backend to the serving model vendor. Never delegate secrets or credentials to this lane.
- The tool policy is checked when the tool call is announced; a forbidden tool is detected and terminated, not prevented.
