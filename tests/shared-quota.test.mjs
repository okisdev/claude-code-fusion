import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const root = path.join(import.meta.dirname, "..");

test("shared companions print the quota fallback contract without running an engine", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shared-quota-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const engine of ["cursor", "agy"]) {
    const file = path.join(root, "plugins", engine, "scripts", `${engine}-companion.mjs`);
    const result = spawnSync(process.execPath, [file, "quota", "--json"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.ok(Number.isFinite(Date.parse(report.observedAt)));
    assert.deepEqual(report, { engine, available: false, observedAt: report.observedAt, pools: [], note: `quota telemetry not exposed by ${engine}` });
  }
});

test("the devin companion reports its free and metered pools through the shared quota command", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shared-quota-devin-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(root, "plugins", "devin", "scripts", "devin-companion.mjs");
  const result = spawnSync(process.execPath, [file, "quota", "--json"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.engine, "devin");
  assert.equal(report.available, true);
  assert.deepEqual(report.pools.map((pool) => [pool.pool, pool.costClass]), [["free", "free"], ["credits", "metered"]]);
});

test("shared quota calls the optional adapter with env and dataDir and tolerates errors", (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shared-quota-adapter-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "scripts"));
  fs.mkdirSync(path.join(home, ".claude-plugin"));
  fs.writeFileSync(path.join(home, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0" }));
  const file = path.join(home, "scripts", "companion.mjs");
  const commands = pathToFileURL(path.join(root, "shared", "companion", "companion-commands.mjs")).href;
  const report = { engine: "cursor", available: true, observedAt: "2026-11-20T00:00:00.000Z", pools: [], note: null };
  for (const fail of [false, true]) {
    fs.writeFileSync(file, `
import assert from "node:assert/strict";
import { createCompanionCommands } from ${JSON.stringify(commands)};
createCompanionCommands({ engine: "cursor", engineName: "Cursor", entryUrl: import.meta.url, state: { resolveDataDir: () => process.env.QUOTA_DATA, nowIso: () => new Date().toISOString() }, render: {}, quota: async ({ env, dataDir }) => {
  assert.equal(env.QUOTA_DATA, dataDir);
  assert.equal(dataDir, ${JSON.stringify(home)});
  if (${fail}) throw new Error("telemetry unavailable");
  return ${JSON.stringify(report)};
} }).run();
`);
    const result = spawnSync(process.execPath, [file, "quota", "--json"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, QUOTA_DATA: home } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    if (fail) {
      assert.equal(output.available, false);
      assert.deepEqual(output.pools, []);
      assert.match(output.note, /telemetry unavailable/);
    } else assert.deepEqual(output, report);
  }
});
