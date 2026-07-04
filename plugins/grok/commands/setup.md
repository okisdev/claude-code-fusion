---
description: Check whether the local Grok CLI is ready for the companion runtime
argument-hint: '[--enable-stop-gate | --disable-stop-gate] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup $ARGUMENTS`

Present the setup output to the user.

- If the Grok CLI is missing, preserve the install guidance from the command output.
- Model and effort defaults belong in `~/.grok/config.toml`, not in plugin flags. Preserve that guidance when present.
- `--enable-stop-gate` turns on the stop-time review gate: when Claude Code stops with uncommitted working tree changes, Grok reviews them and can block the stop with a reason. `--disable-stop-gate` turns it off. The report shows the current gate state.
