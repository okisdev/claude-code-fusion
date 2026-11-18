import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BREADTH_ENGINE_IDS, ENGINES, ENGINE_IDS } from "../plugins/fusion/scripts/lib/engines.mjs";
import { engineInfraDenial, latestUserRequestedBackground, latestUserText } from "../plugins/fusion/scripts/lib/lifecycle/dispatch.mjs";
import { renderHookResult } from "../plugins/fusion/scripts/lib/lifecycle/output.mjs";
import { tagMessage } from "../plugins/fusion/scripts/lib/user-messages.mjs";
import { createWorkerRecord, readPeerCapacityReservations, readWorkerRecords, updateWorkerRecord } from "../plugins/fusion/scripts/lib/worker-state.mjs";
import { handleLifecycleHook } from "../plugins/fusion/scripts/worker-lifecycle.mjs";

function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-dispatch-gates-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transcript = path.join(root, "parent.jsonl");
  fs.writeFileSync(transcript, "");
  return {
    root,
    transcript,
    sequence: 0,
    env: {
      ...process.env,
      FUSION_WORKER_STATE_DIR: path.join(root, "workers"),
      FUSION_DATA_DIR: path.join(root, "data"),
      FUSION_MODEL_ROUTING: path.join(root, "missing-routing.json"),
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      ...Object.fromEntries(ENGINE_IDS.map((engine) => [ENGINES[engine].companionEnv, path.resolve(import.meta.dirname, engine === "grok" ? "fixtures/healthy-grok-companion.mjs" : `../plugins/${engine}/scripts/${ENGINES[engine].companionFile}`)]))
    }
  };
}

async function launch(box, toolInput = {}, overrides = {}) {
  const result = await handleLifecycleHook({
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    tool_use_id: "tool-1",
    transcript_path: box.transcript,
    cwd: box.root,
    tool_name: "Agent",
    tool_input: { subagent_type: ENGINES.codex.rescueAgent, prompt: "bounded package", ...toolInput },
    ...overrides
  }, box.env);
  const stdout = renderHookResult(result, "PreToolUse");
  return stdout ? JSON.parse(stdout).hookSpecificOutput : null;
}

