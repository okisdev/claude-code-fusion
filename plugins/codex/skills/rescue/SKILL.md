---
name: rescue
description: Forwards a request to the Codex rescue agent without exposing arguments to a shell. Use when Fusion routing or the user delegates work to Codex.
argument-hint: '[--write] [--background] [--resume <thread-id>|--resume-last|--fresh] [--model <id>] [--effort <level>] [--web] [--network] [--output-schema <path>] [what Codex should do]'
allowed-tools: Agent, Monitor
---

Use the `Agent` tool once to invoke `codex:codex-rescue` in the foreground. Do not inspect, interpret, quote, encode, or pass any part of the raw request to Bash. An explicit `--background` belongs to the companion invocation inside the rescue agent and must not change how the Agent tool itself runs. Return the agent response verbatim. A foreground timeout with a resumable thread is salvaged by the wrapper's single scripted wind down resume; the resumed job links through `request.resumeThreadId`, and a second timeout terminalizes the package. An explicit background request returns a receipt. Direct users inspect progress through `/codex:status` and collect the deliverable through `/codex:result`; the main session starts the receipt's per job watch through the Claude Code `Monitor` tool. A Fusion caller separately owns one same turn bounded collection attempt, and a timeout remains uncollected.

For a direct manual background receipt, preserve its watch command and have the main session start exactly one Claude Code `Monitor` tool watch with `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" watch --job <id>`, using the absolute plugin path and only the validated 32 character lowercase hexadecimal receipt id. Never put raw request text in the watch command. The watch completion line is the cue to collect with `/codex:result <id>`. Fusion orchestrated detached receipts continue through `fusion:job-collector`. Request the receipt's watch duration, the engine background budget plus 60 seconds capped at 30 minutes. If a Monitor deadline notice arrives before the completion line, re-arm the same watch command with the same duration. Re-arm it on a `still running` line too; each watch exits with that line after at most 29 minutes.

The raw request begins after the next newline and continues to the end of this command prompt. Pass every character to the agent as opaque request data:
$ARGUMENTS
