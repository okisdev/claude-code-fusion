---
name: ultra
description: "Fans the work out as a fleet of parallel Grok and Codex agents billed to their own subscriptions, then synthesizes one result. The peer engine equivalent of ultracode, adding intensity without spending Claude quota on the fleet. The default execution posture for any goal that decomposes into three or more independent work packages, not only an intensity booster for explicit asks."
when_to_use: "Proactively convene whenever the goal decomposes into three or more independent work packages once bootstrap dependencies are resolved; this is the default posture, not an escalation. Also convene on any explicit ask to go deep, be thorough, or exhaustive: deep research on a topic, a comprehensive audit, an exhaustive bug hunt, mapping a whole subsystem, or implementing a large multi part feature. Declining a fleet shaped goal requires a visible fleet-decline: <reason> line."
argument-hint: '[the task to pursue exhaustively]'
allowed-tools: Agent, Read, Bash, AskUserQuestion
---

Pursue the task below at high intensity by fanning it out across a fleet of peer engine agents, then synthesizing. The fleet bills to the OpenAI and xAI subscriptions, so the depth costs peer quota, not Claude quota.

Task:
`$ARGUMENTS`

Size gate first (cheap, in the main loop):

- If the task is small, a single question, or a one file change, do NOT convene a fleet. Return it to the normal routing policy: questions stay in the main session, and requested changes normally use the Codex primary lane. Say you skipped the fleet because the task did not warrant it.
- Skipping a goal that decomposes into three or more independent packages is a decline: state a visible `fleet-decline: <reason>` line in the reply. Decline reasons are premises, and when one expires (a lane recovers, the goal enters implement, packages accrete to three) the fleet question reopens.
- Otherwise decompose the task into independent facets. Research decomposes by angle or source (different subsystems, different questions, different documents). Implementation decomposes by work package. Facet count follows the goal's natural package count with a floor of three: 6 to 8 facets when the seams allow it; up to about 12 only when the user asked for maximum coverage and the facets are truly independent. A three package goal is fleet shaped even though it sits below six.

Compose one self contained brief per facet:

- Each brief states its facet's goal, the shared context needed to work it alone, the relevant paths, and what a good result must cover. Claude worker facets use the `fusion-brief: v1` isolated envelope. Implementation facets carry a verification command. Consult and research facets instead carry explicit coverage or acceptance criteria, with collection review as their verification. A facet brief never depends on another facet's output. Pass every brief directly as the Agent prompt; do not write transport files. Companion adapters own any private staging required by their transports.
- Every Grok facet brief begins with a single routing header line containing exactly one `grok-role: <role>` field, choosing one of `burst`, `independence`, `live-web`, or `large-context` from the facet's actual purpose. Do not include a second Grok role anywhere in that brief.
- Research briefs go to grok with `--web` when live sources help; implementation briefs state write permission explicitly.

Launch the fleet in one message:

- The convening ceremony runs inside this skill, not prepaid by the main loop before invoking it: record the checkpoint or staged patch baseline when the tree is uncommitted, create the orchestrator owned worktrees for eligible independent Codex facets, and generate each brief's sibling declaration list mechanically from the decomposition so every facet's files appear in every other facet's forbidden list. The main loop's job is the decomposition decision and final judgment, not the staging ritual.
- The fleet changes capacity, not lane ownership. Codex remains the primary builder and deep reviewer. Grok supplies breadth under its `burst`, `live-web`, `large-context`, and `independence` protected roles.
- Invoke all independent Grok, Claude, and Codex facets together as parallel foreground-delivery Agent calls in one tool message. Do not set `run_in_background`. If the runtime still returns an async launch receipt, retain ownership and collect it before synthesis; Fusion's lifecycle hook blocks a turn that tries to abandon a Claude worker. Additional independent Codex implementation facets may use distinct orchestrator owned worktrees when their files are disjoint and verification needs no heavy setup. For each such facet, use `--write --cwd "<absolute worktree path>" -- <brief>` as the complete direct prompt to `codex:codex-rescue`. A natural language `Working directory:` line does not select the Codex sandbox, and `--cwd` must never be appended to the Agent call, wrapper Bash command, or `--raw-args-token` invocation. Grok carries the remaining burst breadth, research digests, large context reads, and isolated scoped fixes. Packages that overlap files or require ordering are consolidated or sequenced, never fanned out as parallel overflow.
- Never set background mode on the Codex Agent or add `--background` to its brief. Complexity, expected duration, and model choice do not authorize detachment inside a fleet.
- Track the facets visibly with the harness's task list when one exists, otherwise enumerate the facets in the dispatch note. Never poll; completions arrive as notifications.
- If Grok is unavailable, keep one Codex facet in each available workspace, use isolated Codex worktrees only for eligible independent packages, and send remaining implementation breadth to `fusion:fast-worker`; use `fusion:deep-reasoner` for read only adversarial analysis. If Codex is unavailable, bounded and safely isolated implementation may use Grok under `burst`, while packages needing the Claude tool surface, privacy boundary, or more turns use `fusion:fast-worker`. Say every substitution in the synthesis.

Synthesize when the fleet returns:

- Read every facet result. Produce one coherent answer: for research, a structured report attributing findings to facets and flagging where facets disagreed or left gaps; for implementation, an integrated summary of what each package delivered plus a final verification pass (typecheck and tests) run once over the combined result.
- Surface contradictions between facets explicitly rather than averaging them away. A facet that failed or returned nothing is a gap to name, not a silent omission.
- The user gets one synthesized deliverable, not a pile of raw fleet outputs.

At most one fleet per user turn. If a follow up is needed, prefer one targeted facet over a second full fan out.
