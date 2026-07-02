---
name: grok-prompting
description: Brief writing guidance for composing self contained Grok briefs for coding, review, diagnosis, and second opinion tasks
user-invocable: false
---

# Grok prompting

Grok runs each brief in a fresh process with no memory of the Claude conversation. Write briefs it can execute without asking anything back.

Brief structure:

- State the goal in one sentence, then the constraints that bound it.
- Name the exact paths, modules, and commands involved. Grok should not have to guess where to look.
- Define done criteria: what must be true when the task is finished.
- Give a verification command Grok can run to prove the work, such as a test command or a build step.

Context rules:

- Include context generously. Grok's context window is large (512k as of grok 0.2.16); err on the side of pasting relevant code, error output, and prior findings rather than referring to them.
- Do not reference the Claude conversation, earlier turns, or "the change we discussed". The brief is the only context Grok gets.

Output contract:

- Demand explicit output sections: Verdict, Findings with file and line, Suggested next steps.
- For diagnosis work, ask Grok to separate observed facts from inferences.

Permissions:

- Always state whether Grok has write permission. In write mode, tell it to edit files directly and report the touched paths. In consult mode, tell it to propose changes without editing.
