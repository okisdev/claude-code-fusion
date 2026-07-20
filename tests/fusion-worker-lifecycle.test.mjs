import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { recordCodexAcceptance } from "../plugins/fusion/scripts/fusion-stats.mjs";
import { createWorkerRecord, readWorkerRecords, recordWorkerAcceptance, updateWorkerRecord } from "../plugins/fusion/scripts/lib/worker-state.mjs";
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
  return {
    ...process.env,
    FUSION_WORKER_STATE_DIR: box.state,
    FUSION_DATA_DIR: path.join(box.root, "fusion-data"),
    ...extra,
  };
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
    maxOutputTokens: 48_000,
    maxUncachedTokens: 360_000
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

test("trivial worker limits raise token budgets and retain environment overrides", () => {
  assert.deepStrictEqual(workerLimits("fusion:trivial-worker", {}), {
    wallClockMs: 180_000,
    stallMs: 90_000,
    maxTurns: 12,
    maxOutputTokens: 16_000,
    maxUncachedTokens: 80_000
  });
  assert.deepStrictEqual(workerLimits("fusion:trivial-worker", {
    FUSION_WORKER_MAX_OUTPUT_TOKENS: "17000",
    FUSION_WORKER_MAX_UNCACHED_TOKENS: "90000"
  }), {
    wallClockMs: 180_000,
    stallMs: 90_000,
    maxTurns: 12,
    maxOutputTokens: 17_000,
    maxUncachedTokens: 90_000
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

test("an async launch receipt persists its output file and starts the worker budget", (t) => {
  const box = sandbox(t);
  const outputFile = path.join(box.root, "tasks", "launch-receipt.output");
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, "", "utf8");
  run(box, dispatch(box));
  const launch = run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: {
      isAsync: true,
      status: "async_launched",
      agentId: "launch-receipt",
      content: `task started\noutput_file: ${outputFile}\n`
    }
  });
  assert.strictEqual(launch.status, 0, launch.stderr);
  const launched = record(box);
  assert.strictEqual(launched.outputFile, outputFile);
  assert.ok(Number.isFinite(Date.parse(launched.startedAt)));
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

test("an unexpected async peer wrapper allows Stop while in flight and remains owned until TaskOutput collects it", (t) => {
  const box = sandbox(t);
  const peerDispatch = dispatch(box, { subagent_type: "codex:codex-rescue", prompt: "bounded peer brief" });
  run(box, peerDispatch);
  run(box, {
    ...peerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "peer-async" }
  });
  assert.strictEqual(record(box).transportStatus, "pending_async");
  assert.strictEqual(record(box).failureKind, "unexpected_async");

  const inFlight = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  const inFlightOutput = JSON.parse(inFlight.stdout);
  assert.strictEqual(inFlightOutput.decision, undefined);
  assert.match(inFlightOutput.hookSpecificOutput.additionalContext, /still in flight/);
  assert.strictEqual(record(box).awaitingCollection, true);
  assert.ok(record(box).awaitingCollectionArmedAt);

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
  assert.strictEqual(record(box).failureKind, null);
  assert.strictEqual(record(box).deliveryMode, "harness_async");
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

test("TaskOutput backfills zero telemetry from the harness task transcript", (t) => {
  const box = sandbox(t);
  const peerDispatch = dispatch(box, { subagent_type: "codex:codex-rescue", prompt: "bounded peer brief" });
  run(box, peerDispatch);
  run(box, {
    ...peerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "peer-backfill" }
  });
  const taskTranscript = path.join(box.root, "subagents", "agent-peer-backfill.jsonl");
  fs.mkdirSync(path.dirname(taskTranscript), { recursive: true });
  fs.writeFileSync(taskTranscript, [
    JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 11, cache_creation_input_tokens: 3, cache_read_input_tokens: 5, output_tokens: 4 }, content: [{ type: "tool_use", id: "tool-1" }, { type: "tool_use", id: "tool-2" }] } }),
    JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 7, cache_read_input_tokens: 2, output_tokens: 6 }, content: [{ type: "text", text: "done" }, { type: "tool_use", id: "tool-3" }] } })
  ].join("\n"), "utf8");

  run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "TaskOutput",
    tool_input: { task_id: "peer-backfill", block: true },
    tool_response: { status: "completed", content: "peer result" }
  });

  const collected = record(box);
  assert.strictEqual(collected.turns, 2);
  assert.strictEqual(collected.toolCalls, 3);
  assert.strictEqual(collected.usageSource, "harness-task-transcript");
  assert.strictEqual(collected.usageAvailability, "available");
  assert.deepStrictEqual(collected.usage, {
    inputTokens: 18,
    cacheCreationInputTokens: 3,
    cacheReadInputTokens: 7,
    outputTokens: 10,
    totalTokens: 38,
    uncachedTokens: 31
  });
});

