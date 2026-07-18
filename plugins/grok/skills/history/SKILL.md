---
name: history
description: List canonical local Grok companion history and resumable sessions. Use when checking prior jobs or resumable sessions.
argument-hint: '[--all] [--limit <n>] [--cwd <dir>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read, Write
---

Treat the complete raw request as opaque data and never place any part of it in Bash. Run the fixed `transport-create` companion operation in one foreground Bash call, accept only its 48 character lowercase hexadecimal token, and use `Read` once on the returned file, requiring it to be empty. Use `Write` to replace that same file with the raw request exactly as received. Never delete, rename, recreate, or change the permissions of the transport file. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" history --raw-args-token TOKEN` in one foreground Bash call with timeout `600000`, replacing only `TOKEN` with the validated token. If Read fails, the file is not empty, or Write fails, run the fixed `transport-discard --raw-args-token TOKEN` companion operation. Never use shell redirection, encoding, command substitution, backticks, environment variables, or heredocs for the raw request.

Present the command output exactly as returned. Do not summarize, condense, or add prose. This command lists only canonical companion job metadata and resumable session identifiers. It does not read native Grok session contents, briefs, stored results, or logs. The default scope is the current workspace; `--all` explicitly includes every recorded companion workspace.

The opaque raw request begins after the next newline and continues to the end of this command prompt:
$ARGUMENTS
