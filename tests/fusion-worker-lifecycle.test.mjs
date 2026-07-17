import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { recordCodexAcceptance } from "../plugins/fusion/scripts/fusion-stats.mjs";
import { readWorkerRecords, recordWorkerAcceptance, updateWorkerRecord } from "../plugins/fusion/scripts/lib/worker-state.mjs";
import { workerLimits } from "../plugins/fusion/scripts/worker-lifecycle.mjs";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "plugins", "fusion", "scripts", "worker-lifecycle.mjs");

function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-worker-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "repo");
  const state = path.join(root, "workers");
  const transcript = path.join(root, "parent.jsonl");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(transcript, "", "utf8");
  return { root, cwd, state, transcript };
}

function envFor(box, extra = {}) {
  return { ...process.env, FUSION_WORKER_STATE_DIR: box.state, ...extra };
}

function run(box, payload, extra = {}) {
  return spawnSync(process.execPath, [script], { input: JSON.stringify(payload), encoding: "utf8", env: envFor(box, extra) });
}

function brief() {
  return "fusion-brief: v1\ncontext-mode: isolated\ngoal: implement one fix\nscope: src/a.ts\nverification: node --test\n";
}

function collectorPrompt(engine, jobId) {
  return `engine: ${engine}\njob: ${jobId}\n`;
}

function dispatch(box, overrides = {}) {
  return {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    tool_use_id: "tool-1",
    transcript_path: box.transcript,
    cwd: box.cwd,
    tool_name: "Agent",
    tool_input: { subagent_type: "fusion:fast-worker", description: "fix a", prompt: brief(), ...overrides }
  };
}

function record(box) {
  const records = readWorkerRecords(envFor(box));
  assert.strictEqual(records.length, 1);
  return records[0];
}

test("fast worker limits raise the default budgets and retain environment overrides", () => {
  assert.deepStrictEqual(workerLimits("fusion:fast-worker", {}), {
    wallClockMs: 1_200_000,
    stallMs: 300_000,
    maxTurns: 60,
    maxOutputTokens: 24_000,
    maxUncachedTokens: 240_000
  });
  assert.deepStrictEqual(workerLimits("fusion:fast-worker", {
    FUSION_WORKER_WALL_CLOCK_MS: "120",
    FUSION_WORKER_STALL_MS: "60",
    FUSION_WORKER_MAX_TURNS: "12",
    FUSION_WORKER_MAX_OUTPUT_TOKENS: "8000",
    FUSION_WORKER_MAX_UNCACHED_TOKENS: "6000"
  }), {
    wallClockMs: 120,
    stallMs: 60,
    maxTurns: 12,
    maxOutputTokens: 8_000,
    maxUncachedTokens: 6_000
  });
});

