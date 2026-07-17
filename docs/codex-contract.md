# Codex companion contract

This document defines the Codex instance of the shared companion contract. The adapter owns orchestration, job state, process supervision, rendering, and Fusion integration. The official Codex CLI owns authentication, model execution, tool execution, sandbox enforcement, and persisted Codex threads.

## Runtime boundary

The companion invokes the user-installed `codex` binary through `codex exec --strict-config --json` and forwards `--skip-git-repo-check`. It consumes JSONL from stdout, keeps stderr separate, and stores the raw event stream for diagnosis. It does not depend on `codex-plugin-cc`, parse human-readable Codex output, or copy Codex authentication material. The JSONL stream remains the primary transport authority. A bounded read of the matching locally persisted Codex rollout may recover partial output, cumulative usage, and the actual model and effort after timeout or cancellation, but it cannot turn a failed transport into success. Codex configuration parse failures under `--strict-config`, for example an unknown `mcp_servers` field, currently surface as `failureKind: "process"` with the configuration error in the job log.

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

Each record contains the companion PID and ownership identity, Codex PID and ownership identity, Claude session ID, Codex thread ID when known, workspace root, repository identity, request settings, transport status, semantic status, delivery mode and collection state, resolved model and effort when observable, result or bounded partial result text, exact reported token usage when available, failure kind, bounded diagnostic text, and paths to its brief, log, and raw event ledger.

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

`turn.completed.usage` is cumulative for the Codex thread. A fresh thread uses a zero baseline. A resumed thread stores the reported cumulative value but marks per-turn usage unavailable because the adapter cannot prove that another Codex surface did not resume the same thread between its own jobs. It never reports cumulative usage as one turn, attributes out of band turns to the current job, or fills missing fields with zero. On timeout or cancellation, a matching local rollout may provide partial cumulative usage and output. The record marks that usage incomplete and keeps the transport failure terminal. Fusion may independently recover a per-turn delta from an exact local rollout boundary for reporting; that observation remains separate from the canonical companion token delta.

## Task execution

Consult tasks use the Codex read-only sandbox. Write tasks require `--write` and use the workspace-write sandbox. Both modes use noninteractive approval policy so an unattended exec run cannot hang on an approval request. Danger full access is not exposed by the companion.

Codex exec refuses to start outside a directory with an ancestor `.git` entry. The `projects` trust map in `config.toml` is not consulted by exec. The companion forwards `--skip-git-repo-check`, and a gate failure names that flag as the remedy. The dangerous bypass flag also skips the gate.

Every Codex exec invocation disables `multi_agent` and `multi_agent_v2`. The adapter also fails the job with `failureKind: "policy"` if the event stream or matching rollout still shows a collaboration tool call. Delegated Codex therefore remains one owned engine execution instead of recursively creating Codex agents.

The companion does not add a shell command allow list and does not rewrite the user's configured MCP servers or other Codex tools. Those integrations remain a separate Codex configuration trust boundary and may carry capabilities beyond the filesystem sandbox.

Model and reasoning effort remain unset unless explicitly requested. The Codex configuration remains authoritative for defaults. The companion explicitly sets web search to disabled and workspace-write network access to false by default. `--web` opts a read-only or write task into live Codex web search. `--network` requires `--write` and opts the workspace-write sandbox into network access.

The companion writes the final prompt to Codex stdin. Prompts are never interpolated into a shell command. Programmatic callers use `--request-stdin` and pipe the complete raw companion request through stdin, leaving fixed argv free of request bytes. Claude Code's Bash tool does not expose stdin, so slash commands and wrapper Agents retain a private token-named staging compatibility path: the command model writes the raw request through its Write tool before invoking a fixed companion command containing only that token. Once the staging write has landed, the parser preserves positional whitespace, newlines, quotes, and backslashes byte for byte while removing recognized adapter options. The staged compatibility path is not an end-to-end byte-exact transport because a model performs the Write step. SessionEnd removes verified staging files owned by that Claude session, and later transport creation prunes other verified staging files after one hour. Final response text comes from the bounded JSONL stream, so Codex never receives an unbounded fallback output path. Prompts, individual JSONL events, final responses, raw event ledgers, logs, and rendered diagnostics have explicit byte limits. Oversized input or output fails as `resource` before it can inflate durable state. Resume accepts only a persisted Codex thread ID or a companion-selected terminal task record. `--resume-last` is restricted to the current Claude session when its id is available and otherwise selects the newest eligible workspace task. Active jobs are never resume candidates. `--fresh` rejects combination with either resume form and forces a new thread.

## Review execution

Native review uses `codex exec review --json` with the read-only sandbox. Working tree review maps to `--uncommitted`, and branch review maps to `--base <ref>`. `--scope auto|working-tree|branch` controls target selection. A focused review and adversarial review use a normal read-only Codex turn with an explicit review contract because native review target flags do not accept a positional focus prompt.

Review completion remains a transport outcome. Fusion verifies findings independently before applying changes.

## Result contract

Human-readable terminal output ends with a contiguous footer block:

```text
codex-session: <thread-id>
job: <job-id>
delivery: foreground|manual|managed
semantic: accepted|rejected|unverified
state: done|error|cancelled
failure: <kind>
```

Successful transport output includes `state: done`. Error and cancelled output includes the corresponding `failure` line. Final response prose cannot mark its own result accepted or rejected, so successful Codex transport remains `semantic: unverified` until the orchestrator verifies it. The adapter uses `semantic: rejected` only for structured policy evidence such as a forbidden collaboration tool call. Later verification judgments are recorded independently by Fusion and do not rewrite the companion footer. JSON output exposes the complete persisted record without converting absent fields into zero values.

