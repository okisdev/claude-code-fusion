# Codex companion contract

This document defines the Codex instance of the shared companion contract. The adapter owns orchestration, job state, process supervision, rendering, and Fusion integration. The official Codex CLI owns authentication, model execution, tool execution, sandbox enforcement, and persisted Codex threads.

## Runtime boundary

The companion invokes the user-installed `codex` binary through `codex exec --json`. It consumes JSONL from stdout, keeps stderr separate, and stores the raw event stream for diagnosis. It does not depend on `codex-plugin-cc`, parse human-readable Codex output, inspect Codex rollout files for primary state, or copy Codex authentication material.

The adapter accepts protocol extensions by retaining unknown events. A run succeeds only after a valid `turn.completed` event and a zero process exit. A `turn.failed` event, nonzero exit, signal, timeout, malformed required event, or exit without a terminal turn event fails the job. Top-level `error` events and error items remain diagnostics because Codex can emit them for recoverable retries and configuration warnings.

## Foreground invariant

Task and review commands run in the foreground by default. The caller remains attached until the matching Codex process exits and the companion records a terminal job. Complexity, estimated duration, model choice, and review size never authorize the adapter or forwarding agent to detach work.

Background execution requires an explicit `--background` argument. A background launch creates and persists the job record and brief before spawning a detached companion worker. The worker first records its process identity and waits for a separate approval checkpoint. The parent approves only the exact verified worker it spawned, and the worker cannot start Codex before that approval is durable. A failed parent probe records launch abort before cleanup, so a late worker claim cannot start work after the launcher reported failure. The worker, not a Claude subagent or shell process, owns the Codex child until terminal state. A receipt is never a completed result. Direct Codex commands, including `/codex:task --background` and `/codex:rescue --background`, return that receipt without starting a collector; the user inspects progress through status and collects the deliverable through result. When Fusion is installed, its interactive monitor may also notify the user of completion. When Fusion orchestration creates a detached Codex job, Fusion owns one same turn collection attempt capped at 540000ms. A timeout leaves the job explicitly uncollected.

## Job lifecycle

Every record has one transport status: `running`, `done`, `error`, or `cancelled`.

- `running` means the companion accepted work and has not recorded a terminal outcome.
- `done` means Codex emitted `turn.completed`, exited successfully, and the companion persisted the result.
- `error` means the run ended unsuccessfully with a typed `failureKind`.
- `cancelled` means cancellation was requested and the supervised Codex process group was terminated.

Terminal transport outcomes are immutable. Racing completion, cancellation, liveness repair, and worker failure may enrich diagnostics only when they do not change an existing terminal outcome. A successful `result` read may set `collectedAt` once so retention can distinguish an uncollected detached deliverable from ordinary history.

Each record contains the companion PID and ownership identity, Codex PID and ownership identity, Claude session ID, Codex thread ID when known, workspace root, repository identity, request settings, timestamps including collection state, result text, exact reported token usage when available, failure kind, bounded diagnostic text, and paths to its brief, log, and raw event ledger.

## Process supervision

The companion launches Codex in a distinct process group where the platform permits it. Before that spawn, a background record enters `codex-spawning`; immediately after spawn it records the child PID, then adds the process start identity, boot identity, and command fingerprint before ordinary execution continues. Timeout, cancellation, signal forwarding, session cleanup, and orphan repair verify that identity before sending SIGINT for graceful cleanup because the Codex CLI handles only SIGINT, then escalating to SIGTERM and SIGKILL after bounded grace periods. If the identity checkpoint is incomplete, the companion requests graceful cleanup without forcibly terminating the supervisor and keeps the record nonterminal as `cleanup-required`. PID 1 is never considered a valid target. An identity mismatch is treated as PID reuse and is never signalled. A leaderless group found later through persisted state cannot be authenticated from the historical leader identity, so the companion retains `cleanup-required` rather than risking a signal to a reused process group.

Terminal state is written only after verified cleanup of the owned process group completes. If termination cannot be verified, the job stays `running` in `cleanup-required`, retains both process identifiers and identities, and returns a failure so a later authoritative status, result, or cancel can retry safely. Execution also has a hard local return bound: inherited pipes or an unresponsive process cannot keep the caller attached indefinitely. Process groups are the portable containment boundary on macOS and Linux. A tool that deliberately creates a new session or daemonizes into a different process group leaves that boundary and is not claimed as supervised by the adapter.

The SessionEnd hook silently cancels only running jobs whose recorded Claude session id matches the ending session. It never cancels another concurrent Claude session's jobs.

