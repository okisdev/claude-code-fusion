# Grok CLI contract

The original facts below were verified live against grok 0.2.16 on July 2, 2026 and are implemented by `plugins/grok/scripts/`. Permission matcher behavior was rechecked locally against grok 0.2.82 on July 4, 2026 through `grok --help` and the installed user guide. They are maintainer documentation; nothing here is needed to use the plugin. The Grok CLI evolves, so treat every claim as pinned to those versions and reverify after CLI updates.

The shared companion outcome contract lives in [docs/companion-contract.md](companion-contract.md). This document is the Grok instance and records only Grok CLI invocation, flags, envelopes, field names, constants, and version pinned behavior.

## Shared companion contract

Job statuses, liveness, rendered outcome footers, failure kind definitions, background collection, `resume-last` selection, and stop gate verdict grammar follow [docs/companion-contract.md](companion-contract.md).

## Headless invocation

- The companion calls `grok --prompt-file <brief> --output-format json`, which returns one JSON object on stdout: `{"text", "stopReason", "sessionId", "requestId"}`. Transient recoverable auth errors appear on stderr, so the companion parses stdout only and routes stderr to the per job log. A zero exit run without a valid JSON envelope maps to the shared `error` failure kind; the rendered message includes a bounded stdout tail.
- Model and effort are never passed by default; grok resolves them from its own config (`~/.grok/config.toml`, project `.grok/config.toml`). The companion's `--model` and `--effort` flags forward them explicitly when a caller insists.

## Session threading

- Capture `sessionId` from the JSON output and resume with `-r <uuid>`. The `-s` flag does not upsert named sessions (each run with an unknown name silently creates a fresh uuid session); only uuids grok itself returned are resumable.

## Permissions

- Consult mode: `--sandbox workspace --permission-mode dontAsk` with a narrow allow list (Read, Grep, git read commands, and read only `gh` subcommands: `pr view`, `pr list`, `pr diff`, `pr checks`, `issue view`, `issue list`, `repo view`, `search`, `run view`, `run list`, `release view`, `release list`) plus explicit deny rules for Edit, Write, shell command metacharacters, and nested grok, claude, codex, and node launches. `gh api` is deliberately excluded from the allow list even in consult mode, since it can send mutating requests with the user's credentials; it stays write mode only.
- Grok's installed user guide describes `Bash(npm run build)` as exact command or prefix matching and `Bash(git *)` as any command starting with `git `. That prefix behavior would allow compound commands if a broad pattern matched the beginning of the shell string, so the companion uses space delimited command shapes and consult deny rules for `;`, `&&`, `||`, `|`, redirection, backticks, and `$` expansion. This is defensive hardening based on local documentation rather than a live destructive probe.
- The denies are load bearing: grok inherits permission allow rules from `~/.claude/settings.json` and deny beats allow (verified live). Without them, an inherited allow such as `Bash(node:*)` would silently extend a consult run beyond the documented read only surface. Inherited allows outside the deny list can still extend what a consult run may execute, so keep the global allowlist small.
- Write mode: `--sandbox workspace --always-approve` with deny rules for sudo, `rm -rf`, `git push`, and nested grok, claude, and codex invocations. Everything else is auto approved.
- When a consult mode turn calls a tool outside the allow list, the `dontAsk` permission gate cancels the whole turn: the CLI exits 0 with `stopReason: "Cancelled"` and empty or partial text instead of `stopReason: "EndTurn"`. The companion maps that shape to the shared `permission` failure kind rather than reporting a misleading success.
- `--no-subagents` stays on every call because grok auto discovers Claude Code agent definitions under `~/.claude/agents` and could otherwise recursively spawn them. Best-of-n runs are the exception, since the tournament needs subagents. Web tools are disabled by default (`--disable-web-search`); the task subcommand's `--web` flag re-enables them for research briefs.

## Process lifecycle

- grok is spawned detached in its own process group, and the child pid is recorded on the job record as `grokPid`. Timeout, cancel, and the SessionEnd hook signal the process group, so descendants are reaped with the leader.
- Timeouts: foreground runs default to 570000ms (deliberately below the 600000ms Bash timeout the forwarder agent uses, so the companion always reaps first and writes the record); background workers cap at 1800000ms; the stop gate caps its grok call at 240000ms inside the hook's 900 second budget; the `/grok:review` background flow overrides the foreground default with `GROK_COMPANION_TIMEOUT_MS=1800000`. Timeout, cancel, and SessionEnd cleanup send SIGTERM, poll for up to 2000ms, then escalate to SIGKILL when the process group is still alive. Exit codes: 0 ok, 1 error, 130 SIGINT, 137 SIGKILL, 143 SIGTERM, and other signals map to 128 plus the signal number. Interrupted runs keep their file modifications and are resumable via the session uuid when grok reported one before the interruption; a run killed before emitting its JSON envelope leaves no session id on the record.
- Grok uses `pid` for the driving worker pid and `grokPid` for the Grok CLI child pid. The pidless launcher grace window defaults to 15000ms and can be overridden with `GROK_COMPANION_PIDLESS_RUNNING_GRACE_MS`.

## Environment overrides

- `GROK_BIN`: grok binary override (tests point it at a fake). `GROK_COMPANION_DATA`: state directory override (default `~/.claude/plugins/data/grok-claude-code-fusion`). `GROK_COMPANION_TIMEOUT_MS`: foreground timeout override. `GROK_COMPANION_PIDLESS_RUNNING_GRACE_MS`: pidless launcher grace override. `GROK_CONSULT_ALLOW`: comma separated extra allow rules appended to the consult mode allow list; deny rules still beat them and write mode ignores this variable.

## Stop gate

- The Stop hook pipes the hook JSON into the companion's `stop-gate` subcommand. It exits silently when the gate is off, `stop_hook_active` is set, the cwd is not a git repository, or the working tree diff is empty; otherwise grok reviews the diff in consult mode.
- Grok uses `plugins/grok/prompts/stop-gate.md`, expects the shared first line verdict grammar, and runs in consult mode with timeout 240000ms inside the hook's 900 second budget. Infrastructure failures follow the shared fail open rule.

## Review contract

- `/grok:review` uses `plugins/grok/prompts/review.md` for the model contract and `validateReviewOutput` in `plugins/grok/scripts/lib/render.mjs` as the canonical runtime validator. There is no separate JSON schema file in the runtime contract.

## Degradation

- A missing grok binary fails fast with a message pointing at `/grok:setup`, and the `grok-rescue` agent returns a single `grok unavailable: <reason>` line the orchestrator uses to stop routing to Grok for the session.
- A bad `--cwd` fails before the companion creates a job record and maps to the shared `input` failure kind.
