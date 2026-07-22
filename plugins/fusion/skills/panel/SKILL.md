---
name: panel
description: Convenes a blind Codex and Grok panel on one neutral brief and adjudicates the verdicts.
when_to_use: Proactively use when the user is stuck between two approaches, faces a design or architecture decision where being wrong is expensive, has a diagnosis that resisted one fix, or asks to compare options or get multiple opinions.
argument-hint: '[decision or question to adjudicate]'
allowed-tools: Agent, Read, AskUserQuestion
---

Convene a blind multi-model panel on the decision below. In the standard external panel, every engine receives the same neutral brief, works with no knowledge of the other panelists, and you adjudicate the returned verdicts.

Decision or question to adjudicate:
`$ARGUMENTS`

Compose the brief:

- Write ONE neutral, self contained brief containing: the decision or question, the constraints that bound the answer, the relevant file paths, and explicit coverage or acceptance criteria for what a good answer must address. Collection review verifies this consultation brief; it does not need a shell verification command. Its first line is the single routing header required by policy and includes `lane: panel`, `grok-role: independence` (one of the four permitted Grok roles), and the explicit acceptance criteria; the shared routing header is also included in the identical prompt sent to Codex.
- Never include a candidate answer, a leaning, any prior model opinion, or any context from this conversation. The panel is blind; a brief that hints at a preferred answer is invalid.
- End the brief with: "This is a consultation. Analyze and recommend; do not modify any files."
- Keep the exact brief in the Agent calls and pass it directly as each Agent prompt. Do not create a transport file, temp brief, or plugin-data payload with Write. Companion adapters own any private staging required by their transports. Panel consultations do not use isolated implementation worktrees or a Codex only `--cwd` prefix because either would violate the identical brief invariant.
- If the request is too thin to build a self contained brief, ask the user for the missing constraints before launching.

Launch the panel:

- In one tool message, invoke `grok:grok-rescue` and `codex:codex-rescue` with the identical brief as their direct prompt. Use plain `grok-rescue` or `codex-rescue` if the namespaced form is not found. Do not set `run_in_background`; parallel tool calls provide overlap while each result remains owned and collected.
- Never set background mode on the Codex Agent and never add `--background` to its brief. Complexity, expected duration, and model choice do not change this rule.
- Add `fusion:deep-reasoner` as a third parallel track only when the user asks for a three way panel or the question hinges on Claude native long horizon reasoning. Its prompt must use the `fusion-brief: v1` isolated envelope.

Degrade when a track is unavailable:

- A panel never runs with fewer than two tracks. Two isolated instances of the same model still tend to outperform one in published multi-model deliberation results; the independent synthesis carries much of the lift.
- If a track fails to launch because its agent type does not exist (plugin not installed) or returns an unavailability line such as `grok unavailable: ...`, do not abort the panel: rerun the missing track as `fusion:deep-reasoner` (plain `deep-reasoner` if the namespaced form is not found) with the identical brief, and note the substitution in the final synthesis.
- If neither external engine is available, run a Claude only panel: two `fusion:deep-reasoner` (plain `deep-reasoner` if the namespaced form is not found) tracks with explicitly different lenses, and tell the user the panel ran without external engines. This is the only exception to the identical brief rule. Derive two direct prompts by adding `lens: risk first` and `lens: simplest viable answer` to otherwise identical `fusion-brief: v1` envelopes.
- Availability failures are infrastructure, not verdicts; never present a missing engine as agreeing or disagreeing.

Wait and stay blind:

- Wait for every track to return before synthesizing anything.
- Never paste one engine's output into another engine's prompt. This applies to follow ups too: a follow up to an engine may reference only the original brief and that engine's own prior output.

Adjudicate with a structured analysis first:

- Before writing any prose verdict, produce a judge analysis as a JSON object with exactly these fields: `consensus` (claims the engines agree on), `contradictions` (disputed claims, each side named), `partial_coverage` (points only one engine addressed), `unique_insights` (per engine), `blind_spots` (questions no engine addressed). Attribute every claim in every field to its engine by name.
- Never average the verdicts or count them as equal votes. In the standard two track panel, the configured Codex frontier lane is the default deep lead on long horizon correctness and architecture. The configured Grok lane is an independent cross check weighted on large context factual verification and terminal or operational pragmatics. These are lane priors, not substitutes for evidence; stronger concrete evidence wins a disputed point regardless of which engine produced it.
- Treat agreement as a strong accept signal and consensus as high confidence. Adjudicate each contradiction according to its subject and supporting evidence, applying these weights when both standard tracks return.
- If a clean analysis is impossible (malformed outputs, irreconcilable framing), skip it and present each engine's verdict verbatim with attribution, stating that adjudication was skipped. Raw verdicts beat a forced synthesis.

Synthesize with attribution:

- Quote each engine's verdict by name and attribute every claim to its engine; never blend positions into an anonymous consensus.
- Disagreement triggers exactly ONE targeted follow up to ONE engine on the specific point of disagreement; never run a second full fan out.

Present to the user:

- The panel verdict.
- Each engine's position, in one or two sentences apiece.
- The final recommendation, with the reasoning behind it.
