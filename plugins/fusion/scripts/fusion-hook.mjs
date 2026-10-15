#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleLifecycleHook } from "./worker-lifecycle.mjs";
import { handleInlineDelegationHook } from "./inline-delegation-guard.mjs";

function parseOutput(stdout) {
  return stdout.trim() ? JSON.parse(stdout) : null;
}

export function mergeHookResults(lifecycle, guard) {
  const first = parseOutput(lifecycle.stdout);
  const second = parseOutput(guard.stdout);
  const outputs = [first, second].filter(Boolean);
  const denial = outputs.find((output) => output.hookSpecificOutput?.permissionDecision === "deny" || output.decision === "block");
  let output = null;

  if (outputs.length > 0) {
    output = { ...first, ...second };
    const hookOutputs = outputs.map((item) => item.hookSpecificOutput).filter(Boolean);
    if (hookOutputs.length > 0) {
      const merged = { ...first?.hookSpecificOutput, ...second?.hookSpecificOutput, ...denial?.hookSpecificOutput };
      if (denial) delete merged.updatedInput;
      const contexts = hookOutputs.map((item) => item.additionalContext).filter((value) => typeof value === "string" && value.length > 0);
      if (contexts.length > 0) merged.additionalContext = contexts.join("\n");
      output.hookSpecificOutput = merged;
    }
    if (denial?.decision === "block") {
      output.decision = "block";
      output.reason = denial.reason;
    }
    const messages = outputs.map((item) => item.systemMessage).filter((value) => typeof value === "string" && value.length > 0);
    if (messages.length > 0) output.systemMessage = messages.join("\n");
  }

  return {
    stdout: output ? `${JSON.stringify(output)}\n` : "",
    stderr: `${lifecycle.stderr}${guard.stderr}`,
    exitCode: Math.max(lifecycle.exitCode, guard.exitCode)
  };
}

export function handleFusionHook(input, env = process.env) {
  if (!input) return { stdout: "", stderr: "", exitCode: 0 };
  return mergeHookResults(handleLifecycleHook(input, env), handleInlineDelegationHook(input, env));
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
  const result = handleFusionHook(readHookInput());
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
