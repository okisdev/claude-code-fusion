import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { GO_API_BASE_URL, readModels, readQuota, quotaPools } from "../plugins/opencode/scripts/lib/opencode-provider.mjs";
import { goApiModels, goApiUsage, goModels, goUsage, sandbox } from "./lib/opencode-harness.mjs";

test("models filters tool support, uses the session header, and caches for exactly one hour", async (t) => {
  const box = sandbox(t);
  const calls = [];
  const options = { dataDir: box.dataDir, env: {}, sessionId: "job-123", now: 10000000, fetch: async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ data: goApiModels }) };
  } };
  const first = await readModels(options);
  assert.equal(first.source, "api");
  assert.deepEqual(first.models.map((model) => model.id), goModels.slice(0, 2).map((model) => model.id));
  assert.equal(calls[0].url, `${GO_API_BASE_URL}/models`);
  assert.equal(calls[0].init.headers["x-opencode-session"], "job-123");
  assert.equal((await readModels({ ...options, now: options.now + 3599999 })).source, "cache");
  assert.equal(calls.length, 1);
  assert.equal((await readModels({ ...options, now: options.now + 3600000 })).source, "api");
  assert.equal(calls.length, 2);
  await readModels({ ...options, now: options.now + 3600000, maxAgeMs: 0 });
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(box.dataDir, "models-cache.json"), "utf8")).models.length, 2);
});

test("quota maps the three included pools with rolling pacing unknown and calendar window pacing", () => {
  const pools = quotaPools(goUsage, Date.parse("2026-11-19T00:00:00Z"));
  assert.deepEqual(pools.map((pool) => pool.pool), ["opencode", "opencode", "opencode"]);
  assert.deepEqual(pools.map((pool) => pool.costClass), ["included", "included", "included"]);
  assert.deepEqual(pools.map((pool) => pool.usedPercent), [20, 75, 50]);
  assert.deepEqual(pools.map((pool) => pool.windowMinutes), [300, 10080, 43200]);
  assert.deepEqual(pools.map((pool) => pool.resetsAt), ["2026-11-19T04:00:00.000Z", "2026-11-23T00:00:00.000Z", "2026-12-01T00:00:00.000Z"]);
  assert.equal(pools[0].pacing, null);
  assert.ok(Math.abs(pools[1].pacing - 0.75 / (3 / 7)) < 1e-12);
  assert.ok(Math.abs(pools[2].pacing - 0.5 / (18 / 30)) < 1e-12);
  const unknown = quotaPools({ rolling: { percent: "20", resetsAt: "bad date" } });
  assert.equal(unknown[0].usedPercent, null);
  assert.equal(unknown[0].resetsAt, null);
  assert.equal(unknown[2].windowMinutes, null);
  assert.ok(unknown.every((pool) => pool.pacing === null));
  assert.equal(quotaPools({ monthly: { resetsAt: "2026-03-31T00:00:00Z" } })[2].windowMinutes, 31 * 1440);
});

test("usage requires a key, authenticates only the request, and caches quota for 60 seconds", async (t) => {
  const box = sandbox(t);
  let calls = 0;
  const options = { dataDir: box.dataDir, env: { OPENCODE_GO_API_KEY: "opencode-test-credential" }, now: Date.parse("2026-11-19T00:00:00Z"), sessionId: "job-usage", fetch: async (url, init) => {
    calls++;
    assert.equal(url, `${GO_API_BASE_URL}/usage`);
    assert.equal(init.headers["x-opencode-session"], "job-usage");
    assert.equal(init.headers.Authorization, "Bearer opencode-test-credential");
    return { ok: true, json: async () => goApiUsage };
  } };
  const missing = await readQuota({ ...options, env: {} });
  assert.equal(missing.available, false);
  assert.match(missing.note, /OPENCODE_GO_API_KEY/);
  assert.equal(calls, 0);
  const first = await readQuota(options);
  assert.equal(first.available, true);
  assert.equal(first.note, null);
  assert.equal((await readQuota({ ...options, now: options.now + 59999 })).observedAt, first.observedAt);
  assert.equal(calls, 1);
  assert.notEqual((await readQuota({ ...options, now: options.now + 60000 })).observedAt, first.observedAt);
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(path.join(box.dataDir, "quota-cache.json"), "utf8").includes("opencode-test-credential"), false);
  assert.equal((await readQuota({ ...options, env: {} })).available, false);
});

test("Go HTTP failures retain auth, quota, and rate limit kinds", async (t) => {
  for (const [status, failureKind] of [[401, "auth"], [403, "auth"], [402, "quota"], [429, "rate_limited"], [500, "error"]]) {
    const box = sandbox(t);
    await assert.rejects(readModels({ dataDir: box.dataDir, env: {}, fetch: async () => ({ ok: false, status }) }), { failureKind });
  }
});

test("invalid provider metadata and network failures never populate a cache", async (t) => {
  const box = sandbox(t);
  for (const body of [{}, { data: [] }, { data: [{ ...goApiModels[0], limit: {} }] }]) {
    await assert.rejects(readModels({ dataDir: box.dataDir, env: {}, fetch: async () => ({ ok: true, json: async () => body }) }), { failureKind: "setup" });
  }
  await assert.rejects(readModels({ dataDir: box.dataDir, env: {}, fetch: async () => { throw new Error("sensitive request details"); } }), { failureKind: "network", message: "OpenCode Go request failed." });
  assert.equal(fs.existsSync(path.join(box.dataDir, "models-cache.json")), false);
});
