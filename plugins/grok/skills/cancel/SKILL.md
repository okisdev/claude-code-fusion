---
description: Cancel an active Grok job in this workspace
argument-hint: '<job-id> [--cwd <dir>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" cancel $ARGUMENTS`

Preserve the command output exactly. A cancelled job includes `state: cancelled` and `failure: cancelled`.
