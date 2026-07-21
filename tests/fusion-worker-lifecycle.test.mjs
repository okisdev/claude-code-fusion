import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { recordCodexAcceptance } from "../plugins/fusion/scripts/fusion-stats.mjs";
import { createWorkerRecord, readWorkerSessionState, readWorkerRecords, recordWorkerAcceptance, updateWorkerRecord, WORKER_COLLECTION_METHODS } from "../plugins/fusion/scripts/lib/worker-state.mjs";
import { validateWorkerBrief, workerBudgetFailure, workerLimits } from "../plugins/fusion/scripts/worker-lifecycle.mjs";

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

test("legacy collection methods normalize when worker records load", (t) => {
  const box = sandbox(t);
  const worker = createWorkerRecord({
    taskId: `fusion-${"a".repeat(24)}`,
    sessionId: "session-1",
    agentType: "fusion:fast-worker",
    workspaceRoot: box.cwd
  }, envFor(box));
  const file = path.join(box.state, "jobs", `${worker.taskId}.json`);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, `${JSON.stringify({ ...stored, collectionMethod: "SubagentStop" }, null, 2)}\n`, "utf8");

  assert.strictEqual(record(box).collectionMethod, WORKER_COLLECTION_METHODS.SUBAGENT_STOP);
});

test("collection method write sites use the canonical set", () => {
  const allowed = new Set(Object.values(WORKER_COLLECTION_METHODS));
  assert.strictEqual(allowed.size, Object.keys(WORKER_COLLECTION_METHODS).length);
  for (const method of allowed) {
    assert.match(method, /^[a-z]+(?:_[a-z]+)*$/);
  }

  const sources = [
    fs.readFileSync(script, "utf8"),
    fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "scripts", "lib", "worker-state.mjs"), "utf8")
  ];
  const assignments = sources.flatMap((source) => [...source.matchAll(/collectionMethod:\s*([^,\n}]+)/g)].map((match) => match[1].trim()));
  assert.ok(assignments.length > 0);
  assert.ok(assignments.every((expression) => expression === "null" || expression === "collectionMethod" || /^WORKER_COLLECTION_METHODS\.[A-Z_]+$/.test(expression)));

  const calls = sources.flatMap((source) => source.split("\n").filter((line) => line.includes("markWorkerCollected(") && !line.includes("export function")));
  assert.ok(calls.length > 0);
  assert.ok(calls.every((line) => line.includes("WORKER_COLLECTION_METHODS.") || line.includes(", collectionMethod, now")));
});

test("worker limits preserve the default budgets without a sizing hint and retain environment overrides", () => {
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

test("the stall budget uses successful-call liveness without changing execution progress telemetry", (t) => {
  const box = sandbox(t);
  const limits = { FUSION_WORKER_WALL_CLOCK_MS: "999999", FUSION_WORKER_STALL_MS: "60" };
  run(box, dispatch(box), limits);
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "liveness-1",
    agent_type: "fusion:fast-worker"
  }, limits);

  const withoutCalls = record(box);
  assert.strictEqual(workerBudgetFailure(withoutCalls, Date.parse(withoutCalls.startedAt) + 60).failureKind, "stall");

  run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "liveness-1",
    agent_type: "fusion:fast-worker",
    tool_name: "Read",
    tool_input: { file_path: "src/a.ts" }
  }, limits);
  const afterRead = record(box);
  assert.ok(afterRead.lastLivenessAt);
  assert.strictEqual(afterRead.progressEvents, 0);
  assert.strictEqual(workerBudgetFailure(afterRead, Date.parse(afterRead.lastLivenessAt) + 59), null);

  run(box, {
    hook_event_name: "PostToolUseFailure",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "liveness-1",
    agent_type: "fusion:fast-worker",
    tool_name: "Write",
    tool_input: { file_path: "src/a.ts" }
  }, limits);
  const afterFailure = record(box);
  assert.strictEqual(afterFailure.lastLivenessAt, afterRead.lastLivenessAt);
  assert.strictEqual(afterFailure.progressEvents, 0);
  assert.strictEqual(workerBudgetFailure(afterFailure, Date.parse(afterFailure.lastLivenessAt) + 60).failureKind, "stall");

  run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "liveness-1",
    agent_type: "fusion:fast-worker",
    tool_name: "Write",
    tool_input: { file_path: "src/a.ts" }
  }, limits);
  assert.strictEqual(record(box).progressEvents, 1);
});

test("a worker with no tool call history stalls exactly as it did before in-flight tracking existed", (t) => {
  const box = sandbox(t);
  const limits = { FUSION_WORKER_WALL_CLOCK_MS: "999999", FUSION_WORKER_STALL_MS: "60" };
  run(box, dispatch(box), limits);
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "never-called",
    agent_type: "fusion:fast-worker"
  }, limits);
  const neverCalled = record(box);
  assert.strictEqual(neverCalled.inFlightSince, undefined);
  assert.strictEqual(workerBudgetFailure(neverCalled, Date.parse(neverCalled.startedAt) + 60).failureKind, "stall");
});

test("an in-flight tool call suspends the stall budget but not the wall clock, and stalling resumes once it completes or fails", (t) => {
  const STALL_BUDGET_MS = 600_000;
  const box = sandbox(t);
  const limits = { FUSION_WORKER_WALL_CLOCK_MS: "999999", FUSION_WORKER_STALL_MS: String(STALL_BUDGET_MS) };
  run(box, dispatch(box), limits);
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "inflight-1",
    agent_type: "fusion:fast-worker"
  }, limits);

  run(box, {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "inflight-1",
    agent_type: "fusion:fast-worker",
    tool_name: "Bash",
    tool_input: { command: "sleep 600" }
  }, limits);
  const admitted = record(box);
  assert.ok(admitted.inFlightSince);
  assert.strictEqual(workerBudgetFailure(admitted, Date.parse(admitted.inFlightSince) + STALL_BUDGET_MS + 300_000), null);
  assert.strictEqual(workerBudgetFailure(admitted, Date.parse(admitted.startedAt) + 999_999).failureKind, "timeout");

  run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "inflight-1",
    agent_type: "fusion:fast-worker",
    tool_name: "Bash",
    tool_input: { command: "sleep 600" },
    tool_response: { content: "done" }
  }, limits);
  const completedCall = record(box);
  assert.strictEqual(completedCall.inFlightSince, undefined);
  assert.ok(completedCall.lastLivenessAt);
  assert.strictEqual(workerBudgetFailure(completedCall, Date.parse(completedCall.lastLivenessAt) + STALL_BUDGET_MS - 1), null);
  assert.strictEqual(workerBudgetFailure(completedCall, Date.parse(completedCall.lastLivenessAt) + STALL_BUDGET_MS).failureKind, "stall");

  run(box, {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "inflight-1",
    agent_type: "fusion:fast-worker",
    tool_name: "Bash",
    tool_input: { command: "false" }
  }, limits);
  assert.ok(record(box).inFlightSince);

  run(box, {
    hook_event_name: "PostToolUseFailure",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "inflight-1",
    agent_type: "fusion:fast-worker",
    tool_name: "Bash",
    tool_input: { command: "false" },
    tool_response: { is_error: true }
  }, limits);
  const afterFailedCall = record(box);
  assert.strictEqual(afterFailedCall.inFlightSince, undefined);
  assert.strictEqual(afterFailedCall.lastLivenessAt, completedCall.lastLivenessAt);
  assert.strictEqual(workerBudgetFailure(afterFailedCall, Date.parse(afterFailedCall.lastLivenessAt) + STALL_BUDGET_MS).failureKind, "stall");
});

