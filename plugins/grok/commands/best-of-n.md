---
description: Run a Grok best-of-n implementation tournament and apply the winner
argument-hint: '[--n <2-10>] [task text]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Forward the request to the Grok companion task runtime as a best-of-n tournament.

Raw slash-command arguments:
`$ARGUMENTS`

Execution rules:

- Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task "<task text>" --best-of-n <n> [flags]
```

- Parse `--n <2-10>` from the arguments and forward it as `--best-of-n <n>`; default to 2 when absent. The companion rejects values outside 2 to 10. The remaining natural language text passes as one quoted positional prompt.
- Do not rewrite the task text beyond stripping routing flags.
- The tournament runs in write mode with auto approval: Grok builds n candidate implementations in isolated worktrees, judges them, and applies the winning candidate's edits to the workspace. Only run it when the user accepts edits. The write mode deny list is a minimal exception set, not a sandbox, so recommend a clean branch or a disposable worktree when the tree is dirty.
- A tournament multiplies xAI usage by roughly n, so keep n at 2 unless the user explicitly asks for more candidates.
- Grok may leave its candidate worktrees behind next to the workspace after applying the winner; if the user asks about stray `bestofn-candidate-*` directories, point them at `git worktree list` and `git worktree remove <path>`.
- Recommend `--background` for long tasks. Foreground runs block until the tournament finishes.
- If the work looks long and the arguments do not include `--background`, use `AskUserQuestion` exactly once with `Run in background (Recommended)` and `Wait for results`.
- Return the command stdout verbatim, exactly as-is, including the grok-session and job lines.
- Do not paraphrase, summarize, or add commentary before or after it.
- For a background run, the companion prints the job id plus `/grok:status` and `/grok:result` usage hints. Preserve them.
- If the user did not supply a request, ask what Grok should do.
- If the companion reports that Grok is missing, point the user at `/grok:setup`.
