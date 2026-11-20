# Antigravity companion contract

This document is the Antigravity instance of the engine agnostic [companion contract](companion-contract.md). It pins how the agy plugin drives the Antigravity CLI (`agy`) headlessly over the Agent Client Protocol: binary resolution, the private Gemini directory that isolates every run, session setup, model and effort resolution, tool and permission policy, the protocol stream, process supervision, failure classification, the job record, session continuity, review output, and the residual boundaries the adapter cannot close. The ACP methods, config options, tool names, and permission behavior were checked against Antigravity CLI `1.5.12` on macOS.

## Role in Fusion

Antigravity is Google's agent CLI and the native lane for the Google model family. It runs on the user's Google AI subscription, so its quota is separate from every other lane's. Fusion routes to it under three protected roles: `independence` (a read only consult or blind panel track from a family the question has not seated), `large-context` (a read only consult over inputs that need the 1M token window or image and PDF reading), and `burst` (bounded implementation inside an orchestrator owned worktree, limited to file edits). It is never the default for ordinary implementation. While the agy plugin is installed, the breadth engine does not seat a Google model under `diversity`.

## Binary and version

The companion resolves the CLI as `agy` on `PATH`; `AGY_BIN` overrides the path, which the test suite uses for its fake CLI. Preflight runs `agy --version`, which prints the bare version (`1.5.12`), and records it as `agyVersion` and the resolved executable path as `agyBuildPath` on every job. The tested interval is `[1.5, 1.6)` by major and minor version. A build below the floor fails preflight as `setup`; a build at or past the ceiling runs and `/agy:setup` reports it as newer than the tested interval. Homebrew installs the CLI as the `antigravity-cli` cask with self update disabled.

## Private Gemini directory

The CLI keeps settings, MCP configuration, conversations, plans, and logs under `~/.gemini/antigravity-cli` and reads `~/.gemini/config`. Its OAuth credential lives in the user's login keychain (service `gemini`), which the CLI locates through the real `HOME`. The companion therefore keeps `HOME` and isolates through CLI flags instead.

- `--gemini-dir <data>/gemini` (absolute) replaces `~/.gemini`. `--app-data-dir agy` must be relative; it names `<data>/gemini/agy`. Both are shared by every job so conversations resume across jobs.
- Before creating directories or writing files, the companion uses `lstat` to reject symbolic links at `<data>/gemini`, its `agy`, `config`, and `bin` directories, and the `settings.json`, `mcp_config.json`, and `bin/open` destinations. An existing or dangling link fails setup before any destination is changed. Before every run the companion writes `<data>/gemini/agy/settings.json` as `{}` and `<data>/gemini/config/mcp_config.json` as `{"mcpServers":{}}`, atomically, so no trusted workspace, tool permission, or MCP server persists between runs.
- `<data>/gemini/bin/open` is a private executable that exits 1, and the companion puts `<data>/gemini/bin` first on the child `PATH`. The CLI starts its browser login through `open <url>` whenever it cannot authenticate, so the blocker turns every login prompt into a typed `auth` failure instead of a browser window.
- `--disable-telemetry` and `--include-default-customizations=false` are always passed. `--sandbox` is always passed; it blocks shell reads of credential directories such as `~/.ssh`, but it does not confine writes, so containment comes from the permission policy below, not from the sandbox.

Both the version probe and the ACP child inherit only the environment allowlist of the Devin contract plus `HOME`. On macOS, when `DEVELOPER_DIR` is unset, the companion sets it from `xcode-select -p`, because `/usr/bin/git` is an xcrun shim that reads `/var/db/xcode_select_link`, which the CLI sandbox denies; without it every approved `git` command fails and the model retries it with a sandbox bypass. Every `GEMINI_*`, `GOOGLE_*`, `ANTIGRAVITY_*`, `AGY_*`, and `CLOUDSDK_*` variable is dropped, because each could switch the account, the API key, or the endpoint outside the companion's control.

