# claude-code-fusion

Personal multi-model orchestration for Claude Code. Fable 5 runs the main session as the orchestrator, model-pinned Claude subagents handle execution tiers, and the local Codex and Grok CLIs act as peer senior engineers billed to their own subscriptions. The repo is both a Claude Code plugin marketplace (the `grok` and `fusion` plugins) and the canonical backup of the plain-config orchestration layer.

## Prerequisites

- Claude Code 2.1.170 or later (the `fable` model alias, `~/.claude/rules/`, and the plugin marketplace CLI all require it).
- Node.js 22 or later on PATH (tested on 24). The companion runtime and hooks run on it.
- git. Reviews diff against it and best-of-n tournaments use worktrees.
- macOS or Linux. Job control uses POSIX process groups; Windows is not supported.
- The Grok CLI installed and authenticated (a SuperGrok plan; verify with `grok --version`). Required for the grok plugin. Model and effort defaults belong in `~/.grok/config.toml`; the companion never overrides them.
- The official openai-codex plugin plus an authenticated Codex CLI. Optional; it powers the Codex half of the peer setup and the second panel track. Install with `/plugin marketplace add openai/codex-plugin-cc`, then `/plugin install codex@openai-codex`.
- A Claude plan with Opus, Sonnet, and Haiku available for the tier agents.

## Install

Plugins: `claude plugin marketplace add okisdev/claude-code-fusion` (or the local repo path), then `claude plugin install grok@claude-code-fusion` and `claude plugin install fusion@claude-code-fusion`. Run `/grok:setup` in a new session as the first step; it probes the grok binary, the data directory, and the stop gate state.

Config layer: `./install.sh install` copies the agent and rules files into `~/.claude`, backing up anything it would overwrite; `./install.sh diff` compares the repo against the live files and exits nonzero on drift. Optionally merge `settings/permissions.snippet.json` into `~/.claude/settings.json` so the forwarder agents run the companion without a first-use permission prompt (`Bash(node:*)` is broad; skipping it just means approving the first call by hand). The live files under `~/.claude` are the working copies; this repo is the canonical backup.

## Usage

Day to day, the routing policy in `rules/orchestration.md` makes Fable delegate on its own: search goes to the built in Explore agent, mechanical work to `fast-worker` or `trivial-worker`, hard reasoning to `deep-reasoner`, and second opinions to `codex-rescue` or `grok-rescue`. Asking for "a second opinion from Grok" or "hand this to Codex" in plain language is enough.

Explicit commands:

- `/grok:task <what to do>` delegates a task to Grok. Add `--write` to allow edits, `--background` for long work (then `/grok:status` and `/grok:result <job-id>`), and `--resume <uuid>` or `--resume-last` to continue a thread. Every reply ends with `grok-session: <uuid>` and `job: <id>` lines for threading.
- `/grok:review [--base <ref>] [--focus <text>]` runs an adversarial Grok review of the working tree (or a branch range) and renders structured findings. Review only; it never applies fixes.
- `/grok:best-of-n [--n <2-5>] <task>` runs an implementation tournament: n candidates in isolated worktrees, the winner applied to the workspace. Write mode by definition, and xAI usage multiplies by n.
- `/fusion:panel <decision or question>` convenes a blind panel: one neutral brief goes to Codex and Grok in parallel, neither sees the other, and Fable adjudicates the verdicts with attribution. Use it for choices where a wrong answer is expensive.
- `/grok:setup` health checks the integration; `--enable-stop-gate` / `--disable-stop-gate` toggle the stop-time review gate (default off). With the gate on, Grok reviews the working tree diff every time Claude tries to stop and can block the stop with a reason; infrastructure failures never block.
- `/grok:cancel <job-id>` terminates a running job and its Grok process tree.
- `/grok:stats` aggregates the delegation history for the workspace (jobs by status, mode, and failure kind, plus durations), which is how you check whether the routing policy routes as intended.
- `/fusion:doctor` audits the Claude side for model drift: environment overrides, the main model setting, and every agent's model pin, with rot risks flagged.

## Model roles and evolution

Roles are bound to alias tiers, not to specific models, so new Claude releases adopt their role automatically when Anthropic updates the alias resolution:

