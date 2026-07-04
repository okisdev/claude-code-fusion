---
name: grok-cli-runtime
description: Internal helper contract for calling the grok-companion runtime from Claude Code
user-invocable: false
---

# Grok runtime

Primary helper:

- `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" <subcommand> [flags]`

Subcommand surface:

- `task [prompt] [--prompt-file <path>] [--write] [--web] [--background] [--resume <uuid>] [--resume-last] [--model <id>] [--effort <level>] [--max-turns <n>] [--best-of-n <n>] [--cwd <dir>] [--json]`
- `review [--base <ref>] [--focus <text>] [--cwd <dir>] [--json]`
- `status [job-id] [--cwd <dir>] [--json]`
- `result <job-id> [--json]`
- `cancel <job-id> [--cwd <dir>] [--json]`
- `stats [--all] [--cwd <dir>] [--json]`
- `setup [--enable-stop-gate] [--disable-stop-gate] [--json]`
- `stop-gate`

Execution rules:

- Use exactly one helper call per delegation. The caller is a forwarder, not an orchestrator.
- Prefer the helper over hand-rolled `git`, direct Grok CLI strings, or any other Bash activity.
- Consult mode is the default; `--write` grants Grok edit permission inside the workspace sandbox, and `--web` re-enables the web tools for research briefs.
- `--best-of-n` runs an implementation tournament (verified against grok 0.2.16, see docs/grok-contract.md; the companion accepts 2 to 10); it implies write mode with auto approval (the winning candidate is applied to the workspace), so pass it only when edits are acceptable.
- `--background` detaches the run into a worker; the helper prints the job id plus `/grok:status` and `/grok:result` hints.
- A user asking to resume maps to the companion's `--resume <uuid>` or `--resume-last`. Never invent a session uuid; only uuids Grok returned are resumable. `--resume-last` resumes the newest non running job with a session id for the workspace, preferring jobs started from the current Claude session.
- Leave `--model` and `--effort` unset so Grok's own config rules apply, unless the user explicitly asks for a specific model or effort level.
- `--cwd` scopes the workspace for task, review, status, and stats. A bad value fails before a job record is created.
- `--json` returns structured output for task, review, status, result, cancel, stats, and setup. Preflight failures with `--json` return a structured error object on stderr.
- `setup --enable-stop-gate` turns on the stop gate, and `setup --disable-stop-gate` turns it off.
- `cancel` accepts active foreground or background job ids. It waits for process cleanup before rendering the cancelled record.
- Job outcomes carry a `state:` line (`done`, `error`, or `cancelled`). Error and cancelled outcomes carry a `failure: <kind>` line; cancelled jobs use `failure: cancelled`.
- Return the stdout of the helper exactly as-is.
- If the Bash call fails or Grok cannot be invoked, surface the failure instead of hiding it; the grok-rescue agent returns exactly one `grok unavailable: <reason>` line for the orchestrator's circuit breaker.