test("brief sizing hints scale dispatch limits", (t) => {
  const cases = [
    ["SMALL", { wallClockMs: 600_000, stallMs: 150_000, maxTurns: 30, maxOutputTokens: 24_000, maxUncachedTokens: 180_000 }],
    ["StAnDaRd", { wallClockMs: 1_200_000, stallMs: 300_000, maxTurns: 60, maxOutputTokens: 48_000, maxUncachedTokens: 360_000 }],
    ["large", { wallClockMs: 2_400_000, stallMs: 600_000, maxTurns: 120, maxOutputTokens: 96_000, maxUncachedTokens: 720_000 }]
  ];

  for (const [sizing, limits] of cases) {
    const box = sandbox(t);
    const launch = run(box, dispatch(box, { prompt: `${brief()}sizing: ${sizing}\n` }));
    assert.strictEqual(JSON.parse(launch.stdout).hookSpecificOutput.permissionDecision, "allow");
    assert.deepStrictEqual(record(box).limits, limits);
  }
});

test("brief sizing validation rejects invalid and repeated values", () => {
  const invalid = validateWorkerBrief(`${brief()}sizing: extra-large\n`, "fusion:fast-worker");
  assert.strictEqual(invalid.ok, false);
  assert.match(invalid.reason, /small.*standard.*large/);

  const repeated = validateWorkerBrief(`${brief()}sizing: small\nsizing: large\n`, "fusion:fast-worker");
  assert.strictEqual(repeated.ok, false);
  assert.match(repeated.reason, /may appear once/);
});

test("environment overrides take precedence over brief sizing hints", (t) => {
  const box = sandbox(t);
  const overrides = {
    FUSION_WORKER_WALL_CLOCK_MS: "120",
    FUSION_WORKER_STALL_MS: "60",
    FUSION_WORKER_MAX_TURNS: "12",
    FUSION_WORKER_MAX_OUTPUT_TOKENS: "8000",
    FUSION_WORKER_MAX_UNCACHED_TOKENS: "6000"
  };
  const launch = run(box, dispatch(box, { prompt: `${brief()}sizing: large\n` }), overrides);
  assert.strictEqual(JSON.parse(launch.stdout).hookSpecificOutput.permissionDecision, "allow");
  assert.deepStrictEqual(record(box).limits, {
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

test("SubagentStart requires verdict envelopes for execution and coverage workers but not collectors", (t) => {
  const execution = sandbox(t);
  run(execution, dispatch(execution));
  const executionStart = run(execution, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: execution.cwd,
    transcript_path: execution.transcript,
    agent_id: "execution-envelope",
    agent_type: "fusion:fast-worker"
  });
  const executionInstruction = JSON.parse(executionStart.stdout).hookSpecificOutput.additionalContext;
  assert.match(executionInstruction, /End a successful execution report with separate lines `delivery: complete` and `verification: passed`/);
  assert.match(executionInstruction, /compact verdict envelope/);
  assert.match(executionInstruction, /changed file paths without diffs/);
  assert.match(executionInstruction, /pass and fail counts/);
  assert.match(executionInstruction, /environment findings/);
  assert.match(executionInstruction, /long unified diffs, full test logs, and long quoted file contents/);

  const coverage = sandbox(t);
  run(coverage, dispatch(coverage, {
    subagent_type: "fusion:trivial-worker",
    prompt: "fusion-brief: v1\ncontext-mode: isolated\ngoal: inspect one file\nscope: src/a.ts\nacceptance: identify the behavior\n"
  }));
  const coverageStart = run(coverage, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: coverage.cwd,
    transcript_path: coverage.transcript,
    agent_id: "coverage-envelope",
    agent_type: "fusion:trivial-worker"
  });
  const coverageInstruction = JSON.parse(coverageStart.stdout).hookSpecificOutput.additionalContext;
  assert.match(coverageInstruction, /End the completed analysis with separate lines `delivery: complete` and `coverage: complete`/);
  assert.match(coverageInstruction, /compact verdict envelope/);

  const collector = sandbox(t);
  const peerJobId = "a".repeat(32);
  run(collector, dispatch(collector, { subagent_type: "fusion:job-collector", prompt: collectorPrompt("codex", peerJobId) }));
  const collectorStart = run(collector, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: collector.cwd,
    transcript_path: collector.transcript,
    agent_id: "collector-envelope",
    agent_type: "fusion:job-collector"
  });
  const collectorInstruction = JSON.parse(collectorStart.stdout).hookSpecificOutput.additionalContext;
  assert.match(collectorInstruction, /Return the collector command output exactly, including its terminal `collector:` marker/);
  assert.doesNotMatch(collectorInstruction, /compact verdict envelope|changed file paths without diffs/);
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

test("an async launch receipt persists its transcript path and starts the worker budget", (t) => {
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
  assert.strictEqual(launched.transcriptPath, outputFile);
  assert.strictEqual(launched.outputFile, null);
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
  assert.strictEqual(record(box).collectionMethod, "task_output");
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
  assert.strictEqual(record(box).collectionMethod, "task_output");
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

test("SubagentStop collects a persisted async result and reclassifies the unexpected async marker", (t) => {
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
  assert.strictEqual(record(box).transportStatus, "done");
  assert.strictEqual(record(box).collectionMethod, "subagent_stop");
  assert.ok(record(box).collectedAt);
  assert.strictEqual(record(box).awaitingVerdict, true);
  assert.strictEqual(record(box).failureKind, null);
  assert.strictEqual(record(box).recoveredFailureKind, undefined);
  assert.strictEqual(record(box).deliveryMode, "harness_async");
  const finalTextFile = record(box).outputFile;
  assert.ok(finalTextFile);

  const blocked = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  const output = JSON.parse(blocked.stdout);
  assert.strictEqual(output.decision, undefined);
  assert.match(output.hookSpecificOutput.additionalContext, /Acceptance remains unverified for 1 collected Fusion worker/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /Call Read with file_path=|TaskOutput/);
});

test("SubagentStop clears stale budget failures after successful completion", (t) => {
  for (const failureKind of ["stall", "timeout", "token_limit", "turn_limit"]) {
    const box = sandbox(t);
    run(box, dispatch(box));
    run(box, {
      hook_event_name: "SubagentStart",
      session_id: "session-1",
      cwd: box.cwd,
      transcript_path: box.transcript,
      agent_id: `recovered-${failureKind}`,
      agent_type: "fusion:fast-worker"
    });
    updateWorkerRecord(record(box).taskId, envFor(box), (current) => ({ ...current, failureKind }));
    run(box, {
      hook_event_name: "SubagentStop",
      session_id: "session-1",
      cwd: box.cwd,
      transcript_path: box.transcript,
      agent_id: `recovered-${failureKind}`,
      agent_type: "fusion:fast-worker",
      stop_hook_active: false,
      last_assistant_message: "summary\ndelivery: complete\nverification: passed"
    });
    const completed = record(box);
    assert.strictEqual(completed.transportStatus, "done");
    assert.strictEqual(completed.failureKind, null);
    assert.strictEqual(completed.recoveredFailureKind, failureKind);
  }
});

test("SubagentStop keeps a newly evaluated budget failure instead of recovering a stale one", (t) => {
  const box = sandbox(t);
  const limits = { FUSION_WORKER_WALL_CLOCK_MS: "1", FUSION_WORKER_STALL_MS: "999999" };
  run(box, dispatch(box), limits);
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "fresh-budget-failure",
    agent_type: "fusion:fast-worker"
  }, limits);
  updateWorkerRecord(record(box).taskId, envFor(box), (current) => ({
    ...current,
    failureKind: "stall",
    startedAt: new Date(Date.now() - 1_000).toISOString()
  }));
  run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "fresh-budget-failure",
    agent_type: "fusion:fast-worker",
    stop_hook_active: false,
    last_assistant_message: "summary\ndelivery: complete\nverification: passed"
  }, limits);
  const completed = record(box);
  assert.strictEqual(completed.transportStatus, "done");
  assert.strictEqual(completed.failureKind, "timeout");
  assert.strictEqual(completed.collectionMethod, "subagent_stop");
  assert.ok(completed.collectedAt);
  assert.strictEqual(completed.recoveredFailureKind, undefined);
});

test("SubagentStop retains failed and incomplete workers on their existing collection path", (t) => {
  const failed = sandbox(t);
  const limits = { FUSION_WORKER_WALL_CLOCK_MS: "1", FUSION_WORKER_STALL_MS: "999999" };
  run(failed, dispatch(failed), limits);
  run(failed, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: failed.cwd,
    transcript_path: failed.transcript,
    agent_id: "failed-terminal",
    agent_type: "fusion:fast-worker"
  }, limits);
  updateWorkerRecord(record(failed).taskId, envFor(failed), (current) => ({ ...current, startedAt: new Date(Date.now() - 1_000).toISOString() }));
  run(failed, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: failed.cwd,
    transcript_path: failed.transcript,
    agent_id: "failed-terminal",
    agent_type: "fusion:fast-worker",
    stop_hook_active: true,
    last_assistant_message: "partial result"
  }, limits);
  assert.strictEqual(record(failed).transportStatus, "failed");
  assert.strictEqual(record(failed).failureKind, "timeout");
  assert.strictEqual(record(failed).collectionMethod, "subagent_stop");
  assert.ok(record(failed).collectedAt);

  const incomplete = sandbox(t);
  run(incomplete, dispatch(incomplete));
  run(incomplete, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: incomplete.cwd,
    transcript_path: incomplete.transcript,
    agent_id: "incomplete-terminal",
    agent_type: "fusion:fast-worker"
  });
  run(incomplete, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: incomplete.cwd,
    transcript_path: incomplete.transcript,
    agent_id: "incomplete-terminal",
    agent_type: "fusion:fast-worker",
    stop_hook_active: true,
    last_assistant_message: "partial result"
  });
  assert.strictEqual(record(incomplete).transportStatus, "incomplete");
  assert.strictEqual(record(incomplete).failureKind, "delivery");
  assert.strictEqual(record(incomplete).collectionMethod, "subagent_stop");
  assert.ok(record(incomplete).collectedAt);
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
  assert.strictEqual(reaped.collectionMethod, "task_reaped");
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
  assert.strictEqual(reaped.collectionMethod, "task_reaped");
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

