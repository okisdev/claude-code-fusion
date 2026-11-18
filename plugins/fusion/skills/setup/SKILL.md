---
name: setup
description: Installs or updates the orchestration rules in ~/.claude and checks the optional permission allow. Use on first install or after a plugin update changes the rules template.
argument-hint: ''
allowed-tools: Read, Write, Edit, AskUserQuestion, Bash(node:*)
---

Install or reconcile the orchestration layer this plugin ships but Claude Code cannot auto load: the routing rules file. A SessionStart hook already syncs the rules automatically whenever the live copy matches a version the plugin has shipped before, so this command is mainly needed once (first install) or when the hook detects local edits it will not overwrite on its own. Everything else (the tier agents, the panel and doctor commands) is already active through the plugin itself.

Steps:

1. Read the canonical rules at `${CLAUDE_PLUGIN_ROOT}/rules/orchestration.md`. Install these exact bytes; the capability table, breadth seat, and lane defaults come from `model-routing.json` as session context at session start and after compaction.
2. Read `~/.claude/rules/orchestration.md` if it exists.
   - If it does not exist, write the canonical content there with `Write` and report that the rules are installed.
   - If the bytes match, report that the rules are up to date.
   - If the bytes differ, prefer `node --input-type=module` with `hashRulesTemplate` exported by `${CLAUDE_PLUGIN_ROOT}/scripts/lib/rules-template.mjs` to compute both template hashes. This preserves legacy upgrade recognition by replacing everything between the `<!-- fusion:model-table:start -->` and `<!-- fusion:model-table:end -->` sentinel lines with the fixed normalized marker before computing SHA-256.
   - If the template hashes match, or the live hash is in `${CLAUDE_PLUGIN_ROOT}/rules-manifest.json` (read with `readManifestHashes` from the same module), write the canonical content without asking. Previously rendered tables and older shipped templates upgrade to the static file through this path.
   - If the template hashes differ and the live hash is not in the manifest, the live file carries local edits, and this is the only case where the overwrite question applies. Before asking anything, consult decision memory: read `~/.claude/plugins/data/fusion-claude-code-fusion/reconcile-decisions.json`, a small JSON object mapping template hash to `{decision, date}` (treat a missing file as `{}`). If the live hash already has a recorded entry, apply that decision without asking and state in one line that a previously recorded decision from that date was applied.
   - If the live hash has no recorded entry, show the user a compact diff summary outside the normalized model table region and ask with `AskUserQuestion` whether to overwrite (Recommended when the live copy has no local edits the user wants to keep) or keep the live copy. Overwrite with the canonical content only on approval; either way, record the choice under that hash, with today's date, in `reconcile-decisions.json` before finishing this step, creating the file and its parent directory with `Write` if they do not yet exist and preserving every other hash entry already recorded there.
3. Check `~/.claude/settings.json` for a `permissions.allow` entry of `Bash(node:*)`. If absent, tell the user: adding it lets the Codex, Grok, Cursor, and Devin forwarders run their companions without a first use permission prompt, but it is a broad allow; offer to add it via `Edit` and do so only on approval.
4. Report what was installed, what was skipped, and remind the user that future plugin updates sync automatically at the next session start unless the live copy carries local edits, in which case this command is how to reconcile them. Read capability rows from `model-routing.json` via `node "${CLAUDE_PLUGIN_ROOT}/scripts/fusion-config.mjs" show --json`; when it is missing or has no scored models, point the user at /fusion:config propose as the next step. Routing context refreshes in new sessions or after /compact.

Follow the flow above exactly: a fresh install (no existing rules file) writes without asking, a recognized shipped hash reconciles without asking, a hash with a recorded decision replays that decision without asking, and every other overwrite or settings change happens only on approval. This command touches only `~/.claude/rules/orchestration.md`, the decision memory file at `~/.claude/plugins/data/fusion-claude-code-fusion/reconcile-decisions.json`, and, on request, the settings permissions array.