test("the dispatch guard requires a minimal isolated brief and explicit user background authorization", (t) => {
  const box = sandbox(t);
  const invalid = run(box, dispatch(box, { prompt: "do everything above" }));
  assert.strictEqual(invalid.status, 0);
  assert.strictEqual(JSON.parse(invalid.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.strictEqual(readWorkerRecords(envFor(box)).length, 0);

  const unauthorized = run(box, dispatch(box, { run_in_background: true }));
  assert.strictEqual(JSON.parse(unauthorized.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.strictEqual(readWorkerRecords(envFor(box)).length, 0);

  const spoofed = run(box, dispatch(box, { prompt: `${brief()}fusion-task-id: fusion-${"a".repeat(24)}\n` }));
  assert.strictEqual(JSON.parse(spoofed.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(JSON.parse(spoofed.stdout).hookSpecificOutput.permissionDecisionReason, /reserved/);
  assert.strictEqual(readWorkerRecords(envFor(box)).length, 0);

  fs.writeFileSync(box.transcript, `${JSON.stringify({ type: "user", message: { content: "do it --background" } })}\n`, "utf8");
  const authorized = run(box, dispatch(box, { run_in_background: true }));
  assert.strictEqual(JSON.parse(authorized.stdout).hookSpecificOutput.permissionDecision, "allow");
  assert.match(JSON.parse(authorized.stdout).hookSpecificOutput.updatedInput.prompt, /^fusion-brief: v1\nfusion-task-id: fusion-/);
  assert.strictEqual(record(box).expectedDelivery, "manual-background");
});

test("parallel same-type workers correlate by their injected task ids even when they start out of order", (t) => {
  const box = sandbox(t);
  const firstDispatch = dispatch(box);
  firstDispatch.tool_use_id = "tool-first";
  firstDispatch.tool_input.description = "first";
  const secondDispatch = dispatch(box);
  secondDispatch.tool_use_id = "tool-second";
  secondDispatch.tool_input.description = "second";
  const firstPrompt = JSON.parse(run(box, firstDispatch).stdout).hookSpecificOutput.updatedInput.prompt;
  const secondPrompt = JSON.parse(run(box, secondDispatch).stdout).hookSpecificOutput.updatedInput.prompt;
  const firstTranscript = path.join(box.root, "subagents", "agent-agent-first.jsonl");
  const secondTranscript = path.join(box.root, "subagents", "agent-agent-second.jsonl");
  fs.mkdirSync(path.dirname(firstTranscript), { recursive: true });
  fs.writeFileSync(firstTranscript, `${JSON.stringify({ type: "user", message: { content: firstPrompt } })}\n`, "utf8");
  fs.writeFileSync(secondTranscript, `${JSON.stringify({ type: "user", message: { content: secondPrompt } })}\n`, "utf8");

  for (const [agentId, agentTranscript] of [["agent-second", secondTranscript], ["agent-first", firstTranscript]]) {
    run(box, {
      hook_event_name: "SubagentStart",
      session_id: "session-1",
      cwd: box.cwd,
      transcript_path: box.transcript,
      agent_transcript_path: agentTranscript,
      agent_id: agentId,
      agent_type: "fusion:fast-worker"
    });
  }

  const byDispatch = new Map(readWorkerRecords(envFor(box)).map((worker) => [worker.dispatchToolUseId, worker]));
  assert.strictEqual(byDispatch.get("tool-first").agentId, "agent-first");
  assert.strictEqual(byDispatch.get("tool-second").agentId, "agent-second");
});

test("peer wrapper Agents reject runtime background mode while the managed review runner remains exempt", (t) => {
  const box = sandbox(t);
  for (const subagentType of ["codex:codex-rescue", "grok:grok-rescue"]) {
    const payload = dispatch(box, { subagent_type: subagentType, prompt: "bounded peer brief", run_in_background: true });
    const result = run(box, payload);
    assert.strictEqual(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /foreground delivery/);
  }
  const managed = run(box, dispatch(box, { subagent_type: "grok:grok-review-runner", prompt: "review", run_in_background: true }));
  assert.strictEqual(managed.stdout, "");
  assert.strictEqual(readWorkerRecords(envFor(box)).length, 0);
});

test("an unexpected async peer wrapper remains owned until TaskOutput collects it", (t) => {
  const box = sandbox(t);
  const peerDispatch = dispatch(box, { subagent_type: "codex:codex-rescue", prompt: "bounded peer brief" });
  run(box, peerDispatch);
  run(box, {
    ...peerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "peer-async" }
  });
  assert.strictEqual(record(box).transportStatus, "pending_async");

  const blocked = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  assert.strictEqual(JSON.parse(blocked.stdout).decision, "block");
  assert.match(JSON.parse(blocked.stdout).reason, /TaskOutput with block=true.*peer-async/);

  run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "TaskOutput",
    tool_input: { task_id: "peer-async", block: false },
    tool_response: { status: "completed", content: "peer result" }
  });
  assert.strictEqual(record(box).transportStatus, "pending_async");

  run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "TaskOutput",
    tool_input: { task_id: "peer-async", block: true },
    tool_response: { status: "completed", content: "peer result" }
  });
  assert.strictEqual(record(box).transportStatus, "done");
  assert.strictEqual(record(box).collectionMethod, "TaskOutput");
  assert.ok(record(box).collectedAt);
  const collectedAt = record(box).collectedAt;

  run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "TaskOutput",
    tool_input: { task_id: "peer-async", block: true },
    tool_response: { status: "completed", content: "peer result" }
  });
  assert.strictEqual(record(box).collectionMethod, "TaskOutput");
  assert.strictEqual(record(box).collectedAt, collectedAt);
});