test("TaskOutput skips an oversized harness task transcript without interrupting collection", (t) => {
  const box = sandbox(t);
  const peerDispatch = dispatch(box, { subagent_type: "grok:grok-rescue", prompt: "bounded peer brief" });
  run(box, peerDispatch);
  run(box, {
    ...peerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "peer-oversized" }
  });
  const taskTranscript = path.join(box.root, "subagents", "agent-peer-oversized.jsonl");
  fs.mkdirSync(path.dirname(taskTranscript), { recursive: true });
  fs.writeFileSync(taskTranscript, "{}\n", "utf8");
  fs.truncateSync(taskTranscript, 50 * 1024 * 1024 + 1);

  const result = run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "TaskOutput",
    tool_input: { task_id: "peer-oversized", block: true },
    tool_response: { status: "completed", content: "peer result" }
  });

  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(record(box).transportStatus, "done");
  assert.strictEqual(record(box).usageAvailability, "unreported");
  assert.deepStrictEqual(record(box).usage, {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    uncachedTokens: 0
  });
});

test("SubagentStop reclassifies only the unexpected async marker after transport completion", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box));
  run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "agent-stop-async" }
  });
  updateWorkerRecord(record(box).taskId, envFor(box), (current) => ({ ...current, failureKind: "unexpected_async" }));
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "agent-stop-async",
    agent_type: "fusion:fast-worker"
  });
  run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "agent-stop-async",
    agent_type: "fusion:fast-worker",
    stop_hook_active: false,
    last_assistant_message: "summary\ndelivery: complete\nverification: passed"
  });
  assert.strictEqual(record(box).transportStatus, "ready_uncollected");
  assert.strictEqual(record(box).collectedAt, null);
  assert.strictEqual(record(box).failureKind, null);
  assert.strictEqual(record(box).deliveryMode, "harness_async");

  const blocked = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  assert.strictEqual(JSON.parse(blocked.stdout).decision, "block");
  assert.match(JSON.parse(blocked.stdout).reason, /TaskOutput with block=true.*agent-stop-async/);
});

test("a TaskOutput no-task error marks a matching unexpected async peer wrapper as reaped", (t) => {
  const box = sandbox(t);
  const peerDispatch = dispatch(box, { subagent_type: "codex:codex-rescue", prompt: "bounded peer brief" });
  run(box, peerDispatch);
  run(box, {
    ...peerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "peer-reaped-output" }
  });

  run(box, {
    hook_event_name: "PostToolUseFailure",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "TaskOutput",
    tool_input: { task_id: "peer-reaped-output", block: true },
    tool_response: { is_error: true, content: "No task found with ID: peer-reaped-output" }
  });

  const reaped = record(box);
  assert.strictEqual(reaped.transportStatus, "failed");
  assert.strictEqual(reaped.failureKind, "task_reaped");
  assert.strictEqual(reaped.collectionMethod, "reaped");
  assert.ok(reaped.finishedAt);
  assert.ok(reaped.collectedAt);
  assert.strictEqual(reaped.agentId, "peer-reaped-output");
  assert.strictEqual(reaped.backgroundTaskId, "peer-reaped-output");
});

