# Lane snapshot 2026-10-13

One machine (macOS 27.0, Node 24.21), plugins at 0.0.63, codex-cli 0.162.1, grok 1.0.52, Cursor Agent CLI 2026.10.01-e373342, task manifest `e0d1c683`. Every attempt is in `runs.jsonl`; `env.json` pins the environment. Diffs and consult answers stay out of the tree as the methodology requires.

## Burst lanes

Write mode, three repetitions per lane and task, each lane on its routing default. Input tokens follow each engine's own accounting: Cursor reports cache reads separately, while Codex input includes cached tokens.

| Task | Lane | Passed | Median wall clock | Median input tokens | Median output tokens |
|---|---|---:|---:|---:|---:|
| T05 mechanical codemod | composer-2.5 | 3 of 3 | 68 s | 39,681 | 3,022 |
| T05 mechanical codemod | composer-2.5-fast | 3 of 3 | 61 s | 34,886 | 3,058 |
| T05 mechanical codemod | gpt-6-luna xhigh | 3 of 3 | 106 s | 117,696 | 2,963 |
| T06 plan shaped fixes | composer-2.5 | 0 of 3 | 61 s | 21,387 | 1,521 |
| T06 plan shaped fixes | composer-2.5-fast | 0 of 3 | 56 s | 28,531 | 1,946 |
| T06 plan shaped fixes | gpt-6-luna xhigh | 3 of 3 | 105 s | 113,135 | 3,921 |
| T09 style fidelity | composer-2.5 | 3 of 3 | 75 s | 38,176 | 3,527 |
| T09 style fidelity | composer-2.5-fast | 3 of 3 | 60 s | 37,538 | 3,148 |
| T09 style fidelity | gpt-6-luna xhigh | 3 of 3 | 131 s | 129,270 | 6,493 |

Every Composer T06 attempt fixed all three packages but parsed CSV quoting only as far as the brief spells it out: a doubled double quote inside a quoted field stays doubled, which the hidden test rejects. Every luna attempt handled it. Composer finished in 46 to 64 percent of luna's wall clock on the tasks it passed. Across nine attempts each, composer-2.5 used 232,207 input and 23,826 output tokens, composer-2.5-fast 300,793 and 25,869, both from Cursor's first-party pool at $0.50 and $2.50 per million tokens for composer-2.5 against $3 and $15 for the fast variant. Luna used 1,115,094 input tokens (822,528 cached) and 41,483 output tokens at 2.5, 0.25, and 12.5 Codex credits per million.

The grok burst arm (grok-4.7-build-fast at low) has no measurement. Its one attempt failed as `sandbox` before spawn because OrbStack's `~/.orbstack/run/docker.sock` exists on this host, the same refusal both fusion hosts hit, and the account's Grok Build balance is exhausted (HTTP 402), so neither host can run a grok write today.

## Diversity seats

Consult mode, one repetition per seat and brief, scored by the orchestrator against each brief's key. The lru brief has two real defects: the seeded eviction end, and a latent double removal that the T01 reference solution shares (`#dropKey` unlinks a node its caller already detached, which empties the list; with maxSize 2, inserting a, b, c, d leaves b and d). The blind review has three; the research brief has three values; the clean review has none, so every reported defect there is a false claim.

| Seat | lru (2) | Blind review (3) | Research (3) | Clean review | False claims | Evidence slips | Wall clock |
|---|---:|---:|---:|---|---:|---|---:|
| fusion:deep-reasoner (Fable) | 2 | 3 | 3 | none found, one hedged overflow note | 0 | one predicted output in its own repro was a trace error | 65 to 221 s |
| muse-spark-1.3 xhigh | 2 | 3 | 3 | none found | 0 | the CSV fix is only sketched | 32 to 68 s |
| kimi-k3 high | 2 | 3 | 3 | none found | 0 | none | 27 to 35 s |
| gemini-3.8-flash high | 2 | 3 | 3 | one false defect (normalize with a reversed range) | 1 | none | 71 to 230 s |
| glm-5.2 high | 1 | 3 | 3 | none found | 0 | two line numbers one off, and it asserted the lru code had no other defect | 26 to 44 s |

Deep-reasoner gave the strongest evidence: pointer level traces, a steelman of the opposite list convention, and scope notes kept apart from defects. muse-spark-1.3 and kimi-k3 reached the same findings, the latent defect included, with no false claims. The research brief separated nobody.

## Routing reading

- Burst: no promotion. Composer cannot be ranked against grok burst without a grok measurement, and it trails the Codex volume tier on plan shaped fixes (0 of 6 against 3 of 3). It stays co-equal with grok burst on the admission ladder, and on hosts where grok writes are refused it is the only burst lane besides Codex. composer-2.5-fast earns no seat over composer-2.5: same verdicts, seconds faster, six times the token price.
- Diversity: muse-spark-1.3 stays the default seat, and kimi-k3 is an equal second whenever Composer is not seated on the same question, because the two share the Kimi lineage. gemini-3.8-flash and glm-5.2 rank below them on this snapshot.
- Codex flight fit: five scoped read only source audits ran on gpt-6.1-sol at xhigh the same day; one finished in 405 s and four exceeded the 570 s foreground flight and finished through the wind down resume after 793 to 867 s, so the quick lane default stays gpt-6-sol.
