# Cursor companion contract

This document is the Cursor instance of the engine agnostic [companion contract](companion-contract.md). It pins how the Cursor plugin drives the Cursor Agent CLI headlessly: binary resolution, the private home that isolates every run, per mode invocation, tool and sandbox policy, model resolution, the stream protocol, process supervision, failure classification, the job record, session continuity, review output, and the residual boundaries that the adapter cannot close. The contract was verified against Cursor Agent CLI build `2026.10.01-e373342` by reading its bundled source and by live probes on macOS.

## Role in Fusion

Cursor is a multi family harness: one CLI, one authentication domain, and one billing account serving models from several vendors. Fusion uses it for two protected roles. `diversity` runs a read only consult on a model family that no other installed lane serves, so the blind panel and independence checks gain a family that is neither the orchestrator's nor Codex's nor Grok's. `burst` runs bounded implementation packages on Cursor's own Composer model inside orchestrator owned worktrees when the Codex slot is occupied. A Cursor brief header names its role with `cursor-role: <role>` or `lane: cursor <role>`. Fusion routed dispatches always carry an explicit model and effort from the routing table; direct `/cursor:*` commands fall back to the model selected in the user's own `~/.cursor/cli-config.json`.

## Binary and version

The companion resolves the CLI as `cursor-agent`, never as the bare `agent` name, because other CLIs install an `agent` executable earlier on PATH (Grok does on macOS). `CURSOR_AGENT_BIN` overrides the path, which the test suite uses for its fake CLI. Preflight runs `cursor-agent --version`, which prints a build identifier of the form `YYYY.MM.DD-<hash>`, and records it on every job as `cursorVersion` together with the resolved executable path as `cursorBuildPath`. The tested interval is `[2026.10.01, 2026.11.01)` by build date. A build older than the floor fails preflight as `setup`; a build at or past the ceiling runs and `/cursor:setup` reports it as newer than the tested interval. The CLI updates itself on a timer two seconds after startup, so every managed run passes `--disable-auto-update`, and a build change between jobs is visible through the recorded build identity rather than assumed away.

## Private home

Cursor reads Claude Code, Codex, Grok, and Cursor configuration from fixed locations under the home directory regardless of `CURSOR_CONFIG_DIR`: `~/.claude/settings.json` hooks, `~/.claude` skills, agents, and plugin marketplaces, `~/.codex/skills`, `~/.grok/skills`, `~/.agents/skills`, and `~/.cursor` rules, skills, agents, hooks, MCP servers, plugins, and sandbox policy. No flag or configuration key disables those imports for a headless run. The companion therefore runs every job with `HOME` set to a private home that it builds itself, which removes every home scoped source at once.

The private home lives at `<data>/runs/<job-id>/home` and contains only:

- `Library/Keychains`, a symbolic link to the real user's `~/Library/Keychains`, because the CLI's credentials are the macOS keychain items `cursor-access-token` and `cursor-refresh-token` and the keychain is located through `HOME`. No credential file is copied or read by the companion.
- `.cursor/cli-config.json`, generated per mode as described below.
- `.cursor/sandbox.json`, generated per mode as described below.
- `.cursor/plugins` and `.cursor/skills-cursor`, created empty with mode `0555`. Cursor otherwise downloads its public marketplace plugins (some of which ship hooks and MCP servers) and its built in skills into a fresh home on first run, which takes 30 to 45 seconds; read only empty directories keep both out of the session and start the CLI in under ten seconds.

The child environment inherits only `PATH`, `LANG`, `LANGUAGE`, `TERM`, `COLORTERM`, `TMPDIR`, `TZ`, `USER`, `LOGNAME`, `SHELL`, every `LC_*` variable, `CURSOR_API_KEY`, and the toolchain roots `JAVA_HOME`, `GOROOT`, `GOPATH`, `CARGO_HOME`, `RUSTUP_HOME`, `PNPM_HOME`, `BUN_INSTALL`, `VOLTA_HOME`, `MISE_DATA_DIR`, `MISE_CONFIG_DIR`, `MISE_CACHE_DIR`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `DEVELOPER_DIR`, and `SDKROOT`. The companion sets `HOME` to the private home and `NODE_COMPILE_CACHE` to `<data>/compile-cache`, shared across runs so the bundled JavaScript compiles once. On Linux the keychain link is not created; authentication requires `CURSOR_API_KEY` in the companion environment, which is passed through unchanged.