| Role | Binding | Today |
|---|---|---|
| Orchestrator (main session) | `best[1m]` in settings | Fable 5 when available, latest Opus otherwise; floats to future Fable releases |
| Deep reasoning executor | `deep-reasoner` pinned to the `opus` alias | Opus 4.8 |
| Mechanical executor | `fast-worker` pinned to the `sonnet` alias | Sonnet 5 |
| Trivial executor | `trivial-worker` pinned to the full ID `claude-haiku-4-5` | Deliberate exception: the haiku alias is remapped on this machine, so this pin must be bumped by hand when a newer cheap tier ships |
| Peer engineers | Whatever each CLI's own config selects | `~/.grok/config.toml` for Grok, codex config.toml for Codex; this setup never pins them |

Consequences: a same tier release (Sonnet 5, a future Opus) needs zero configuration; only a genuinely new tier above or between the rungs requires a decision about which role gets it. If Fable becomes unavailable (it was suspended for three weeks in June 2026, and moves to metered usage credits after July 7, 2026), `best[1m]` degrades the orchestrator to the latest Opus and every rule keeps working because the policy is written against the role, not the model. If a session silently falls back from Fable mid-flight (safety classifier), `/model best` restores it. `/fusion:doctor` audits all of this.

## When a peer CLI is missing

Everything degrades instead of breaking. If the grok binary is absent, companion runs fail fast with an actionable message pointing at `/grok:setup`, and `grok-rescue` returns a single `grok unavailable:` line; the routing policy then stops routing to Grok for the rest of the session and uses Codex and `deep-reasoner` instead. If the codex plugin is not installed, its agent type simply does not exist and the same fallback applies in reverse. `/fusion:panel` substitutes `deep-reasoner` for any missing track (or runs a two-lens Claude-only panel when both engines are missing) and says so in the synthesis. The stop gate always fails open: no grok, no block.

## Grok invocation contract

Verified against grok 0.2.16 on 2026-07-02 and implemented by `plugins/grok/scripts/`:

- Headless call: `grok --prompt-file <brief> --output-format json` returns `{"text", "stopReason", "sessionId", "requestId"}` on stdout; transient recoverable auth errors appear on stderr, so the companion parses stdout only and routes stderr to the job log.
- Model and effort are never passed by default; grok resolves them from its own config (`~/.grok/config.toml`, project `.grok/config.toml`). `--model` and `--effort` on the companion forward them explicitly.
- Consult mode: `--sandbox workspace --permission-mode dontAsk` with a narrow `--allow` list (Read, Grep, git read commands) keeps runs effectively read only while still letting grok persist its session state.
- Write mode: `--sandbox workspace --always-approve` with `--deny` rules for sudo, `rm -rf`, `git push`, and nested grok, claude, and codex invocations.
- Threading: capture `sessionId` from the JSON output and resume with `-r <uuid>`. The `-s` flag does not upsert named sessions; only uuids returned by grok are resumable.
- `--no-subagents` stays on every call because grok auto discovers Claude Code agent definitions under `~/.claude/agents` and could otherwise recursively spawn them (`--best-of-n` runs are the exception, since the tournament needs subagents).
- `--deny "Bash(grok*)"` also stays on every call: grok inherits the permission allowlist from `~/.claude/settings.json`, so without the deny a delegated run could launch nested grok processes unapproved.

## Development

`npm test` runs the suite (node:test against `tests/fake-grok`; no real grok, no network). `claude plugin validate plugins/grok`, `... plugins/fusion`, and `... .` check the manifests. Iterate with `claude --plugin-dir ./plugins/grok` plus `/reload-plugins`, and refresh the installed copy after committing with `claude plugin marketplace update claude-code-fusion`.

## Layout

- `.claude-plugin/marketplace.json`: the marketplace manifest; this repo installs as marketplace `claude-code-fusion`.
- `plugins/grok/`: the Grok integration. A Node companion script wraps the grok CLI headless mode with background jobs, session threading, adversarial review, the stop gate, and best-of-n tournaments; surfaced as the `grok-rescue` subagent plus the `/grok:*` commands.
- `plugins/fusion/`: multi-model orchestration commands, currently `/fusion:panel`.
- `agents/`: model-pinned Claude tier agents (`deep-reasoner` on Opus at xhigh effort, `fast-worker` on Sonnet, `trivial-worker` on true Haiku by full model ID since the haiku alias is remapped on this machine).
- `rules/orchestration.md`: the routing policy loaded into every session; Fable plans, decomposes, judges, and synthesizes, and delegates everything else.
- `settings/permissions.snippet.json`: the optional permission allow described under Install.
- `install.sh`: copies the plain-config files into `~/.claude` or reports drift.
- `tests/`: the fake-grok driven test suite.
