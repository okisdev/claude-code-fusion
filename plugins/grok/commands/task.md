---
description: Delegate a coding or consultation task to the local Grok CLI through the companion runtime
argument-hint: '[--write] [--web] [--background] [--resume <uuid>|--resume-last] [--model <id>] [--effort <level>] [--max-turns <n>] [--best-of-n <n>] [what Grok should do]'
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Forward the request to the Grok companion task runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Execution rules:

- Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task "<task text>" [flags]
```

- Separate routing flags from the task text: `--write`, `--web`, `--background`, `--resume <uuid>`, `--resume-last`, `--model`, `--effort`, `--max-turns`, and `--best-of-n` pass through as flags, and the remaining natural language text passes as one quoted positional prompt.
- Do not rewrite the task text beyond stripping routing flags.
- Recommend `--background` for long, open-ended, or multi-step work. Foreground runs block until Grok finishes.
- If the work looks long and the arguments do not include `--background`, use `AskUserQuestion` exactly once with `Run in background (Recommended)` and `Wait for results`.
- Leave `--model` and `--effort` unset unless the user explicitly asked for them. Grok resolves both from its own config.
- `--web` re-enables Grok's web tools for research briefs; leave it off for code work.
- `--best-of-n` implies write mode with auto approval because the tournament applies the winning candidate to the workspace; pass it only when the user accepts edits.
- Never invent a session uuid for `--resume`. Only pass a uuid that Grok previously returned; for continuing the most recent thread use `--resume-last`.
- Return the command stdout verbatim, exactly as-is, including the grok-session and job lines.
- Do not paraphrase, summarize, or add commentary before or after it.
- For a background run, the companion prints the job id plus `/grok:status` and `/grok:result` usage hints. Preserve them.
- If the user did not supply a request, ask what Grok should do.
- If the companion reports that Grok is missing, point the user at `/grok:setup`.