test("an armed async worker is collected by SubagentStop and remains verdict gated", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box));
  const task = record(box);
  const transcriptPath = path.join(box.root, "tasks", "agent-a1.output");
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, "", "utf8");
  run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "a1", outputFile: transcriptPath, resolvedModel: "claude-sonnet-5" }
  });
  const pending = record(box);
  assert.strictEqual(pending.taskId, task.taskId);
  assert.strictEqual(pending.agentId, "a1");
  assert.strictEqual(pending.backgroundTaskId, "a1");
  assert.strictEqual(pending.transportStatus, "pending_async");
  assert.strictEqual(pending.resolvedModel, "claude-sonnet-5");
  assert.strictEqual(pending.transcriptPath, transcriptPath);
  assert.strictEqual(pending.outputFile, null);

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
  assert.strictEqual(secondStop.stdout, "");
  assert.strictEqual(record(box).awaitingCollectionArmedAt, armedAt);

  const finalMessage = "completed result\ndelivery: complete\nverification: passed";
  updateWorkerRecord(record(box).taskId, envFor(box), (current) => ({ ...current, failureKind: "turn_limit" }));
  run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_transcript_path: transcriptPath,
    agent_id: "a1",
    agent_type: "fusion:fast-worker",
    stop_hook_active: false,
    last_assistant_message: finalMessage
  });
  const finalTextFile = record(box).outputFile;
  assert.ok(finalTextFile);
  assert.notStrictEqual(finalTextFile, transcriptPath);
  assert.strictEqual(record(box).transportStatus, "done");
  assert.strictEqual(record(box).collectionMethod, "subagent_stop");
  assert.ok(record(box).collectedAt);
  assert.strictEqual(record(box).awaitingCollection, false);
  assert.strictEqual(record(box).awaitingCollectionArmedAt, null);
  assert.strictEqual(record(box).awaitingVerdict, true);

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
  assert.strictEqual(decision.decision, undefined);
  assert.match(decision.hookSpecificOutput.additionalContext, /Acceptance remains unverified for 1 collected Fusion worker/);
  assert.doesNotMatch(decision.hookSpecificOutput.additionalContext, /Call Read with file_path=|TaskOutput/);
  assert.match(decision.hookSpecificOutput.additionalContext, /unverified/);
  assert.strictEqual(record(box).failureKind, null);
  assert.strictEqual(record(box).recoveredFailureKind, "turn_limit");

  const collectedStop = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  assert.strictEqual(JSON.parse(collectedStop.stdout).decision, undefined);
  assert.match(JSON.parse(collectedStop.stdout).hookSpecificOutput.additionalContext, /Acceptance remains unverified/);

  recordWorkerAcceptance({ taskId: record(box).taskId, acceptance: "accepted", env: envFor(box), source: "main-loop" });
  const settledStop = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  assert.strictEqual(settledStop.stdout, "");
});

test("a completed async worker is collected at SubagentStop and remains verdict gated", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box));
  const transcriptPath = path.join(box.root, "tasks", "agent-collected.output");
  const finalMessage = "completed result\ndelivery: complete\nverification: passed";
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, `${finalMessage}\n`, "utf8");
  run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "agent-collected", outputFile: transcriptPath }
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
    agent_transcript_path: transcriptPath,
    agent_id: "agent-collected",
    agent_type: "fusion:fast-worker",
    stop_hook_active: false,
    last_assistant_message: finalMessage
  });
  const stopped = record(box);
  const taskId = stopped.taskId;
  const finalTextFile = stopped.outputFile;
  assert.strictEqual(stopped.transportStatus, "done");
  assert.strictEqual(stopped.collectionMethod, "subagent_stop");
  assert.ok(stopped.collectedAt);
  assert.strictEqual(stopped.awaitingVerdict, true);
  assert.strictEqual(stopped.transcriptPath, transcriptPath);
  assert.strictEqual(finalTextFile, path.join(box.state, "jobs", `${stopped.taskId}.final.txt`));
  assert.strictEqual(fs.readFileSync(finalTextFile, "utf8"), finalMessage);
  assert.strictEqual(fs.statSync(finalTextFile).mode & 0o777, 0o600);

  const blocked = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: "done",
    background_tasks: []
  });
  const blockedOutput = JSON.parse(blocked.stdout);
  assert.strictEqual(blockedOutput.decision, undefined);
  assert.match(blockedOutput.hookSpecificOutput.additionalContext, /Acceptance remains unverified for 1 collected Fusion worker/);
  assert.doesNotMatch(blockedOutput.hookSpecificOutput.additionalContext, /Call Read with file_path=|TaskOutput/);

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
    assert.strictEqual(record(box).transportStatus, "done");
    assert.strictEqual(record(box).collectionMethod, "subagent_stop");
  }

  recordWorkerAcceptance({ taskId, acceptance: "accepted", env: envFor(box), source: "main-loop" });
  const allowed = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: "done",
    background_tasks: []
  });
  assert.strictEqual(allowed.stdout, "");
});

test("SubagentStop bounds an oversized final-text artifact to a 72KB payload with a truncation marker", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box));
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "oversized-final",
    agent_type: "fusion:fast-worker"
  });
  const finalMessage = `${"h".repeat(65_536)}${"m".repeat(200_000)}${"t".repeat(130_000)}\ndelivery: complete\nverification: passed`;
  run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "oversized-final",
    agent_type: "fusion:fast-worker",
    stop_hook_active: false,
    last_assistant_message: finalMessage
  });

  const artifact = fs.readFileSync(record(box).outputFile);
  const source = Buffer.from(finalMessage, "utf8");
  const omitted = source.length - 24_576 - 49_152;
  const marker = Buffer.from(`\n[fusion: truncated ${omitted} bytes]\n`, "utf8");
  assert.deepStrictEqual(artifact, Buffer.concat([source.subarray(0, 24_576), marker, source.subarray(source.length - 49_152)]));
  assert.strictEqual(artifact.length, 72 * 1024 + marker.length);
});

