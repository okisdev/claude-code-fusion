import os from "node:os";
import path from "node:path";

function engine(descriptor) {
  return Object.freeze({
    ...descriptor,
    managedAgents: Object.freeze([...descriptor.managedAgents]),
    stateEnvs: Object.freeze([...descriptor.stateEnvs]),
    roles: Object.freeze([...descriptor.roles]),
    efforts: Object.freeze([...descriptor.efforts])
  });
}

const ENGINES = Object.freeze({
  codex: engine({
    id: "codex",
    displayName: "Codex",
    family: "openai",
    rescueAgent: "codex:codex-rescue",
    managedAgents: [],
    companionFile: "codex-companion.mjs",
    companionEnv: "FUSION_CODEX_COMPANION",
    dataDirName: "codex-claude-code-fusion",
    dataEnv: "CODEX_COMPANION_DATA",
    stateEnvs: ["FUSION_CODEX_STATE", "FUSION_CODEX_STATE_DIR"],
    versionField: "codexVersion",
    verifiedVersionKey: "codex-cli",
    acceptanceLedger: true,
    ownMonitor: false,
    roles: ["quick", "volume", "flagship"],
    defaultRole: "quick",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    unavailablePrefix: "codex unavailable:"
  }),
  grok: engine({
    id: "grok",
    displayName: "Grok",
    family: "xai",
    rescueAgent: "grok:grok-rescue",
    managedAgents: ["grok:grok-review-runner"],
    companionFile: "grok-companion.mjs",
    companionEnv: "FUSION_GROK_COMPANION",
    dataDirName: "grok-claude-code-fusion",
    dataEnv: "GROK_COMPANION_DATA",
    stateEnvs: [],
    versionField: "grokVersion",
    verifiedVersionKey: "grok",
    acceptanceLedger: false,
    ownMonitor: true,
    roles: ["burst", "independence", "live-web", "large-context"],
    defaultRole: null,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    unavailablePrefix: "grok unavailable:"
  }),
  cursor: engine({
    id: "cursor",
    displayName: "Cursor",
    family: null,
    rescueAgent: "cursor:cursor-rescue",
    managedAgents: [],
    companionFile: "cursor-companion.mjs",
    companionEnv: "FUSION_CURSOR_COMPANION",
    dataDirName: "cursor-claude-code-fusion",
    dataEnv: "CURSOR_COMPANION_DATA",
    stateEnvs: [],
    versionField: "cursorVersion",
    verifiedVersionKey: "cursor",
    acceptanceLedger: false,
    ownMonitor: false,
    roles: ["diversity", "burst"],
    defaultRole: null,
    efforts: ["default", "low", "medium", "high", "xhigh", "max"],
    unavailablePrefix: "cursor unavailable:"
  })
});

const ENGINE_IDS = Object.freeze(Object.keys(ENGINES));
const ENGINE_ID_ALTERNATION = ENGINE_IDS.join("|");
const ENGINE_TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);
const PEER_RESCUE_AGENTS = new Set(ENGINE_IDS.map((id) => ENGINES[id].rescueAgent));
const PEER_MANAGED_AGENTS = new Set(ENGINE_IDS.flatMap((id) => ENGINES[id].managedAgents));
const PEER_JOB_FOOTER_AGENTS = new Set([...PEER_RESCUE_AGENTS, ...PEER_MANAGED_AGENTS]);
const PEER_RESCUE_AGENT_NAMES = withBareNames(PEER_RESCUE_AGENTS);
const PEER_MANAGED_AGENT_NAMES = withBareNames(PEER_MANAGED_AGENTS);
const ROLE_HEADER_LINES = 12;

function withBareNames(agents) {
  return new Set([...agents].flatMap((agent) => [agent, agent.slice(agent.indexOf(":") + 1)]));
}

function isEngineId(value) {
  return typeof value === "string" && Object.hasOwn(ENGINES, value);
}

function engineDisplayName(id) {
  return isEngineId(id) ? ENGINES[id].displayName : null;
}

function engineForAgentType(agentType) {
  if (typeof agentType !== "string") {
    return null;
  }
  return ENGINE_IDS.find((id) => {
    const { managedAgents, rescueAgent } = ENGINES[id];
    return [rescueAgent, ...managedAgents].some((agent) => agent === agentType || agent.slice(agent.indexOf(":") + 1) === agentType);
  }) ?? null;
}

function engineResultCommand(id, jobId) {
  return isEngineId(id) ? `/${id}:result ${jobId}` : null;
}

function engineIdChoices() {
  return new Intl.ListFormat("en", { type: "disjunction" }).format(ENGINE_IDS);
}

function engineDisplayNameList(type = "conjunction") {
  return new Intl.ListFormat("en", { type }).format(ENGINE_IDS.map((id) => ENGINES[id].displayName));
}

function absolutePath(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const trimmed = value.trim();
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : null;
}

function homeDir(env) {
  return absolutePath(env.HOME) ?? os.homedir();
}

function engineDataDir(id, env = process.env) {
  if (!isEngineId(id)) {
    return null;
  }
  const { dataDirName, dataEnv } = ENGINES[id];
  return absolutePath(env[dataEnv]) ?? path.join(homeDir(env), ".claude", "plugins", "data", dataDirName);
}

function engineStateRoots(id, env = process.env) {
  if (!isEngineId(id)) {
    return [];
  }
  for (const name of ENGINES[id].stateEnvs) {
    const override = absolutePath(env[name]);
    if (override) {
      return [override];
    }
  }
  return [path.join(engineDataDir(id, env), "state")];
}

function knownRole(value, roles) {
  const role = typeof value === "string" ? value.toLowerCase() : "";
  return roles.includes(role) ? role : null;
}

function engineRoleFromBrief(id, brief) {
  if (!isEngineId(id) || typeof brief !== "string") {
    return null;
  }
  const { defaultRole, roles } = ENGINES[id];
  const lines = brief.split(/\r?\n/).filter((line) => line.trim()).slice(0, ROLE_HEADER_LINES);
  const header = lines[0]?.trim() ?? "";
  const lane = knownRole(header.match(new RegExp(`^lane:\\s*${id}\\s+([a-z][a-z-]*)(?=$|[\\s;,|])`, "i"))?.[1], roles);
  if (lane) {
    return lane;
  }
  for (const line of lines) {
    const field = line.match(new RegExp(`(?:^|[\\s;,|])${id}-role:\\s*([^\\s;,|]+)`, "i"));
    if (field) {
      return knownRole(field[1], roles);
    }
  }
  return /^lane:/i.test(header) ? defaultRole : null;
}

export {
  ENGINES,
  ENGINE_IDS,
  ENGINE_ID_ALTERNATION,
  ENGINE_TERMINAL_STATUSES,
  PEER_JOB_FOOTER_AGENTS,
  PEER_MANAGED_AGENTS,
  PEER_MANAGED_AGENT_NAMES,
  PEER_RESCUE_AGENTS,
  PEER_RESCUE_AGENT_NAMES,
  engineDataDir,
  engineDisplayName,
  engineDisplayNameList,
  engineForAgentType,
  engineIdChoices,
  engineResultCommand,
  engineRoleFromBrief,
  engineStateRoots,
  isEngineId
};