test("a TaskStop no-task error marks a matching unexpected async peer wrapper as reaped", (t) => {
  const box = sandbox(t);
  const peerDispatch = dispatch(box, { subagent_type: "grok:grok-rescue", prompt: "bounded peer brief" });
  run(box, peerDispatch);
  run(box, {
    ...peerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "peer-reaped-stop" }
  });

  run(box, {
    hook_event_name: "PostToolUseFailure",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "TaskStop",
    tool_input: { task_id: "peer-reaped-stop" },
    error: "No task found with ID: peer-reaped-stop"
  });

  const reaped = record(box);
  assert.strictEqual(reaped.transportStatus, "failed");
  assert.strictEqual(reaped.failureKind, "task_reaped");
  assert.strictEqual(reaped.collectionMethod, "reaped");
  assert.ok(reaped.finishedAt);
  assert.ok(reaped.collectedAt);
});

test("no-task errors ignore unmatched task ids and terminal worker records", (t) => {
  const box = sandbox(t);
  const peerDispatch = dispatch(box, { subagent_type: "codex:codex-rescue", prompt: "bounded peer brief" });
  run(box, peerDispatch);
  run(box, {
    ...peerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "peer-terminal" }
  });

  run(box, {
    hook_event_name: "PostToolUseFailure",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "TaskOutput",
    tool_input: { task_id: "unknown-peer", block: true },
    error: "No task found with ID: unknown-peer"
  });
  assert.strictEqual(record(box).transportStatus, "pending_async");
  assert.strictEqual(record(box).failureKind, "unexpected_async");

  const terminal = updateWorkerRecord(record(box).taskId, envFor(box), (current) => ({
    ...current,
    transportStatus: "done",
    finishedAt: "2026-07-19T00:00:00.000Z",
    collectedAt: "2026-07-19T00:00:01.000Z",
    collectionMethod: "TaskOutput"
  }));
  run(box, {
    hook_event_name: "PostToolUseFailure",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "TaskStop",
    tool_input: { task_id: "peer-terminal" },
    error: "No task found with ID: peer-terminal"
  });
  assert.deepStrictEqual(record(box), terminal);
});

test("Stop does not demand collection for a reaped peer wrapper", (t) => {
  const box = sandbox(t);
  const peerDispatch = dispatch(box, { subagent_type: "codex:codex-rescue", prompt: "bounded peer brief" });
  run(box, peerDispatch);
  run(box, {
    ...peerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "peer-reaped-stop-gate" }
  });
  run(box, {
    hook_event_name: "PostToolUseFailure",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "TaskOutput",
    tool_input: { task_id: "peer-reaped-stop-gate", block: true },
    error: "No task found with ID: peer-reaped-stop-gate"
  });

  const stop = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  const output = JSON.parse(stop.stdout);
  assert.strictEqual(output.decision, undefined);
  assert.doesNotMatch(JSON.stringify(output), /TaskOutput|collect the terminal result/);
  assert.match(output.hookSpecificOutput.additionalContext, /Acceptance remains unverified/);
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

test("an armed async worker blocks only after terminal state is observed and unblocks after Read collection", (t) => {
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

  const firstStop = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: "done",
    background_tasks: [{ id: "a1", type: "subagent", status: "running", agent_type: "fusion:fast-worker" }]
  });
  assert.strictEqual(JSON.parse(firstStop.stdout).decision, undefined);
  assert.strictEqual(record(box).awaitingCollection, true);
  const armedAt = record(box).awaitingCollectionArmedAt;
  assert.ok(armedAt);

  const secondStop = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: "done",
    background_tasks: [{ id: "a1", type: "subagent", status: "running", agent_type: "fusion:fast-worker" }]
  });
  assert.strictEqual(JSON.parse(secondStop.stdout).decision, undefined);
  assert.strictEqual(record(box).awaitingCollectionArmedAt, armedAt);

  const terminalStop = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: "done",
    background_tasks: [{ id: "a1", type: "subagent", status: "completed", agent_type: "fusion:fast-worker" }]
  });
  const decision = JSON.parse(terminalStop.stdout);
  assert.strictEqual(decision.decision, "block");
  assert.match(decision.reason, /Call Read with file_path=/);
  assert.match(decision.reason, new RegExp(outputFile));
  assert.doesNotMatch(decision.reason, /TaskOutput/);
  assert.match(decision.reason, /unverified/);

  run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "Read",
    tool_input: { file_path: outputFile },
    tool_response: { status: "completed", content: "completed" }
  });
  assert.strictEqual(record(box).transportStatus, "done");
  assert.strictEqual(record(box).awaitingCollection, false);
  assert.strictEqual(record(box).awaitingCollectionArmedAt, null);

  const collectedStop = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  assert.strictEqual(JSON.parse(collectedStop.stdout).decision, undefined);
  assert.match(JSON.parse(collectedStop.stdout).hookSpecificOutput.additionalContext, /Acceptance remains unverified/);
});

