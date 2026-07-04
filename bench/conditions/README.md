# Benchmark condition profiles

Each benchmark condition uses a separate `CLAUDE_CONFIG_DIR`. Do not reuse a directory across conditions, and do not prepare condition A in a directory that ever had fusion installed. The fusion setup command writes routing rules into the user configuration under `rules/orchestration.md`, and those rules can continue to affect later Claude Code sessions even when the plugin itself is disabled.

## Condition A

Condition A is vanilla Claude Code. Start with a fresh configuration directory that has never installed `claude-code-fusion`, `grok@claude-code-fusion`, `fusion@claude-code-fusion`, or `codex@openai-codex`.

```bash
export CLAUDE_CONFIG_DIR=/absolute/path/to/bench-configs/A
mkdir -p "$CLAUDE_CONFIG_DIR"
test ! -e "$CLAUDE_CONFIG_DIR/rules/orchestration.md"
claude auth login
```

`claude auth login` is interactive and must be completed with the Claude subscription used for the snapshot. Do not run `/fusion:setup`, `/grok:setup`, `claude plugin marketplace add okisdev/claude-code-fusion`, or any plugin install command in this profile.

## Condition B1

Condition B1 enables only the fusion plugin so the Claude tier agents and fusion routing rules are available. Peer plugins are not installed for this profile. If a shared configuration directory already has Grok or Codex installed, discard that directory and create a clean B1 profile instead.

```bash
export CLAUDE_CONFIG_DIR=/absolute/path/to/bench-configs/B1
mkdir -p "$CLAUDE_CONFIG_DIR"
claude auth login
claude plugin marketplace add okisdev/claude-code-fusion
claude plugin install fusion@claude-code-fusion
claude plugin enable fusion@claude-code-fusion
claude plugin disable grok@claude-code-fusion
claude plugin disable codex@openai-codex
```

`claude auth login` is interactive. If the Grok or Codex plugin is not installed, the disable command may report that there is nothing to disable, which is acceptable for B1. Start an interactive Claude session in the same `CLAUDE_CONFIG_DIR`, accept the workspace trust prompt if it appears, run `/fusion:setup`, approve the routing rule install, and approve the optional `Bash(node:*)` permission only for this benchmark profile. Do not run `/grok:setup`, do not authenticate Grok or Codex in this profile, and do not install peer plugins for B1.

## Condition B2

Condition B2 enables all fusion, Grok, and Codex surfaces. It requires authenticated Claude, Grok, and Codex subscriptions for the snapshot.

```bash
export CLAUDE_CONFIG_DIR=/absolute/path/to/bench-configs/B2
mkdir -p "$CLAUDE_CONFIG_DIR"
claude auth login
claude plugin marketplace add okisdev/claude-code-fusion
claude plugin install grok@claude-code-fusion
claude plugin install fusion@claude-code-fusion
claude plugin enable grok@claude-code-fusion
claude plugin enable fusion@claude-code-fusion
claude plugin install codex@openai-codex
claude plugin enable codex@openai-codex
```

`claude auth login` is interactive. Grok CLI authentication and Codex CLI authentication are also interactive, but their exact login commands are owned by those CLIs and are not defined in this repository. Start an interactive Claude session in the same `CLAUDE_CONFIG_DIR`, accept the workspace trust prompt if it appears, run `/fusion:setup`, approve the routing rule install, and approve the optional `Bash(node:*)` permission for this benchmark profile. Run `/grok:setup` after the Grok CLI login so the companion can confirm the runtime path.

The runner emits `peerTokens: { "grok": null, "codex": null }` for B2 in this slice. Parsing Grok and Codex subscription token logs is a later package, so B2 peer token fields are placeholders until that parser lands.
