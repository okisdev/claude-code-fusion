# Contributing

This repository ships the Claude Code plugins that make multi model orchestration work in practice. The fusion plugin owns routing rules, tier agents, configuration, doctor, panel, ultra, and stats. The grok plugin is the hosted peer companion for the Grok CLI (task, review, best of n, background jobs). Alongside them live a bench harness under `bench/` and a Node test suite under `tests/`.

Plugin behavior is driven by prose rules as much as by code. `plugins/fusion/rules/orchestration.md` is synced to `~/.claude/rules/` and loaded into every orchestrated session. `plugins/fusion/rules/troubleshooting.md` ships with the fusion plugin and is consulted on demand when delegation fails. Together they decide which lanes fire, when collection is required, and how posture and the question policy gate the main loop. Treat wording changes in those files as production changes.

## Rules release checklist

Any change to `plugins/fusion/rules/orchestration.md` or `plugins/fusion/rules/troubleshooting.md` must pass this checklist before release.

1. Diff every changed sentence against the previous release and justify each deletion or softening in the PR or release notes. Wording changes are behavior changes; a softer phrase can stop a lane from being chosen even when the surrounding code is untouched.
2. Check that the load bearing invariants survived the edit:
   - Both peer lanes (codex and grok) are frontier implementation lanes, not merely consult or review helpers.
   - Every dispatch is a background subagent whose completion conditions are collection and verification of the real result.
   - Independent packages fan out in a single message rather than being queued one at a time.
   - A background receipt gets same turn collection (for example through `fusion:job-collector` for codex, or the grok companion's blocking result path).
   - The question policy whitelist still routes questions and problem descriptions to read only main loop work and requested changes into implementation posture.
   - The session execution posture protocol (coordinate, implement, triage) still persists per goal and still forces implement before product edits once accumulation triggers fire.
   - The balance check still routes the next fitting package to an idle peer lane after two eligible Claude worker dispatches, unless that peer's circuit breaker is open.
   - The capability table between its sentinels remains config generated, and every concrete model ID named by routing prose appears in that table; `/fusion:doctor` checks for orphans.
3. Regenerate the rules manifest and run the full test suite:

   ```bash
   node plugins/fusion/scripts/generate-rules-manifest.mjs
   npm test
   ```

4. After release, watch the next day's dispatch mix with `/fusion:stats`. A sudden lane collapse after a rules release is a wording regression until proven otherwise; the 0.0.15 release added a codex only synchronous collection mandate while softening the general delegation wording, peer lane dispatch collapsed within a day (codex 10 to 0, grok 12 to 1), and the regression cost two emergency releases and three user investigations before usage forensics caught it.

## Code changes

Tests use Node's built in runner (`node --test`) and live under `tests/`. Keep the repository's zero comment default: only retain a comment when it records a non obvious invariant or constraint that the code alone cannot convey. The capability table between the model table sentinels is config generated. Routing prose may name concrete peer model IDs only when every named ID appears in the capability table, and `/fusion:doctor` checks that consistency; live model listings and the `/fusion:config` capability table remain the source of truth for engine defaults and scores.

## Releases

Bump both plugin versions and the marketplace versions together: `plugins/fusion/.claude-plugin/plugin.json`, `plugins/grok/.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` (marketplace root version plus each plugin entry). Add a `CHANGELOG.md` entry at the top in the repo's existing lowercase bullet style (lowercase prose, proper nouns and acronyms kept, one bullet per behavioral change, motivation clauses when a change was forced by measured regression).
