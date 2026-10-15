

let outputSink = (text) => process.stdout.write(text);

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
  outputSink(`${JSON.stringify(value)}\n`);
}

function getOutputSink() { return outputSink; }
function setOutputSink(sink) { outputSink = sink; }

export { hookOutput, blockStop, denyTool, writeOutput, getOutputSink, setOutputSink };
