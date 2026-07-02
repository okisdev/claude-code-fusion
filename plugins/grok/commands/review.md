---
description: Run an adversarial Grok review against local git state
argument-hint: '[--base <ref>] [--focus <text>]'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Grok code review through the companion runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:

- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Grok's output verbatim to the user.

Execution mode rules:

- Estimate the review size first: `git status --short --untracked-files=all` plus `git diff --shortstat` and `git diff --shortstat --cached`, or `git diff --shortstat <base>...HEAD` when `--base` is given.
- Treat untracked files as reviewable work even when the diff stat is empty.
- Recommend waiting only when the review is clearly tiny, roughly 1 or 2 files. In every other case, including unclear size, recommend background.
- Use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`
- The companion runs the review either way. Claude Code's `Bash(..., run_in_background: true)` is what actually detaches a long review.

Foreground flow:

- Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" review $ARGUMENTS
```

- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.

Background flow:

- Launch the review with `Bash` in the background:

```typescript
Bash({
  command: `GROK_COMPANION_TIMEOUT_MS=1800000 node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" review $ARGUMENTS`,
  description: "Grok review",
  run_in_background: true
})
```

The env prefix matters: the companion's default timeout is sized for a foreground Bash call, and a detached long review would otherwise be killed after 9.5 minutes.

- Do not wait for completion in this turn. Tell the user the review is running and will surface when done.

After presenting findings:

- STOP. Do not make any code changes. Do not fix any issues. You must explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto applying fixes from a review is strictly forbidden, even if the fix is obvious.
