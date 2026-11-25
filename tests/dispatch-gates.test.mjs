import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ENGINES, ENGINE_IDS, engineStateRoots } from "../plugins/fusion/scripts/lib/engines.mjs";
import { engineHealth } from "../plugins/fusion/scripts/lib/engine-health.mjs";
import { codexPacingAdvisory, createDispatch, engineInfraDenial, injectedPeerDefaults, latestUserRequestedBackground, latestUserText, validateWorkerBrief } from "../plugins/fusion/scripts/lib/lifecycle/dispatch.mjs";
import { renderHookResult } from "../plugins/fusion/scripts/lib/lifecycle/output.mjs";
import { tagMessage } from "../plugins/fusion/scripts/lib/user-messages.mjs";
import { createWorkerRecord, readPeerCapacityReservations, readWorkerRecords, updateWorkerRecord } from "../plugins/fusion/scripts/lib/worker-state.mjs";
import { handleLifecycleHook } from "../plugins/fusion/scripts/worker-lifecycle.mjs";

function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-dispatch-gates-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transcript = path.join(root, "parent.jsonl");
  fs.writeFileSync(transcript, "");
  const binaries = Object.fromEntries(ENGINE_IDS.map((engine) => {
    const key = ENGINES[engine].binEnv;
    const file = path.join(root, `${engine}-cli`);
    fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    return [key, file];
  }));
  return {
    root,
    transcript,
    sequence: 0,
    env: {
      ...process.env,
      HOME: root,
      FUSION_WORKER_STATE_DIR: path.join(root, "workers"),
      FUSION_DATA_DIR: path.join(root, "data"),
      FUSION_MODEL_ROUTING: path.join(root, "missing-routing.json"),
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      ...binaries,
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

function fallbackBrief(reason = null) {
  return `fusion-brief: v1\ncontext-mode: isolated\ngoal: implement a bounded fix\nscope: src/a.mjs\nverification: node --test\n${reason === null ? "" : `claude-fallback: ${reason}\n`}`;
}

function healthJob(box, engine, id, fields = {}) {
  const jobs = path.join(engineStateRoots(engine, box.env)[0], "workspace", "jobs");
  fs.mkdirSync(jobs, { recursive: true });
  fs.writeFileSync(path.join(jobs, `${id}.json`), JSON.stringify({
    id, status: "error", mode: "write", claudeSessionId: "session-1",
    finishedAt: new Date(Date.now() - 60_000).toISOString(), ...fields
  }));
}

test("dispatch resolves implicit and explicit model pools from routing before history", (t) => {
  const box = sandbox(t);
  healthJob(box, "codex", "quota", { failureKind: "quota", billingPool: "codex", requestedModel: "different-model" });
  for (const model of ["gpt-6.2-astra", "gpt-6.2-sol"]) {
    healthJob(box, "codex", model, { status: "done", requestedModel: model, billingPool: "obsolete-pool" });
  }
  for (const prompt of ["lane: codex flagship", "lane: codex quick", "--model gpt-6.2-sol -- lane: codex flagship", "--model=gpt-6.2-astra --write -- bounded"]) {
    assert.match(engineInfraDenial("session-1", "codex:codex-rescue", "continue", box.env, Date.now(), prompt), /failure: quota/, prompt);
  }
  healthJob(box, "codex", "custom", { status: "done", requestedModel: "custom-model", billingPool: "custom-pool" });
  assert.equal(engineInfraDenial("session-1", "codex:codex-rescue", "continue", box.env, Date.now(), "--model custom-model --write -- bounded"), null);
  fs.writeFileSync(box.env.FUSION_MODEL_ROUTING, JSON.stringify({ schemaVersion: 2, updatedAt: new Date().toISOString(), costProfile: "", models: [{ id: "custom-model", lane: "codex", intelligence: 5, taste: 4, cost: 3 }] }));
  assert.match(engineInfraDenial("session-1", "codex:codex-rescue", "continue", box.env, Date.now(), "--model custom-model --write -- bounded"), /failure: quota/);
  assert.match(engineInfraDenial("session-1", "codex:codex-rescue", "continue", box.env, Date.now(), "--model unknown-model --write -- bounded"), /failure: quota/);
});

test("a table row with an unknown pool remains conservative instead of trusting stale history", (t) => {
  const box = sandbox(t);
  healthJob(box, "devin", "quota", { failureKind: "quota", billingPool: "free", requestedModel: "another-model" });
  healthJob(box, "devin", "stale", { status: "done", requestedModel: "swe-2.1", billingPool: "credits" });
  assert.match(engineInfraDenial("session-1", "devin:devin-rescue", "continue", box.env, Date.now(), "lane: devin burst"), /failure: quota/);
});

test("peer dispatch records preserve the original mode, model, and pool", (t) => {
  const box = sandbox(t);
  const record = createDispatch({ session_id: "session-1", tool_use_id: "record-choice", cwd: box.root, tool_input: { prompt: "--write --model gpt-6.1-sol -- lane: codex flagship" } }, "codex:codex-rescue", false, box.env);
  assert.equal(record.mode, "write");
  assert.equal(record.requestedModel, "gpt-6.1-sol");
  assert.equal(record.billingPool, "codex");
  for (const [agentType, pool] of [["codex:codex-rescue", "codex"], ["grok:grok-rescue", "grok"], ["agy:agy-rescue", "agy"]]) {
    const bare = createDispatch({ session_id: "session-1", tool_use_id: `bare-${pool}`, cwd: box.root, tool_input: { prompt: "--write -- port the routes" } }, agentType, false, box.env);
    assert.equal(bare.requestedModel, null);
    assert.equal(bare.billingPool, pool);
  }
});

for (const mode of ["write", "consult"]) {
  test(`SendMessage uses the original ${mode} mode and pool despite message contents`, async (t) => {
    const box = sandbox(t);
    const recipient = workerRecord(box, { agentType: "devin:devin-rescue", agentId: "original-worker", transportStatus: "done", peerFailureKind: null, mode, packageType: mode === "write" ? "implementation" : "consult", requestedModel: "swe-2.1", billingPool: "free", finishedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    for (const index of [1, 2]) healthJob(box, "devin", `timeout-${index}`, { failureKind: "timeout", billingPool: "free" });
    const output = await launch(box, {}, { tool_name: "SendMessage", tool_input: { to: recipient.agentId, message: mode === "write" ? "--model muse-wonder -- lane: devin diversity · consult" : "--model muse-wonder --write -- implement this" } });
    if (mode === "write") {
      assert.equal(output.permissionDecision, "deny");
      assert.match(output.permissionDecisionReason, /failure: timeout/);
    } else {
      assert.notEqual(output?.permissionDecision, "deny");
    }
  });
}

test("SendMessage uses the saved billing pool after routing defaults change", async (t) => {
  const box = sandbox(t);
  const recipient = workerRecord(box, { agentType: "devin:devin-rescue", agentId: "original-worker", mode: "write", requestedModel: "swe-2.1", peerBillingPool: "credits", billingPool: "free", finishedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
  healthJob(box, "devin", "quota", { failureKind: "quota", billingPool: "credits" });
  const output = await launch(box, {}, { tool_name: "SendMessage", tool_input: { to: recipient.agentId, message: "--model swe-2.1 -- lane: devin burst" } });
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /failure: quota/);
});

test("SendMessage checks the recorded Claude model instead of a model named in the message", async (t) => {
  const box = sandbox(t);
  workerRecord(box, { agentType: "fusion:claude-worker", failureKind: "quota", infraFailure: true, quotaModelFamily: "fable", quotaResetAt: new Date(Date.now() + 60_000).toISOString() });
  const opus = workerRecord(box, { agentType: "fusion:claude-worker", agentId: "opus-worker", requestedModel: "opus", resolvedModel: "claude-opus-5-5", transportStatus: "running", failureKind: null, peerFailureKind: null, finishedAt: null });
  const fable = workerRecord(box, { agentType: "fusion:claude-worker", agentId: "fable-worker", requestedModel: "fable", resolvedModel: "claude-fable-5-1", transportStatus: "running", failureKind: null, peerFailureKind: null, finishedAt: null });
  const allowed = await launch(box, {}, { tool_name: "SendMessage", tool_input: { to: opus.agentId, message: "model: fable\ncontinue" } });
  assert.notEqual(allowed?.permissionDecision, "deny");
  const denied = await launch(box, {}, { tool_name: "SendMessage", tool_input: { to: fable.agentId, message: "model: opus\ncontinue" } });
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /Fable usage limit/);
});

for (const engine of ENGINE_IDS.filter((id) => ENGINES[id].roles.some((role) => ["flagship", "quick", "burst"].includes(role)))) {
  test(`no-healthy-lane checks the routed ${engine} write pool instead of historical pools`, (t) => {
    const box = sandbox(t);
    pacingSetup(box, { breadth: engine === "devin" ? "devin" : "cursor" });
    for (const other of ["codex", "grok", engine === "devin" ? "devin" : "cursor", "agy"].filter((other) => other !== engine)) {
      workerRecord(box, { agentType: ENGINES[other].rescueAgent });
    }
    const pool = engine === "devin" ? "free" : engine === "cursor" ? "first-party" : engine;
    healthJob(box, engine, "quota", { failureKind: "quota", billingPool: pool });
    healthJob(box, engine, "other-pool", { status: "done", billingPool: "unrelated" });
    assert.equal(validateWorkerBrief(fallbackBrief("no-healthy-lane"), "fusion:claude-worker", box.env).ok, true);
    healthJob(box, engine, "quota", { failureKind: "quota", billingPool: "unrelated" });
    const healthy = validateWorkerBrief(fallbackBrief("no-healthy-lane"), "fusion:claude-worker", box.env);
    assert.equal(healthy.ok, false);
    assert.ok(healthy.reason.includes(`Healthy lanes: ${engine}.`));
  });
}

for (const packageType of ["consult", "review", "research", "design"]) {
  test(`no-healthy-lane uses ${packageType} package health`, (t) => {
    const box = sandbox(t);
    for (const engine of ["codex", "grok", "cursor", "agy"]) {
      for (const index of [1, 2]) healthJob(box, engine, `write-${index}`, { failureKind: "timeout" });
    }
    const prompt = `${fallbackBrief("no-healthy-lane")}package-type: ${packageType}\n`;
    const validation = validateWorkerBrief(prompt, "fusion:claude-worker", box.env);
    assert.equal(validation.ok, false);
    assert.match(validation.reason, /consult mode/);
    assert.match(validation.reason, /Healthy lanes: codex, grok, cursor, agy/);
  });
}

test("no-healthy-lane treats a missing or nonexecutable routed CLI as unhealthy", (t) => {
  const box = sandbox(t);
  for (const engine of ["grok", "cursor", "agy"]) workerRecord(box, { agentType: ENGINES[engine].rescueAgent });
  const prompt = fallbackBrief("no-healthy-lane");
  assert.equal(validateWorkerBrief(prompt, "fusion:claude-worker", box.env).ok, false);
  fs.chmodSync(box.env.CODEX_BIN, 0o600);
  assert.equal(validateWorkerBrief(prompt, "fusion:claude-worker", box.env).ok, true);
  fs.unlinkSync(box.env.CODEX_BIN);
  assert.equal(validateWorkerBrief(prompt, "fusion:claude-worker", box.env).ok, true);
});

test("envelope fields accept case, whitespace, colon spacing, and one trailing period", async (t) => {
  const box = sandbox(t);
  const prompt = "\n  FuSiOn-BrIeF : V1.  \n  CoNtExT-MoDe : IsOlAtEd. \n GoAl : inspect one file. \n ScOpE : src/a.mjs. \n AcCePtAnCe : bounded result. \n ClAuDe-FaLlBaCk : PrIvAcY. \n PaCkAgE-TyPe : ReViEw. \n SiZiNg : SmAlL. \n\nclaude-fallback: network\npackage-type: implementation\nsizing: invalid\n";
  const validation = validateWorkerBrief(prompt, "fusion:claude-worker", box.env);
  assert.equal(validation.ok, true);
  assert.equal(validation.fallbackReason, "privacy");
  assert.equal(validation.packageType, "review");
  assert.equal(validation.sizing, "small");
  const output = await launch(box, { subagent_type: "fusion:claude-worker", prompt });
  assert.equal(output.permissionDecision, "allow");
  assert.match(output.updatedInput.prompt, /FuSiOn-BrIeF : V1\.  \nfusion-task-id:/);
  assert.equal(readWorkerRecords(box.env)[0].fallbackReason, "privacy");
  assert.equal(validateWorkerBrief(fallbackBrief("privacy.."), "fusion:claude-worker", box.env).ok, false);
});

test("body fields cannot supply or duplicate fallback and required envelope fields", (t) => {
  const box = sandbox(t);
  const missingFallback = `${fallbackBrief()}\nclaude-fallback: privacy\n`;
  assert.equal(validateWorkerBrief(missingFallback, "fusion:claude-worker", box.env).ok, false);
  for (const field of ["context-mode: isolated", "goal: implement a bounded fix", "scope: src/a.mjs", "verification: node --test"]) {
    const prompt = `${fallbackBrief("privacy").replace(`${field}\n`, "")}\n${field}\n`;
    assert.equal(validateWorkerBrief(prompt, "fusion:claude-worker", box.env).ok, false, field);
  }
  const quoted = `${fallbackBrief("privacy")}\nclaude-fallback: no-healthy-lane\n`;
  assert.equal(validateWorkerBrief(quoted, "fusion:claude-worker", box.env).fallbackReason, "privacy");
});

test("dispatch admission and advisory share one health read per hook invocation", async (t) => {
  const box = sandbox(t);
  pacingSetup(box);
  const root = engineStateRoots("codex", box.env)[0];
  let reads = 0;
  const readdir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (directory, ...args) => {
    if (directory === root) reads += 1;
    return readdir(directory, ...args);
  });
  await launch(box, { prompt: "lane: codex quick" });
  assert.equal(reads, 1);
  await launch(box, { prompt: "--cwd another-worktree -- lane: codex quick" }, { tool_use_id: "another-hook" });
  assert.equal(reads, 2);
});

function pacingSetup(box, { breadth = "devin", tier = "free", pools = [{ pool: "codex", pacing: 2.7 }], available = true } = {}) {
  box.env.DEVIN_COMPANION_DATA = path.join(box.root, "devin-data");
  fs.mkdirSync(box.env.DEVIN_COMPANION_DATA, { recursive: true });
  fs.writeFileSync(path.join(box.env.DEVIN_COMPANION_DATA, "models-cache.json"), JSON.stringify({ fetchedAt: Date.now(), families: [{ slug: "swe-2.1", aliases: [], variants: [{ uid: "swe-2-1-high", cost_tier: tier }] }] }));
  fs.writeFileSync(box.env.FUSION_MODEL_ROUTING, JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), costProfile: "", breadth, models: [] }));
  const quota = { engine: "codex", available, observedAt: new Date().toISOString(), note: null, pools: pools.map((pool) => ({ costClass: "included", usedPercent: 79, windowMinutes: 10080, resetsAt: null, ...pool })) };
  const calls = path.join(box.root, "quota-calls");
  box.env.FUSION_CODEX_COMPANION = path.join(box.root, "quota-companion.mjs");
  fs.writeFileSync(box.env.FUSION_CODEX_COMPANION, `import fs from "node:fs"; if (process.argv.slice(2).join(" ") !== "quota --json") process.exit(2); fs.appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify("call\n")}); process.stdout.write(JSON.stringify(${JSON.stringify(quota)}));`);
  return calls;
}

