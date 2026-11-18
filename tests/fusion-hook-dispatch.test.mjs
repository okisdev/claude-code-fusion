import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { mergeHookResults } from "../plugins/fusion/scripts/fusion-hook.mjs";
import { handleInlineDelegationHook, readAuditEvents } from "../plugins/fusion/scripts/inline-delegation-guard.mjs";
import { createWorkerRecord, updateWorkerRecord } from "../plugins/fusion/scripts/lib/worker-state.mjs";
import { hookResult, renderHookResult } from "../plugins/fusion/scripts/lib/lifecycle/output.mjs";
import { tagMessage } from "../plugins/fusion/scripts/lib/user-messages.mjs";
import { handleLifecycleHook, handlesLifecycleHook } from "../plugins/fusion/scripts/worker-lifecycle.mjs";

const root = path.resolve(import.meta.dirname, "..");
const scripts = Object.fromEntries(["worker-lifecycle", "inline-delegation-guard", "fusion-hook", "brief-sensor"].map((name) => [name, path.join(root, "plugins", "fusion", "scripts", `${name}.mjs`)]));
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

function run(script, input, env, args = []) {
  const result = spawnSync(process.execPath, [...args, scripts[script]], {
    input: JSON.stringify(input), env, encoding: "utf8", timeout: 30_000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status };
}

function moduleProbe(box, answers = null, failure = false) {
  const loads = path.join(box.dir, "loads.jsonl");
  const requests = path.join(box.dir, "requests.jsonl");
  const probe = path.join(box.dir, "probe.mjs");
  const source = `import fs from "node:fs";
export async function askJev(state, questions) {
  fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ state, questions }) + "\\n");
  ${failure ? 'throw new Error("classifier unavailable");' : `return ${JSON.stringify(answers)};`}
}`;
  fs.writeFileSync(probe, `import fs from "node:fs";
import { registerHooks } from "node:module";
registerHooks({ load(url, context, nextLoad) {
  fs.appendFileSync(${JSON.stringify(loads)}, JSON.stringify(url) + "\\n");
  if (url.endsWith("/lib/jev.mjs")) return { format: "module", shortCircuit: true, source: ${JSON.stringify(source)} };
  return nextLoad(url, context);
} });`);
  return {
    args: ["--import", probe],
    loads: () => fs.readFileSync(loads, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    requests: () => fs.existsSync(requests) ? fs.readFileSync(requests, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []
  };
}

function output(result) {
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
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
  const expected = renderHookResult(mergeHookResults(hookResult(output(lifecycle)), hookResult(output(guard))), input.hook_event_name);
  assert.deepEqual(output(dispatched), output({ stdout: expected }));
  return { lifecycle, guard, dispatched };
}

test("each shared matcher uses one dispatcher process and lifecycle-only tools keep their command", () => {
  const shared = {
    PreToolUse: ["Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit", "MultiEdit", "Bash", "Agent", "Task", "SendMessage", "TaskStop"],
    PostToolUse: ["Agent", "Task", "Bash", "SendMessage", "Edit", "Write", "NotebookEdit", "MultiEdit"],
    PostToolUseFailure: ["Edit", "Write", "NotebookEdit", "MultiEdit", "Bash"]
  };
  for (const [event, tools] of Object.entries(shared)) {
    for (const tool of tools) {
      const commands = hooks[event].filter((group) => group.matcher === "*" || new RegExp(group.matcher).test(tool)).flatMap((group) => group.hooks.map((hook) => hook.command));
      const pair = commands.filter((command) => /scripts\/(?:worker-lifecycle|inline-delegation-guard|fusion-hook)\.mjs/.test(command));
      assert.equal(pair.length, 1, `${event} ${tool}`);
      assert.match(pair[0], /scripts\/fusion-hook\.mjs/, `${event} ${tool}`);
      assert.ok(commands.every((command) => !command.includes("node ") || command.startsWith("command -v node >/dev/null 2>&1 || exit 0; ")));
      assert.equal(commands.length, 1, `${event} ${tool}`);
    }
    const other = hooks[event].filter((group) => group.matcher === "*" || new RegExp(group.matcher).test("Skill")).flatMap((group) => group.hooks.map((hook) => hook.command));
    assert.equal(other.length, 1, `${event} Skill`);
    assert.match(other[0], /scripts\/worker-lifecycle\.mjs/);
    if (event !== "PreToolUse") {
      const read = hooks[event].filter((group) => group.matcher === "*" || new RegExp(group.matcher).test("Read")).flatMap((group) => group.hooks.map((hook) => hook.command));
      assert.equal(read.length, 1, `${event} Read`);
      assert.match(read[0], /scripts\/worker-lifecycle\.mjs/);
    }
  }
});

test("startup and compact each use one session context process", () => {
  const startup = hooks.SessionStart.filter(({ matcher }) => matcher === "startup").flatMap(({ hooks }) => hooks);
  assert.equal(startup.length, 1);
  assert.equal(startup[0].command, 'command -v node >/dev/null 2>&1 || exit 0; node "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs"');
  const compact = hooks.SessionStart.filter(({ matcher }) => matcher === "compact").flatMap(({ hooks }) => hooks);
  assert.equal(compact.length, 1);
  assert.equal(compact[0].command, 'command -v node >/dev/null 2>&1 || exit 0; node "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs" --compact');
});

test("ignored tools and agent types load no lifecycle handlers or guard modules", (t) => {
  const box = sandbox(t);
  const probe = moduleProbe(box);
  const cases = [
    { hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: {} },
    { hook_event_name: "PreToolUse", tool_name: "Skill", agent_type: "general-purpose", tool_input: {} },
    { hook_event_name: "SubagentStart", agent_type: "Explore" },
    { hook_event_name: "SubagentStop", agent_type: "general-purpose" },
    { hook_event_name: "SessionStart" }
  ];
  for (const script of ["fusion-hook", "worker-lifecycle"]) {
    for (const input of cases) {
      const result = run(script, input, environment(box, "ignored"), probe.args);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }
  }
  const loaded = probe.loads();
  assert.ok(loaded.some((url) => url.endsWith("/worker-lifecycle.mjs")));
  assert.deepEqual(loaded.filter((url) => /\/lib\/(?:lifecycle\/(?!output\.mjs)|guard\/)|\/(?:inline-delegation-guard|brief-sensor)\.mjs$/.test(url)), []);
});

test("unhandled launch agent types skip lifecycle imports", (t) => {
  const box = sandbox(t);
  const probe = moduleProbe(box);
  for (const tool of ["Agent", "Task"]) {
    const input = payload(box, "PreToolUse", tool, { subagent_type: "general-purpose", prompt: "read a file" });
    assert.equal(handlesLifecycleHook(input), false);
    const result = run("worker-lifecycle", input, environment(box, "ignored-launch"), probe.args);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(probe.loads().filter((url) => /\/lib\/lifecycle\/(?!output\.mjs)/.test(url)), []);
  for (const agent_type of ["fast-worker", "fusion:fast-worker"]) {
    assert.equal(handlesLifecycleHook({ hook_event_name: "PreToolUse", tool_name: "Skill", agent_type }), false, agent_type);
  }
  for (const agent_type of ["claude-worker", "fusion:claude-worker", "trivial-worker", "fusion:trivial-worker", "deep-reasoner", "fusion:deep-reasoner", "job-collector", "fusion:job-collector"]) {
    assert.equal(handlesLifecycleHook({ hook_event_name: "PreToolUse", tool_name: "Skill", agent_type }), true, agent_type);
  }
});

test("a lifecycle denial never loads or calls the sensor", (t) => {
  const box = sandbox(t);
  const probe = moduleProbe(box, { unbounded: { noul: 0.95 } });
  for (const tool of ["Agent", "Task"]) {
    const input = payload(box, "PreToolUse", tool, { subagent_type: "codex:codex-rescue", prompt: "x".repeat(300), run_in_background: true });
    const result = run("fusion-hook", input, environment(box, "denied"), probe.args);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(output(result).hookSpecificOutput.permissionDecision, "deny");
  }
  assert.deepEqual(probe.requests(), []);
  assert.ok(probe.loads().every((url) => !url.endsWith("/brief-sensor.mjs") && !url.endsWith("/lib/jev.mjs")));
});

test("allowed peer dispatches preserve standalone output with and without sensor advice", (t) => {
  for (const tool of ["Agent", "Task"]) {
    for (const noul of [0.05, 0.95]) {
      const box = sandbox(t);
      const probe = moduleProbe(box, { unbounded: { noul } });
      const input = payload(box, "PreToolUse", tool, { subagent_type: "codex:codex-rescue", prompt: `lane: codex quick\nGoal: ${"x".repeat(300)}` });
      const reference = environment(box, "sensor-reference");
      const lifecycle = run("worker-lifecycle", input, reference, probe.args);
      const guard = run("inline-delegation-guard", input, reference, probe.args);
      const sensor = run("brief-sensor", input, reference, probe.args);
      const fused = run("fusion-hook", input, environment(box, "sensor-fused"), probe.args);
      const expected = mergeHookResults(mergeHookResults(hookResult(output(lifecycle)), hookResult(output(guard))), hookResult(output(sensor)));
      assert.equal(fused.exitCode, 0, fused.stderr);
      assert.equal(fused.stderr, lifecycle.stderr + guard.stderr + sensor.stderr);
      assert.equal(fused.stdout, renderHookResult(expected, input.hook_event_name));
      assert.equal(fused.stdout.trim().split("\n").length, 1);
      assert.deepEqual(output(fused).hookSpecificOutput.updatedInput, output(lifecycle).hookSpecificOutput.updatedInput);
      assert.equal(probe.requests().length, 2);
      assert.ok(probe.requests().every(({ state }) => state === input.tool_input.prompt));
      assert.equal(output(fused).hookSpecificOutput.additionalContext.includes("Jev flagged"), noul >= 0.7);
    }
  }
});

test("a sensor failure preserves the allowed lifecycle result", (t) => {
  const box = sandbox(t);
  const probe = moduleProbe(box, null, true);
  const input = payload(box, "PreToolUse", "Agent", { subagent_type: "codex:codex-rescue", prompt: `lane: codex quick\nGoal: ${"x".repeat(300)}` });
  const lifecycle = run("worker-lifecycle", input, environment(box, "failure-reference"), probe.args);
  const result = run("fusion-hook", input, environment(box, "failure-fused"), probe.args);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, lifecycle.stdout);
  assert.equal(result.stderr, lifecycle.stderr);
  assert.equal(probe.requests().length, 1);
});

test("dispatcher matches sequential standalone outputs for every shared matcher", (t) => {
  const box = sandbox(t);
  const edit = { file_path: path.join(box.cwd, "file.txt"), old_string: "old", new_string: "new" };
  const cases = [
    ["PreToolUse", "Read", { file_path: path.join(box.cwd, "file.txt") }],
    ["PreToolUse", "Edit", edit],
    ["PreToolUse", "Agent", { subagent_type: "codex:codex-rescue", prompt: "lane: codex quick\nGoal: test" }],
    ["PreToolUse", "SendMessage", { to: "unknown", message: "hello" }],
    ["PreToolUse", "TaskStop", { task_id: "unknown" }],
    ["PostToolUse", "Agent", { subagent_type: "generic", prompt: "hello" }],
    ["PostToolUse", "Edit", edit],
    ["PostToolUseFailure", "Edit", edit],
    ["PostToolUseFailure", "Bash", { command: "cat > src/x <<'EOF'\nx\nEOF" }]
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

test("a lifecycle-denied launch leaves guard and worker state unchanged", (t) => {
  for (const seeded of [false, true]) {
    const box = sandbox(t);
    const env = environment(box, "fused");
    if (seeded) run("fusion-hook", payload(box, "PreToolUse", "Agent", { subagent_type: "Explore", prompt: "read a file" }), env);
    const snapshot = () => fs.existsSync(path.join(box.dir, "fused"))
      ? Object.fromEntries(fs.readdirSync(path.join(box.dir, "fused"), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return [file, fs.readFileSync(file, "utf8")];
      }))
      : {};
    const before = snapshot();
    const input = payload(box, "PreToolUse", "Agent", { subagent_type: "codex:codex-rescue", prompt: "lane: codex quick\nGoal: test", run_in_background: true });
    input.tool_use_id = "denied-launch";
    const result = run("fusion-hook", input, env);
    assert.equal(output(result).hookSpecificOutput.permissionDecision, "deny");
    assert.match(output(result).hookSpecificOutput.permissionDecisionReason, /foreground/);
    assert.deepEqual(snapshot(), before);
    if (seeded) {
      const state = JSON.parse(fs.readFileSync(path.join(env.FUSION_INLINE_GUARD_STATE, "fusion-dispatch.json"), "utf8"));
      assert.ok(state.dispatchLog.every((entry) => entry.toolUseId !== input.tool_use_id));
    } else {
      for (const dir of [env.FUSION_INLINE_GUARD_STATE, env.FUSION_INLINE_GUARD_AUDIT_DIR, env.FUSION_WORKER_STATE_DIR, env.FUSION_DATA_DIR]) assert.equal(fs.existsSync(dir), false);
    }
  }
});

test("a repeated fused dispatch callback leaves state and audit unchanged", (t) => {
  const box = sandbox(t);
  const env = environment(box, "fused");
  const input = payload(box, "PreToolUse", "Agent", { subagent_type: "Explore", prompt: "read a file" });
  run("fusion-hook", input, env);
  const callback = { ...input, hook_event_name: "PostToolUse" };
  run("fusion-hook", callback, env);
  const file = path.join(env.FUSION_INLINE_GUARD_STATE, "fusion-dispatch.json");
  const before = fs.readFileSync(file, "utf8");
  const audit = readAuditEvents({ auditDir: env.FUSION_INLINE_GUARD_AUDIT_DIR });
  run("fusion-hook", callback, env);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(readAuditEvents({ auditDir: env.FUSION_INLINE_GUARD_AUDIT_DIR }), audit);
  assert.deepEqual(JSON.parse(before).dispatches, { builtin: 1 });
});

test("in-process handlers return output without writing to process streams", async (t) => {
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
    lifecycle = await handleLifecycleHook(lifecycleInput, environment(box, "handler"));
    guard = handleInlineDelegationHook(guardInput, environment(box, "handler", {}));
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  assert.deepEqual(streamed, []);
  assert.equal(lifecycle.decision, "allow");
  assert.ok(lifecycle.updatedInput.prompt);
  assert.deepEqual(guard, {});
  assert.equal(Object.hasOwn(lifecycle, "stdout"), false);
});

test("a guard denial wins over lifecycle output and retains its tagged reason", (t) => {
  const box = sandbox(t);
  const taskId = "fusion-reaped-dispatch";
  for (const variant of ["reference", "fused"]) {
    const env = environment(box, variant);
    createWorkerRecord({ taskId, sessionId: "fusion-dispatch", agentType: "fusion:claude-worker", workspaceRoot: box.cwd, limits: {} }, env);
    updateWorkerRecord(taskId, env, (record) => ({ ...record, transportStatus: "done", backgroundTaskId: taskId, outputFile: path.join(box.cwd, "result.txt") }));
  }
  const input = payload(box, "PreToolUse", "TaskStop", { task_id: taskId });
  const { guard, dispatched } = compare(box, input);
  assert.equal(output(dispatched).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(output(dispatched).hookSpecificOutput.permissionDecisionReason, output(guard).hookSpecificOutput.permissionDecisionReason);
  assert.match(output(dispatched).hookSpecificOutput.permissionDecisionReason, /\[fusion:\d+\]/);
});

test("the dispatcher retains Bash write charges on both failure callback forms", (t) => {
  for (const event of ["PostToolUseFailure", "PostToolUse"]) {
    const box = sandbox(t);
    const input = payload(box, "PreToolUse", "Bash", { command: "cat > src/x <<'EOF'\nnew\nEOF" });
    compare(box, input);
    const env = environment(box, "fused");
    const file = path.join(env.FUSION_INLINE_GUARD_STATE, "fusion-dispatch.json");
    const before = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(before.writeCount, 1);
    assert.equal(before.writeReplayTokens, 400_000);
    compare(box, { ...input, hook_event_name: event, tool_response: { exitCode: 1 } });
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.writeCount, 1);
    assert.equal(after.writesSinceDispatch, 1);
    assert.equal(after.writeReplayTokens, 400_000);
    assert.deepEqual(after.pendingWrites, []);
  }
});

test("dispatcher preserves replay token advisories for read tools and compound Bash reads", (t) => {
  for (const tool of ["Read", "Bash"]) {
    const box = sandbox(t);
    for (const variant of ["reference", "fused"]) {
      const dir = environment(box, variant).FUSION_INLINE_GUARD_STATE;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "fusion-dispatch.json"), JSON.stringify({ readStreakTurns: 4, readStreakReplayTokens: 1_600_000 }));
    }
    const input = payload(box, "PreToolUse", tool, tool === "Bash" ? { command: "sed -n 1,5p a; echo ---; grep x b" } : { file_path: path.join(box.cwd, "file.txt") });
    const { dispatched } = compare(box, input);
    assert.equal(output(dispatched).hookSpecificOutput.additionalContext, tagMessage("inline-guard.read-streak-advisory", "5 read only turns in a row replayed 2.0M tokens of context. Batch independent reads into one message, and send open ended reconnaissance to Explore."));
    const env = environment(box, "fused");
    const state = JSON.parse(fs.readFileSync(path.join(env.FUSION_INLINE_GUARD_STATE, "fusion-dispatch.json"), "utf8"));
    assert.equal(state.readStreakTurns, 5);
    assert.equal(state.readStreakReplayTokens, 2_000_000);
    const { events } = readAuditEvents({ auditDir: env.FUSION_INLINE_GUARD_AUDIT_DIR });
    assert.deepEqual(events.map((event) => event.event), ["replay", "warn"]);
    assert.equal(events[0].tool, tool);
    assert.equal(events[0].tokens, 400_000);
    assert.equal(events[1].replayTokens, 2_000_000);
    assert.equal(events[1].budget, 2_000_000);
  }
});

test("merger joins tagged context and system messages and keeps allowed input", () => {
  const lifecycleContext = tagMessage("worker-lifecycle.lane-default-injection", "lane filled");
  const guardContext = tagMessage("inline-guard.read-streak-advisory", "read streak reached");
  const lifecycle = { systemMessage: lifecycleContext, decision: "allow", updatedInput: { prompt: "filled" }, additionalContext: lifecycleContext };
  const guard = { systemMessage: guardContext, additionalContext: guardContext };
  const merged = mergeHookResults(lifecycle, guard);
  assert.equal(merged.additionalContext, `${lifecycleContext}\n${guardContext}`);
  assert.equal(merged.systemMessage, `${lifecycleContext}\n${guardContext}`);
  assert.deepEqual(merged.updatedInput, { prompt: "filled" });

  const reason = tagMessage("inline-guard.no-op-heartbeat-deny", "tasks are in flight");
  for (const results of [[lifecycle, { ...guard, decision: "deny", reason }], [{ decision: "deny", reason }, lifecycle]]) {
    const denied = mergeHookResults(...results);
    assert.equal(denied.decision, "deny");
    assert.equal(denied.reason, reason);
    assert.equal(denied.updatedInput, undefined);
    assert.deepEqual(JSON.parse(renderHookResult(denied, "PreToolUse")).hookSpecificOutput, {
      hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason, additionalContext: denied.additionalContext
    });
  }
  const blocked = mergeHookResults({ decision: "block", reason }, lifecycle);
  const rendered = JSON.parse(renderHookResult(blocked, "Stop"));
  assert.equal(rendered.decision, "block");
  assert.equal(rendered.reason, reason);
  assert.equal(rendered.hookSpecificOutput.updatedInput, undefined);
});
