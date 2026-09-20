import assert from "node:assert";
import http from "node:http";
import { test } from "node:test";

import { askJev } from "../plugins/fusion/scripts/lib/jev.mjs";

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

test("askJev is silent without a key", async (t) => {
  const server = await startServer(t, (_request, response) => response.end('{"answers":{}}'));

  assert.strictEqual(await askJev("state", {}, { env: envFor(server.endpoint, { key: false }) }), null);
  assert.strictEqual(server.requests.length, 0);
});

test("askJev sends the pinned model and returns answers", async (t) => {
  const expectedAnswers = { q: { type: "noul", noul: 0.9 } };
  const server = await startServer(t, (_request, response) => response.end(JSON.stringify({ answers: expectedAnswers })));
  const state = "A peer brief";
  const questions = { q: { type: "noul", instructions: "Is it ready?" } };

  assert.deepStrictEqual(await askJev(state, questions, { env: envFor(server.endpoint) }), expectedAnswers);
  assert.strictEqual(server.requests.length, 1);
  const [request] = server.requests;
  assert.strictEqual(request.method, "POST");
  assert.strictEqual(request.headers.authorization, "Bearer test-key");
  assert.strictEqual(request.headers["content-type"], "application/json");
  assert.deepStrictEqual(JSON.parse(request.body), { model: "jev-1.13.0", state, questions });
});

test("askJev sends a candidate model when one is given", async (t) => {
  const server = await startServer(t, (_request, response) => response.end('{"answers":{}}'));

  await askJev("state", {}, { env: envFor(server.endpoint), model: "jev-9.9.9" });
  assert.strictEqual(JSON.parse(server.requests[0].body).model, "jev-9.9.9");
});

test("askJev truncates state to 24000 characters", async (t) => {
  const server = await startServer(t, (_request, response) => response.end('{"answers":{}}'));

  await askJev("x".repeat(30_000), {}, { env: envFor(server.endpoint) });
  assert.strictEqual(JSON.parse(server.requests[0].body).state.length, 24_000);
});

test("askJev fails open for API status responses", async (t) => {
  for (const status of [401, 422, 429, 529]) {
    const server = await startServer(t, (_request, response) => {
      response.writeHead(status);
      response.end();
    });
    assert.strictEqual(await askJev("state", {}, { env: envFor(server.endpoint) }), null);
  }
});

test("askJev rejects malformed answer payloads", async (t) => {
  for (const body of ["not json", "{}", '{"answers":[]}']) {
    const server = await startServer(t, (_request, response) => response.end(body));
    assert.strictEqual(await askJev("state", {}, { env: envFor(server.endpoint) }), null);
  }
});

test("askJev fails open for a refused local connection", async (t) => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await closeServer(server);

  assert.strictEqual(await askJev("state", {}, { env: envFor(`http://127.0.0.1:${port}`) }), null);
});

test("askJev times out before a delayed response", async (t) => {
  const server = await startServer(t, (_request, response) => {
    const timer = setTimeout(() => response.end('{"answers":{}}'), 6_000);
    timer.unref();
  });
  const startedAt = performance.now();

  assert.strictEqual(await askJev("state", {}, { env: envFor(server.endpoint) }), null);
  assert.ok(performance.now() - startedAt < 5_500);
});
