---
name: smoke
description: Runs a three probe live smoke wave after a plugin update and reports gate chain health before real work rides it.
argument-hint: ''
when_to_use: After a plugin cache refresh or version update, before dispatching real delegated work.
allowed-tools: 'Agent, Bash, Read'
---

Verify the update landed, then prove the dispatch chain end to end with three tiny probes before real packages ride it.

1. Version parity: read `~/.claude/plugins/installed_plugins.json` and compare the fusion, codex, and grok entries against `.claude-plugin/marketplace.json` in this repository when present. Report each version pair; a mismatch is a FAIL naming the stale plugin.
2. Fan out three probes as parallel foreground Agent calls in one message: a `codex:codex-rescue` task passing `--model gpt-5.6-luna --effort low -- Reply with exactly this single line and nothing else: FUSION-SMOKE-CODEX-OK`; a `grok:grok-rescue` task whose direct prompt passes `--effort low --` followed by a brief whose header line is `grok-role: burst | effort low | acceptance: exact marker line` and whose body asks for exactly the line FUSION-SMOKE-GROK-OK; a `fusion:trivial-worker` brief in the `fusion-brief: v1` envelope with `context-mode: isolated`, a goal of returning exactly the line FUSION-SMOKE-WORKER-OK, a scope of no file access, and an acceptance of the exact marker line.
3. Collect all three, then settle them in one `/fusion:stats --record` call with one pair per probe: accepted only when the exact marker line came back, rejected otherwise.
4. Report one PASS or FAIL line per gate: version parity, codex dispatch and envelope, grok dispatch and sandbox handshake, worker dispatch and deliverable, settlement write. A FAIL names the failing surface and advises holding real dispatches on that lane until repaired.

The wave is a probe, not work: never attach real packages to it, and never skip the settlement step, because the settlement write is itself one of the gates under test.
