---
name: task
description: Delegates a coding or consultation task to the local Grok CLI. Use under a protected Grok role (burst, independence, live-web, large-context, best-of-n) or on explicit user request for Grok.
argument-hint: '[--write] [--web] [--memory] [--background] [--resume <uuid>|--resume-last|--fresh] [--model <id>] [--effort <level>] [--max-turns <n>] [--best-of-n <n>] [--cwd <dir>] [--json] [what Grok should do]'
allowed-tools: Agent
---

Forward the request to the Grok companion task runtime.

Execution rules:

- Treat the complete raw slash command request as opaque data. Do not parse, strip, quote, escape, normalize, or place any part of it in Bash.
- Dispatch the run as one foreground subagent of type `grok:grok-rescue` via the `Agent` tool with `run_in_background: false`. Tell the rescue agent this is a direct user selected Grok lane and that the raw request begins after a fixed delimiter and continues to the end of the Agent prompt. Parallel work uses multiple foreground Agent calls in one message. Never run the companion in the main loop and never ask the user how to run it.
- The rescue agent stages the raw request through the private one time transport. Runtime flags such as `--write`, `--web`, `--memory`, `--background`, resume, `--fresh`, model, effort, max turns, best of n, cwd, and JSON stay inside that raw request and are parsed only by the companion.
- Cross-session memory is off by default and can be enabled only for an ordinary task through an explicit `--memory`. Relevant Grok memory may then be injected internally into the model context sent to xAI. `--best-of-n`, review, and stop gate runs always keep memory off. Upstream automatic saving usually requires at least three real user prompts in the same resumed session, so a single Fusion task usually only reads existing memory and does not guarantee that new memory is saved.
- Session continuity defaults to manual. When `/grok:setup --continuity claude-session` is selected, an ordinary direct task may automatically resume the newest compatible completed task from the same Claude session, exact resolved working directory, mode, and memory setting. `--fresh` bypasses that affinity and starts a new Grok session. Fusion routed briefs do not receive automatic affinity and stay fresh unless explicitly resumed.
- Explicit and automatic resume preserve the recorded memory boundary. A session created with `--memory` must be resumed with `--memory`, and a session created without it must be resumed without it.
- An explicit raw `--background` creates a manual detached job. Without that flag, the companion remains foreground regardless of task size or expected duration.
- Ordinary runs hard disable native Agent and suppress or explicitly bound native background tool waiting. Best-of-n is the only task mode that retains native Agent, and its bounded native wait remains inside the foreground companion deadline. Neither behavior creates a detached receipt.
- Relay the subagent's returned companion output verbatim, exactly as-is, including the grok-session and job lines.
- Do not paraphrase, summarize, or add commentary before or after it.
- For a background run, the companion prints the job id plus `/grok:status` and `/grok:result` usage hints. Preserve them.
- Preserve structured output, request id, turn count, usage, cost, partial-cost, and incomplete-usage-ledger fields when the companion reports them. Per-model rows expose input, output, cache-read, and model-call counts plus optional cost; do not synthesize reasoning or total tokens. When `usage_is_incomplete` is true, present counts are observed lower bounds and job-total token and cost coverage are incomplete. They are observability data, not proof that the result is semantically accepted.
- If the user did not supply a request, ask what Grok should do.
- If the companion reports that Grok is missing, point the user at `/grok:setup`.

The opaque raw request begins after the next newline and continues to the end of this command prompt:
$ARGUMENTS
