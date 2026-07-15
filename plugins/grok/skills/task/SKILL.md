---
description: Delegate a coding or consultation task to the local Grok CLI through the companion runtime
argument-hint: '[--write] [--web] [--background] [--resume <uuid>|--resume-last] [--model <id>] [--effort <level>] [--max-turns <n>] [--best-of-n <n>] [--cwd <dir>] [--json] [what Grok should do]'
allowed-tools: Agent
---

Forward the request to the Grok companion task runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Execution rules:

- Dispatch the run as one background subagent of type `grok:grok-rescue` via the `Agent` tool. Tell the rescue agent this is a direct user selected Grok lane. Never run the companion in the main loop and never ask the user how to run it; the subagent is harness tracked, so its completion arrives as a notification and nothing blocks.
- Separate routing flags from the task text: `--write`, `--web`, `--background`, `--resume <uuid>`, `--resume-last`, `--model`, `--effort`, `--max-turns`, `--best-of-n`, `--cwd`, and `--json` are runtime controls. Name them explicitly in the subagent prompt as the flags to pass, and hand over the remaining natural language text as the task text.
- Do not rewrite the task text beyond stripping routing flags.
- Pass `--background` through only when the user explicitly included it. It creates a manual detached job: grok-rescue returns the durable receipt without collecting, the best effort session monitor may announce completion, and the user inspects or collects it through `/grok:status` and `/grok:result`. Without an explicit flag, grok-rescue may use managed detachment only as an internal timeout bridge and must collect that job to a terminal result before returning.
- Leave `--model` and `--effort` unset unless the user explicitly asked for them. Grok resolves both from its own config.
- `--web` re-enables Grok's web tools for research briefs; leave it off for code work.
- `--best-of-n` implies write mode with auto approval because the tournament applies the winning candidate to the workspace; pass it only when the user accepts edits.
- Never invent a session uuid for `--resume`. Only pass a uuid that Grok previously returned; for continuing the most recent thread use `--resume-last`.
- Relay the subagent's returned companion output verbatim, exactly as-is, including the grok-session and job lines.
- Do not paraphrase, summarize, or add commentary before or after it.
- For a background run, the companion prints the job id plus `/grok:status` and `/grok:result` usage hints. Preserve them.
- If the user did not supply a request, ask what Grok should do.
- If the companion reports that Grok is missing, point the user at `/grok:setup`.