test("a completed async worker blocks on its first Stop until a full Read collects it", (t) => {
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
  assert.strictEqual(record(box).collectedAt, null);

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
  assert.match(JSON.parse(blocked.stdout).reason, /Call Read with file_path=/);
  assert.match(JSON.parse(blocked.stdout).reason, new RegExp(outputFile));
  assert.doesNotMatch(JSON.parse(blocked.stdout).reason, /TaskOutput/);

  for (const block of [false, false]) {
    run(box, {
      hook_event_name: "PostToolUse",
      session_id: "session-1",
      cwd: box.cwd,
      transcript_path: box.transcript,
      tool_name: "TaskOutput",
      tool_input: { task_id: "agent-collected", block },
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
  assert.strictEqual(completed.awaitingVerdict, true);
  assert.ok(completed.awaitingVerdictArmedAt);

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
  assert.match(output.hookSpecificOutput.additionalContext, new RegExp(`/fusion:stats --record ${completed.taskId}=accepted\\|rejected\\|unverified`));
  assert.match(output.hookSpecificOutput.additionalContext, /pairs are <id>=<verdict> with id either a fusion task id \(fusion- plus 24 lowercase hex\) or an engine job id \(32 lowercase hex\), verdict one of accepted\|rejected\|unverified/);

  recordWorkerAcceptance({ taskId: completed.taskId, acceptance: "accepted", env: envFor(box), source: "main-loop" });
  assert.strictEqual(record(box).awaitingVerdict, false);
  assert.strictEqual(record(box).awaitingVerdictArmedAt, null);
  const quiet = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  assert.strictEqual(quiet.stdout, "");
});

test("collection captures peer job footers and leaves absent or malformed footers null", (t) => {
  const cases = [
    {
      agentType: "codex:codex-rescue",
      taskId: "peer-job-last",
      content: `result\njob: ${"a".repeat(32)}\njob: ${"b".repeat(32)}`,
      peerJobId: "b".repeat(32),
      peerEngine: "codex"
    },
    {
      agentType: "grok:grok-rescue",
      taskId: "peer-job-absent",
      content: "result without a job footer",
      peerJobId: null,
      peerEngine: undefined
    },
    {
      agentType: "grok:grok-rescue",
      taskId: "peer-job-malformed",
      content: `result\njob: ${"A".repeat(32)}`,
      peerJobId: null,
      peerEngine: undefined
    }
  ];

  for (const testCase of cases) {
    const box = sandbox(t);
    const peerDispatch = dispatch(box, { subagent_type: testCase.agentType, prompt: "bounded peer brief" });
    run(box, peerDispatch);
    run(box, {
      ...peerDispatch,
      hook_event_name: "PostToolUse",
      tool_response: { isAsync: true, status: "async_launched", agentId: testCase.taskId }
    });
    run(box, {
      hook_event_name: "PostToolUse",
      session_id: "session-1",
      cwd: box.cwd,
      transcript_path: box.transcript,
      tool_name: "TaskOutput",
      tool_input: { task_id: testCase.taskId, block: true },
      tool_response: { status: "completed", content: testCase.content }
    });

    const collected = record(box);
    assert.strictEqual(collected.peerJobId, testCase.peerJobId);
    assert.strictEqual(collected.peerEngine, testCase.peerEngine);
    assert.strictEqual(collected.awaitingVerdict, true);
    assert.ok(collected.awaitingVerdictArmedAt);
  }
});

test("TaskOutput captures a peer job footer from a tagged response", (t) => {
  const box = sandbox(t);
  const peerDispatch = dispatch(box, { subagent_type: "codex:codex-rescue", prompt: "bounded peer brief" });
  run(box, peerDispatch);
  run(box, {
    ...peerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "a7e7bb81fdd99c53a" }
  });
  run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "TaskOutput",
    tool_input: { task_id: "a7e7bb81fdd99c53a", block: true },
    tool_response: `<retrieval_status>success</retrieval_status>
<task_id>a7e7bb81fdd99c53a</task_id>
<task_type>local_agent</task_type>
<status>completed</status>
<output>
worker final message text
codex-session: 019f
job: 87254fcdc09d390bc321881d9be3e8b8
delivery: foreground
</output>`
  });

  const collected = record(box);
  assert.strictEqual(collected.peerJobId, "87254fcdc09d390bc321881d9be3e8b8");
  assert.strictEqual(collected.peerEngine, "codex");
});