The generated `cli-config.json` sets `approvalMode` to `allowlist`, `sandbox.mode` to `enabled`, `sandbox.networkAccess` to `user_config_only`, `sandbox.readBoundary` to `workspace`, `autoAcceptWebSearch` to `false`, both `attribution` flags to `false`, empty `permissions.allow`, and, for read only modes, `permissions.deny` of `["Write(**)"]`. The generated `sandbox.json` has `type` `workspace_readonly` for consult and review and `workspace_readwrite` for write, `readBoundary` `workspace`, and `networkPolicy.default` `deny`. Write mode adds `additionalReadonlyPaths` for the language runtime installation root (`MISE_DATA_DIR/installs`, or `~/.local/share/mise/installs` when present) so project test suites find their toolchains, and for a linked worktree adds the repository's Git common directory as read only and the worktree's own Git directory as read write.

## Invocation

Every managed run executes, with the private home as `HOME` and the workspace as its working directory:

```text
cursor-agent -p --output-format stream-json --model <variant> --workspace <cwd> --trust
  --sandbox enabled --disable-project-configs --disable-auto-update --single-turn
  --allowed-tools <comma separated list> [--mode ask] [--resume <session-id>]
```

The brief is written to the child's stdin and stdin is closed; the CLI reads stdin only when no positional prompt is present, so the brief never appears in the process arguments. `--disable-project-configs` ignores a project `.cursor/cli.json`, which could otherwise widen permissions. `--single-turn` ends the run after the first user turn instead of waiting for background shells. The companion never passes `--force`, `--yolo`, `--auto-review`, `--approve-mcps`, `--worktree`, `--plugin-dir`, or `--add-dir`; headless approvals use Cursor's always deny decision provider, so any action outside the allowlist and sandbox is rejected rather than prompted.

Lint tools start language servers through `npm exec` outside the sandbox, so they are excluded from every allowlist.

Tool allowlists use the CLI's snake case tool identifiers:

| Mode | `--mode` | Tools |
|---|---|---|
| consult | `ask` | `read_tool_call`, `grep_tool_call`, `glob_tool_call`, `ls_tool_call` |
| review | `ask` | the consult list |
| write | none | the consult list plus `edit_tool_call`, `delete_tool_call`, `shell_tool_call`, `update_todos_tool_call`, `read_todos_tool_call` |

Web search and fetch, MCP, subagent and agent creation (`task_tool_call`, `create_agent_tool_call`, `send_to_agent_tool_call`), background shell input, semantic search against Cursor's index, computer use, image generation, pull request management, and every other tool stay outside every allowlist. The allowlist travels to Cursor's backend as request metadata, so the companion also enforces it locally: a `tool_call` event naming a tool outside the mode's allowlist terminates the process group and fails the job as `policy`.

Live probes of this build confirmed that in write mode an edit and a shell write inside the workspace succeed without approval, while a shell write outside the workspace, a shell or file tool read outside the workspace, a read of the real `~/.claude`, and outbound network access are all refused, and that a project `.cursor/sandbox.json` of type `insecure_none` does not widen the generated policy.

## Models

The model catalog comes from `cursor-agent models`, whose lines read `<id> - <display name>` with optional `(current)` or `(default)` markers. The companion caches the parsed catalog at `<data>/models-cache.json` for one hour and exposes it through `models --json`. Catalog identifiers are flattened variants that encode effort and speed, for example `muse-spark-1.3-xhigh`, `grok-4.7-high-fast`, `composer-2.5`, and `composer-2.5-fast`; the CLI matches `--model` against these identifiers and against quoted bracket forms such as `claude-opus-4-8[effort=high]`.

Resolution of a requested model and effort, in order: a value containing `[` is passed through unchanged; an exact catalog identifier is used as is when the effort is `default` or already encoded in the identifier; otherwise the companion tries `<model>-<effort>` (with `xhigh` also tried as `extra-high`), and for a model ending in `-fast` tries `<base>-<effort>-fast`; a model with no effort variants resolves to its exact identifier with `effortApplied: false` recorded. A request that matches no catalog identifier fails before job creation as `input` and lists the available variants for that base. `auto` and `default` are refused as `input`, because Auto routes to a model that no event reports.

The `system/init` event reports only a display name, which can differ from the catalog's display name for the same variant (context window labels differ), so the companion records it as `observedModel` and does not treat a mismatch as drift. `billingPool` is `first-party` for `composer-*` identifiers and `api` for every other model; it names the subscription pool a quota failure exhausts.

## Stream protocol

