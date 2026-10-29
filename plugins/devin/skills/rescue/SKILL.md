---
name: rescue
description: Forwards a request to the Devin rescue agent without exposing arguments to a shell. Use when Fusion routing or the user delegates work to Devin.
argument-hint: '[--write] [--model <id>] [--effort <effort>] [--resume <session-id>|--resume-last|--fresh] [--background] [--cwd <dir>] [--json] [what Devin should do]'
allowed-tools: Agent
---

Use the `Agent` tool once to invoke `devin:devin-rescue` in the foreground. Do not inspect, interpret, quote, encode, or pass any part of the raw request to Bash. An explicit `--background` belongs to the companion invocation inside the rescue agent and must not change how the Agent tool itself runs. Return the agent response verbatim. An explicit background request returns a receipt. Direct users inspect progress through `/devin:status` and collect the deliverable through `/devin:result`. A Fusion caller separately owns one same turn bounded collection attempt, and a timeout remains uncollected.

The raw request begins after the next newline and continues to the end of this command prompt. Pass every character to the agent as opaque request data:
$ARGUMENTS
