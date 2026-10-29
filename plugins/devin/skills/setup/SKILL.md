---
name: setup
description: Checks whether the local Devin CLI is ready for the companion runtime. Use when validating the local companion setup, after a CLI update, or after a setup class failure.
argument-hint: '[--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read, Write
---

Treat the complete raw request as opaque data and never place any part of it in Bash. Run the fixed `transport-create` companion operation in one foreground Bash call, accept only its 48 character lowercase hexadecimal token, and use `Read` once on the returned file, requiring it to be empty. Use `Write` to replace that same file with the raw request exactly as received. Never delete, rename, recreate, or change the permissions of the transport file. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/devin-companion.mjs" setup --raw-args-token TOKEN` in one foreground Bash call with timeout `600000`, replacing only `TOKEN` with the validated token. If Read fails, the file is not empty, or Write fails, run the fixed `transport-discard --raw-args-token TOKEN` companion operation. Never use shell redirection, encoding, command substitution, backticks, environment variables, or heredocs for the raw request.

Present the setup output to the user.

- If the Devin CLI is missing, preserve the install guidance from the command output. The companion resolves `devin` on `PATH`; `DEVIN_BIN` overrides it.
- Preserve the authentication check from `devin auth status`, the plan tier, and guidance to run `devin auth login` when needed. Credentials are linked into private XDG data storage and are never read or copied by the companion.
- Preserve the compatibility line for `[3000.11, 3000.12)` by major and minor version. An older or unparseable build fails as `setup`; a newer build runs and is reported as newer than the tested interval.
- Preserve the model catalog refresh result and the project configuration advisory.
- Preserve warnings for `.devin/config.json`, `.devin/config.local.json`, `.devin/mcp_config.json`, and `.devin/mcp_config.local.json` in the working directory. These files can add permissions, hooks, MCP servers, or imports.
- A direct `/devin:*` command without `--model` uses the account default model. Fusion routed dispatches carry an explicit model and effort from the routing table.
- A CLI installation, version, or required capability preflight failure persists and renders failure kind `setup`. Preserve its upgrade or repair guidance and tell the user to rerun `/devin:setup`.
- Job records, briefs, the shared private home, and per job configuration live under `~/.claude/plugins/data/devin-claude-code-fusion/` unless `DEVIN_COMPANION_DATA` overrides it. SessionEnd attempts verified process cleanup for jobs owned by that Claude session, removes unused raw transports, and sweeps orphan run directories.

The opaque raw request begins after the next newline and continues to the end of this command prompt:
$ARGUMENTS
