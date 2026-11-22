import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { GO_API_BASE_URL, opencodeAuthFile, readModels, readQuota, quotaPools, requireApiKey, resolveApiKey } from "../plugins/opencode/scripts/lib/opencode-provider.mjs";
import { goApiModels, goApiUsage, goModels, goUsage, sandbox } from "./lib/opencode-harness.mjs";

test("models filters tool support, uses the session header, and caches for exactly one hour", async (t) => {
  const box = sandbox(t);
  const calls = [];
  const options = { dataDir: box.dataDir, env: { HOME: box.root }, sessionId: "job-123", now: 10000000, fetch: async (url, init) => {
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
  const missing = await readQuota({ ...options, env: { HOME: box.root } });
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
  assert.equal((await readQuota({ ...options, env: { HOME: box.root } })).available, false);
});

test("Go HTTP failures retain auth, quota, and rate limit kinds", async (t) => {
  for (const [status, failureKind] of [[401, "auth"], [403, "auth"], [402, "quota"], [429, "rate_limited"], [500, "error"]]) {
    const box = sandbox(t);
    await assert.rejects(readModels({ dataDir: box.dataDir, env: { HOME: box.root }, fetch: async () => ({ ok: false, status }) }), { failureKind });
  }
});

test("invalid provider metadata and network failures never populate a cache", async (t) => {
  const box = sandbox(t);
  for (const body of [{}, { data: [] }, { data: [{ ...goApiModels[0], limit: {} }] }]) {
    await assert.rejects(readModels({ dataDir: box.dataDir, env: { HOME: box.root }, fetch: async () => ({ ok: true, json: async () => body }) }), { failureKind: "setup" });
  }
  await assert.rejects(readModels({ dataDir: box.dataDir, env: { HOME: box.root }, fetch: async () => { throw new Error("sensitive request details"); } }), { failureKind: "network", message: "OpenCode Go request failed." });
  assert.equal(fs.existsSync(path.join(box.dataDir, "models-cache.json")), false);
});

test("the key comes from the environment first, then the opencode auth login store", (t) => {
  const box = sandbox(t);
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); };
  const home = { HOME: box.root };
  assert.equal(opencodeAuthFile(home), path.join(box.root, ".local/share/opencode/auth.json"));
  assert.equal(opencodeAuthFile({ ...home, XDG_DATA_HOME: path.join(box.root, "xdg") }), path.join(box.root, "xdg/opencode/auth.json"));
  assert.equal(resolveApiKey(home), null);
  assert.throws(() => requireApiKey(home), { failureKind: "auth", message: /opencode auth login/ });
  write(opencodeAuthFile(home), { "opencode-go": { type: "api", key: " stored-credential " } });
  assert.equal(resolveApiKey(home), "stored-credential");
  assert.equal(resolveApiKey({ ...home, OPENCODE_GO_API_KEY: "env-credential" }), "env-credential");
  assert.equal(resolveApiKey({ ...home, OPENCODE_GO_API_KEY: "   " }), "stored-credential");
  const xdg = { ...home, XDG_DATA_HOME: path.join(box.root, "xdg") };
  assert.equal(resolveApiKey(xdg), null);
  write(opencodeAuthFile(xdg), { "opencode-go": { type: "api", key: "xdg-credential" } });
  assert.equal(resolveApiKey(xdg), "xdg-credential");
  for (const stored of [{ "opencode-go": { type: "oauth", access: "token" } }, { "opencode-go": { type: "api", key: "" } }, { opencode: { type: "api", key: "zen-credential" } }, "not json"]) {
    write(opencodeAuthFile(home), stored);
    assert.equal(resolveApiKey(home), null);
  }
});
