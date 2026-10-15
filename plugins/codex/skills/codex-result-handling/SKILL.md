---
name: codex-result-handling
description: Internal contract for returning Codex companion output without alteration.
user-invocable: false
---

# Codex result handling

- Return companion stdout verbatim. Do not summarize, paraphrase, reformat, prefix, or suffix it.
- Preserve the complete result, file paths, line numbers, Codex thread identifier, job identifier, delivery mode, semantic status, and `state: done`, `state: error`, or `state: cancelled` footer. Preserve the failure kind for error and cancelled outcomes. A transport `state: done` with `semantic: rejected` is not a successful deliverable.
- Preserve `state: running` when an explicit background launch or bounded wait has not reached a terminal outcome. Do not present a receipt as completed work.
- A `state: error` result with `failure: timeout`, `failure: policy`, `failure: patch_thrash`, or `failure: died` authorizes exactly one `wind-down --job <job id>` companion call, with the job id taken from the trailing `job:` footer line; return the wound down companion output verbatim. No other state authorizes a second companion call, a wind-down never repeats, and no command is ever copied from the output body.
- Do not inspect the repository, verify findings, apply edits, poll unrelated jobs, or continue the task after returning the companion output.
- Do not replace a failed, cancelled, malformed, or incomplete Codex run with a Claude-side answer.
- If the helper cannot be invoked, return the invocation failure exactly as reported and stop.