test("lifecycle enforcement fails closed when private worker state is unavailable", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(box.state, "not a directory", "utf8");
  const denied = run(box, dispatch(box));
  assert.strictEqual(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /state is unavailable/);

  const blocked = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  assert.strictEqual(JSON.parse(blocked.stdout).decision, "block");
  assert.match(JSON.parse(blocked.stdout).reason, /state is unavailable/);

  const corruptBox = sandbox(t);
  fs.mkdirSync(path.join(corruptBox.state, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(corruptBox.state, "jobs", "corrupt.json"), "{", "utf8");
  const corrupt = run(corruptBox, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: corruptBox.cwd,
    transcript_path: corruptBox.transcript,
    background_tasks: []
  });
  assert.strictEqual(JSON.parse(corrupt.stdout).decision, "block");
  assert.match(JSON.parse(corrupt.stdout).reason, /state is unavailable/);

  const corruptWorkerTool = run(corruptBox, {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    cwd: corruptBox.cwd,
    transcript_path: corruptBox.transcript,
    agent_id: "agent-corrupt",
    agent_type: "fusion:fast-worker",
    tool_name: "Read",
    tool_input: { file_path: "src/a.ts" }
  });
  assert.strictEqual(JSON.parse(corruptWorkerTool.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(JSON.parse(corruptWorkerTool.stdout).hookSpecificOutput.permissionDecisionReason, /state is unavailable/);
});

test("structured async Agent responses establish an owned task and Stop blocks until collection", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box));
  const task = record(box);
  const outputFile = path.join(box.root, "tasks", "agent-a1.output");
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, "", "utf8");
  run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "a1", outputFile, resolvedModel: "claude-sonnet-5" }
  });
  const pending = record(box);
  assert.strictEqual(pending.taskId, task.taskId);
  assert.strictEqual(pending.agentId, "a1");
  assert.strictEqual(pending.backgroundTaskId, "a1");
  assert.strictEqual(pending.transportStatus, "pending_async");
  assert.strictEqual(pending.resolvedModel, "claude-sonnet-5");

  const stop = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: "done",
    background_tasks: [{ id: "a1", type: "subagent", status: "running", agent_type: "fusion:fast-worker" }]
  });
  const decision = JSON.parse(stop.stdout);
  assert.strictEqual(decision.decision, "block");
  assert.match(decision.reason, /TaskOutput with block=true/);
  assert.match(decision.reason, /unverified/);
});

test("a completed async worker remains owned after it leaves the runtime registry until its output is read", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box));
  const outputFile = path.join(box.root, "tasks", "agent-collected.output");
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, "completed result\ndelivery: complete\nverification: passed\n", "utf8");
  run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "agent-collected", outputFile }
  });
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "agent-collected",
    agent_type: "fusion:fast-worker"
  });
  run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_transcript_path: outputFile,
    agent_id: "agent-collected",
    agent_type: "fusion:fast-worker",
    stop_hook_active: false,
    last_assistant_message: "completed result\ndelivery: complete\nverification: passed"
  });
  assert.strictEqual(record(box).transportStatus, "ready_uncollected");

  const blocked = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: "done",
    background_tasks: []
  });
  assert.strictEqual(JSON.parse(blocked.stdout).decision, "block");
  assert.match(JSON.parse(blocked.stdout).reason, /Read the completed output file/);

  for (const partial of [{ offset: 1 }, { limit: 1 }]) {
    run(box, {
      hook_event_name: "PostToolUse",
      session_id: "session-1",
      cwd: box.cwd,
      transcript_path: box.transcript,
      tool_name: "Read",
      tool_input: { file_path: outputFile, ...partial },
      tool_response: { content: "completed" }
    });
    assert.strictEqual(record(box).transportStatus, "ready_uncollected");
  }

  run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "Read",
    tool_input: { file_path: outputFile },
    tool_response: { content: "completed result" }
  });
  assert.strictEqual(record(box).transportStatus, "done");
  const allowed = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: "done",
    background_tasks: []
  });
  assert.match(JSON.parse(allowed.stdout).hookSpecificOutput.additionalContext, /Acceptance remains unverified for 1 collected Fusion worker/);
});

test("foreground structured usage is canonical and transport completion remains unverified", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box));
  run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: {
      status: "completed",
      agentId: "fg1",
      resolvedModel: "claude-sonnet-5",
      totalTokens: 116,
      totalDurationMs: 1200,
      totalToolUseCount: 3,
      usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 6 }
    }
  });
  const completed = record(box);
  assert.strictEqual(completed.transportStatus, "done");
  assert.strictEqual(completed.acceptance, "unverified");
  assert.strictEqual(completed.usageSource, "tool-response");
  assert.deepStrictEqual(completed.usage, {
    inputTokens: 10,
    cacheCreationInputTokens: 20,
    cacheReadInputTokens: 80,
    outputTokens: 6,
    totalTokens: 116,
    uncachedTokens: 36
  });
  assert.strictEqual(completed.toolCalls, 3);
});

test("Stop advises on collected unverified workers without blocking and stays quiet after acceptance", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box));
  run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: { status: "completed", agentId: "advisory-1" }
  });
  const completed = record(box);
  assert.ok(completed.collectedAt);
  assert.strictEqual(completed.collectionMethod, "Agent");

  const advisory = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  const output = JSON.parse(advisory.stdout);
  assert.strictEqual(output.decision, undefined);
  assert.match(output.hookSpecificOutput.additionalContext, /Acceptance remains unverified for 1 collected Fusion worker/);
  assert.match(output.hookSpecificOutput.additionalContext, /\/fusion:stats --record-worker-acceptance <task-id> accepted --source main-loop/);

  recordWorkerAcceptance({ taskId: completed.taskId, acceptance: "accepted", env: envFor(box), source: "main-loop" });
  const quiet = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  assert.strictEqual(quiet.stdout, "");
});

