import assert from "node:assert";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { briefAdvisory, peerBrief } from "../plugins/fusion/scripts/brief-sensor.mjs";
import { messageTag } from "../plugins/fusion/scripts/lib/user-messages.mjs";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "plugins", "fusion", "scripts", "brief-sensor.mjs");
const checkIds = ["mixedConcern", "tasteAsProse", "noDoneCriteria", "unbounded"];

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function startServer(t, responder) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    requests.push({ method: request.method, headers: request.headers, body });
    await responder(request, response, body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(server));
  const { port } = server.address();
  return { endpoint: `http://127.0.0.1:${port}`, requests };
}

function envFor(endpoint, { key = true } = {}) {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  delete env.FUSION_JEV_ENDPOINT;
  if (key) {
    env.TYPESAFE_API_KEY = "test-key";
  }
  env.FUSION_JEV_ENDPOINT = endpoint;
  return env;
}

function runHook(input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

function hookInput({ hookEventName = "PreToolUse", toolName = "Agent", subagentType = "codex:codex-rescue", prompt = "x".repeat(300) } = {}) {
  return { hook_event_name: hookEventName, tool_name: toolName, tool_input: { subagent_type: subagentType, prompt } };
}

function answerSet(noul) {
  return Object.fromEntries(checkIds.map((id) => [id, { type: "noul", noul }]));
}

test("peerBrief rejects non-peer events and short briefs", () => {
  assert.strictEqual(peerBrief(hookInput({ hookEventName: "PostToolUse" })), null);
  assert.strictEqual(peerBrief(hookInput({ toolName: "Bash" })), null);
  assert.strictEqual(peerBrief(hookInput({ subagentType: "Explore" })), null);
  assert.strictEqual(peerBrief(hookInput({ subagentType: "grok:grok-review-runner" })), null);
  assert.strictEqual(peerBrief(hookInput({ prompt: "x".repeat(199) })), null);
});

test("peerBrief accepts both peer tools and rescue agents", () => {
  const brief = "x".repeat(300);
  for (const toolName of ["Agent", "Task"]) {
    for (const subagentType of ["codex:codex-rescue", "grok:grok-rescue"]) {
      assert.strictEqual(peerBrief(hookInput({ toolName, subagentType, prompt: brief })), brief);
    }
  }
});

test("peerBrief extracts only leading flag envelopes", () => {
  const brief = `  ${"x".repeat(300)}  `;

  assert.strictEqual(peerBrief(hookInput({ prompt: `--write --cwd "/x" -- ${brief}` })), brief.trim());
  assert.strictEqual(peerBrief(hookInput({ prompt: `  ordinary prompt -- ${brief}  ` })), `ordinary prompt -- ${brief}`.trim());
});

test("briefAdvisory ignores absent, low, and non-finite answers", () => {
  assert.strictEqual(briefAdvisory(null), null);
  assert.strictEqual(briefAdvisory({}), null);
  assert.strictEqual(briefAdvisory(answerSet(0.69)), null);
  assert.strictEqual(briefAdvisory({ mixedConcern: { noul: Number.NaN }, unbounded: { noul: Infinity } }), null);
});

test("briefAdvisory flags its threshold and retains its message tag", () => {
  const advisory = briefAdvisory({ mixedConcern: { noul: 0.7 } });

  assert.ok(advisory.startsWith("Jev flagged this peer brief."));
  assert.ok(advisory.includes("(p=0.70)"));
  assert.ok(advisory.endsWith(messageTag("brief-sensor.readiness-advisory")));
});

test("briefAdvisory preserves check order and excludes clean findings", () => {
  const advisory = briefAdvisory({ mixedConcern: { noul: 0.93 }, tasteAsProse: { noul: 0.05 }, noDoneCriteria: { noul: 0.05 }, unbounded: { noul: 0.91 } });

  assert.ok(advisory.indexOf("It asks one package to find a cause and to fix it") < advisory.indexOf("It asks for a sweep without named paths"));
  assert.ok(!advisory.includes("It carries style or design intent only as prose"));
  assert.ok(!advisory.includes("It names no checkable completion condition"));
});

test("the hook emits one advisory output without a permission decision", async (t) => {
  const server = await startServer(t, (_request, response) => response.end(JSON.stringify({ answers: answerSet(0.9) })));
  const result = await runHook(JSON.stringify(hookInput()), envFor(server.endpoint));

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.signal, null);
  assert.strictEqual(result.stdout.trim().split("\n").length, 1);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.strictEqual(typeof output.hookSpecificOutput.additionalContext, "string");
  assert.strictEqual(Object.hasOwn(output, "permissionDecision"), false);
  assert.strictEqual(Object.hasOwn(output.hookSpecificOutput, "permissionDecision"), false);
});

test("the hook sends clean peer briefs and stays silent for clean answers", async (t) => {
  const server = await startServer(t, (_request, response) => response.end(JSON.stringify({ answers: answerSet(0.05) })));
  const brief = "x".repeat(300);
  const result = await runHook(JSON.stringify(hookInput({ prompt: `--write --cwd "/x" -- ${brief}` })), envFor(server.endpoint));

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(server.requests.length, 1);
  const request = JSON.parse(server.requests[0].body);
  assert.strictEqual(request.state, brief);
  assert.deepStrictEqual(Object.keys(request.questions), checkIds);
  for (const question of Object.values(request.questions)) {
    assert.strictEqual(question.type, "noul");
  }
});

test("the hook fails open for classifier, key, peer, and stdin failures", async (t) => {
  const server = await startServer(t, (_request, response) => {
    response.writeHead(500);
    response.end();
  });
  const classifierFailure = await runHook(JSON.stringify(hookInput()), envFor(server.endpoint));
  const beforeMissingKey = server.requests.length;
  const missingKey = await runHook(JSON.stringify(hookInput()), envFor(server.endpoint, { key: false }));
  const beforeNonPeer = server.requests.length;
  const nonPeer = await runHook(JSON.stringify(hookInput({ subagentType: "Explore" })), envFor(server.endpoint));
  const beforeMalformed = server.requests.length;
  const malformed = await runHook("{not json", envFor(server.endpoint));

  for (const result of [classifierFailure, missingKey, nonPeer, malformed]) {
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
  }
  assert.strictEqual(server.requests.length, 1);
  assert.strictEqual(beforeMissingKey, 1);
  assert.strictEqual(beforeNonPeer, 1);
  assert.strictEqual(beforeMalformed, 1);
});

test("brief sensor is wired to Agent and Task PreToolUse hooks", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "hooks", "hooks.json"), "utf8"));
  const block = hooks.hooks.PreToolUse.find(({ matcher }) => matcher === "^(Agent|Task)$");

  assert.ok(block);
  assert.ok(block.hooks.some(({ command, timeout }) => timeout === 10 && command.endsWith('scripts/brief-sensor.mjs"')));
});
