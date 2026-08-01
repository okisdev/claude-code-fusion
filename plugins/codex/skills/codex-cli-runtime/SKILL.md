---
name: codex-cli-runtime
description: Internal contract for invoking the Codex companion runtime.
user-invocable: false
---

# Codex runtime

Primary helper:

- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" <subcommand> [flags]`

Subcommand surface:

- `task [--prompt-file <path>] [--output-schema <path>] [--write] [--background] [--resume <thread-id>|--resume-last|--fresh] [--model <id>] [--effort <level>] [--web] [--network] [--cwd <dir>] [--json] [--] [prompt]`
- `review [--scope <auto|working-tree|branch>] [--base <ref>] [--focus <text>] [--background] [--model <id>] [--effort <level>] [--cwd <dir>] [--json]`
- `adversarial-review [--scope <auto|working-tree|branch>] [--base <ref>] [--focus <text>] [--background] [--model <id>] [--effort <level>] [--cwd <dir>] [--json]`
- `status [job-id] [--all] [--cwd <dir>] [--json]`
- `history [--json]`
- `result <job-id> [--wait] [--wait-timeout-ms <ms>] [--cwd <dir>] [--json]`
- `cancel <job-id> [--cwd <dir>] [--json]`
- `setup [--cwd <dir>] [--json]`

Execution rules:

- Programmatic orchestrators pass the complete opaque raw request through stdin with `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --request-stdin`. A write default uses `task --transport-default-write --request-stdin`. The fixed argv contains no request bytes, and stdin must close after the complete request is written. The same ingress option works with review, status, result, cancel, history, and setup. Slash commands whose Bash tool has no stdin field keep using the private token staging compatibility path: `transport-create`, one Read of the allocated empty file, Write to that same file, then a fixed `--raw-args-token` invocation. Never delete, rename, recreate, or change the permissions of the transport file; use `transport-discard` when Read or Write fails or when the allocated file is not empty.

- Invoke the helper only through foreground `Bash` with `timeout: 600000`.
- Place every task option before the first prompt token. Use `--` before a prompt that begins with an option shaped token.
- Task, review, and adversarial review reject an implicit working directory below its repository top level before job creation. Pass `--cwd` with either the repository root or the intended subdirectory to choose the sandbox root explicitly.
- The companion forwards `--skip-git-repo-check` to Codex exec. Without that flag or the dangerous bypass flag, Codex refuses to start unless the working directory has an ancestor `.git` entry; the projects trust map in `config.toml` is not consulted by exec. A gate failure names `--skip-git-repo-check` as the remedy.
- Never use Bash background mode. Complexity, duration, and model choice never justify implicit background execution.
- Pass `--background` only when the received request explicitly contains it. The companion owns detachment and returns a durable job receipt.
- A direct slash command invocation returns that receipt without automatic collection. Direct users inspect progress through status and collect the deliverable through result; when Fusion is installed, its monitor can notify them of completion. Fusion orchestration separately owns one same turn collection attempt capped at 540000ms for jobs it creates. A timeout remains explicitly uncollected.
- A task is read only unless `--write` is present. Review commands are always read only.
- Leave `--model` and `--effort` unset unless explicitly requested so Codex configuration remains authoritative.
- Use `--resume <thread-id>` only with a real thread identifier returned by Codex. Use `--resume-last` for the newest eligible task thread launched by the current Claude session, or the newest eligible workspace task when no Claude session id is available.
- A foreground timeout with a resumable thread is salvaged by the wrapper's single scripted wind down resume; the resumed job links through `request.resumeThreadId`, and a second timeout terminalizes the package.
- Use `--fresh` only when the caller explicitly requests a new thread. It cannot be combined with either resume form.
- Use `--web` only when explicitly requested. Use `--network` only with `--write` and only when explicitly requested.
- Use `--output-schema <path>` only for task mode. The companion resolves the path, requires a regular JSON file at most 256 KiB, and records one JSON parsing result without retrying the task. Native `review` ignores output schemas on tested CLI versions. Review shaped task briefs can use `${CLAUDE_PLUGIN_ROOT}/schemas/adversarial-review-verdict.schema.json`; adversarial review uses that schema automatically.
- `result --wait` performs a bounded wait. When the wait budget expires while the job is still active, it leaves the job unchanged and returns output ending in `job: <id>` and `state: running`.
- Terminal output ends with the Codex thread identifier when available, the job identifier, and `state: done`, `state: error`, or `state: cancelled`. Error and cancelled outcomes also include a failure kind.
- Every companion invocation disables Codex `multi_agent` and `multi_agent_v2` features. A collaboration tool event fails the job even if an upstream configuration bypasses those flags.
- `history` reads only the current canonical state root and exposes thread, transport, delivery, semantic, resolved model, and resolved effort fields. Exec sessions remain persisted and resumable locally, but Codex Desktop does not guarantee sidebar visibility for them.
- Return helper stdout exactly as received. Do not interpret it or replace a failed run with Claude-side work.
