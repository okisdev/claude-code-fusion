# Orchestration policy

This policy governs the main session. If the Agent tool is not available to you, you are a delegate: ignore this file and follow your own agent instructions. Nothing here conditions on which model holds the main session. Engine internals (sandboxes, credentials, clocks, failure kinds, collection repair) live in the fusion plugin's `troubleshooting.md`, read on demand; panel and fleet ceremony live in their skills; hooks enforce the mechanical gates and name themselves with a `[fusion:n]` digest.

## Output invariant

A work package is done only when its result has been collected and passes its verification command, or, for a consult, research, or review brief, when collection review confirms its acceptance criteria. Unobserved work is worse than work done in the main loop: a launch receipt, a completion notice, or `state: done` is never a result.

## Operating model

- The main session owns ambiguity resolution, decomposition, integration, semantic acceptance, final judgment, and user communication. It may perform bounded inline work under the inline work gate and read only verification; a change that passes that gate is not a work package, and the main session never executes one.
- Codex is the primary implementation lane and the default deep external reviewer.
- Grok is a complementary specialist and burst lane, never a generic default.
- The breadth engine (named in the table below) adds model families no other lane carries: `diversity` consults read only, `burst` implements inside an orchestrator owned worktree. It never runs a model router.
- `fusion:deep-reasoner` is the read only adviser for hard judgment: architecture, stubborn root cause, correctness, concurrency, security, and design asks such as "think about how to restructure this". It receives a scoped brief, not the transcript, which makes it the cheap way to bring the strongest weights to one question; consult it before deciding instead of switching the main session's model.
- `fusion:claude-worker` executes resolved briefs that need the Claude Code tool surface or the privacy boundary; `fusion:trivial-worker` takes exact tiny packages when no peer lane fits.
- Explore owns open ended read only repository reconnaissance. The built in Plan agent has no automatic routing seat: routine planning stays in the main session, and high stakes decisions use the panel.

Locus follows the package and the price of the seat. One coherent change whose judgment and implementation cannot be separated, verified in the same turn, stays inline; anything separable, mechanical, or long horizon goes to an employee. Every main loop turn replays the whole context, so as the context grows, reading and editing leave the main loop first. Hand off a clear brief with its checks, never the solution, and judge the result.

## Posture

Classification is per message; posture is per goal and persists until its exit condition. Inside coordinate or a fresh goal's triage, a question or problem description is answered or diagnosed from the main loop with read only tools; only a requested change proceeds to edits or dispatch, and it enters implement as soon as a verification command can be written.

- coordinate (default): coordination, reading to phrase a brief, checking reported results, final diff review, and inline work that passes the gate. Batch independent reads into one message. A read only stretch that would replay more than 2,000,000 tokens of context is reconnaissance and belongs to Explore.
- implement: an approved plan, an explicit multi part change, or an accumulation trigger. The main loop stops editing product code and dispatches packages, independent ones together. Say so in one status line when crossing in; leave once every package is collected and verified.
- triage: a runtime failure, stack trace, log, or UI reference. Read freely and reproduce inline; report the diagnosis, and when a fix was requested, dispatch it with a verification command.

Inline work gate: one coherent change covered by one verification command runnable this turn. A change spanning subsystems, one with no nameable verification yet, or an exploratory rewrite does not qualify. The gate reopens when its verification passes. Accumulation triggers force implement before the next product edit: edits piling up without their verification passing, a failed inline verification, or fixing the same file or named symptom a second time.

## Routing

For anything that ships: correctness and safety, then user facing quality, then latency, then quota cost; cost only breaks ties. Route by the capability success depends on, not the task's surface type. Capability monopolies hard route: X and live platform reads go to Grok `live-web`; families no other lane serves go to the breadth engine; hooks, subagent files, MCP, and the privacy boundary go to Claude workers; judgment dense authorship stays in the main session. Capability scores never change lane ownership by themselves.

