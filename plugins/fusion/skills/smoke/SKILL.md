---
name: smoke
description: Runs a four probe live smoke wave after a plugin update and reports gate chain health before real work rides it.
argument-hint: ''
when_to_use: After a plugin cache refresh or version update, before dispatching real delegated work.
allowed-tools: 'Agent, Bash, Read'
---

Verify the update landed, then prove the dispatch chain end to end with four tiny probes before real packages ride it.

1. Version parity: read `~/.claude/plugins/installed_plugins.json` and compare the fusion, codex, grok, cursor, and devin entries against `.claude-plugin/marketplace.json` in this repository when present. Report each version pair; a mismatch is a FAIL naming the stale plugin.
2. Read the selected breadth engine from the top level `breadth` key in `model-routing.json` (default `cursor`) and confirm the rendered routing table names it. Fan out four probes as parallel foreground Agent calls in one message. The three engine probes name no model, so the routing table's lane default fills it and the probe exercises that path too:
   - a `codex:codex-rescue` task whose direct prompt passes `--effort low --cwd "<absolute repository root>" --` followed by a brief whose header line is `lane: codex volume | effort low | acceptance: exact marker line` and whose body asks for exactly the line FUSION-SMOKE-CODEX-OK;
   - a `grok:grok-rescue` task whose direct prompt passes `--effort low --cwd "<absolute repository root>" --` followed by a brief whose header line is `grok-role: burst | effort low | acceptance: exact marker line` and whose body asks for exactly the line FUSION-SMOKE-GROK-OK;
   - a selected `<breadth>:<breadth>-rescue` task whose direct prompt passes `--cwd "<absolute repository root>" --` followed by a brief whose header line is `<breadth>-role: diversity | acceptance: exact marker line` and whose body asks for exactly the line FUSION-SMOKE-CURSOR-OK or FUSION-SMOKE-DEVIN-OK, according to the selected breadth engine;
   - a `fusion:trivial-worker` brief in the `fusion-brief: v1` envelope with `context-mode: isolated`, a goal of returning exactly the line FUSION-SMOKE-WORKER-OK, a scope of no file access, and an acceptance of the exact marker line.
3. Collect all four, then settle them in one `/fusion:stats` call carrying one `--record <id>=<verdict>` flag per probe: accepted only when the exact marker line came back, rejected otherwise.
4. Report one PASS or FAIL line per gate: version parity, codex dispatch and envelope, grok dispatch and sandbox handshake, breadth dispatch and private home, worker dispatch and deliverable, settlement write. The codex, grok, and breadth gates also require the lane default notice naming the filled model, and the breadth gate also requires the selected engine's isolation evidence: Cursor job records have `homeDir` under its `runs/` directory; Devin job records have `configDir` under its `runs/` directory and `devinVersion`. A FAIL names the failing surface and advises holding real dispatches on that lane until repaired.

The wave is a probe, not work: never attach real packages to it, and never skip the settlement step, because the settlement write is itself one of the gates under test.
