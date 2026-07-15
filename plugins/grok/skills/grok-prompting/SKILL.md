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
- Give implementation and change briefs a verification command Grok can run to prove the work, such as a test command or a build step. Consult, research, and review briefs instead need explicit coverage or acceptance criteria, with collection review as their verification.

Context rules:

- Include context generously. Grok's context window is large; size briefs against the live `grok models` output rather than hardcoded numbers (the flagship default carries a 500k window). Err on the side of pasting relevant code, error output, and prior findings rather than referring to them.
- Do not reference the Claude conversation, earlier turns, or "the change we discussed". The brief is the only context Grok gets.

Output contract:

- For review work, require the JSON object contract from `plugins/grok/prompts/review.md`: verdict, findings, and next_steps. The companion validates that shape with `validateReviewOutput`.
- For task briefs, define prose done criteria instead of requiring review JSON. Ask Grok to report what changed, which paths it touched, and which verification command it ran.
- For diagnosis work, ask Grok to separate observed facts from inferences.

Permissions:

- Always state whether Grok has write permission. In write mode, tell it to edit files directly and report the touched paths. In consult mode, tell it to propose changes without editing.
- Read only consult briefs must state that Grok may read, list, and search files only, plus use web search and fetch when `--web` is present. Shell commands, tests, git, builds, edits, MCP tools, and subagents are unavailable. The hard tool filter or permission gate cancels calls outside that set. Write capable briefs are exempt.