test("SubagentStop finalizes the record when the final-text artifact write fails", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box));
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "artifact-write-failure",
    agent_type: "fusion:fast-worker"
  });
  const taskId = record(box).taskId;
  fs.mkdirSync(path.join(box.state, "jobs", `${taskId}.final.txt`), { recursive: true });

  const stopped = run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "artifact-write-failure",
    agent_type: "fusion:fast-worker",
    stop_hook_active: false,
    last_assistant_message: "summary\ndelivery: complete\nverification: passed"
  });
  assert.strictEqual(stopped.status, 0, stopped.stderr);
  assert.strictEqual(stopped.stdout, "");

  const completed = record(box);
  assert.strictEqual(completed.transportStatus, "done");
  assert.strictEqual(completed.failureKind, null);
  assert.strictEqual(completed.outputFile, null);
  assert.ok(completed.collectedAt);
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
  assert.strictEqual(completed.collectionMethod, "agent_result");
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

test("Stop in-flight advisory emits only when the in-flight set changes", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box));
  run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "a1", resolvedModel: "claude-sonnet-5" }
  });
  const backgroundTasks = [{ id: "a1", type: "subagent", status: "running", agent_type: "fusion:fast-worker" }];

  const firstStop = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: "done",
    background_tasks: backgroundTasks
  });
  const firstOutput = JSON.parse(firstStop.stdout);
  assert.strictEqual(firstOutput.decision, undefined);
  assert.match(firstOutput.hookSpecificOutput.additionalContext, /still in flight/);
  assert.match(firstOutput.hookSpecificOutput.additionalContext, /Collection is armed/);
  assert.strictEqual(record(box).awaitingCollection, true);
  const armedAt = record(box).awaitingCollectionArmedAt;
  assert.ok(armedAt);

  const unchanged = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: "done",
    background_tasks: backgroundTasks
  });
  assert.strictEqual(unchanged.stdout, "");

  const reentered = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: true,
    last_assistant_message: "done",
    background_tasks: backgroundTasks
  });
  assert.strictEqual(reentered.stdout, "");
  assert.strictEqual(record(box).awaitingCollection, true);
  assert.strictEqual(record(box).awaitingCollectionArmedAt, armedAt);

  const secondDispatch = { ...dispatch(box, { description: "fix b" }), tool_use_id: "tool-2" };
  run(box, secondDispatch);
  run(box, {
    ...secondDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "a2", resolvedModel: "claude-sonnet-5" }
  });
  const expandedBackgroundTasks = [...backgroundTasks, { id: "a2", type: "subagent", status: "running", agent_type: "fusion:fast-worker" }];
  const changed = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: "done",
    background_tasks: expandedBackgroundTasks
  });
  assert.match(JSON.parse(changed.stdout).hookSpecificOutput.additionalContext, /Collection is armed/);

  const emptied = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: "done",
    background_tasks: expandedBackgroundTasks.map((task) => ({ ...task, status: "completed" }))
  });
  assert.strictEqual(JSON.parse(emptied.stdout).decision, "block");
  for (const worker of readWorkerRecords(envFor(box))) {
    updateWorkerRecord(worker.taskId, envFor(box), (current) => ({
      ...current,
      transportStatus: "done",
      collectedAt: new Date().toISOString(),
      awaitingCollection: false,
      awaitingCollectionArmedAt: null,
      awaitingVerdict: false,
      awaitingVerdictArmedAt: null
    }));
  }

  const thirdDispatch = { ...dispatch(box, { description: "fix c" }), tool_use_id: "tool-3" };
  run(box, thirdDispatch);
  run(box, {
    ...thirdDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "a3", resolvedModel: "claude-sonnet-5" }
  });
  const newWave = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: "done",
    background_tasks: [{ id: "a3", type: "subagent", status: "running", agent_type: "fusion:fast-worker" }]
  });
  assert.match(JSON.parse(newWave.stdout).hookSpecificOutput.additionalContext, /Collection is armed/);
});

test("a successfully terminal async worker without a final-text artifact demands TaskOutput", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box));
  const transcriptPath = path.join(box.root, "tasks", "agent-a1.output");
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, "", "utf8");
  run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "a1", outputFile: transcriptPath, resolvedModel: "claude-sonnet-5" }
  });
  assert.strictEqual(record(box).outputFile, null);
  assert.strictEqual(record(box).transcriptPath, transcriptPath);

  const terminalStop = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: true,
    last_assistant_message: "done",
    background_tasks: [{ id: "a1", type: "subagent", status: "completed", agent_type: "fusion:fast-worker" }]
  });
  const decision = JSON.parse(terminalStop.stdout);
  assert.strictEqual(decision.decision, "block");
  assert.strictEqual(record(box).transportStatus, "ready_uncollected");
  assert.strictEqual(record(box).collectedAt, null);
  assert.match(decision.reason, /TaskOutput with block=true.*a1/);
  assert.doesNotMatch(decision.reason, /Call Read with file_path=/);
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

test("a Read collects terminal output and captures its peer job footer", (t) => {
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
  assert.strictEqual(collected.collectionMethod, "output_file_read");
  assert.ok(collected.collectedAt);
  assert.strictEqual(collected.transportStatus, "done");
  assert.strictEqual(collected.failureKind, null);
  assert.strictEqual(collected.deliveryMode, "harness_async");
  assert.strictEqual(collected.peerJobId, peerJobId);
  assert.strictEqual(collected.peerEngine, "codex");
});

test("Read collection debug capture writes the raw response when enabled", (t) => {
  const box = sandbox(t);
  const toolResponse = { type: "text", text: "worker final message", diagnostics: { source: "Read" } };
  const peerJobId = "c".repeat(32);
  const collectorDispatch = dispatch(box, { subagent_type: "fusion:job-collector", prompt: collectorPrompt("codex", peerJobId) });
  run(box, collectorDispatch);
  run(box, {
    ...collectorDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "debug-read" }
  });
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "debug-read",
    agent_type: "fusion:job-collector"
  });
  run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "debug-read",
    agent_type: "fusion:job-collector",
    stop_hook_active: false,
    last_assistant_message: `collector: state=done semantic=unverified engine=codex job=${peerJobId} elapsed=1s`
  });
  const finalTextFile = record(box).outputFile;
  assert.strictEqual(record(box).transportStatus, "ready_uncollected");

  const collected = run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "Read",
    tool_input: { file_path: finalTextFile },
    tool_response: toolResponse
  }, { FUSION_WORKER_DEBUG_COLLECTION_RESPONSE: "1" });
  assert.strictEqual(collected.status, 0, collected.stderr);
  const debugFile = path.join(box.root, "fusion-data", "worker-collection-response.json");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(debugFile, "utf8")), toolResponse);
});

test("a terminal failed runtimeAsync worker is demanded by Stop and collected by a Read", (t) => {
  const box = sandbox(t);
  const outputFile = path.join(box.root, "tasks", "terminal-failed.output");
  const output = "worker final message before it failed\n";
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, output, "utf8");
  run(box, dispatch(box));
  run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "terminal-failed" }
  });
  assert.strictEqual(record(box).runtimeAsync, true);
  updateWorkerRecord(record(box).taskId, envFor(box), (current) => ({
    ...current,
    transportStatus: "failed",
    failureKind: "task_reaped",
    outputFile
  }));

  const blocked = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  const blockedOutput = JSON.parse(blocked.stdout);
  assert.strictEqual(blockedOutput.decision, "block");
  assert.match(blockedOutput.reason, /Call Read with file_path=/);
  assert.match(blockedOutput.reason, new RegExp(outputFile));

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
  assert.strictEqual(collected.collectionMethod, "output_file_read");
  assert.ok(collected.collectedAt);
  assert.strictEqual(collected.transportStatus, "done");
  assert.strictEqual(collected.failureKind, "task_reaped");

  const cleared = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  const clearedOutput = JSON.parse(cleared.stdout);
  assert.strictEqual(clearedOutput.decision, undefined);
  assert.match(clearedOutput.hookSpecificOutput.additionalContext, /Acceptance remains unverified for 1 collected Fusion worker/);
  assert.doesNotMatch(clearedOutput.hookSpecificOutput.additionalContext, /Call Read with file_path=|TaskOutput/);
});

