# claude-code-fusion

Multi-model orchestration for Claude Code. The strongest available Claude model runs your session as a tech lead, cheaper Claude models do the execution, and the local Codex and Grok CLIs act as peer engineers whose usage bills to their own subscriptions instead of your Claude quota.

| Layer | Who | Job |
|---|---|---|
| Orchestrator | the main session on `best[1m]` (Fable 5, or the latest Opus when Fable is unavailable) | plan, delegate, judge, synthesize |
| Claude workers | `fusion:deep-reasoner` (Opus), `fusion:fast-worker` (Sonnet), `fusion:trivial-worker` (Haiku) | deep reasoning, mechanical work, trivial tasks |
| Peer engineers | Codex CLI (official openai-codex plugin) and Grok CLI (the `grok` plugin here) | second opinions, adversarial review, delegated implementation |
| Panel | `/fusion:panel` | one blind brief to both peers in parallel, adjudicated with attribution |

## Quick start

Prerequisites: Claude Code 2.1.170 or later, Node.js 22 or later, git, macOS or Linux, and an authenticated Grok CLI (check with `grok --version`). The Codex side is optional; install [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) to enable it.

```bash
claude plugin marketplace add okisdev/claude-code-fusion
claude plugin install grok@claude-code-fusion
claude plugin install fusion@claude-code-fusion
```

Then, in a new session, run `/fusion:setup` once per machine (it writes the routing rules into `~/.claude/rules/`, where every later session loads them automatically) and `/grok:setup` once to verify the Grok side. The tier agents ship inside the fusion plugin, so nothing else needs copying; re-run `/fusion:setup` only when a plugin update changes the rules, which `/fusion:doctor` flags as drift. From there plain language is enough: ask for "a second opinion from Grok" or "hand this to Codex" and the routing rules make the orchestrator delegate on its own.

## Commands

| Command | What it does |
|---|---|
| `/grok:task <text>` | Delegate to Grok. `--write` allows edits, `--background` detaches, `--resume <uuid>` or `--resume-last` continues a thread |
| `/grok:review [--base <ref>]` | Adversarial review of the working tree or a branch range; never applies fixes |
| `/grok:best-of-n [--n <2-5>] <task>` | Implementation tournament in isolated worktrees; the winning candidate is applied |
| `/grok:status`, `/grok:result <id>`, `/grok:cancel <id>` | Background job lifecycle |
| `/grok:stats` | Delegation history by status, mode, and failure kind |
| `/grok:setup` | Health check; `--enable-stop-gate` / `--disable-stop-gate` toggles the stop-time review gate |
| `/fusion:panel <question>` | Blind two engine panel with attributed adjudication, for decisions where a wrong answer is expensive |
| `/fusion:setup` | Install or update the routing rules into `~/.claude/rules/`; offers the optional permission allow |
| `/fusion:doctor` | Audit model pins, environment overrides, rules drift, and stale agent copies |

A successful foreground `/grok:task` reply ends with `grok-session: <uuid>`, `job: <id>`, and `state: done` lines; a background launch prints the job id and how to fetch it; failed or cancelled jobs carry `state:` and `failure: <kind>` lines.

## Safety model

- Consultations and reviews run read only: an OS level workspace sandbox plus explicit tool denies that hold even against permission allows grok inherits from `~/.claude/settings.json`.
- Write mode and best-of-n auto approve everything outside a short deny list (sudo, `rm -rf`, `git push`, nested CLI launches). That list is a minimal exception set, not a sandbox: run them on a clean branch or a disposable worktree.
- The stop-time review gate is off by default and always fails open: no grok, no block.
- Everything degrades instead of breaking. A missing grok binary or codex plugin trips a session circuit breaker, routing falls back to the other peer and `deep-reasoner`, and `/fusion:panel` substitutes tracks rather than aborting.

## Model roles

Roles bind to alias tiers, not to specific models, so a same tier release (Sonnet 5 under `sonnet`, a future Opus) needs zero configuration, and `best[1m]` floats the orchestrator to future Fable releases or degrades it to the latest Opus when Fable is unavailable. The one deliberate exception is `trivial-worker`, pinned to the full ID `claude-haiku-4-5` for machines where ANTHROPIC_DEFAULT_HAIKU_MODEL remaps the haiku alias; bump it by hand when a newer cheap tier ships. `/fusion:doctor` audits all of this.

## Development

`npm test` runs the suite against a fake grok binary (no real grok, no network). `claude plugin validate plugins/grok`, `... plugins/fusion`, and `... .` check the manifests. Iterate with `claude --plugin-dir ./plugins/grok` plus `/reload-plugins`; after committing and pushing, `claude plugin marketplace update claude-code-fusion` refreshes the installed copy.

## Layout

- `.claude-plugin/marketplace.json`: the marketplace manifest; installs as marketplace `claude-code-fusion`.
- `plugins/grok/`: the Grok integration (companion runtime, `grok-rescue` agent, `/grok:*` commands).
- `plugins/fusion/`: the orchestration layer: tier agents (`agents/`), the routing policy payload (`rules/`), and the `/fusion:panel`, `/fusion:setup`, and `/fusion:doctor` commands.
- `tests/`: the fake-grok driven test suite.

## Internals

The verified Grok CLI contract (headless invocation, session threading, permission inheritance, process lifecycle, stop gate parsing) lives in [docs/grok-contract.md](docs/grok-contract.md).

## License

[MIT](LICENSE)