test("a full Read collects terminal output and captures its peer job footer", (t) => {
  const box = sandbox(t);
  const peerJobId = "b".repeat(32);
  const outputFile = path.join(box.root, "tasks", "peer-read.output");
  const output = `worker final message\njob: ${peerJobId}\ndelivery: foreground\n`;
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, output, "utf8");
  const peerDispatch = dispatch(box, { subagent_type: "codex:codex-rescue", prompt: "bounded peer brief" });
  run(box, peerDispatch);
  run(box, {
    ...peerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: {
      isAsync: true,
      status: "async_launched",
      agentId: "peer-read",
      content: `task started\noutput_file: ${outputFile}\n`
    }
  });
  updateWorkerRecord(record(box).taskId, envFor(box), (current) => ({ ...current, transportStatus: "ready_uncollected" }));

  const blocked = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  const instruction = JSON.parse(blocked.stdout).reason;
  assert.match(instruction, /Call Read with file_path=/);
  assert.match(instruction, new RegExp(outputFile));
  assert.doesNotMatch(instruction, /TaskOutput/);

  run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "Read",
    tool_input: { file_path: outputFile },
    tool_response: { type: "text", text: output }
  });

  const collected = record(box);
  assert.strictEqual(collected.collectionMethod, "Read");
  assert.ok(collected.collectedAt);
  assert.strictEqual(collected.transportStatus, "done");
  assert.strictEqual(collected.failureKind, null);
  assert.strictEqual(collected.deliveryMode, "harness_async");
  assert.strictEqual(collected.peerJobId, peerJobId);
  assert.strictEqual(collected.peerEngine, "codex");
});