test("a terminal cancelled runtimeAsync worker is demanded by Stop and collected by a Read", (t) => {
  const box = sandbox(t);
  const outputFile = path.join(box.root, "tasks", "terminal-cancelled.output");
  const output = "worker final message before it was cancelled\n";
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, output, "utf8");
  run(box, dispatch(box));
  run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "terminal-cancelled" }
  });
  assert.strictEqual(record(box).runtimeAsync, true);
  updateWorkerRecord(record(box).taskId, envFor(box), (current) => ({
    ...current,
    transportStatus: "cancelled",
    failureKind: "cancelled",
    outputFile
  }));

  const blocked = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  const blockedOutput = JSON.parse(blocked.stdout);
  assert.strictEqual(blockedOutput.decision, "block");
  assert.match(blockedOutput.reason, /Call Read with file_path=/);
  assert.match(blockedOutput.reason, new RegExp(outputFile));

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
  assert.strictEqual(collected.collectionMethod, "output_file_read");
  assert.ok(collected.collectedAt);
  assert.strictEqual(collected.transportStatus, "done");
  assert.strictEqual(collected.failureKind, "cancelled");

  const cleared = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  const clearedOutput = JSON.parse(cleared.stdout);
  assert.strictEqual(clearedOutput.decision, undefined);
  assert.match(clearedOutput.hookSpecificOutput.additionalContext, /Acceptance remains unverified for 1 collected Fusion worker/);
  assert.doesNotMatch(clearedOutput.hookSpecificOutput.additionalContext, /Call Read with file_path=|TaskOutput/);
});

test("a failed Read of a terminal runtimeAsync record's output file collects with a limit", (t) => {
  const box = sandbox(t);
  const outputFile = path.join(box.root, "tasks", "terminal-partial.output");
  const output = "worker final message\n";
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, output, "utf8");
  run(box, dispatch(box));
  run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "terminal-partial" }
  });
  updateWorkerRecord(record(box).taskId, envFor(box), (current) => ({
    ...current,
    transportStatus: "failed",
    failureKind: "task_reaped",
    outputFile
  }));

  run(box, {
    hook_event_name: "PostToolUseFailure",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "Read",
    tool_input: { file_path: outputFile, limit: 1 },
    tool_response: { is_error: true, content: "Read output exceeded the size limit" }
  });

  const collected = record(box);
  assert.ok(collected.collectedAt);
  assert.strictEqual(collected.collectionMethod, "output_file_read");
  assert.strictEqual(collected.transportStatus, "done");
});

test("a Read of a terminal runtimeAsync record's transcript path collects with offset and limit", (t) => {
  const box = sandbox(t);
  const transcriptPath = path.join(box.root, "tasks", "terminal-transcript.jsonl");
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, "worker final message\n", "utf8");
  run(box, dispatch(box));
  updateWorkerRecord(record(box).taskId, envFor(box), (current) => ({
    ...current,
    transportStatus: "ready_uncollected",
    outputFile: null,
    transcriptPath
  }));

  run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "Read",
    tool_input: { file_path: transcriptPath, offset: 1, limit: 1 },
    tool_response: { type: "text", text: "worker" }
  });

  const collected = record(box);
  assert.ok(collected.collectedAt);
  assert.strictEqual(collected.collectionMethod, "output_file_read");
  assert.strictEqual(collected.transportStatus, "done");
});

test("a Read of an unrelated file does not collect a terminal runtimeAsync record", (t) => {
  const box = sandbox(t);
  const outputFile = path.join(box.root, "tasks", "terminal-unrelated-target.output");
  const unrelatedFile = path.join(box.root, "tasks", "terminal-unrelated-other.output");
  const output = "worker final message\n";
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, output, "utf8");
  fs.writeFileSync(unrelatedFile, "some other file", "utf8");
  run(box, dispatch(box));
  run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "terminal-unrelated" }
  });
  updateWorkerRecord(record(box).taskId, envFor(box), (current) => ({
    ...current,
    transportStatus: "cancelled",
    failureKind: "cancelled",
    outputFile
  }));

  run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "Read",
    tool_input: { file_path: unrelatedFile },
    tool_response: { type: "text", text: "some other file" }
  });

  const untouched = record(box);
  assert.strictEqual(untouched.collectedAt, null);
  assert.strictEqual(untouched.collectionMethod, null);
  assert.strictEqual(untouched.transportStatus, "cancelled");

  const blocked = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  const blockedOutput = JSON.parse(blocked.stdout);
  assert.strictEqual(blockedOutput.decision, "block");
  assert.match(blockedOutput.reason, /Call Read with file_path=/);
});

test("a ready_uncollected record still collects through a Read", (t) => {
  const box = sandbox(t);
  const outputFile = path.join(box.root, "tasks", "ready-uncollected-unchanged.output");
  const output = "worker final message\ndelivery: complete\nverification: passed\n";
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, output, "utf8");
  run(box, dispatch(box));
  updateWorkerRecord(record(box).taskId, envFor(box), (current) => ({
    ...current,
    transportStatus: "ready_uncollected",
    outputFile
  }));

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
  assert.strictEqual(collected.transportStatus, "done");
  assert.strictEqual(collected.collectionMethod, "output_file_read");
  assert.ok(collected.collectedAt);
});

test("a terminal record with collectedAt already set is not demanded again and a further Read leaves it unchanged", (t) => {
  const box = sandbox(t);
  const outputFile = path.join(box.root, "tasks", "terminal-already-collected.output");
  const output = "worker final message\n";
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, output, "utf8");
  run(box, dispatch(box));
  run(box, {
    ...dispatch(box),
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "already-collected" }
  });
  const already = updateWorkerRecord(record(box).taskId, envFor(box), (current) => ({
    ...current,
    transportStatus: "failed",
    failureKind: "task_reaped",
    outputFile,
    collectionMethod: "reaped",
    collectedAt: "2026-07-19T00:00:01.000Z",
    finishedAt: "2026-07-19T00:00:01.000Z"
  }));

  const quiet = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  assert.strictEqual(quiet.stdout, "");

  run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "Read",
    tool_input: { file_path: outputFile },
    tool_response: { type: "text", text: output }
  });

  assert.deepStrictEqual(record(box), already);
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
  assert.strictEqual(collected.collectionMethod, "subagent_stop");
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
  assert.strictEqual(record(box).collectionMethod, "subagent_stop");
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
  assert.strictEqual(record(box).collectionMethod, "subagent_stop");
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
  assert.strictEqual(record(box).collectionMethod, "subagent_stop");
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

