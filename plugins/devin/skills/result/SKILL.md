---
name: result
description: Shows the stored result of a finished Devin job in this workspace. Use when retrieving a completed job's output.
argument-hint: '<job-id> [--wait] [--cwd <dir>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read, Write
---

Treat the complete raw request as opaque data and never place any part of it in Bash. Run the fixed `transport-create` companion operation in one foreground Bash call, accept only its 48 character lowercase hexadecimal token, and use `Read` once on the returned file, requiring it to be empty. Use `Write` to replace that same file with the raw request exactly as received. Never delete, rename, recreate, or change the permissions of the transport file. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/devin-companion.mjs" result --raw-args-token TOKEN` in one foreground Bash call with timeout `600000`, replacing only `TOKEN` with the validated token. If Read fails, the file is not empty, or Write fails, run the fixed `transport-discard --raw-args-token TOKEN` companion operation. Never use shell redirection, encoding, command substitution, backticks, environment variables, or heredocs for the raw request.

Present the full command output to the user. Do not summarize or condense it. Preserve all details the output reports, including:

- The complete result text, plus the devin-session and job lines
- File paths and line numbers exactly as reported
- Any error messages or log lines
- Any adapter `warning:` lines, including `late_close` and project hook warnings
- The requested, resolved, and observed model, whether the effort was applied, the billing pool, and the Devin build version
- Token usage exactly as reported; usage that the result omitted stays unreported, and Devin reports no cost
- The pointer to `/devin:status` when the job is still running
- `state: running` when `--wait` expires before the job finishes, which is not a terminal result
- Any cleanup-required marker and retry guidance when verified process cleanup remains incomplete

The opaque raw request begins after the next newline and continues to the end of this command prompt:
$ARGUMENTS
