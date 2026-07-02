# Grok CLI contract

The facts below were verified live against grok 0.2.16 on 2026-07-02 and are implemented by `plugins/grok/scripts/`. They are maintainer documentation; nothing here is needed to use the plugin.

## Headless invocation

- The companion calls `grok --prompt-file <brief> --output-format json`, which returns one JSON object on stdout: `{"text", "stopReason", "sessionId", "requestId"}`. Transient recoverable auth errors appear on stderr, so the companion parses stdout only and routes stderr to the per job log.
- Model and effort are never passed by default; grok resolves them from its own config (`~/.grok/config.toml`, project `.grok/config.toml`). The companion's `--model` and `--effort` flags forward them explicitly when a caller insists.

## Session threading

- Capture `sessionId` from the JSON output and resume with `-r <uuid>`. The `-s` flag does not upsert named sessions (each run with an unknown name silently creates a fresh uuid session); only uuids grok itself returned are resumable.
- `--resume-last` on the companion resolves the newest non running job with a session id for the workspace, preferring jobs started from the current Claude session.

## Permissions

- Consult mode: `--sandbox workspace --permission-mode dontAsk` with a narrow allow list (Read, Grep, git read commands) plus explicit deny rules for Edit, Write, and nested grok, claude, codex, and node launches.
- The denies are load bearing: grok inherits permission allow rules from `~/.claude/settings.json` and deny beats allow (verified live). Without them, an inherited allow such as `Bash(node:*)` would silently extend a consult run beyond the documented read only surface. Inherited allows outside the deny list can still extend what a consult run may execute, so keep the global allowlist small.
- Write mode: `--sandbox workspace --always-approve` with deny rules for sudo, `rm -rf`, `git push`, and nested grok, claude, and codex invocations. Everything else is auto approved.
- `--no-subagents` stays on every call because grok auto discovers Claude Code agent definitions under `~/.claude/agents` and could otherwise recursively spawn them. Best-of-n runs are the exception, since the tournament needs subagents.

## Process lifecycle

- grok is spawned detached in its own process group, and the child pid is recorded on the job record as `grokPid`. Timeout, cancel, and the SessionEnd hook signal the process group, so descendants are reaped with the leader.
- Timeout escalates SIGTERM to SIGKILL after a 10 second grace, guarded so a process that already exited is never signaled again (PID reuse). Exit codes: 0 ok, 1 error, 130 SIGINT, 143 SIGTERM. Interrupted runs keep their file modifications and are resumable via the session uuid.
- Failed runs carry a typed `failureKind` (missing_cli, auth, rate_limited, quota, timeout, cancelled, error) on the job record and a `failure: <kind>` line in rendered output; the routing policy uses it for session circuit breaking.

## Stop gate

- The Stop hook pipes the hook JSON into the companion's `stop-gate` subcommand. It exits silently when the gate is off, `stop_hook_active` is set, the cwd is not a git repository, or the working tree diff is empty; otherwise grok reviews the diff in consult mode.
- The verdict is the first line in the reply that starts with `BLOCK:` (grok sometimes prefixes a preamble line, so the parser scans the whole reply rather than only line one). Anything without a BLOCK line allows the stop. Infrastructure failures always allow.

## Degradation

- A missing grok binary fails fast with a message pointing at `/grok:setup`, and the `grok-rescue` agent returns a single `grok unavailable: <reason>` line the orchestrator uses to stop routing to Grok for the session.
- If the codex plugin is not installed, its agent type does not exist and the routing policy falls back symmetrically. `/fusion:panel` substitutes `deep-reasoner` for any missing track, or runs a two lens Claude only panel when both engines are missing, and says so in the synthesis.
