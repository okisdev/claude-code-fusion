# claude-code-fusion

Multi-model orchestration for Claude Code. The strongest available Claude model runs your session as a tech lead, cheaper Claude models do the execution, and the local Codex and Grok CLIs act as peer engineers whose engine work bills to their own subscriptions. The orchestrator and the Claude worker tiers still bill to your Claude plan; delegation moves the heavy execution off it.

| Layer | Who | Job |
|---|---|---|
| Orchestrator | the main session on `best[1m]` (Fable 5, or the latest Opus when Fable is unavailable) | plan, delegate, judge, synthesize |
| Claude workers | `fusion:deep-reasoner` (Opus), `fusion:fast-worker` (Sonnet), `fusion:trivial-worker` (Haiku) | deep reasoning, mechanical work, trivial tasks |
| Peer engineers | Codex CLI (OpenAI's official `codex` plugin) and Grok CLI (the `grok` plugin here) | second opinions, adversarial review, delegated implementation |
| Panel | `/fusion:panel` | one blind brief to both peers in parallel, adjudicated with attribution |

## Quick start

Prerequisites: Claude Code 2.1.170 or later and Node.js 22 or later (tested on 2.1.198 and Node 24; the floors are not enforced), git, macOS or Linux, and an authenticated Grok CLI on PATH (check with `grok --version`; the CLI is xAI's, so follow their install and login docs). The Codex side is optional; install the `codex` plugin from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (`codex@openai-codex`) to enable it.

```bash
claude plugin marketplace add okisdev/claude-code-fusion
claude plugin install grok@claude-code-fusion
claude plugin install fusion@claude-code-fusion
```

Then, in a new session, run `/fusion:setup` once per machine (it writes the routing rules into `~/.claude/rules/`, where every later session loads them automatically) and `/grok:setup` once to verify the Grok side. The tier agents ship inside the fusion plugin, so nothing else needs copying; re-run `/fusion:setup` only when a plugin update changes the rules, which `/fusion:doctor` flags as drift. From there plain language is enough: ask for "a second opinion from Grok" or "hand this to Codex" and the routing rules make the orchestrator delegate on its own.

## Commands

| Command | What it does |
|---|---|
| `/grok:task <text>` | Delegate to Grok. `--write` allows edits, `--background` detaches, `--resume <uuid>` or `--resume-last` continues a thread; `--model`, `--effort`, and `--max-turns` forward explicit overrides |
| `/grok:review [--base <ref>] [--focus <text>]` | Adversarial review of the working tree or a branch range (untracked files reach the review as names only); never applies fixes |
| `/grok:best-of-n [--n <2-10>] <task>` | Implementation tournament in isolated worktrees; the winning candidate is applied. Keep n at 2; the companion rejects values outside 2 to 10 |
| `/grok:status [job-id]`, `/grok:result <job-id>`, `/grok:cancel <job-id>` | Background job lifecycle |
| `/grok:stats [--all]` | Grok delegation history by status, mode, and failure kind |
| `/fusion:stats [--all]` | Delegation history across both grok and codex peers |
| `/grok:setup` | Health check; `--enable-stop-gate` / `--disable-stop-gate` toggles the stop-time review gate |
| `/fusion:panel <question>` | Blind multi-model panel with attributed adjudication, for decisions where a wrong answer is expensive |
| `/fusion:setup` | Install or update the routing rules into `~/.claude/rules/`; offers the optional permission allow |
| `/fusion:doctor` | Audit model pins, environment overrides, rules drift, and stale agent copies |

Every companion outcome is machine parseable: successful foreground replies end with `grok-session: <uuid>`, `job: <id>`, and `state: done` lines; failures report `state: error` plus `failure: <kind>`; cancelled jobs report `state: cancelled` with `failure: cancelled`; a background launch prints the job id and how to fetch it.

## Safety model

Two layers with different strength, stated plainly.

Enforced by the companion runtime (code, covered by the test suite): consult runs combine an OS level workspace sandbox with explicit tool denies (Edit, Write, and nested grok, claude, codex, and node launches). The denies matter because grok inherits permission allows from `~/.claude/settings.json` and deny beats allow (verified against grok 0.2.16, see [docs/grok-contract.md](docs/grok-contract.md); inherited allows outside the deny list can still extend a consult run, so keep the global allowlist small). Write mode and best-of-n auto approve everything outside a short deny list (sudo, `rm -rf`, `git push`, nested CLI launches); that list is a minimal exception set, not a sandbox, so run them on a clean branch or a disposable worktree. The stop-time review gate is off by default and fails open on every error path: no grok, no block.

Requested by prompts (the orchestrator follows the installed instructions; not runtime enforced): the routing policy, the panel's blindness, review never applying fixes, and the session circuit breaker that stops routing to a peer after a `grok unavailable:` line or a quota, auth, or missing_cli failure kind. `/fusion:panel` substitutes `fusion:deep-reasoner` for a missing track rather than aborting.

## Model roles

Roles bind to alias tiers, not to specific models, so a same tier release (Sonnet 5 under `sonnet`, a future Opus) needs zero configuration, and `best[1m]` floats the orchestrator to future Fable releases or degrades it to the latest Opus when Fable is unavailable. The one deliberate exception is `fusion:trivial-worker`, pinned to the full ID `claude-haiku-4-5` for machines where ANTHROPIC_DEFAULT_HAIKU_MODEL remaps the haiku alias; bump it by hand when a newer cheap tier ships. Alias semantics are Claude Code behavior as observed on 2.1.x, and nothing here sets your main model for you: pick it yourself, for example `/model best`. `/fusion:doctor` audits all of this.

## Data and uninstall

The grok plugin keeps job records, briefs, and logs under `~/.claude/plugins/data/grok-claude-code-fusion/`; briefs can contain your prompts and diffs, and logs can contain grok stderr. Delete that directory to clear history. Full uninstall: remove both plugins via `/plugin`, delete `~/.claude/rules/orchestration.md`, drop the optional `Bash(node:*)` entry from `permissions.allow`, and delete the data directory. Environment overrides (`GROK_BIN`, `GROK_COMPANION_DATA`, `GROK_COMPANION_TIMEOUT_MS`) are documented in [docs/grok-contract.md](docs/grok-contract.md). `/fusion:stats` aggregates delegation counts across both peers; token usage itself lives with each vendor (ccusage for the Claude side, the OpenAI and xAI dashboards for the peers), since peer work never touches the Claude transcript.

## Development

`npm test` runs the suite against a fake grok binary (no real grok, no network). `claude plugin validate plugins/grok`, `... plugins/fusion`, and `... .` check the manifests. Iterate with `claude --plugin-dir ./plugins/grok` plus `/reload-plugins`; after committing and pushing, `claude plugin marketplace update claude-code-fusion` refreshes the installed copy.

## Layout

- `.claude-plugin/marketplace.json`: the marketplace manifest; installs as marketplace `claude-code-fusion`.
- `plugins/grok/`: the Grok integration (companion runtime, `grok-rescue` agent, `/grok:*` commands).
- `plugins/fusion/`: the orchestration layer: tier agents (`agents/`), the routing policy payload (`rules/`), and the `/fusion:panel`, `/fusion:setup`, and `/fusion:doctor` commands.
- `tests/`: the fake-grok driven test suite.

## Internals

The verified Grok CLI contract (headless invocation, session threading, permission inheritance, process lifecycle, timeouts, stop gate parsing) lives in [docs/grok-contract.md](docs/grok-contract.md). Bug reports and questions go to GitHub issues.

## License

[MIT](LICENSE)
