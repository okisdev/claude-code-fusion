import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  BREADTH_ENGINE_IDS,
  DEFAULT_BREADTH_ENGINE,
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
  engineDataDir,
  engineResultCommand,
  engineRoleFromBrief,
  engineStateRoots,
  isEngineId,
  routedEngineIds
} from "../plugins/fusion/scripts/lib/engines.mjs";

const repoRoot = path.join(import.meta.dirname, "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

test("engine constants and definitions are frozen", () => {
  assert.deepStrictEqual(ENGINE_IDS, ["codex", "grok", "cursor", "devin"]);
  assert.deepStrictEqual(BREADTH_ENGINE_IDS, ["cursor", "devin"]);
  assert.strictEqual(DEFAULT_BREADTH_ENGINE, "cursor");
  assert.deepStrictEqual(routedEngineIds(), ["codex", "grok", "cursor"]);
  assert.deepStrictEqual(routedEngineIds("devin"), ["codex", "grok", "devin"]);
  assert.strictEqual(ENGINE_ID_ALTERNATION, "codex|grok|cursor|devin");
  assert.ok(Object.isFrozen(ENGINES));
  assert.ok(Object.isFrozen(ENGINE_IDS));
  assert.ok(Object.isFrozen(BREADTH_ENGINE_IDS));

  for (const id of ENGINE_IDS) {
    assert.ok(Object.isFrozen(ENGINES[id]));
    assert.ok(Object.isFrozen(ENGINES[id].managedAgents));
    assert.ok(Object.isFrozen(ENGINES[id].stateEnvs));
    assert.ok(Object.isFrozen(ENGINES[id].roles));
    assert.ok(Object.isFrozen(ENGINES[id].efforts));
  }
});

test("every engine definition has the registry shape", () => {
  for (const [id, engine] of Object.entries(ENGINES)) {
    for (const field of ["id", "displayName", "rescueAgent", "companionFile", "companionEnv", "dataDirName"]) {
      assert.strictEqual(typeof engine[field], "string");
      assert.ok(engine[field].length > 0);
    }
    assert.strictEqual(engine.id, id);
    assert.strictEqual(engine.seat, BREADTH_ENGINE_IDS.includes(id) ? "breadth" : null);
    assert.ok(Array.isArray(engine.managedAgents));
    assert.ok(engine.rescueAgent.startsWith(`${id}:`));
    for (const agent of engine.managedAgents) {
      assert.ok(agent.startsWith(`${id}:`));
    }
  }
});

test("Devin registry contract matches the breadth companion", () => {
  const devin = ENGINES.devin;
  assert.deepStrictEqual({
    displayName: devin.displayName,
    family: devin.family,
    rescueAgent: devin.rescueAgent,
    managedAgents: devin.managedAgents,
    companionFile: devin.companionFile,
    companionEnv: devin.companionEnv,
    dataDirName: devin.dataDirName,
    dataEnv: devin.dataEnv,
    stateEnvs: devin.stateEnvs,
    versionField: devin.versionField,
    verifiedVersionKey: devin.verifiedVersionKey,
    acceptanceLedger: devin.acceptanceLedger,
    ownMonitor: devin.ownMonitor,
    roles: devin.roles,
    defaultRole: devin.defaultRole,
    efforts: devin.efforts,
    unavailablePrefix: devin.unavailablePrefix
  }, {
    displayName: "Devin", family: null, rescueAgent: "devin:devin-rescue", managedAgents: [],
    companionFile: "devin-companion.mjs", companionEnv: "FUSION_DEVIN_COMPANION",
    dataDirName: "devin-claude-code-fusion", dataEnv: "DEVIN_COMPANION_DATA", stateEnvs: [],
    versionField: "devinVersion", verifiedVersionKey: "devin", acceptanceLedger: false, ownMonitor: false,
    roles: ["diversity", "burst"], defaultRole: null,
    efforts: ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"],
    unavailablePrefix: "devin unavailable:"
  });
});

test("engine terminal statuses are exact", () => {
  assert.deepStrictEqual(ENGINE_TERMINAL_STATUSES, new Set(["done", "error", "cancelled"]));
});

test("peer agent sets are exact", () => {
  assert.deepStrictEqual(PEER_RESCUE_AGENTS, new Set(["codex:codex-rescue", "grok:grok-rescue", "cursor:cursor-rescue", "devin:devin-rescue"]));
  assert.deepStrictEqual(PEER_MANAGED_AGENTS, new Set(["grok:grok-review-runner"]));
  assert.deepStrictEqual(PEER_JOB_FOOTER_AGENTS, new Set(["codex:codex-rescue", "grok:grok-rescue", "cursor:cursor-rescue", "devin:devin-rescue", "grok:grok-review-runner"]));
  assert.deepStrictEqual(PEER_RESCUE_AGENT_NAMES, new Set(["codex:codex-rescue", "codex-rescue", "grok:grok-rescue", "grok-rescue", "cursor:cursor-rescue", "cursor-rescue", "devin:devin-rescue", "devin-rescue"]));
  assert.deepStrictEqual(PEER_MANAGED_AGENT_NAMES, new Set(["grok:grok-review-runner", "grok-review-runner"]));
});

test("isEngineId accepts only registered engine ids", () => {
  for (const value of ["codex", "grok", "cursor", "devin"]) {
    assert.strictEqual(isEngineId(value), true);
  }
  for (const value of ["claude", "", null, undefined, 1, "toString", "constructor"]) {
    assert.strictEqual(isEngineId(value), false);
  }
});

test("engineDisplayName maps registered engines", () => {
  assert.strictEqual(engineDisplayName("codex"), "Codex");
  assert.strictEqual(engineDisplayName("grok"), "Grok");
  assert.strictEqual(engineDisplayName("cursor"), "Cursor");
  assert.strictEqual(engineDisplayName("devin"), "Devin");
  for (const value of ["claude", "", null, undefined]) {
    assert.strictEqual(engineDisplayName(value), null);
  }
});

test("engineForAgentType maps qualified and bare peer agents", () => {
  assert.strictEqual(engineForAgentType("codex:codex-rescue"), "codex");
  assert.strictEqual(engineForAgentType("grok:grok-rescue"), "grok");
  assert.strictEqual(engineForAgentType("grok:grok-review-runner"), "grok");
  assert.strictEqual(engineForAgentType("cursor:cursor-rescue"), "cursor");
  assert.strictEqual(engineForAgentType("devin:devin-rescue"), "devin");
  assert.strictEqual(engineForAgentType("codex-rescue"), "codex");
  assert.strictEqual(engineForAgentType("grok-review-runner"), "grok");
  assert.strictEqual(engineForAgentType("cursor-rescue"), "cursor");
  assert.strictEqual(engineForAgentType("devin-rescue"), "devin");
  for (const value of ["fusion:claude-worker", "claude-worker", "rescue", undefined]) {
    assert.strictEqual(engineForAgentType(value), null);
  }
});

test("engine state roots and data dirs follow the registry overrides", () => {
  assert.deepStrictEqual(engineStateRoots("codex", { HOME: "/h" }), ["/h/.claude/plugins/data/codex-claude-code-fusion/state"]);
  assert.deepStrictEqual(engineStateRoots("codex", { HOME: "/h", FUSION_CODEX_STATE: "/s", CODEX_COMPANION_DATA: "/d" }), ["/s"]);
  assert.deepStrictEqual(engineStateRoots("codex", { HOME: "/h", FUSION_CODEX_STATE: "relative", CODEX_COMPANION_DATA: "/d" }), ["/d/state"]);
  assert.deepStrictEqual(engineStateRoots("grok", { HOME: "/h", GROK_COMPANION_DATA: "/g" }), ["/g/state"]);
  assert.strictEqual(engineDataDir("cursor", { HOME: "/h" }), "/h/.claude/plugins/data/cursor-claude-code-fusion");
  assert.deepStrictEqual(engineStateRoots("cursor", { HOME: "/h", CURSOR_COMPANION_DATA: "/c" }), ["/c/state"]);
  assert.strictEqual(engineDataDir("devin", { HOME: "/h" }), "/h/.claude/plugins/data/devin-claude-code-fusion");
  assert.deepStrictEqual(engineStateRoots("devin", { HOME: "/h", DEVIN_COMPANION_DATA: "/d" }), ["/d/state"]);
  assert.deepStrictEqual(engineStateRoots("unknown", { HOME: "/h" }), []);
  assert.strictEqual(engineDataDir("unknown", { HOME: "/h" }), null);
});

test("engineRoleFromBrief reads lane headers and role fields per engine", () => {
  assert.strictEqual(engineRoleFromBrief("codex", "lane: codex flagship | verification: npm test"), "flagship");
  assert.strictEqual(engineRoleFromBrief("codex", "lane: codex | verification: npm test"), "quick");
  assert.strictEqual(engineRoleFromBrief("codex", "lane: panel | grok-role: independence"), "quick");
  assert.strictEqual(engineRoleFromBrief("grok", "lane: panel | grok-role: independence"), "independence");
  assert.strictEqual(engineRoleFromBrief("grok", "lane: grok burst"), "burst");
  assert.strictEqual(engineRoleFromBrief("grok", "lane: panel"), null);
  assert.strictEqual(engineRoleFromBrief("cursor", "lane: cursor diversity | acceptance: cited"), "diversity");
  assert.strictEqual(engineRoleFromBrief("cursor", "goal: x\ncursor-role: burst"), "burst");
  assert.strictEqual(engineRoleFromBrief("cursor", "cursor-role: unknown"), null);
  assert.strictEqual(engineRoleFromBrief("cursor", "lane: panel | grok-role: independence"), null);
  assert.strictEqual(engineRoleFromBrief("devin", "lane: devin diversity | acceptance: cited"), "diversity");
  assert.strictEqual(engineRoleFromBrief("devin", "goal: x\ndevin-role: burst"), "burst");
  assert.strictEqual(engineRoleFromBrief("devin", "lane: panel | cursor-role: diversity"), null);
  assert.strictEqual(engineRoleFromBrief("unknown", "lane: x"), null);
});

test("engineResultCommand formats only registered engine commands", () => {
  assert.strictEqual(engineResultCommand("codex", "abc"), "/codex:result abc");
  assert.strictEqual(engineResultCommand("unknown", "abc"), null);
});

test("engine display lists use the requested conjunction", () => {
  assert.strictEqual(engineIdChoices(), "codex, grok, cursor, or devin");
  assert.strictEqual(engineDisplayNameList(), "Codex, Grok, Cursor, and Devin");
  assert.strictEqual(engineDisplayNameList("disjunction"), "Codex, Grok, Cursor, or Devin");
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
