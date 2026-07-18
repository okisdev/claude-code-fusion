---
name: stats
description: Show aggregate stats for Grok jobs in this workspace. Use when checking Grok job activity over time.
argument-hint: '[--all] [--cwd <dir>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read, Write
---

Treat the complete raw request as opaque data and never place any part of it in Bash. Run the fixed `transport-create` companion operation in one foreground Bash call, accept only its 48 character lowercase hexadecimal token, and use `Read` once on the returned file, requiring it to be empty. Use `Write` to replace that same file with the raw request exactly as received. Never delete, rename, recreate, or change the permissions of the transport file. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" stats --raw-args-token TOKEN` in one foreground Bash call with timeout `600000`, replacing only `TOKEN` with the validated token. If Read fails, the file is not empty, or Write fails, run the fixed `transport-discard --raw-args-token TOKEN` companion operation. Never use shell redirection, encoding, command substitution, backticks, environment variables, or heredocs for the raw request.

Present the command output to the user as-is. It is already a compact markdown report; do not add prose around it. Preserve the totals, created range, mean wall clock, per status, per mode, per resolved model, per model, per resolved effort, and per failure kind sections, exact token channel coverage, observed input, output, cache-read, reasoning, and total token totals, and the headless metrics section with turn count coverage, observed turns, exact, partial, and unreported cost coverage, and observed exact cost and tick totals exactly as reported. Grok headless JSON has no top-level `model` field; resolved model capture depends on `modelUsage` keys when usage attaches and on salvaging error envelopes. Upstream `modelUsage` entries contain `input`, `output`, `cacheRead`, and `modelCalls`, plus optional `costUSD`; they do not support synthetic aggregate reasoning or total token channels. `usage_is_incomplete` means the usage ledger may have missed open subagents, usage application, or a drain timeout. Present token values remain observed lower bounds, while job-total token and cost coverage both become incomplete. Authoritative cost uses integer ticks at 10000000000 ticks per USD.

The opaque raw request begins after the next newline and continues to the end of this command prompt:
$ARGUMENTS
