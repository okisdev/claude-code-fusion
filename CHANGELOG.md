# changelog

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
