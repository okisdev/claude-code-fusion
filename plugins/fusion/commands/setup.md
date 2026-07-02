---
description: Install or update the orchestration routing rules into ~/.claude and check the optional permission allow
argument-hint: ''
allowed-tools: Read, Write, Edit, AskUserQuestion
---

Install the orchestration layer this plugin ships but Claude Code cannot auto load: the routing rules file. Everything else (the tier agents, the panel and doctor commands) is already active through the plugin itself.

Steps:

1. Read the canonical rules at `${CLAUDE_PLUGIN_ROOT}/rules/orchestration.md`.
2. Read `~/.claude/rules/orchestration.md` if it exists.
   - If it does not exist, write the canonical content there with `Write` and report that the rules are installed.
   - If it exists and is identical, report that the rules are up to date and stop.
   - If it exists and differs, show the user a compact diff summary (what changed, not necessarily every line) and ask with `AskUserQuestion` whether to overwrite (Recommended when the live copy has no local edits the user wants to keep) or keep the live copy. Overwrite only on approval.
3. Check `~/.claude/settings.json` for a `permissions.allow` entry of `Bash(node:*)`. If absent, tell the user: adding it lets the grok forwarder run the companion without a first use permission prompt, but it is a broad allow; offer to add it via `Edit` and do so only on approval.
4. Report what was installed, what was skipped, and remind the user that a new session picks up rules changes.

Never modify anything without the approval flow above. This command touches only `~/.claude/rules/orchestration.md` and, on request, the settings permissions array.
