# Benchmark condition profiles

Each benchmark condition uses a separate `CLAUDE_CONFIG_DIR`. Do not reuse a directory across conditions, and do not prepare condition A in a directory that ever had fusion installed. The fusion setup command writes routing rules into the user configuration under `rules/orchestration.md`, and those rules can continue to affect later Claude Code sessions even when the plugin itself is disabled. The runner validates exact installed and enabled plugin IDs, so disabling an extra plugin does not make a contaminated profile valid.

## Condition A

Condition A is vanilla Claude Code. Start with a fresh configuration directory that has never installed `claude-code-fusion`, `grok@claude-code-fusion`, `codex@claude-code-fusion`, `codex@openai-codex`, or `fusion@claude-code-fusion`.

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
```

`claude auth login` is interactive. Start an interactive Claude session in the same `CLAUDE_CONFIG_DIR`, accept the workspace trust prompt if it appears, run `/fusion:setup`, approve the routing rule install, and approve the optional `Bash(node:*)` permission only for this benchmark profile. Do not run `/grok:setup`, do not authenticate Grok or Codex in this profile, and do not install peer plugins for B1. Discard the profile if any peer plugin was installed, even if it is disabled.

## Condition B2

Condition B2 enables all fusion, Grok, and Codex surfaces. It requires authenticated Claude, Grok, and Codex subscriptions for the snapshot.

```bash
export CLAUDE_CONFIG_DIR=/absolute/path/to/bench-configs/B2
mkdir -p "$CLAUDE_CONFIG_DIR"
claude auth login
claude plugin marketplace add okisdev/claude-code-fusion
claude plugin install codex@claude-code-fusion
claude plugin install grok@claude-code-fusion
claude plugin install fusion@claude-code-fusion
claude plugin enable codex@claude-code-fusion
claude plugin enable grok@claude-code-fusion
claude plugin enable fusion@claude-code-fusion
```

`claude auth login` is interactive. Grok CLI authentication and Codex CLI authentication are also interactive, but their exact login commands are owned by those CLIs and are not defined in this repository. Start an interactive Claude session in the same `CLAUDE_CONFIG_DIR`, accept the workspace trust prompt if it appears, run `/fusion:setup`, approve the routing rule install, and approve the optional `Bash(node:*)` permission for this benchmark profile. Run `/codex:setup` and `/grok:setup` after the corresponding CLI login so each companion can confirm its runtime path. Discard the profile if `codex@openai-codex` or any other extra peer plugin was installed; disabling it is insufficient because the runner also validates the installed registry.

The runner emits `peerTokens: { "grok": null, "codex": null }` for B2 in this slice. Parsing Grok and Codex subscription token logs is a later package, so B2 peer token fields are placeholders until that parser lands.

## Condition B3

Condition B3 enables only the fusion plugin so the Claude tier agents and fusion routing rules are available, with the main session model fixed to the Sonnet tier before any benchmark session starts. Peer plugins are not installed for this profile. B3 must not reuse the B1 directory; discard any shared directory and create a clean B3 profile instead.

```bash
export CLAUDE_CONFIG_DIR=/absolute/path/to/bench-configs/B3
mkdir -p "$CLAUDE_CONFIG_DIR"
printf '%s\n' '{"model": "sonnet"}' > "$CLAUDE_CONFIG_DIR/settings.json"
claude auth login
claude plugin marketplace add okisdev/claude-code-fusion
claude plugin install fusion@claude-code-fusion
claude plugin enable fusion@claude-code-fusion
```

`claude auth login` is interactive. Start an interactive Claude session in the same `CLAUDE_CONFIG_DIR`, accept the workspace trust prompt if it appears, run `/fusion:setup`, approve the routing rule install, and approve the optional `Bash(node:*)` permission only for this benchmark profile. Do not run `/grok:setup`, do not authenticate Grok or Codex in this profile, and do not install peer plugins for B3. Discard the profile if any peer plugin was installed, even if it is disabled. The runner refuses a B3 invocation unless `$CLAUDE_CONFIG_DIR/settings.json` contains `{"model": "sonnet"}`.
