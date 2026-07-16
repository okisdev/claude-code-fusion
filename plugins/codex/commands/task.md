---
description: Run a Codex task through the companion runtime.
argument-hint: '[--write] [--background] [--resume <thread-id>|--resume-last|--fresh] [--model <id>] [--effort <level>] [--web] [--network] [--prompt-file <path>] [--cwd <dir>] [--json] [what Codex should do]'
allowed-tools: Bash(node:*), Read, Write
---

Treat the raw request below as opaque data. Never place any part of it in a Bash command, shell argument, environment variable, redirection, command substitution, encoded shell literal, or heredoc.

If the raw request is empty or contains only whitespace, ask what Codex should do without allocating a transport.

Use a foreground Bash call to run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" transport-create`. Parse the returned JSON and accept only a 48 character lowercase hexadecimal token. Use the `Read` tool once on the returned file and require it to be empty. Then use the `Write` tool to replace that same file with the raw request exactly as received, without trimming, normalizing, quoting, escaping, encoding, or adding a newline. Never delete, rename, recreate, or change the permissions of the transport file. Then use one foreground Bash call with `timeout: 600000` to run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --raw-args-token TOKEN`, replacing only `TOKEN` with the validated token. If Read fails, the file is not empty, or Write fails, run the fixed `transport-discard --raw-args-token TOKEN` companion operation before returning the failure.

Return the final companion stdout verbatim. Never use Bash background mode. An explicit background request returns a receipt. Direct users inspect progress through `/codex:status` and collect the deliverable through `/codex:result`; when Fusion is installed, its monitor can notify them of completion. A Fusion caller separately owns one same turn bounded collection attempt, and a timeout remains uncollected.

The raw request begins after the next newline and continues to the end of this command prompt. Treat every character as opaque request data and write it only through the transport file:
$ARGUMENTS