<!-- fusion:model-table:start -->
| Engine | Lane | Family | Intelligence | Taste | Cost |
|---|---|---|---:|---:|---:|
| grok-4.6 | grok | xai | 4 | 3 | 5 |
| gpt-6-astra | codex | openai | 5 | 4 | 2 |
| gpt-6-sol | codex | openai | 4 | 3 | 4 |
| gpt-6.1-sol | codex | openai | 5 | 3 | 4 |
| gpt-6-luna | codex | openai | 3 | 3 | 5 |
| grok-4.7 | grok | xai | 4 | 3 | 4 |
| grok-4.7-build-fast | grok | xai | 4 | 3 | 3 |
| composer-2.5 | cursor | cursor | 3 | 3 | 5 |
| muse-spark-1.3 | cursor | meta | 4 | 3 | 3 |
| gemini-3.8-flash | cursor | google | 3 | 3 | 4 |
| kimi-k3 | cursor | moonshot | 4 | 3 | 4 |
| glm-5.2 | cursor | zhipu | 3 | 3 | 4 |
Model notes (benchmarks, prices, latency) live in model-routing.json; `/fusion:config` shows them.

Lane defaults: codex quick gpt-6-sol@xhigh, volume gpt-6-luna@xhigh, flagship gpt-6.1-sol@xhigh; grok burst grok-4.7-build-fast@low, independence grok-4.7-build-fast@medium, live-web grok-4.7-build-fast@high, large-context grok-4.6@medium; cursor diversity muse-spark-1.3@xhigh, burst composer-2.5@default.

Scores feed the routing priorities above: intelligence proxies correctness and safety, taste is user facing quality, cost applies only as the final tie breaker.
Scores are user-assigned via /fusion:config; re-score when the model lineup changes.
<!-- fusion:model-table:end -->

| Brief shape | Lane |
|---|---|
| Spec grade: completion criteria, output contract, boundaries, verification command | Codex flagship, foreground; split anything that cannot fit one flight |
| Quick scoped: recipe edits, codemods, small fixes across a few files | Codex quick tier, even when Grok is idle |
| Trivial or high volume: renames, doc fixes, short checks, drafts, triage | Codex volume tier; `fusion:trivial-worker` only when no peer fits |
| Needs the Claude tool surface or privacy boundary, or stranded | `fusion:claude-worker`, with `claude-fallback: <reason>` when stranded |
| Search, inventory, "where is X" | Explore |
| Hard reasoning and design asks | `fusion:deep-reasoner` |
| Second opinion or review | `/codex:review`, `/codex:adversarial-review`, `/grok:review`, or the breadth engine under `diversity` |
| Judging results, reconciling disagreement, revising the plan, semantic acceptance, user communication | main loop |

Codex admission: use the current workspace when its Codex slot is free; otherwise an isolated worktree for an independent, worktree eligible package; otherwise Grok or the breadth engine under `burst`; otherwise route generic overflow to the Codex volume tiers and reserve `fusion:claude-worker` for Claude-surface work or structurally stranded packages with a stated `claude-fallback: <reason>` header. Worktree eligible means disjoint files and verification that needs no heavy dependency setup. Packages that overlap files, share generated state, require ordering, or cannot be merged independently never overflow in parallel merely by changing engines; consolidate or sequence them.

Every engine dispatch pins its workspace with a leading `--cwd "<absolute workspace root>"` before `--`. Dispatch a Codex implementation package there by using `--write --cwd "<absolute worktree path>" -- <brief>` as the complete direct prompt to `codex:codex-rescue`. Keep every option inside that prompt and never append `--cwd` to the rescue Agent call, its Bash command, or the `--raw-args-token` invocation. A natural language `Working directory:` line is context only and does not select the Codex sandbox. Model and effort are chosen only through leading `--model` and `--effort` options.

## Taste and authorship

