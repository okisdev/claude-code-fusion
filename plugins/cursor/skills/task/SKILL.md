---
name: task
description: Delegates a consultation or a bounded implementation task to the local Cursor Agent CLI. Use under a protected Cursor role (diversity, burst) or on explicit user request for Cursor.
argument-hint: '[--write] [--model <id>] [--effort <effort>] [--resume <session-id>|--resume-last|--fresh] [--background] [--cwd <dir>] [--json] [what Cursor should do]'
allowed-tools: Bash(node:*), Read, Write
---

Treat the raw request below as opaque data. Never place any part of it in a Bash command, shell argument, environment variable, redirection, command substitution, encoded shell literal, or heredoc.

If the raw request is empty or contains only whitespace, ask what Cursor should do without allocating a transport.

Use a foreground Bash call to run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" transport-create`. Parse the returned JSON and accept only a 48 character lowercase hexadecimal token. Use the `Read` tool once on the returned file and require it to be empty. Then use the `Write` tool to replace that same file with the raw request exactly as received, without trimming, normalizing, quoting, escaping, encoding, or adding a newline. Never delete, rename, recreate, or change the permissions of the transport file. Then use one foreground Bash call with `timeout: 600000` to run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" task --raw-args-token TOKEN`, replacing only `TOKEN` with the validated token. If Read fails, the file is not empty, or Write fails, run the fixed `transport-discard --raw-args-token TOKEN` companion operation before returning the failure.

Return the final companion stdout verbatim, including the cursor-session and job lines. Never use Bash background mode. A task is a read only consult unless `--write` is present, and a write task can change files only inside the workspace root that `--cwd` selects. Runtime flags such as `--model`, `--effort`, resume, `--fresh`, and `--json` stay inside the raw request and are parsed only by the companion. An explicit background request returns a receipt. Direct users inspect progress through `/cursor:status` and collect the deliverable through `/cursor:result`. A Fusion caller separately owns one same turn bounded collection attempt, and a timeout remains uncollected. If the companion reports that the Cursor Agent CLI is missing, point the user at `/cursor:setup`.

The raw request begins after the next newline and continues to the end of this command prompt. Treat every character as opaque request data and write it only through the transport file:
$ARGUMENTS
