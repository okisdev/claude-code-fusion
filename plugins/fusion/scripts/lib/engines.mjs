const ENGINES = Object.freeze({
  codex: Object.freeze({
    id: "codex",
    displayName: "Codex",
    rescueAgent: "codex:codex-rescue",
    managedAgents: Object.freeze([]),
    companionFile: "codex-companion.mjs",
    companionEnv: "FUSION_CODEX_COMPANION",
    dataDirName: "codex-claude-code-fusion"
  }),
  grok: Object.freeze({
    id: "grok",
    displayName: "Grok",
    rescueAgent: "grok:grok-rescue",
    managedAgents: Object.freeze(["grok:grok-review-runner"]),
    companionFile: "grok-companion.mjs",
    companionEnv: "FUSION_GROK_COMPANION",
    dataDirName: "grok-claude-code-fusion"
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
  return ENGINE_IDS.find((id) => ENGINES[id].rescueAgent === agentType || ENGINES[id].managedAgents.includes(agentType)) ?? null;
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
  engineDisplayName,
  engineDisplayNameList,
  engineForAgentType,
  engineIdChoices,
  engineResultCommand,
  isEngineId
};