A `running` record is not proof of liveness. Companion status, result, and cancel paths verify the companion and Codex PIDs. A record remains running during a short pidless launch grace period. After that period, a companion read path atomically finalizes a record without a live owner as `error` with `failureKind: "died"`. Fusion monitor and ordinary stats observation paths are read only with respect to canonical lifecycle state. They never signal a recorded PID or repair a canonical Codex record; the monitor may report an apparently dead running owner as a best effort notice, and Codex status or result performs the authoritative locked recheck. The explicit `/fusion:stats --prune-dead --yes` cleanup remains a separate user-authorized deletion path.

## State durability

Job snapshots use atomic replacement under recoverable per-record locks. Every record, workspace, and thread lock has a random ownership token plus the owning PID identity. A contender reclaims a lock only after it proves that the owner exited or the PID identity changed, and release verifies the token so an earlier holder cannot remove a successor's lock. Raw JSONL event ledgers retain an append-only bounded prefix during each run, while diagnostic logs retain a bounded tail. State lookup may span workspace directories when a job ID is explicit, while `--cwd` restricts lookup to that workspace.

Managed terminal history defaults to at most 256 records and 512 MiB. Garbage collection protects running jobs, the current workspace resume head and one direct predecessor, and every terminal background job until `result` marks it collected. Those safety exceptions can temporarily keep managed history above quota. Collection removes only recognized current-schema record artifacts and empty known directories. Future-schema records, corrupt quarantines, crash orphans, unknown files, and other content that cannot be classified safely are neither counted toward this managed-history quota nor deleted, so the quota is not a bound on the entire data root.

The companion permits one active Codex job per canonical workspace. Admission is serialized under a recoverable workspace lock, so two launches cannot both pass the single flight gate. An isolated Git worktree has a distinct canonical workspace and may run concurrently while retaining the shared repository identity used by Fusion aggregation. Resuming a thread additionally uses a data-root-wide thread lease, so the same Codex thread cannot run concurrently from different worktrees.

The record stores both the canonical workspace path and a repository key derived from the Git common directory. This preserves worktree separation while allowing Fusion to aggregate jobs belonging to the same repository. Fusion treats the stored repository key as authoritative, including after a disposable worktree path has been removed.

`turn.completed.usage` is cumulative for the Codex thread. A fresh thread uses a zero baseline. A resumed thread stores the reported cumulative value but marks per-turn usage unavailable because the adapter cannot prove that another Codex surface did not resume the same thread between its own jobs. It never reports cumulative usage as one turn, attributes out of band turns to the current job, or fills missing fields with zero. Fusion may independently recover a turn delta from a matching local rollout boundary, but that observation is not canonical adapter state.

## Task execution

Consult tasks use the Codex read-only sandbox. Write tasks require `--write` and use the workspace-write sandbox. Both modes use noninteractive approval policy so an unattended exec run cannot hang on an approval request. Danger full access is not exposed by the companion.

The companion does not add a shell command allow list and does not rewrite the user's configured MCP servers or other Codex tools. Those integrations remain a separate Codex configuration trust boundary and may carry capabilities beyond the filesystem sandbox.

Model and reasoning effort remain unset unless explicitly requested. The Codex configuration remains authoritative for defaults. The companion explicitly sets web search to disabled and workspace-write network access to false by default. `--web` opts a read-only or write task into live Codex web search. `--network` requires `--write` and opts the workspace-write sandbox into network access.

The companion writes the prompt to Codex stdin. Prompts are never interpolated into a shell command. Slash-command ingress allocates a private token-named staging file, and the command model writes the raw request through its Write tool before invoking a fixed companion command containing only that token. Once the staging write has landed, the parser preserves positional whitespace, newlines, quotes, and backslashes byte for byte while removing recognized adapter options. This is not an end-to-end byte-exact transport because a model performs the Write step. SessionEnd removes verified staging files owned by that Claude session, and later transport creation prunes other verified staging files after one hour. Final response text comes from the bounded JSONL stream, so Codex never receives an unbounded fallback output path. Prompts, individual JSONL events, final responses, raw event ledgers, logs, and rendered diagnostics have explicit byte limits. Oversized input or output fails as `resource` before it can inflate durable state. Resume accepts only a persisted Codex thread ID or a companion-selected terminal task record. `--resume-last` is restricted to the current Claude session when its id is available and otherwise selects the newest eligible workspace task. Active jobs are never resume candidates. `--fresh` rejects combination with either resume form and forces a new thread.