test("an async collector keeps its Read collection requirement", (t) => {
  const box = sandbox(t);
  const peerJobId = "b".repeat(32);
  const collectorDispatch = dispatch(box, { subagent_type: "fusion:job-collector", prompt: collectorPrompt("codex", peerJobId) });
  run(box, collectorDispatch);
  run(box, {
    ...collectorDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "collector-async" }
  });
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "collector-async",
    agent_type: "fusion:job-collector"
  });
  const finalMessage = `Codex transport completed.\ncollector: state=done semantic=unverified engine=codex job=${peerJobId} elapsed=3s`;
  run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "collector-async",
    agent_type: "fusion:job-collector",
    stop_hook_active: false,
    last_assistant_message: finalMessage
  });

  const stopped = record(box);
  const finalTextFile = stopped.outputFile;
  assert.strictEqual(stopped.transportStatus, "ready_uncollected");
  assert.strictEqual(stopped.collectionMethod, null);
  assert.strictEqual(stopped.collectedAt, null);
  assert.ok(finalTextFile);

  const blocked = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  assert.strictEqual(JSON.parse(blocked.stdout).decision, "block");
  assert.match(JSON.parse(blocked.stdout).reason, /Call Read with file_path=/);
  assert.match(JSON.parse(blocked.stdout).reason, new RegExp(finalTextFile));

  run(box, {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    tool_name: "Read",
    tool_input: { file_path: finalTextFile },
    tool_response: { type: "text", text: finalMessage }
  });
  const collected = record(box);
  assert.strictEqual(collected.transportStatus, "done");
  assert.strictEqual(collected.collectionMethod, "output_file_read");
  assert.ok(collected.collectedAt);
});

test("a structured Codex collection persists final text and remains gated until semantic judgment", (t) => {
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
  const finalMessage = `Codex transport completed, but the task still needs verification.\ncollector: state=done semantic=unverified engine=codex job=${peerJobId} elapsed=3s`;
  const stopped = run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "collector-semantic",
    agent_type: "fusion:job-collector",
    stop_hook_active: false,
    last_assistant_message: finalMessage
  });
  assert.strictEqual(stopped.stdout, "");
  const collector = record(box);
  assert.strictEqual(collector.transportStatus, "done");
  assert.strictEqual(collector.peerJobId, peerJobId);
  assert.strictEqual(collector.peerTransportStatus, "done");
  assert.strictEqual(collector.peerSemanticStatus, "unverified");
  assert.strictEqual(collector.acceptanceRecordedAt, undefined);
  assert.strictEqual(fs.readFileSync(collector.outputFile, "utf8"), finalMessage);

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
    if (count === 0) {
      const output = JSON.parse(stop.stdout);
      assert.strictEqual(output.decision, undefined);
      assert.match(output.hookSpecificOutput.additionalContext, /still in flight/);
    } else {
      assert.strictEqual(stop.stdout, "");
    }
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

test("Stop does not launder a failed runtime task into success across two rounds", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box));
  const taskId = record(box).taskId;
  updateWorkerRecord(taskId, envFor(box), (current) => ({
    ...current,
    transportStatus: "cancel_requested",
    failureKind: "timeout",
    cancelReason: "wall clock budget reached (1200000ms)"
  }));
  const backgroundTasks = [{ id: "terminal-fail-1", type: "subagent", status: "failed", agent_type: "fusion:fast-worker" }];

  const firstStop = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: "still working",
    background_tasks: backgroundTasks
  });
  assert.strictEqual(JSON.parse(firstStop.stdout).decision, "block");
  const afterFirstRound = record(box);
  assert.strictEqual(afterFirstRound.transportStatus, "ready_uncollected");
  assert.strictEqual(afterFirstRound.failureKind, "timeout");
  assert.strictEqual(afterFirstRound.recoveredFailureKind, undefined);

  const secondStop = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: "still working",
    background_tasks: backgroundTasks
  });
  assert.strictEqual(JSON.parse(secondStop.stdout).decision, "block");
  const afterSecondRound = record(box);
  assert.strictEqual(afterSecondRound.transportStatus, "ready_uncollected");
  assert.strictEqual(afterSecondRound.failureKind, "timeout");
  assert.strictEqual(afterSecondRound.recoveredFailureKind, undefined);
  assert.strictEqual(afterSecondRound.cancelReason, "wall clock budget reached (1200000ms)");
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
    if (count === 0) {
      assert.strictEqual(JSON.parse(stop.stdout).decision, undefined);
      assert.match(JSON.parse(stop.stdout).hookSpecificOutput.additionalContext, /still in flight/);
    } else {
      assert.strictEqual(stop.stdout, "");
    }
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

test("a completed background worker is not timed out while awaiting verdict settlement", (t) => {
  const box = sandbox(t);
  const limits = { FUSION_WORKER_WALL_CLOCK_MS: "1", FUSION_WORKER_STALL_MS: "999999" };
  fs.writeFileSync(box.transcript, `${JSON.stringify({ type: "user", message: { content: "do it --background" } })}\n`, "utf8");
  run(box, dispatch(box, { run_in_background: true }), limits);
  run(box, {
    ...dispatch(box, { run_in_background: true }),
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "completed-budget" }
  }, limits);
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "completed-budget",
    agent_type: "fusion:fast-worker"
  }, limits);
  updateWorkerRecord(record(box).taskId, envFor(box), (current) => ({
    ...current,
    startedAt: new Date(Date.now() + 60_000).toISOString()
  }));
  run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "completed-budget",
    agent_type: "fusion:fast-worker",
    stop_hook_active: false,
    last_assistant_message: "summary\ndelivery: complete\nverification: passed"
  }, limits);
  const taskId = record(box).taskId;
  assert.strictEqual(record(box).transportStatus, "done");
  assert.strictEqual(record(box).collectionMethod, "subagent_stop");
  assert.strictEqual(record(box).awaitingVerdict, true);
  updateWorkerRecord(taskId, envFor(box), (current) => ({
    ...current,
    startedAt: new Date(Date.now() - 2_000).toISOString()
  }));

  const stopped = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: `Background task ${taskId} completed as completed-budget.`,
    background_tasks: []
  }, limits);
  const worker = record(box);
  const stoppedOutput = JSON.parse(stopped.stdout);
  assert.strictEqual(stoppedOutput.decision, undefined);
  assert.match(stoppedOutput.hookSpecificOutput.additionalContext, /Acceptance remains unverified for 1 collected Fusion worker/);
  assert.doesNotMatch(stoppedOutput.hookSpecificOutput.additionalContext, /TaskStop/);
  assert.strictEqual(worker.transportStatus, "done");
  assert.notStrictEqual(worker.failureKind, "timeout");
  assert.notStrictEqual(worker.transportStatus, "cancel_requested");
});

test("an explicitly authorized completed worker is collected by SubagentStop before verdict settlement", (t) => {
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
  const stopped = record(box);
  const taskId = stopped.taskId;
  const finalTextFile = stopped.outputFile;
  assert.strictEqual(stopped.transportStatus, "done");
  assert.strictEqual(stopped.collectionMethod, "subagent_stop");
  assert.ok(stopped.collectedAt);
  assert.strictEqual(stopped.awaitingVerdict, true);
  assert.ok(fs.existsSync(finalTextFile));

  const blocked = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    last_assistant_message: `Background task ${taskId} completed as manual-ready.`,
    background_tasks: []
  });
  const blockedOutput = JSON.parse(blocked.stdout);
  assert.strictEqual(blockedOutput.decision, undefined);
  assert.match(blockedOutput.hookSpecificOutput.additionalContext, /Acceptance remains unverified for 1 collected Fusion worker/);
  assert.doesNotMatch(blockedOutput.hookSpecificOutput.additionalContext, /Call Read with file_path=|TaskOutput/);

  recordWorkerAcceptance({ taskId, acceptance: "accepted", env: envFor(box), source: "main-loop" });

  const allowed = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    background_tasks: []
  });
  assert.strictEqual(allowed.stdout, "");
  assert.strictEqual(record(box).transportStatus, "done");
});

