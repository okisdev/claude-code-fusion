---
name: grok-prompting
description: Brief writing guidance for composing self contained Grok briefs for coding, review, diagnosis, and second opinion tasks
user-invocable: false
---

# Grok prompting

Grok runs each brief in a new process and never receives the Claude conversation automatically. An explicit resume or direct-task continuity affinity may restore a compatible Grok session, and `--memory` may inject relevant cross-session Grok memory, but every brief must remain self contained. Fusion routed briefs do not receive automatic affinity and stay fresh unless explicitly resumed.

Brief structure:

- State the goal in one sentence, then the constraints that bound it.
- Name the exact paths, modules, and commands involved. Grok should not have to guess where to look.
- Define done criteria: what must be true when the task is finished.
- Give implementation and change briefs a verification command Grok can run to prove the work, such as a test command or a build step. Consult, research, and review briefs instead need explicit coverage or acceptance criteria, with collection review as their verification.

Context rules:

- Include context generously. Grok's context window is large; size briefs against the live `grok models` output rather than hardcoded numbers (the flagship default carries a 500k window). Err on the side of pasting relevant code, error output, and prior findings rather than referring to them.
- Do not reference the Claude conversation, earlier turns, or "the change we discussed". The brief is the only context Grok gets.
- Do not rely on continuity or memory to supply required task facts. Automatic affinity is limited to ordinary direct tasks with a matching Claude session, exact resolved working directory, mode, and memory setting. Fusion routed work does not receive automatic affinity, while review, stop gate, best-of-n, and `--fresh` start without prior Grok session context.
- Treat `--memory` as a data disclosure choice. Upstream first-turn memory injection can add relevant global or workspace memory to the model context sent to xAI, and that internal injection is not blocked by the companion's model-facing Read deny for `~/.grok/memory/**`. Upstream automatic saving usually requires at least three real user prompts in the same resumed session, so one Fusion task should not be expected to create new memory.

Output contract:

- For review work, require the JSON object contract from `plugins/grok/prompts/review.md`: verdict, findings, and next_steps. The companion requires the equivalent official `--json-schema` contract and consumes `structuredOutput` from the same turn. An explicit structured output error or null result fails the review. Compatibility parsing of text is limited to responses that completely omit the structured output field and never spends a second call.
- For task briefs, define prose done criteria instead of requiring review JSON. Ask Grok to report what changed, which paths it touched, and which verification command it ran.
- For diagnosis work, ask Grok to separate observed facts from inferences.

Permissions:

- Always state whether Grok has write permission. In write mode, tell it to edit files directly and report the touched paths. In consult mode, tell it to propose changes without editing.
- Read only consult briefs must state that Grok may invoke only file read, list, and search tools, plus web search and fetch when `--web` is present. Shell commands, tests, git, builds, edits, MCP tools, native questions, search delegation, tool delegation, and subagents are unavailable to the model. The hard tool filter or permission gate cancels calls outside that set, but it does not prove that native MCP servers, plugins, or hooks configured under `~/.grok` did not start during agent construction. Write capable briefs may use `search_replace` for existing or new files and may run shell commands, but still cannot invoke native questions, delegated search or tools, MCP, or Agent outside best-of-n. Every mode uses strict, so a requested user toolchain outside its readable roots may be unavailable; never suggest a workspace downgrade.
