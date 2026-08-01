# Companion outcome contract

This document is the canonical engine agnostic contract for companion plugins that run peer engines for fusion. It defines job records, liveness, rendered outcome lines, failure kinds, background collection, session threading, and stop gate verdict parsing. Per engine documents define each engine's CLI invocation, flags, envelopes, field names, constants, and version pins. The current instances are [docs/codex-contract.md](codex-contract.md) and [docs/grok-contract.md](grok-contract.md).

## Job records and lifecycle

Every job record has exactly one lifecycle status: `running`, `done`, `error`, or `cancelled`. `running` means the companion accepted work and has not yet recorded a terminal outcome. `done` means the engine returned a successful transport result. `error` means the run failed with a typed `failureKind`. `cancelled` means cancellation was requested through the plugin, companion signal forwarding, or session cleanup and the companion recorded that as the terminal outcome. Transport status, semantic acceptance, and delivery are independent dimensions. `semanticStatus` is `accepted`, `rejected`, or `unverified`; only the orchestrator can mark a deliverable accepted after checking its completion criteria. `delivery` identifies foreground, manual background, or managed background ownership, while `deliveryStatus` or a collection timestamp records whether the result crossed the companion boundary. A terminal job without explicit semantic evidence remains `unverified`.

Terminal transport outcomes are immutable: once a record is `done`, `error`, or `cancelled`, later writes must preserve that outcome rather than replacing it with a racing worker result. An adapter may set a delivery or collection acknowledgement timestamp once after a successful result read, but that metadata update cannot change the terminal status, result, diagnostics, usage, or process evidence. Records carry the driving worker pid and the engine CLI child pid when those processes exist, so status and result commands can verify liveness and target cleanup at both layers. A companion that signals persisted process identifiers must also persist and verify process ownership identity, reject unsafe identifiers such as PID 1, and retain a retryable running cleanup state whenever verified termination does not complete. When the engine reports actual model or token usage, the companion may retain those structured fields and their upstream incompleteness marker on both successful and failed terminal records; aggregation must disclose complete, incomplete, and unreported coverage and must not estimate it. A partial usage object cannot enter exact totals through zero filling, a total derived from other fields, or a multi-attempt merge that fills one attempt's missing fields from another attempt. Record locks are recoverable. A lock that carries a verifiable owner identity is reclaimed only after the owner exits or its PID identity changes, and release must prove ownership so an earlier holder cannot remove a successor. An engine without verifiable process identity may retain a bounded stale age fallback in its own contract.

## Liveness

A `running` status is a claim, not proof of progress. Authoritative companion status, result, and cancel paths verify the driving process and persist lifecycle transitions. Cross-plugin stats and monitor observers stay read only, may report an apparently dead owner as advisory evidence, and never signal a recorded process or rewrite canonical lifecycle state.

Launcher death can happen before either pid is written. During a short pidless grace window, a record with no driving worker pid and no engine child pid remains running; after the window elapses, an authoritative companion read treats it as `died`. Died detection rechecks liveness before mutating the record, so a racing completion or cancellation remains terminal. If the driving process is dead while its recorded engine child is still alive, the companion terminates the verified child process group with the same escalation discipline as cancellation before it finalizes the `died` record. Failed or unverifiable cleanup retains the identifiers and keeps the record running with an explicit cleanup phase.

## Rendered outcome lines

Foreground command output and completed background result output end with a contiguous block of line based footers. Diagnostics, log excerpts, and usage hints appear before this block. The orchestrator parses these lines, not prose:

```text
<engine>-session: <session>
job: <id>
sandbox: <cwd>
delivery: foreground|manual|managed
semantic: accepted|rejected|unverified
state: done|error|cancelled
failure: <kind>
```

Successful transport outcomes include `state: done`. Failed outcomes include `state: error` and `failure: <kind>`. Cancelled outcomes include `state: cancelled` and `failure: cancelled`. A session line uses the lowercase engine id as the prefix, for example `<engine>-session: <session>`, and appears when the engine returned a resumable session id. A `job: <id>` line appears when a job record exists. Adapters include `delivery` and `semantic` when those dimensions are available in their text protocol; structured JSON always keeps them separate from transport status. Input validation failures that happen before job creation report `state: error` and `failure: input` without a job line. Both companions reject an implicit task or review working directory below its Git repository root before job creation. Other preflight failures retain their typed failure kind, such as `missing_cli` or `setup`.

