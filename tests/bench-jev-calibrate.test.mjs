import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "bench", "jev", "calibrate.mjs");
const briefs = JSON.parse(fs.readFileSync(path.join(repoRoot, "bench", "jev", "briefs.json"), "utf8"));
const pinnedModel = "jev-1.13.0";

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function startServer(t, responder) {
  const requests = [];
  const errors = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
    }
    try {
      const body = JSON.parse(raw);
      requests.push(body);
      await responder(body, response);
    } catch (error) {
      errors.push(error);
      if (!response.headersSent) {
        response.writeHead(500);
        response.end();
      } else {
        response.destroy();
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(() => closeServer(server));
  const { port } = server.address();
  return { endpoint: `http://127.0.0.1:${port}`, requests, errors };
}

function envFor(endpoint, { key = true } = {}) {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  delete env.FUSION_JEV_ENDPOINT;
  delete env.GROK_COMPANION_DATA;
  delete env.FUSION_CODEX_STATE;
  delete env.FUSION_CODEX_STATE_DIR;
  delete env.CODEX_COMPANION_DATA;
  if (key) {
    env.TYPESAFE_API_KEY = "test-key";
  }
  env.FUSION_JEV_ENDPOINT = endpoint;
  return env;
}

function runCalibration(args, env, { cwd = repoRoot } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
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
    child.stdin.end();
  });
}

function sendAnswers(response, answers) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ answers }));
}

function fixtureResponder(score) {
  return (body, response) => {
    const fixture = briefs.find(({ brief }) => brief === body.state);
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: score(id, fixture) }]));
    sendAnswers(response, answers);
  };
}

function assertSuccessfulFixtureRequests(server, model) {
  assert.deepStrictEqual(server.errors, []);
  assert.strictEqual(server.requests.length, briefs.length);
  assert.ok(server.requests.every(({ model: requestModel }) => requestModel === model));
  assert.ok(server.requests.every(({ state }) => briefs.some((fixture) => fixture.brief === state)));
}

test("calibration passes with fixture-specific answers", async (t) => {
  const server = await startServer(t, fixtureResponder((id, fixture) => id === fixture?.label ? 0.9 : 0.05));
  const result = await runCalibration([], envFor(server.endpoint));

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.signal, null);
  assert.match(result.stdout, /calibration holds/);
  const fixtureLines = result.stdout.split("\n").filter((line) => briefs.some(({ label }) => line.startsWith(label.padEnd(15))));
  assert.strictEqual(fixtureLines.length, briefs.length);
  assertSuccessfulFixtureRequests(server, pinnedModel);
});

test("calibration sends the requested model", async (t) => {
  const model = "jev-9.9.9";
  const server = await startServer(t, fixtureResponder((id, fixture) => id === fixture?.label ? 0.9 : 0.05));
  const result = await runCalibration(["--model", model], envFor(server.endpoint));

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.signal, null);
  assert.strictEqual(result.stdout.split("\n", 1)[0], `model ${model}, threshold 0.7, pinned ${pinnedModel}`);
  assertSuccessfulFixtureRequests(server, model);
});

test("calibration reports missed non-clean fixtures", async (t) => {
  const server = await startServer(t, fixtureResponder(() => 0.05));
  const result = await runCalibration([], envFor(server.endpoint));
  const expectedFailures = briefs.filter(({ label }) => label !== "clean").length;

  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, new RegExp(`calibration failed on ${expectedFailures} of ${briefs.length} fixtures`));
  assert.match(result.stdout, /missed at/);
});

test("calibration reports false positives", async (t) => {
  const server = await startServer(t, fixtureResponder(() => 0.9));
  const result = await runCalibration([], envFor(server.endpoint));

  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /false positive/);
});

test("calibration reports unavailable answers", async (t) => {
  const server = await startServer(t, (_body, response) => {
    response.writeHead(500);
    response.end();
  });
  const result = await runCalibration([], envFor(server.endpoint));

  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /no answer/);
});

test("calibration exits before requesting without an API key", async (t) => {
  const server = await startServer(t, (_body, response) => sendAnswers(response, {}));
  const result = await runCalibration([], envFor(server.endpoint, { key: false }));

  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /TYPESAFE_API_KEY is not set\./);
  assert.strictEqual(server.requests.length, 0);
});

test("calibration rejects unknown flags before requesting", async (t) => {
  const server = await startServer(t, (_body, response) => sendAnswers(response, {}));
  const result = await runCalibration(["--bogus"], envFor(server.endpoint, { key: false }));

  assert.notStrictEqual(result.status, 0);
  assert.strictEqual(server.requests.length, 0);
});

function retainedSandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bench-jev-retained-"));
  const grokData = path.join(directory, "grok-data");
  const grokState = path.join(grokData, "state");
  const codexState = path.join(directory, "codex-state");
  fs.mkdirSync(grokState, { recursive: true });
  fs.mkdirSync(codexState, { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, grokData, grokState, codexState };
}

function writeRetainedRecord(stateRoot, record, brief) {
  const workspaceRoot = path.join(stateRoot, "workspace");
  fs.mkdirSync(path.join(workspaceRoot, "jobs"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "briefs"), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "jobs", `${record.id}.json`), JSON.stringify(record));
  fs.writeFileSync(path.join(workspaceRoot, "briefs", `${record.id}.md`), brief);
}

