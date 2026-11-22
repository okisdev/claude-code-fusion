# Contributing

This repository ships the Claude Code plugins that make multi model orchestration work in practice. The fusion plugin owns routing rules, tier agents, configuration, doctor, panel, ultra, and stats. The Codex, Grok, Cursor, Devin, Antigravity, and OpenCode plugins are the hosted peer companions for their runtimes; a new engine joins through an entry in `plugins/fusion/scripts/lib/engines.mjs` and a companion that implements [docs/companion-contract.md](docs/companion-contract.md). Alongside them live a bench harness under `bench/` and a Node test suite under `tests/`.

Plugin behavior is driven by prose rules as much as by code. `plugins/fusion/rules/orchestration.md` is synced to `~/.claude/rules/` and loaded into every orchestrated session. `plugins/fusion/rules/troubleshooting.md` ships with the fusion plugin and is consulted on demand when delegation fails. Together they decide which lanes fire, when collection is required, and how the question policy and the execution posture guide the main loop. Treat wording changes in those files as production changes.

## Rules release checklist

Any change to `plugins/fusion/rules/orchestration.md` or `plugins/fusion/rules/troubleshooting.md` must pass this checklist before release.

1. Diff every changed sentence against the previous release and justify each deletion or softening in the PR or release notes. Wording changes are behavior changes; a softer phrase can stop a lane from being chosen even when the surrounding code is untouched.
2. Check that the load bearing invariants survived the edit:
   - The main Claude session is the only control plane and final judge. It owns ambiguity resolution, decomposition, integration, semantic acceptance, and user communication, while work packages execute in delegated lanes.
   - Codex owns ordinary implementation by default. Grok remains implementation capable only through its four protected roles (`burst`, `independence`, `live-web`, `large-context`) or an explicit user choice; it is not a generic alternative merely because it is idle.
   - Codex admission order is the current workspace, the breadth engine's prepaid `burst` pool for a worktree eligible package whose brief fits under 3 KB, an isolated worktree for an independent eligible package, then Grok, Antigravity, or the breadth engine under `burst`, then the matching Claude fallback. While the Codex quota pool is over pace, quick and volume packages go to the breadth engine's prepaid `burst` pool, and once it is near exhaustion (90% used before its reset) flagship packages that do not need Codex split to fit it or Antigravity `burst`. No lane default or routing rule picks a metered pool unless the user named it.
   - Claude worker dispatches carry `claude-fallback: <reason>` from the enumerated vocabulary (`network`, `toolchain`, `long-build`, `claude-surface`, `privacy`, `no-healthy-lane`), and the hook accepts `no-healthy-lane` only while every implementation peer lane is unhealthy for writes.
   - Engine health is one function keyed by engine, mode, and pool: quota and rate limits close a pool, repeated timeouts and policy failures close a mode, and setup, auth, sandbox, transport, and protocol failures close the engine. Packages with overlapping files, shared generated state, or ordering dependencies are consolidated or sequenced instead of parallel overflow.
   - Antigravity (`agy`) owns the Google family on the user's Google AI subscription. Its protected `independence` and `large-context` roles consult read only; `burst` edits files only inside an orchestrator owned worktree, with verification in the main session. It is never a generic default, and every automatically routed brief carries `agy-role: <role>`. The breadth engine excludes Google from `diversity` while Antigravity is routed.
   - OpenCode (`opencode`) owns bulk generation on the user's OpenCode Go subscription, through the Codex CLI with a private `CODEX_HOME` so its health, quota pool, and rollouts never touch the Codex engine. Its protected roles are `bulk` (writes inside an orchestrator owned worktree, accepted only by a verification command the main session reruns) and `blind-check` (read only answers to a staged artifact). It is never a generic default, never a review, panel, or `independence` seat, and never satisfies `no-healthy-lane` for ordinary implementation; every automatically routed brief carries `opencode-role: <role>`, and the routing sentences that name it stay conditioned on it being installed.
   - The breadth engine is Cursor or Devin, selected with `/fusion:config set-breadth <cursor|devin>` (default `cursor`) and named in the rendered routing table; exactly one holds the seat. Its protected roles are `diversity` (a read only consult on a model family no other installed lane serves) and `burst` (bounded Composer or SWE implementation in orchestrator owned worktrees). It never runs a model router (Cursor Auto or Devin Adaptive), never serves the Claude family, and stands in for another family's native lane only while that lane's breaker is open on quota or rate limits or its pool is over pace. A Devin planner and SWE pairing names both models, bills the pool its catalog cost tier names, and serves `burst` only with a non Claude planner.
   - Routing stays capability first: capability monopolies (X and live platform reads on Grok `live-web`, Google family work on Antigravity, model families no other installed lane serves on the breadth engine, Claude tool surface and privacy on Claude workers, judgment dense authorship in the main session) hard route ahead of every task type default, and the judgment dense authorship rule keeps policy text, public naming, API shape, and UX copy authored in the main session with only the mechanical spread dispatched.
   - Codex, Grok, Cursor, Devin, Antigravity, and OpenCode wrapper Agents never request background delivery (the harness may still launch them asynchronously, and the main session collects them), launch their companion calls in background shells, and wait through `await-output --file <path>` in slices of at most 100 seconds to return one companion report. Only an incoming user request with explicit companion `--background` may detach the companion child; Fusion collects a receipt it creates in the same turn.
   - A Codex package that cannot fit the foreground cap is split or routed elsewhere. Complexity and duration never silently detach it.
   - Independent packages fan out in a single message rather than being queued one at a time. Dependence is never removed by switching engines.
   - Agent scheduling, companion delivery, and CLI process supervision remain distinct. A manual receipt created by Fusion orchestration gets one same turn bounded collection attempt; a managed Grok detachment stays inside its owning Agent until terminal and marks collection. A direct manual receipt carries a per job watch command for the main session to run through the Claude Code `Monitor` tool; its completion line requires explicit result collection. Direct peer slash commands with explicit `--background` return manual receipts for status and result collection.
   - After refreshing installed plugin caches, run `/fusion:smoke` before real delegated work.
   - `fusion:deep-reasoner` is read only advice, never an implementation retry. `fusion:claude-worker` owns resolved Claude tool-surface or privacy packages, and `fusion:trivial-worker` is an exact tiny fallback when no eligible peer lane fits.
   - The question policy whitelist still routes questions and problem descriptions to read only main loop work and requested changes into implementation posture.
   - The session execution posture protocol (coordinate, implement, triage) still persists per goal in the rules; it is prose guidance, and no hook enforces it.
   - After two eligible packages have gone to Claude workers, the balance check routes the next ordinary implementation package to idle Codex. It routes to idle Grok or the selected breadth engine only when a protected role fits and its circuit breaker is closed.
   - The capability table between its sentinels remains config generated, and every concrete model ID named by routing prose appears in that table; `/fusion:doctor` checks for orphans.
