# Companion outcome contract

This document is the canonical engine agnostic contract for companion plugins that run peer engines for fusion. It defines job records, liveness, rendered outcome lines, failure kinds, background collection, session threading, and stop gate verdict parsing. Per engine documents define each engine's CLI invocation, flags, envelopes, field names, constants, and version pins. The Grok instance is [docs/grok-contract.md](grok-contract.md).

## Job records and lifecycle

Every job record has exactly one lifecycle status: `running`, `done`, `error`, or `cancelled`. `running` means the companion accepted work and has not yet recorded a terminal outcome. `done` means the engine returned a successful result. `error` means the run failed with a typed `failureKind`. `cancelled` means cancellation was requested through the plugin, companion signal forwarding, or session cleanup and the companion recorded that as the terminal outcome.

Terminal records are immutable: once a record is `done`, `error`, or `cancelled`, later writes must preserve it rather than replacing it with a racing worker result. Records carry the driving worker pid and the engine CLI child pid when those processes exist, so status and result commands can verify liveness and target cleanup at both layers. Record locks are recoverable: an implementation reaps an abandoned lock after its configured stale age rather than allowing a dead writer to block the record forever.

## Liveness

A `running` status is a claim, not proof of progress. Every read path that displays, counts, or relies on running jobs must verify the driving process, and when it is dead must persist terminal `status: "error"` with `failureKind: "died"` before rendering the record.

Launcher death can happen before either pid is written. During a short pidless grace window, a record with no driving worker pid and no engine child pid remains running; after the window elapses, the read path treats it as `died`. Died detection rechecks liveness under the record lock before mutating the record, so a racing completion or cancellation remains terminal. If the driving process is dead while its recorded engine child is still alive, the companion terminates the child process group with the same escalation discipline as cancellation before it finalizes the `died` record.

## Rendered outcome lines

Foreground command output and completed background result output end with a contiguous block of line based footers. Diagnostics, log excerpts, and usage hints appear before this block. The orchestrator parses these lines, not prose:

```text
<engine>-session: <session>
job: <id>
state: done|error|cancelled
failure: <kind>
```

Successful outcomes include `state: done`. Failed outcomes include `state: error` and `failure: <kind>`. Cancelled outcomes include `state: cancelled` and `failure: cancelled`. A session line uses the lowercase engine id as the prefix, for example `<engine>-session: <session>`, and appears when the engine returned a resumable session id. A `job: <id>` line appears when a job record exists. Preflight failures that happen before job creation report `state: error` and `failure: input` without a job line.

## Failure kinds

The failure kinds are:

- `quota`: The engine reports quota exhaustion, insufficient credits, or a usage limit.
- `auth`: The engine reports authentication or authorization failure, including login required failures that are not classified as quota.
- `missing_cli`: The engine CLI cannot be found or launched.
- `rate_limited`: The engine reports a rate limit, HTTP 429, or too many requests.
- `timeout`: The companion timeout elapsed and the engine process group was terminated.
- `error`: The engine or companion failed without a more specific classification, including invalid or missing engine output after a zero exit and structured output that remains invalid after its corrective retry.
- `permission`: A consult mode permission gate cancelled the turn because the engine attempted a tool call outside the read only allow list.
- `cancelled`: The plugin cancel command, companion signal forwarding, or session cleanup intentionally marked the job cancelled.
- `input`: The request was rejected before job creation, for example because the working directory was invalid.
- `died`: The driving process exited without recording an outcome, or no driving pid or engine child pid was recorded before the pidless launcher grace window elapsed.

## Background jobs

Background jobs never notify on completion. A background launch returns the job id; callers must collect the job through the plugin's status and result commands before relying on the outcome. The grok plugin additionally ships a best effort session monitor that surfaces newly terminal background jobs as notification lines in interactive sessions; it is experimental, interactive only, and not a substitute for collecting the job through status and result. The monitor is session scoped: each session's monitor reports only jobs launched from that same session, keyed by the recorded Claude session id, so concurrent sessions sharing a workspace do not hear about each other's jobs. When the session id is unavailable to the monitor process it degrades to workspace wide reporting and surfaces every session's terminal jobs. An unreadable individual job record is skipped without making the workspace snapshot unavailable, and its file id remains live for announcement deduplication until the record becomes readable or the file disappears.

## Job lookup scope

An explicit `--cwd` on a status by id, result, or cancel command restricts the lookup to that workspace's state directory. Omitting `--cwd` preserves the global id lookup across recorded workspaces for compatibility.

## Session threading

`resume-last` selects the newest non running job with a session id for the workspace, preferring jobs started from the current Claude session.

## Stop gate

The stop gate verdict is the first nonempty line in the engine reply. `ALLOW` allows the stop, and `BLOCK: <reason>` blocks with that reason. Infrastructure failures fail open.
