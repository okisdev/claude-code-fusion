---
name: codex-result-handling
description: Internal contract for returning Codex companion output without alteration.
user-invocable: false
---

# Codex result handling

- Return companion stdout verbatim. Do not summarize, paraphrase, reformat, prefix, or suffix it.
- Preserve the complete result, file paths, line numbers, Codex thread identifier, job identifier, delivery mode, semantic status, and `state: done`, `state: error`, or `state: cancelled` footer. Preserve the failure kind for error and cancelled outcomes. A transport `state: done` with `semantic: rejected` is not a successful deliverable.
- Preserve `state: running` when an explicit background launch or bounded wait has not reached a terminal outcome. Do not present a receipt as completed work.
- A timeout result whose body carries a `Resume Codex job` line authorizes exactly one scripted resume with the wind down prompt named by the agent contract; return the resumed companion output verbatim. No other state authorizes a second companion call, and a resume never repeats.
- Do not inspect the repository, verify findings, apply edits, poll unrelated jobs, or continue the task after returning the companion output.
- Do not replace a failed, cancelled, malformed, or incomplete Codex run with a Claude-side answer.
- If the helper cannot be invoked, return the invocation failure exactly as reported and stop.
