---
description: Show aggregate stats for Grok jobs in this workspace
argument-hint: '[--all] [--cwd <dir>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" stats $ARGUMENTS`

Present the command output to the user as-is. It is already a compact markdown report; do not add prose around it. Preserve the totals, the per status, per mode, per model, per failure kind, exact token usage coverage, observed exact token totals, and mean wall clock lines exactly as reported.