test("Metered lane defaults warn only when the same engine offers an eligible prepaid row", (t) => {
  const box = sandbox(t);
  pacingSetup(box, { breadth: "cursor" });
  const prompt = "lane: cursor diversity";
  const sentence = "muse-spark-1.3 bills a metered pool; pass --model explicitly to keep using it, or pick a free or included model with /fusion:config.";
  assert.doesNotMatch(injectedPeerDefaults(prompt, "cursor:cursor-rescue", box.env).context, /bills a metered pool/);
  fs.writeFileSync(box.env.FUSION_MODEL_ROUTING, JSON.stringify({ schemaVersion: 2, updatedAt: new Date().toISOString(), costProfile: "", breadth: "cursor", models: [
    { id: "composer-2.5", lane: "cursor", family: "cognition", intelligence: 3, taste: 3, cost: 3 }
  ] }));
  const implicit = injectedPeerDefaults(prompt, "cursor:cursor-rescue", box.env);
  assert.match(implicit.prompt, /^--model muse-spark-1\.3 --effort /);
  assert.ok(implicit.context.includes(sentence));
  assert.ok(injectedPeerDefaults(`--effort high -- ${prompt}`, "cursor:cursor-rescue", box.env).context.includes(sentence));
  assert.doesNotMatch(injectedPeerDefaults(`--model muse-spark-1.3 -- ${prompt}`, "cursor:cursor-rescue", box.env).context, /bills a metered pool/);
  assert.equal(injectedPeerDefaults(`--model muse-spark-1.3 --effort high -- ${prompt}`, "cursor:cursor-rescue", box.env), null);
  pacingSetup(box, { tier: "premium" });
  assert.doesNotMatch(injectedPeerDefaults("lane: devin burst", "devin:devin-rescue", box.env).context, /bills a metered pool/);
  pacingSetup(box);
  assert.doesNotMatch(injectedPeerDefaults("lane: devin burst", "devin:devin-rescue", box.env).context, /bills a metered pool/);
  pacingSetup(box, { breadth: "cursor" });
  const cursorBurst = injectedPeerDefaults("lane: cursor burst", "cursor:cursor-rescue", box.env);
  assert.match(cursorBurst.prompt, /^--model composer-2\.5 /);
  assert.doesNotMatch(cursorBurst.context, /bills a metered pool/);
  assert.doesNotMatch(injectedPeerDefaults("lane: codex quick", "codex:codex-rescue", box.env).context, /bills a metered pool/);
  pacingSetup(box);
  fs.rmSync(path.join(box.env.DEVIN_COMPANION_DATA, "models-cache.json"));
  assert.doesNotMatch(injectedPeerDefaults("lane: devin burst", "devin:devin-rescue", box.env).context, /bills a metered pool/);
});

