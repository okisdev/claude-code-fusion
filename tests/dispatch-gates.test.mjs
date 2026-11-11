import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BREADTH_ENGINE_IDS, ENGINES, ENGINE_IDS } from "../plugins/fusion/scripts/lib/engines.mjs";
import { latestUserRequestedBackground, latestUserText } from "../plugins/fusion/scripts/lib/lifecycle/dispatch.mjs";
import { tagMessage } from "../plugins/fusion/scripts/lib/user-messages.mjs";
import { createWorkerRecord, readPeerCapacityReservations, updateWorkerRecord } from "../plugins/fusion/scripts/lib/worker-state.mjs";
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
      ...Object.fromEntries(ENGINE_IDS.map((engine) => [ENGINES[engine].companionEnv, path.resolve(import.meta.dirname, `../plugins/${engine}/scripts/${ENGINES[engine].companionFile}`)]))
    }
  };
}

function launch(box, toolInput = {}, overrides = {}) {
  const result = handleLifecycleHook({
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    tool_use_id: "tool-1",
    transcript_path: box.transcript,
    cwd: box.root,
    tool_name: "Agent",
    tool_input: { subagent_type: ENGINES.codex.rescueAgent, prompt: "bounded package", ...toolInput },
    ...overrides
  }, box.env);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null;
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

const flagshipMessage = "gpt-6-astra write briefs of 3000 bytes or more time out on most flights. Split the package, or drop --model to use the codex flagship lane default.";

function infraMessage(engine, kind, elapsed = 5, remaining = 25) {
  return `${ENGINES[engine].displayName} failed with failure: ${kind} ${elapsed} minutes ago in this session. Route this package to another eligible lane. It reopens after ${remaining} minutes or after you name the engine in a message.`;
}

test("Explore defaults to sonnet and preserves every other input field", (t) => {
  const box = sandbox(t);
  const input = { subagent_type: "Explore", prompt: "find the entry point", description: "trace entry", run_in_background: true };
  assert.deepEqual(launch(box, input), {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: { ...input, model: "sonnet" }
  });
  assert.deepEqual(readPeerCapacityReservations(box.env), []);
});

test("Explore preserves explicit models and other agent types receive no model default", (t) => {
  const box = sandbox(t);
  for (const model of ["haiku", "opus", "sonnet", "", null]) {
    assert.equal(launch(box, { subagent_type: "Explore", model }), null);
  }
  for (const subagent_type of ["Plan", "general-purpose", "explore"]) {
    assert.equal(launch(box, { subagent_type }), null);
  }
});

test("Task launches share the Explore model default", (t) => {
  const box = sandbox(t);
  assert.equal(launch(box, { subagent_type: "Explore" }, { tool_name: "Task" }).updatedInput.model, "sonnet");
});

for (const [bytes, brief] of [[2999, "a".repeat(2999)], [3000, "a".repeat(3000)], [2999, `${"界".repeat(999)}ab`], [3000, "界".repeat(1000)]]) {
  test(`flagship writes with ${bytes} UTF-8 bytes and ${brief.length} characters enforce the boundary`, (t) => {
    const box = sandbox(t);
    assert.equal(Buffer.byteLength(brief, "utf8"), bytes);
    const output = launch(box, { prompt: `--write --model gpt-6-astra -- ${brief}` });
    if (bytes === 3000) {
      assertDenied(box, output, "worker-lifecycle.flagship-write-deny", flagshipMessage);
    } else {
      assertStaged(box, output, `--write --model gpt-6-astra -- ${brief}`);
      assert.equal(readPeerCapacityReservations(box.env).length, 1);
    }
  });
}

for (const options of ["--write --model=gpt-6-astra", '--model "gpt-6-astra" --write', "--cwd '/tmp/repo with spaces' --write --model 'gpt-6-astra'"]) {
  test(`flagship writes parse leading companion options: ${options}`, (t) => {
    const box = sandbox(t);
    assertDenied(box, launch(box, { prompt: `${options} -- ${"x".repeat(3000)}` }), "worker-lifecycle.flagship-write-deny", flagshipMessage);
  });
}

test("flagship gate only counts the separated brief and explicit write model options", (t) => {
  const box = sandbox(t);
  for (const [prompt, staged] of [
    [`--cwd /${"d".repeat(3000)} --write --model gpt-6-astra -- small brief`, true],
    [`--model gpt-6-astra -- ${"x".repeat(3000)}`, false],
    [`--write --model gpt-6.1-sol -- ${"x".repeat(3000)}`, true],
    [`--write -- ${"x".repeat(3000)}`, true],
    [`--write --model gpt-6-astra ${"x".repeat(3000)}`, true],
    [`review --write --model gpt-6-astra -- ${"x".repeat(3000)}`, false],
    [`--model gpt-6-astra -- ${"x".repeat(3000)} --write`, false],
    [`--write -- ${"x".repeat(3000)} --model gpt-6-astra`, true]
  ]) {
    const output = launch(box, { prompt });
    if (staged) {
      assertStaged(box, output, prompt);
    } else {
      assert.equal(output, null, prompt.slice(0, 80));
    }
  }
});

test("flagship writes accept the latest user's literal model request", (t) => {
  const box = sandbox(t);
  writeTranscript(box, [userMessage("use gpt-6-astra for this package")]);
  const prompt = `--write --model gpt-6-astra -- ${"x".repeat(3000)}`;
  assertStaged(box, launch(box, { prompt }), prompt);
  assert.equal(readPeerCapacityReservations(box.env).length, 1);
});

test("flagship exemptions do not come from older users, assistant text, or tool results", (t) => {
  const box = sandbox(t);
  writeTranscript(box, [
    userMessage("use gpt-6-astra"),
    userMessage("implement the package"),
    { type: "assistant", message: { content: "gpt-6-astra" } },
    { ...userMessage("gpt-6-astra"), toolUseResult: {} },
    { ...userMessage("gpt-6-astra"), sourceToolAssistantUUID: "assistant-1" },
    { type: "user", message: { content: [{ type: "tool_result", content: "gpt-6-astra" }] } }
  ]);
  assertDenied(box, launch(box, { prompt: `--write --model gpt-6-astra -- ${"x".repeat(3000)}` }), "worker-lifecycle.flagship-write-deny", flagshipMessage);
});

test("bare rescue names enforce the flagship gate and other engines remain eligible", (t) => {
  const box = sandbox(t);
  const prompt = `--write --model gpt-6-astra -- ${"x".repeat(3000)}`;
  assertDenied(box, launch(box, { subagent_type: "codex-rescue", prompt }), "worker-lifecycle.flagship-write-deny", flagshipMessage);
  for (const engine of ENGINE_IDS.filter((id) => id !== ENGINES.codex.id)) {
    assertStaged(box, launch(box, { subagent_type: ENGINES[engine].rescueAgent, prompt }), prompt, engine);
  }
});

for (const engine of ENGINE_IDS) {
  for (const kind of ["sandbox", "auth", "setup", "quota"]) {
    test(`${engine} admission after ${kind} respects the engine's infrastructure scope`, (t) => {
      const box = sandbox(t);
      workerRecord(box, { agentType: ENGINES[engine].rescueAgent, peerFailureKind: kind });
      const output = launch(box, { subagent_type: ENGINES[engine].rescueAgent });
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
  test(`engine infrastructure stop at ${elapsedMs} milliseconds`, (t) => {
    const box = sandbox(t);
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    workerRecord(box, { finishedAt: new Date(now - elapsedMs).toISOString() });
    const output = launch(box);
    if (elapsedMs < 30 * 60_000) {
      assertDenied(box, output, "worker-lifecycle.engine-infra-deny", infraMessage(ENGINES.codex.id, "sandbox", Math.floor(elapsedMs / 60_000), Math.ceil((30 * 60_000 - elapsedMs) / 60_000)));
    } else {
      assert.equal(output, null);
      assert.equal(readPeerCapacityReservations(box.env).length, 1);
    }
  });
}

for (const engine of ENGINE_IDS) {
  test(`${engine} reopens when the latest user names its id or display name`, (t) => {
    const box = sandbox(t);
    workerRecord(box, { agentType: ENGINES[engine].rescueAgent });
    for (const name of [engine, ENGINES[engine].displayName, engine.toUpperCase()]) {
      writeTranscript(box, [userMessage(`please use (${name}) for this package`)]);
      assert.equal(launch(box, { subagent_type: ENGINES[engine].rescueAgent }), null);
    }
  });
}

test("engine exemptions require a name in the latest external user message", (t) => {
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
    assertDenied(box, launch(box), "worker-lifecycle.engine-infra-deny", infraMessage(ENGINES.codex.id, "sandbox"));
  }
});

test("newest finished record wins even when older failures were updated later", (t) => {
  const box = sandbox(t);
  const now = Date.now();
  const failure = workerRecord(box, { finishedAt: new Date(now - 10 * 60_000).toISOString() });
  workerRecord(box, { transportStatus: "done", peerFailureKind: null, finishedAt: new Date(now - 60_000).toISOString() });
  updateWorkerRecord(failure.taskId, box.env, (current) => ({ ...current, description: "updated after success" }));
  assert.equal(launch(box), null);
});

test("a newer failure stops the engine after an older success", (t) => {
  const box = sandbox(t);
  workerRecord(box, { transportStatus: "done", peerFailureKind: null, finishedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
  workerRecord(box);
  assertDenied(box, launch(box), "worker-lifecycle.engine-infra-deny", infraMessage(ENGINES.codex.id, "sandbox"));
});

test("engine stops ignore other sessions, engines, nonterminal records, and other failures", (t) => {
  const box = sandbox(t);
  workerRecord(box, { sessionId: "other-session" });
  workerRecord(box, { agentType: ENGINES.grok.rescueAgent });
  workerRecord(box, { transportStatus: "running" });
  assert.equal(launch(box), null);
  for (const kind of [null, "timeout", "network", "intent_override"]) {
    workerRecord(box, { peerFailureKind: kind });
    assert.equal(launch(box), null);
  }
});

test("same-engine collector records participate in infrastructure stops", (t) => {
  const box = sandbox(t);
  workerRecord(box, { agentType: "fusion:job-collector", peerEngine: ENGINES.codex.id });
  assertDenied(box, launch(box, { subagent_type: "codex-rescue" }), "worker-lifecycle.engine-infra-deny", infraMessage(ENGINES.codex.id, "sandbox"));
});

test("infrastructure stops require a valid past finish time", (t) => {
  const box = sandbox(t);
  for (const finishedAt of [null, "invalid", new Date(Date.now() + 60_000).toISOString()]) {
    workerRecord(box, { finishedAt });
    assert.equal(launch(box), null);
  }
});

test("the transcript reader serves model, engine, and background authorization", (t) => {
  const box = sandbox(t);
  workerRecord(box);
  const content = [{ type: "text", text: "use Codex with gpt-6-astra" }, { type: "text", text: "--background" }];
  writeTranscript(box, [userMessage(content)]);
  fs.appendFileSync(box.transcript, "{invalid json}\n");
  assert.equal(latestUserText(box.transcript), "use Codex with gpt-6-astra\n--background");
  assert.equal(latestUserRequestedBackground(box.transcript), true);
  const prompt = `--write --model gpt-6-astra -- ${"x".repeat(3000)}`;
  assertStaged(box, launch(box, { prompt }), prompt);
  writeTranscript(box, [userMessage(content), userMessage("continue")]);
  assert.equal(latestUserText(box.transcript), "continue");
  assert.equal(latestUserRequestedBackground(box.transcript), false);
});

test("model and engine exemptions each apply only to their own gate", (t) => {
  const box = sandbox(t);
  workerRecord(box);
  const input = { prompt: `--write --model gpt-6-astra -- ${"x".repeat(3000)}` };
  writeTranscript(box, [userMessage("use Codex")]);
  assertDenied(box, launch(box, input), "worker-lifecycle.flagship-write-deny", flagshipMessage);
  writeTranscript(box, [userMessage("use gpt-6-astra")]);
  assertDenied(box, launch(box, input), "worker-lifecycle.engine-infra-deny", infraMessage(ENGINES.codex.id, "sandbox"));
});

test("missing transcripts grant no admission exemptions", (t) => {
  const box = sandbox(t);
  fs.unlinkSync(box.transcript);
  assert.equal(latestUserText(box.transcript), null);
  assert.equal(latestUserRequestedBackground(box.transcript), false);
  assertDenied(box, launch(box, { prompt: `--write --model gpt-6-astra -- ${"x".repeat(3000)}` }), "worker-lifecycle.flagship-write-deny", flagshipMessage);
  workerRecord(box);
  assertDenied(box, launch(box), "worker-lifecycle.engine-infra-deny", infraMessage(ENGINES.codex.id, "sandbox"));
});