function writeTranscript(box, entries) {
  fs.writeFileSync(box.transcript, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function userMessage(text) {
  return { type: "user", message: { content: text } };
}

function workerRecord(box, overrides = {}) {
  const { agentType = ENGINES.codex.rescueAgent, sessionId = "session-1", ...fields } = overrides;
  const record = createWorkerRecord({
    taskId: `fusion-gate-${++box.sequence}`,
    sessionId,
    agentType,
    workspaceRoot: box.root
  }, box.env);
  return updateWorkerRecord(record.taskId, box.env, (current) => ({
    ...current,
    transportStatus: "failed",
    peerFailureKind: "sandbox",
    finishedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...fields
  }));
}

function assertDenied(box, output, slug, message) {
  assert.equal(output?.permissionDecision, "deny");
  assert.equal(output.permissionDecisionReason, tagMessage(slug, message));
  assert.deepEqual(readPeerCapacityReservations(box.env), []);
}

function assertStaged(box, output, prompt, engine = "codex") {
  assert.equal(output?.permissionDecision, "allow");
  const token = output.updatedInput?.prompt.match(/^fusion-staged-token: ([a-f0-9]{48})\nmode: write$/)?.[1];
  assert.ok(token);
  const file = path.join(box.root, `${engine}-companion-input-${token}`, "request");
  assert.equal(fs.readFileSync(file, "utf8"), prompt);
  const discarded = spawnSync(process.execPath, [box.env[ENGINES[engine].companionEnv], "transport-discard", "--raw-args-token", token], { env: { ...box.env, CLAUDE_CODE_SESSION_ID: "session-1" }, encoding: "utf8" });
  assert.equal(discarded.status, 0, discarded.stderr);
  assert.equal(fs.existsSync(file), false);
}

function infraMessage(engine, kind, elapsed = 5, remaining = 25) {
  return `${ENGINES[engine].displayName} failed with failure: ${kind} ${elapsed} minutes ago in this session. Route this package to another eligible lane. It reopens after ${remaining} minutes or after you name the engine in a message.`;
}

test("Explore defaults to sonnet and preserves every other input field", async (t) => {
  const box = sandbox(t);
  const input = { subagent_type: "Explore", prompt: "find the entry point", description: "trace entry", run_in_background: true };
  assert.deepEqual(await launch(box, input), {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: { ...input, model: "sonnet" }
  });
  assert.deepEqual(readPeerCapacityReservations(box.env), []);
});

test("Explore preserves explicit models and other agent types receive no model default", async (t) => {
  const box = sandbox(t);
  for (const model of ["haiku", "opus", "sonnet", "", null]) {
    assert.equal(await launch(box, { subagent_type: "Explore", model }), null);
  }
  for (const subagent_type of ["Plan", "general-purpose", "explore"]) {
    assert.equal(await launch(box, { subagent_type }), null);
  }
});

test("Task launches share the Explore model default", async (t) => {
  const box = sandbox(t);
  assert.equal((await launch(box, { subagent_type: "Explore" }, { tool_name: "Task" })).updatedInput.model, "sonnet");
});

test("large flagship write briefs stage without a model-specific gate", async (t) => {
  const box = sandbox(t);
  const prompt = `--write --model gpt-6-astra -- ${"x".repeat(3000)}`;
  assertStaged(box, await launch(box, { prompt }), prompt);
  assert.equal(readPeerCapacityReservations(box.env).length, 1);
});

test("bare rescue names and other engines can stage large write briefs", async (t) => {
  const box = sandbox(t);
  const prompt = `--write --model gpt-6-astra -- ${"x".repeat(3000)}`;
  assertStaged(box, await launch(box, { subagent_type: "codex-rescue", prompt }), prompt);
  for (const engine of ENGINE_IDS.filter((id) => id !== ENGINES.codex.id)) {
    assertStaged(box, await launch(box, { subagent_type: ENGINES[engine].rescueAgent, prompt }), prompt, engine);
  }
});

for (const engine of ENGINE_IDS) {
  for (const kind of ["sandbox", "auth", "setup", "quota"]) {
    test(`${engine} admission after ${kind} respects the engine's infrastructure scope`, async (t) => {
      const box = sandbox(t);
      workerRecord(box, { agentType: ENGINES[engine].rescueAgent, peerFailureKind: kind });
      const output = await launch(box, { subagent_type: ENGINES[engine].rescueAgent });
      if (kind === "quota" && BREADTH_ENGINE_IDS.includes(engine)) {
        assert.equal(output, null);
        assert.equal(readPeerCapacityReservations(box.env).length, 1);
      } else {
        assertDenied(box, output, "worker-lifecycle.engine-infra-deny", infraMessage(engine, kind));
      }
    });
  }
}

for (const elapsedMs of [0, 30 * 60_000 - 1, 30 * 60_000, 30 * 60_000 + 1]) {
  test(`engine infrastructure stop at ${elapsedMs} milliseconds`, async (t) => {
    const box = sandbox(t);
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    workerRecord(box, { finishedAt: new Date(now - elapsedMs).toISOString() });
    const output = await launch(box);
    if (elapsedMs < 30 * 60_000) {
      assertDenied(box, output, "worker-lifecycle.engine-infra-deny", infraMessage(ENGINES.codex.id, "sandbox", Math.floor(elapsedMs / 60_000), Math.ceil((30 * 60_000 - elapsedMs) / 60_000)));
    } else {
      assert.equal(output, null);
      assert.equal(readPeerCapacityReservations(box.env).length, 1);
    }
  });
}

for (const engine of ENGINE_IDS) {
  test(`${engine} reopens when the latest user names its id or display name`, async (t) => {
    const box = sandbox(t);
    workerRecord(box, { agentType: ENGINES[engine].rescueAgent });
    for (const name of [engine, ENGINES[engine].displayName, engine.toUpperCase()]) {
      writeTranscript(box, [userMessage(`please use (${name}) for this package`)]);
      assert.equal(await launch(box, { subagent_type: ENGINES[engine].rescueAgent }), null);
    }
  });
}

test("engine exemptions require a name in the latest external user message", async (t) => {
  const box = sandbox(t);
  workerRecord(box);
  for (const text of ["implement it", "use grok instead", "codexish is unrelated"]) {
    writeTranscript(box, [
      userMessage("use Codex"),
      userMessage(text),
      { type: "assistant", message: { content: "Codex" } },
      { ...userMessage("Codex"), toolUseResult: {} },
      { ...userMessage("Codex"), sourceToolAssistantUUID: "assistant-1" }
    ]);
    assertDenied(box, await launch(box), "worker-lifecycle.engine-infra-deny", infraMessage(ENGINES.codex.id, "sandbox"));
  }
});

test("newest finished record wins even when older failures were updated later", async (t) => {
  const box = sandbox(t);
  const now = Date.now();
  const failure = workerRecord(box, { finishedAt: new Date(now - 10 * 60_000).toISOString() });
  workerRecord(box, { transportStatus: "done", peerFailureKind: null, finishedAt: new Date(now - 60_000).toISOString() });
  updateWorkerRecord(failure.taskId, box.env, (current) => ({ ...current, description: "updated after success" }));
  assert.equal(await launch(box), null);
});

test("a newer failure stops the engine after an older success", async (t) => {
  const box = sandbox(t);
  workerRecord(box, { transportStatus: "done", peerFailureKind: null, finishedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
  workerRecord(box);
  assertDenied(box, await launch(box), "worker-lifecycle.engine-infra-deny", infraMessage(ENGINES.codex.id, "sandbox"));
});

test("engine stops ignore other sessions, engines, nonterminal records, and other failures", async (t) => {
  const box = sandbox(t);
  workerRecord(box, { sessionId: "other-session" });
  workerRecord(box, { agentType: ENGINES.grok.rescueAgent });
  workerRecord(box, { transportStatus: "running", companionCwd: path.join(box.root, "isolated") });
  assert.equal(await launch(box), null);
  for (const kind of [null, "timeout", "network", "intent_override"]) {
    workerRecord(box, { peerFailureKind: kind });
    assert.equal(await launch(box), null);
  }
});

test("same-engine collector records participate in infrastructure stops", async (t) => {
  const box = sandbox(t);
  workerRecord(box, { agentType: "fusion:job-collector", peerEngine: ENGINES.codex.id });
  assertDenied(box, await launch(box, { subagent_type: "codex-rescue" }), "worker-lifecycle.engine-infra-deny", infraMessage(ENGINES.codex.id, "sandbox"));
});

test("infrastructure stops require a valid past finish time", async (t) => {
  const box = sandbox(t);
  for (const finishedAt of [null, "invalid", new Date(Date.now() + 60_000).toISOString()]) {
    workerRecord(box, { finishedAt });
    assert.equal(await launch(box), null);
  }
});

test("the transcript reader serves model, engine, and background authorization", async (t) => {
  const box = sandbox(t);
  workerRecord(box);
  const content = [{ type: "text", text: "use Codex with gpt-6-astra" }, { type: "text", text: "--background" }];
  writeTranscript(box, [userMessage(content)]);
  fs.appendFileSync(box.transcript, "{invalid json}\n");
  assert.equal(latestUserText(box.transcript), "use Codex with gpt-6-astra\n--background");
  assert.equal(latestUserRequestedBackground(box.transcript), true);
  const prompt = `--write --model gpt-6-astra -- ${"x".repeat(3000)}`;
  assertStaged(box, await launch(box, { prompt }), prompt);
  writeTranscript(box, [userMessage(content), userMessage("continue")]);
  assert.equal(latestUserText(box.transcript), "continue");
  assert.equal(latestUserRequestedBackground(box.transcript), false);
});

test("engine exemption depends on the latest user message", async (t) => {
  const box = sandbox(t);
  workerRecord(box);
  const input = { prompt: `--write --model gpt-6-astra -- ${"x".repeat(3000)}` };
  writeTranscript(box, [userMessage("use Codex")]);
  assertStaged(box, await launch(box, input), input.prompt);
  writeTranscript(box, [userMessage("use gpt-6-astra")]);
  assert.equal((await launch(box, input))?.permissionDecisionReason, tagMessage("worker-lifecycle.engine-infra-deny", infraMessage(ENGINES.codex.id, "sandbox")));
});

test("missing transcripts grant no admission exemptions", async (t) => {
  const box = sandbox(t);
  fs.unlinkSync(box.transcript);
  assert.equal(latestUserText(box.transcript), null);
  assert.equal(latestUserRequestedBackground(box.transcript), false);
  assertStaged(box, await launch(box, { prompt: `--write --model gpt-6-astra -- ${"x".repeat(3000)}` }), `--write --model gpt-6-astra -- ${"x".repeat(3000)}`);
  workerRecord(box);
  assert.equal((await launch(box))?.permissionDecisionReason, tagMessage("worker-lifecycle.engine-infra-deny", infraMessage(ENGINES.codex.id, "sandbox")));
});

test("host blockers deny the first dispatch only for the leading brief mode", async (t) => {
  const box = sandbox(t);
  const companion = path.join(box.root, "grok-companion.mjs");
  fs.writeFileSync(companion, `if (process.argv[2] !== "host-check") process.exit(2); process.stdout.write(${JSON.stringify(JSON.stringify({ blockers: [{ kind: "sandbox", modes: ["write"], message: "Socket blocks writes." }] }))});`);
  box.env.FUSION_GROK_COMPANION = companion;
  const denied = await launch(box, { subagent_type: "grok-rescue", prompt: "--cwd '/tmp/My Project' --write -- bounded package" });
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /Grok write runs are blocked on this host: sandbox: Socket blocks writes/);
  assert.deepEqual(readPeerCapacityReservations(box.env), []);
  assert.equal(await launch(box, { subagent_type: "grok:grok-rescue", prompt: "-- consult mentioning --write in prose" }), null);
  writeTranscript(box, [userMessage("use Grok")]);
  assert.equal(await launch(box, { subagent_type: "grok:grok-rescue", prompt: "--write -- bounded package" }), null);
});

test("Codex workspace slots cover other sessions, every nonterminal status, and path aliases", async (t) => {
  const box = sandbox(t);
  const link = path.join(box.root, "repo-link");
  fs.symlinkSync(box.root, link, "dir");
  const worker = workerRecord(box, { sessionId: "other-session", transportStatus: "running", peerFailureKind: null });
  for (const transportStatus of ["dispatching", "running", "pending_async", "ready_uncollected", "ready_background", "cancel_requested"]) {
    updateWorkerRecord(worker.taskId, box.env, (record) => ({ ...record, transportStatus }));
    const denied = await launch(box, { subagent_type: "codex-rescue", prompt: `--cwd '${link}' -- bounded package` });
    assert.equal(denied.permissionDecision, "deny", transportStatus);
    assert.match(denied.permissionDecisionReason, /Use an isolated worktree with --cwd, or wait/);
  }
  assert.equal(await launch(box, { prompt: "--cwd 'isolated worktree' -- bounded package" }), null);
  assert.equal((await launch(box, {}, { tool_name: "Bash", tool_input: { command: "/codex --write" } })), null);
  updateWorkerRecord(worker.taskId, box.env, (record) => ({ ...record, transportStatus: "done" }));
  assert.equal(await launch(box, {}, { tool_use_id: "after-completion" }), null);
});

test("Codex reservations reject simultaneous launches before worker records exist", async (t) => {
  const box = sandbox(t);
  assert.equal(await launch(box), null);
  assert.deepEqual(readWorkerRecords(box.env), []);
  const denied = await launch(box, {}, { tool_use_id: "tool-2", session_id: "other-session" });
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /Codex already has a wrapper running/);
  assert.equal(readPeerCapacityReservations(box.env).length, 1);
  assert.equal(await launch(box, { prompt: "--cwd worktree -- bounded package" }, { tool_use_id: "tool-3" }), null);
});

test("Codex launches without tool ids still reserve their workspace slot", async (t) => {
  const box = sandbox(t);
  assert.equal(await launch(box, {}, { tool_use_id: undefined }), null);
  const denied = await launch(box, { prompt: "a second package" }, { tool_use_id: undefined });
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /workspace-slot-deny|isolated worktree/);
  assert.equal(readPeerCapacityReservations(box.env).length, 1);
});

test("Claude quota admission scopes the reset to the same agent type and session", (t) => {
  const box = sandbox(t);
  const now = Date.parse("2026-11-18T10:00:00.000Z");
  workerRecord(box, { agentType: "fusion:deep-reasoner", failureKind: "quota", infraFailure: true, finishedAt: "2026-11-18T09:00:00.000Z", quotaResetAt: "2026-11-21T00:00:00.000Z", quotaResetText: "Nov 21" });
  const denial = engineInfraDenial("session-1", "deep-reasoner", "continue", box.env, now);
  assert.match(denial, /quota resets Nov 21 \(2026-11-21T00:00:00.000Z\)/);
  for (const text of ["use fusion:deep-reasoner", "use deep-reasoner"]) assert.equal(engineInfraDenial("session-1", "fusion:deep-reasoner", text, box.env, now), null);
  assert.equal(engineInfraDenial("other-session", "fusion:deep-reasoner", "continue", box.env, now), null);
  assert.equal(engineInfraDenial("session-1", "fusion:claude-worker", "continue", box.env, now), null);
  assert.equal(engineInfraDenial("session-1", "fusion:deep-reasoner", "continue", box.env, Date.parse("2026-11-21T00:00:00.000Z")), null);
});

test("Claude quota without a parsed reset reopens after one hour", (t) => {
  const box = sandbox(t);
  const finished = Date.parse("2026-11-18T09:00:00.000Z");
  workerRecord(box, { agentType: "fusion:claude-worker", failureKind: "quota", infraFailure: true, finishedAt: new Date(finished).toISOString() });
  assert.match(engineInfraDenial("session-1", "claude-worker", "continue", box.env, finished + 3_599_999), /2026-11-18T10:00:00.000Z \(1 hour fallback\)/);
  assert.equal(engineInfraDenial("session-1", "claude-worker", "continue", box.env, finished + 3_600_000), null);
});
