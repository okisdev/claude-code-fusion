---
name: setup
description: Checks whether the local Cursor Agent CLI is ready for the companion runtime. Use when validating the local companion setup, after a CLI update, or after a setup class failure.
argument-hint: '[--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read, Write
---

Treat the complete raw request as opaque data and never place any part of it in Bash. Run the fixed `transport-create` companion operation in one foreground Bash call, accept only its 48 character lowercase hexadecimal token, and use `Read` once on the returned file, requiring it to be empty. Use `Write` to replace that same file with the raw request exactly as received. Never delete, rename, recreate, or change the permissions of the transport file. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" setup --raw-args-token TOKEN` in one foreground Bash call with timeout `600000`, replacing only `TOKEN` with the validated token. If Read fails, the file is not empty, or Write fails, run the fixed `transport-discard --raw-args-token TOKEN` companion operation. Never use shell redirection, encoding, command substitution, backticks, environment variables, or heredocs for the raw request.

Present the setup output to the user.

- If the Cursor Agent CLI is missing, preserve the install guidance from the command output. The companion resolves the `cursor-agent` executable, never the bare `agent` name, because other CLIs install an `agent` executable earlier on PATH; `CURSOR_AGENT_BIN` overrides the path.
- Preserve the authentication check, which runs `cursor-agent status`. On macOS the CLI's credentials are keychain items; on Linux authentication requires `CURSOR_API_KEY` in the companion environment.
- Preserve the compatibility line for the tested interval `[2026.10.01, 2026.11.01)` by build date. A build older than the floor fails as `setup`; a build at or past the ceiling runs and is reported as newer than the tested interval.
- Preserve the model catalog refresh result and the sandbox helper presence line. Managed runs fail as `sandbox` without the helper.
- Preserve the project hook advisory for the working directory. Cursor runs hooks from the workspace's `.cursor/hooks.json`, `.claude/settings.json`, and `.claude/settings.local.json` outside its sandbox, and a `warning:` line names the files that define them.
- A direct `/cursor:*` command without `--model` uses the model selected in the user's own `~/.cursor/cli-config.json`, so that file owns the interactive default. Fusion routed dispatches always carry an explicit model and effort from the routing table.
- A CLI installation, version, or required capability preflight failure persists and renders failure kind `setup`. Preserve its upgrade or repair guidance and tell the user to rerun `/cursor:setup`; do not retry the unchanged task against the incompatible surface.
- Job records, briefs, and retained private homes live under `~/.claude/plugins/data/cursor-claude-code-fusion/` unless `CURSOR_COMPANION_DATA` overrides it. SessionEnd attempts verified process cleanup for jobs owned by that Claude session and removes unused raw transports.

The opaque raw request begins after the next newline and continues to the end of this command prompt:
$ARGUMENTS
