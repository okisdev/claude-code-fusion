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
- `review [--base <ref>] [--focus <text>] [--cwd <dir>] [--background] [--json]`
- `status [job-id] [--cwd <dir>] [--json]`
- `result <job-id> [--cwd <dir>] [--wait] [--wait-timeout-ms <ms>] [--json]`
- `cancel <job-id> [--cwd <dir>] [--json]`
- `stats [--all] [--cwd <dir>] [--json]`
- `setup [--enable-stop-gate] [--disable-stop-gate] [--json]`
- `stop-gate`

Execution rules:

- Background has three distinct layers. The Grok rescue Agent is scheduled in the background for orchestration concurrency. Every helper `Bash` call remains foreground. The Grok CLI runs in its own supervised process group, which is not itself a detached user job.
- Ordinary delegations use one foreground helper call with timeout `600000`. Long running delegations may use a managed detached companion worker with `GROK_COMPANION_BACKGROUND_DELIVERY=managed`, followed by a `result --wait` collection chain that stays inside the owning Agent. Only an explicit incoming `--background` creates a manual receipt that crosses the Agent boundary.
- Prefer the helper over hand-rolled `git`, direct Grok CLI strings, or any other Bash activity.
- Consult mode is the default. It pins `--sandbox strict`, which requests working directory read isolation from the operating system sandbox, overrides inherited always approve mode with `--permission-mode default`, and hard filters the built in tool surface to file read, list, and search tools. Working directory read isolation applies only where the platform sandbox initializes and enforces it. `--web` additionally exposes Grok's web search and fetch tools. Shell commands, tests, git, builds, file edits, MCP tools, and subagents are unavailable. `--write` switches to the workspace sandbox and grants edit permission.
- `--best-of-n` runs an implementation tournament (see docs/grok-contract.md; the companion accepts 2 to 10); it implies write mode with auto approval (the winning candidate is applied to the workspace), so pass it only when edits are acceptable.
- `--background` detaches `task` or `review` into a companion worker; the helper prints the job id plus `/grok:status` and `/grok:result` hints. An explicit incoming flag creates manual delivery and the caller returns that receipt. For an internally managed long run, the forwarder also sets `GROK_COMPANION_BACKGROUND_DELIVERY=managed`, then collects that same job with repeated `result <job-id> --wait` calls. Every result call repeats the launch `--cwd`, and an original `--json` stays on both launch and result. Text collection continues only after a zero exit whose output ends in `state: running`; JSON collection continues only after a zero exit with top level `status: "running"` and `cleanupRequired` not true. A text `phase: cleanup-required` or JSON `cleanupRequired: true` result is returned as a nonterminal failure receipt instead of looping. Terminal result collection records successful companion output, not later Agent message delivery. The monitor suppresses collected managed jobs and emits a delayed fallback after the grace period when a terminal managed job remains uncollected, as a best effort owner loss fallback.
- `result --wait` blocks while a job is running, refreshes liveness on each poll, and prints the same terminal output as `result` when the job finishes. If its bounded wait budget elapses first, it prints a compact running render ending in `state: running` and exits zero so the forwarder can issue another foreground wait call. If verified cleanup cannot complete, it exits nonzero and returns the explicit cleanup-required receipt even though the durable record remains running for a later cleanup retry.
- A user asking to resume maps to the companion's `--resume <uuid>` or `--resume-last`. Never invent a session uuid; only uuids recorded by this companion are resumable. The sandbox profile is fixed for a Grok session, so consult resumes only compatible strict sessions and write resumes only compatible workspace sessions. Cross mode and legacy unknown profile resumes fail closed and require a fresh task. `--resume-last` selects the newest compatible non running job, preferring jobs started from the current Claude session.
- Leave `--model` and `--effort` unset so Grok's own config rules apply, unless the user explicitly asks for a specific model or effort level.
- `--cwd` scopes the workspace for task, review, status, and stats. A bad value fails before a job record is created.
- `--json` returns structured output for task, review, status, result, cancel, stats, and setup. Preflight failures with `--json` return a structured error object on stderr.
- The stop gate is primarily toggled by the plugin's `Stop gate review` setting in Claude Code's plugin configuration; `setup --enable-stop-gate` and `setup --disable-stop-gate` persist the same toggle locally as a scripting fallback and only take effect when that setting is left unset. The Stop hook reads the first nonempty reply line: `ALLOW` permits stopping and `BLOCK: <reason>` blocks it; a preamble before `BLOCK` and infrastructure failures fail open. SessionEnd only cleans up jobs.
- `cancel` accepts active foreground or background job ids. It waits for process cleanup before rendering the cancelled record.
- Job outcomes carry a `state:` line (`done`, `error`, or `cancelled`). Error and cancelled outcomes carry a `failure: <kind>` line; cancelled jobs use `failure: cancelled`.
- Return the helper output exactly as-is, whether the Bash tool reports it from stdout or stderr.
- If the Bash call fails or Grok cannot be invoked, surface the failure instead of hiding it; the grok-rescue agent returns exactly one `grok unavailable: <reason>` line for the orchestrator's circuit breaker.
