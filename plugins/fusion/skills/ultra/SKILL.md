---
description: "Fans the work out as a fleet of parallel Grok and Codex agents billed to their own subscriptions, then synthesizes one result. The peer engine equivalent of ultracode, adding intensity without spending Claude quota on the fleet."
when_to_use: "Proactively use when the user asks to go deep, be thorough, or exhaustive. Deep research on a topic, a comprehensive audit, an exhaustive bug hunt, mapping a whole subsystem, or implementing a large multi part feature."
argument-hint: '[the task to pursue exhaustively]'
allowed-tools: Write, Agent, Read, AskUserQuestion
---

Pursue the task below at high intensity by fanning it out across a fleet of peer engine agents, then synthesizing. The fleet bills to the OpenAI and xAI subscriptions, so the depth costs peer quota, not Claude quota.

Task:
`$ARGUMENTS`

Size gate first (cheap, in the main loop):

- If the task is small, a single question or a one file change, do NOT convene a fleet. Hand it to one `grok:grok-rescue` or answer it directly, and say you skipped the fleet because the task did not warrant it. The fleet is for genuinely large or open ended work.
- Otherwise decompose the task into independent facets. Research decomposes by angle or source (different subsystems, different questions, different documents). Implementation decomposes by work package. Aim for 6 to 8 facets by default; go lower if the task has fewer natural seams, higher (up to about 12) only when the user asked for maximum coverage and the facets are truly independent.

Compose one self contained brief per facet:

- Each brief states its facet's goal, the shared context needed to work it alone, the relevant paths, and what a good result must cover. A facet brief never depends on another facet's output.
- Research briefs go to grok with `--web` when live sources help; implementation briefs state write permission explicitly.

Launch the fleet in ONE message:

- Spawn all facets at once as background subagents via the `Agent` tool. Route by lane: codex and grok are both frontier implementation lanes; prefer codex (`codex:codex-rescue`) for long horizon multi step facets and adversarial passes, and since it is single flight per workspace give it the deepest facet rather than many; prefer grok (`grok:grok-rescue`) for high volume facets, research digests, large context reads, and scoped fixes, each spec grade brief where applicable. Balance the split so both engines draw.
- Track the facets visibly with the harness's task list when one exists, otherwise enumerate the facets in the dispatch note. Never poll; completions arrive as notifications.
- If an engine is unavailable (`grok unavailable: ...` or a missing agent type), route its facets to the other peer with their briefs intact, and only when both peers are down fall back to the Claude tiers: fusion:fast-worker for implementation facets, fusion:deep-reasoner for adversarial and synthesis facets. Say so in the synthesis.

Synthesize when the fleet returns:

- Read every facet result. Produce one coherent answer: for research, a structured report attributing findings to facets and flagging where facets disagreed or left gaps; for implementation, an integrated summary of what each package delivered plus a final verification pass (typecheck and tests) run once over the combined result.
- Surface contradictions between facets explicitly rather than averaging them away. A facet that failed or returned nothing is a gap to name, not a silent omission.
- The user gets one synthesized deliverable, not a pile of raw fleet outputs.

At most one fleet per user turn. If a follow up is needed, prefer one targeted facet over a second full fan out.