test("Read collection debug capture writes the raw response when enabled", (t) => {
  const box = sandbox(t);
  const outputFile = path.join(box.root, "tasks", "debug-read.output");
  const toolResponse = { type: "text", text: "worker final message", diagnostics: { source: "Read" } };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, toolResponse.text, "utf8");
  run(box, dispatch(box));
  run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "debug-read", outputFile }
  });
  updateWorkerRecord(record(box).taskId, envFor(box), (current) => ({ ...current, transportStatus: "ready_uncollected" }));

  const collected = run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "Read",
    tool_input: { file_path: outputFile },
    tool_response: toolResponse
  }, { FUSION_WORKER_DEBUG_COLLECTION_RESPONSE: "1" });
  assert.strictEqual(collected.status, 0, collected.stderr);
  const debugFile = path.join(box.root, "fusion-data", "worker-collection-response.json");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(debugFile, "utf8")), toolResponse);
});

test("TaskOutput captures a peer job footer from the documented text response", (t) => {
  const box = sandbox(t);
  const peerJobId = "d".repeat(32);
  const peerDispatch = dispatch(box, { subagent_type: "codex:codex-rescue", prompt: "bounded peer brief" });
  run(box, peerDispatch);
  run(box, {
    ...peerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "peer-documented-text" }
  });
  run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "TaskOutput",
    tool_input: { task_id: "peer-documented-text", block: true },
    tool_response: { type: "text", text: `worker final message\njob: ${peerJobId}\ndelivery: foreground\n`, isError: false }
  });

  const collected = record(box);
  assert.strictEqual(collected.peerJobId, peerJobId);
  assert.strictEqual(collected.peerEngine, "codex");
});

test("TaskOutput captures a peer job footer from text content blocks", (t) => {
  const box = sandbox(t);
  const peerJobId = "e".repeat(32);
  const peerDispatch = dispatch(box, { subagent_type: "grok:grok-rescue", prompt: "bounded peer brief" });
  run(box, peerDispatch);
  run(box, {
    ...peerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "peer-content-blocks" }
  });
  run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "TaskOutput",
    tool_input: { task_id: "peer-content-blocks", block: true },
    tool_response: [
      { type: "text", text: "worker final message" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "ignored" } },
      { type: "text", text: `job: ${peerJobId}\ndelivery: foreground` }
    ]
  });

  const collected = record(box);
  assert.strictEqual(collected.peerJobId, peerJobId);
  assert.strictEqual(collected.peerEngine, "grok");
});

test("an async SubagentStop captures a peer job footer", (t) => {
  const box = sandbox(t);
  const peerJobId = "c".repeat(32);
  const peerDispatch = dispatch(box, { subagent_type: "grok:grok-rescue", prompt: "bounded peer brief" });
  run(box, peerDispatch);
  run(box, {
    ...peerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "peer-async-stop" }
  });
  run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "peer-async-stop",
    agent_type: "grok:grok-rescue",
    stop_hook_active: false,
    last_assistant_message: `worker final message\njob: ${peerJobId}\ndelivery: complete\nverification: passed`
  });

  const stopped = record(box);
  assert.strictEqual(stopped.runtimeAsync, true);
  assert.strictEqual(stopped.peerJobId, peerJobId);
  assert.strictEqual(stopped.peerEngine, "grok");
});

test("SubagentStop leaves a malformed peer footer null while arming its verdict", (t) => {
  const box = sandbox(t);
  const worker = createWorkerRecord({
    taskId: `fusion-${"d".repeat(24)}`,
    sessionId: "session-1",
    agentType: "grok:grok-review-runner",
    workspaceRoot: box.cwd
  }, envFor(box));
  updateWorkerRecord(worker.taskId, envFor(box), (current) => ({ ...current, agentId: "review-stop", transportStatus: "running" }));

  run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "review-stop",
    agent_type: "grok:grok-review-runner",
    stop_hook_active: false,
    last_assistant_message: `summary\njob: ${"z".repeat(32)}\ndelivery: complete\nverification: passed`
  });

  const collected = record(box);
  assert.strictEqual(collected.collectionMethod, "SubagentStop");
  assert.strictEqual(collected.peerJobId, null);
  assert.strictEqual(collected.awaitingVerdict, true);
  assert.ok(collected.awaitingVerdictArmedAt);
});

