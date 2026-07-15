---
description: Run an adversarial Grok review against local git state
argument-hint: '[--base <ref>] [--focus <text>] [--cwd <dir>] [--json]'
allowed-tools: Read, Glob, Grep, Bash(git:*), Agent
---

Run a Grok code review through the companion runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraints:

- Never ask the user how to run the review or which findings to fix. The only question that may reach the user is a finding that forces a genuine product or design decision, such as a scope change or a public API break.
- The review never runs in the main loop. It rides in a tracked background subagent, and that runner launches the companion foreground, reads the detached review job id, and chains `result --wait` until a terminal output arrives.
- The review run is read only consult mode and never edits files. Acting on a confirmed finding is a separate orchestrator decision after the review returns.

Launch:

- Dispatch one background subagent of type `grok:grok-review-runner` via the `Agent` tool. Expand `${CLAUDE_PLUGIN_ROOT}` to its literal value when composing the prompt, and pass the raw arguments through unchanged:

```
Run this review command and return its output:
GROK_COMPANION_BACKGROUND_DELIVERY=managed GROK_COMPANION_TIMEOUT_MS=1800000 node "<plugin root>/scripts/grok-companion.mjs" review $ARGUMENTS --background
```

- Tell the user the review is running and end the turn. Do not poll; the runner's completion notification delivers the collected terminal result.

Presenting results:

- Return the runner's output verbatim, exactly as-is. Do not paraphrase, summarize, or add commentary before or after it.
- Untracked files reach the review as a name list only, not content; say so when findings depend on new files.

After presenting findings:

- Triage by verification, not by asking. After the review returns, the orchestrator separately decides whether to act on each confirmed finding; when it does, it dispatches a fix by the orchestration routing rules without prompting. Drop false positives with a stated reason.
- Close with one report: what was fixed, what was dropped, and why. Only a finding that forces a whitelisted product or design decision goes to the user as a question; everything else proceeds on defaults.