Stdout is newline delimited JSON. The companion requires a `system` event with subtype `init` (fields `session_id`, `model`, `cwd`, `apiKeySource`, `permissionMode`) before any other event, then accepts `user`, `thinking` (`delta`, `completed`), `assistant`, `tool_call` (`started`, `completed`, with `call_id` and a `tool_call` object that holds the tool payload under a key ending in `ToolCall`, such as `readToolCall`, `editToolCall`, or `shellToolCall`, next to metadata keys `hookAdditionalContexts`, `toolCallId`, `startedAtMs`, and `completedAtMs`; the tool is identified by the `ToolCall` key alone), and `system` subtype `task_notification`, and finally one `result` event with subtype `success`, `is_error: false`, `result` text, `session_id`, `request_id`, `duration_ms`, and an optional cumulative `usage` object with `inputTokens` (excluding cache), `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens`. Session ids in init, result, and resume requests must be UUIDs. A failed run prints the error to stderr and exits nonzero without a result event. Unknown event types are ignored; malformed lines, a missing init event, or a zero exit without a result event fail the job as `protocol`. The job records `usage` exactly as reported and marks it unreported when the result event omits it; cost is never reported.

## Process supervision

The CLI starts in its own process group. On demand it can spawn a `worker-server` helper that inherits that group and reparents to init after the CLI exits, so the companion terminates the whole group once the CLI has exited or the job has otherwise ended. A helper started while the CLI is shutting down can still escape that signal, so the companion then also terminates every `worker-server` process whose environment `HOME` is the job's private home, which no other process shares. Cleanup waits for both the worker pid and the entire Cursor process group to disappear, escalating to `SIGKILL` after five seconds. After the `result` event the CLI still runs session end hooks, flushes telemetry, and disposes its store, so the companion waits up to `CURSOR_COMPANION_EXIT_GRACE_MS` (default 15000) for exit, then sends `SIGTERM` to the group and `SIGKILL` after five more seconds, and records a `late_close` warning while keeping the transport outcome `done`. The run timeout is `CURSOR_COMPANION_TIMEOUT_MS` (default 540000), sized so a foreground wrapper finishes inside the ten minute tool limit. A bounded drain after CLI exit and an absolute run deadline resolve streams held open by descendants. Cancellation, signal forwarding, died detection, pidless grace, and process identity verification follow the shared contract. A background worker waits up to five seconds for the launcher to record its pid before it runs, because the launcher writes the pid under the record lock only after the spawn returns. The process that owns a run (the foreground companion or the background worker) forwards SIGTERM, SIGINT, and SIGHUP to the Cursor group through its live child handle and records the job as cancelled. Because `cursor-agent` is a shell launcher that replaces itself with Node, the identity recorded at spawn describes the launcher, so the owner refreshes the recorded identity when the `system/init` event arrives; a `cancel` from another process signals the verified owner, which stops the group, and signals the group directly only when its refreshed identity matches.

## Failure kinds

| Kind | Evidence |
|---|---|
| `missing_cli` | the executable cannot be found or spawned |
| `setup` | the build is below the tested floor, `--version` output is unparseable, the CLI rejects an adapter flag or tool identifier (`Invalid --allowed-tools value`), or rejects a catalog model (`Cannot use this model`) |
| `auth` | `Authentication required`, `Not logged in`, `Unauthorized`, or HTTP 401 or 403 |
| `quota` | usage limit, quota, spend limit, insufficient credit, or HTTP 402 text |
| `rate_limited` | rate limit, too many requests, or HTTP 429 text |
| `network` | DNS failure, connection refused or reset, or fetch failure before any result |
| `sandbox` | `Sandbox mode is enabled but not available` or a sandbox helper failure |
| `policy` | a tool outside the mode allowlist appeared in the stream |
| `protocol` | malformed stream, missing init, or a zero exit without a result event |
| `timeout` | the run timeout elapsed and the group was terminated |
| `process` | an unexpected signal or exit code 143 that the companion did not request |
| `cancelled`, `died`, `input`, `resource`, `error` | as defined by the shared contract |

Quota and rate limit failures carry the job's `billingPool`, so Fusion's breaker opens only the pool that failed; authentication, missing CLI, setup, sandbox, protocol, and policy failures are engine wide.

## Job record

Records live at `<data>/state/<workspace>/jobs/<id>.json`, where `<data>` is `CURSOR_COMPANION_DATA` or `~/.claude/plugins/data/cursor-claude-code-fusion`, and follow the Grok companion's record shape with `engine: "cursor"`. Cursor specific fields are `cursorVersion`, `cursorBuildPath`, `sessionId` (the chat id), `requestId`, `requestedModel`, `resolvedModel` (the catalog variant passed to the CLI), `observedModel`, `requestedEffort`, `effortApplied`, `billingPool`, `mode` (`consult`, `write`, or `review`), `role`, `usage`, `homeDir`, and `warnings`. The footer session line is `cursor-session: <session-id>`.

