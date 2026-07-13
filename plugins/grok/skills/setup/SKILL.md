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
- The primary switch for the stop-time review gate is the plugin's `Stop gate review` setting in Claude Code's plugin configuration: when enabled, the Stop hook asks Grok to review the working tree diff whenever Claude Code stops with uncommitted changes. Only `BLOCK: <reason>` on the first nonempty reply line blocks the stop; a preamble before `BLOCK` and infrastructure failures fail open. SessionEnd only cleans up jobs. `--enable-stop-gate` and `--disable-stop-gate` remain as a scripting fallback that persists the same toggle locally; they only take effect when the plugin setting is left unset. The report shows the current gate state.
