---
name: opencode-result-handling
description: Internal guidance for presenting OpenCode Go companion output back to the user
user-invocable: false
---

# OpenCode Go result handling

When the helper returns OpenCode Go output:

- Return the companion output verbatim, whether the Bash tool reports it from stdout or stderr. Do not summarize, paraphrase, reformat, prefix, or suffix it.
- Keep the opencode-session and job lines; the user needs them to resume or inspect the run. Preserve the complete result, file paths, line numbers, delivery mode, semantic status, and the `state: done`, `state: error`, or `state: cancelled` footer, plus the failure kind for error and cancelled outcomes. A transport `state: done` with `semantic: rejected` is not a successful deliverable.
- Preserve `state: running` when an explicit background launch or bounded wait has not reached a terminal outcome. Do not present a receipt as completed work.
- Preserve adapter `warning:` lines. A `late_close` warning records that the CLI was slow to exit after its result and leaves the outcome `done`. A warning naming project configuration files records that the workspace can add permissions, hooks, MCP servers, or imports.
- Preserve the reported requested, resolved, and observed model, whether the effort was applied, and the billing pool. Preserve `model_mismatch` when the observed model differs from the requested model.
- Preserve reported token usage exactly. A result that omits usage stays unreported, never infer missing usage or cost.
- A quota or rate limit failure carries the job's billing pool, `opencode` for every Go model. Preserve it so the caller can scope its circuit breaker to the pool that failed.
- A `policy` failure means the runtime rejected the run under its execution policy. Return it as a failure and do not retry the unchanged brief.
- If OpenCode Go made edits, say so explicitly and list the touched files when the helper provides them.
- Return a failed or incomplete OpenCode Go run to the caller with its typed failure. For automatic Fusion routing, the caller applies the circuit breaker and an eligible fallback; a direct user selected OpenCode Go command reports the failure without silently changing engines. Never implement inside result handling.
- Return a cleanup-required receipt immediately even though its durable state remains running. Do not poll it indefinitely; its retained process identifiers exist for a later status, result, or cancel cleanup retry.
- Do not inspect the repository, verify findings, apply edits, poll unrelated jobs, or continue the task after returning the companion output. Do not replace a failed, cancelled, malformed, or incomplete OpenCode Go run with a Claude side answer.
- If the helper reports that the Codex CLI is missing, direct the user to `/opencode:setup` and do not improvise alternate install flows.
- If the helper reports failure kind `setup`, do not retry the unchanged task. Direct the user to upgrade or repair the Codex CLI and rerun `/opencode:setup`; automatic Fusion routing may use another healthy eligible lane meanwhile.
- If the helper reports failure kind `auth`, direct the user to run `opencode auth login` and choose OpenCode Go (or set `OPENCODE_GO_API_KEY`) and rerun `/opencode:setup`. Do not retry the unchanged task.
- If the helper cannot be invoked, return the invocation failure exactly as reported and stop.