test("explicit acceptance settlement clears verdict arming, including unverified", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box));
  run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: { status: "completed", agentId: "settle-unverified" }
  });
  const completed = record(box);
  assert.strictEqual(completed.awaitingVerdict, true);

  recordWorkerAcceptance({ taskId: completed.taskId, acceptance: "unverified", env: envFor(box), source: "main-loop" });
  const settled = record(box);
  assert.strictEqual(settled.acceptance, "unverified");
  assert.ok(settled.acceptanceRecordedAt);
  assert.strictEqual(settled.awaitingVerdict, false);
  assert.strictEqual(settled.awaitingVerdictArmedAt, null);

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
    env: envFor(box),
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
  assert.strictEqual(worker.awaitingCollection, true);
  assert.ok(worker.awaitingCollectionArmedAt);
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

test("advisory in-flight stop rounds do not consume the cancellation budget for a harness-async worker", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box));
  run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "harness-async-1" }
  });
  const taskId = record(box).taskId;
  assert.notStrictEqual(record(box).userBackgroundAuthorized, true);

  for (let count = 0; count < 12; count += 1) {
    const stop = run(box, {
      hook_event_name: "Stop",
      session_id: "session-1",
      cwd: box.cwd,
      transcript_path: box.transcript,
      stop_hook_active: false,
      last_assistant_message: `Fusion task ${taskId} is still in flight.`,
      background_tasks: [{ id: "harness-async-1", type: "subagent", status: "running", agent_type: "fusion:fast-worker" }]
    });
    const output = JSON.parse(stop.stdout);
    assert.strictEqual(output.decision, undefined);
    assert.match(output.hookSpecificOutput.additionalContext, /still in flight/);
  }
  const worker = record(box);
  assert.strictEqual(worker.stopBlockCount, 0);
  assert.strictEqual(worker.transportStatus, "pending_async");
  assert.strictEqual(worker.awaitingCollection, true);

  updateWorkerRecord(taskId, envFor(box), (current) => ({
    ...current,
    startedAt: new Date(Date.now() - 2_000_000).toISOString(),
    limits: { ...current.limits, wallClockMs: 1000 }
  }));
  const expired = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: `Fusion task ${taskId} is still in flight.`,
    background_tasks: [{ id: "harness-async-1", type: "subagent", status: "running", agent_type: "fusion:fast-worker" }]
  });
  const expiredOutput = JSON.parse(expired.stdout);
  assert.strictEqual(expiredOutput.decision, "block");
  assert.match(expiredOutput.reason, /TaskStop/);
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
    assert.strictEqual(JSON.parse(stop.stdout).decision, undefined);
    assert.match(JSON.parse(stop.stdout).hookSpecificOutput.additionalContext, /still in flight/);
  }
  const running = record(box);
  assert.strictEqual(running.transportStatus, "pending_async");
  assert.strictEqual(running.awaitingCollection, true);
  assert.ok(running.awaitingCollectionArmedAt);

  run(box, {
    hook_event_name: "SessionEnd",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript
  });
  assert.strictEqual(record(box).transportStatus, "owner_ended");
});

test("an explicitly authorized completed worker requires TaskOutput before Stop can finish", (t) => {
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
  assert.strictEqual(record(box).transportStatus, "ready_uncollected");

  const blocked = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: `Background task ${taskId} completed as manual-ready.`,
    background_tasks: []
  });
  assert.strictEqual(JSON.parse(blocked.stdout).decision, "block");
  assert.match(JSON.parse(blocked.stdout).reason, /TaskOutput with block=true.*manual-ready/);

  run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "TaskOutput",
    tool_input: { task_id: "manual-ready", block: true },
    tool_response: { status: "completed", content: "completed result" }
  });

  const allowed = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  assert.match(JSON.parse(allowed.stdout).hookSpecificOutput.additionalContext, /Acceptance remains unverified for 1 collected Fusion worker/);
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