test("nested structured Agent responses retain their canonical usage", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box));
  run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: {
      toolUseResult: {
        status: "completed",
        agentId: "nested-1",
        totalTokens: 9,
        totalToolUseCount: 2,
        usage: { input_tokens: 4, cache_creation_input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 2 }
      }
    }
  });
  const completed = record(box);
  assert.strictEqual(completed.usageSource, "tool-response");
  assert.strictEqual(completed.usage.totalTokens, 9);
  assert.strictEqual(completed.toolCalls, 2);
});

test("SubagentStop blocks one incomplete report and then records a verified transport result as unverified", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box));
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "agent-1",
    agent_type: "fusion:fast-worker"
  });
  const first = run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_transcript_path: path.join(box.root, "subagents", "agent-agent-1.jsonl"),
    agent_id: "agent-1",
    agent_type: "fusion:fast-worker",
    stop_hook_active: false,
    last_assistant_message: "summary\ndelivery: complete\nverification: passed\nI will run tests next"
  });
  assert.strictEqual(JSON.parse(first.stdout).decision, "block");
  assert.strictEqual(record(box).retryCount, 1);

  const second = run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_transcript_path: path.join(box.root, "subagents", "agent-agent-1.jsonl"),
    agent_id: "agent-1",
    agent_type: "fusion:fast-worker",
    stop_hook_active: true,
    last_assistant_message: "summary\ndelivery: complete\nverification: passed"
  });
  assert.strictEqual(second.stdout, "");
  assert.strictEqual(record(box).transportStatus, "done");
  assert.strictEqual(record(box).acceptance, "unverified");
  assert.strictEqual(record(box).collectionMethod, "SubagentStop");
  assert.ok(record(box).collectedAt);
  const collectedAt = record(box).collectedAt;
  run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_transcript_path: path.join(box.root, "subagents", "agent-agent-1.jsonl"),
    agent_id: "agent-1",
    agent_type: "fusion:fast-worker",
    stop_hook_active: true,
    last_assistant_message: "summary\ndelivery: complete\nverification: passed"
  });
  assert.strictEqual(record(box).collectionMethod, "SubagentStop");
  assert.strictEqual(record(box).collectedAt, collectedAt);
});

test("an acceptance brief uses the analysis completion contract", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box, {
    subagent_type: "fusion:trivial-worker",
    prompt: "fusion-brief: v1\ncontext-mode: isolated\ngoal: inspect one file\nscope: src/a.ts\nacceptance: identify the behavior\n"
  }));
  assert.strictEqual(record(box).completionContract, "coverage");
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "analysis-1",
    agent_type: "fusion:trivial-worker"
  });
  const stopped = run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "analysis-1",
    agent_type: "fusion:trivial-worker",
    stop_hook_active: false,
    last_assistant_message: "analysis result\ndelivery: complete\ncoverage: complete"
  });
  assert.strictEqual(stopped.stdout, "");
  assert.strictEqual(record(box).transportStatus, "done");
});

test("job collector completion requires a terminal marker and fails closed on the legacy unstructured marker", (t) => {
  const box = sandbox(t);
  const peerJobId = "a".repeat(32);
  run(box, dispatch(box, { subagent_type: "fusion:job-collector", prompt: collectorPrompt("codex", peerJobId) }));
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "collector-1",
    agent_type: "fusion:job-collector"
  });
  const incomplete = run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "collector-1",
    agent_type: "fusion:job-collector",
    stop_hook_active: false,
    last_assistant_message: "state: done\ncollector: state=done job=job-1\nextra narration"
  });
  assert.strictEqual(JSON.parse(incomplete.stdout).decision, "block");

  const stopped = run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "collector-1",
    agent_type: "fusion:job-collector",
    stop_hook_active: true,
    last_assistant_message: "state: done\ncollector: state=done job=job-1"
  });
  assert.strictEqual(stopped.stdout, "");
  assert.strictEqual(record(box).transportStatus, "incomplete");
  assert.strictEqual(record(box).failureKind, "collection_protocol");
  assert.strictEqual(record(box).peerJobId, undefined);
  assert.strictEqual(record(box).retryCount, 1);
});

