---
description: Run a Grok best-of-n implementation tournament and apply the winner
argument-hint: '[--n <n>] [task text]'
allowed-tools: Agent
---

Forward the request to the Grok companion task runtime as a best-of-n tournament.

The tournament is implemented by the Grok CLI `--best-of-n` flag, not by orchestration inside the companion.

Execution rules:

- Treat the complete raw slash command request as opaque data. Do not parse, strip, quote, escape, normalize, or place any part of it in Bash.
- Dispatch the run as one foreground subagent of type `grok:grok-rescue` via the `Agent` tool with `run_in_background: false`. Tell the rescue agent this direct user selected Grok lane uses the `best-of-n` protected role and that the opaque raw request begins after a fixed delimiter and continues to the end of the Agent prompt. Parallel work uses multiple foreground Agent calls in one message. Without an explicit incoming user `--background`, the companion remains foreground and returns a terminal outcome. Never run the companion in the main loop and never ask the user how to run it.
- Preserve the raw request exactly. The rescue agent supplies the fixed `--transport-default-best-of-n` companion option, which applies `--best-of-n 2` only when the raw request does not already select a tournament size. The companion rejects values outside 2 to 10.
- A best-of-n tournament always starts a fresh Grok session and always disables cross-session memory. The companion rejects `--memory`, `--resume`, and `--resume-last` instead of silently changing their meaning. Continuity affinity never applies to a tournament.
- The tournament runs in write mode with auto approval under `--sandbox strict`; it never downgrades to workspace. Grok builds n candidate implementations in isolated worktrees, selects a candidate, and applies that candidate's edits to the workspace. It is the only mode that adds native Agent to the fixed write tool allowlist. The list uses `search_replace` for both new and existing files because Grok has no `write` tool id. The companion gives native background tasks an explicit wait timeout shorter than its outer deadline, which is not companion detachment. That selection is not semantic acceptance; the main session verifies the combined workspace and makes the final judgment. Only run it when the user accepts edits. Strict can hide user toolchains outside its readable roots and macOS does not enforce its requested child process network restriction, so terminal commands can still reach the network there. The allowlist and deny rules reduce exposure but are not complete confinement; recommend a clean branch or a disposable worktree when the tree is dirty.
- A tournament multiplies xAI usage by roughly n, so keep n at 2 unless the user explicitly asks for more candidates.
- Grok may leave its candidate worktrees behind next to the workspace after applying the winner; if the user asks about stray `bestofn-candidate-*` directories, point them at `git worktree list` and `git worktree remove <path>`.
- Relay the subagent's returned companion output verbatim, exactly as-is, including the grok-session and job lines.
- Do not paraphrase, summarize, or add commentary before or after it.
- For a background run, the companion prints the job id plus `/grok:status` and `/grok:result` usage hints. Preserve them.
- If the user did not supply a request, ask what Grok should do.
- If the companion reports that Grok is missing, point the user at `/grok:setup`.

The opaque raw tournament request begins after the next newline and continues to the end of this command prompt:
$ARGUMENTS