test("Stop settles a delivered task notification once without a TaskOutput probe", (t) => {
  const box = sandbox(t);
  const workerTranscript = path.join(box.root, "notification-worker.output");
  const finalMessage = "bounded notification result\ndelivery: complete\nverification: passed";
  fs.writeFileSync(workerTranscript, [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }] }, toolUseResult: { content: "done" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "bounded notification result" }, { type: "text", text: "delivery: complete\nverification: passed" }] } })
  ].join("\n") + "\n", "utf8");
  const workerDispatch = dispatch(box);
  run(box, workerDispatch);
  run(box, {
    ...workerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "notification-worker", outputFile: workerTranscript }
  });
  const before = record(box);
  fs.appendFileSync(box.transcript, `${JSON.stringify({ type: "user", message: { content: `<task-notification>\n<task-id>${before.agentId}</task-id>\n<status>completed</status>\n</task-notification>` } })}\n`, "utf8");

  const stopped = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: true,
    background_tasks: []
  });
  assert.strictEqual(stopped.status, 0);
  assert.strictEqual(stopped.stdout, "");
  const collected = record(box);
  assert.strictEqual(collected.transportStatus, "done");
  assert.strictEqual(collected.collectionMethod, "task_notification");
  assert.ok(collected.collectedAt);
  assert.strictEqual(collected.failureKind, null);
  assert.strictEqual(collected.deliveryMode, null);
  assert.strictEqual(collected.awaitingVerdict, true);
  assert.strictEqual(collected.outputFile, path.join(box.state, "jobs", `${collected.taskId}.final.txt`));
  assert.notStrictEqual(collected.outputFile, workerTranscript);
  assert.strictEqual(fs.readFileSync(collected.outputFile, "utf8"), finalMessage);

  const scanState = readWorkerSessionState("session-1", envFor(box));
  assert.strictEqual(scanState.taskNotificationTranscriptPath, box.transcript);
  assert.strictEqual(scanState.taskNotificationScanOffset, fs.statSync(box.transcript).size);

  const repeated = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: true,
    background_tasks: []
  });
  assert.strictEqual(repeated.status, 0);
  assert.strictEqual(repeated.stdout, "");
  assert.deepStrictEqual(readWorkerSessionState("session-1", envFor(box)), scanState);

  const settled = recordWorkerAcceptance({ taskId: collected.taskId, acceptance: "accepted", env: envFor(box), source: "main-loop" });
  assert.strictEqual(settled.acceptance, "accepted");
});

test("a task notification output file stamps a null transcript path and writes final text", (t) => {
  const box = sandbox(t);
  const workerTranscript = path.join(box.root, "notification-output-file.jsonl");
  const finalMessage = "notification supplied transcript\ndelivery: complete\nverification: passed";
  fs.writeFileSync(workerTranscript, `${JSON.stringify({ type: "assistant", requestId: "turn-1", message: { content: [{ type: "text", text: finalMessage }] } })}\n`, "utf8");
  const workerDispatch = dispatch(box);
  run(box, workerDispatch);
  run(box, {
    ...workerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "notification-output-file" }
  });
  const launched = record(box);
  assert.strictEqual(launched.transcriptPath, null);
  fs.appendFileSync(box.transcript, `${JSON.stringify({ type: "user", message: { content: `<task-notification>\n<task-id>${launched.agentId}</task-id>\n<status>completed</status>\n<output-file>${workerTranscript}</output-file>\n</task-notification>` } })}\n`, "utf8");

  run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: true,
    background_tasks: []
  });

  const collected = record(box);
  assert.strictEqual(collected.transcriptPath, workerTranscript);
  assert.strictEqual(collected.transportStatus, "done");
  assert.strictEqual(collected.collectionMethod, "task_notification");
  assert.strictEqual(collected.failureKind, null);
  assert.strictEqual(fs.readFileSync(collected.outputFile, "utf8"), finalMessage);
});

test("a completed task notification captures a Codex peer job footer", (t) => {
  const box = sandbox(t);
  const peerJobId = "f".repeat(32);
  const workerTranscript = path.join(box.root, "notification-codex-rescue.output");
  const finalMessage = `completed rescue\ncodex-session: session-1\njob: ${peerJobId}\nsemantic: unverified\nstate: done`;
  fs.writeFileSync(workerTranscript, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: finalMessage }] } })}\n`, "utf8");
  const workerDispatch = dispatch(box, { subagent_type: "codex:codex-rescue", prompt: "bounded peer brief" });
  run(box, workerDispatch);
  run(box, {
    ...workerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "notification-codex-rescue" }
  });
  const launched = record(box);
  assert.strictEqual(launched.transcriptPath, null);
  const before = record(box);
  fs.appendFileSync(box.transcript, `${JSON.stringify({ type: "user", message: { content: `<task-notification>\n<task-id>${before.agentId}</task-id>\n<status>completed</status>\n<output-file>${workerTranscript}</output-file>\n</task-notification>` } })}\n`, "utf8");

  run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: true,
    background_tasks: []
  });

  const collected = record(box);
  assert.strictEqual(collected.transcriptPath, workerTranscript);
  assert.strictEqual(collected.transportStatus, "done");
  assert.strictEqual(collected.failureKind, null);
  assert.strictEqual(collected.peerJobId, peerJobId);
  assert.strictEqual(collected.peerEngine, "codex");
  assert.strictEqual(collected.peerTransportStatus, undefined);
  assert.strictEqual(collected.peerSemanticStatus, undefined);
});

test("an incomplete peer notification captures its job footer from the bounded transcript tail", (t) => {
  const box = sandbox(t);
  const peerJobId = "d".repeat(32);
  const workerTranscript = path.join(box.root, "notification-peer-dangling.output");
  fs.writeFileSync(workerTranscript, [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `partial rescue\njob: ${peerJobId}` }, { type: "tool_use", id: "tool-1" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }] }, toolUseResult: { content: "done" } })
  ].join("\n") + "\n", "utf8");
  const workerDispatch = dispatch(box, { subagent_type: "codex:codex-rescue", prompt: "bounded peer brief" });
  run(box, workerDispatch);
  run(box, {
    ...workerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "notification-peer-dangling" }
  });
  const launched = record(box);
  fs.appendFileSync(box.transcript, `${JSON.stringify({ type: "user", message: { content: `<task-notification>\n<task-id>${launched.agentId}</task-id>\n<status>completed</status>\n<output-file>${workerTranscript}</output-file>\n</task-notification>` } })}\n`, "utf8");

  run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: true,
    background_tasks: []
  });

  const incomplete = record(box);
  assert.strictEqual(incomplete.transportStatus, "incomplete");
  assert.strictEqual(incomplete.failureKind, "missing_final_text");
  assert.strictEqual(incomplete.peerJobId, peerJobId);
  assert.strictEqual(incomplete.peerEngine, "codex");
});

test("a completed task notification does not parse peer footers for fusion workers", (t) => {
  const box = sandbox(t);
  const workerTranscript = path.join(box.root, "notification-fast-worker.output");
  const finalMessage = `completed worker\ncodex-session: session-1\njob: ${"e".repeat(32)}\nsemantic: unverified\nstate: done`;
  fs.writeFileSync(workerTranscript, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: finalMessage }] } })}\n`, "utf8");
  const workerDispatch = dispatch(box);
  run(box, workerDispatch);
  run(box, {
    ...workerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "notification-fast-worker", outputFile: workerTranscript }
  });
  const before = record(box);
  fs.appendFileSync(box.transcript, `${JSON.stringify({ type: "user", message: { content: `<task-notification>\n<task-id>${before.agentId}</task-id>\n<status>completed</status>\n</task-notification>` } })}\n`, "utf8");

  run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: true,
    background_tasks: []
  });

  const collected = record(box);
  assert.strictEqual(collected.peerJobId, undefined);
  assert.strictEqual(collected.peerEngine, undefined);
  assert.strictEqual(collected.peerTransportStatus, undefined);
  assert.strictEqual(collected.peerSemanticStatus, undefined);
});

