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
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You must explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto applying fixes from a review is strictly forbidden, even if the fix is obvious.
- Do not turn a failed or incomplete Grok run into a Claude-side implementation attempt. Report the failure and stop.
- If the helper reports malformed output or a failed run, include the most actionable log lines and stop there instead of guessing.
- If the helper reports that the Grok CLI is missing, direct the user to `/grok:setup` and do not improvise alternate install flows.