test("Metered diversity notice ignores prepaid rows from another engine or an ineligible family", (t) => {
  const box = sandbox(t);
  pacingSetup(box, { breadth: "cursor" });
  const rows = [
    { id: "composer-2.5", lane: "cursor", family: "anthropic", intelligence: 3, taste: 3, cost: 3 },
    { id: "swe-2.1", lane: "devin", family: "cognition", intelligence: 3, taste: 3, cost: 3 }
  ];
  fs.writeFileSync(box.env.FUSION_MODEL_ROUTING, JSON.stringify({ schemaVersion: 2, updatedAt: new Date().toISOString(), costProfile: "", breadth: "cursor", models: rows }));
  const injected = injectedPeerDefaults("lane: cursor diversity", "cursor:cursor-rescue", box.env);
  assert.doesNotMatch(injected.context, /bills a metered pool/);
});

test("Codex quick and volume dispatches receive the routed prepaid burst advisory", async (t) => {
  const box = sandbox(t);
  const calls = pacingSetup(box);
  for (const [sizing, prompt] of [["quick", "lane: codex quick"], ["volume", "--model gpt-6.2-sol --effort medium -- codex-role: volume | bounded package"]]) {
    const output = await launch(box, { prompt });
    assert.equal(output.permissionDecision, "allow");
    assert.ok(output.additionalContext.includes(`Codex is over pace (pacing 2.7); this ${sizing} package fits the devin burst lane on its prepaid pool. Prefer devin-role: burst unless the package needs Codex.`));
    assert.equal(output.updatedInput.prompt.includes(prompt), true);
  }
  assert.equal(fs.readFileSync(calls, "utf8"), "call\n");
});