function retainedBrief(marker, length, prefix = "") {
  const content = `${prefix}${marker}`;
  return content + "x".repeat(length - content.length);
}

function retainedEnv(endpoint, sandbox) {
  const env = envFor(endpoint);
  env.GROK_COMPANION_DATA = sandbox.grokData;
  env.FUSION_CODEX_STATE = sandbox.codexState;
  return env;
}

test("retained calibration scopes accepted briefs to in-repository records", async (t) => {
  const sandbox = retainedSandbox(t);
  const foreignCwd = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-sibling`);
  writeRetainedRecord(sandbox.grokState, { id: "a".repeat(32), cwd: repoRoot, status: "done", semanticStatus: "accepted" }, retainedBrief("RETAINED-IN-SCOPE", 300));
  writeRetainedRecord(sandbox.grokState, { id: "b".repeat(32), cwd: foreignCwd, status: "done", semanticStatus: "accepted" }, retainedBrief("RETAINED-FOREIGN", 300));
  writeRetainedRecord(sandbox.grokState, { id: "c".repeat(32), cwd: repoRoot, status: "done", semanticStatus: "accepted" }, retainedBrief("RETAINED-REVIEW", 300, "<role>"));
  writeRetainedRecord(sandbox.grokState, { id: "d".repeat(32), cwd: repoRoot, status: "done", semanticStatus: "accepted" }, retainedBrief("RETAINED-SHORT", 50));
  const server = await startServer(t, fixtureResponder((id, fixture) => id === fixture?.label ? 0.9 : 0.05));
  const result = await runCalibration(["--retained"], retainedEnv(server.endpoint, sandbox), { cwd: sandbox.directory });

  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.signal, null);
  assert.deepStrictEqual(server.errors, []);
  assert.strictEqual(server.requests.length, briefs.length + 1);
  assert.strictEqual(server.requests.filter(({ state }) => state.includes("RETAINED-IN-SCOPE")).length, 1);
  assert.ok(server.requests.every(({ state }) => !state.includes("RETAINED-FOREIGN")));
  assert.ok(server.requests.every(({ state }) => !state.includes("RETAINED-REVIEW")));
  assert.ok(server.requests.every(({ state }) => !state.includes("RETAINED-SHORT")));
  assert.match(result.stdout, /retained accepted briefs: 1 scored, 0 unanswered, 0 flagged/);
});

test("retained calibration does not send non-accepted records", async (t) => {
  const sandbox = retainedSandbox(t);
  writeRetainedRecord(sandbox.grokState, { id: "e".repeat(32), cwd: repoRoot, status: "done", semanticStatus: "rejected" }, retainedBrief("RETAINED-REJECTED", 300));
  writeRetainedRecord(sandbox.grokState, { id: "f".repeat(32), cwd: repoRoot, status: "error", semanticStatus: "accepted" }, retainedBrief("RETAINED-ERROR", 300));
  const server = await startServer(t, fixtureResponder((id, fixture) => id === fixture?.label ? 0.9 : 0.05));
  const result = await runCalibration(["--retained"], retainedEnv(server.endpoint, sandbox), { cwd: sandbox.directory });

  assert.strictEqual(result.status, 0);
  assertSuccessfulFixtureRequests(server, pinnedModel);
  assert.match(result.stdout, /retained accepted briefs: 0 scored, 0 unanswered, 0 flagged/);
});

test("retained calibration reports flagged Codex briefs without failing", async (t) => {
  const sandbox = retainedSandbox(t);
  const id = "1".repeat(32);
  const marker = "RETAINED-FLAGGED";
  writeRetainedRecord(sandbox.codexState, { id, workspaceRoot: repoRoot, status: "done", semanticStatus: "accepted" }, retainedBrief(marker, 300));
  const server = await startServer(t, (body, response) => {
    const fixture = briefs.find(({ brief }) => brief === body.state);
    const retained = body.state.includes(marker);
    const answers = Object.fromEntries(Object.keys(body.questions).map((questionId) => [questionId, { type: "noul", noul: retained || questionId === fixture?.label ? 0.9 : 0.05 }]));
    sendAnswers(response, answers);
  });
  const result = await runCalibration(["--retained"], retainedEnv(server.endpoint, sandbox), { cwd: sandbox.directory });

  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /retained accepted briefs: 1 scored, 0 unanswered, 1 flagged/);
  assert.ok(result.stdout.includes(id.slice(0, 8)));
});

test("retained calibration counts unavailable answers", async (t) => {
  const sandbox = retainedSandbox(t);
  const marker = "RETAINED-UNANSWERED";
  writeRetainedRecord(sandbox.grokState, { id: "2".repeat(32), cwd: repoRoot, status: "done", semanticStatus: "accepted" }, retainedBrief(marker, 300));
  const fixtureResponderForTest = fixtureResponder((id, fixture) => id === fixture?.label ? 0.9 : 0.05);
  const server = await startServer(t, (body, response) => {
    if (body.state.includes(marker)) {
      response.writeHead(500);
      response.end();
      return;
    }
    fixtureResponderForTest(body, response);
  });
  const result = await runCalibration(["--retained"], retainedEnv(server.endpoint, sandbox), { cwd: sandbox.directory });

  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /retained accepted briefs: 0 scored, 1 unanswered, 0 flagged/);
});
