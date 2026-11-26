import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
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
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    if (["darwin", "freebsd", "openbsd"].includes(process.platform)) {
      fs.writeFileSync(path.join(bin, "ps"), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-p" ]; then printf "process-%s\\n" "$2"; exit 0; fi; shift; done\n', { mode: 0o755 });
      fs.writeFileSync(path.join(bin, "sysctl"), '#!/bin/sh\nprintf "{ sec = 1, usec = 0 }\\n"\n', { mode: 0o755 });
      fs.writeFileSync(path.join(bin, "uptime"), '#!/bin/sh\nprintf "boot-marker\\n"\n', { mode: 0o755 });
    }
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: root, [`${engine.toUpperCase()}_COMPANION_DATA`]: data };
    const run = (args) => spawnSync(process.execPath, [companion, ...args], { env, cwd: root, encoding: "utf8", timeout: 5000 });
    return { root, id, record, file, env, run };
  }

  async function startWatch(t, box, entrypoint = companion) {
    const pollMs = 25;
    const preload = path.join(box.root, "watch-poll.cjs");
    fs.writeFileSync(preload, `
const setTimeout = global.setTimeout;
global.setTimeout = (callback, delay, ...args) => {
  const timer = setTimeout(callback, delay, ...args);
  if (delay === ${pollMs}) {
    global.setTimeout = setTimeout;
    process.send("watch-poll");
  }
  return timer;
};
`);
    box.env[`${engine.toUpperCase()}_COMPANION_WATCH_POLL_MS`] = String(pollMs);
    const child = fork(entrypoint, ["watch", "--job", box.id], {
      env: box.env, cwd: box.root, execArgv: ["--require", preload], silent: true
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const output = { stdout: "", stderr: "" };
    child.stdout.on("data", (chunk) => { output.stdout += chunk; });
    child.stderr.on("data", (chunk) => { output.stderr += chunk; });
    const closed = once(child, "close");
    const ready = await Promise.race([
      once(child, "message").then(([message]) => message),
      closed.then(() => null),
    ]);
    assert.equal(ready, "watch-poll", output.stderr);
    assert.equal(output.stdout, "");
    assert.equal(output.stderr, "");
    assert.equal(child.exitCode, null);
    return { closed, output };
  }

  function replaceRecord(box, patch) {
    const pending = `${box.file}.tmp`;
    fs.writeFileSync(pending, JSON.stringify({ ...box.record, ...patch }));
    fs.renameSync(pending, box.file);
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

  test(`${engine} watch reconciles an orphan before announcing it without collecting`, async (t) => {
    const box = await fixture(t, "running");
    fs.writeFileSync(box.file, JSON.stringify({ ...box.record, createdAt: new Date(Date.now() - 60_000).toISOString() }));
    const result = box.run(["watch", "--job", box.id]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^${engine} job ${box.id} orphaned \\(died\\).* /${engine}:result ${box.id}.* /${engine}:cancel ${box.id}`));
    assert.equal(result.stdout.trim().split("\n").length, 1);
    const reconciled = JSON.parse(fs.readFileSync(box.file, "utf8"));
    assert.equal(reconciled.status, "error");
    assert.equal(reconciled.failureKind, "died");
    assert.equal(reconciled.deliveryCollectedAt, null);
  });

  test(`${engine} watch exits when orphan cleanup cannot verify a surviving process`, async (t) => {
    const box = await fixture(t, "running");
    fs.writeFileSync(box.file, JSON.stringify({
      ...box.record, createdAt: new Date(Date.now() - 60_000).toISOString(),
      pid: 2147483647, pidIdentity: null, [`${engine}Pid`]: process.pid, [`${engine}PidIdentity`]: null
    }));
    const result = box.run(["watch", "--job", box.id]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^${engine} job ${box.id} cleanup required.* /${engine}:result ${box.id}.* /${engine}:cancel ${box.id}`));
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(fs.readFileSync(box.file, "utf8")).status, "running");
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  });

  test(`${engine} watch identifies an expired orphan even when reconciliation completes cleanup`, async (t) => {
    const box = await fixture(t, "running");
    fs.writeFileSync(box.file, JSON.stringify({ ...box.record, createdAt: new Date(Date.now() - 120_000).toISOString(), deadlineAt: new Date(Date.now() - 60_000).toISOString() }));
    const result = box.run(["watch", "--job", box.id]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^${engine} job ${box.id} orphaned.* /${engine}:result ${box.id}.* /${engine}:cancel ${box.id}`));
    assert.equal(JSON.parse(fs.readFileSync(box.file, "utf8")).status, "error");
    assert.equal(JSON.parse(fs.readFileSync(box.file, "utf8")).deliveryCollectedAt, null);
  });

  test(`${engine} watch exits after a recorded deadline plus grace even while reconciliation leaves it running`, async (t) => {
    const box = await fixture(t, "running");
    fs.writeFileSync(box.file, JSON.stringify({ ...box.record, deadlineAt: new Date(Date.now() - 60_000).toISOString(), pid: process.pid, pidIdentity: null }));
    const result = box.run(["watch", "--job", box.id]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^${engine} job ${box.id} cleanup required.* /${engine}:result ${box.id}.* /${engine}:cancel ${box.id}`));
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(fs.readFileSync(box.file, "utf8")).status, "running");
  });

  test(`${engine} watch announces still running and exits before its Monitor can expire`, async (t) => {
    const box = await fixture(t, "running");
    box.env[`${engine.toUpperCase()}_COMPANION_WATCH_MAX_MS`] = "75";
    box.env[`${engine.toUpperCase()}_COMPANION_WATCH_POLL_MS`] = "10";
    const result = box.run(["watch", "--job", box.id]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^${engine} job ${box.id} still running.*re-arm the same watch command`));
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(fs.readFileSync(box.file, "utf8")).deliveryCollectedAt, null);
  });

  test(`${engine} watch reconciles liveness again after an initially live poll`, { timeout: 5000 }, async (t) => {
    const box = await fixture(t, "running");
    const { closed, output } = await startWatch(t, box);
    replaceRecord(box, { createdAt: new Date(Date.now() - 60_000).toISOString() });
    const [code, signal] = await closed;
    assert.equal(code, 0, output.stderr);
    assert.equal(signal, null);
    assert.match(output.stdout, new RegExp(`^${engine} job ${box.id} orphaned \\(died\\).* /${engine}:result ${box.id}`));
    assert.equal(JSON.parse(fs.readFileSync(box.file, "utf8")).status, "error");
  });

  test(`${engine} watch receipts request the background budget plus margin capped at 30 minutes and explain re-arming`, async () => {
    const { backgroundWatchReceipt } = await import(new URL(`../../plugins/${engine}/scripts/lib/job-watch.mjs`, import.meta.url));
    const prefix = `${engine.toUpperCase()}_COMPANION_`;
    const receipt = backgroundWatchReceipt(engine, "a".repeat(32), { [`${prefix}${engine === "codex" ? "BACKGROUND_TIMEOUT_MS" : "TIMEOUT_MS"}`]: "120000" });
    assert.equal(receipt.watchDurationSeconds, 180);
    assert.match(receipt.watchInstruction, /duration of 180 seconds/);
    assert.match(receipt.watchInstruction, /Monitor deadline notice.*before the completion line.*re-arm the same watch command/);
    const defaults = backgroundWatchReceipt(engine, "a".repeat(32), {});
    assert.equal(defaults.watchDurationSeconds, ["codex", "grok"].includes(engine) ? 1800 : 600);
    const capped = backgroundWatchReceipt(engine, "a".repeat(32), { [`${prefix}${engine === "codex" ? "BACKGROUND_TIMEOUT_MS" : "TIMEOUT_MS"}`]: "3600000" });
    assert.equal(capped.watchDurationSeconds, 1800);
  });

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
    const { closed, output } = await startWatch(t, box, installedCompanion);
    fs.rmSync(installation, { recursive: true });
    replaceRecord(box, { status: "done", finishedAt: new Date().toISOString() });
    const [code, signal] = await closed;
    assert.equal(code, 0, output.stderr);
    assert.equal(signal, null);
    assert.equal(output.stdout, `${engine} job ${box.id} done. collect with /${engine}:result ${box.id}; completion notices do not replace collection.\n`);
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