test("Dispatch pacing cache survives another process and refreshes expired or changed probes", (t) => {
  const box = sandbox(t);
  const calls = pacingSetup(box);
  const expected = codexPacingAdvisory("lane: codex quick", "codex:codex-rescue", box.env);
  assert.match(expected, /Codex is over pace/);
  const script = `import { codexPacingAdvisory } from ${JSON.stringify(new URL("../plugins/fusion/scripts/lib/lifecycle/dispatch.mjs", import.meta.url).href)}; process.stdout.write(JSON.stringify(codexPacingAdvisory("lane: codex quick", "codex:codex-rescue", process.env)));`;
  const cached = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: box.env, encoding: "utf8" });
  assert.equal(cached.status, 0, cached.stderr);
  assert.equal(JSON.parse(cached.stdout), expected);
  assert.equal(fs.readFileSync(calls, "utf8"), "call\n");
  const file = path.join(box.env.FUSION_DATA_DIR, "quota-codex.json");
  const cache = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...cache, fetchedAt: Date.now() - 60_001 }));
  assert.equal(codexPacingAdvisory("lane: codex quick", "codex:codex-rescue", box.env), expected);
  assert.equal(fs.readFileSync(calls, "utf8"), "call\ncall\n");
  pacingSetup(box, { pools: [{ pool: "codex", pacing: 1 }] });
  assert.equal(codexPacingAdvisory("lane: codex quick", "codex:codex-rescue", box.env), null);
  fs.writeFileSync(file, "{invalid");
  assert.equal(codexPacingAdvisory("lane: codex quick", "codex:codex-rescue", box.env), null);
  assert.equal(fs.readFileSync(calls, "utf8"), "call\ncall\ncall\ncall\n");
});

test("Dispatch bounds a hung quota read and caches its failure", (t) => {
  const box = sandbox(t);
  const calls = pacingSetup(box);
  fs.writeFileSync(box.env.FUSION_CODEX_COMPANION, `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify("call\n")}); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`);
  const started = Date.now();
  assert.equal(codexPacingAdvisory("lane: codex quick", "codex:codex-rescue", box.env), null);
  assert.ok(Date.now() - started < 1500);
  assert.equal(codexPacingAdvisory("lane: codex quick", "codex:codex-rescue", box.env), null);
  assert.equal(fs.readFileSync(calls, "utf8"), "call\n");
});

