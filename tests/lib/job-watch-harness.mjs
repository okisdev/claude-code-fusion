import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");

export function verifyJobWatch(engine) {
  const pluginRoot = path.join(repoRoot, "plugins", engine);
  const companion = path.join(pluginRoot, "scripts", `${engine}-companion.mjs`);
  const stateUrl = new URL(`../../plugins/${engine}/scripts/lib/state.mjs`, import.meta.url);

  async function fixture(t, status = "done") {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${engine}-watch-`)));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const data = path.join(root, "data");
    const state = await import(stateUrl.href);
    const id = "a".repeat(32);
    const record = {
      ...state.createJobRecord({ id, status, mode: "consult", cwd: root, briefFile: path.join(root, "brief.md"), background: true }),
      status,
      ...(status !== "running" ? { finishedAt: new Date().toISOString() } : {}),
      failureKind: status === "error" ? "timeout" : status === "cancelled" ? "cancelled" : null
    };
    const file = state.jobFilePath(data, root, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record));
    const env = { PATH: process.env.PATH, HOME: root, [`${engine.toUpperCase()}_COMPANION_DATA`]: data };
    const run = (args) => spawnSync(process.execPath, [companion, ...args], { env, cwd: root, encoding: "utf8", timeout: 5000 });
    return { root, id, record, file, env, run };
  }

  for (const status of ["done", "error", "cancelled"]) {
    test(`${engine} watch announces ${status} once, exits zero, and leaves collection pending`, async (t) => {
      const box = await fixture(t, status);
      const result = box.run(["watch", "--job", box.id]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const failure = box.record.failureKind ? ` (${box.record.failureKind})` : "";
      assert.equal(result.stdout, `${engine} job ${box.id} ${status}${failure}. collect with /${engine}:result ${box.id}; completion notices do not replace collection.\n`);
      assert.equal(JSON.parse(fs.readFileSync(box.file, "utf8")).deliveryCollectedAt, null);
    });
  }

  test(`${engine} watch rejects unknown ids and unsafe command arguments`, async (t) => {
    const box = await fixture(t);
    const missing = box.run(["watch", "--job", "b".repeat(32)]);
    assert.notEqual(missing.status, 0);
    assert.equal(missing.stdout, "");
    assert.match(missing.stderr, /No job record found/);
    for (const args of [[], [box.id], ["--job", "$(touch unsafe)"], ["--job", box.id, "--job", box.id], ["--job", box.id, "--json"]]) {
      const result = box.run(["watch", ...args]);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /watch requires --job/);
    }
  });

  test(`${engine} watch stays silent while running and survives removal of its plugin installation`, { timeout: 25000 }, async (t) => {
    const box = await fixture(t, "running");
    const installation = path.join(box.root, "old-plugin");
    fs.cpSync(pluginRoot, installation, { recursive: true });
    const installedCompanion = path.join(installation, "scripts", `${engine}-companion.mjs`);
    const child = spawn(process.execPath, [installedCompanion, "watch", "--job", box.id], { env: box.env, cwd: box.root, stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const closed = once(child, "close");
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(stdout, "");
    assert.equal(stderr, "");
    assert.equal(child.exitCode, null);
    fs.rmSync(installation, { recursive: true });
    fs.writeFileSync(box.file, JSON.stringify({ ...box.record, status: "done", finishedAt: new Date().toISOString() }));
    const [code, signal] = await closed;
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
    assert.equal(stdout, `${engine} job ${box.id} done. collect with /${engine}:result ${box.id}; completion notices do not replace collection.\n`);
  });

  test(`${engine} manual receipts name the absolute watch command and managed receipts do not`, async () => {
    const render = await import(new URL(`../../plugins/${engine}/scripts/lib/render.mjs`, import.meta.url));
    const { backgroundWatchReceipt } = await import(new URL(`../../plugins/${engine}/scripts/lib/job-watch.mjs`, import.meta.url));
    const id = "a".repeat(32);
    const manual = engine === "codex" ? render.renderBackgroundLaunch({ id, cwd: repoRoot, delivery: "manual" }) : render.renderBackgroundLaunch(id, "manual", repoRoot);
    const expected = `node "${companion}" watch --job ${id}`;
    assert.ok(manual.includes(expected), manual);
    assert.match(manual, /main session.*one Claude Code Monitor tool watch/);
    assert.match(manual, new RegExp(`watch completion line is the cue to collect with /${engine}:result ${id}`));
    assert.equal(backgroundWatchReceipt(engine, id).watchCommand, expected);
    const managed = engine === "codex" ? render.renderBackgroundLaunch({ id, cwd: repoRoot, delivery: "managed" }) : render.renderBackgroundLaunch(id, "managed", repoRoot);
    assert.doesNotMatch(managed, /watch --job|Monitor tool/);
  });
}
