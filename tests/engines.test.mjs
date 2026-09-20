import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  ENGINES,
  ENGINE_IDS,
  ENGINE_ID_ALTERNATION,
  ENGINE_TERMINAL_STATUSES,
  PEER_JOB_FOOTER_AGENTS,
  PEER_MANAGED_AGENTS,
  PEER_MANAGED_AGENT_NAMES,
  PEER_RESCUE_AGENTS,
  PEER_RESCUE_AGENT_NAMES,
  engineDisplayName,
  engineDisplayNameList,
  engineForAgentType,
  engineIdChoices,
  engineResultCommand,
  isEngineId
} from "../plugins/fusion/scripts/lib/engines.mjs";

const repoRoot = path.join(import.meta.dirname, "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

test("engine constants and definitions are frozen", () => {
  assert.deepStrictEqual(ENGINE_IDS, ["codex", "grok"]);
  assert.strictEqual(ENGINE_ID_ALTERNATION, "codex|grok");
  assert.ok(Object.isFrozen(ENGINES));
  assert.ok(Object.isFrozen(ENGINE_IDS));

  for (const id of ENGINE_IDS) {
    assert.ok(Object.isFrozen(ENGINES[id]));
    assert.ok(Object.isFrozen(ENGINES[id].managedAgents));
  }
});

test("every engine definition has the registry shape", () => {
  for (const [id, engine] of Object.entries(ENGINES)) {
    for (const field of ["id", "displayName", "rescueAgent", "companionFile", "companionEnv", "dataDirName"]) {
      assert.strictEqual(typeof engine[field], "string");
      assert.ok(engine[field].length > 0);
    }
    assert.strictEqual(engine.id, id);
    assert.ok(Array.isArray(engine.managedAgents));
    assert.ok(engine.rescueAgent.startsWith(`${id}:`));
    for (const agent of engine.managedAgents) {
      assert.ok(agent.startsWith(`${id}:`));
    }
  }
});

test("engine terminal statuses are exact", () => {
  assert.deepStrictEqual(ENGINE_TERMINAL_STATUSES, new Set(["done", "error", "cancelled"]));
});

test("peer agent sets are exact", () => {
  assert.deepStrictEqual(PEER_RESCUE_AGENTS, new Set(["codex:codex-rescue", "grok:grok-rescue"]));
  assert.deepStrictEqual(PEER_MANAGED_AGENTS, new Set(["grok:grok-review-runner"]));
  assert.deepStrictEqual(PEER_JOB_FOOTER_AGENTS, new Set(["codex:codex-rescue", "grok:grok-rescue", "grok:grok-review-runner"]));
  assert.deepStrictEqual(PEER_RESCUE_AGENT_NAMES, new Set(["codex:codex-rescue", "codex-rescue", "grok:grok-rescue", "grok-rescue"]));
  assert.deepStrictEqual(PEER_MANAGED_AGENT_NAMES, new Set(["grok:grok-review-runner", "grok-review-runner"]));
});

test("isEngineId accepts only registered engine ids", () => {
  for (const value of ["codex", "grok"]) {
    assert.strictEqual(isEngineId(value), true);
  }
  for (const value of ["claude", "", null, undefined, 1, "toString", "constructor"]) {
    assert.strictEqual(isEngineId(value), false);
  }
});

test("engineDisplayName maps registered engines", () => {
  assert.strictEqual(engineDisplayName("codex"), "Codex");
  assert.strictEqual(engineDisplayName("grok"), "Grok");
  for (const value of ["claude", "", null, undefined]) {
    assert.strictEqual(engineDisplayName(value), null);
  }
});

test("engineForAgentType maps qualified peer agents", () => {
  assert.strictEqual(engineForAgentType("codex:codex-rescue"), "codex");
  assert.strictEqual(engineForAgentType("grok:grok-rescue"), "grok");
  assert.strictEqual(engineForAgentType("grok:grok-review-runner"), "grok");
  for (const value of ["grok-rescue", "fusion:claude-worker", undefined]) {
    assert.strictEqual(engineForAgentType(value), null);
  }
});

test("engineResultCommand formats only registered engine commands", () => {
  assert.strictEqual(engineResultCommand("codex", "abc"), "/codex:result abc");
  assert.strictEqual(engineResultCommand("unknown", "abc"), null);
});

test("engine display lists use the requested conjunction", () => {
  assert.strictEqual(engineIdChoices(), "codex or grok");
  assert.strictEqual(engineDisplayNameList(), "Codex and Grok");
  assert.strictEqual(engineDisplayNameList("disjunction"), "Codex or Grok");
});

test("engine definitions match plugin files and marketplace entries", () => {
  const marketplace = readJson(".claude-plugin/marketplace.json");

  for (const id of ENGINE_IDS) {
    const engine = ENGINES[id];
    const rescueAgentName = engine.rescueAgent.slice(engine.rescueAgent.indexOf(":") + 1);
    assert.ok(fs.existsSync(path.join(repoRoot, "plugins", id, "agents", `${rescueAgentName}.md`)));
    assert.ok(fs.existsSync(path.join(repoRoot, "plugins", id, "scripts", engine.companionFile)));
    for (const managedAgent of engine.managedAgents) {
      const managedAgentName = managedAgent.slice(managedAgent.indexOf(":") + 1);
      assert.ok(fs.existsSync(path.join(repoRoot, "plugins", id, "agents", `${managedAgentName}.md`)));
    }
    assert.ok(marketplace.plugins.some(({ name }) => name === id));
  }
});

test("peer footer matchers cover every registered peer agent", () => {
  const hooks = readJson("plugins/fusion/hooks/hooks.json").hooks;
  const footerAgents = [...PEER_JOB_FOOTER_AGENTS];
  let matchingBlockCount = 0;

  for (const [event, blocks] of Object.entries(hooks)) {
    for (const block of blocks) {
      if (typeof block.matcher !== "string" || !footerAgents.some((agent) => block.matcher.includes(agent))) {
        continue;
      }
      matchingBlockCount += 1;
      for (const agent of footerAgents) {
        assert.ok(new RegExp(block.matcher).test(agent), `${event} matcher does not match ${agent}: ${block.matcher}`);
      }
    }
  }

  assert.ok(matchingBlockCount > 0);
  assert.ok(hooks.SubagentStop.some((block) => typeof block.matcher === "string" && footerAgents.some((agent) => block.matcher.includes(agent))));
});

test("engine-prefixed hook matcher tokens are registered peer agents", () => {
  const hooks = readJson("plugins/fusion/hooks/hooks.json").hooks;
  const tokenPattern = /\b([A-Za-z0-9_]+:[A-Za-z0-9-]+)\b/g;

  for (const [event, blocks] of Object.entries(hooks)) {
    for (const block of blocks) {
      if (typeof block.matcher !== "string") {
        continue;
      }
      for (const match of block.matcher.matchAll(tokenPattern)) {
        const [token] = match;
        const prefix = token.slice(0, token.indexOf(":"));
        if (isEngineId(prefix)) {
          assert.ok(PEER_JOB_FOOTER_AGENTS.has(token), `${event} matcher contains unknown peer agent ${token}`);
        }
      }
    }
  }
});

test("fusion scripts take engine identity from the registry", () => {
  const scriptsDir = path.join(repoRoot, "plugins", "fusion", "scripts");
  const registry = path.join(scriptsDir, "lib", "engines.mjs");
  const agents = [...PEER_JOB_FOOTER_AGENTS].map((agent) => `"${agent}"`);
  const dataDirs = ENGINE_IDS.map((id) => `"${ENGINES[id].dataDirName}"`);
  const literals = [...agents, ...dataDirs, `(${ENGINE_ID_ALTERNATION})`, JSON.stringify(ENGINE_IDS).replace(",", ", ")];
  const files = fs.readdirSync(scriptsDir, { recursive: true }).filter((name) => name.endsWith(".mjs")).map((name) => path.join(scriptsDir, name));

  for (const file of files.filter((candidate) => candidate !== registry)) {
    const source = fs.readFileSync(file, "utf8");
    for (const literal of literals) {
      assert.ok(!source.includes(literal), `${path.relative(repoRoot, file)} repeats the engine literal ${literal}`);
    }
  }
});
