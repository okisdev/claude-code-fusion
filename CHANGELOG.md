# changelog

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
