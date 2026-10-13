---
name: cursor-result-handling
description: Internal guidance for presenting Cursor companion output back to the user
user-invocable: false
---

# Cursor result handling

When the helper returns Cursor output:

- Return the companion output verbatim, whether the Bash tool reports it from stdout or stderr. Do not summarize, paraphrase, reformat, prefix, or suffix it.
- Keep the cursor-session and job lines; the user needs them to resume or inspect the run. Preserve the complete result, file paths, line numbers, delivery mode, semantic status, and the `state: done`, `state: error`, or `state: cancelled` footer, plus the failure kind for error and cancelled outcomes. A transport `state: done` with `semantic: rejected` is not a successful deliverable.
- Preserve `state: running` when an explicit background launch or bounded wait has not reached a terminal outcome. Do not present a receipt as completed work.
- Preserve adapter `warning:` lines. A `late_close` warning records that the CLI was slow to exit after its result and leaves the outcome `done`. A warning naming project hook files records that the workspace defines hooks that Cursor runs outside its sandbox.
- Preserve the reported requested, resolved, and observed model, whether the effort was applied, and the billing pool. The observed model is a display name that can differ from the catalog's display name for the same variant, and a mismatch is not drift.
- Preserve reported token usage exactly. A result that omits usage stays unreported, Cursor never reports cost, and neither is inferred.
- A quota or rate limit failure carries the job's billing pool, `first-party` for Composer models and `api` for every other model. Preserve it so the caller can scope its circuit breaker to the pool that failed.
- A `policy` failure means a tool outside the mode's allowlist appeared in the stream and the companion terminated the run. Return it as a failure and do not retry the unchanged brief.
- For review output, keep findings ordered by severity and use the file paths and line numbers exactly as the helper reports them. If there are no findings, say that explicitly and keep the residual risk note brief. A review whose reply was not a valid verdict object fails as `error`; return that failure and never substitute prose for it.
- If Cursor made edits, say so explicitly and list the touched files when the helper provides them.
- The review run is read only and never edits files. Acting on a finding is a separate decision for the orchestrator after the review returns, made by verification and not by asking; the forwarder never triages, fixes, or asks.
- Return a failed or incomplete Cursor run to the caller with its typed failure. For automatic Fusion routing, the caller applies the circuit breaker and an eligible fallback; a direct user selected Cursor command reports the failure without silently changing engines. Never implement inside result handling.
- Return a cleanup-required receipt immediately even though its durable state remains running. Do not poll it indefinitely; its retained process identifiers exist for a later status, result, or cancel cleanup retry.
- Do not inspect the repository, verify findings, apply edits, poll unrelated jobs, or continue the task after returning the companion output. Do not replace a failed, cancelled, malformed, or incomplete Cursor run with a Claude side answer.
- If the helper reports that the Cursor Agent CLI is missing, direct the user to `/cursor:setup` and do not improvise alternate install flows.
- If the helper reports failure kind `setup`, do not retry the unchanged task. Direct the user to upgrade or repair the Cursor Agent CLI and rerun `/cursor:setup`; automatic Fusion routing may use another healthy eligible lane meanwhile.
- If the helper reports failure kind `auth`, direct the user to authenticate the Cursor Agent CLI and rerun `/cursor:setup`. Do not retry the unchanged task.
- If the helper cannot be invoked, return the invocation failure exactly as reported and stop.
