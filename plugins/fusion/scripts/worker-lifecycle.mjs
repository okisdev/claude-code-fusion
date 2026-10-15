#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tagMessage } from "./lib/user-messages.mjs";
import { blockStop, denyTool, getOutputSink, setOutputSink, writeOutput } from "./lib/lifecycle/output.mjs";
import { handleSessionEnd } from "./lib/lifecycle/session.mjs";
import { handleStop } from "./lib/lifecycle/stop.mjs";
import { handleSubagentStart, handleSubagentStop } from "./lib/lifecycle/subagents.mjs";
import { handlePostToolUse, handlePreToolUse } from "./lib/lifecycle/tools.mjs";

// Collection writes now live in lib/lifecycle/notifications.mjs; see markWorkerCollected(refreshed, WORKER_COLLECTION_METHODS.TASK_NOTIFICATION, now).

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

function runHook(input, env = process.env) {
  switch (input.hook_event_name) {
    case "PreToolUse":
      handlePreToolUse(input, env);
      break;
    case "PostToolUse":
      handlePostToolUse(input, env, false);
      break;
    case "PostToolUseFailure":
      handlePostToolUse(input, env, true);
      break;
    case "SubagentStart":
      handleSubagentStart(input, env);
      break;
    case "SubagentStop":
      handleSubagentStop(input, env);
      break;
    case "Stop":
      handleStop(input, env);
      break;
    case "SessionEnd":
      handleSessionEnd(input, env);
      break;
    default:
      break;
  }
}

function executeHook(input, env = process.env) {
  if (!input) {
    return;
  }
  try {
    runHook(input, env);
  } catch {
    if (input.hook_event_name === "PreToolUse") {
      writeOutput(denyTool(tagMessage("worker-lifecycle.state-unavailable", "Fusion lifecycle state is unavailable. Retry after restoring private worker state access.")));
    } else if (input.hook_event_name === "Stop" || input.hook_event_name === "SubagentStop") {
      writeOutput(blockStop(tagMessage("worker-lifecycle.state-unavailable", "Fusion lifecycle state is unavailable. Restore private worker state access before ending this task.")));
    }
  }
}

function handleLifecycleHook(input, env = process.env) {
  let stdout = "";
  const previousSink = getOutputSink();
  setOutputSink((text) => { stdout += text; });
  try {
    executeHook(input, env);
    return { stdout, stderr: "", exitCode: 0 };
  } finally {
    setOutputSink(previousSink);
  }
}

function main() {
  executeHook(readHookInput());
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  main();
}

export { runHook, handleLifecycleHook };

export { workerLimits } from "./lib/lifecycle/budget.mjs";
export { validateWorkerBrief } from "./lib/lifecycle/dispatch.mjs";
export { workerBudgetFailure } from "./lib/lifecycle/budget.mjs";
export { settleOnlyRecords, reverifyInFlightRecords, runtimeTaskMissing, needsCancellation, reverifyCancellationRecords } from "./lib/lifecycle/stop.mjs";
