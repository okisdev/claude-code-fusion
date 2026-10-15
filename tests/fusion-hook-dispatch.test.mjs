import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { mergeHookResults } from "../plugins/fusion/scripts/fusion-hook.mjs";
import { handleInlineDelegationHook } from "../plugins/fusion/scripts/inline-delegation-guard.mjs";
import { tagMessage } from "../plugins/fusion/scripts/lib/user-messages.mjs";
import { handleLifecycleHook } from "../plugins/fusion/scripts/worker-lifecycle.mjs";

const root = path.resolve(import.meta.dirname, "..");
const scripts = Object.fromEntries(["worker-lifecycle", "inline-delegation-guard", "fusion-hook"].map((name) => [name, path.join(root, "plugins", "fusion", "scripts", `${name}.mjs`)]));
const hooks = JSON.parse(fs.readFileSync(path.join(root, "plugins", "fusion", "hooks", "hooks.json"), "utf8")).hooks;

function sandbox(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-dispatch-test-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, "work");
  const transcript = path.join(dir, "transcript.jsonl");
  fs.mkdirSync(cwd);
  fs.writeFileSync(transcript, "");
  return { dir, cwd, transcript };
}

function environment(box, variant, extra = {}) {
  return {
    ...process.env,
    FUSION_WORKER_STATE_DIR: path.join(box.dir, variant, "workers"),
    FUSION_INLINE_GUARD_STATE: path.join(box.dir, variant, "guard"),
    FUSION_INLINE_GUARD_AUDIT_DIR: path.join(box.dir, variant, "audit"),
    FUSION_DATA_DIR: path.join(box.dir, variant, "data"),
    FUSION_MODEL_ROUTING: path.join(box.dir, "missing-routing.json"),
    ...extra
  };
}

