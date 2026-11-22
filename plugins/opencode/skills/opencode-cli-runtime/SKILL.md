---
name: opencode-cli-runtime
description: Internal helper contract for calling the opencode-companion runtime from Claude Code
user-invocable: false
---

# OpenCode Go runtime

Primary helper:

- `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" <subcommand> [flags]`

Subcommand surface:

- `task [--write] [--model <id>] [--effort <effort>] [--resume <session-id>|--resume-last|--fresh] [--background] [--cwd <dir>] [--json] [--] [prompt]`
- `status [job-id] [--all] [--cwd <dir>] [--json]`
- `result <job-id> [--wait] [--cwd <dir>] [--json]`
- `cancel <job-id> [--cwd <dir>] [--json]`
- `history [--all] [--limit <n>] [--cwd <dir>] [--json]`
- `models [--refresh] [--json]`
- `setup [--json]`
- `record-acceptance --job-id <id> --acceptance <accepted|rejected|unverified> [--reason <text>] [--failure-kind <kind>] [--source <collector|main-loop|stats>] [--accept-failed-transport] [--json]`
- `transport-create` and `transport-discard --raw-args-token <token>`
- `task-worker` is an internal background worker that the helper never invokes directly.
- `quota [--json]`

Execution rules:

- Slash commands stage their complete raw arguments through `transport-create`, one Read of the allocated empty file, Write to that same file, and a fixed `--raw-args-token` invocation. The token transport applies to task, status, history, result, cancel, and setup. Raw request bytes never enter Bash, shell arguments, environment variables, redirections, substitutions, encoded literals, or heredocs. A transport is private, bounded, validated, and consumed once. Never delete, rename, recreate, or change the permissions of the transport file; use `transport-discard` when Read or Write fails or when the allocated file is not empty.
- Place every task option before the prompt, and put `--` before a prompt that begins with an option shaped token. The prompt text may also arrive on stdin.
- The companion resolves `codex` on `PATH`, overridden by `OPENCODE_CODEX_BIN`, and records `codexVersion`. Preserve setup compatibility warnings and rerun `/opencode:setup` after repairing an incompatible CLI.
- Each brief must declare exactly one `opencode-role: bulk` or `opencode-role: blind-check` in its header. Bulk writes in an orchestrator owned worktree through Codex's `workspace-write` sandbox and is accepted by rerunning the verification command. Blind-check uses `read-only` to answer a staged artifact with its answers removed. OpenCode Go never handles ordinary implementation, review, panels, or independence consults.
- The companion runs `codex exec --json` with the role's sandbox, workspace, model, and reasoning effort. Bulk defaults to `deepseek-v4.1-flash@high`; blind-check defaults to `glm-5.3-flash@high`. Supported efforts come from the Go model listing; the routing defaults use `low`, `high`, or `max`. Fusion supplies explicit model and effort choices from the routing table.
- `CODEX_HOME` is the shared private `<data>/codex-home`. Its generated configuration selects the OpenCode Go Responses provider at `https://opencode.ai/inference/go/v1`, and its model catalog derives from the installed Codex binary's bundled `gpt-5.5` entry. It regenerates when `codexVersion` changes. A missing required catalog entry fails preflight as `setup`.
- The key comes from `OPENCODE_GO_API_KEY` or, when that is unset, the opencode CLI login store, and is passed to the Codex child. Never write or print it. The generated shell policy excludes `OPENCODE_*` from model shell commands. Missing credentials fail as `auth`.
- `models` lists Go models supporting tools and caches them for one hour; `--refresh` fetches again. `quota` reports rolling, weekly, and monthly allowance pools, all named `opencode` with cost class `included`. Turn off Extra Usage in the OpenCode console to keep this lane on its included allowance. Requests carry `x-opencode-session` with the job id, never a repository name or path.
- Repository `AGENTS.md` still loads. The workspace sandbox confines writes; reads outside the workspace remain possible. Prompts, tool content, and results pass through OpenCode and the serving model vendor. Never delegate secrets or credentials to this lane.
- A forwarder agent runs the companion in one background shell: a Bash call with `run_in_background: true`, which returns at once with a background id and the path of the output file. It then runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" await-output --file "PATH"` in a foreground Bash call with `timeout: 120000` and repeats that call while it prints exactly `await-output: pending`; any other output is the complete stdout of the launched operation. The harness delivers one report per agent, so a forwarder never ends its turn or writes a waiting line while the await operation prints pending. The rescue wrapper adds the fixed option `--transport-background-shell` to its task launch for a 900000ms default execution budget. Direct foreground tasks keep their 540000ms default, and `OPENCODE_COMPANION_TIMEOUT_MS` overrides either budget. Background mode belongs to that Bash call alone and is neither the Agent's own background mode nor the companion's `--background`. A companion run directly by the main session through a slash command, with no forwarder agent, is a foreground `Bash` call with `timeout: 600000`.
- Ordinary delegations use one helper call. Only an explicit incoming user `--background` detaches a task into an internal worker and creates a manual receipt; the helper prints the job id plus `/opencode:status` and `/opencode:result` hints. Never add `--background` because a task appears large or slow, and never confuse a background shell with that option. `result --wait` blocks while a job is running, and when its bounded wait budget elapses first it returns output ending in `state: running`.
- A user asking to resume maps to `--resume <session-id>` or `--resume-last`; these and `--fresh` are alternatives. Resume stays in the same workspace and preserves the original role. Codex rollouts stay in the private home.
- `history` exposes a safe metadata projection with resumable session ids. It defaults to the current workspace, `--all` includes every recorded workspace, and `--limit` caps the number of jobs shown.
- `--cwd` selects the workspace for task, status, history, result, and cancel. Status, result, and cancel search all recorded workspaces by job id when `--cwd` is omitted. A bad working directory, or an implicit task working directory below its Git repository root, fails before a job record is created. Worktree isolation means creating a real Git worktree before launch and supplying that path as the actual `--cwd`.
- Typed failure kinds are `missing_cli`, `setup`, `auth`, `quota`, `rate_limited`, `network`, `permission`, `policy`, `refused`, `protocol`, `timeout`, `process`, `cancelled`, `died`, `input`, `resource`, and `error`. Provider HTTP 401 or 403 is `auth`; HTTP 429 is `rate_limited`; an exhausted Go allowance is `quota`. Quota and rate limit failures carry `billingPool: "opencode"`; authentication, missing CLI, setup, protocol, permission, and policy failures are engine wide.
- Outcomes end with the shared footer block: `opencode-session: <session-id>` when a resumable session exists, then `job:`, `sandbox:`, `delivery:`, `semantic:`, any adapter `warning:` lines, `state:`, and `failure:` for error and cancelled outcomes.
- Job records live at `<data>/state/<workspace>/jobs/<id>.json`, where `<data>` is `OPENCODE_COMPANION_DATA` or `~/.claude/plugins/data/opencode-claude-code-fusion`. They carry the role, mode, Codex version, session id, requested and resolved model and effort, billing pool, usage, and warnings.
- `scripts/session-end-hook.mjs` runs at Claude Code SessionEnd, performs verified cleanup of this session's running jobs, and removes unused raw transports.
- Return the helper output exactly as received, whether the Bash tool reports it from stdout or stderr.
- If the Bash call fails or OpenCode Go cannot be invoked, surface the failure instead of hiding it; the opencode-rescue agent returns exactly one `opencode unavailable: <reason>` line for the orchestrator's circuit breaker.
