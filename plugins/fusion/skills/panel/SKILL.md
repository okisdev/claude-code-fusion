---
description: Convenes a blind Codex and Grok panel on one neutral brief and adjudicates the verdicts.
when_to_use: Proactively use when the user is stuck between two approaches, faces a design or architecture decision where being wrong is expensive, has a diagnosis that resisted one fix, or asks to compare options or get multiple opinions.
argument-hint: '[decision or question to adjudicate]'
allowed-tools: Write, Agent, Read, AskUserQuestion
---

Convene a blind multi-model panel on the decision below. Every engine receives the same neutral brief, works with no knowledge of the other panelists, and you adjudicate the returned verdicts.

Decision or question to adjudicate:
`$ARGUMENTS`

Compose the brief:

- Write ONE neutral, self contained brief containing: the decision or question, the constraints that bound the answer, the relevant file paths, and what a good answer must address.
- Never include a candidate answer, a leaning, any prior model opinion, or any context from this conversation. The panel is blind; a brief that hints at a preferred answer is invalid.
- End the brief with: "This is a consultation. Analyze and recommend; do not modify any files."
- Save the exact brief text to a file with `Write` before launching any track, so the text every engine received is traceable. Save it outside the repository (a temp directory or the session scratchpad); the panel must never dirty the working tree.
- If the request is too thin to build a self contained brief, ask the user for the missing constraints before launching.

Launch the panel:

- In a SINGLE message, launch two background subagents via the `Agent` tool, each with the identical brief as its prompt:
  - `codex:codex-rescue` (use plain `codex-rescue` if the namespaced form is not found)
  - `grok:grok-rescue` (use plain `grok-rescue` if the namespaced form is not found)
- Add `fusion:deep-reasoner` as a third track only when the user asks for a three way panel or the question hinges on Claude native long horizon reasoning.

Degrade when a track is unavailable:

- A panel never runs with fewer than two tracks. Two isolated instances of the same model still tend to outperform one in published multi-model deliberation results; the independent synthesis carries much of the lift.
- If a track fails to launch because its agent type does not exist (plugin not installed) or returns an unavailability line such as `grok unavailable: ...`, do not abort the panel: rerun the missing track as `fusion:deep-reasoner` (plain `deep-reasoner` if the namespaced form is not found) with the identical brief, and note the substitution in the final synthesis.
- If neither external engine is available, run a Claude only panel: two `fusion:deep-reasoner` (plain `deep-reasoner` if the namespaced form is not found) tracks with explicitly different lenses (prefix one brief with "Adopt a risk first lens." and the other with "Adopt a simplest viable answer lens."), and tell the user the panel ran without external engines.
- Availability failures are infrastructure, not verdicts; never present a missing engine as agreeing or disagreeing.

Wait and stay blind:

- Wait for every track to return before synthesizing anything.
- Never paste one engine's output into another engine's prompt. This applies to follow ups too: a follow up to an engine may reference only the original brief and that engine's own prior output.

Adjudicate with a structured analysis first:

- Before writing any prose verdict, produce a judge analysis as a JSON object with exactly these fields, every entry attributed by engine name: `consensus` (claims the engines agree on), `contradictions` (disputed claims, each side named), `partial_coverage` (points only one engine addressed), `unique_insights` (per engine), `blind_spots` (questions no engine addressed).
- Treat consensus as high confidence. Adjudicate contradictions on evidence, not on which engine said it.
- If a clean analysis is impossible (malformed outputs, irreconcilable framing), skip it and present each engine's verdict verbatim with attribution, stating that adjudication was skipped. Raw verdicts beat a forced synthesis.

Synthesize with attribution:

- Quote each engine's verdict by name; never blend positions into an anonymous consensus.
- When material disagreement remains, prefer ONE targeted follow up to ONE engine over a second full fan out.

Present to the user:

- The panel verdict.
- Each engine's position, in one or two sentences apiece.
- The final recommendation, with the reasoning behind it.
