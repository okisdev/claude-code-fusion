# changelog

## 0.0.10

- model aware peer lanes: codex is now the primary implementation lane (the current GPT 5.x flagship, spec grade briefs with explicit completion criteria, output contract, boundaries, and a verification command); grok is the quick turnaround lane (Composer 2.5 Fast by default) for small fixes, drafts, research digests, and large context reads; trivial single file tasks now default to grok, with fusion:trivial-worker as the fallback
- new /fusion:config command reads local model configuration across engines, enumerates available models, and changes defaults interactively
- /fusion:ultra facet routing: codex takes implementation and adversarial facets with spec grade briefs; grok takes high volume facets, research digests, and scoped fixes
- /fusion:doctor gains a peer engine defaults check (model keys from each CLI config, never the full files) and points at /fusion:config and `grok models` for remediation
- the codex prerequisite is explicit: codex@openai-codex powers the implementation lane, the rules document per call model and effort overrides (including the spark alias) and the fallback routing when the plugin is absent, and /codex:adversarial-review becomes the named cross engine review command

## 0.0.9

- rules sync is automatic: a SessionStart hook compares the installed ~/.claude/rules/orchestration.md against the plugin's canonical copy and a manifest of every released version's hash; a missing file is installed, a file matching any released hash is safely updated (provably never hand edited), and unknown content is never touched, with a one line notice pointing at /fusion:setup to reconcile. /fusion:setup narrows to first install permission checks and local edit reconciliation, and a guard test fails the suite when the rules change without regenerating the manifest
- routing policy gains the pre dispatch side: classify the user's message before any dispatch (questions and problem descriptions are handled in the main loop with read only tools, executors go out only for actual change requests); reconnaissance and execution are two dispatches on unfamiliar surfaces; and the verification command becomes the dispatch gate, with the main loop owning what to do and how to verify while the worker owns how to implement

## 0.0.8

- routing policy: worker reuse is scoped and rotated. a follow up goes to the same worker only when it touches the same files or surface as its previous brief; new packages, different surfaces, and parallelizable work get fresh agents; after about three follow up resumes or when notifications show usage nearing the context window, rotate to a fresh worker whose brief carries the accumulated decisions (observed live: one ui worker reached 78 percent of its window after five follow up resumes). truncation resumes count toward rotation and the same discipline applies to grok --resume-last threads

## 0.0.7

- worker turn caps are runaway breakers, not task size estimates: fusion:fast-worker goes from 30 to 120 turns and fusion:deep-reasoner from 40 to 80, after four fast-worker packages in one day exhausted the 30 turn cap mid implementation and their dangling progress narration was reported as the final result; fusion:trivial-worker stays at 15 by design, since exhausting it means the task was routed wrong
- routing policy: truncation is not completion. a worker result that ends in forward looking narration or lacks the verification output its brief demanded is treated as a truncated run and resumed with SendMessage to finish and re-report, instead of being read as a final report
- public benchmark scaffolding: bench/METHODOLOGY.md defines the claims under test (C1a Claude tier quota displacement, C1b peer offload increment, C2 wall clock compression, C3 typed failure surfacing scoped to the tested grok contract) with condition isolation, pre registered task manifests, verifier isolation with mutant self tests, a fixed exclusion enum, and a publication gate; the draft went through a blind two engine adversarial panel and every blocking finding was folded in
- the harness ships alongside it: run.mjs (isolated CLAUDE_CONFIG_DIR per condition, verifiers run outside the model visible worktree, token accounting by model and role from transcripts), a strict run record schema, summarize.mjs (pass matrix, median and IQR, refuses to compare snapshots from different task manifests), manifest.mjs (content hashed task registration), redact.mjs (path and credential scrubbing), and the first task T01-seeded-bug with a mutant self test; 12 new tests, suite at 60
- no results are published yet and the README says so: the task pool holds 1 of the planned 8 to 12 tasks, so no snapshot passes the methodology's own publication gate; in tree results stay lean (runs.jsonl, env.json, summary) with full redacted transcripts attached to releases instead of committed to the tree

## 0.0.6

