import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createWorkerRecord, readWorkerOutputFileTaskIds, readWorkerRecord,
  readWorkerSessionState, refreshWorkerTranscript, updateWorkerRecord
} from "../plugins/fusion/scripts/lib/worker-state.mjs";
import { tagMessage } from "../plugins/fusion/scripts/lib/user-messages.mjs";

const lifecycle = path.join(import.meta.dirname, "..", "plugins", "fusion", "scripts", "worker-lifecycle.mjs");

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-compaction-"));
  const children = new Set();
  t.after(() => {
    for (const child of children) {
      if (!child.stdin.destroyed) child.stdin.end();
      child.kill("SIGKILL");
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, FUSION_WORKER_STATE_DIR: path.join(root, "workers"), FUSION_DATA_DIR: path.join(root, "data") };
  const transcript = path.join(root, "parent.jsonl");
  fs.writeFileSync(transcript, "");
  return { root, env, transcript, children };
}

async function hook(box, payload) {
  const child = spawn(process.execPath, [lifecycle], { env: box.env, stdio: ["pipe", "pipe", "pipe"] });
  box.children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  child.stdin.end(JSON.stringify(payload));
  try {
    const { code, signal } = await completion;
    assert.equal(code, 0, stderr || `hook exited on ${signal}`);
    return stdout ? JSON.parse(stdout) : null;
  } finally {
    clearTimeout(timer);
    if (!child.stdin.destroyed) child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    box.children.delete(child);
  }
}

function worker(box, taskId, agentType = "fusion:claude-worker") {
  return createWorkerRecord({ taskId, sessionId: "session-1", agentType, workspaceRoot: box.root }, box.env);
}

test("session output index tracks changed paths and rebuilds a missing index once", (t) => {
  const box = sandbox(t);
  const taskId = "fusion-output-index-one";
  worker(box, taskId);
  const first = path.join(box.root, "first.txt");
  const second = path.join(box.root, "second.txt");
  updateWorkerRecord(taskId, box.env, (record) => ({ ...record, outputFile: first }));
  assert.deepEqual(readWorkerOutputFileTaskIds("session-1", first, box.env), [taskId]);
  updateWorkerRecord(taskId, box.env, (record) => ({ ...record, outputFile: second }));
  assert.deepEqual(readWorkerOutputFileTaskIds("session-1", first, box.env), []);
  assert.deepEqual(readWorkerOutputFileTaskIds("session-1", second, box.env), [taskId]);

  const sessionFile = path.join(box.env.FUSION_WORKER_STATE_DIR, "sessions", "session-1.json");
  const session = readWorkerSessionState("session-1", box.env);
  delete session.outputFiles;
  fs.writeFileSync(sessionFile, JSON.stringify(session));
  assert.deepEqual(readWorkerOutputFileTaskIds("session-1", second, box.env), [taskId]);
  assert.deepEqual(readWorkerSessionState("session-1", box.env).outputFiles[second], [taskId]);
  const originalReaddir = fs.readdirSync;
  fs.readdirSync = (directory, ...args) => {
    if (directory === path.join(box.env.FUSION_WORKER_STATE_DIR, "jobs")) throw new Error("unexpected ledger scan");
    return originalReaddir(directory, ...args);
  };
  try {
    assert.deepEqual(readWorkerOutputFileTaskIds("session-1", second, box.env), [taskId]);
  } finally {
    fs.readdirSync = originalReaddir;
  }
});

test("parent Read uses the path index without parsing unrelated session records", async (t) => {
  const box = sandbox(t);
  const taskId = "fusion-indexed-read";
  const unrelatedId = "fusion-indexed-other";
  worker(box, taskId);
  worker(box, unrelatedId);
  const outputFile = path.join(box.root, "result.txt");
  fs.writeFileSync(outputFile, "finished work\n");
  updateWorkerRecord(taskId, box.env, (record) => ({ ...record, outputFile, transportStatus: "ready_uncollected", runtimeAsync: true }));
  fs.writeFileSync(path.join(box.env.FUSION_WORKER_STATE_DIR, "jobs", `${unrelatedId}.json`), "invalid json");
  await hook(box, { hook_event_name: "PostToolUse", session_id: "session-1", cwd: box.root, tool_name: "Read", tool_input: { file_path: outputFile }, tool_response: { content: "finished work\n" } });
  assert.equal(readWorkerRecord(taskId, box.env).collectionMethod, "output_file_read");
});

test("incremental transcript overlap stays deduplicated after 64-entry compaction", (t) => {
  const box = sandbox(t);
  const taskId = "fusion-usage-overlap";
  const transcript = path.join(box.root, "worker.jsonl");
  const line = (id) => JSON.stringify({ type: "assistant", requestId: `turn-${id}`, message: { id: `message-${id}`, usage: { input_tokens: 2, output_tokens: 1 }, content: [{ type: "tool_use", id: `tool-${id}` }] } });
  fs.writeFileSync(transcript, `${Array.from({ length: 70 }, (_, i) => line(i)).join("\n")}\n`);
  const created = worker(box, taskId);
  updateWorkerRecord(taskId, box.env, () => refreshWorkerTranscript(created, transcript));
  fs.appendFileSync(transcript, `${Array.from({ length: 10 }, (_, i) => line(i + 60)).join("\n")}\n${Array.from({ length: 10 }, (_, i) => line(i + 70)).join("\n")}\n`);
  const refreshed = updateWorkerRecord(taskId, box.env, (record) => refreshWorkerTranscript(record, transcript));
  assert.equal(refreshed.turns, 80);
  assert.equal(refreshed.toolCalls, 80);
  assert.equal(refreshed.usage.inputTokens, 160);
  assert.equal(refreshed.usage.outputTokens, 80);
  assert.deepEqual([Object.keys(refreshed.usageMessages).length, refreshed.turnIds.length, refreshed.toolUseIds.length], [64, 64, 64]);
  assert.equal(refreshed.transcriptRoundPrefix.usage.outputTokens, 16);
  assert.equal(updateWorkerRecord(taskId, box.env, (record) => refreshWorkerTranscript(record, transcript)).usage.outputTokens, 80);
});

test("next write compacts legacy buffers and skips an oversized carry", (t) => {
  const box = sandbox(t);
  const taskId = "fusion-legacy-buffers";
  worker(box, taskId);
  const file = path.join(box.env.FUSION_WORKER_STATE_DIR, "jobs", `${taskId}.json`);
  const legacy = readWorkerRecord(taskId, box.env);
  legacy.usageMessages = Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`m-${i}`, { inputTokens: 1, outputTokens: 1, totalTokens: 2, uncachedTokens: 2 }]));
  legacy.turnIds = Array.from({ length: 90 }, (_, i) => `t-${i}`);
  legacy.toolUseIds = Array.from({ length: 90 }, (_, i) => `u-${i}`);
  legacy.transcriptCarry = "x".repeat(70 * 1024);
  legacy.usage = { inputTokens: 90, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 90, totalTokens: 180, uncachedTokens: 180 };
  fs.writeFileSync(file, JSON.stringify(legacy));
  const compacted = updateWorkerRecord(taskId, box.env, (record) => record);
  assert.deepEqual([Object.keys(compacted.usageMessages).length, compacted.turnIds.length, compacted.toolUseIds.length], [64, 64, 64]);
  assert.equal(compacted.transcriptRoundPrefix.usage.outputTokens, 26);
  assert.equal(compacted.usage.outputTokens, 90);
  assert.equal(compacted.transcriptCarry, "");
  assert.equal(compacted.transcriptSkippingLine, true);
});

