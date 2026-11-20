---
name: smoke
description: Runs a five probe live smoke wave after a plugin update and reports gate chain health before real work rides it.
argument-hint: ''
when_to_use: After a plugin cache refresh or version update, before dispatching real delegated work.
allowed-tools: 'Agent, Bash, Read'
---

Verify the update landed, then prove the dispatch chain end to end with five tiny probes before real packages ride it.

1. Version parity: read `~/.claude/plugins/installed_plugins.json` and compare the fusion, codex, grok, cursor, devin, and agy entries against `.claude-plugin/marketplace.json` in this repository when present. Report each version pair; a mismatch is a FAIL naming the stale plugin.
2. Read the selected breadth engine from the top level `breadth` key in `model-routing.json` (default `cursor`) and confirm the rendered routing table names it. Fan out five probes as parallel foreground Agent calls in one message. The four engine probes name no model, so the routing table's lane default fills it and the probe exercises that path too:
   - a `codex:codex-rescue` task whose direct prompt passes `--effort low --cwd "<absolute repository root>" --` followed by a brief whose header line is `lane: codex volume | effort low | read only | acceptance: exact marker line` and whose body asks for exactly the line FUSION-SMOKE-CODEX-OK;
   - a `grok:grok-rescue` task whose direct prompt passes `--effort low --cwd "<absolute repository root>" --` followed by a brief whose header line is `grok-role: burst | effort low | read only | acceptance: exact marker line` and whose body asks for exactly the line FUSION-SMOKE-GROK-OK;
   - an `agy:agy-rescue` task whose direct prompt passes `--cwd "<absolute repository root>" --` followed by a brief whose header line is `agy-role: independence | read only | acceptance: exact marker line` and whose body asks for exactly the line FUSION-SMOKE-AGY-OK;
   - a selected `<breadth>:<breadth>-rescue` task whose direct prompt passes `--cwd "<absolute repository root>" --` followed by a brief whose header line is `<breadth>-role: diversity | acceptance: exact marker line` and whose body asks for exactly the line FUSION-SMOKE-CURSOR-OK or FUSION-SMOKE-DEVIN-OK, according to the selected breadth engine;
   - a `fusion:trivial-worker` brief in the `fusion-brief: v1` envelope with `context-mode: isolated` and `claude-fallback: claude-surface`, a goal of returning exactly the line FUSION-SMOKE-WORKER-OK, a scope of no file access, and an acceptance of the exact marker line.
3. Collect all five, then settle them in one `/fusion:stats` call carrying one `--record <id>=<verdict>` flag per probe: accepted only when the exact marker line came back, rejected otherwise.
4. Report one PASS or FAIL line per gate: version parity, codex dispatch and envelope, grok dispatch and sandbox handshake, agy dispatch and private Gemini directory, breadth dispatch and private home, worker dispatch and deliverable, settlement write. The codex, grok, agy, and breadth gates also require the lane default notice naming the filled model, and the breadth gate also requires the selected engine's isolation evidence: Cursor job records have `homeDir` under its `runs/` directory; Devin job records have `configDir` under its `runs/` directory and `devinVersion`. The agy gate requires `agyVersion`, `resolvedModel` from the Google family, `resolvedEffort`, `billingPool: subscription`, and private `gemini/agy/settings.json` and empty `gemini/config/mcp_config.json` under its data directory while keychain authentication uses the real `HOME`. A FAIL names the failing surface and advises holding real dispatches on that lane until repaired.

The wave is a probe, not work: never attach real packages to it, and never skip the settlement step, because the settlement write is itself one of the gates under test.
