import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { ENGINES, ENGINE_IDS, engineRoleFromBrief } from "../plugins/fusion/scripts/lib/engines.mjs";
import { briefArtifactPath } from "../plugins/fusion/scripts/lib/lifecycle/dispatch.mjs";
import { readPeerCapacityReservations, readWorkerRecords } from "../plugins/fusion/scripts/lib/worker-state.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const hook = path.join(repoRoot, "plugins/fusion/scripts/fusion-hook.mjs");
const lifecycle = path.join(repoRoot, "plugins/fusion/scripts/worker-lifecycle.mjs");
const engines = ENGINE_IDS;
const sessionId = "wrapper-prestage-session";

function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-prestage-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transcript = path.join(root, "parent.jsonl");
  fs.writeFileSync(transcript, "");
  const env = {
    ...process.env,
    HOME: path.join(root, "home"),
    FUSION_DATA_DIR: path.join(root, "fusion"),
    FUSION_WORKER_STATE_DIR: path.join(root, "workers"),
    FUSION_MODEL_ROUTING: path.join(root, "missing-routing.json"),
    CLAUDE_CODE_SESSION_ID: "inherited-session-must-not-own-transport",
    TMPDIR: root,
    TMP: root,
    TEMP: root
  };
  for (const engine of engines) {
    env[ENGINES[engine].companionEnv] = engine === "grok" ? path.join(import.meta.dirname, "fixtures", "healthy-grok-companion.mjs") : path.join(repoRoot, `plugins/${engine}/scripts/${engine}-companion.mjs`);
    env[ENGINES[engine].dataEnv] = path.join(root, engine);
  }
  return { root, transcript, env };
}

function event(box, engine, prompt, fields = {}) {
  return {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    tool_use_id: "launch-1",
    cwd: box.root,
    transcript_path: box.transcript,
    tool_name: "Agent",
    tool_input: { subagent_type: ENGINES[engine].rescueAgent, description: `${engine} package`, prompt },
    ...fields
  };
}

