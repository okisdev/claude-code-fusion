---
description: Install or update the orchestration routing rules into ~/.claude and check the optional permission allow
argument-hint: ''
allowed-tools: Read, Write, Edit, AskUserQuestion, Bash(node:*)
---

Install or reconcile the orchestration layer this plugin ships but Claude Code cannot auto load: the routing rules file. A SessionStart hook already syncs the rules automatically whenever the live copy matches a version the plugin has shipped before, so this command is mainly needed once (first install) or when the hook detects local edits it will not overwrite on its own. Everything else (the tier agents, the panel and doctor commands) is already active through the plugin itself.

Steps:

1. Read the canonical rules at `${CLAUDE_PLUGIN_ROOT}/rules/orchestration.md` and render the content that should be live. Prefer `node --input-type=module` with `renderRulesContent` and `hashRulesTemplate` exported by `${CLAUDE_PLUGIN_ROOT}/scripts/lib/rules-template.mjs`, passing the existing live model table region as `invalidFallbackText` when the live file exists. If no model routing file exists, the rendered content keeps the shipped placeholder. If a valid model routing file exists, the rendered content contains the scored table.
2. Read `~/.claude/rules/orchestration.md` if it exists.
   - If it does not exist, write the rendered content there with `Write` and report that the rules are installed.
   - If it exists, compute the template hash for the live file and the canonical file after replacing everything between the `<!-- fusion:model-table:start -->` and `<!-- fusion:model-table:end -->` sentinel lines with the fixed normalized marker before computing SHA-256. A live scored model table is expected to differ from the shipped placeholder, so do not compare raw bytes and do not treat that region as drift.
   - If the template hashes match, report that the rules are up to date and stop.
   - If the template hashes differ, show the user a compact diff summary outside the normalized model table region and ask with `AskUserQuestion` whether to overwrite (Recommended when the live copy has no local edits the user wants to keep) or keep the live copy. Overwrite with the rendered content only on approval.
3. Check `~/.claude/settings.json` for a `permissions.allow` entry of `Bash(node:*)`. If absent, tell the user: adding it lets the grok forwarder run the companion without a first use permission prompt, but it is a broad allow; offer to add it via `Edit` and do so only on approval.
4. Report what was installed, what was skipped, and remind the user that future plugin updates sync automatically at the next session start unless the live copy carries local edits, in which case this command is how to reconcile them.

Follow the flow above exactly: a fresh install (no existing rules file) writes without asking, and every overwrite or settings change happens only on approval. This command touches only `~/.claude/rules/orchestration.md` and, on request, the settings permissions array.