test("Pacing advisory requires Codex, a quick or volume shape, and a confirmed prepaid burst pool", (t) => {
  const box = sandbox(t);
  const calls = pacingSetup(box);
  for (const [prompt, agent] of [["lane: grok burst", "grok:grok-rescue"], ["lane: codex quick", "fusion:claude-worker"]]) {
    assert.equal(codexPacingAdvisory(prompt, agent, box.env), null);
  }
  assert.equal(fs.existsSync(calls), false);
  for (const prompt of ["lane: codex flagship", "bounded package"]) assert.equal(codexPacingAdvisory(prompt, "codex:codex-rescue", box.env), null);
  pacingSetup(box, { breadth: "cursor" });
  fs.writeFileSync(box.env.FUSION_MODEL_ROUTING, JSON.stringify({ schemaVersion: 2, updatedAt: new Date().toISOString(), costProfile: "", breadth: "cursor", models: [
    { id: "muse-spark-1.3", lane: "cursor", family: "meta", intelligence: 3, taste: 3, cost: 3 }
  ], defaults: { cursor: { burst: { model: "muse-spark-1.3", effort: "xhigh" } } } }));
  assert.equal(codexPacingAdvisory("lane: codex quick", "codex:codex-rescue", box.env), null);
  const cacheless = sandbox(t);
  const cachelessCalls = pacingSetup(cacheless);
  fs.rmSync(path.join(cacheless.env.DEVIN_COMPANION_DATA, "models-cache.json"));
  assert.equal(codexPacingAdvisory("lane: codex quick", "codex:codex-rescue", cacheless.env), null);
  assert.equal(fs.existsSync(cachelessCalls), false);
  pacingSetup(box, { tier: "premium" });
  assert.equal(codexPacingAdvisory("lane: codex quick", "codex:codex-rescue", box.env), null);
  pacingSetup(box, { tier: "free" });
  assert.match(codexPacingAdvisory("lane: codex quick", "codex:codex-rescue", box.env), /devin burst lane on its prepaid pool/);
});

test("Near exhaustion advisory covers every Codex package shape while pacing stays quick and volume only", (t) => {
  for (const [usedPercent, prompt, expected] of [
    [90, "lane: codex flagship", /near exhaustion \(90% used until \d{4}-\d{2}-\d{2}\); unless this package needs Codex, split it into briefs under 3 KB for devin-role: burst/],
    [95, "bounded package", /near exhaustion \(95% used/],
    [98, "lane: codex quick", /near exhaustion \(98% used.*agy-role: burst/],
    [89, "lane: codex flagship", null],
    [89, "lane: codex quick", /over pace \(pacing 2\.7\)/]
  ]) {
    const box = sandbox(t);
    pacingSetup(box, { pools: [{ pool: "codex", pacing: 2.7, usedPercent, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }] });
    const advisory = codexPacingAdvisory(prompt, "codex:codex-rescue", box.env);
    if (expected) assert.match(advisory, expected, `${usedPercent} ${prompt}`);
    else assert.equal(advisory, null, `${usedPercent} ${prompt}`);
  }
  const expired = sandbox(t);
  pacingSetup(expired, { pools: [{ pool: "codex", pacing: 2.7, usedPercent: 99, resetsAt: new Date(Date.now() - 60_000).toISOString() }] });
  assert.equal(codexPacingAdvisory("lane: codex flagship", "codex:codex-rescue", expired.env), null);
});

test("Pacing advisory accepts Cursor's included burst and probes Codex alone", (t) => {
  const box = sandbox(t);
  const calls = pacingSetup(box, { breadth: "cursor" });
  const otherCalls = path.join(box.root, "other-quota-calls");
  box.env.FUSION_GROK_COMPANION = path.join(box.root, "grok-quota.mjs");
  fs.writeFileSync(box.env.FUSION_GROK_COMPANION, `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(otherCalls)}, "call\\n");`);
  const advisory = codexPacingAdvisory("lane: codex quick", "codex:codex-rescue", box.env);
  assert.match(advisory, /cursor burst lane on its prepaid pool/);
  assert.equal(fs.readFileSync(calls, "utf8"), "call\n");
  assert.equal(fs.existsSync(otherCalls), false);
});

test("Pacing advisory ignores at-threshold, unknown, unrelated, and unavailable quota", (t) => {
  for (const options of [
    { pools: [{ pool: "codex", pacing: 1.15 }] },
    { pools: [{ pool: "codex", pacing: null }] },
    { pools: [{ pool: "other", pacing: 2.7 }] },
    { pools: [] },
    { available: false }
  ]) {
    const box = sandbox(t);
    pacingSetup(box, options);
    assert.equal(codexPacingAdvisory("lane: codex quick", "codex:codex-rescue", box.env), null);
  }
  const box = sandbox(t);
  pacingSetup(box, { pools: [{ pool: "codex", pacing: 1.150001 }] });
  assert.match(codexPacingAdvisory("lane: codex volume", "codex-rescue", box.env), /this volume package fits the devin burst lane/);
});

test("Pacing advisory respects breadth write health and the burst billing pool", (t) => {
  for (const [failureKind, pool, packageType, expected] of [["auth", null, "consult", false], ["quota", "free", "implementation", false], ["quota", "credits", "implementation", true], ["timeout", null, "consult", true], ["timeout", null, "implementation", false]]) {
    const box = sandbox(t);
    const calls = pacingSetup(box);
    const failure = { agentType: "devin:devin-rescue", peerFailureKind: failureKind, peerBillingPool: pool, packageType };
    workerRecord(box, failure);
    if (failureKind === "timeout") workerRecord(box, failure);
    const result = codexPacingAdvisory("lane: codex quick", "codex:codex-rescue", box.env);
    assert.equal(typeof result === "string", expected, `${failureKind} ${pool} ${packageType}`);
    assert.equal(fs.existsSync(calls), expected);
  }
  const box = sandbox(t);
  const calls = pacingSetup(box);
  workerRecord(box, { agentType: "devin:devin-rescue", sessionId: "other-session", peerFailureKind: "auth" });
  assert.equal(codexPacingAdvisory("lane: codex quick", "codex:codex-rescue", box.env), null);
  assert.equal(fs.existsSync(calls), false);
});

for (const agent of ["fusion:claude-worker", "fusion:trivial-worker", "claude-worker", "trivial-worker"]) {
  test(`${agent} denies missing, unknown, and duplicate fallback reasons`, async (t) => {
    const box = sandbox(t);
    for (const reason of [null, "generic", "privacy\nclaude-fallback: network", "privacy extra"]) {
      const output = await launch(box, { subagent_type: agent, prompt: fallbackBrief(reason) });
      assert.equal(output.permissionDecision, "deny");
      assert.match(output.permissionDecisionReason, /network, toolchain, long-build, claude-surface, privacy, no-healthy-lane/);
      assert.match(output.permissionDecisionReason, /\nclaude-fallback: claude-surface/);
      assert.deepEqual(readWorkerRecords(box.env), []);
    }
  });

  test(`${agent} accepts and persists each fallback reason`, async (t) => {
    const box = sandbox(t);
    for (const engine of ["codex", "grok", "cursor", "agy"]) workerRecord(box, { agentType: ENGINES[engine].rescueAgent });
    for (const reason of ["network", "toolchain", "long-build", "claude-surface", "privacy", "no-healthy-lane"]) {
      const output = await launch(box, { subagent_type: agent, prompt: fallbackBrief(reason) }, { tool_use_id: reason });
      assert.equal(output.permissionDecision, "allow");
      const record = readWorkerRecords(box.env).find((record) => record.dispatchToolUseId === reason);
      assert.equal(record.fallbackReason, reason);
    }
  });
}

test("deep-reasoner advice requires no Claude fallback reason", async (t) => {
  const box = sandbox(t);
  const output = await launch(box, { subagent_type: "fusion:deep-reasoner", prompt: fallbackBrief() });
  assert.equal(output.permissionDecision, "allow");
  assert.equal(readWorkerRecords(box.env)[0].fallbackReason, null);
});

test("no-healthy-lane names healthy write lanes and accepts only after every lane fails", async (t) => {
  const box = sandbox(t);
  for (const engine of ["grok", "cursor", "agy"]) workerRecord(box, { agentType: ENGINES[engine].rescueAgent });
  const input = { subagent_type: "fusion:claude-worker", prompt: fallbackBrief("no-healthy-lane") };
  const denied = await launch(box, input);
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /Healthy lanes: codex\./);
  workerRecord(box);
  assert.equal((await launch(box, input)).permissionDecision, "allow");
});

test("no-healthy-lane follows the selected breadth engine", async (t) => {
  const box = sandbox(t);
  fs.writeFileSync(box.env.FUSION_MODEL_ROUTING, JSON.stringify({
    schemaVersion: 1, updatedAt: new Date().toISOString(), costProfile: "test", models: [], breadth: "devin"
  }));
  for (const engine of ["codex", "grok", "agy"]) workerRecord(box, { agentType: ENGINES[engine].rescueAgent });
  const input = { subagent_type: "fusion:trivial-worker", prompt: fallbackBrief("no-healthy-lane") };
  const denied = await launch(box, input);
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /Healthy lanes: devin\./);
  workerRecord(box, { agentType: ENGINES.devin.rescueAgent });
  assert.equal((await launch(box, input)).permissionDecision, "allow");
});

