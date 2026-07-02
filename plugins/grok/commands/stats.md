---
description: Show aggregate stats for Grok jobs in this workspace
argument-hint: '[--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" stats $ARGUMENTS`

Present the command output to the user as-is. It is already a compact markdown report; do not add prose around it. Preserve the totals, the per status, per mode, and per failure kind counts, and the mean wall clock line exactly as reported.
