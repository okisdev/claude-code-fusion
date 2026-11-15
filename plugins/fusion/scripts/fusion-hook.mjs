#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleLifecycleHook, handlesLifecycleHook } from "./worker-lifecycle.mjs";
import { mergeHookResults, renderHookResult } from "./lib/lifecycle/output.mjs";

export { mergeHookResults } from "./lib/lifecycle/output.mjs";

const GUARD_TOOLS = new Set(["Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit", "MultiEdit", "Bash", "Agent", "Task", "SendMessage", "TaskOutput", "TaskStop"]);

export async function handleFusionHook(input, env = process.env) {
  if (!input) return {};
  const lifecycleHandled = handlesLifecycleHook(input);
  const guardHandled = ["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(input.hook_event_name) && GUARD_TOOLS.has(input.tool_name) && !(typeof input.agent_id === "string" && input.agent_id.length > 0);
  if (!lifecycleHandled && !guardHandled) return {};
  const lifecycle = lifecycleHandled ? await handleLifecycleHook(input, env) : {};
  if (input.hook_event_name === "PreToolUse" && lifecycle.decision === "deny") return lifecycle;
  let result = lifecycle;
  if (guardHandled) {
    const { handleInlineDelegationHook } = await import("./inline-delegation-guard.mjs");
    result = mergeHookResults(result, handleInlineDelegationHook(input, env));
  }
  if (input.hook_event_name === "PreToolUse" && ["Agent", "Task"].includes(input.tool_name) && result.decision !== "deny") {
    try {
      const { handleBriefSensor } = await import("./brief-sensor.mjs");
      result = mergeHookResults(result, await handleBriefSensor(input, env));
    } catch {
      void 0;
    }
  }
  return result;
}

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const input = readHookInput();
  const stdout = renderHookResult(await handleFusionHook(input), input?.hook_event_name);
  if (stdout) process.stdout.write(stdout);
}