test("dispatch scopes a recorded model's quota pool without denying another model's pool", (t) => {
  const box = sandbox(t);
  pacingSetup(box);
  fs.writeFileSync(path.join(box.env.DEVIN_COMPANION_DATA, "models-cache.json"), JSON.stringify({ fetchedAt: Date.now(), families: [
    { slug: "swe-2.1", aliases: [], variants: [{ uid: "swe-2-1-high", cost_tier: "free" }] },
    { slug: "muse-wonder", aliases: [], variants: [{ uid: "muse-wonder-high", cost_tier: "premium" }] }
  ] }));
  const now = Date.now();
  const jobs = path.join(engineStateRoots("devin", box.env)[0], "workspace", "jobs");
  fs.mkdirSync(jobs, { recursive: true });
  for (const [id, fields] of [
    ["first-party-quota", { status: "error", failureKind: "quota", billingPool: "first-party", requestedModel: "swe-2.1" }],
    ["api-success", { status: "done", billingPool: "api", requestedModel: "muse-wonder" }]
  ]) {
    fs.writeFileSync(path.join(jobs, `${id}.json`), JSON.stringify({ id, mode: "write", claudeSessionId: "session-1", finishedAt: new Date(now - 60_000).toISOString(), ...fields }));
  }
  assert.match(engineInfraDenial("session-1", "devin:devin-rescue", "continue", box.env, now, "lane: devin burst"), /failure: quota/);
  assert.equal(engineInfraDenial("session-1", "devin:devin-rescue", "continue", box.env, now, "--model muse-wonder --write -- bounded"), null);
});

test("dispatch reuses write detection for mode headers, transport defaults, and burst roles", (t) => {
  const box = sandbox(t);
  const now = Date.now();
  for (const minutes of [4, 2]) workerRecord(box, {
    agentType: ENGINES.devin.rescueAgent,
    packageType: "implementation",
    peerFailureKind: "timeout",
    finishedAt: new Date(now - minutes * 60_000).toISOString()
  });
  for (const prompt of ["--write -- bounded", "--transport-default-write -- bounded", "mode: write\nbounded", "lane: devin burst", "devin-role: burst"]) {
    assert.match(engineInfraDenial("session-1", "devin:devin-rescue", "continue", box.env, now, prompt), /failure: timeout/);
  }
  for (const prompt of ["lane: devin diversity", "-- consult mentioning --write in prose", "mode: review\nbounded", "lane: devin burst · read-only"]) {
    assert.equal(engineInfraDenial("session-1", "devin:devin-rescue", "continue", box.env, now, prompt), null);
  }
  assert.equal(engineHealth("devin", "review", null, { env: box.env, now }).healthy, true);
});

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