function runHook(box, input, preload = null, script = hook) {
  const result = spawnSync(process.execPath, [...(preload ? ["--import", preload] : []), script], {
    input: JSON.stringify(input), env: box.env, cwd: box.root, encoding: "utf8", timeout: 15000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function stagedTransport(t, box, engine, output, mode) {
  const result = output?.hookSpecificOutput;
  assert.equal(result?.permissionDecision, "allow");
  const matched = result.updatedInput?.prompt.match(/^fusion-staged-token: ([a-f0-9]{48})\nmode: (write|read-only)$/);
  assert.ok(matched, JSON.stringify(output));
  assert.equal(matched[2], mode);
  const token = matched[1];
  const directory = path.join(box.root, `${engine}-companion-input-${token}`);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { token, directory, file: path.join(directory, "request"), input: result.updatedInput };
}

function consume(box, engine, token, owner = sessionId) {
  const moduleUrl = pathToFileURL(path.join(repoRoot, `plugins/${engine}/scripts/lib/raw-transport.mjs`)).href;
  const source = `
    const { configureRawTransport, consumeRawCommandTransport } = await import(process.argv[1]);
    configureRawTransport({ engineName: process.argv[2], sessionIdEnv: "CLAUDE_CODE_SESSION_ID", maxRawArgumentBytes: 5 * 1024 * 1024, makeError: (message, kind) => Object.assign(new Error(message), { failureKind: kind }) });
    process.stdout.write(consumeRawCommandTransport(process.argv[3]));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source, moduleUrl, engine, token], {
    env: { ...box.env, CLAUDE_CODE_SESSION_ID: owner }, encoding: "utf8", timeout: 10000
  });
}

function preload(box, source) {
  const file = path.join(box.root, "fault.mjs");
  fs.writeFileSync(file, `import fs from "node:fs";\nimport childProcess from "node:child_process";\nimport { syncBuiltinESMExports } from "node:module";\n${source}\nsyncBuiltinESMExports();\n`);
  return file;
}

for (const engine of engines) {
  for (const mode of ["write", "read-only"]) {
    test(`${engine} ${mode} stages and consumes exact bytes under the hook session`, (t) => {
      const box = sandbox(t);
      const header = `--model sample --effort high ${mode === "write" ? "--write " : ""}-- `;
      const prompt = `${header}lane: ${engine} ${engine === "codex" ? "quick" : "burst"} · ${mode}\r\n'quotes' "double" \\backslash \\n literal\n\`backticks\` $(touch ${path.join(box.root, "shell-ran")})\n多字节 🦊 café\n\n`;
      const input = event(box, engine, prompt);
      const output = runHook(box, input);
      const staged = stagedTransport(t, box, engine, output, mode);
      assert.deepEqual(output.hookSpecificOutput.updatedInput, { ...input.tool_input, prompt: staged.input.prompt });
      assert.equal(input.tool_input.prompt, prompt);
      assert.deepEqual(fs.readFileSync(staged.file), Buffer.from(prompt));
      assert.equal(fs.statSync(staged.file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(staged.directory).mode & 0o777, 0o700);
      const owner = JSON.parse(fs.readFileSync(path.join(staged.directory, "owner.json"), "utf8"));
      assert.equal(owner.sessionHash, createHash("sha256").update(sessionId).digest("hex"));
      const wrongOwner = consume(box, engine, staged.token, "another-session");
      assert.notEqual(wrongOwner.status, 0);
      assert.match(wrongOwner.stderr, /belongs to another Claude session/);
      assert.equal(fs.existsSync(staged.file), true);
      const consumed = consume(box, engine, staged.token);
      assert.equal(consumed.status, 0, consumed.stderr);
      assert.deepEqual(Buffer.from(consumed.stdout), Buffer.from(prompt));
      assert.equal(fs.existsSync(staged.directory), false);
      assert.notEqual(consume(box, engine, staged.token).status, 0);
      assert.equal(fs.existsSync(path.join(box.root, "shell-ran")), false);
      runHook(box, { ...input, hook_event_name: "PostToolUse", tool_input: staged.input, tool_response: { isAsync: true, agentId: "roundtrip-peer" } });
      const [record] = readWorkerRecords(box.env);
      assert.equal(fs.readFileSync(record.briefFile, "utf8"), prompt);
      assert.equal(record.briefFile, briefArtifactPath(record, box.env));
      assert.equal(record.description, input.tool_input.description);
      assert.equal(record.packageType, mode === "write" ? "implementation" : "consult");
      assert.deepEqual(readPeerCapacityReservations(box.env), []);
      assert.equal(runHook(box, { hook_event_name: "SubagentStart", session_id: sessionId, agent_id: "roundtrip-peer", agent_type: ENGINES[engine].rescueAgent, tool_input: staged.input, cwd: box.root }, null, lifecycle), null);
      runHook(box, { hook_event_name: "SubagentStop", session_id: sessionId, agent_id: "roundtrip-peer", agent_type: ENGINES[engine].rescueAgent, cwd: box.root, last_assistant_message: `done\njob: ${"a".repeat(32)}\nstate: done` }, null, lifecycle);
      assert.equal(readWorkerRecords(box.env)[0].peerEngine, engine);
      assert.equal(fs.readFileSync(record.briefFile, "utf8"), prompt);
    });
  }
}

test("only a deterministic leading mode stages an Agent request", (t) => {
  const box = sandbox(t);
  for (const prompt of [
    "please modify the parser",
    "please review this read-only consult",
    "--model sample -- modify the parser",
    "--model sample -- bounded task\nread-only consult",
    "--model sample -- bounded task with --write in its body",
    "fusion-staged-token: abc\nmode: write",
    `fusion-staged-token: ${"a".repeat(48)}\nmode: write\nextra data`
  ]) {
    const output = runHook(box, event(box, "codex", prompt));
    assert.equal(output?.hookSpecificOutput?.updatedInput, undefined, prompt);
    assert.notEqual(output?.hookSpecificOutput?.permissionDecision, "deny", prompt);
    runHook(box, { ...event(box, "codex", prompt), hook_event_name: "PostToolUse", tool_response: { status: "completed" } });
  }
  for (const [index, header] of ["read only", "READ-ONLY", "consult", "consultation"].entries()) {
    const output = runHook(box, event(box, "codex", `-- ${header}\nmodify no files`, { tool_use_id: `read-${index}` }));
    if (header === "consultation") {
      assert.equal(output?.hookSpecificOutput?.updatedInput, undefined);
    } else {
      const staged = stagedTransport(t, box, "codex", output, "read-only");
      assert.equal(consume(box, "codex", staged.token).status, 0);
    }
    runHook(box, { ...event(box, "codex", "unused", { tool_use_id: `read-${index}` }), hook_event_name: "PostToolUse", tool_response: { status: "completed" } });
  }
  const write = runHook(box, event(box, "codex", "--write -- read-only consult", { tool_use_id: "write-overrides-header" }));
  const staged = stagedTransport(t, box, "codex", write, "write");
  assert.equal(consume(box, "codex", staged.token).status, 0);
});

test("consult only routed roles prestage read only while write takes precedence", (t) => {
  const box = sandbox(t);
  const cases = [
    ["grok", "lane: grok live-web", true],
    ["grok", "lane: panel | grok-role: large-context", true],
    ["cursor", "lane: cursor diversity", true],
    ["devin", "lane: devin diversity", true],
    ["agy", "lane: agy independence", true],
    ["agy", "lane: panel | agy-role: large-context", true],
    ["codex", "lane: codex quick", false],
    ["grok", "lane: grok burst", false],
    ["cursor", "lane: cursor burst", false],
    ["devin", "lane: devin burst", false],
    ["agy", "lane: agy burst", false]
  ];
  for (const [index, [engine, header, consultOnly]] of cases.entries()) {
    for (const write of [false, true]) {
      const prompt = `--model sample --effort high ${write ? "--write " : ""}-- ${header}\ngoal: inspect the package`;
      const input = event(box, engine, prompt, { tool_use_id: `role-${index}-${write}` });
      const output = runHook(box, input);
      if (!consultOnly && !write) {
        assert.equal(output?.hookSpecificOutput?.updatedInput, undefined, prompt);
      } else {
        const staged = stagedTransport(t, box, engine, output, write ? "write" : "read-only");
        assert.equal(fs.readFileSync(staged.file, "utf8"), prompt);
        assert.equal(consume(box, engine, staged.token).status, 0);
      }
      runHook(box, { ...input, hook_event_name: "PostToolUse", tool_response: { status: "completed" } });
    }
  }
});

test("an operation review routing header stages the three line review form", (t) => {
  let box;
  for (const [engine, role] of [["devin", "diversity"], ["cursor", "diversity"], ["agy", "independence"]]) {
    box = sandbox(t);
    const prompt = `-- ${engine}-role: ${role} | operation: review | acceptance: findings cite file:line\nreview the working tree diff`;
    const input = event(box, engine, prompt, { tool_use_id: `review-${engine}` });
    const output = runHook(box, input);
    const result = output?.hookSpecificOutput;
    assert.equal(result?.permissionDecision, "allow", `${engine}: ${JSON.stringify(output)}`);
    const matched = result.updatedInput?.prompt.match(/^fusion-staged-token: ([a-f0-9]{48})\nmode: read-only\noperation: review$/);
    assert.ok(matched, `${engine}: ${JSON.stringify(output)}`);
    const file = path.join(box.root, `${engine}-companion-input-${matched[1]}`, "request");
    t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
    const stagedBytes = fs.readFileSync(file, "utf8");
    assert.ok(stagedBytes.endsWith(prompt), `${engine}: ${stagedBytes}`);
    const consumed = consume(box, engine, matched[1]);
    assert.equal(consumed.status, 0, consumed.stderr);
    assert.equal(consumed.stdout, stagedBytes);
    runHook(box, { ...input, hook_event_name: "PostToolUse", tool_input: result.updatedInput, tool_response: { isAsync: true, agentId: `review-peer-${engine}` } });
  }
});

test("operation review forces read only staging while other headers keep the two line form", (t) => {
  let box;
  box = sandbox(t);
  const review = runHook(box, event(box, "devin", "--write -- devin-role: burst | operation: review\nreview the wave diff", { tool_use_id: "burst-review" }));
  const matched = review?.hookSpecificOutput?.updatedInput?.prompt.match(/^fusion-staged-token: ([a-f0-9]{48})\nmode: read-only\noperation: review$/);
  assert.ok(matched, JSON.stringify(review));
  const file = path.join(box.root, `devin-companion-input-${matched[1]}`, "request");
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  assert.equal(consume(box, "devin", matched[1]).status, 0);
  runHook(box, { ...event(box, "devin", "unused", { tool_use_id: "burst-review" }), hook_event_name: "PostToolUse", tool_input: review.hookSpecificOutput.updatedInput, tool_response: { isAsync: true, agentId: "burst-review-peer" } });
  for (const [index, header] of ["devin-role: diversity", "devin-role: diversity | operation: task", "devin-role: diversity | operation: reviewer"].entries()) {
    box = sandbox(t);
    const input = event(box, "devin", `-- ${header}\ninspect the package`, { tool_use_id: `header-${index}` });
    const staged = stagedTransport(t, box, "devin", runHook(box, input), "read-only");
    assert.equal(consume(box, "devin", staged.token).status, 0);
    runHook(box, { ...input, hook_event_name: "PostToolUse", tool_input: staged.input, tool_response: { isAsync: true, agentId: `header-peer-${index}` } });
  }
});

test("operation review headers stage the two line form for codex and grok", (t) => {
  const box = sandbox(t);
  for (const [engine, role] of [["codex", "quick"], ["grok", "independence"]]) {
    const prompt = `-- ${engine}-role: ${role} | operation: review | acceptance: findings cite file:line\nreview the working tree diff`;
    const input = event(box, engine, prompt, { tool_use_id: `review-two-line-${engine}` });
    const output = runHook(box, input);
    const staged = stagedTransport(t, box, engine, output, "read-only");
    assert.ok(fs.readFileSync(staged.file, "utf8").endsWith(prompt));
    assert.equal(consume(box, engine, staged.token).status, 0);
    runHook(box, { ...input, hook_event_name: "PostToolUse", tool_input: staged.input, tool_response: { isAsync: true, agentId: `review-two-line-${engine}` } });
  }
});

test("operation review is a header field separated from prose", (t) => {
  let box;
  for (const [index, header] of ["operation: review", "devin-role: diversity; operation: review", "devin-role: diversity, operation: review", "devin-role: diversity · operation: review"].entries()) {
    box = sandbox(t);
    const output = runHook(box, event(box, "devin", `-- ${header}\nreview the working tree diff`, { tool_use_id: `separator-${index}` }));
    const matched = output?.hookSpecificOutput?.updatedInput?.prompt.match(/^fusion-staged-token: ([a-f0-9]{48})\nmode: read-only\noperation: review$/);
    assert.ok(matched, `${header}: ${JSON.stringify(output)}`);
    const file = path.join(box.root, `devin-companion-input-${matched[1]}`, "request");
    t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
    assert.equal(consume(box, "devin", matched[1]).status, 0);
    runHook(box, { ...event(box, "devin", "unused", { tool_use_id: `separator-${index}` }), hook_event_name: "PostToolUse", tool_input: output.hookSpecificOutput.updatedInput, tool_response: { isAsync: true, agentId: `separator-peer-${index}` } });
  }
  for (const [index, prompt] of [
    "--write -- goal: run the operation: review suite end to end\nscope: the diff",
    "--write -- devin-role: burst operation: review\nreview the wave diff",
    "--write -- devin-role: burst | reoperation: review\nreview the wave diff"
  ].entries()) {
    box = sandbox(t);
    const input = event(box, "devin", prompt, { tool_use_id: `prose-${index}` });
    const output = runHook(box, input);
    const staged = stagedTransport(t, box, "devin", output, "write");
    assert.ok(fs.readFileSync(staged.file, "utf8").endsWith(prompt), prompt);
    assert.equal(consume(box, "devin", staged.token).status, 0);
    runHook(box, { ...input, hook_event_name: "PostToolUse", tool_input: staged.input, tool_response: { isAsync: true, agentId: `prose-peer-${index}` } });
  }
});

test("the staged header is the first non blank brief line like role detection", (t) => {
  let box;
  box = sandbox(t);
  const review = runHook(box, event(box, "devin", "\n  \ndevin-role: diversity | operation: review\nreview the diff", { tool_use_id: "blank-header" }));
  const matched = review?.hookSpecificOutput?.updatedInput?.prompt.match(/^fusion-staged-token: ([a-f0-9]{48})\nmode: read-only\noperation: review$/);
  assert.ok(matched, JSON.stringify(review));
  const file = path.join(box.root, `devin-companion-input-${matched[1]}`, "request");
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  assert.equal(consume(box, "devin", matched[1]).status, 0);
  runHook(box, { ...event(box, "devin", "unused", { tool_use_id: "blank-header" }), hook_event_name: "PostToolUse", tool_input: review.hookSpecificOutput.updatedInput, tool_response: { isAsync: true, agentId: "blank-header-peer" } });
  box = sandbox(t);
  const consult = runHook(box, event(box, "codex", "-- \n\nread only\nmodify no files", { tool_use_id: "blank-consult" }));
  const staged = stagedTransport(t, box, "codex", consult, "read-only");
  assert.equal(consume(box, "codex", staged.token).status, 0);
  runHook(box, { ...event(box, "codex", "unused", { tool_use_id: "blank-consult" }), hook_event_name: "PostToolUse", tool_input: staged.input, tool_response: { isAsync: true, agentId: "blank-consult-peer" } });
  box = sandbox(t);
  const prose = runHook(box, event(box, "devin", "--write --\n\nreview the operation: review notes", { tool_use_id: "blank-prose" }));
  const proseStaged = stagedTransport(t, box, "devin", prose, "write");
  assert.equal(consume(box, "devin", proseStaged.token).status, 0);
  runHook(box, { ...event(box, "devin", "unused", { tool_use_id: "blank-prose" }), hook_event_name: "PostToolUse", tool_input: proseStaged.input, tool_response: { isAsync: true, agentId: "blank-prose-peer" } });
});

test("the review wrappers carry the staged review command rule", () => {
  for (const engine of ["devin", "cursor", "agy"]) {
    const file = `plugins/${engine}/agents/${engine}-rescue.md`;
    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.ok(content.includes("`operation: review`"), file);
    assert.ok(content.includes(`node "\${CLAUDE_PLUGIN_ROOT}/scripts/${engine}-companion.mjs" review --transport-background-shell --raw-args-token TOKEN`), file);
    assert.match(content, /instead of the task command/, file);
    assert.match(content, /same await-output loop/, file);
  }
});

test("leading write options stage without a brief separator", (t) => {
  const box = sandbox(t);
  for (const [index, prompt] of ["--write", "--write modify the parser", '--model "model with spaces" --write modify the parser'].entries()) {
    const input = event(box, "codex", prompt, { tool_use_id: `unseparated-${index}` });
    const output = runHook(box, input);
    const staged = stagedTransport(t, box, "codex", output, "write");
    assert.equal(consume(box, "codex", staged.token).stdout, prompt);
    runHook(box, { ...input, hook_event_name: "PostToolUse", tool_response: { status: "completed" } });
  }
});

test("SendMessage continuations keep raw prompts while Task launches stage", (t) => {
  const box = sandbox(t);
  const prompt = "--write -- read-only consult";
  const input = event(box, "codex", prompt);
  runHook(box, { ...input, hook_event_name: "PostToolUse", tool_response: { isAsync: true, agentId: "peer-1" } });
  const continuation = { ...input, tool_name: "SendMessage", tool_input: { to: "peer-1", message: prompt } };
  const continued = runHook(box, continuation);
  assert.equal(continued?.hookSpecificOutput?.updatedInput, undefined);
  assert.notEqual(continued?.hookSpecificOutput?.permissionDecision, "deny");
  const taskPrompt = `--cwd isolated-worktree ${prompt}`;
  const task = runHook(box, { ...input, tool_name: "Task", tool_use_id: "task-1", tool_input: { ...input.tool_input, prompt: taskPrompt } });
  const staged = stagedTransport(t, box, "codex", task, "write");
  assert.equal(fs.readFileSync(staged.file, "utf8"), taskPrompt);
  assert.equal(consume(box, "codex", staged.token).status, 0);
  runHook(box, { ...input, tool_name: "Task", tool_use_id: "task-1", hook_event_name: "PostToolUse", tool_input: staged.input, tool_response: { isAsync: true, agentId: "task-peer-1" } });
  const record = readWorkerRecords(box.env).find((entry) => entry.agentId === "task-peer-1");
  assert.ok(record);
  assert.equal(fs.readFileSync(record.briefFile, "utf8"), taskPrompt);
});

test("parallel same-engine requests without tool use ids retain their own briefs", (t) => {
  const box = sandbox(t);
  const inputs = ["first brief", "second brief"].map((brief, index) => event(box, "codex", `--cwd worktree-${index} --write -- ${brief}`, { tool_use_id: undefined }));
  for (const input of inputs) {
    const output = runHook(box, input);
    assert.notEqual(output?.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(output?.hookSpecificOutput?.updatedInput, undefined);
  }
  assert.equal(fs.readdirSync(box.root).some((name) => name.includes("-companion-input-")), false);
  assert.ok(readPeerCapacityReservations(box.env).every((entry) => entry.originalPrompt === undefined));
  for (const [index, input] of inputs.entries()) {
    runHook(box, { ...input, hook_event_name: "PostToolUse", tool_response: { isAsync: true, agentId: `unstaged-peer-${index}` } });
  }
  const records = readWorkerRecords(box.env);
  assert.equal(records.length, inputs.length);
  for (const [index, input] of inputs.entries()) {
    const record = records.find((entry) => entry.agentId === `unstaged-peer-${index}`);
    assert.ok(record);
    assert.equal(fs.readFileSync(record.briefFile, "utf8"), input.tool_input.prompt);
  }
  assert.deepEqual(readPeerCapacityReservations(box.env), []);
});

for (const fault of ["no companion", "spawn error", "spawn throw", "invalid JSON", "bad token", "bad token type", "bad file", "write error", "create exit", "reservation write error", "discard error"]) {
  test(`staging falls back and cleans up after ${fault}`, (t) => {
    const box = sandbox(t);
    const source = `
      const fault = ${JSON.stringify(fault)};
      const originalSpawn = childProcess.spawnSync;
      const originalWrite = fs.writeFileSync;
      const originalRename = fs.renameSync;
      if (fault === "no companion") {
        const originalStat = fs.statSync;
        const originalExists = fs.existsSync;
        fs.statSync = (file, ...args) => { if (String(file).endsWith("codex-companion.mjs")) throw new Error("unavailable"); return originalStat(file, ...args); };
        fs.existsSync = (file) => String(file).endsWith("codex-companion.mjs") ? false : originalExists(file);
      }
      fs.writeFileSync = (file, ...args) => {
        if (["write error", "discard error"].includes(fault) && String(file).endsWith("/request")) throw new Error("write failed");
        return originalWrite(file, ...args);
      };
      let created = false;
      fs.renameSync = (...args) => {
        if (created && fault === "reservation write error" && String(args[1]).endsWith("peer-capacity-reservations.json")) throw new Error("reservation write failed");
        return originalRename(...args);
      };
      childProcess.spawnSync = (command, args, options) => {
        if (args?.[1] === "transport-create") {
          if (fault === "spawn throw") throw new Error("spawn failed");
          if (fault === "spawn error") return { error: new Error("spawn failed"), stdout: "", status: null };
          const result = originalSpawn(command, args, options);
          if (result.status !== 0) return result;
          created = true;
          const transport = JSON.parse(result.stdout);
          originalWrite(${JSON.stringify(path.join(box.root, "created.json"))}, JSON.stringify(transport));
          if (fault === "invalid JSON") return { ...result, stdout: "invalid JSON " + result.stdout };
          if (fault === "bad token") return { ...result, stdout: JSON.stringify({ ...transport, token: "INVALID" }) };
          if (fault === "bad token type") return { ...result, stdout: JSON.stringify({ ...transport, token: [transport.token] }) };
          if (fault === "bad file") return { ...result, stdout: JSON.stringify({ ...transport, file: "relative/request" }) };
          if (fault === "create exit") return { ...result, status: 1 };
          return result;
        }
        if (args?.[1] === "transport-discard") {
          originalWrite(${JSON.stringify(path.join(box.root, "discard.json"))}, JSON.stringify(args));
          const result = originalSpawn(command, args, options);
          if (fault === "discard error") throw new Error("discard failed after cleanup");
          return result;
        }
        return originalSpawn(command, args, options);
      };
    `;
    const input = event(box, "codex", "--write -- preserve this request exactly\n'字节' `code` $(literal)");
    const output = runHook(box, input, preload(box, source));
    assert.notEqual(output?.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(output?.hookSpecificOutput?.updatedInput, undefined);
    assert.equal(readPeerCapacityReservations(box.env)[0].originalPrompt, undefined);
    const createdFile = path.join(box.root, "created.json");
    if (fs.existsSync(createdFile)) {
      const created = JSON.parse(fs.readFileSync(createdFile, "utf8"));
      assert.equal(fs.existsSync(path.dirname(created.file)), false);
      const args = JSON.parse(fs.readFileSync(path.join(box.root, "discard.json"), "utf8"));
      assert.deepEqual(args.slice(1), ["transport-discard", "--raw-args-token", created.token]);
    }
  });
}

test("staged bytes and late brief artifacts retain injected defaults and parent context", (t) => {
  const box = sandbox(t);
  const routing = path.join(box.root, "routing.json");
  fs.writeFileSync(routing, JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    costProfile: "test",
    models: [{ id: "gpt-6.1-sol", lane: "codex", intelligence: 5, taste: 5, cost: 5 }],
    defaults: { codex: { quick: { model: "gpt-6.1-sol", effort: "xhigh" } } }
  }));
  box.env.FUSION_MODEL_ROUTING = routing;
  fs.writeFileSync(box.transcript, `${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 1000, cache_read_input_tokens: 299000 } } })}\n`);
  const prompt = "--cwd 'isolated worktree' --write -- lane: codex quick · write\ngoal: fix quotes ' \" `code` $(literal) 多字节\nverification: node --test\n";
  const input = event(box, "codex", prompt);
  const output = runHook(box, input);
  const staged = stagedTransport(t, box, "codex", output, "write");
  const expected = `--model gpt-6.1-sol --effort xhigh ${prompt}`;
  assert.equal(fs.readFileSync(staged.file, "utf8"), expected);
  assert.match(output.hookSpecificOutput.additionalContext, /lane default/);
  assert.match(output.systemMessage, /main loop context is 300k tokens/);
  assert.equal(engineRoleFromBrief("codex", expected.slice(expected.indexOf("lane:"))), "quick");
  assert.equal(consume(box, "codex", staged.token).stdout, expected);
  runHook(box, { ...input, hook_event_name: "PostToolUse", tool_input: staged.input, tool_response: { isAsync: true, agentId: "peer-1" } });
  const [record] = readWorkerRecords(box.env);
  assert.ok(record);
  assert.equal(record.description, "codex package");
  assert.equal(record.agentType, ENGINES.codex.rescueAgent);
  assert.equal(record.packageType, "implementation");
  assert.equal(record.companionCwd, path.join(box.root, "isolated worktree"));
  assert.equal(record.parentTranscriptPath, box.transcript);
  assert.equal(record.parentTranscriptBytesAtDispatch, fs.statSync(box.transcript).size);
  assert.equal(record.parentContextTokensAtDispatch, 300000);
  assert.equal(record.briefFile, briefArtifactPath(record, box.env));
  assert.equal(fs.readFileSync(record.briefFile, "utf8"), expected);
  assert.deepEqual(readPeerCapacityReservations(box.env), []);
  runHook(box, { hook_event_name: "SubagentStop", session_id: sessionId, agent_id: "peer-1", agent_type: ENGINES.codex.rescueAgent, cwd: box.root, last_assistant_message: "terminated early due to an API error" }, null, lifecycle);
  const stop = runHook(box, { hook_event_name: "Stop", session_id: sessionId, cwd: box.root }, null, lifecycle);
  assert.match(JSON.stringify(stop), /redispatch/);
  assert.ok(JSON.stringify(stop).includes(record.briefFile));
  assert.equal(fs.readFileSync(record.briefFile, "utf8"), expected);
});

test("large flagship writes stage transport", (t) => {
  const box = sandbox(t);
  const output = runHook(box, event(box, "codex", `--write --model gpt-6-astra -- ${"x".repeat(3000)}`));
  assert.equal(output.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(readPeerCapacityReservations(box.env).length, 1);
  assert.equal(fs.readdirSync(box.root).some((name) => name.includes("-companion-input-")), true);
});
