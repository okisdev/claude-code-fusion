# Lane snapshot 2026-11-18

One machine (macOS 27.2, Node 24.22), companions at 0.0.77, codex 0.169.0, devin 3000.14.30821, task manifest `c0950bd3` (unchanged since the 2026-11-07 snapshot). Write mode on T05, T06, and T09, three repetitions each, 72 judged attempts and no infrastructure failures. Attempts were interleaved round robin across lanes with at most three running at once. Grok is excluded because its write runs are blocked while OrbStack runs on this host. Input tokens follow each engine's own accounting and do not compare across engines. Devin output token counts are an order of magnitude lower than Codex for the same work and are not comparable either.

## Codex arm

| Task | Lane | Passed | Median wall clock | Median output tokens |
|---|---|---:|---:|---:|
| T05 mechanical codemod | gpt-6.2-sol xhigh | 3 of 3 | 69 s | 3,309 |
| T05 mechanical codemod | gpt-6.2-sol high | 3 of 3 | 56 s | 2,504 |
| T05 mechanical codemod | gpt-6.2-astra xhigh | 3 of 3 | 59 s | 1,465 |
| T05 mechanical codemod | gpt-6.1-sol xhigh | 3 of 3 | 66 s | 3,252 |
| T05 mechanical codemod | gpt-6-sol high | 3 of 3 | 46 s | 2,194 |
| T06 plan shaped fixes | gpt-6.2-sol xhigh | 3 of 3 | 152 s | 6,903 |
| T06 plan shaped fixes | gpt-6.2-sol high | 3 of 3 | 79 s | 3,253 |
| T06 plan shaped fixes | gpt-6.2-astra xhigh | 3 of 3 | 103 s | 2,517 |
| T06 plan shaped fixes | gpt-6.1-sol xhigh | 3 of 3 | 80 s | 3,892 |
| T06 plan shaped fixes | gpt-6-sol high | 3 of 3 | 61 s | 3,310 |
| T09 style fidelity | gpt-6.2-sol xhigh | 3 of 3 | 129 s | 5,384 |
| T09 style fidelity | gpt-6.2-sol high | 3 of 3 | 90 s | 3,164 |
| T09 style fidelity | gpt-6.2-astra xhigh | 3 of 3 | 75 s | 2,455 |
| T09 style fidelity | gpt-6.1-sol xhigh | 3 of 3 | 114 s | 5,250 |
| T09 style fidelity | gpt-6-sol high | 3 of 3 | 63 s | 2,886 |

Pooled over the nine attempts per lane:

| Lane | Passed | Median wall clock | Slowest attempt | Median output tokens |
|---|---:|---:|---:|---:|
| gpt-6.2-astra xhigh | 9 of 9 | 75 s | 405 s | 2,392 |
| gpt-6.2-sol xhigh | 9 of 9 | 129 s | 443 s | 4,790 |
| gpt-6.2-sol high | 9 of 9 | 82 s | 423 s | 2,933 |
| gpt-6.1-sol xhigh | 9 of 9 | 80 s | 124 s | 3,892 |
| gpt-6-sol high | 9 of 9 | 61 s | 66 s | 2,886 |

Every Codex lane passed every attempt, so the arm separates on latency and tokens only. The three slowest 6.2 attempts (394 to 443 s, on T05) and a 405 s astra attempt on T06 all passed and started within a few minutes of each other, which reads as a serving stall rather than a property of one model; neither 6.1-sol nor 6-sol showed such a tail, but they were not hit by the stall window either by luck or by serving, and nine attempts cannot say which. gpt-6.2-sol at xhigh is the slowest and most verbose lane on the two harder tasks (152 s and 6,903 tokens on T06) without passing more. gpt-6.2-astra at xhigh is the leanest by output tokens and sits between 6-sol and 6.1-sol on typical wall clock.

## Devin burst arm