test("Antigravity dispatch fills every protected role and preserves explicit options", (t) => {
  const box = sandbox(t);
  for (const [role, effort] of [["independence", "high"], ["large-context", "high"], ["burst", "medium"]]) {
    const prompt = `--cwd "${box.root}" -- agy-role: ${role} | acceptance: bounded result`;
    for (const agent of [ENGINES.agy.rescueAgent, "agy-rescue"]) {
      const injected = injectedPeerDefaults(prompt, agent, box.env);
      assert.equal(injected.prompt, `--model gemini-4-neon --effort ${effort} ${prompt}`);
      assert.match(injected.context, new RegExp(`agy ${role} lane default`));
    }
    assert.equal(injectedPeerDefaults(`--model gemini-4-argon --effort xhigh ${prompt}`, ENGINES.agy.rescueAgent, box.env), null);
  }
  for (const header of ["agy-role: diversity", "lane: agy", "goal: user selected task"]) {
    assert.equal(injectedPeerDefaults(header, ENGINES.agy.rescueAgent, box.env), null);
  }
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
      assertDenied(box, output, "worker-lifecycle.engine-infra-deny", infraMessage(engine, kind));
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
    assert.match(denied.permissionDecisionReason, /burst on its prepaid pool before a second Codex worktree\. Otherwise use an isolated worktree with --cwd, or wait/);
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
  workerRecord(box, { agentType: "fusion:deep-reasoner", failureKind: "quota", infraFailure: true, quotaModelFamily: "fable", finishedAt: "2026-11-18T09:00:00.000Z", quotaResetAt: "2026-11-21T00:00:00.000Z", quotaResetText: "Nov 21" });
  const denial = engineInfraDenial("session-1", "deep-reasoner", "continue", box.env, now);
  assert.equal(denial, tagMessage("worker-lifecycle.engine-infra-deny", "Fable usage limit until Nov 21 (2026-11-21T00:00:00.000Z); rerun with model: opus to use Opus 5.5 meanwhile. Route this package to another agent type, or name deep-reasoner to retry."));
  for (const text of ["use fusion:deep-reasoner", "use deep-reasoner"]) assert.equal(engineInfraDenial("session-1", "fusion:deep-reasoner", text, box.env, now), null);
  assert.equal(engineInfraDenial("other-session", "fusion:deep-reasoner", "continue", box.env, now), null);
  assert.equal(engineInfraDenial("session-1", "fusion:claude-worker", "continue", box.env, now), null);
  assert.equal(engineInfraDenial("session-1", "fusion:deep-reasoner", "continue", box.env, Date.parse("2026-11-21T00:00:00.000Z")), null);
});

test("Claude quota overrides compare families across aliases and versioned models", (t) => {
  const box = sandbox(t);
  const now = Date.parse("2026-11-18T10:00:00.000Z");
  workerRecord(box, { agentType: "fusion:deep-reasoner", failureKind: "quota", infraFailure: true, quotaModelFamily: "fable", finishedAt: "2026-11-18T09:00:00.000Z", quotaResetAt: "2026-11-21T00:00:00.000Z" });
  for (const model of ["fable", "fable[1m]", "claude-fable-5-1", "inherit", "unknown", null]) {
    assert.match(engineInfraDenial("session-1", "deep-reasoner", "continue", box.env, now, "model: opus", model), /Fable usage limit/, String(model));
  }
  for (const model of ["opus", "opus[1m]", "claude-opus-5-5", "sonnet"]) {
    assert.equal(engineInfraDenial("session-1", "deep-reasoner", "continue", box.env, now, "", model), null, model);
  }
  workerRecord(box, { agentType: "fusion:deep-reasoner", failureKind: "quota", infraFailure: true, quotaModelFamily: "opus", finishedAt: "2026-11-18T09:30:00.000Z", quotaResetAt: "2026-11-18T11:00:00.000Z" });
  assert.match(engineInfraDenial("session-1", "deep-reasoner", "continue", box.env, now, "", "opus"), /Opus usage limit/);
  assert.equal(engineInfraDenial("session-1", "deep-reasoner", "continue", box.env, Date.parse("2026-11-18T11:00:00.000Z"), "", "opus"), null);
});

test("Claude quota admission migrates saved family evidence without changing the reset", (t) => {
  const box = sandbox(t);
  const now = Date.parse("2026-11-18T10:00:00.000Z");
  const reset = "2026-11-21T00:00:00.000Z";
  const worker = workerRecord(box, { agentType: "fusion:deep-reasoner", failureKind: "quota", infraFailure: true, resolvedModel: "claude-opus-5-5", finalText: "You've hit your Fable limit · resets Nov 21", finishedAt: "2026-11-18T09:00:00.000Z", quotaResetAt: reset, quotaResetText: "Nov 21" });
  assert.equal(engineInfraDenial("session-1", "deep-reasoner", "continue", box.env, now, "", "opus"), null);
  const migrated = readWorkerRecords(box.env).find((record) => record.taskId === worker.taskId);
  assert.equal(migrated.quotaModelFamily, "fable");
  assert.equal(migrated.quotaResetAt, reset);
  assert.match(engineInfraDenial("session-1", "deep-reasoner", "continue", box.env, now, "", "fable"), /Fable usage limit/);
});