test("parent context advice fires at 250k and 800k once each", async (t) => {
  const box = sandbox(t);
  const dispatch = async (id) => {
    const event = { session_id: "session-1", tool_use_id: `tool-${id}`, transcript_path: box.transcript, cwd: box.root, tool_name: "Agent", tool_input: { subagent_type: "codex:codex-rescue", description: "peer", prompt: "bounded peer brief" } };
    const output = await hook(box, { ...event, hook_event_name: "PreToolUse" });
    await hook(box, { ...event, hook_event_name: "PostToolUse", tool_response: { status: "completed", content: [{ type: "text", text: "done" }] } });
    return output;
  };
  const usage = (tokens) => fs.appendFileSync(box.transcript, `${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: tokens } } })}\n`);
  usage(250000);
  assert.match((await dispatch(1)).hookSpecificOutput.additionalContext, /main loop context is 250k/);
  usage(700000);
  assert.equal(await dispatch(2), null);
  usage(800000);
  assert.match((await dispatch(3)).hookSpecificOutput.additionalContext, /main loop context is 800k/);
  assert.equal(await dispatch(4), null);
  const session = readWorkerSessionState("session-1", box.env);
  assert.equal(session.parentContextAdvisorySent, true);
  assert.equal(session.parentContextAdvisory800kSent, true);

  const configured = sandbox(t);
  configured.env.FUSION_PARENT_CONTEXT_ADVISORY_TOKENS = "500000";
  const configuredDispatch = async (id) => {
    const event = { session_id: "session-1", tool_use_id: `configured-${id}`, transcript_path: configured.transcript, cwd: configured.root, tool_name: "Agent", tool_input: { subagent_type: "codex:codex-rescue", description: "peer", prompt: "bounded peer brief" } };
    const output = await hook(configured, { ...event, hook_event_name: "PreToolUse" });
    await hook(configured, { ...event, hook_event_name: "PostToolUse", tool_response: { status: "completed", content: [{ type: "text", text: "done" }] } });
    return output;
  };
  fs.appendFileSync(configured.transcript, `${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 500000 } } })}\n`);
  assert.match((await configuredDispatch(1)).hookSpecificOutput.additionalContext, /main loop context is 500k/);
  fs.appendFileSync(configured.transcript, `${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 800000 } } })}\n`);
  assert.match((await configuredDispatch(2)).hookSpecificOutput.additionalContext, /main loop context is 800k/);
});