test("job collector dispatch requires and persists one closed peer identity", (t) => {
  const box = sandbox(t);
  const invalid = run(box, dispatch(box, { subagent_type: "fusion:job-collector", prompt: `engine: codex\nengine: grok\njob: ${"a".repeat(32)}\n` }));
  assert.strictEqual(JSON.parse(invalid.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.strictEqual(readWorkerRecords(envFor(box)).length, 0);

  const peerJobId = "b".repeat(32);
  const valid = run(box, dispatch(box, { subagent_type: "fusion:job-collector", prompt: collectorPrompt("codex", peerJobId) }));
  assert.strictEqual(JSON.parse(valid.stdout).hookSpecificOutput.permissionDecision, "allow");
  assert.strictEqual(record(box).expectedPeerEngine, "codex");
  assert.strictEqual(record(box).expectedPeerJobId, peerJobId);
});

test("a collector marker for a different peer identity fails closed", (t) => {
  const box = sandbox(t);
  const expectedJobId = "8".repeat(32);
  const reportedJobId = "9".repeat(32);
  run(box, dispatch(box, { subagent_type: "fusion:job-collector", prompt: collectorPrompt("codex", expectedJobId) }));
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "collector-mismatch",
    agent_type: "fusion:job-collector"
  });
  const retry = run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "collector-mismatch",
    agent_type: "fusion:job-collector",
    stop_hook_active: false,
    last_assistant_message: `result from another job\ncollector: state=done semantic=unverified engine=codex job=${reportedJobId} elapsed=2s`
  });
  assert.strictEqual(JSON.parse(retry.stdout).decision, "block");
  assert.match(JSON.parse(retry.stdout).reason, new RegExp(expectedJobId));
  assert.strictEqual(record(box).transportStatus, "running");
  assert.strictEqual(record(box).retryCount, 1);

  const exhausted = run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "collector-mismatch",
    agent_type: "fusion:job-collector",
    stop_hook_active: false,
    last_assistant_message: `result from another job again\ncollector: state=done semantic=unverified engine=codex job=${reportedJobId} elapsed=3s`
  });
  assert.strictEqual(exhausted.stdout, "");
  const collector = record(box);
  assert.strictEqual(collector.transportStatus, "incomplete");
  assert.strictEqual(collector.failureKind, "collection_protocol");
  assert.strictEqual(collector.expectedPeerEngine, "codex");
  assert.strictEqual(collector.expectedPeerJobId, expectedJobId);
  assert.strictEqual(collector.peerEngine, undefined);
  assert.strictEqual(collector.peerJobId, undefined);

  const blockedStop = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    last_assistant_message: "finished",
    background_tasks: []
  });
  assert.strictEqual(JSON.parse(blockedStop.stdout).decision, "block");
  assert.match(JSON.parse(blockedStop.stdout).reason, new RegExp(expectedJobId));

  const reportedStop = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    last_assistant_message: `Fusion collector ${collector.taskId} failed for ${expectedJobId}; the result remains uncollected. Use /codex:result ${expectedJobId}.`,
    background_tasks: []
  });
  assert.strictEqual(reportedStop.stdout, "");
  assert.ok(record(box).protocolReportedAt);
});

test("a structured Codex collection remains gated until the main loop records a semantic judgment", (t) => {
  const box = sandbox(t);
  const peerJobId = "c".repeat(32);
  run(box, dispatch(box, { subagent_type: "fusion:job-collector", prompt: collectorPrompt("codex", peerJobId) }));
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "collector-semantic",
    agent_type: "fusion:job-collector"
  });
  const stopped = run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "collector-semantic",
    agent_type: "fusion:job-collector",
    stop_hook_active: false,
    last_assistant_message: `Codex transport completed, but the task still needs verification.\ncollector: state=done semantic=unverified engine=codex job=${peerJobId} elapsed=3s`
  });
  assert.strictEqual(stopped.stdout, "");
  assert.strictEqual(record(box).transportStatus, "done");
  assert.strictEqual(record(box).peerJobId, peerJobId);
  assert.strictEqual(record(box).peerTransportStatus, "done");
  assert.strictEqual(record(box).peerSemanticStatus, "unverified");
  assert.strictEqual(record(box).acceptanceRecordedAt, undefined);

  const blocked = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    last_assistant_message: "finished",
    background_tasks: []
  });
  assert.strictEqual(JSON.parse(blocked.stdout).decision, "block");
  assert.match(JSON.parse(blocked.stdout).reason, new RegExp(peerJobId));
  assert.match(JSON.parse(blocked.stdout).reason, /accepted\|rejected\|unverified/);

  recordCodexAcceptance({
    jobId: peerJobId,
    acceptance: "rejected",
    workspaceRoot: box.cwd,
    env: envFor(box, { FUSION_DATA_DIR: path.join(box.root, "fusion-data") }),
    sessionId: "session-1",
    source: "main-loop",
    reason: "verification did not pass"
  });
  assert.strictEqual(record(box).acceptance, "rejected");
  assert.ok(record(box).acceptanceRecordedAt);

  const allowed = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    last_assistant_message: "reported rejected delivery",
    background_tasks: []
  });
  assert.strictEqual(allowed.stdout, "");
});

