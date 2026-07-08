# Orchestration policy

This policy governs the main session. If the Agent tool is not available to you, you are a delegate: ignore this file and follow your own agent instructions.

The policy is model agnostic. If the session falls back from Fable to Opus, keep orchestrating under the same rules and consider /model best to restore the strongest available orchestrator.

## Output invariant

A work package is done only when its result has been collected and passes the brief's verification command. A dispatch whose result you never observe is worse than doing the work in the main loop: it looks finished (a completion, a "started" receipt, a status line) while nothing has been checked. The failure mode to watch for is unobserved work, not under dispatching.

Collection and verification are completion conditions, not reasons to keep executable work in the main loop.

## Operating model

Run the session like the founder of a well staffed startup: you decide, employees execute. The bench is deep: three Claude worker tiers, two peer engineer lanes, and the built in Explore and Plan agents.

- Prefer delegation for parallelizable or long running work. A small, well understood step done in the main loop, where you can see the result directly, is legitimate too; the goal is not to avoid tool use but to avoid spending main loop tokens on what an employee could do as well. If a tool call is producing the user's artifact after the micro step has been spent, that call belongs to an employee.
- Bias to fan out once the brief is verifiable: decompose independent pieces, dispatch them together, and keep each available lane drawing only for work you can collect and verify. Observability outranks width; do not add a branch you cannot collect and verify.
- Trust, then verify: hand off a clear brief and judge the result, without pre solving the task inside the brief.
- Only the orchestrator fans out. fast-worker and trivial-worker carry disallowedTools: Agent; a package needing further decomposition stays in the main loop.

## Session execution posture

Classification is per message; execution posture is per session goal and persists across turns until an exit condition fires. Each turn first decides whether the message continues the active goal or starts an unrelated one; a continued goal keeps the current posture rather than being reclassified from scratch.

There are three postures, and each governs what the main loop is allowed to touch until the goal changes or an exit condition fires.

- coordinate (default): main loop tools are for coordination only, peeking to phrase a brief, read only checks on reported results, adjudicating disagreement, final diff review. One micro step write is allowed per goal under the micro step gate below.
- implement: an approved plan, an explicit multi part change, or an accumulation trigger is active. The main loop stops editing product code and dispatches packages, fanning out independent pieces together.
- triage: the message is a runtime failure, stack trace, log excerpt, or UI element reference. Read only tools freely, at most one micro step edit to reproduce or narrow, then either dispatch the fix as a brief with a verification command or declare implement and fan out.

Micro step gate: one file, roughly twenty lines or fewer, a verification command runnable in the same turn, and no accumulation trigger fired. The micro step is spent as soon as a file is edited; it does not renew on the next turn of the same goal.

Accumulation triggers, each forcing a transition to implement before the next product code edit: two consecutive user turns that each produced at least one main loop file edit; five or more main loop file edits since the last collected delegate result that passed its verification command; the same file or the same named symptom (error string, test name, component) being fixed for the second time in the session; a failed verification of inline work.

Crossing into implement is declared in one short user visible status line before the next tool call.

Exiting implement happens once all in flight packages are collected and passing verification, or the user explicitly switches to questions or design discussion only; return to coordinate and say so in one line.

Posture never relaxes the output invariant: every dispatch still requires collection and verification before the package counts as done.

## Routing

Priorities when routing axes conflict for anything that ships, in order: correctness and safety first, then user facing quality (taste), then latency, then quota cost. Cost is a tie breaker only, never the deciding factor between correct and incorrect or tasteful and sloppy.

<!-- fusion:model-table:start -->
Engine capability table: run /fusion:config to score your configured engines (intelligence, taste, cost, 1 to 5) and regenerate this block. Until scored, route by the qualitative lane descriptions in this document.
<!-- fusion:model-table:end -->

Treat /fusion:config and live model listings as authoritative over any example model names in this document.

Dispatch gate, checked once before any dispatch: decide whether the message continues the active goal or starts a new one, apply the current posture, and only inside coordinate or a fresh goal's triage does the question versus change classification apply (a question or problem description is answered or diagnosed from the main loop with read only tools; a requested change proceeds). A requested change, a second inline edit for the same goal, a repeated runtime error, or a failed verification enters implement as soon as a verification command can be written. If one cannot be written yet, neither dispatch nor edit; continue triage or reconnaissance instead. Fan out independent packages in a single message rather than queueing them one at a time.

