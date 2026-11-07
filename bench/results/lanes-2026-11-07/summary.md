# Lane snapshot 2026-11-07

One machine (macOS 27.2, Node 24.22), companion at 0.0.70, grok 1.0.77, task manifest `c0950bd3`. The only manifest change since the 2026-10-13 snapshot is T01, so T05, T06, and T09 compare directly with it.

## Grok burst arm

Write mode, three repetitions per task, on the routing default `grok-4.7-build-fast` at low. The Composer and Luna rows repeat the 2026-10-13 snapshot. Input tokens follow each engine's own accounting, so they do not compare across engines.

| Task | Lane | Passed | Median wall clock | Median output tokens |
|---|---|---:|---:|---:|
| T05 mechanical codemod | grok-4.7-build-fast low | 3 of 3 | 36 s | 2,700 |
| T05 mechanical codemod | composer-2.5 | 3 of 3 | 68 s | 3,022 |
| T05 mechanical codemod | gpt-6-luna xhigh | 3 of 3 | 106 s | 2,963 |
| T06 plan shaped fixes | grok-4.7-build-fast low | 3 of 3 | 25 s | 1,905 |
| T06 plan shaped fixes | composer-2.5 | 0 of 3 | 61 s | 1,521 |
| T06 plan shaped fixes | gpt-6-luna xhigh | 3 of 3 | 105 s | 3,921 |
| T09 style fidelity | grok-4.7-build-fast low | 3 of 3 | 30 s | 2,787 |
| T09 style fidelity | composer-2.5 | 3 of 3 | 75 s | 3,527 |
| T09 style fidelity | gpt-6-luna xhigh | 3 of 3 | 131 s | 6,493 |

Grok burst ranks above Composer on these tasks: it passed T06, where every Composer attempt failed on CSV quoting, and it finished each task in about half the time. The nine runs cost $0.35 in total as the CLI reports it. Three repetitions on three tasks, on a different day and CLI build from the other lanes, support that ranking and no finer one.

The nine runs needed OrbStack stopped, because the companion refuses a Grok write run while its socket exists.
