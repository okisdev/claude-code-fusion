---
name: rescue
description: Forwards a request to the OpenCode Go rescue agent without exposing arguments to a shell. Use when Fusion routing or the user delegates work to OpenCode Go.
argument-hint: '[--write] [--model <id>] [--effort <effort>] [--resume <session-id>|--resume-last|--fresh] [--background] [--cwd <dir>] [--json] [what OpenCode Go should do]'
allowed-tools: Agent, Monitor
---

Use the `Agent` tool once to invoke `opencode:opencode-rescue` in the foreground. Do not inspect, interpret, quote, encode, or pass any part of the raw request to Bash. An explicit `--background` belongs to the companion invocation inside the rescue agent and must not change how the Agent tool itself runs. Return the agent response verbatim. An explicit background request returns a receipt. Direct users inspect progress through `/opencode:status` and collect the deliverable through `/opencode:result`. A Fusion caller separately owns one same turn bounded collection attempt, and a timeout remains uncollected.

For a direct manual background receipt, preserve its watch command and have the main session start exactly one Claude Code `Monitor` tool watch with `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" watch --job <id>`, using the absolute plugin path and only the validated 32 character lowercase hexadecimal receipt id. Never put raw request text in the watch command. The watch completion line is the cue to collect with `/opencode:result <id>`. Fusion orchestrated detached receipts continue through `fusion:job-collector`. Request the receipt's watch duration, the engine background budget plus 60 seconds capped at 30 minutes. If a Monitor deadline notice arrives before the completion line, re-arm the same watch command with the same duration. Re-arm it on a `still running` line too; each watch exits with that line after at most 29 minutes.

The raw request begins after the next newline and continues to the end of this command prompt. Pass every character to the agent as opaque request data:
$ARGUMENTS
