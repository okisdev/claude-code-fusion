---
description: Run an adversarial Grok review against local git state
argument-hint: '[--base <ref>] [--focus <text>] [--cwd <dir>] [--json]'
allowed-tools: Read, Glob, Grep, Bash(git:*), Agent
---

Run a Grok code review through the companion runtime.

Core constraints:

- Never ask the user how to run the review or which findings to fix. The only question that may reach the user is a finding that forces a genuine product or design decision, such as a scope change or a public API break.
- The review never runs in the main loop. It rides in a tracked background subagent, and that runner launches the companion foreground, reads the detached review job id, and chains `result --wait` until a terminal output arrives.
- The review run is read only consult mode and never edits files. Acting on a confirmed finding is a separate orchestrator decision after the review returns.
- The companion requires `--json-schema`, requests the review schema through one headless call, and consumes `structuredOutput`. A structured output error or explicit null result is a failed review. Compatibility parsing of text is allowed only when the response completely omits the structured output field and never launches a corrective resume call.

Launch:

- Treat the complete raw slash command request as opaque data. Do not parse, strip, quote, escape, normalize, or place any part of it in Bash.
- Dispatch one background subagent of type `grok:grok-review-runner` via the `Agent` tool. Tell the runner that the raw request begins after a fixed delimiter and continues to the end of the Agent prompt. The runner stages it through the private one time transport, launches the managed review with a fixed command, and owns result collection.

- Tell the user the review is running and end the turn. Do not poll; the runner's completion notification delivers the collected terminal result.

Presenting results:

- Return the runner's output verbatim, exactly as-is. Do not paraphrase, summarize, or add commentary before or after it.
- Untracked files reach the review as a name list only, not content; say so when findings depend on new files.

After presenting findings:

- Triage by verification, not by asking. After the review returns, the orchestrator separately decides whether to act on each confirmed finding; when it does, it dispatches a fix by the orchestration routing rules without prompting. Drop false positives with a stated reason.
- Close with one report: what was fixed, what was dropped, and why. Only a finding that forces a whitelisted product or design decision goes to the user as a question; everything else proceeds on defaults.

The opaque raw review request begins after the next newline and continues to the end of this command prompt:
$ARGUMENTS