for (const alias of ["opus", "sonnet", "haiku", "fable"]) {
  test(`Claude quota resolves the configured ${alias} alias before admission`, (t) => {
    const box = sandbox(t);
    const now = Date.parse("2026-11-18T10:00:00.000Z");
    const env = { ...box.env, [`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`]: "claude-fable-5-2" };
    workerRecord(box, { agentType: "fusion:deep-reasoner", failureKind: "quota", infraFailure: true, quotaModelFamily: "fable", finishedAt: "2026-11-18T09:00:00.000Z", quotaResetAt: "2026-11-21T00:00:00.000Z" });
    for (const model of [alias, `${alias}[1m]`]) {
      const denial = engineInfraDenial("session-1", "deep-reasoner", "continue", env, now, "", model);
      assert.match(denial, /Fable usage limit/, model);
      if (alias === "opus") assert.doesNotMatch(denial, /rerun with model: opus/);
    }
    assert.equal(engineInfraDenial("session-1", "deep-reasoner", "continue", env, now, "", "claude-opus-5-5"), null);
    env[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`] = "claude-sonnet-5";
    assert.equal(engineInfraDenial("session-1", "deep-reasoner", "continue", env, now, "", alias), null);
    assert.match(engineInfraDenial("session-1", "deep-reasoner", "continue", env, now, "", "claude-fable-5-2"), /Fable usage limit/);
    assert.equal(readWorkerRecords(box.env)[0].quotaModelFamily, "fable");
  });
}

test("Claude quota admission migrates resolved model evidence when the error is unavailable", (t) => {
  const box = sandbox(t);
  const now = Date.parse("2026-11-18T10:00:00.000Z");
  workerRecord(box, { agentType: "fusion:deep-reasoner", failureKind: "quota", infraFailure: true, resolvedModel: "claude-opus-5-5", finishedAt: "2026-11-18T09:00:00.000Z", quotaResetAt: "2026-11-21T00:00:00.000Z" });
  assert.equal(engineInfraDenial("session-1", "deep-reasoner", "continue", box.env, now, "", "fable"), null);
  assert.equal(readWorkerRecords(box.env)[0].quotaModelFamily, "opus");
  assert.match(engineInfraDenial("session-1", "deep-reasoner", "continue", box.env, now, "", "opus"), /Opus usage limit/);
});

test("Claude quota admission migrates errors kept only in the worker transcript", (t) => {
  const box = sandbox(t);
  const now = Date.parse("2026-11-18T10:00:00.000Z");
  const transcriptPath = path.join(box.root, "quota-worker.jsonl");
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "You've hit your Fable limit · resets Nov 21" }] } })}\n`);
  workerRecord(box, { agentType: "fusion:deep-reasoner", failureKind: "quota", infraFailure: true, transcriptPath, finishedAt: "2026-11-18T09:00:00.000Z", quotaResetAt: "2026-11-21T00:00:00.000Z" });
  assert.equal(engineInfraDenial("session-1", "deep-reasoner", "continue", box.env, now, "", "opus"), null);
  assert.equal(readWorkerRecords(box.env)[0].quotaModelFamily, "fable");
});

test("Claude quota without a parsed reset reopens after one hour", (t) => {
  const box = sandbox(t);
  const finished = Date.parse("2026-11-18T09:00:00.000Z");
  workerRecord(box, { agentType: "fusion:claude-worker", failureKind: "quota", infraFailure: true, finishedAt: new Date(finished).toISOString() });
  assert.match(engineInfraDenial("session-1", "claude-worker", "continue", box.env, finished + 3_599_999), /2026-11-18T10:00:00.000Z \(1 hour fallback\)/);
  assert.match(engineInfraDenial("session-1", "claude-worker", "continue", box.env, finished + 3_599_999, "", "opus"), /usage limit/);
  assert.equal(engineInfraDenial("session-1", "claude-worker", "continue", box.env, finished + 3_600_000), null);
});

test("healthy OpenCode bulk and blind-check roles do not block no-healthy-lane", (t) => {
  const box = sandbox(t);
  for (const engine of ["codex", "grok", "cursor", "agy"]) {
    workerRecord(box, { agentType: ENGINES[engine].rescueAgent });
  }
  for (const [role, mode] of [["bulk", "write"], ["blind-check", "consult"]]) {
    healthJob(box, "opencode", role, { status: "done", failureKind: null, mode, billingPool: "opencode" });
    assert.equal(engineHealth("opencode", mode, "opencode", { env: box.env, sessionId: "session-1" }).healthy, true);
  }
  assert.equal(fs.statSync(box.env.OPENCODE_CODEX_BIN).isFile(), true);
  for (const agent of ["fusion:claude-worker", "fusion:trivial-worker"]) {
    const result = validateWorkerBrief(fallbackBrief("no-healthy-lane"), agent, box.env);
    assert.equal(result.ok, true, result.reason);
  }
});

test("OpenCode dispatch fills protected defaults and keeps blind-check read only", async (t) => {
  const box = sandbox(t);
  for (const [role, model] of [["bulk", "deepseek-v4.1-flash"], ["blind-check", "glm-5.3-flash"]]) {
    const prompt = `lane: opencode ${role}\nopencode-role: ${role}\nverification: node --test`;
    const injected = injectedPeerDefaults(prompt, ENGINES.opencode.rescueAgent, box.env);
    assert.match(injected.prompt, new RegExp(`^--model ${model.replaceAll(".", "\\.")} --effort high -- `));
    const record = createDispatch({ session_id: "session-1", tool_use_id: role, cwd: box.root, tool_input: { prompt: injected.prompt } }, ENGINES.opencode.rescueAgent, false, box.env);
    assert.equal(record.requestedModel, model);
    assert.equal(record.billingPool, "opencode");
    if (role === "blind-check") {
      const launchBox = sandbox(t);
      const output = await launch(launchBox, { subagent_type: ENGINES.opencode.rescueAgent, prompt }, { tool_use_id: role });
      assert.equal(output.permissionDecision, "allow", output.permissionDecisionReason);
      assert.match(output.updatedInput.prompt, /^fusion-staged-token: [a-f0-9]{48}\nmode: read-only$/);
      const token = output.updatedInput.prompt.split("\n")[0].split(": ")[1];
      assert.equal(fs.readFileSync(path.join(launchBox.root, `opencode-companion-input-${token}`, "request"), "utf8"), injected.prompt);
    }
  }
});
