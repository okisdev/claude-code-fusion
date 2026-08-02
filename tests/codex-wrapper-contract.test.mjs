import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { tagMessage } from "../plugins/fusion/scripts/lib/user-messages.mjs";
import { readWorkerRecords } from "../plugins/fusion/scripts/lib/worker-state.mjs";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "plugins", "fusion", "scripts", "worker-lifecycle.mjs");
const hooksConfigPath = path.join(repoRoot, "plugins", "fusion", "hooks", "hooks.json");

function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-wrapper-contract-test-")));
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

function dispatch(box, overrides = {}) {
  return {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    tool_use_id: "tool-1",
    transcript_path: box.transcript,
    cwd: box.cwd,
    tool_name: "Agent",
    tool_input: { subagent_type: "fusion:claude-worker", description: "fix a", prompt: brief(), ...overrides }
  };
}

function record(box) {
  const records = readWorkerRecords(envFor(box));
  assert.strictEqual(records.length, 1);
  return records[0];
}

test("a codex:codex-rescue final carrying the companion envelope completes without a stop block", (t) => {
  const box = sandbox(t);
  const peerJobId = "3".repeat(32);
  const peerDispatch = dispatch(box, { subagent_type: "codex:codex-rescue", prompt: "bounded peer brief" });
  run(box, peerDispatch);
  run(box, {
    ...peerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "codex-envelope-pass" }
  });

  const stopped = run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "codex-envelope-pass",
    agent_type: "codex:codex-rescue",
    stop_hook_active: false,
    last_assistant_message: ["companion result prose", "codex-session: session-1", `job: ${peerJobId}`, "semantic: unverified", "state: done"].join("\n")
  });

  assert.strictEqual(stopped.stdout, "");
  const completed = record(box);
  assert.strictEqual(completed.retryCount, 0);
  assert.strictEqual(completed.failureKind, null);
  assert.strictEqual(completed.peerJobId, peerJobId);
  assert.strictEqual(completed.peerEngine, "codex");
  assert.strictEqual(completed.transportStatus, "ready_uncollected");
});

test("a grok:grok-rescue final carrying the companion envelope completes without a stop block", (t) => {
  const box = sandbox(t);
  const peerJobId = "4".repeat(32);
  const peerDispatch = dispatch(box, { subagent_type: "grok:grok-rescue", prompt: "bounded peer brief" });
  run(box, peerDispatch);
  run(box, {
    ...peerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "grok-envelope-pass" }
  });

  const stopped = run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "grok-envelope-pass",
    agent_type: "grok:grok-rescue",
    stop_hook_active: false,
    last_assistant_message: ["companion result prose", "grok-session: grok-session-9", `job: ${peerJobId}`, "state: done"].join("\n")
  });

  assert.strictEqual(stopped.stdout, "");
  const completed = record(box);
  assert.strictEqual(completed.retryCount, 0);
  assert.strictEqual(completed.failureKind, null);
  assert.strictEqual(completed.peerJobId, peerJobId);
  assert.strictEqual(completed.peerEngine, "grok");
  assert.strictEqual(completed.transportStatus, "ready_uncollected");
});

test("a codex:codex-rescue final that is truncated forward-looking narration blocks exactly once and then terminates without looping", (t) => {
  const box = sandbox(t);
  const peerDispatch = dispatch(box, { subagent_type: "codex:codex-rescue", prompt: "bounded peer brief" });
  run(box, peerDispatch);
  run(box, {
    ...peerDispatch,
    hook_event_name: "PostToolUse",
    tool_response: { isAsync: true, status: "async_launched", agentId: "codex-narration-only" }
  });
  const stopPayload = {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "codex-narration-only",
    agent_type: "codex:codex-rescue",
    stop_hook_active: false,
    last_assistant_message: "I still need to confirm the fix and will report the final result shortly."
  };

  const first = run(box, stopPayload);
  const firstOutput = JSON.parse(first.stdout);
  assert.strictEqual(firstOutput.decision, "block");
  assert.strictEqual(firstOutput.reason, tagMessage("worker-lifecycle.deliverable-retry-block", "The transport relay is incomplete. Return the companion output verbatim, including its `job:` and `state:` footer lines. This is the only retry."));
  assert.strictEqual(record(box).retryCount, 1);

  const second = run(box, stopPayload);
  assert.strictEqual(second.stdout, "");
  const settled = record(box);
  assert.strictEqual(settled.transportStatus, "incomplete");
  assert.strictEqual(settled.failureKind, "delivery");
  assert.strictEqual(settled.retryCount, 1);

  const third = run(box, stopPayload);
  assert.strictEqual(third.stdout, "");
  const stable = record(box);
  assert.strictEqual(stable.transportStatus, "incomplete");
  assert.strictEqual(stable.failureKind, "delivery");
  assert.strictEqual(stable.retryCount, 1);
});

test("a fusion:claude-worker final without EXECUTION_END_MARKER is still blocked", (t) => {
  const box = sandbox(t);
  run(box, dispatch(box));
  run(box, {
    hook_event_name: "SubagentStart",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "fast-worker-narration-only",
    agent_type: "fusion:claude-worker"
  });

  const blocked = run(box, {
    hook_event_name: "SubagentStop",
    session_id: "session-1",
    cwd: box.cwd,
    transcript_path: box.transcript,
    agent_id: "fast-worker-narration-only",
    agent_type: "fusion:claude-worker",
    stop_hook_active: false,
    last_assistant_message: "I still need to confirm the fix and will report the final result shortly."
  });

  const blockedOutput = JSON.parse(blocked.stdout);
  assert.strictEqual(blockedOutput.decision, "block");
  assert.strictEqual(blockedOutput.reason, tagMessage("worker-lifecycle.deliverable-retry-block", "The task is not deliverable yet. Complete the requested verification and return the actual result. End with `delivery: complete` plus `verification: passed`. This is the only retry."));
  const stopped = record(box);
  assert.strictEqual(stopped.retryCount, 1);
  assert.strictEqual(stopped.transportStatus, "running");
});

test("the SubagentStop matcher matches all seven peer and Claude worker agent names and rejects an unrelated agent", () => {
  const hooks = JSON.parse(fs.readFileSync(hooksConfigPath, "utf8")).hooks;
  const group = hooks.SubagentStop.find((candidate) => candidate.hooks.some((hook) => hook.command?.includes("worker-lifecycle.mjs")));
  assert.ok(group);
  const matcher = new RegExp(group.matcher);
  const agentNames = [
    "fusion:claude-worker",
    "fusion:trivial-worker",
    "fusion:deep-reasoner",
    "fusion:job-collector",
    "codex:codex-rescue",
    "grok:grok-rescue",
    "grok:grok-review-runner"
  ];
  for (const name of agentNames) {
    assert.match(name, matcher);
  }
  assert.doesNotMatch("general-purpose", matcher);
});
