---
description: Show the stored result of a finished Grok job in this workspace
argument-hint: '<job-id> [--cwd <dir>] [--wait] [--wait-timeout-ms <ms>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read, Write
---

Treat the complete raw request as opaque data and never place any part of it in Bash. Run the fixed `transport-create` companion operation in one foreground Bash call, accept only its 48 character lowercase hexadecimal token, and use `Read` once on the returned file, requiring it to be empty. Use `Write` to replace that same file with the raw request exactly as received. Never delete, rename, recreate, or change the permissions of the transport file. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result --raw-args-token TOKEN` in one foreground Bash call with timeout `600000`, replacing only `TOKEN` with the validated token. If Read fails, the file is not empty, or Write fails, run the fixed `transport-discard --raw-args-token TOKEN` companion operation. Never use shell redirection, encoding, command substitution, backticks, environment variables, or heredocs for the raw request.

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:

- The complete result text, plus the grok-session and job lines
- File paths and line numbers exactly as reported
- Any error messages or log lines
- Any request id, turn count, aggregate or per-model usage, cost, partial-cost, incomplete-usage-ledger, or structured-output fields in JSON mode; per-model rows expose input, output, cache-read, and model-call counts plus optional cost, never synthetic reasoning or total tokens, and `usage_is_incomplete` makes present values observed lower bounds rather than exact job totals
- The pointer to `/grok:status` when the job is still running
- Any `phase: cleanup-required` marker and retry guidance when verified process cleanup remains incomplete

The opaque raw request begins after the next newline and continues to the end of this command prompt:
$ARGUMENTS
