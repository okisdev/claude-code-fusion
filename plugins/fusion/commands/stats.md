---
description: Aggregate delegation statistics across the grok and codex peer engines
argument-hint: '[--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/fusion-stats.mjs" $ARGUMENTS`

Present the command output to the user as-is. It is already a compact markdown report; do not add prose around it. An unavailable engine section is expected when that peer's plugin is not installed or has no job state; do not treat it as an error.
