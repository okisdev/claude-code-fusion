# claude-code-fusion

Multi-model orchestration for Claude Code. The strongest available Claude model runs your session as a tech lead, cheaper Claude models do the execution, and the local Codex and Grok CLIs act as peer engineers whose engine work bills to their own subscriptions. The orchestrator and the Claude worker tiers still bill to your Claude plan; delegation moves the heavy execution off it.

| Layer | Who | Job |
|---|---|---|
| Orchestrator | the main session on `best[1m]` (Fable 5, or the latest Opus when Fable is unavailable) | plan, delegate, judge, synthesize |
| Claude workers | `fusion:deep-reasoner` (Opus), `fusion:fast-worker` (Sonnet), `fusion:trivial-worker` (Haiku) | deep reasoning, mechanical work, trivial tasks when Grok is unavailable |
| Peer engineers | Codex CLI (OpenAI's official `codex` plugin) and Grok CLI (the `grok` plugin here) | Codex is the primary implementation lane on the current GPT 5.x flagship and expects spec grade briefs (explicit completion criteria, output contract, boundaries, verification command); Grok is the quick turnaround lane on Composer 2.5 Fast by default for small fixes, drafts, research digests, and large context reads. Trivial single file tasks default to Grok |
| Panel | `/fusion:panel` | one blind brief to both peers in parallel, adjudicated with attribution |

## Quick start

Prerequisites: Claude Code 2.1.170 or later and Node.js 22 or later (tested on 2.1.198 and Node 24; the floors are not enforced), git, macOS or Linux, and an authenticated Grok CLI on PATH (check with `grok --version`; the CLI is xAI's, so follow their install and login docs). The Codex side powers the primary implementation lane; install the `codex` plugin from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (`codex@openai-codex`) and run `/codex:setup` once. Without it fusion still runs, with spec grade implementation packages falling back to the Claude workers and Grok.

```bash
claude plugin marketplace add okisdev/claude-code-fusion
claude plugin install grok@claude-code-fusion
claude plugin install fusion@claude-code-fusion
```

Then, in a new session, run `/fusion:setup` once per machine (it writes the routing rules into `~/.claude/rules/`, where every later session loads them automatically) and `/grok:setup` once to verify the Grok side. The tier agents ship inside the fusion plugin, so nothing else needs copying. After that, a SessionStart hook applies rules updates from later plugin upgrades automatically at the next session start, as long as the live copy still matches a version the plugin has shipped; re-run `/fusion:setup` only if you hand edited `~/.claude/rules/orchestration.md`, which the hook and `/fusion:doctor` both flag as drift. From there plain language is enough: ask for "a second opinion from Grok" or "hand this to Codex" and the routing rules make the orchestrator delegate on its own.

## Commands

| Command | What it does |
|---|---|
| `/grok:task <text>` | Delegate to Grok. `--write` allows edits, `--web` enables web tools for research, `--background` detaches, `--resume <uuid>` or `--resume-last` continues a thread; `--model`, `--effort`, and `--max-turns` forward explicit overrides |
| `/grok:review [--base <ref>] [--focus <text>]` | Adversarial review of the working tree or a branch range (untracked files reach the review as names only); never applies fixes |
| `/grok:best-of-n [--n <2-10>] <task>` | Implementation tournament in isolated worktrees; the winning candidate is applied. Keep n at 2; the companion rejects values outside 2 to 10 |
| `/grok:status [job-id]`, `/grok:result <job-id>`, `/grok:cancel <job-id>` | Background job lifecycle |
| `/grok:stats [--all]` | Grok delegation history by status, mode, and failure kind |
| `/fusion:stats [--all]` | Delegation history across both grok and codex peers |
| `/grok:setup` | Health check; `--enable-stop-gate` / `--disable-stop-gate` toggles the stop-time review gate |
| `/fusion:panel <question>` | Blind multi-model panel with attributed adjudication, for decisions where a wrong answer is expensive. Also fires from plain language ("help me decide", "compare these") |
| `/fusion:ultra <task>` | Fans a large task out as a fleet of parallel Grok and Codex agents billed to their own subscriptions, then synthesizes. Fires from "go deep", "audit everything", "be exhaustive"; skips small tasks |
| `/fusion:setup` | Install or update the routing rules into `~/.claude/rules/`; offers the optional permission allow |
| `/fusion:config` | Read the local model configuration across engines, enumerate available models, and change defaults interactively |
| `/fusion:doctor` | Audit model pins, environment overrides, rules drift, and stale agent copies |

Every companion outcome is machine parseable: successful foreground replies end with `grok-session: <uuid>`, `job: <id>`, and `state: done` lines; failures report `state: error` plus `failure: <kind>`; cancelled jobs report `state: cancelled` with `failure: cancelled`; a background launch prints the job id and how to fetch it.

## Safety model

Two layers with different strength, stated plainly.

Enforced by the companion runtime (code, covered by the test suite): consult runs combine an OS level workspace sandbox with explicit tool denies (Edit, Write, and nested grok, claude, codex, and node launches). The denies matter because grok inherits permission allows from `~/.claude/settings.json` and deny beats allow (verified against grok 0.2.16, see [docs/grok-contract.md](docs/grok-contract.md); inherited allows outside the deny list can still extend a consult run, so keep the global allowlist small). Write mode and best-of-n auto approve everything outside a short deny list (sudo, `rm -rf`, `git push`, nested CLI launches); that list is a minimal exception set, not a sandbox, so run them on a clean branch or a disposable worktree. The stop-time review gate is off by default and fails open on every error path: no grok, no block.

Requested by prompts (the orchestrator follows the installed instructions; not runtime enforced): the routing policy, the panel's blindness, review never applying fixes, and the session circuit breaker that stops routing to a peer after a `grok unavailable:` line or a quota, auth, or missing_cli failure kind. `/fusion:panel` substitutes `fusion:deep-reasoner` for a missing track rather than aborting.

## Model roles

Roles bind to alias tiers, not to specific models, so a same tier release (Sonnet 5 under `sonnet`, a future Opus) needs zero configuration, and `best[1m]` floats the orchestrator to future Fable releases or degrades it to the latest Opus when Fable is unavailable. The one deliberate exception is `fusion:trivial-worker`, pinned to the full ID `claude-haiku-4-5` for machines where ANTHROPIC_DEFAULT_HAIKU_MODEL remaps the haiku alias; bump it by hand when a newer cheap tier ships. It is a fallback for trivial work when Grok is unavailable, not the default for single file tasks. Peer engine defaults live in each CLI's config (`~/.grok/config.toml`, `~/.codex/config.toml`); `/fusion:config` reads and changes them interactively. Alias semantics are Claude Code behavior as observed on 2.1.x, and nothing here sets your main model for you: pick it yourself, for example `/model best`. `/fusion:doctor` audits all of this.

## Benchmark

The plugin's effectiveness claims are benchmarked, not asserted. The claims and the full protocol live in [bench/METHODOLOGY.md](bench/METHODOLOGY.md): C1 quota displacement (routing bills fewer tokens to the Claude subscription than a vanilla session at equal task success, split into a Claude tiers only arm and a peer offload arm), C2 wall clock compression on plan shaped tasks versus a protocol enforced sequential baseline, and C3 typed failure surfacing, scoped to the grok companion failure kind contract the test suite already covers. The harness ships in [bench/](bench/): a runner that isolates each condition in its own Claude configuration directory and keeps verifiers outside the model visible worktree, a strict JSONL record schema, a summary script that refuses to compare snapshots from different task manifests, a redaction step for published transcripts, and a manifest tool that content hashes every task before any results exist.

No results are published yet. The task suite currently holds one of the planned 8 to 12 tasks, so no snapshot would meet the methodology's own publication gate; the first dated reference snapshot ships once the pool is complete, with raw per run data committed alongside the summary table. Until then the status is plain: the procedure is public and runnable, the numbers do not exist. Readers can run the harness themselves with `node bench/run.mjs --task <id> --condition <A|B1|B2> --repetition <n> --results <dir> --claude-config <dir>` after building condition profiles per [bench/conditions/README.md](bench/conditions/README.md).

## Data and uninstall

The grok plugin keeps job records, briefs, and logs under `~/.claude/plugins/data/grok-claude-code-fusion/`; briefs can contain your prompts and diffs, and logs can contain grok stderr. Delete that directory to clear history. Full uninstall: remove both plugins via `/plugin`, delete `~/.claude/rules/orchestration.md`, drop the optional `Bash(node:*)` entry from `permissions.allow`, and delete the data directory. Environment overrides (`GROK_BIN`, `GROK_COMPANION_DATA`, `GROK_COMPANION_TIMEOUT_MS`) are documented in [docs/grok-contract.md](docs/grok-contract.md). `/fusion:stats` aggregates delegation counts across both peers; token usage itself lives with each vendor (ccusage for the Claude side, the OpenAI and xAI dashboards for the peers), since peer work never touches the Claude transcript.

## Development

`npm test` runs the suite against a fake grok binary (no real grok, no network). `claude plugin validate plugins/grok`, `... plugins/fusion`, and `... .` check the manifests. Iterate with `claude --plugin-dir ./plugins/grok` plus `/reload-plugins`; after committing and pushing, `claude plugin marketplace update claude-code-fusion` refreshes the installed copy.

## Layout

- `.claude-plugin/marketplace.json`: the marketplace manifest; installs as marketplace `claude-code-fusion`.
- `plugins/grok/`: the Grok integration (companion runtime, `grok-rescue` agent, `/grok:*` commands).
- `plugins/fusion/`: the orchestration layer: tier agents (`agents/`), the routing policy payload (`rules/`), and the `/fusion:panel`, `/fusion:setup`, `/fusion:doctor`, and `/fusion:stats` commands.
- `bench/`: the benchmark methodology, harness, and task suite; no published results yet, see the publication gate in [bench/METHODOLOGY.md](bench/METHODOLOGY.md).
- `tests/`: the fake-grok and fake-claude driven test suite.

## Internals

The verified Grok CLI contract (headless invocation, session threading, permission inheritance, process lifecycle, timeouts, stop gate parsing) lives in [docs/grok-contract.md](docs/grok-contract.md). Bug reports and questions go to GitHub issues.

## License

[MIT](LICENSE)
