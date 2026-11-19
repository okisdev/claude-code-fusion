---
name: setup
description: Checks whether the local Antigravity CLI is ready for the companion runtime. Use when validating the local companion setup, after a CLI update, or after a setup class failure.
argument-hint: '[--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read, Write
---

Treat the complete raw request as opaque data and never place any part of it in Bash. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" transport-create` in one foreground Bash call, accept only its 48 character lowercase hexadecimal token, and use `Read` once on the returned file, requiring it to be empty. Use `Write` to replace that same file with the raw request exactly as received. Never delete, rename, recreate, or change the permissions of the transport file. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup --raw-args-token TOKEN` in one foreground Bash call with timeout `600000`, replacing only `TOKEN` with the validated token. If Read fails, the file is not empty, or Write fails, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" transport-discard --raw-args-token TOKEN`. Never use shell redirection, encoding, command substitution, backticks, environment variables, or heredocs for the raw request.

Present the setup output to the user.

- If the Antigravity CLI is missing, preserve the install guidance from the command output. The companion resolves `agy` on `PATH`; `AGY_BIN` overrides it.
- Preserve authentication evidence from a successful ACP `session/new`. Antigravity uses the login keychain through the inherited real `HOME`; the companion never reads or copies credentials.
- Preserve the compatibility line for the tested interval from 1.5 to before 1.6. An older or unparseable build fails as `setup`; a newer build runs with verification advice.
- Preserve the usable Google model list and warnings for workspace `.gemini` or `.agents` directories, whose instructions may still load.
- Preserve the reminder to set Antigravity overage to never, so exhausting the subscription cannot buy AI credits.
- A direct call defaults to `gemini-4-neon`. Fusion routed dispatches carry an explicit model and effort.
- Installation, version, or capability failures require repair and another `/agy:setup` before retrying unchanged work. The Homebrew cask is `antigravity-cli` with self update disabled.
- Job records, briefs, and the shared private Gemini directory live under `~/.claude/plugins/data/agy-claude-code-fusion/` unless `AGY_COMPANION_DATA` overrides it. SessionEnd attempts verified process cleanup for this session's jobs, removes unused raw transports, and sweeps orphan run directories.

The opaque raw request begins after the next newline and continues to the end of this command prompt:
$ARGUMENTS
