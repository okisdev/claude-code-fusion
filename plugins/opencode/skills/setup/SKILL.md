---
name: setup
description: Checks whether OpenCode Go through the Codex CLI sandbox is ready for the companion runtime. Use when validating the local companion setup, after a CLI update, or after a setup class failure.
argument-hint: '[--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read, Write
---

Treat the complete raw request as opaque data and never place any part of it in Bash. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" transport-create` in one foreground Bash call, accept only its 48 character lowercase hexadecimal token, and use `Read` once on the returned file, requiring it to be empty. Use `Write` to replace that same file with the raw request exactly as received. Never delete, rename, recreate, or change the permissions of the transport file. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" setup --raw-args-token TOKEN` in one foreground Bash call with timeout `600000`, replacing only `TOKEN` with the validated token. If Read fails, the file is not empty, or Write fails, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" transport-discard --raw-args-token TOKEN`. Never use shell redirection, encoding, command substitution, backticks, environment variables, or heredocs for the raw request.

Present the setup output to the user.

- Preserve the Codex CLI install or repair guidance. The companion resolves `codex` on `PATH`; `OPENCODE_CODEX_BIN` overrides it.
- Authentication uses `OPENCODE_GO_API_KEY` from the companion environment, or else the key `opencode auth login` stored for OpenCode Go. Never ask the model to read, print, copy, or persist the key. A missing key fails as `auth`.
- Preserve the reported Codex version, compatibility warning, model catalog result, typed failure, and next steps. Rerun `/opencode:setup` after repairing a setup failure.
- Turn off Extra Usage in the OpenCode console to keep this lane on the included allowance.
- Each task must declare `opencode-role: bulk` or `opencode-role: blind-check`. Bulk writes inside an orchestrator owned worktree and is accepted by a verification command; blind-check answers a staged artifact with its answers removed and is read only. OpenCode Go never handles ordinary implementation, review, or panels.
- The role defaults are `deepseek-v4.1-flash@high` for bulk and `glm-5.3-flash@high` for blind-check. Fusion routed dispatches carry the routing table's explicit model and effort.
- Job records and the shared private Codex home live under `~/.claude/plugins/data/opencode-claude-code-fusion/` unless `OPENCODE_COMPANION_DATA` overrides it. SessionEnd attempts verified cleanup of this session's running jobs and unused raw transports.

The opaque raw request begins after the next newline and continues to the end of this command prompt:
$ARGUMENTS
