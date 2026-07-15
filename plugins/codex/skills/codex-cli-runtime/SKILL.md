---
name: codex-cli-runtime
description: Internal contract for invoking the Codex companion runtime.
user-invocable: false
---

# Codex runtime

Primary helper:

- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" <subcommand> [flags]`

Subcommand surface:

- `task [--prompt-file <path>] [--write] [--background] [--resume <thread-id>|--resume-last|--fresh] [--model <id>] [--effort <level>] [--web] [--network] [--cwd <dir>] [--json] [--] [prompt]`
- `review [--scope <auto|working-tree|branch>] [--base <ref>] [--focus <text>] [--background] [--model <id>] [--effort <level>] [--cwd <dir>] [--json]`
- `adversarial-review [--scope <auto|working-tree|branch>] [--base <ref>] [--focus <text>] [--background] [--model <id>] [--effort <level>] [--cwd <dir>] [--json]`
- `status [job-id] [--all] [--cwd <dir>] [--json]`
- `result <job-id> [--wait] [--wait-timeout-ms <ms>] [--cwd <dir>] [--json]`
- `cancel <job-id> [--cwd <dir>] [--json]`
- `setup [--cwd <dir>] [--json]`

Execution rules:

- Invoke the helper only through foreground `Bash` with `timeout: 600000`.
- Place every task option before the first prompt token. Use `--` before a prompt that begins with an option shaped token.
- Never use Bash background mode. Complexity, duration, and model choice never justify implicit background execution.
- Pass `--background` only when the received request explicitly contains it. The companion owns detachment and returns a durable job receipt.
- A direct slash command invocation returns that receipt without automatic collection. Direct users inspect progress through status and collect the deliverable through result; when Fusion is installed, its monitor can notify them of completion. Fusion orchestration separately owns one same turn collection attempt capped at 540000ms for jobs it creates. A timeout remains explicitly uncollected.
- A task is read only unless `--write` is present. Review commands are always read only.
- Leave `--model` and `--effort` unset unless explicitly requested so Codex configuration remains authoritative.
- Use `--resume <thread-id>` only with a real thread identifier returned by Codex. Use `--resume-last` for the newest eligible task thread launched by the current Claude session, or the newest eligible workspace task when no Claude session id is available.
- Use `--fresh` only when the caller explicitly requests a new thread. It cannot be combined with either resume form.
- Use `--web` only when explicitly requested. Use `--network` only with `--write` and only when explicitly requested.
- `result --wait` performs a bounded wait. When the wait budget expires while the job is still active, it leaves the job unchanged and returns output ending in `job: <id>` and `state: running`.
- Terminal output ends with the Codex thread identifier when available, the job identifier, and `state: done`, `state: error`, or `state: cancelled`. Error and cancelled outcomes also include a failure kind.
- Return helper stdout exactly as received. Do not interpret it or replace a failed run with Claude-side work.