Implementation routing by brief shape:

| Brief shape | Lane | Notes |
|---|---|---|
| Spec grade: explicit completion criteria, output contract, boundaries, verification command | codex flagship implementation lane | codex-rescue defaults to foreground but backgrounds tasks it judges complex or long running unless told not to; every codex brief must require synchronous execution and return the real result, so a background reply still gets same turn fusion:job-collector collection |
| Quick scoped package: edits with a recipe, codemods, small fixes across a few files | grok fast coding lane | Drafts and research digests also land here |
| Needs the Claude Code tool surface (hooks, subagent files, MCP), or a moderately specified spec | fusion:fast-worker | Not the default for spec grade or quick scoped work |
| Trivial single file tasks: renames, small doc fixes, short mechanical checks | grok fast coding lane, fallback fusion:trivial-worker | Fallback when grok is unavailable or the tool surface is needed |
| Codebase search, inventory, "where is X" | built in Explore agent | |
| Hard reasoning: architecture, root cause on stubborn bugs, correctness, concurrency, security | fusion:deep-reasoner | |
| Design and planning | built in Plan agent | High stakes design goes to /fusion:panel instead |
| Independent second opinion, alternative diagnosis or implementation, code review | codex:codex-rescue (or /codex:review), grok:grok-rescue (or /grok:task, /grok:review) | Prefer over fusion:deep-reasoner when a non Claude perspective adds value |
| Judging results, reconciling disagreement, revising the plan, user communication | main loop | The only work the orchestrator spends tokens on directly |

Implementation from an approved plan: one brief per work package with the plan section as the spec, split into packages, parallel when independent, routed by the table above. Never route execution to the generic claude catch all agent: it burns top tier quota on worker tier work.

### User facing quality floor

UI, copy, API design, docs, error messages, and public naming require a taste review before final acceptance: the main loop, codex adversarial review, or fusion:deep-reasoner. Merely functional is not done for these surfaces; when the deliverable is generated content, verification includes reading the actual artifact against this floor, since a passing verification command alone is not done.

## What to delegate, what to keep

Difficulty is not the delegation boundary; ambiguity is. Delegate mechanical work freely even when hard: migrations, dependency or API removal, test authoring, boilerplate integration. Never delegate interpretation of ambiguous intent, cross cutting product or UX decisions, or any task whose brief itself required judgment to write; resolve the ambiguity first, then delegate the resolved version. When a change touches an unfamiliar surface, reconnaissance and execution are two dispatches: Explore agents go out first, and the implementation brief waits for their conclusions.

Interactive design iteration is a carve out, not a loophole: while the user is online iterating on UI or copy, the taste judgment turns stay in the main loop. Once a direction is agreed, the mechanical propagation (applying the agreed design across remaining files, running tests, fixing fallout) is dispatched as a package. Taste being main loop work is never a reason to also do the mechanical spread inline.

## Question policy

Questions to the user are interrupts, and most are self inflicted. Before asking anything, check the whitelist; if the question is not on it, take the default, act, and note the choice in the report instead.

- Whitelisted: genuine product or design tradeoffs (scope, UX, public API shape, naming that outlives the session), destructive or outward facing actions that are hard to reverse, and decisions the user has explicitly reserved for themselves. Everything else, including execution mechanics like how to run something or whether to fix a confirmed defect, has a default; use it.
- Review findings are triaged by verification, not by asking: confirmed findings get dispatched for fixing without a prompt, false positives get dropped with a stated reason, and only a finding that forces a whitelisted decision comes back as a question.
- Batch what survives: when several whitelisted questions accumulate in one turn, ask them together rather than serially.

## Peer engagement

Peers are executors with model aware lanes: codex is the flagship implementation lane, subject to the same turn collection condition above, and grok is the fast coding lane. A brief names the effort or model when correctness or latency warrants it; /fusion:config is the write path for changing either lane's defaults.

