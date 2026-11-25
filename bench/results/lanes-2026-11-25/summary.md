# Lane snapshot 2026-11-25

One machine (macOS 27.2, Node 24.22), companions at 0.0.92, codex-cli 0.172.0, devin 3000.14.30821, task manifest `c0950bd3` (unchanged since the 2026-11-07 snapshot). This snapshot reruns the Codex lanes on the harder tasks the 2026-11-18 snapshot left out (T03, T07, T08), measures gpt-6.2-sol at medium for the volume role, and measures Devin's new swe-2.1 for the burst and diversity seats. Write mode ran three repetitions per lane and task; 93 judged write attempts and 10 consult attempts, no infrastructure failures. Grok is excluded because its write runs are blocked while OrbStack runs on this host. Input tokens follow each engine's own accounting and do not compare across engines.

## Codex arm

| Task | Lane | Passed | Median wall clock | Median output tokens |
|---|---|---:|---:|---:|
| T03 spec implementation | gpt-6.2-astra xhigh | 3 of 3 | 71 s | 3,140 |
| T03 spec implementation | gpt-6.2-sol xhigh | 3 of 3 | 110 s | 4,656 |
| T03 spec implementation | gpt-6.2-sol high | 3 of 3 | 81 s | 3,577 |
| T03 spec implementation | gpt-6.1-sol xhigh | 3 of 3 | 97 s | 5,517 |
| T03 spec implementation | gpt-6-sol xhigh | 3 of 3 | 82 s | 5,023 |
| T07 plan shaped features | gpt-6.2-astra xhigh | 3 of 3 | 96 s | 5,266 |
| T07 plan shaped features | gpt-6.2-sol xhigh | 3 of 3 | 159 s | 9,326 |
| T07 plan shaped features | gpt-6.2-sol high | 3 of 3 | 144 s | 8,461 |
| T07 plan shaped features | gpt-6.1-sol xhigh | 2 of 3 | 228 s | 13,613 |
| T07 plan shaped features | gpt-6-sol xhigh | 3 of 3 | 129 s | 8,322 |
| T08 plan shaped migrations | gpt-6.2-astra xhigh | 3 of 3 | 49 s | 1,341 |
| T08 plan shaped migrations | gpt-6.2-sol xhigh | 3 of 3 | 48 s | 1,825 |
| T08 plan shaped migrations | gpt-6.2-sol high | 3 of 3 | 45 s | 1,387 |
| T08 plan shaped migrations | gpt-6.2-sol medium | 3 of 3 | 41 s | 1,499 |
| T08 plan shaped migrations | gpt-6.1-sol xhigh | 3 of 3 | 60 s | 2,073 |
| T08 plan shaped migrations | gpt-6-sol xhigh | 3 of 3 | 46 s | 1,843 |
| T05 mechanical codemod | gpt-6.2-sol medium | 3 of 3 | 41 s | 1,403 |
| T06 plan shaped fixes | gpt-6.2-sol medium | 3 of 3 | 46 s | 1,899 |
| T09 style fidelity | gpt-6.2-sol medium | 3 of 3 | 44 s | 2,162 |

Pooled per lane (gpt-6.2-sol medium ran T05, T06, T08, T09; the others ran T03, T07, T08):

| Lane | Passed | Median wall clock | Slowest attempt |
|---|---:|---:|---:|
| gpt-6.2-astra xhigh | 9 of 9 | 71 s | 104 s |
| gpt-6.2-sol xhigh | 9 of 9 | 110 s | 164 s |
| gpt-6.2-sol high | 9 of 9 | 81 s | 154 s |
| gpt-6.2-sol medium | 12 of 12 | 43 s | 49 s |
| gpt-6.1-sol xhigh | 8 of 9 | 97 s | 230 s |
| gpt-6-sol xhigh | 9 of 9 | 82 s | 160 s |

gpt-6.2-astra at xhigh is the fastest lane on every harder task and the leanest by output tokens; the serving stall the 2026-11-18 snapshot saw on the 6.2 lanes did not recur. gpt-6.1-sol at xhigh, the flagship default going in, is the only lane with a failure and the slowest on T07, which matches its 25 percent foreground timeout share across 44 production xhigh jobs. gpt-6.2-sol at high matches gpt-6-sol at xhigh within a few seconds on T03 and T08 and trails it on T07; gpt-6.2-sol at xhigh is slower and more verbose without passing more, as on 2026-11-18. gpt-6.2-sol at medium passed every attempt with the tightest spread of any lane.

