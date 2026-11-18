#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PEER_JOB_FOOTER_AGENTS, PEER_RESCUE_AGENT_NAMES } from "./lib/engines.mjs";
import { tagMessage } from "./lib/user-messages.mjs";
import { blockStop, collectHookResult, denyTool, renderHookResult, writeOutput } from "./lib/lifecycle/output.mjs";

const FUSION_WORKER_AGENT = /^(?:fusion:)?(?:claude-worker|trivial-worker|deep-reasoner|job-collector)$/;
const HANDLERS = {
  PreToolUse: ["tools", "handlePreToolUse"],
  PostToolUse: ["tools", "handlePostToolUse"],
  PostToolUseFailure: ["tools", "handlePostToolUse"],
  SubagentStart: ["subagents", "handleSubagentStart"],
  SubagentStop: ["subagents", "handleSubagentStop"],
  Stop: ["stop", "handleStop"],
  SessionEnd: ["session", "handleSessionEnd"]
};

function handlesLifecycleHook(input) {
  if (!input) return false;
  const worker = FUSION_WORKER_AGENT.test(input.agent_type);
  const peer = PEER_JOB_FOOTER_AGENTS.has(input.agent_type);
  const launch = ["Agent", "Task"].includes(input.tool_name);
  const agentType = input.tool_input?.subagent_type;
  const managedLaunch = FUSION_WORKER_AGENT.test(agentType) || PEER_RESCUE_AGENT_NAMES.has(agentType);
  const message = input.tool_name === "SendMessage" && typeof input.tool_input?.to === "string";
  const taskControl = input.tool_name === "TaskStop";
  switch (input.hook_event_name) {
    case "PreToolUse":
      if (launch) return managedLaunch || (agentType === "Explore" && !Object.hasOwn(input.tool_input, "model"));
      return worker || (input.tool_name === "SubagentHandback" && PEER_RESCUE_AGENT_NAMES.has(input.agent_type)) || message || (!input.agent_id && taskControl && typeof input.tool_input?.task_id === "string");
    case "PostToolUse":
    case "PostToolUseFailure":
      if (message || (launch && input.hook_event_name === "PostToolUseFailure")) return true;
      if (!input.agent_id && launch) return managedLaunch;
      return worker || peer || (!input.agent_id && (taskControl || input.tool_name === "Read"));
    case "SubagentStart":
      return worker;
    case "SubagentStop":
      return worker || peer;
    case "Stop":
    case "SessionEnd":
      return true;
    default:
      return false;
  }
}

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function handleLifecycleHook(input, env = process.env) {
  if (!handlesLifecycleHook(input)) return {};
  let handler;
  try {
    const [module, name] = HANDLERS[input.hook_event_name];
    const handlers = await import(`./lib/lifecycle/${module}.mjs`);
    handler = handlers[name];
  } catch (error) {
    handler = () => { throw error; };
  }
  return collectHookResult(() => {
    try {
      handler(input, env, input.hook_event_name === "PostToolUseFailure");
    } catch {
      if (input.hook_event_name === "PreToolUse") {
        writeOutput(denyTool(tagMessage("worker-lifecycle.state-unavailable", "Fusion lifecycle state is unavailable. Retry after restoring private worker state access.")));
      } else if (input.hook_event_name === "Stop" || input.hook_event_name === "SubagentStop") {
        writeOutput(blockStop(tagMessage("worker-lifecycle.state-unavailable", "Fusion lifecycle state is unavailable. Restore private worker state access before ending this task.")));
      }
    }
  });
}

async function main() {
  const input = readHookInput();
  const stdout = renderHookResult(await handleLifecycleHook(input), input?.hook_event_name);
  if (stdout) process.stdout.write(stdout);
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  await main();
}

export { handleLifecycleHook, handlesLifecycleHook };
