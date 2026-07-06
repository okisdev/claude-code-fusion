---
description: Audit the orchestration setup for model drift, stale pins, and environment overrides
allowed-tools: Read, Glob, Bash(rg:*), Bash(node:*)
---

Audit the orchestration setup and report findings as a short checklist with a clear verdict per item.

Environment overrides captured at invocation:

- CLAUDE_CODE_SUBAGENT_MODEL: !`sh -c 'printenv CLAUDE_CODE_SUBAGENT_MODEL || echo "(unset)"'`
- ANTHROPIC_MODEL: !`sh -c 'printenv ANTHROPIC_MODEL || echo "(unset)"'`
- ANTHROPIC_DEFAULT_HAIKU_MODEL: !`sh -c 'printenv ANTHROPIC_DEFAULT_HAIKU_MODEL || echo "(unset)"'`
- ANTHROPIC_DEFAULT_FABLE_MODEL: !`sh -c 'printenv ANTHROPIC_DEFAULT_FABLE_MODEL || echo "(unset)"'`

Checks to perform:

1. A set CLAUDE_CODE_SUBAGENT_MODEL can silently override every agent model pin (Claude Code behavior as observed on 2.1.x); flag it as a problem unless the user says it is deliberate.
2. Read ~/.claude/settings.json and report the `model` key. It should be an alias, preferably `best[1m]` (Fable when available, latest Opus otherwise, floats to future releases). Flag any dated full model ID as a rot risk. Also confirm grok@claude-code-fusion and fusion@claude-code-fusion appear in enabledPlugins; codex@openai-codex powers the primary implementation lane, and when it is missing report that implementation routing is degraded to fusion:fast-worker and grok and recommend installing it.
3. Read the frontmatter of every file in ${CLAUDE_PLUGIN_ROOT}/agents/ and report each `model`, `effort`, and `maxTurns` value. Alias pins (opus, sonnet, haiku) float to new releases automatically and are healthy. Full model ID pins are rot risks; fusion:trivial-worker's claude-haiku-4-5 pin is deliberate because the haiku alias can be remapped by ANTHROPIC_DEFAULT_HAIKU_MODEL, so a full ID pins the tier to the intended model regardless of that override, but it must be bumped by hand when a newer cheap tier ships.
4. List ~/.claude/agents/ if it exists. A file whose name matches a plugin agent (deep-reasoner, fast-worker, trivial-worker) registers as a duplicate agent alongside the fusion: namespaced one and confuses auto delegation; flag it as a stale leftover to delete unless the user says it is a deliberate local override.
5. Compare the template hash of ~/.claude/rules/orchestration.md against the template hash of ${CLAUDE_PLUGIN_ROOT}/rules/orchestration.md, using the same normalization as rules-sync: replace everything between the `<!-- fusion:model-table:start -->` and `<!-- fusion:model-table:end -->` sentinel lines with the fixed normalized marker before computing SHA-256. Prefer `node --input-type=module` with `hashRulesTemplate` exported by `${CLAUDE_PLUGIN_ROOT}/scripts/lib/rules-template.mjs`; a sed or similar comparison that strips only the sentinel region is also acceptable. Missing live rules or a mismatched template hash means the static routing policy is stale; point at /fusion:setup to install or update it. A scored live model table is expected to differ from the shipped placeholder and is healthy when the template hashes match.
6. Remind the user of the role model: the orchestrator, deep reasoning, mechanical, and trivial tiers are roles bound to alias tiers, not to specific models, so same tier releases (for example Sonnet 5 under the sonnet alias) adopt their role with no configuration change. Only a genuinely new tier above or between the existing rungs requires a decision.
7. Note the recovery moves: if the main session fell back from Fable (safety classifier or availability), /model best restores the strongest available orchestrator. Peer engine models are owned by their own CLIs (~/.grok/config.toml, ~/.codex/config.toml); this setup never pins them.
8. Point at /grok:setup for grok runtime health checks beyond config defaults; peer config defaults themselves are covered in the next step.
9. Peer engine defaults: extract the model related keys from ~/.grok/config.toml and the model and model_reasoning_effort keys from ~/.codex/config.toml (never read or print the full files; they sit next to credentials; use a scoped rg query rather than Read on those two files). Report each peer's configured default and flag a grok default outside its fast coding tier or a codex default behind the current flagship line. /fusion:config is the write path for changing these; `grok models` enumerates the account's live lineup.
10. Check whether ~/.claude/plugins/data/codex-openai-codex/state exists (the job state directory fusion-stats.mjs reads). Its absence is a codex lane health signal: report it as no recorded codex job history yet or the codex plugin state path not initialized, not necessarily an error.

Report the findings compactly. Do not change any file; this command is read only.
