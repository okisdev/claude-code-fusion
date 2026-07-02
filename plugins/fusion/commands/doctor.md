---
description: Audit the orchestration setup for model drift, stale pins, and environment overrides
allowed-tools: Read, Glob
---

Audit the orchestration setup and report findings as a short checklist with a clear verdict per item.

Environment overrides captured at invocation:

- CLAUDE_CODE_SUBAGENT_MODEL: !`sh -c 'printenv CLAUDE_CODE_SUBAGENT_MODEL || echo "(unset)"'`
- ANTHROPIC_MODEL: !`sh -c 'printenv ANTHROPIC_MODEL || echo "(unset)"'`
- ANTHROPIC_DEFAULT_HAIKU_MODEL: !`sh -c 'printenv ANTHROPIC_DEFAULT_HAIKU_MODEL || echo "(unset)"'`
- ANTHROPIC_DEFAULT_FABLE_MODEL: !`sh -c 'printenv ANTHROPIC_DEFAULT_FABLE_MODEL || echo "(unset)"'`

Checks to perform:

1. A set CLAUDE_CODE_SUBAGENT_MODEL can silently override every agent model pin (Claude Code behavior as observed on 2.1.x); flag it as a problem unless the user says it is deliberate.
2. Read ~/.claude/settings.json and report the `model` key. It should be an alias, preferably `best[1m]` (Fable when available, latest Opus otherwise, floats to future releases). Flag any dated full model ID as a rot risk. Also confirm grok@claude-code-fusion and fusion@claude-code-fusion appear in enabledPlugins; codex@openai-codex is optional, and its absence only means the codex track degrades.
3. Read the frontmatter of every file in ${CLAUDE_PLUGIN_ROOT}/agents/ and report each `model` value. Alias pins (opus, sonnet, haiku) float to new releases automatically and are healthy. Full model ID pins are rot risks; fusion:trivial-worker's claude-haiku-4-5 pin is deliberate on machines where ANTHROPIC_DEFAULT_HAIKU_MODEL remaps the haiku alias, but it must be bumped by hand when a newer cheap tier ships.
4. List ~/.claude/agents/ if it exists. A file whose name matches a plugin agent (deep-reasoner, fast-worker, trivial-worker) registers as a duplicate agent alongside the fusion: namespaced one and confuses auto delegation; flag it as a stale leftover to delete unless the user says it is a deliberate local override.
5. Compare ~/.claude/rules/orchestration.md against ${CLAUDE_PLUGIN_ROOT}/rules/orchestration.md. Missing or drifted means the routing policy is stale; point at /fusion:setup to install or update it.
6. Remind the user of the role model: the orchestrator, deep reasoning, mechanical, and trivial tiers are roles bound to alias tiers, not to specific models, so same tier releases (for example Sonnet 5 under the sonnet alias) adopt their role with no configuration change. Only a genuinely new tier above or between the existing rungs requires a decision.
7. Note the recovery moves: if the main session fell back from Fable (safety classifier or availability), /model best restores the strongest available orchestrator. Peer engine models are owned by their own CLIs (~/.grok/config.toml, codex config.toml); this setup never pins them.
8. Point at /grok:setup for grok runtime health; this command only audits the Claude side.

Report the findings compactly. Do not change any file; this command is read only.
