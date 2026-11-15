let outputSink = () => {};

function hookOutput(hookEventName, additionalContext) {
  return { hookSpecificOutput: { hookEventName, additionalContext } };
}

function blockStop(reason) {
  return { decision: "block", reason };
}

function denyTool(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function writeOutput(value) {
  outputSink(hookResult(value));
}

function hookResult(output) {
  const hook = output?.hookSpecificOutput;
  return {
    ...(hook?.permissionDecision || output?.decision ? { decision: hook?.permissionDecision ?? output.decision } : {}),
    ...(hook?.additionalContext !== undefined ? { additionalContext: hook.additionalContext } : {}),
    ...(output?.systemMessage !== undefined ? { systemMessage: output.systemMessage } : {}),
    ...(hook?.updatedInput !== undefined ? { updatedInput: hook.updatedInput } : {}),
    ...(hook?.permissionDecisionReason !== undefined || output?.reason !== undefined ? { reason: hook?.permissionDecisionReason ?? output.reason } : {})
  };
}

function mergeHookResults(first = {}, second = {}) {
  const denial = [first, second].find((result) => result.decision === "deny" || result.decision === "block");
  const result = { ...first, ...second, ...(denial ? { decision: denial.decision, reason: denial.reason } : {}) };
  if (denial) delete result.updatedInput;
  for (const key of ["additionalContext", "systemMessage"]) {
    const values = [first[key], second[key]].filter((value) => typeof value === "string" && value.length > 0);
    if (values.length > 0) result[key] = values.join("\n");
  }
  return result;
}

function collectHookResult(callback) {
  let result = {};
  const previousSink = outputSink;
  outputSink = (value) => { result = mergeHookResults(result, value); };
  try {
    callback();
    return result;
  } finally {
    outputSink = previousSink;
  }
}

function renderHookResult(result, hookEventName) {
  const output = {};
  if (result.decision === "block") {
    output.decision = "block";
    output.reason = result.reason;
  }
  if (result.decision === "allow" || result.decision === "deny" || result.additionalContext !== undefined || result.updatedInput !== undefined) {
    output.hookSpecificOutput = {
      hookEventName,
      ...(["allow", "deny"].includes(result.decision) ? { permissionDecision: result.decision } : {}),
      ...(result.decision === "deny" ? { permissionDecisionReason: result.reason } : {}),
      ...(result.updatedInput !== undefined && result.decision !== "deny" && result.decision !== "block" ? { updatedInput: result.updatedInput } : {}),
      ...(result.additionalContext !== undefined ? { additionalContext: result.additionalContext } : {})
    };
  }
  if (result.systemMessage !== undefined) output.systemMessage = result.systemMessage;
  return Object.keys(output).length > 0 ? `${JSON.stringify(output)}\n` : "";
}

export { hookOutput, blockStop, denyTool, writeOutput, hookResult, mergeHookResults, collectHookResult, renderHookResult };
