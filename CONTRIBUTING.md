# Contributing

This repository ships the Claude Code plugins that make multi model orchestration work in practice. The fusion plugin owns routing rules, tier agents, configuration, doctor, panel, ultra, and stats. The Codex and Grok plugins are the hosted peer companions for their local CLIs. Alongside them live a bench harness under `bench/` and a Node test suite under `tests/`.

Plugin behavior is driven by prose rules as much as by code. `plugins/fusion/rules/orchestration.md` is synced to `~/.claude/rules/` and loaded into every orchestrated session. `plugins/fusion/rules/troubleshooting.md` ships with the fusion plugin and is consulted on demand when delegation fails. Together they decide which lanes fire, when collection is required, and how posture and the question policy gate the main loop. Treat wording changes in those files as production changes.

## Rules release checklist

Any change to `plugins/fusion/rules/orchestration.md` or `plugins/fusion/rules/troubleshooting.md` must pass this checklist before release.

1. Diff every changed sentence against the previous release and justify each deletion or softening in the PR or release notes. Wording changes are behavior changes; a softer phrase can stop a lane from being chosen even when the surrounding code is untouched.
2. Check that the load bearing invariants survived the edit:
   - The main Claude session is the only control plane and final judge. It owns ambiguity resolution, decomposition, integration, semantic acceptance, and user communication, while work packages execute in delegated lanes.
   - Codex owns ordinary implementation by default. Grok remains implementation capable only through its four protected roles (`burst`, `independence`, `live-web`, `large-context`) or an explicit user choice; it is not a generic alternative merely because it is idle.
   - Codex admission order is the current workspace, an isolated worktree for an independent eligible package, then Grok under `burst`, then the matching Claude fallback. Packages with overlapping files, shared generated state, or ordering dependencies are consolidated or sequenced instead of parallel overflow.
   - Routing stays capability first: capability monopolies (X and live platform reads on Grok `live-web`, Claude tool surface and privacy on Claude workers, judgment dense authorship in the main session) hard route ahead of every task type default, and the judgment dense authorship rule keeps policy text, public naming, API shape, and UX copy authored in the main session with only the mechanical spread dispatched.
   - Claude worker and Grok dispatches are background Agents. Codex is the foreground Agent exception: its rescue Agent and companion Bash call stay foreground regardless of complexity or expected duration unless the incoming user request already contains `--background`.
   - A Codex package that cannot fit the foreground cap is split or routed elsewhere. Complexity and duration never silently detach it.
   - Independent packages fan out in a single message rather than being queued one at a time. Dependence is never removed by switching engines.
   - Agent scheduling, companion delivery, and CLI process supervision remain distinct. A manual receipt created by Fusion orchestration gets one same turn bounded collection attempt; a managed Grok detachment stays inside its owning Agent until terminal and marks collection. The monitor suppresses collected jobs but emits a delayed fallback after the grace period when a terminal managed job remains uncollected, as a best effort owner loss fallback. Direct Codex or Grok slash commands with explicit `--background` return manual receipts for status and result collection.
   - After refreshing installed plugin caches, run `/fusion:smoke` before real delegated work.
   - `fusion:deep-reasoner` is read only advice, never an implementation retry. `fusion:fast-worker` owns resolved Claude tool or privacy packages, and `fusion:trivial-worker` is an exact tiny fallback when no eligible peer lane fits.
   - The question policy whitelist still routes questions and problem descriptions to read only main loop work and requested changes into implementation posture.
   - The session execution posture protocol (coordinate, implement, triage) still persists per goal and still forces implement before product edits once accumulation triggers fire.
   - After two eligible packages have gone to Claude workers, the balance check routes the next ordinary implementation package to idle Codex. It routes to idle Grok only when a protected role fits and its circuit breaker is closed.
   - The capability table between its sentinels remains config generated, and every concrete model ID named by routing prose appears in that table; `/fusion:doctor` checks for orphans.
3. Regenerate the rules manifest and run the full test suite:

   ```bash
   node plugins/fusion/scripts/generate-rules-manifest.mjs
   claude plugin validate plugins/codex
   claude plugin validate plugins/grok
   claude plugin validate plugins/fusion
   claude plugin validate .
   npm test
   ```

4. After release, watch the next day's dispatch mix with `/fusion:stats`. A sudden lane collapse after a rules release is a wording regression until proven otherwise; the 0.0.15 release added a codex only synchronous collection mandate while softening the general delegation wording, peer lane dispatch collapsed within a day (codex 10 to 0, grok 12 to 1), and the regression cost two emergency releases and three user investigations before usage forensics caught it.

## Code changes

Tests use Node's built in runner (`node --test`) and live under `tests/`. Keep the repository's zero comment default: only retain a comment when it records a non obvious invariant or constraint that the code alone cannot convey. The capability table between the model table sentinels is config generated. Routing prose may name concrete peer model IDs only when every named ID appears in the capability table, and `/fusion:doctor` checks that consistency; live model listings and the `/fusion:config` capability table remain the source of truth for engine defaults and scores.

## Releases

Bump all plugin versions and the marketplace versions together: `plugins/codex/.claude-plugin/plugin.json`, `plugins/fusion/.claude-plugin/plugin.json`, `plugins/grok/.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` (marketplace root version plus each plugin entry). Add a `CHANGELOG.md` entry at the top in the repo's existing lowercase bullet style (lowercase prose, proper nouns and acronyms kept, one bullet per behavioral change, motivation clauses when a change was forced by measured regression).