`result --wait` may wait for an explicitly detached job. If its bounded wait period expires, it returns `state: running` without claiming completion. Foreground task and review calls do not use collector polling.

## Failure kinds

The adapter uses the shared failure categories `quota`, `auth`, `missing_cli`, `setup`, `rate_limited`, `timeout`, `error`, `permission`, `cancelled`, `input`, `died`, and `resource`. Protocol violations use `protocol`. A process exit caused by an unrequested signal uses `process`. A forbidden collaboration tool call uses `policy`.

Classification uses structured Codex events first, then the process error and bounded stderr tail. Logs may retain more detail, but rendered failures expose only bounded diagnostics and never expose environment variables or authentication data.

## Compatibility

The companion checks the installed Codex version during setup and records it on every job when available. Preflight hard-fails with `failureKind: "setup"` when the installed Codex CLI version parses below the tested minimum 0.144.0 and tells the user to upgrade. Versions above the tested 0.144.x window remain allowed with the setup compatibility advisory. Setup also verifies CLI authentication and a writable adapter data directory. A nonempty `CODEX_API_KEY` is accepted as exec authentication when `codex login status` reports logged out because that probe does not inspect environment based authentication. Unknown JSONL event types are retained and ignored unless they affect terminal correctness. Missing or changed required lifecycle events fail closed as protocol errors.

Codex CLI 0.144.4 requires `supports_reasoning_summaries` in `models_cache.json` without a serde default. Codex 0.145.0 alpha releases renamed the field to `supports_reasoning_summary_parameter` and added a default. A newer generation binary sharing `CODEX_HOME`, including ChatGPT.app's bundled codex-cli 0.145.0-alpha.18 at `Contents/Resources/codex`, can rewrite the cache in the new schema. A 0.144.4 exec session then logs non-fatal `failed to renew cache TTL: missing field` messages on each etag renewal. Startup refetch self-heals the file. The durable fix is version alignment among all Codex binaries sharing the same `CODEX_HOME`.

Protocol fixtures cover every supported event type, unknown extensions, malformed JSON, failure events, missing terminal events, nonzero exits, signals, aborts, timeouts, resume, native review, cancellation, worker death, lock recovery, worktrees, and concurrent terminal writes.

## Environment overrides

- `CODEX_BIN` overrides the Codex executable for tests and controlled installations.
- `CODEX_COMPANION_DATA` overrides the data root. The value must be an absolute path, since the companion fails closed on a relative value and Fusion treats a non-absolute state-root override as unset rather than throwing.
- `CODEX_COMPANION_TIMEOUT_MS` overrides the foreground execution timeout.
- `CODEX_COMPANION_BACKGROUND_TIMEOUT_MS` overrides the detached worker timeout.
- `CODEX_COMPANION_BACKGROUND_DELIVERY=managed` marks a detached job as owned by an internal collector. Unset explicit background jobs use manual delivery.
- `CODEX_COMPANION_LAUNCH_APPROVAL_TIMEOUT_MS` overrides how long an unapproved background worker waits before failing without starting Codex.
- `CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS` overrides the launch grace period.
- `CODEX_COMPANION_WAIT_POLL_MS` and `CODEX_COMPANION_WAIT_TIMEOUT_MS` control bounded result waiting.
- `CODEX_COMPANION_HISTORY_MAX_RECORDS` and `CODEX_COMPANION_HISTORY_MAX_BYTES` control managed terminal history retention.
- `CODEX_JOBS_MONITOR_SESSIONS_DIR` overrides the Codex rollout tree used by Fusion's monitor for best effort model, effort, and token observations. When it is unset, the monitor uses `$CODEX_HOME/sessions` if `CODEX_HOME` is nonempty, then `~/.codex/sessions`.
- `FUSION_CODEX_STATE` selects one Codex state root for Fusion. The compatibility alias `FUSION_CODEX_STATE_DIR` also selects one root.
- `FUSION_CODEX_INCLUDE_LEGACY=1` explicitly adds the preserved `codex-openai-codex/state` root to Fusion reporting. Current canonical state is the default.

## Fusion integration

Codex records are the primary source for transport status, delivery, semantic status, model request, resolved model and effort, token usage, thread identity, Claude session identity, repository identity, and job duration. Without a state override, Fusion reads only the canonical `codex-claude-code-fusion/state` root. The old `codex-openai-codex/state` root is included only through `/fusion:stats --include-legacy` or `FUSION_CODEX_INCLUDE_LEGACY=1`, is always read only, and is never copied or mutated. The new `/codex:result` command cannot collect an old plugin deliverable. `CODEX_COMPANION_DATA` selects only its own state root, just as the Fusion state overrides select only one root. Fusion observes those records without taking ownership of their lifecycle. A `done` Codex job remains `unverified` until the orchestrator checks its completion criteria or verification command and records `accepted` or `rejected`. `/fusion:stats --record-acceptance` writes that verdict through the companion's `record-acceptance` subcommand. Marking a job accepted after transport failure requires the explicit `--accept-failed-transport` override, and the stats report exposes acceptance anomalies.

`/codex:history` reads all workspaces from the canonical companion state root and shows job ids, thread ids, transport, delivery, semantic status, and resolved model and effort. Codex exec threads are also persisted in the local Codex session store and remain resumable by thread id. Codex Desktop filters its normal task list by interactive source kinds, so exec sourced threads are not guaranteed to appear in its sidebar.