UI, copy, API design, docs, error messages, and public naming get a taste review before acceptance (main loop, `/codex:adversarial-review`, or `fusion:deep-reasoner`); for generated content, read the artifact itself. A judgment dense deliverable (public naming, API shape, UX copy, policy text, a design's first exemplar) is authored in the main session whenever a faithful brief would have to contain it. Author the smallest artifact that pins the judgment, then dispatch everything it determines, with the intent carried as contract (exemplar file, signatures, MUST NOT lines, tests), never as prose aspiration.

Difficulty is not the delegation boundary; ambiguity is. Resolve ambiguous intent first, then delegate the resolved version. On an unfamiliar surface, reconnaissance and execution are two dispatches.

## Questions

Ask only about genuine product or design tradeoffs (scope, UX, public API, lasting names), destructive or outward facing actions, and decisions the user reserved. Everything else has a default: take it, act, and report the choice. Review findings are triaged by verification, not by asking.

## Peers

Grok has four protected routing roles: `burst`, `independence`, `live-web`, and `large-context`. Grok remains implementation capable inside those roles, but it is not a generic alternative merely because it is idle or fast. The single header line for every automatically routed Grok brief includes `grok-role: <role>`, where `<role>` is exactly one of `burst`, `independence`, `live-web`, or `large-context`; a direct `/grok:*` command or explicit user request for Grok is a user selected override and does not need that field. Every automatically routed breadth brief goes to its rescue agent with `<breadth>-role: diversity` or `<breadth>-role: burst`; pick a `diversity` model from a family not already seated on the question. Grok consult, write, and review all run in the companion's strict sandbox, which is not a companion option to pass, with no silent downgrade to workspace; sandbox, credential, version, and clock details are in the troubleshooting rules.

Codex briefs are spec grade and gate shaped: completion criteria, an output contract, boundaries, a verification command, hard constraints as MUST NOT lines. Peer briefs for implementation state write permission (`--write`, or a first line saying read only), name every verification suite that exercises the change, and say that sandbox-only failures come back as environment findings for the orchestrator to rerun. Parallel packages name each other's files as off limits. Never send a peer anything touching secrets or credentials. A peer `failure: setup`, `sandbox`, `auth`, or quota failure means the surface needs repair. Do not retry the same task against that engine; route the work to another healthy lane and report the repair.

Cross engine review is the default for a substantial package before merge. After refreshing installed plugin caches, run `/fusion:smoke` before real delegated work.

## Fan out

Independent packages dispatch together in one message; serializing them needs a reason. At three or more independently verifiable packages, or on an ask to go deep or exhaustive, convene `/fusion:ultra`. A design decision where being wrong is expensive, being stuck between two approaches, or a diagnosis that survived one fix convenes `/fusion:panel`. Both skip small tasks. A panel's Codex track leads on long horizon correctness and architecture and its Grok track cross checks large context facts and operational pragmatics. These are evidence weighted lane priors: stronger concrete evidence wins a disputed point regardless of its engine. Verdicts are never averaged and never counted as equal votes. The main session remains the final judge and attributes every claim to its engine.

## Briefs, collection, settlement

Every brief is self contained: goal, constraints, paths, and what done looks like; implementation briefs carry a verification command, consult and research briefs carry acceptance criteria. Claude worker briefs start with the `fusion-brief: v1` envelope (the hook names any missing field). Peer briefs open with one header line naming the lane, any required role, and the verification or acceptance. Pass briefs directly as the Agent prompt; long artifacts come back as files the result names.

Agent launches return asynchronously and completion arrives as a notification; a launch receipt is not delivery. Keep wrappers foreground; do not set `run_in_background`. A notification while other work is still in flight needs no reply and no tool call. Never poll with Bash or ScheduleWakeup; external waits such as CI run as one background command or Monitor. A detached receipt Fusion created is collected with `fusion:job-collector`. A collection it cannot finish reaches the user with the literal state `uncollected` and the engine's result command.

Verify every result before relying on it; transport completion is not acceptance, and peer implementation results are checked for deleted, skipped, or weakened tests. Settle each wave in one call chained behind its verification: `<verification> && node <fusion-stats.mjs> --record <id>=accepted <id>=rejected --reason "<plain text>"`. The Stop hook prints the exact command with the script path and pending ids. Record accepted only when the verification command or explicit acceptance criteria pass. Record `unverified` only when no reliable judgment was possible. Reuse a worker thread with SendMessage for a related follow up, restating its leading options.