A live probe confirmed that with this layout the keychain credential authenticates, the user's own `~/.gemini` settings and MCP servers do not load, and only the CLI's builtin skills are present. A run with a private `HOME` instead requires an interactive OAuth login and is therefore unusable. The same happens when the login keychain is locked, as in an ssh or other headless session: the credential exists but cannot be read, and the run fails as `auth`.

## Invocation

Every run executes `agy acp --disable-telemetry --include-default-customizations=false --sandbox --gemini-dir <dir> --app-data-dir agy` with the workspace as its working directory and speaks JSON-RPC 2.0 over newline delimited stdio. The companion sends, in order:

1. `initialize` with `protocolVersion: 1` and `clientCapabilities` `{ fs: { readTextFile: false, writeTextFile: false }, terminal: false }`. The agent must answer `protocolVersion: 1`; `agentInfo.version` is recorded.
2. `session/new` with `{ cwd, mcpServers: [] }`, or `session/load` with `{ sessionId, cwd, mcpServers: [] }` when resuming. The result carries `sessionId` (a UUID), `modes`, `models`, and `configOptions` with ids `model`, `thought_level`, and `mode`.
3. `session/set_mode` with the mode's `modeId`, then `session/set_config_option` for `model`, then `thought_level`. Each `set_config_option` result returns the updated `configOptions`; the companion verifies every value it set, including `mode`, and fails before prompting when one differs.
4. `session/prompt` with `{ sessionId, prompt: [{ type: "text", text: <brief> }] }`. The brief travels only inside this message. In every mode the text is a fixed operating limits note, a blank line, then the brief; the note directs the agent to read with its file tools, states that a shell command is approved only as a single allowlisted read only program (`ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `stat`, `grep`, `rg`, `find`, or a read only `git` subcommand) without pipes, redirection, variables, or chaining, and warns that any other tool or command request is refused and ends the turn.

After the prompt result the companion closes stdin. It never passes `--dangerously-skip-permissions`, `--remote-agent`, `--remote-control`, `--project`, `--agent`, `--add-dir`, or `--ide-mcp-port`.

| Mode | ACP `modeId` | Tools the companion accepts |
|---|---|---|
| consult | `default` | `read_file`, `search_web`, `run_command` |
| review | `default` | the consult list |
| write | `accept-edits` | the consult list plus `edit_file`, `write_file` |

The `plan` mode is never used: it ends the turn with a plan artifact awaiting approval instead of an answer.

## Permission policy

In `default` mode every `run_command`, every read outside the workspace, and every write raises `session/request_permission`; in `accept-edits` mode file edits and writes inside the workspace proceed without a request while writes outside it and every `run_command` still raise one. The request carries `toolCall` (with `name` and `rawInput`) and `options`, each with `optionId` and `kind` (`allow_once`, `reject_once`). The companion answers `{ outcome: { outcome: "selected", optionId } }` choosing an option by `kind`, never by id:

- `allow_once` only for `run_command` whose `rawInput.CommandLine` passes the read only command check and whose `rawInput.BypassSandbox` is absent or `false`.
- `reject_once` for everything else, including reads and writes outside the workspace. When no `reject_once` option exists the companion answers `{ outcome: { outcome: "cancelled" } }`.

The read only command check parses one simple shell command against explicit program and flag allowlists. It rejects carriage returns, newlines, null bytes, `$`, backticks, backslashes, `;`, `|`, `&`, `>`, and `<` anywhere, including inside quotes. Unquoted `*`, `?`, `[`, `]`, `{`, `}`, `(`, and `)` are rejected anywhere; unquoted `~`, `#`, `!`, and `=` are rejected at the start of a token. Whitespace separates words. Single and double quotes preserve literal text, adjacent quoted and unquoted segments concatenate, and unterminated quotes reject the command. All subsequent checks use the dequoted words. The first word cannot contain `/` or `=`, so program paths and environment assignments are refused.

The program must be `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `stat`, `grep`, `rg`, `find`, or `git`. `file` and `tree` are refused. `ls`, `pwd`, `cat`, `head`, `wc`, `stat`, and `grep` accept any flags. `tail` rejects `-f`, `-F`, `--follow`, `--follow=value`, and short clusters containing `f` or `F` before `--`.

`rg` accepts only the long flags `--hidden`, `--no-ignore`, `--files`, `--files-with-matches`, `--count`, `--line-number`, `--no-line-number`, `--ignore-case`, `--smart-case`, `--case-sensitive`, `--fixed-strings`, `--word-regexp`, `--invert-match`, `--multiline`, `--json`, `--max-count`, `--glob`, `--iglob`, `--type`, `--type-not`, `--context`, `--before-context`, `--after-context`, `--max-depth`, `--sort`, `--follow`, `--with-filename`, `--no-heading`, `--heading`, `--null`, `--only-matching`, and `--regexp`. Short clusters may contain `n`, `i`, `S`, `s`, `F`, `w`, `v`, `l`, `c`, `U`, `L`, `H`, `N`, `o`, `u`, and `x`. The value flags `-e`, `-g`, `-t`, `-T`, `-A`, `-B`, `-C`, `-m`, and `-M` consume an attached value or the next word. Long value flags accept `=value` or the next word. Required values must be present. `--` ends flag parsing. Other flags, including `--pre`, `--pre-glob`, `-z`, `--search-zip`, and `--hostname-bin`, are refused.

`find` accepts `-L`, `-H`, and `-P` only before paths. After paths it accepts only `-name`, `-iname`, `-path`, `-ipath`, `-wholename`, `-regex`, `-iregex`, `-type`, `-maxdepth`, `-mindepth`, `-size`, `-mtime`, `-mmin`, `-newer`, `-empty`, `-print`, `-print0`, `-prune`, `-not`, `-a`, `-o`, `-and`, `-or`, and `-ls`. Predicates that require a value consume the next word. Literal grouping and negation words `(`, `)`, and `!` must be quoted. All other predicates are refused, including execution, deletion, and file output actions.

For `git`, the second word must be the subcommand, so global options such as `-c`, `-C`, `--git-dir`, and `--exec-path` are refused. Each subcommand has its own flag allowlist:

| Subcommand | Allowed flags |
|---|---|
| `status` | `-s --short --porcelain -b --branch -u --untracked-files --ignored` |
| `log` | `--oneline -n --max-count -p --patch --stat --shortstat --name-only --name-status --graph --decorate --format --pretty --author --since --until --after --before --grep -S -G --follow --all --reverse --first-parent --no-merges --abbrev-commit --date`, plus `-<number>` |
| `show` | `--stat --shortstat --name-only --name-status -p --patch --format --pretty --no-patch -s --abbrev-commit --date` |
| `diff` | `--stat --shortstat --name-only --name-status --cached --staged -U --unified --word-diff --no-color --numstat --summary` |
| `ls-files` | `-c --cached -m --modified -o --others -i --ignored --exclude-standard -s --stage -z` |
| `grep` | `-n --line-number -i --ignore-case -w --word-regexp -l --files-with-matches -c --count -e -E -F -P --cached --untracked -I --max-depth` |
| `blame` | `-L -w -M -C --porcelain -s -e` |
| `rev-parse` | `--show-toplevel --abbrev-ref --short --verify --git-dir --is-inside-work-tree` |
| `branch` | Bare, or `--list -a --all -r --remotes -v -vv --show-current` |

Git value flags accept `=value` or a following word that does not begin with `-`. Short clusters must contain only allowed letters, with a value flag last; its value follows as `=value` or a separate word. Optional values do not consume subsequent flags. Other nonflag words are revisions, patterns, or paths, including `HEAD` for `rev-parse`. `--` ends flag parsing. `branch` permits operands only when `--list` appears before `--`, so branch creation is refused. Every other command line is rejected. Approved commands still run inside the CLI sandbox.

A refused permission ends the agent's turn early in this build; the result text is whatever the agent wrote before the refusal, which may be empty, so a job with refused requests carries a `permission_refused` warning. Each refusal also records `{ tool, command }` on the outcome's `refusedPermissions` list — the `toolCall` name and the `rawInput.CommandLine` truncated to 200 characters, at most five requests — and the warning and the `permission` failure message name those refused tools and commands. A `tool_call` naming a tool outside the mode's list (`invoke_subagent`, `define_subagent`, `manage_subagents`, `manage_task`, `run_workflow`, `schedule`, `send_message`, `swarm`, `ask_question`, any `mcp_*`, and anything new), terminates the process group and fails the job as `policy`. A `run_command` with `rawInput.BypassSandbox: true` raises a permission request like any command and is refused there; the job continues. A bypassed `run_command` whose update reports `status: "completed"` ran without the companion's approval and fails the job as `policy`.

## Models

The account's usable models are the `model` config option values of the new session (`gemini-4-neon`, `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-3.8-flash`, and others). `models --json` starts a session, reads that option, and caches the list at `<data>/models-cache.json` for one hour. Effort is the separate `thought_level` option (`low`, `medium`, `high`, `xhigh`); a new session starts at `high`.

Resolution of a requested model and effort:

1. The requested model must be a `model` option value or a value from `agy models` (`gemini-4-neon-high`), whose trailing `-low`, `-medium`, `-high`, or `-xhigh` sets the effort when no effort is requested. The default model is `gemini-4-neon`.
2. Only Google family values starting with `gemini-` are accepted. `gemini-pro-orchestrator-*` values are refused as `input` because they route work to models the session does not pin; Claude and other non Google families are refused as `input` because other lanes serve them. A value the account does not offer fails the job as `setup`, listing the usable Google values.
3. `default` effort leaves `thought_level` at the session default; any other effort must be one of the `thought_level` values, else the job fails as `input` listing them.

The job records `requestedModel`, `resolvedModel`, `requestedEffort`, `resolvedEffort`, and `effortApplied`. `billingPool` is always `subscription`.

## Protocol stream

Stdout carries JSON-RPC responses, `session/update` notifications, and agent requests. The companion handles:

- `session/update` with `sessionUpdate` `agent_message_chunk` (`content.text`): appended to the result text, only for chunks after `session/prompt` was sent, because `session/load` replays earlier turns.
- `tool_call` and `tool_call_update` (`name`, `kind`, `status`, `rawInput`, `locations`): checked against the tool policy on every event, including before initialization, during `session/load` replay, and after the prompt result. Tool call ids are counted once. Updates retain the preceding name and input when those fields are absent, so a later sandbox bypass is still detected.
- `session/request_permission`: answered by the permission policy.
- Everything else (`agent_thought_chunk`, `usage_update`, `config_option_update`, `current_mode_update`, `available_commands_update`, `session_info_update`, `plan`) is ignored.

The `session/prompt` result is `{ stopReason, usage: { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens, totalTokens } }`. A successful run has `stopReason: "end_turn"`. The job records `usage` as reported and never reports cost. A JSON-RPC error carries `{ code, message, data? }` and is classified below. Malformed stdout lines, a response for an unknown request id, a missing `sessionId`, or an exit before the prompt result fail the job as `protocol`. Stderr is diagnostic only. Exit status is never evidence of success.

## Process supervision

`agy acp` starts in its own process group; commands it runs are descendants. After the prompt result the companion closes stdin and waits up to `AGY_COMPANION_EXIT_GRACE_MS` (default 15000), then sends `SIGTERM` to the group and `SIGKILL` after five more seconds, recording a `late_close` warning while keeping the transport outcome. The run timeout is `AGY_COMPANION_TIMEOUT_MS` (default 540000). A timeout or cancellation first sends `session/cancel` and then terminates the group. Cancellation, signal forwarding, died detection, pidless grace, process identity, the background worker's pid wait, and owner signal forwarding follow the Devin contract unchanged.

## Failure kinds

| Kind | Evidence |
|---|---|
| `missing_cli` | the executable cannot be found or spawned |
| `setup` | the version is below the floor or unparseable, `initialize` returns a protocol version other than 1, the language server fails to start, or a requested model is not offered |
| `auth` | `Authentication required`, `log in`, `sign in`, `not logged in`, `unauthorized`, `UNAUTHENTICATED`, or HTTP 401 or 403 text |
| `quota` | quota, usage limit, weekly limit, credits, `RESOURCE_EXHAUSTED` with a quota message, or HTTP 402 text |
| `rate_limited` | rate limit, too many requests, HTTP 429, `No capacity available`, `UNAVAILABLE`, or HTTP 503 text |
| `network` | DNS failure, connection refused or reset, or fetch failure before the prompt result |
| `policy` | a forbidden tool or a sandbox bypass appeared in the stream |
| `refused` | `stopReason: "refusal"`; the breaker ignores it |
| `protocol` | malformed stream, unexpected response id, or an exit before the prompt result |
| `timeout` | the run timeout elapsed and the group was terminated |
| `process` | an unexpected signal the companion did not request |
| `cancelled`, `died`, `input`, `resource`, `error` | as defined by the shared contract |

Quota and rate limit failures carry `billingPool`. Authentication, missing CLI, setup, protocol, and policy failures are engine wide.

## Job record

Records live at `<data>/state/<workspace>/jobs/<id>.json`, where `<data>` is `AGY_COMPANION_DATA` or `~/.claude/plugins/data/agy-claude-code-fusion`, and follow the Devin record shape with `engine: "agy"`. Antigravity specific fields are `agyVersion`, `agyBuildPath`, `sessionId`, `requestedModel`, `resolvedModel`, `requestedEffort`, `resolvedEffort`, `effortApplied`, `billingPool`, `mode`, `role`, `usage`, `stopReason`, `permissionsAllowed`, `permissionsRejected`, and `warnings`. The footer session line is `agy-session: <session-id>`.

## Sessions

Conversations live in the shared private Gemini directory, so `--resume <session-id>` and `--resume-last` call `session/load` on the parent job's session and resume only a terminal job of the same workspace and mode whose failure kind is not `policy`. A policy failure taints the session: `--resume-last` skips that parent, an explicit `--resume` fails as `input` when no eligible job owns the session, and history marks the job as not resumable. A resumed session keeps its model unless the request names one. `--fresh` ignores continuity. A sweep at task start and SessionEnd removes run directories without job records once they are older than one hour, at most once every 10 minutes per data root. The CLI owns retention of its conversations.

## Review

`review` collects the working tree diff or branch range the same way the Devin companion does, interpolates it into `plugins/agy/prompts/review.md`, and runs a review mode job. The reply must contain one JSON object with `verdict` (`approve` or `request_changes`), `summary`, and `findings` (each with `severity`, `file`, `line`, `title`, and `body`); a missing or invalid object fails the review as `error`.

## Commands

`plugins/agy/scripts/agy-companion.mjs` implements the same subcommands, options, raw arguments transport, internal workers, and manual background watch as the Devin companion, with `agy` in place of `devin` in every name, environment variable, and footer. `setup` reports the binary path, the version against the tested interval, authentication (a `session/new` that succeeds), the usable Google models, and a warning for any workspace `.gemini` or `.agents` directory. Defaults: `AGY_COMPANION_TIMEOUT_MS` 540000, `AGY_COMPANION_EXIT_GRACE_MS` 15000, and the pidless grace, wait, and watch variables under the `AGY_COMPANION_` prefix with the Devin defaults.

## Residual boundaries

- Project scoped instructions (`AGENTS.md`, `GEMINI.md`) and a workspace `.gemini` or `.agents` directory may still load. They are the repository's own instructions; the companion warns when the directories exist.
- The agent's read tool reads anything inside the workspace without a request, and approved read only commands read inside the CLI sandbox, which blocks credential directories but not the rest of the home directory.
- An approved `git` command honors the repository's own configuration, so a workspace whose `.git/config` sets `core.fsmonitor`, an external diff, or a textconv driver runs that program. Delegate only repositories the user trusts.
- Subscription quota is opaque: the CLI publishes no remaining allowance, and an account set to buy AI credits on overage keeps running past the plan limit. `/agy:setup` reminds the user to set overage to never.
- Prompts, workspace content read by tools, and results pass through Google's backend. Never delegate secrets or credentials to this lane.
- The tool policy is checked when the tool call is announced; a forbidden tool is detected and terminated, not prevented.