## Review execution

Native review uses `codex exec review --json` with the read-only sandbox. Working tree review maps to `--uncommitted`, and branch review maps to `--base <ref>`. `--scope auto|working-tree|branch` controls target selection. A focused review and adversarial review use a normal read-only Codex turn with an explicit review contract because native review target flags do not accept a positional focus prompt.

Review completion remains a transport outcome. Fusion verifies findings independently before applying changes.

## Result contract

Human-readable terminal output ends with a contiguous footer block:

```text
codex-session: <thread-id>
job: <job-id>
state: done|error|cancelled
failure: <kind>
```

Successful output includes `state: done`. Error and cancelled output includes the corresponding `failure` line. JSON output exposes the complete persisted record without converting absent fields into zero values.

`result --wait` may wait for an explicitly detached job. If its bounded wait period expires, it returns `state: running` without claiming completion. Foreground task and review calls do not use collector polling.

## Failure kinds

The adapter uses the shared failure categories `quota`, `auth`, `missing_cli`, `rate_limited`, `timeout`, `error`, `permission`, `cancelled`, `input`, `died`, and `resource`. Protocol violations use `protocol`. A process exit caused by an unrequested signal uses `process`.

Classification uses structured Codex events first, then the process error and bounded stderr tail. Logs may retain more detail, but rendered failures expose only bounded diagnostics and never expose environment variables or authentication data.

## Compatibility

The companion checks the installed Codex version during setup and records it on every job when available. This adapter supports Codex CLI 0.144.x, which means versions greater than or equal to 0.144.0 and lower than 0.145.0. Setup also verifies CLI authentication and a writable adapter data directory. A nonempty `CODEX_API_KEY` is accepted as exec authentication when `codex login status` reports logged out because that probe does not inspect environment based authentication. Unknown JSONL event types are retained and ignored unless they affect terminal correctness. Missing or changed required lifecycle events fail closed as protocol errors.

Protocol fixtures cover every supported event type, unknown extensions, malformed JSON, failure events, missing terminal events, nonzero exits, signals, aborts, timeouts, resume, native review, cancellation, worker death, lock recovery, worktrees, and concurrent terminal writes.

## Environment overrides

- `CODEX_BIN` overrides the Codex executable for tests and controlled installations.
- `CODEX_COMPANION_DATA` overrides the data root. The value must be an absolute path, since the companion fails closed on a relative value and Fusion treats a non-absolute state-root override as unset rather than throwing.
- `CODEX_COMPANION_TIMEOUT_MS` overrides the foreground execution timeout.
- `CODEX_COMPANION_BACKGROUND_TIMEOUT_MS` overrides the detached worker timeout.
- `CODEX_COMPANION_LAUNCH_APPROVAL_TIMEOUT_MS` overrides how long an unapproved background worker waits before failing without starting Codex.
- `CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS` overrides the launch grace period.
- `CODEX_COMPANION_WAIT_POLL_MS` and `CODEX_COMPANION_WAIT_TIMEOUT_MS` control bounded result waiting.
- `CODEX_COMPANION_HISTORY_MAX_RECORDS` and `CODEX_COMPANION_HISTORY_MAX_BYTES` control managed terminal history retention.
- `CODEX_JOBS_MONITOR_SESSIONS_DIR` overrides the Codex rollout tree used by Fusion's monitor for best effort model, effort, and token observations. When it is unset, the monitor uses `$CODEX_HOME/sessions` if `CODEX_HOME` is nonempty, then `~/.codex/sessions`.
- `FUSION_CODEX_STATE` selects one Codex state root for Fusion. The compatibility alias `FUSION_CODEX_STATE_DIR` also selects one root. Either override disables default dual-root aggregation.

## Fusion integration

Codex records are the primary source for transport status, model request, reasoning effort, token usage, thread identity, Claude session identity, repository identity, and job duration. Without a state override, Fusion reads the canonical `codex-claude-code-fusion/state` root plus the old `codex-openai-codex/state` root as a read only compatibility source, then deduplicates lifecycle mirrors. It never copies or mutates the old records, and the new `/codex:result` command cannot collect an old plugin deliverable. `CODEX_COMPANION_DATA` selects only its own state root, just as the Fusion state overrides select only one root. Fusion observes those records without taking ownership of their lifecycle. Fusion keeps semantic acceptance separate. A `done` Codex job remains `unverified` until the orchestrator checks its completion criteria or verification command and records `accepted` or `rejected`.
