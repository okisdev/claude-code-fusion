---
description: Show the stored result of a finished Grok job in this workspace
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result $ARGUMENTS`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:

- The complete result text, plus the grok-session and job lines
- File paths and line numbers exactly as reported
- Any error messages or log lines
- The pointer to `/grok:status` when the job is still running