| Task | Lane | Passed | Median wall clock | Median output tokens | Failure kinds |
|---|---|---:|---:|---:|---|
| T05 mechanical codemod | swe-2 high | 3 of 3 | 30 s | 142 | |
| T05 mechanical codemod | swe-2-flash high | 3 of 3 | 17 s | 193 | |
| T05 mechanical codemod | kimi-k3.1-pro high | 3 of 3 | 22 s | 290 | |
| T06 plan shaped fixes | swe-2 high | 3 of 3 | 34 s | 294 | |
| T06 plan shaped fixes | swe-2-flash high | 1 of 3 | 540 s | 369 | timeout 2 |
| T06 plan shaped fixes | kimi-k3.1-pro high | 3 of 3 | 34 s | 387 | |
| T09 style fidelity | swe-2 high | 3 of 3 | 54 s | 383 | |
| T09 style fidelity | swe-2-flash high | 2 of 3 | 57 s | 367 | verifier fail 1 |
| T09 style fidelity | kimi-k3.1-pro high | 3 of 3 | 40 s | 206 | |

| Lane | Passed | Median wall clock | Slowest attempt |
|---|---:|---:|---:|
| swe-2 high | 9 of 9 | 34 s | 61 s |
| kimi-k3.1-pro high | 9 of 9 | 34 s | 56 s |
| swe-2-flash high | 6 of 9 | 52 s | 541 s |

The devin catalog lists models without effort levels, and the companion accepted `high` for all three. The companion resolved the requested models to `swe-2-high`, `swe-2-flash-medium`, and `kimi-k3-1-pro-max` (the last two are variant uids chosen by the catalog, not an effort mismatch the instrument controls). swe-2-flash timed out twice on T06 at the companion's 540 s bound and failed one T09 attempt on the verifier; it passed T05 fastest, but it is the only burst lane with a failure. The premise that swe-2@high currently fails did not reproduce: it passed 9 of 9, with every attempt under 61 s. Devin billing pools are first party for swe-2 and swe-2-flash and api for kimi, and the CLI reports no cost.

## Recommendations

Codex flagship and quick defaults: keep gpt-6.1-sol@xhigh as flagship, do not adopt the gpt-6.2 models as defaults yet, and use gpt-6-sol@high for the quick and volume roles. Evidence: all five Codex lanes passed 9 of 9, so correctness does not separate them on T05, T06, and T09. gpt-6.2-sol@xhigh costs 1.6 times the median wall clock of gpt-6.1-sol@xhigh (129 s against 80 s) and 1.2 times the output tokens with no pass advantage, and both 6.2-sol lanes plus 6.2-astra showed 394 to 443 s attempts that no 6.1 or 6 lane showed. gpt-6.2-astra@xhigh matched 6.1-sol on pass rate at similar latency (75 s against 80 s) with the fewest output tokens, so it is a credible flagship candidate but not a demonstrated improvement. gpt-6-sol@high is the fastest and tightest lane (61 s median, 66 s slowest) and passed everything, which supports it as the quick and volume default. Caveat: three repetitions on three tasks that every lane already passes cannot rank flagship quality; the harder discriminating tasks (T03, T07, T08) were not run, and the stall that hit the 6.2 lanes may be transient serving. Revisit gpt-6.2-astra as flagship after a rerun on harder tasks.

Devin burst default: keep swe-2@high, with kimi-k3.1-pro@high as the fallback; drop swe-2-flash@high. Evidence: swe-2@high and kimi-k3.1-pro@high both passed 9 of 9 at a 34 s median, and swe-2-flash@high is the one to drop (6 of 9, two timeouts at 540 s). kimi-k3.1-pro has the same pass rate and speed as swe-2 and bills through the api pool, so it is a fallback, not an upgrade. Caveat: nine attempts per lane on three easy tasks, one account, and the earlier failure of swe-2@high that motivated this check was not reproduced here, so the failure may be task specific, time specific, or fixed in devin 3000.14.30821.

Runs lost to a concurrent upgrade of another engine CLI during the snapshot (a cursor-agent version change tripped the environment pin) wrote no records and were rerun; the `env.json` cursor entry reflects the version after the upgrade and is unrelated to these lanes.
