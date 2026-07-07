# Orchestration troubleshooting

Reference material for plugins/fusion/rules/orchestration.md. This file is not synced to ~/.claude/rules and nothing installs it automatically; it exists for the orchestrator to consult when a delegation is failing, not as an always loaded rule.

## Escalation ladders

Failure driven escalation applies among the Claude fusion worker tiers; peer failures are handled by the circuit breaker table below instead.

- Diagnose the brief before the engine: a starved worker looks exactly like a weak one, and most "it just did not do the work" failures are under specified briefs, not capability gaps. Hold the failed brief against the dispatch gate (goal, constraints, relevant paths, done criteria, verification command); if a piece is missing, complete the brief and re-dispatch at the same tier. Only when a complete brief still failed on capability grounds, re-dispatch the same brief one rung up the ladder with the failure attached (fusion:trivial-worker to fusion:fast-worker to fusion:deep-reasoner, or a peer retry at higher effort). Do not fix a delegate's botched output in the main loop. The circuit breaker takes precedence: a broken engine is never a rung.
- Quality driven escalation runs alongside the failure ladder: a completed run can still fail review. When the output is correct but below the quality bar, re-dispatch the same brief plus concrete critique one rung up, or to a better suited engine, without asking. Never accept substandard output just because the cheaper lane technically succeeded; judge the output, not the price tag.

## Failure kinds and the circuit breaker

The grok companion emits these kinds directly; for engines that do not, map the observed failure onto the closest kind before acting.

| Failure kind | Immediate action | Circuit breaker effect |
|---|---|---|
| quota, auth, missing_cli | Stop retrying this engine | Breaks the engine for the rest of the session |
| rate_limited | One retry | Breaks after that one retry fails |
| timeout | One resume (--resume <uuid>) or one --background rerun, collected through fusion:job-collector before the turn ends | Escalates to a different executor if the retry also times out; does not break the engine |
| died | Cancel the stale job, then one resume of the thread with the failure attached | Escalates to a different executor if the resume also dies; does not break the engine |
| error | One retry with the failure attached | Escalates after the retry; does not break the engine |
| permission | Re-dispatch once with --write if repository changes are acceptable, otherwise rewrite the brief to avoid shell commands | Does not break the engine; this is an allow list gap, not misbehavior |
| cancelled | Confirm with the user before treating the work as intentionally dropped | An externally killed job can also report cancelled, so verify before trusting it |
| missing agent type or a `grok unavailable:` line | Route to the fallback lane | Breaks immediately |

When an engine is broken, use the other peer for second opinions and fusion:deep-reasoner for adversarial review.

## Died process detection

A running status from a background job is a claim, not verified progress. A worker process that dies without recording an outcome (a crash, a reboot, a stream reconnect that never recovers) leaves its job reporting running indefinitely. Before continuing to wait on any background job whose log has gone quiet, verify liveness rather than trusting status.

The grok companion runs this check itself and reports such jobs as failure kind died. Codex does not track its worker process, so check it directly: no codex process in `ps` and no process holding the job's rollout file open means the job is dead. A dead process behind a running status is a died outcome, not a slow one: cancel the job, resume the thread once with the failure attached, and if that resume also dies silently, finish the package on a different executor instead of resuming a third time.

## Worker reuse and thread rotation

Worker reuse is scoped and rotated. A follow up instruction may go to the same worker via SendMessage only when it modifies the same files or surface as that worker's previous brief; a new work package, a different surface, or anything that can run in parallel gets a fresh agent instead of queueing behind a warm one.

Reuse is capped: after about three follow up resumes, or when completion notifications show the worker's accumulated usage nearing its context window, rotate to a fresh worker whose brief carries the accumulated decisions and current state rather than assuming the old thread's memory. Truncation resumes complete an existing brief under the same rule but still grow the same context, so they count toward rotation.

The same rotation discipline applies to every warm peer thread, whether kept alive with grok's --resume-last or continued through codex resume. A peer thread whose accumulated context has grown very large is the kind most likely to die mid stream, so rotate it to a fresh thread carrying the accumulated decisions instead of resuming it again.

Warm thread eligibility for --resume-last: reuse the warm grok thread only when the new brief continues the same task, files, or subsystem as the prior one, and cannot run in parallel with it. Start a fresh thread for unrelated packages, panels, reviews, and anything dispatched in parallel.