test("peer wrapper relays without a recent state footer are flagged without added output", async (t) => {
  const box = sandbox(t);
  for (const [index, agentType] of ["codex:codex-rescue", "grok:grok-rescue", "cursor:cursor-rescue"].entries()) {
    const taskId = `fusion-footer-missing-${index}`;
    worker(box, taskId, agentType);
    updateWorkerRecord(taskId, box.env, (record) => ({ ...record, agentId: `agent-${index}`, transportStatus: "running", runtimeAsync: true }));
    const output = await hook(box, { hook_event_name: "SubagentStop", session_id: "session-1", agent_id: `agent-${index}`, agent_type: agentType, cwd: box.root, transcript_path: box.transcript, last_assistant_message: `job: ${String(index).repeat(32)}\nresult text` });
    assert.equal(output, null);
    assert.equal(readWorkerRecord(taskId, box.env).relayFooterMissing, true);
  }
  const presentId = "fusion-footer-present";
  worker(box, presentId, "codex:codex-rescue");
  updateWorkerRecord(presentId, box.env, (record) => ({ ...record, agentId: "agent-present", transportStatus: "running", runtimeAsync: true }));
  const present = await hook(box, { hook_event_name: "SubagentStop", session_id: "session-1", agent_id: "agent-present", agent_type: "codex:codex-rescue", cwd: box.root, transcript_path: box.transcript, last_assistant_message: `job: ${"a".repeat(32)}\nstate: done\nresult text` });
  assert.equal(present, null);
  assert.equal(readWorkerRecord(presentId, box.env).relayFooterMissing, undefined);

  const staleId = "fusion-footer-stale";
  worker(box, staleId, "codex:codex-rescue");
  updateWorkerRecord(staleId, box.env, (record) => ({ ...record, agentId: "agent-stale", transportStatus: "running", runtimeAsync: true }));
  const stale = await hook(box, { hook_event_name: "SubagentStop", session_id: "session-1", agent_id: "agent-stale", agent_type: "codex:codex-rescue", cwd: box.root, transcript_path: box.transcript, last_assistant_message: `job: ${"b".repeat(32)}\nstate: done\n${Array.from({ length: 16 }, (_, i) => `tail ${i}`).join("\n")}` });
  assert.equal(stale, null);
  assert.equal(readWorkerRecord(staleId, box.env).relayFooterMissing, true);
});

test("a truncated peer relay keeps the exact tagged retry block and records missing-footer telemetry", async (t) => {
  const box = sandbox(t);
  const taskId = "fusion-footer-retry";
  worker(box, taskId, "codex:codex-rescue");
  updateWorkerRecord(taskId, box.env, (record) => ({ ...record, agentId: "agent-retry", transportStatus: "running" }));
  const output = await hook(box, { hook_event_name: "SubagentStop", session_id: "session-1", agent_id: "agent-retry", agent_type: "codex:codex-rescue", cwd: box.root, transcript_path: box.transcript, last_assistant_message: "forward-looking narration without a result" });
  assert.equal(output.reason, tagMessage("worker-lifecycle.deliverable-retry-block", "The transport relay is incomplete. Return the companion output verbatim, including its `job:` and `state:` footer lines. This is the only retry."));
  assert.equal(readWorkerRecord(taskId, box.env).relayFooterMissing, true);
});