3. Regenerate the rules manifest and run the full test suite:

   ```bash
   node plugins/fusion/scripts/generate-rules-manifest.mjs
   claude plugin validate plugins/codex
   claude plugin validate plugins/grok
   claude plugin validate plugins/cursor
   claude plugin validate plugins/devin
   claude plugin validate plugins/agy
   claude plugin validate plugins/opencode
   claude plugin validate plugins/fusion
   claude plugin validate .
   npm test
   ```

4. After release, watch the next day's dispatch mix with `/fusion:stats`. A sudden lane collapse after a rules release is a wording regression until proven otherwise; the 0.0.15 release added a codex only synchronous collection mandate while softening the general delegation wording, peer lane dispatch collapsed within a day (codex 10 to 0, grok 12 to 1), and the regression cost two emergency releases and three user investigations before usage forensics caught it.

## Code changes

Tests use Node's built in runner (`node --test`) and live under `tests/`. Keep the repository's zero comment default: only retain a comment when it records a non obvious invariant or constraint that the code alone cannot convey. The capability table between the model table sentinels is config generated. Routing prose may name concrete peer model IDs only when every named ID appears in the capability table, and `/fusion:doctor` checks that consistency; live model listings and the `/fusion:config` capability table remain the source of truth for engine defaults and scores. Engine identity (ids, display names, peer agent types, companion file and environment names, data directory names) lives only in `plugins/fusion/scripts/lib/engines.mjs`; `tests/engines.test.mjs` fails when another fusion script repeats one of those literals or when `hooks.json` wires a peer agent the registry does not know. Engine specific behavior, such as failure patterns, acceptance ledgers, and watch reconciliation, stays in its own module.

## Releases

Bump all plugin versions and the marketplace versions together: `plugins/agy/.claude-plugin/plugin.json`, `plugins/codex/.claude-plugin/plugin.json`, `plugins/cursor/.claude-plugin/plugin.json`, `plugins/devin/.claude-plugin/plugin.json`, `plugins/fusion/.claude-plugin/plugin.json`, `plugins/grok/.claude-plugin/plugin.json`, `plugins/opencode/.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` (marketplace root version plus each plugin entry). Add a `CHANGELOG.md` entry at the top in the repo's existing lowercase bullet style (lowercase prose, proper nouns and acronyms kept, one bullet per behavioral change, motivation clauses when a change was forced by measured regression).

Edit shared companion code under `shared/companion`, then run `node shared/sync.mjs` before committing. CI fails if the vendored plugin copies drift from the shared sources.
