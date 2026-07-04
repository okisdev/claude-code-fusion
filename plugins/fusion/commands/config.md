---
description: Configure model defaults and capability scores across the Claude, Grok, and Codex orchestration surfaces
allowed-tools: Read, Glob, Edit, Bash(grok models:*), Bash(rg:*), Bash(node:*), AskUserQuestion
---

Inspect the local model configuration across all peer engines, show what is currently available, and offer targeted edits to the defaults and the per user capability scores. Treat this as the write path counterpart to /fusion:doctor.

Steps:

1. Gather current state.
   - Capture environment overrides at invocation:
     - CLAUDE_CODE_SUBAGENT_MODEL: !`sh -c 'printenv CLAUDE_CODE_SUBAGENT_MODEL || echo "(unset)"'`
     - ANTHROPIC_MODEL: !`sh -c 'printenv ANTHROPIC_MODEL || echo "(unset)"'`
     - ANTHROPIC_DEFAULT_HAIKU_MODEL: !`sh -c 'printenv ANTHROPIC_DEFAULT_HAIKU_MODEL || echo "(unset)"'`
     - ANTHROPIC_DEFAULT_FABLE_MODEL: !`sh -c 'printenv ANTHROPIC_DEFAULT_FABLE_MODEL || echo "(unset)"'`
   - Read `~/.claude/settings.json` if it exists and report only the `model` key for the main session model.
   - Read only the frontmatter of every file in `${CLAUDE_PLUGIN_ROOT}/agents/` and report each Claude worker pin's `model` and `effort` values.
   - Run `grok models` to enumerate the account's live model lineup and current default, then extract only model related keys from `~/.grok/config.toml`.
   - Extract only the `model` and `model_reasoning_effort` keys from `~/.codex/config.toml`.
   - Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/fusion-config.mjs" show` to display the per user quantified engine capability table and its backing file path. Use `node "${CLAUDE_PLUGIN_ROOT}/scripts/fusion-config.mjs" show --json` only when structured output makes the next edit decision clearer.
   - Never read or print the full peer config files; extract only model related keys, because those files sit next to credentials and private project settings.
   - Do not use `Read` on `~/.grok/config.toml` or `~/.codex/config.toml`; use a scoped `rg` query that matches only model related keys.
   - Degrade gracefully per engine. A missing CLI or config file makes that engine's row show as unavailable; it never aborts the command.
2. Render one table with columns for configuration surface, current value, available values, and file that owns it. Prefer live enumeration values where available. Include rows for environment overrides, the main session model, Claude worker pins, Grok, and Codex. For unavailable values, write `unavailable` and include the reason in the current value or available values cell. Then show the capability table output from `fusion-config.mjs show` as its own compact section.
3. Offer changes with the `AskUserQuestion` tool, then apply only what the user picked.
   - For Grok, choices must come from the `grok models` output, never from a hardcoded list. Edit `~/.grok/config.toml` only when the user chooses a Grok default change, touch only model related keys, and preserve the rest of the file byte for byte.
   - For Codex, edit `~/.codex/config.toml` only when the user chooses a Codex default or reasoning effort change, touch only the `model` and `model_reasoning_effort` keys, and preserve the rest of the file byte for byte. Valid effort values are none, minimal, low, medium, high, and xhigh; the config file holds defaults, and per call --model and --effort overrides on the codex companion take precedence for a single job.
   - For Claude worker pins, show a caution before asking: this edits the marketplace checkout and will be overwritten by plugin updates. Edit only the plugin agent frontmatter fields the user selected.
   - For capability scores, use `node "${CLAUDE_PLUGIN_ROOT}/scripts/fusion-config.mjs" rescore <id> --intelligence N --taste N --cost N [--lane L] [--notes S]`, `node "${CLAUDE_PLUGIN_ROOT}/scripts/fusion-config.mjs" set-cost-profile <text>`, and `node "${CLAUDE_PLUGIN_ROOT}/scripts/fusion-config.mjs" reset-defaults --yes`. Suggest scoring again when /fusion:doctor reports model lineup changes or when the user says the available lineup changed. The script refreshes the live routing rules after each mutation, so do not hand edit the generated rules block.
   - For the main session model, never write `~/.claude/settings.json`; advise the user to use `/model` instead.
   - If an engine is unavailable or lacks live choices, offer no write option for that engine.
4. Close with what changed, what was skipped, and any engines that were unavailable. Advise the user to run `/fusion:doctor` to re-audit. Note that new grok sessions pick up config changes, while already running jobs do not.