## Failure kinds

The shared failure kinds are:

- `quota`: The engine reports quota exhaustion, insufficient credits or balance, a usage limit, or HTTP 402 Payment Required.
- `auth`: The engine reports authentication or authorization failure, including login required failures that are not classified as quota.
- `missing_cli`: The engine CLI cannot be found or launched.
- `setup`: The installed CLI version or installation lacks a required adapter capability and fails capability preflight. Upgrade or repair the CLI and rerun the companion setup command; do not retry the unchanged task against the same incompatible surface.
- `rate_limited`: The engine reports a rate limit, HTTP 429, or too many requests.
- `timeout`: The companion timeout elapsed and the engine process group was terminated.
- `error`: The engine or companion failed without a more specific classification, including invalid or missing engine output after a zero exit and structured output that fails its adapter validation.
- `permission`: A permission gate or sandbox rejected an engine action that the selected read only or write mode did not allow.
- `cancelled`: The plugin cancel command, companion signal forwarding, or session cleanup intentionally marked the job cancelled.
- `input`: The request was rejected before job creation, for example because the working directory was invalid.
- `died`: The driving process exited without recording an outcome, or no driving pid or engine child pid was recorded before the pidless launcher grace window elapsed.
- `resource`: The adapter rejected an artifact that exceeded a bounded resource limit, a run whose protocol was left incomplete by skipped oversized events, or could not acquire an exclusive runtime resource, including because of an active session lease or an ambiguous legacy id.

Engine adapters may define additional typed failure kinds beyond this shared set. The current Codex instance adds `protocol`, for a required structured lifecycle stream that was malformed, incomplete, or incompatible with the adapter, `process`, for an engine process that exited because of an unexpected signal or other unrequested process termination, and `policy`, for a forbidden Codex collaboration tool call. The Grok instance adds `sandbox`, for sandbox initialization or enforcement failure, `transport`, for prompt delivery or structured envelope failure, and `policy`, for missing positive tool-policy evidence or a fallback, unmappable, or unmatched tool-policy warning.

## Background jobs

Background delivery is distinct from Agent scheduling and engine process supervision. A manual background launch returns a job id; callers inspect progress through status and collect the deliverable through result before relying on the outcome. A managed background worker is an internal timeout bridge whose owning Agent retains the receipt, collects the terminal result in the caller's original text or JSON format, and records that collection only after writing the terminal output. It must not surface a launch receipt as its deliverable. A running record whose verified process cleanup cannot complete is the exception to terminal collection: the collector returns an explicit nonterminal cleanup-required failure receipt instead of looping forever, and the durable process evidence remains available for a later cleanup retry. The collection timestamp acknowledges a successful companion stdout write, not observation of the Agent's later final message, which the companion cannot see. The Grok monitor suppresses collected managed jobs and emits a delayed fallback notification after the grace period when a terminal managed job remains uncollected, as a best effort owner loss fallback. The Grok plugin and Fusion's Codex integration ship best effort interactive monitors for manual background jobs. A monitor notification is never a substitute for collecting through result. Monitors scope announcements by the recorded Claude session id where available and degrade to workspace or repository scope when the session id is unavailable. A session scoped monitor may scan recorded workspaces so a job launched through an explicit working directory remains observable. An unreadable individual job record is skipped without making the workspace snapshot unavailable, and its file id remains live for announcement deduplication until the record becomes readable or the file disappears.

## Job lookup scope

An explicit `--cwd` on a status by id, result, or cancel command restricts the lookup to that workspace's state directory. Omitting `--cwd` preserves the global id lookup across recorded workspaces for compatibility. An adapter must reject an ambiguous duplicate id rather than choose one record arbitrarily.

## Session threading

`resume-last` selects the newest non running job with an engine session id that is eligible under the engine contract for the workspace. When the current Claude session id is available, selection is restricted to jobs launched by that session so one conversation cannot accidentally continue another conversation's engine thread. Without a Claude session id, it falls back to the newest eligible workspace job.

## Stop gate

The stop gate verdict is the first nonempty line in the engine reply. `ALLOW` allows the stop, and `BLOCK: <reason>` blocks with that reason. Infrastructure failures fail open.