test("a structured Grok collection remains gated until the main loop records a semantic judgment", (t) => {
  const box = sandbox(t);
  const peerJobId = "8".repeat(32);
  run(box, dispatch(box, { subagent_type: "fusion:job-collector", prompt: collectorPrompt("grok", peerJobId) }));
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "collector-grok-semantic",
    agent_type: "fusion:job-collector"
  });
  run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "collector-grok-semantic",
    agent_type: "fusion:job-collector",
    stop_hook_active: false,
    last_assistant_message: `Grok transport completed, but the task still needs verification.\ncollector: state=done semantic=unverified engine=grok job=${peerJobId} elapsed=3s`
  });
  const collector = record(box);

  const blocked = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    last_assistant_message: "finished",
    background_tasks: []
  });
  assert.strictEqual(JSON.parse(blocked.stdout).decision, "block");
  assert.match(JSON.parse(blocked.stdout).reason, new RegExp(collector.taskId));
  assert.match(JSON.parse(blocked.stdout).reason, /record-worker-acceptance/);

  recordWorkerAcceptance({ taskId: collector.taskId, acceptance: "accepted", env: envFor(box), source: "main-loop" });
  const allowed = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    last_assistant_message: "reported accepted delivery",
    background_tasks: []
  });
  assert.strictEqual(allowed.stdout, "");
});

test("an unrecognized collector engine requires manual resolution before Stop", (t) => {
  const box = sandbox(t);
  const peerJobId = "9".repeat(32);
  run(box, dispatch(box, { subagent_type: "fusion:job-collector", prompt: collectorPrompt("codex", peerJobId) }));
  const collector = record(box);
  updateWorkerRecord(collector.taskId, envFor(box), (current) => ({
    ...current,
    transportStatus: "done",
    peerEngine: "unknown",
    peerJobId,
    peerTransportStatus: "done",
    peerSemanticStatus: "unverified"
  }));

  const blocked = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    last_assistant_message: "finished",
    background_tasks: []
  });
  const reason = JSON.parse(blocked.stdout).reason;
  assert.strictEqual(JSON.parse(blocked.stdout).decision, "block");
  assert.match(reason, new RegExp(collector.taskId));
  assert.match(reason, /collection for Fusion task .* needs manual resolution/);
  assert.doesNotMatch(reason, /record-worker-acceptance/);
});

test("an authorized background worker cannot bypass an unjudged Codex collection", (t) => {
  const box = sandbox(t);
  const peerJobId = "7".repeat(32);
  const collectorDispatch = dispatch(box, { subagent_type: "fusion:job-collector", prompt: collectorPrompt("codex", peerJobId) });
  collectorDispatch.tool_use_id = "tool-collector-gate";
  run(box, collectorDispatch);
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "collector-gate",
    agent_type: "fusion:job-collector"
  });
  run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "collector-gate",
    agent_type: "fusion:job-collector",
    stop_hook_active: false,
    last_assistant_message: `collected result\ncollector: state=done semantic=unverified engine=codex job=${peerJobId} elapsed=1s`
  });

  fs.writeFileSync(box.transcript, `${JSON.stringify({ type: "user", message: { content: "keep the independent worker running --background" } })}\n`, "utf8");
  const backgroundDispatch = dispatch(box, { run_in_background: true });
  backgroundDispatch.tool_use_id = "tool-authorized-background";
  run(box, backgroundDispatch);
  const backgroundRecord = readWorkerRecords(envFor(box)).find((candidate) => candidate.agentType === "fusion:fast-worker");
  assert.ok(backgroundRecord);

  const blocked = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    last_assistant_message: `Background task ${backgroundRecord.taskId} remains available.`,
    background_tasks: [{ id: "authorized-background", type: "subagent", status: "running", agent_type: "fusion:fast-worker" }]
  });
  assert.strictEqual(JSON.parse(blocked.stdout).decision, "block");
  assert.match(JSON.parse(blocked.stdout).reason, new RegExp(peerJobId));
  assert.match(JSON.parse(blocked.stdout).reason, /semantic judgment/);
});

