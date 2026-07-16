---
name: grok-result-handling
description: Internal guidance for presenting Grok companion output back to the user
user-invocable: false
---

# Grok result handling

When the helper returns Grok output:

- Return the companion output verbatim, whether the Bash tool reports it from stdout or stderr. Do not paraphrase, summarize, or add commentary before or after it.
- Keep the grok-session and job lines; the user needs them to resume or inspect the run.
- Preserve reported request id, turn count, aggregate and per-model token usage, cost, partial-cost, incomplete-usage-ledger, and structured-output fields. Upstream per-model rows contain input, output, cache-read, and model-call counts plus optional cost; never invent aggregate reasoning or total tokens. When `usage_is_incomplete` is true, present counts are observed lower bounds and both job-total token and cost coverage are incomplete. Missing values stay missing; do not infer zero or exactness.
- For review output, keep findings ordered by severity and use the file paths and line numbers exactly as the helper reports them.
- If there are no findings, say that explicitly and keep the residual risk note brief.
- If Grok made edits, say so explicitly and list the touched files when the helper provides them.
- The review run is read only consult mode and never edits files. After it returns, triage findings by verification, not by asking. The orchestrator separately decides whether to act on each confirmed finding; when it does, dispatch a fix without prompting, and drop false positives with a stated reason. Only a finding that forces a genuine product or design decision goes to the user as a question. Close with one report: what was fixed, what was dropped, and why.
- Return a failed or incomplete Grok run to the caller with its typed failure. For automatic Fusion routing, the caller applies the circuit breaker and an eligible fallback; a direct user selected Grok command reports the failure without silently changing engines. Never implement inside result handling.
- Return a cleanup-required failure receipt immediately even though its durable state remains running. Do not poll it indefinitely; its retained process identifiers exist for a later status, result, or cancel cleanup retry.
- If the helper reports malformed output, a structured output error, missing or mismatched `ProfileApplied` evidence, an owned-stderr sandbox warning or handshake timeout, shared sandbox-event rotation, absent positive tool allowlist evidence, a fallback or unmatched policy warning, or another failed run, include the most actionable log lines and return control to the caller instead of guessing. Shared `ApplyFailed` events are auxiliary diagnostics because upstream supplies no run id or pid.
- If the helper reports that the Grok CLI is missing, direct the user to `/grok:setup` and do not improvise alternate install flows.
- If the helper reports failure kind `setup`, do not retry the unchanged task. Direct the user to upgrade or repair the Grok CLI and rerun `/grok:setup`; automatic Fusion routing may use another healthy eligible lane meanwhile.