## Devin burst arm

| Task | Lane | Passed | Median wall clock | Median output tokens |
|---|---|---:|---:|---:|
| T05 mechanical codemod | swe-2.1 high | 3 of 3 | 77 s | 239 |
| T05 mechanical codemod | swe-2.1 xhigh | 3 of 3 | 58 s | 345 |
| T05 mechanical codemod | swe-2 high | 3 of 3 | 23 s | 203 |
| T06 plan shaped fixes | swe-2.1 high | 3 of 3 | 127 s | 373 |
| T06 plan shaped fixes | swe-2.1 xhigh | 3 of 3 | 156 s | 347 |
| T06 plan shaped fixes | swe-2 high | 3 of 3 | 25 s | 227 |
| T07 plan shaped features | swe-2.1 high | 3 of 3 | 302 s | 310 |
| T07 plan shaped features | swe-2.1 xhigh | 3 of 3 | 557 s | 468 |
| T07 plan shaped features | swe-2 high | 1 of 3 | 108 s | 455 |
| T09 style fidelity | swe-2.1 high | 3 of 3 | 145 s | 481 |
| T09 style fidelity | swe-2.1 xhigh | 3 of 3 | 190 s | 279 |
| T09 style fidelity | swe-2 high | 3 of 3 | 31 s | 402 |

swe-2.1 passed all 24 attempts at both efforts; swe-2 failed two of three T07 attempts on the verifier. swe-2.1 is three to five times slower than swe-2 at high, and xhigh adds latency without passing more (T07 at 557 s sits close to the 900 s Devin flight). Both models billed the free pool at the requested efforts.

## Devin diversity seat

Consult mode, swe-2.1 at high, scored against each brief's key as in the 2026-10-13 snapshot. The first two clean review attempts ran against the T02 fixtures instead of its solution, an operator error, so they are excluded from scoring; two more ran against the solution.

| Brief | Key | swe-2.1 high | Wall clock |
|---|---|---|---:|
| lru recency | 2 defects | 1 of 2 in both runs; missed the latent double removal and asserted no other defect | 136 to 234 s |
| blind review | 3 defects | 3 of 3 in both runs | 113 to 162 s |
| research | 3 values | 3 of 3 in both runs | 43 to 81 s |
| clean review | no defects | 4 false defects in each run (reversed ranges, floating point overflow in normalize and lerp) | 306 to 325 s |

## Recommendations

Codex: flagship gpt-6.2-astra at xhigh, quick gpt-6.2-sol at high, volume gpt-6.2-sol at medium. Evidence: astra was fastest and leanest on the discriminating tasks with no failure, where the incumbent flagship failed once and ran slowest; the live catalog marks gpt-6-sol Legacy and names gpt-6.2-sol its go to coding model with a 500k window, and gpt-6.2-sol at high matched gpt-6-sol at xhigh on the harder tasks; medium passed 12 of 12 at the lowest latency, which fits the volume role while keeping quick and volume on distinct efforts. Caveat: astra bills about four times gpt-6.2-sol per token, which the Codex weekly pool absorbs at 24 percent used on the snapshot date.

Devin burst: swe-2.1 at high replaces swe-2 at high. Correctness ranks before latency, and swe-2.1 is the only Devin lane that passed the plan shaped feature task. swe-2 stays scored as the fastest choice for tiny mechanical packages named explicitly.

Devin diversity: keep kimi-k3.1-pro at high. swe-2.1 is free but reported four false defects on each clean review and missed the latent lru defect that kimi-k3 and muse-spark-1.3 found on 2026-10-13, so it would raise adjudication burden on every panel it sits on. kimi-k3.1-pro bills the metered pool, so it is seated only when named.

Eight attempts first failed before running because the runner reported a conflicting `engineCliVersions` pin while three or more attempts started together; they wrote no records and passed when rerun one at a time. The cause was not isolated.
