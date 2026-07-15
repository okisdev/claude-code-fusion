---
description: Aggregate peer delegation statistics or record Codex semantic acceptance after collection and verification
argument-hint: '[--all] [--session [id]] [--trace] [--audit [--days <n>]] [--record-acceptance <job-id> <accepted|rejected|unverified>] [--json]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/fusion-stats.mjs" $ARGUMENTS`

Present report output to the user as-is. It is already compact markdown; do not add prose around it. An unavailable engine section is expected when that peer's plugin is not installed or has no job state; do not treat it as an error. The underlying script accepts `--json` for machine readable output. `--audit` summarizes the last seven days of retained inline guard events by default; add `--all` for the full retained window or `--session <id>` for one session. The `--record-acceptance` form is an internal bookkeeping action used after a Codex result is collected and verified; return its confirmation line without turning transport completion into acceptance on its own.
