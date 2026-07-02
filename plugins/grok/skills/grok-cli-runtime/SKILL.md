---
name: grok-cli-runtime
description: Internal helper contract for calling the grok-companion runtime from Claude Code
user-invocable: false
---

# Grok runtime

Primary helper:

- `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" <subcommand> [flags]`

Subcommand surface:

- `task [prompt] [--prompt-file <path>] [--write] [--background] [--resume <uuid>] [--resume-last] [--model <id>] [--effort <level>] [--max-turns <n>] [--best-of-n <n>] [--cwd <dir>] [--json]`
- `review [--base <ref>] [--focus <text>] [--cwd <dir>] [--json]`
- `status [job-id]`
- `result <job-id> [--json]`
- `cancel <job-id>`
- `stats [--all] [--cwd <dir>] [--json]`
- `setup`

Execution rules:

- Use exactly one helper call per delegation. The caller is a forwarder, not an orchestrator.
- Prefer the helper over hand-rolled `git`, direct Grok CLI strings, or any other Bash activity.
- Consult mode is the default; `--write` grants Grok edit permission inside the workspace sandbox.
- `--best-of-n` runs an implementation tournament, validated end to end against the real Grok CLI; it implies write mode with auto approval (the winning candidate is applied to the workspace), so pass it only when edits are acceptable.
- `--background` detaches the run into a worker; the helper prints the job id plus `/grok:status` and `/grok:result` hints.
- A user asking to resume maps to the companion's `--resume <uuid>` or `--resume-last`. Never invent a session uuid; only uuids Grok returned are resumable. `--resume-last` resumes the newest non running job with a session id for the workspace, preferring jobs started from the current Claude session.
- Leave `--model` and `--effort` unset so Grok's own config rules, unless the user explicitly asks for a specific model or effort level.
- Failed runs carry a `failure: <kind>` line in their rendered output; the orchestrator uses it for session circuit breaking.
- Return the stdout of the helper exactly as-is.
- If the Bash call fails or Grok cannot be invoked, return nothing.