test("collector judgment gates do not age an unrelated active worker toward cancellation", (t) => {
  const box = sandbox(t);
  const peerJobId = "6".repeat(32);
  const collectorDispatch = dispatch(box, { subagent_type: "fusion:job-collector", prompt: collectorPrompt("codex", peerJobId) });
  collectorDispatch.tool_use_id = "tool-collector-independent";
  run(box, collectorDispatch);
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "collector-independent",
    agent_type: "fusion:job-collector"
  });
  run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "collector-independent",
    agent_type: "fusion:job-collector",
    stop_hook_active: false,
    last_assistant_message: `collected result\ncollector: state=done semantic=unverified engine=codex job=${peerJobId} elapsed=1s`
  });

  const workerDispatch = dispatch(box);
  workerDispatch.tool_use_id = "tool-worker-independent";
  run(box, workerDispatch);
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "worker-independent",
    agent_type: "fusion:fast-worker"
  });
  const workerTaskId = readWorkerRecords(envFor(box)).find((candidate) => candidate.agentId === "worker-independent").taskId;

  for (let attempt = 0; attempt < 7; attempt += 1) {
    const blocked = run(box, {
      hook_event_name: "Stop",
      session_id: "session-1",
      cwd: box.cwd,
      transcript_path: box.transcript,
      last_assistant_message: "finished",
      background_tasks: [{ id: "worker-independent", type: "subagent", status: "running", agent_type: "fusion:fast-worker" }]
    });
    assert.strictEqual(JSON.parse(blocked.stdout).decision, "block");
  }
  const worker = readWorkerRecords(envFor(box)).find((candidate) => candidate.taskId === workerTaskId);
  assert.strictEqual(worker.stopBlockCount, 0);
  assert.notStrictEqual(worker.transportStatus, "cancel_requested");
});

test("structured collector timeout, dead, and status error outcomes stay incomplete", (t) => {
  for (const [outcome, failureKind] of [["timeout", "collection_timeout"], ["dead", "collection_dead"], ["status-error", "collection_status_error"]]) {
    const box = sandbox(t);
    const peerJobId = outcome === "timeout" ? "d".repeat(32) : outcome === "dead" ? "e".repeat(32) : "f".repeat(32);
    run(box, dispatch(box, { subagent_type: "fusion:job-collector", prompt: collectorPrompt("codex", peerJobId) }));
    run(box, {
      hook_event_name: "SubagentStart",
      session_id: "session-1",
      cwd: box.cwd,
      transcript_path: box.transcript,
      agent_id: `collector-${outcome}`,
      agent_type: "fusion:job-collector"
    });
    run(box, {
      hook_event_name: "SubagentStop",
      session_id: "session-1",
      cwd: box.cwd,
      transcript_path: box.transcript,
      agent_id: `collector-${outcome}`,
      agent_type: "fusion:job-collector",
      stop_hook_active: false,
      last_assistant_message: `state: running\ncollector: ${outcome} engine=codex job=${peerJobId} elapsed=540s`
    });
    assert.strictEqual(record(box).transportStatus, "incomplete");
    assert.strictEqual(record(box).failureKind, failureKind);
    const collector = record(box);
    assert.strictEqual(collector.peerJobId, peerJobId);

    const blocked = run(box, {
      hook_event_name: "Stop",
      session_id: "session-1",
      cwd: box.cwd,
      transcript_path: box.transcript,
      last_assistant_message: "finished",
      background_tasks: []
    });
    assert.strictEqual(JSON.parse(blocked.stdout).decision, "block");
    assert.match(JSON.parse(blocked.stdout).reason, new RegExp(collector.taskId));
    assert.match(JSON.parse(blocked.stdout).reason, new RegExp(`/codex:result ${peerJobId}`));

    const reported = run(box, {
      hook_event_name: "Stop",
      session_id: "session-1",
      cwd: box.cwd,
      transcript_path: box.transcript,
      last_assistant_message: `Fusion collector ${collector.taskId} failed for ${peerJobId}; the result remains uncollected. Use /codex:result ${peerJobId}.`,
      background_tasks: []
    });
    assert.strictEqual(reported.stdout, "");
    assert.ok(record(box).failureReportedAt);
  }
});

test("legacy collector failures without a peer job id can satisfy the Stop gate", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box, { subagent_type: "fusion:job-collector", prompt: collectorPrompt("codex", "a".repeat(32)) }));
  const collector = record(box);
  updateWorkerRecord(collector.taskId, envFor(box), (current) => {
    const { expectedPeerEngine, expectedPeerJobId, peerEngine, peerJobId, ...legacy } = current;
    return {
      ...legacy,
      transportStatus: "incomplete",
      failureKind: "collection_timeout",
      finishedAt: "2026-07-16T00:00:00.000Z",
    };
  });

  const blocked = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    last_assistant_message: "finished",
    background_tasks: [],
  });
  assert.strictEqual(JSON.parse(blocked.stdout).decision, "block");
  assert.match(JSON.parse(blocked.stdout).reason, /legacy peer identity unavailable/);
  assert.doesNotMatch(JSON.parse(blocked.stdout).reason, /undefined/);

  const reported = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    last_assistant_message: `Fusion collector ${collector.taskId} remains uncollected; the legacy record has no peer job id.`,
    background_tasks: [],
  });
  assert.strictEqual(reported.stdout, "");
  assert.ok(record(box).failureReportedAt);
});