function run(script, input, env) {
  const result = spawnSync(process.execPath, [scripts[script]], {
    input: JSON.stringify(input), env, encoding: "utf8", timeout: 30_000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
}

function output(result) {
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function expectedMerge(lifecycle, guard) {
  const first = output(lifecycle);
  const second = output(guard);
  const denial = [first, second].find((item) => item?.hookSpecificOutput?.permissionDecision === "deny");
  if (!first && !second) return null;
  const result = { ...first, ...second };
  const parts = [first?.hookSpecificOutput, second?.hookSpecificOutput].filter(Boolean);
  if (parts.length) {
    result.hookSpecificOutput = { ...first?.hookSpecificOutput, ...second?.hookSpecificOutput, ...denial?.hookSpecificOutput };
    if (denial) delete result.hookSpecificOutput.updatedInput;
    const contexts = parts.map((part) => part.additionalContext).filter(Boolean);
    if (contexts.length) result.hookSpecificOutput.additionalContext = contexts.join("\n");
  }
  const messages = [first?.systemMessage, second?.systemMessage].filter(Boolean);
  if (messages.length) result.systemMessage = messages.join("\n");
  return result;
}

function payload(box, hook_event_name, tool_name, tool_input) {
  return {
    hook_event_name, tool_name, tool_input, tool_use_id: `${hook_event_name}-${tool_name}`,
    session_id: "fusion-dispatch", cwd: box.cwd, transcript_path: box.transcript,
    tool_response: { success: true }
  };
}

function compare(box, input, extra = {}) {
  const reference = environment(box, "reference", extra);
  const fused = environment(box, "fused", extra);
  const lifecycle = run("worker-lifecycle", input, reference);
  const guard = run("inline-delegation-guard", input, reference);
  const dispatched = run("fusion-hook", input, fused);
  assert.equal(dispatched.exitCode, Math.max(lifecycle.exitCode, guard.exitCode));
  assert.equal(dispatched.stderr, lifecycle.stderr + guard.stderr);
  assert.deepEqual(output(dispatched), expectedMerge(lifecycle, guard));
  return { lifecycle, guard, dispatched };
}

test("each shared matcher uses one dispatcher process and lifecycle-only tools keep their command", () => {
  const shared = {
    PreToolUse: ["Edit", "Write", "NotebookEdit", "MultiEdit", "Bash", "Agent", "Task", "SendMessage", "TaskOutput", "TaskStop"],
    PostToolUse: ["Agent", "Task", "Bash", "SendMessage", "Edit", "Write", "NotebookEdit", "MultiEdit"],
    PostToolUseFailure: ["Edit", "Write", "NotebookEdit", "MultiEdit"]
  };
  for (const [event, tools] of Object.entries(shared)) {
    for (const tool of tools) {
      const commands = hooks[event].filter((group) => group.matcher === "*" || new RegExp(group.matcher).test(tool)).flatMap((group) => group.hooks.map((hook) => hook.command));
      const pair = commands.filter((command) => /scripts\/(?:worker-lifecycle|inline-delegation-guard|fusion-hook)\.mjs/.test(command));
      assert.equal(pair.length, 1, `${event} ${tool}`);
      assert.match(pair[0], /scripts\/fusion-hook\.mjs/, `${event} ${tool}`);
      assert.ok(commands.every((command) => !command.includes("node ") || command.startsWith("command -v node >/dev/null 2>&1 || exit 0; ")));
      if (event === "PreToolUse" && tool === "Agent") assert.ok(commands.some((command) => command.includes("brief-sensor.mjs")));
    }
    const other = hooks[event].filter((group) => group.matcher === "*" || new RegExp(group.matcher).test("Read")).flatMap((group) => group.hooks.map((hook) => hook.command));
    assert.equal(other.length, 1, `${event} Read`);
    assert.match(other[0], /scripts\/worker-lifecycle\.mjs/);
  }
});

test("dispatcher matches sequential standalone outputs for every shared matcher", (t) => {
  const box = sandbox(t);
  const edit = { file_path: path.join(box.cwd, "file.txt"), old_string: "old", new_string: "new" };
  const cases = [
    ["PreToolUse", "Edit", edit],
    ["PreToolUse", "Agent", { subagent_type: "codex:codex-rescue", prompt: "lane: codex quick\nGoal: test" }],
    ["PreToolUse", "SendMessage", { to: "unknown", message: "hello" }],
    ["PreToolUse", "TaskStop", { task_id: "unknown" }],
    ["PostToolUse", "Agent", { subagent_type: "generic", prompt: "hello" }],
    ["PostToolUse", "Edit", edit],
    ["PostToolUseFailure", "Edit", edit]
  ];
  for (const [event, tool, toolInput] of cases) {
    const input = payload(box, event, tool, toolInput);
    const { lifecycle, dispatched } = compare(box, input);
    if (event === "PreToolUse" && tool === "Agent") {
      assert.equal(output(dispatched).hookSpecificOutput.permissionDecision, "allow");
      assert.deepEqual(output(dispatched).hookSpecificOutput.updatedInput, output(lifecycle).hookSpecificOutput.updatedInput);
      assert.match(output(dispatched).hookSpecificOutput.additionalContext, /\[fusion:\d+\]/);
    }
  }
});

test("in-process handlers return output without writing to process streams", (t) => {
  const box = sandbox(t);
  const lifecycleInput = payload(box, "PreToolUse", "Agent", { subagent_type: "codex:codex-rescue", prompt: "lane: codex quick\nGoal: test" });
  const guardInput = payload(box, "PreToolUse", "Edit", { file_path: path.join(box.cwd, "file.txt"), old_string: "old", new_string: "new" });
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const streamed = [];
  let lifecycle;
  let guard;
  try {
    process.stdout.write = (chunk) => { streamed.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { streamed.push(String(chunk)); return true; };
    lifecycle = handleLifecycleHook(lifecycleInput, environment(box, "handler"));
    guard = handleInlineDelegationHook(guardInput, environment(box, "handler", { FUSION_POSTURE: "strict", FUSION_INLINE_WRITE_BUDGET: "1" }));
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  assert.deepEqual(streamed, []);
  assert.equal(output(lifecycle).hookSpecificOutput.permissionDecision, "allow");
  assert.match(output(guard).hookSpecificOutput.additionalContext, /\[fusion:\d+\]/);
  assert.equal(lifecycle.exitCode, 0);
  assert.equal(guard.exitCode, 0);
});

test("a guard denial wins over lifecycle output and retains its tagged reason", (t) => {
  const box = sandbox(t);
  const extra = { FUSION_POSTURE: "strict", FUSION_INLINE_WRITE_BUDGET: "1", FUSION_INLINE_ZERO_DISPATCH_WRITES: "0", FUSION_INLINE_TAIL_ALLOWANCE: "0" };
  const edit = { file_path: path.join(box.cwd, "file.txt"), old_string: "old", new_string: "new" };
  const first = payload(box, "PreToolUse", "Edit", edit);
  first.tool_use_id = "first";
  run("inline-delegation-guard", first, environment(box, "reference", extra));
  run("inline-delegation-guard", first, environment(box, "fused", extra));
  const { guard, dispatched } = compare(box, payload(box, "PreToolUse", "Edit", edit), extra);
  assert.equal(output(dispatched).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(output(dispatched).hookSpecificOutput.permissionDecisionReason, output(guard).hookSpecificOutput.permissionDecisionReason);
  assert.match(output(dispatched).hookSpecificOutput.permissionDecisionReason, /\[fusion:\d+\]/);
});

test("merger joins tagged context and system messages, keeps allow input, and uses severe exit code", () => {
  const lifecycleContext = tagMessage("worker-lifecycle.lane-default-injection", "lane filled");
  const guardContext = tagMessage("inline-guard.write-budget-advisory", "budget reached");
  const lifecycle = { stdout: `${JSON.stringify({ systemMessage: lifecycleContext, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { prompt: "filled" }, additionalContext: lifecycleContext } })}\n`, stderr: "first\n", exitCode: 0 };
  const guard = { stdout: `${JSON.stringify({ systemMessage: guardContext, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: guardContext } })}\n`, stderr: "second\n", exitCode: 2 };
  const merged = mergeHookResults(lifecycle, guard);
  assert.equal(output(merged).hookSpecificOutput.additionalContext, `${lifecycleContext}\n${guardContext}`);
  assert.equal(output(merged).systemMessage, `${lifecycleContext}\n${guardContext}`);
  assert.deepEqual(output(merged).hookSpecificOutput.updatedInput, { prompt: "filled" });
  assert.equal(merged.stderr, "first\nsecond\n");
  assert.equal(merged.exitCode, 2);

  const reason = tagMessage("inline-guard.write-budget-deny", "budget exhausted");
  const denied = mergeHookResults(lifecycle, { ...guard, stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })}\n` });
  assert.equal(output(denied).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(output(denied).hookSpecificOutput.permissionDecisionReason, reason);
  assert.equal(output(denied).hookSpecificOutput.updatedInput, undefined);
});