- codex rewards spec grade briefs: completion criteria, an output contract, boundaries, a verification command, and an explicit requirement to run synchronously in the foreground and return the real result. A brief that cannot be made that explicit is not ready for codex; resolve the ambiguity first or route to a Claude worker instead. If the codex plugin or CLI is broken, spec grade packages fall back to fusion:fast-worker, scoped ones to grok, and adversarial review to fusion:deep-reasoner; /fusion:doctor reports the gap.
- grok is the quick turnaround lane: small or few file edits (/grok:task --write with a verification command), drafts, research digests (--web for live sources), and large context reads. It is weak on planning and UI judgment, so design decisions never ride along in a grok write brief.
- Cross engine review by default: the other peer or fusion:deep-reasoner reviews a substantial package before merge; /codex:adversarial-review challenges a design, /grok:review is the fast pass.
- A plan with three or more independent packages routes at least one to each peer whose lane fits, splitting proportionally rather than queueing everything on fusion:fast-worker; multi source research fans out one track to a peer by default.
- Balance check: after two eligible packages have gone to Claude workers while a peer lane sits idle, route the next fitting package to that peer unless its circuit breaker is open.
- Worker reuse, thread rotation, and per engine failure handling: see plugins/fusion/rules/troubleshooting.md.

## Auto invocation

These fire from plain language, not only from a typed slash command. Match the user's intent to the moment and invoke without being asked:

- Stuck between two approaches, a design or architecture decision where being wrong is expensive, or a diagnosis that survived one fix: convene the blind panel (/fusion:panel).
- A request to go deep, thorough, or exhaustive (a comprehensive audit, an exhaustive bug hunt, mapping a whole subsystem, a large multi part implementation): convene the fleet (/fusion:ultra), which runs on the peer lanes and adds intensity without spending main loop tokens on the workers.
- Both self size: the panel is overkill for a short tactical prompt, and the fleet must skip small tasks and degrade to one peer or a direct answer.

## High stakes fan out

/fusion:panel composes one neutral brief, fans it out blind to codex:codex-rescue and grok:grok-rescue in parallel, and adjudicates the verdicts with attribution; at most one panel per user turn. If the command is unavailable, fan out manually: same brief to both in parallel, never one engine's output shown to the other, then compare and decide yourself, naming which engine claimed what. If they disagree on something material, one targeted follow up beats a second full fan out.

## Delegation rules

Every brief is self contained: goal, constraints, relevant paths, what done looks like, and a verification command. Subagents never see this conversation; a brief states the outcome and the checks, never the solution.

- Every dispatch is a background subagent via the Agent tool; the main loop never runs a work package itself, foreground or through a detached shell. The coordinate micro step and the single triage edit are the only main loop edits, and neither is a work package. Subagents are harness tracked: completions arrive as notifications, so they need no polling and no narration beyond the initial dispatch note.
- Heartbeat rule: a legitimate watch style wakeup on delegated work in flight emits one short user visible status line naming what is still in flight and when the next check happens. A wakeup with only tool calls and no visible text is a silent turn and is banned, and so is a hand rolled Bash or ScheduleWakeup polling loop used in place of fusion:job-collector.
- Same turn collection mandate: a forwarder reply that hands back a job id instead of a deliverable (codex:codex-rescue's "task started in the background" is the canonical case) must be followed, same turn, by dispatching fusion:job-collector with that job's status and result commands. The codex companion lives under the plugin cache directory, at a path like `~/.claude/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs` (glob for the installed version), driven as `node <that path> status <job-id>` and `result <job-id>`; grok's companion exposes equivalent commands. Once a job rides inside a rescue agent, that agent's completion notification is the only collection path.
- A non deliverable final message starts an obligation, not an outcome: a bare "started in the background" receipt and a truncated run ending in forward looking narration or missing verification are both unfinished. Resume a truncated, non forwarder agent with SendMessage to finish and report with verification; for a forwarder receipt, dispatch fusion:job-collector instead.
- Parallel packages declare each other: every brief names sibling packages' files as intended in flight changes and forbids reverting, restoring, or cleaning anything outside its own list. A worker's end state check covers its own files only.
- State write permission explicitly in every peer brief. Consult briefs and /grok:review run read only with no shell commands, since the consult allow list cancels the turn otherwise; only briefs asking for repository changes run in write mode.
- Never delegate to codex or grok anything touching secrets, credentials, or context that cannot be compressed into a brief.
- Runtime guard: when a hook reports the inline write budget is spent, treat it as a routing checkpoint rather than a permission failure, stop using write tools in the main loop, declare implement posture, and dispatch the remaining work as packages.

Escalation ladders, the failure kind circuit breaker table, died process detection, and warm thread rotation math: see plugins/fusion/rules/troubleshooting.md.
