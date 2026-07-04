---
description: Show active and recent Grok jobs for this workspace
argument-hint: '[job-id] [--cwd <dir>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" status $ARGUMENTS`

If the user did not pass a job id:

- Render the command output as a single markdown table of the workspace's jobs.
- Keep it compact. Do not add prose outside the table.
- Preserve the actionable fields, including job id, status, mode, background, age, and session ownership.

If the user did pass a job id:

- Present the full command output to the user, including any log tail.
- Do not summarize or condense it.