test("worker tool calls are denied after the wall clock budget and cancellation propagates to Stop", (t) => {
  const box = sandbox(t);
  const limits = { FUSION_WORKER_WALL_CLOCK_MS: "1", FUSION_WORKER_STALL_MS: "999999" };
  run(box, dispatch(box), limits);
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "budget-1",
    agent_type: "fusion:fast-worker"
  }, limits);
  const preTool = run(box, {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "budget-1",
    agent_type: "fusion:fast-worker",
    tool_name: "Read",
    tool_input: { file_path: "x" }
  }, limits);
  assert.strictEqual(JSON.parse(preTool.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.strictEqual(record(box).failureKind, "timeout");
});

test("an explicitly authorized background worker still requires TaskStop after its budget expires", (t) => {
  const box = sandbox(t);
  const limits = { FUSION_WORKER_WALL_CLOCK_MS: "1", FUSION_WORKER_STALL_MS: "999999" };
  fs.writeFileSync(box.transcript, `${JSON.stringify({ type: "user", message: { content: "do it --background" } })}\n`, "utf8");
  run(box, dispatch(box, { run_in_background: true }), limits);
  run(box, {
    ...dispatch(box, { run_in_background: true }),
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "authorized-budget" }
  }, limits);
  const stop = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: record(box).taskId,
    background_tasks: [{ id: "authorized-budget", type: "subagent", status: "running", agent_type: "fusion:fast-worker" }]
  }, limits);
  const decision = JSON.parse(stop.stdout);
  assert.strictEqual(decision.decision, "block");
  assert.match(decision.reason, /TaskStop/);
  assert.strictEqual(record(box).transportStatus, "cancel_requested");
});

test("an explicitly authorized running worker is not cancelled by repeated Stop hooks and becomes owner-ended with its session", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(box.transcript, `${JSON.stringify({ type: "user", message: { content: "do it --background" } })}\n`, "utf8");
  run(box, dispatch(box, { run_in_background: true }));
  run(box, {
    ...dispatch(box, { run_in_background: true }),
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "manual-running" }
  });
  const taskId = record(box).taskId;

  for (let count = 0; count < 7; count += 1) {
    const stop = run(box, {
      hook_event_name: "Stop",
      session_id: "session-1",
      cwd: box.cwd,
      transcript_path: box.transcript,
      stop_hook_active: false,
      last_assistant_message: `Background task ${taskId} is running as manual-running.`,
      background_tasks: [{ id: "manual-running", type: "subagent", status: "running", agent_type: "fusion:fast-worker" }]
    });
    assert.strictEqual(stop.stdout, "");
  }
  assert.strictEqual(record(box).transportStatus, "pending_async");

  run(box, {
    hook_event_name: "SessionEnd",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript
  });
  assert.strictEqual(record(box).transportStatus, "owner_ended");
});

test("an explicitly authorized completed worker stays ready until Stop records its receipt", (t) => {
  const box = sandbox(t);
  fs.writeFileSync(box.transcript, `${JSON.stringify({ type: "user", message: { content: "do it --background" } })}\n`, "utf8");
  run(box, dispatch(box, { run_in_background: true }));
  run(box, {
    ...dispatch(box, { run_in_background: true }),
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "manual-ready" }
  });
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "manual-ready",
    agent_type: "fusion:fast-worker"
  });
  run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "manual-ready",
    agent_type: "fusion:fast-worker",
    stop_hook_active: false,
    last_assistant_message: "summary\ndelivery: complete\nverification: passed"
  });
  const taskId = record(box).taskId;
  assert.strictEqual(record(box).transportStatus, "ready_background");

  const stop = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: `Background task ${taskId} completed as manual-ready.`,
    background_tasks: []
  });
  assert.match(JSON.parse(stop.stdout).hookSpecificOutput.additionalContext, /Acceptance remains unverified for 1 collected Fusion worker/);
  assert.strictEqual(record(box).transportStatus, "done");
});

test("hooks configuration wires lifecycle events through an executable shell command", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "hooks", "hooks.json"), "utf8")).hooks;
  for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStart", "SubagentStop", "Stop", "SessionEnd"]) {
    const handlers = hooks[event].flatMap((group) => group.hooks).filter((hook) => hook.command?.includes("worker-lifecycle.mjs"));
    assert.ok(handlers.length > 0, event);
    assert.ok(handlers.every((handler) => handler.command === 'node "${CLAUDE_PLUGIN_ROOT}/scripts/worker-lifecycle.mjs"'));
  }
  const dispatchHandlers = hooks.PostToolUse.flatMap((group) => group.hooks.map((hook) => ({ matcher: group.matcher, command: hook.command }))).filter((hook) => hook.command?.includes("inline-delegation-guard.mjs"));
  assert.deepStrictEqual(dispatchHandlers, [{ matcher: "^(Agent|Task)$", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/inline-delegation-guard.mjs"' }]);
});