- permission failure kind: a consult mode run whose tool call fell outside the allow list was reported as done with empty or partial output, because the grok CLI cancels the whole turn and exits 0 with stopReason Cancelled; the companion now detects that shape across the foreground, background, review, and stop gate paths and converts it to state: error, failure: permission with guidance to re-dispatch with --write or rewrite the brief (observed live: research briefs calling gh api died silently twice in a row)
- consult mode allow list gains read only gh subcommands (pr view/list/diff/checks, issue view/list, repo view, search, run view/list, release view/list); gh api stays write mode only since it can send mutating requests with the user's credentials
- GROK_CONSULT_ALLOW appends comma separated extra allow rules to consult mode per machine; deny rules still beat them and write mode ignores the variable
- routing policy: permission does not break the engine in the circuit breaker; re-dispatch the same brief once with --write when repository changes are acceptable, otherwise rewrite the brief to avoid shell commands

## 0.0.5

- the routing policy is rewritten around an operating model: the orchestrator runs the session like a founder with a paid bench, biases to fan out (five or more concurrent delegations is a normal state, under dispatching is the failure mode), keeps every engine drawing, and trusts then verifies instead of hovering; grok is named the fast lane and codex the deep lane
- peer engagement policy: peers are executors, not just reviewers. plans with three or more independent packages route at least one to a peer, multi source research fans one track to a peer by default, and a per session balance check shifts the next eligible package to an idle peer (motivated by observing sessions where codex and grok barely participated while claude workers took everything)
- auto invocation: the panel and the new fleet fire from plain language, not only a typed slash command. /fusion:panel's description is trigger shaped, and a new rules section maps natural language moments to both without the user typing a slash
- /fusion:ultra: the peer engine answer to ultracode. asking to go deep, thorough, or exhaustive fans the work out as a fleet of parallel Grok and Codex agents (6 to 8 facets by default, up to about 12), billed to their own subscriptions, then synthesized into one deliverable; a size gate skips the fleet for small tasks
- /grok:task gains --web, which re-enables grok's web tools for research briefs (they stay disabled for code work); grok-rescue's description now claims implementation packages and research digests first instead of introducing itself as a second opinion

## 0.0.4

- /fusion:stats aggregates delegation counts across both the grok and codex peers (grok via its stats subcommand, codex read best effort from its plugin job state), degrading each engine section independently when a peer is absent; token usage still lives with each vendor
- routing: implementation from an approved plan goes to fusion:fast-worker as one brief per work package, split rather than bundled, never to the generic catch-all agent; ordinary design uses the built in Plan agent while high stakes designs go to the panel
- fusion:fast-worker claims approved plan implementation in its description so it competes for that moment instead of ceding it to the catch-all (observed live: bundled phases went to the catch-all on the orchestrator's model while a single scoped package correctly went to fast-worker)

## 0.0.3

- readme and docs aligned with what the code actually enforces: billing wording softened, the safety model split into runtime enforced vs prompt requested, provenance anchors added to third party claims (grok 0.2.16, Claude Code 2.1.x)
- every companion job outcome now carries machine parseable state and failure lines, including spawn failures and cancellations (session end cancellations get failureKind cancelled)
- best-of-n rejects values outside 2 to 10 instead of forwarding any positive integer
- untracked files documented as reaching reviews by name only; timeout ladder and environment overrides documented in docs/grok-contract.md
- namespaced agent references (fusion:deep-reasoner and peers) unified across docs, rules, and the compaction hook; marketplace and plugin metadata unified under one author and description set
- added .gitignore, CI workflow, SECURITY.md, and this changelog

## 0.0.2

- tier agents and routing rules ship inside the fusion plugin; /fusion:setup installs the rules and /fusion:doctor audits drift, replacing install.sh
- stop gate parses BLOCK verdicts behind preamble lines; consult mode denies write tools even against inherited permission allows
- uniform state footer line on job outcomes; MIT license; readme rewritten around quick start

## 0.0.1

- initial release: grok plugin (companion runtime, background jobs, review, best-of-n, stop gate) and fusion plugin (panel, doctor), with the plain config orchestration layer