test("a completion notification with a dangling tool result remains incomplete and uncollected", (t) => {
  const box = sandbox(t);
  const workerTranscript = path.join(box.root, "notification-dangling.output");
  fs.writeFileSync(workerTranscript, [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }, { type: "tool_use", id: "tool-1" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }] }, toolUseResult: { content: "done" } })
  ].join("\n") + "\n", "utf8");
  const workerDispatch = dispatch(box);
  run(box, workerDispatch);
  run(box, {
    ...workerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "notification-dangling", outputFile: workerTranscript }
  });
  const before = record(box);
  updateWorkerRecord(before.taskId, envFor(box), (current) => ({ ...current, turns: 5 }));
  fs.appendFileSync(box.transcript, `${JSON.stringify({ type: "user", message: { content: `<task-notification>\n<task-id>${before.agentId}</task-id>\n<status>completed</status>\n</task-notification>` } })}\n`, "utf8");

  run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: true,
    background_tasks: []
  });

  const incomplete = record(box);
  assert.strictEqual(incomplete.transportStatus, "incomplete");
  assert.strictEqual(incomplete.failureKind, "missing_final_text");
  assert.strictEqual(incomplete.turns, 5);
  assert.strictEqual(incomplete.collectionMethod, null);
  assert.strictEqual(incomplete.collectedAt, null);
  assert.strictEqual(incomplete.awaitingVerdict, false);
  assert.strictEqual(incomplete.outputFile, null);
  assert.strictEqual(fs.existsSync(path.join(box.state, "jobs", `${incomplete.taskId}.final.txt`)), false);
});

test("a no-text completion at the turn cap remains a turn limit", (t) => {
  const box = sandbox(t);
  const workerTranscript = path.join(box.root, "notification-turn-limit.output");
  fs.writeFileSync(workerTranscript, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1" }] } })}\n`, "utf8");
  const workerDispatch = dispatch(box);
  run(box, workerDispatch);
  run(box, {
    ...workerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "notification-turn-limit", outputFile: workerTranscript }
  });
  const launched = record(box);
  updateWorkerRecord(launched.taskId, envFor(box), (current) => ({ ...current, turns: 60 }));
  fs.appendFileSync(box.transcript, `${JSON.stringify({ type: "user", message: { content: `<task-notification>\n<task-id>${launched.agentId}</task-id>\n<status>completed</status>\n</task-notification>` } })}\n`, "utf8");

  run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: true,
    background_tasks: []
  });

  const incomplete = record(box);
  assert.strictEqual(incomplete.transportStatus, "incomplete");
  assert.strictEqual(incomplete.failureKind, "turn_limit");
  assert.strictEqual(incomplete.turns, 60);
});

test("PostToolUse emits turn wind-down context once at two turns below the cap", (t) => {
  const box = sandbox(t);
  const workerDispatch = dispatch(box);
  run(box, workerDispatch);
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "wind-down",
    agent_type: "fusion:fast-worker"
  });
  const workerTranscript = path.join(box.root, "agent-wind-down.jsonl");
  fs.writeFileSync(workerTranscript, Array.from({ length: 58 }, (_, index) => JSON.stringify({ type: "assistant", requestId: `turn-${index}`, message: { content: [{ type: "text", text: `turn ${index}` }] } })).join("\n") + "\n", "utf8");
  const payload = {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: workerTranscript,
    agent_id: "wind-down",
    agent_type: "fusion:fast-worker",
    tool_name: "Read"
  };

  const first = run(box, payload);
  const firstOutput = JSON.parse(first.stdout);
  assert.match(firstOutput.hookSpecificOutput.additionalContext, /stop making tool calls and write your final deliverable now/);
  assert.strictEqual(record(box).turns, 58);
  const notifiedAt = record(box).windDownContextSentAt;
  assert.ok(notifiedAt);

  const repeated = run(box, payload);
  assert.strictEqual(repeated.stdout, "");
  assert.strictEqual(record(box).windDownContextSentAt, notifiedAt);
});

test("Stop combines multi-record collection and settlement instructions", (t) => {
  const box = sandbox(t);
  const outputFile = path.join(box.root, "peer-terminal.output");
  fs.writeFileSync(outputFile, "peer result\n", "utf8");
  const collecting = createWorkerRecord({
    taskId: `fusion-${"1".repeat(24)}`,
    sessionId: "session-1",
    agentType: "codex:codex-rescue",
    workspaceRoot: box.cwd,
    outputFile
  }, envFor(box));
  updateWorkerRecord(collecting.taskId, envFor(box), (current) => ({ ...current, agentId: "collecting-peer", backgroundTaskId: "collecting-peer", transportStatus: "ready_uncollected", runtimeAsync: true }));
  const settling = createWorkerRecord({
    taskId: `fusion-${"2".repeat(24)}`,
    sessionId: "session-1",
    agentType: "fusion:fast-worker",
    workspaceRoot: box.cwd
  }, envFor(box));
  const collectedAt = new Date().toISOString();
  updateWorkerRecord(settling.taskId, envFor(box), (current) => ({ ...current, transportStatus: "done", collectedAt, collectionMethod: WORKER_COLLECTION_METHODS.SUBAGENT_STOP, awaitingVerdict: true, awaitingVerdictArmedAt: collectedAt }));

  const stopped = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    background_tasks: []
  });

  assert.strictEqual(stopped.stdout.trim().split("\n").length, 1);
  const decision = JSON.parse(stopped.stdout);
  assert.strictEqual(decision.decision, "block");
  assert.match(decision.reason, new RegExp(`Call Read with file_path=${outputFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(decision.reason, /no offset or limit/);
  assert.match(decision.reason, new RegExp(`settle-only: ${settling.taskId}: /fusion:stats --record ${settling.taskId}=accepted\\|rejected\\|unverified`));
});

test("a delivered completion notification prevents Stop from demanding TaskStop for an expired worker", (t) => {
  const box = sandbox(t);
  const workerTranscript = path.join(box.root, "notification-expired.output");
  fs.writeFileSync(workerTranscript, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "expired worker result" }] } })}\n`, "utf8");
  const limits = { FUSION_WORKER_WALL_CLOCK_MS: "1", FUSION_WORKER_STALL_MS: "999999" };
  const workerDispatch = dispatch(box);
  run(box, workerDispatch, limits);
  run(box, {
    ...workerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "notification-expired", outputFile: workerTranscript }
  }, limits);
  const before = record(box);
  updateWorkerRecord(before.taskId, envFor(box, limits), (current) => ({ ...current, startedAt: new Date(Date.now() - 1_000).toISOString() }));
  fs.appendFileSync(box.transcript, `${JSON.stringify({ type: "user", message: { content: `<task-notification>\n<task-id>${before.agentId}</task-id>\n<status>completed</status>\n</task-notification>` } })}\n`, "utf8");

  const stopped = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: false,
    background_tasks: []
  }, limits);
  assert.strictEqual(stopped.status, 0);
  assert.doesNotMatch(stopped.stdout, /TaskStop/);
  assert.strictEqual(record(box).transportStatus, "done");
  assert.notStrictEqual(record(box).transportStatus, "cancel_requested");
});

test("malformed parent transcript content does not transition a worker during Stop", (t) => {
  const box = sandbox(t);
  const workerDispatch = dispatch(box);
  run(box, workerDispatch);
  run(box, {
    ...workerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "notification-malformed" }
  });
  const before = record(box);
  fs.appendFileSync(box.transcript, "{not valid json}\n", "utf8");

  const stopped = run(box, {
    hook_event_name: "Stop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    stop_hook_active: true,
    background_tasks: [{ id: before.agentId, type: "subagent", status: "running", agent_type: "fusion:fast-worker" }]
  });
  assert.strictEqual(stopped.status, 0);
  const unchanged = record(box);
  assert.strictEqual(unchanged.transportStatus, "pending_async");
  assert.strictEqual(unchanged.collectionMethod, null);
  assert.strictEqual(unchanged.collectedAt, null);
  assert.strictEqual(unchanged.failureKind, null);
  assert.strictEqual(readWorkerSessionState("session-1", envFor(box)).taskNotificationScanOffset, fs.statSync(box.transcript).size);
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