## Sessions

Cursor stores a chat at `<home>/.cursor/chats/<md5 of the absolute workspace path>/<session-id>/`. Because every job has its own private home, `--resume <session-id>` and `--resume-last` copy the parent job's chat directory into the new job's home before launch, and resume only a terminal job of the same workspace and mode. `--fresh` ignores continuity. The private home of a terminal job is retained with the job record so a later resume can copy from it, and is pruned with the job history.

## Review

`review` collects the working tree diff or a branch range the same way the Grok companion does, interpolates it into `plugins/cursor/prompts/review.md`, and runs a review mode job. The reply must contain one JSON object with `verdict` (`approve` or `request_changes`), `summary`, and `findings` (each with `severity`, `file`, `line`, `title`, and `body`); the companion extracts the first JSON object from the result text and validates it. A missing or invalid object fails the review as `error` instead of falling back to prose.

## Commands

`plugins/cursor/scripts/cursor-companion.mjs` implements the shared surface in [companion-contract.md](companion-contract.md) with the Grok companion's argument and transport conventions:

| Subcommand | Behavior |
|---|---|
| `task [--write] [--model <id>] [--effort <effort>] [--resume <session-id> \| --resume-last \| --fresh] [--background] [--cwd <dir>] [--json] [-- <brief>]` | Consult by default, write with `--write`; the brief comes after `--` or from stdin; `--background` returns a manual receipt; the outcome ends with the shared footer block and `cursor-session:` |
| `review [--scope auto\|working-tree\|branch] [--base <ref>] [--focus <text>] [--model <id>] [--effort <effort>] [--cwd <dir>] [--background] [--json]` | Read only review of local Git state with the validated JSON verdict |
| `status [<job-id>] [--all] [--cwd <dir>] [--json]`, `result <job-id> [--wait] [--cwd <dir>] [--json]`, `cancel <job-id> [--cwd <dir>] [--json]` | Shared lifecycle with liveness verification |
| `history [--all] [--limit <n>] [--cwd <dir>] [--json]` | Safe metadata projection with resumable session ids |
| `models [--refresh] [--json]` | The parsed account catalog from the cache or the CLI |
| `setup [--json]` | Binary path and name check, build against the tested interval, authentication (`cursor-agent status`), catalog refresh, sandbox helper presence, and the project hook advisory for the working directory |
| `record-acceptance ...` | As defined by the shared contract |
| `transport-create`, `transport-discard --raw-args-token <token>`, and `--raw-args-token <token>` on `task` and `review` | The raw arguments transport used by the rescue agent, identical in shape to the Grok companion's |
| `task-worker`, `review-worker` | Internal background workers |

`scripts/session-end-hook.mjs` runs at Claude Code SessionEnd, performs verified cleanup of this session's running jobs, and removes unused raw transports, as the Grok plugin's hook does. Defaults: `CURSOR_COMPANION_TIMEOUT_MS` 540000, `CURSOR_COMPANION_EXIT_GRACE_MS` 15000, `CURSOR_COMPANION_PIDLESS_RUNNING_GRACE_MS` as in Grok, `CURSOR_COMPANION_WAIT_TIMEOUT_MS` and `CURSOR_COMPANION_WAIT_POLL_MS` for `result --wait`.

## Residual boundaries

- Project scoped sources still load: `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, and skill and agent definitions under the workspace's `.cursor`, `.claude`, `.codex`, `.grok`, and `.agents` directories. They are the repository's own instructions, as they are for Codex.
- Project hooks still execute outside the sandbox: Cursor runs hooks from the workspace's `.cursor/hooks.json`, `.claude/settings.json`, and `.claude/settings.local.json` (verified for `SessionStart`), and no caller disables project hook loading. The companion detects a non empty `hooks` object in those files before launch and renders a `warning:` line naming them.
- Account level user rules configured in Cursor's settings are delivered by Cursor's backend and reach every session.
- Prompts, workspace content read by tools, and results pass through Cursor's backend to the serving model vendor under the account's privacy mode. Never delegate secrets or credentials to this lane.
- The allowlist is enforced by Cursor's backend and checked locally after the fact; a forbidden tool call is detected and terminated, not prevented.
