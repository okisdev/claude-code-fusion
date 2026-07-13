---
name: grok-result-handling
description: Internal guidance for presenting Grok companion output back to the user
user-invocable: false
---

# Grok result handling

When the helper returns Grok output:

- Return the companion stdout verbatim. Do not paraphrase, summarize, or add commentary before or after it.
- Keep the grok-session and job lines; the user needs them to resume or inspect the run.
- For review output, keep findings ordered by severity and use the file paths and line numbers exactly as the helper reports them.
- If there are no findings, say that explicitly and keep the residual risk note brief.
- If Grok made edits, say so explicitly and list the touched files when the helper provides them.
- The review run is read only consult mode and never edits files. After it returns, triage findings by verification, not by asking. The orchestrator separately decides whether to act on each confirmed finding; when it does, dispatch a fix without prompting, and drop false positives with a stated reason. Only a finding that forces a genuine product or design decision goes to the user as a question. Close with one report: what was fixed, what was dropped, and why.
- Do not turn a failed or incomplete Grok run into a Claude-side implementation attempt. Report the failure and stop.
- If the helper reports malformed output or a failed run, include the most actionable log lines and stop there instead of guessing.
- If the helper reports that the Grok CLI is missing, direct the user to `/grok:setup` and do not improvise alternate install flows.
