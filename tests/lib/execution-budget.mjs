import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function executionTimeoutProbe(root, maxTimeoutMs) {
  const file = path.join(root, "execution-timeouts.jsonl");
  const preload = path.join(root, "execution-timeouts.cjs");
  fs.writeFileSync(file, "");
  fs.writeFileSync(preload, `const fs = require("node:fs");
const original = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => {
  if (/^\\(\\)\\s*=>\\s*(?:handleRunTimeout|expireGrokRun)\\(/.test(String(callback))) {
    fs.appendFileSync(${JSON.stringify(file)}, JSON.stringify(delay) + "\\n");
    delay = Math.min(delay, ${maxTimeoutMs ?? "Infinity"});
  }
  return original(callback, delay, ...args);
};
`);
  return {
    env: { NODE_OPTIONS: `--require=${preload}` },
    timeouts: () => fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  };
}

async function workerExited(jobId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const found = spawnSync("pgrep", ["-f", `task-worker --job-id ${jobId}`], { encoding: "utf8" });
    if (found.status === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`background worker for ${jobId} did not exit`);
}

export async function verifyExecutionBudgets(t, { engine, createHarness, model, foregroundTimeoutMs, backgroundTimeoutMs = foregroundTimeoutMs }) {
  const timeoutEnv = `${engine.toUpperCase()}_COMPANION_TIMEOUT_MS`;
  const modelArgs = model ? ["--model", model] : [];
  for (const entry of [
    { name: "direct foreground", direct: true },
    { name: "staged foreground" },
    { name: "wrapper consult", shell: true },
    { name: "wrapper write", shell: true, write: true },
    { name: "explicit read only beats wrapper write", shell: true, write: true, rawOptions: "--write=false" },
    { name: "foreground override", override: "2400" },
    { name: "wrapper override", shell: true, override: "2400" },
    { name: "invalid wrapper override", shell: true, override: "invalid" },
    { name: "manual background keeps its budget", shell: true, rawOptions: "--background", background: true },
    { name: "prompt cannot request the wrapper budget", prompt: "inspect --transport-background-shell" }
  ]) {
    await t.test(entry.name, async (t) => {
      const h = createHarness(t, { [timeoutEnv]: entry.override ?? "" });
      const probe = executionTimeoutProbe(h.root ?? h.temp);
      Object.assign(h.env, probe.env);
      const prompt = entry.prompt ?? "inspect the budget";
      const raw = [...modelArgs, entry.rawOptions ?? "", "--", prompt].filter(Boolean).join(" ");
      let transport;
      if (!entry.direct) {
        const created = h.run(["transport-create"]);
        assert.equal(created.status, 0, created.stderr);
        transport = JSON.parse(created.stdout);
        fs.writeFileSync(transport.file, raw);
      }
      const args = entry.direct ? [...modelArgs, "--", prompt] : [
        ...(entry.write ? ["--transport-default-write"] : []),
        ...(entry.shell ? ["--transport-background-shell"] : []),
        "--raw-args-token", transport.token
      ];
      const result = h.run(["task", ...args]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const deadline = Date.now() + 10000;
      while (entry.background && h.jobs()[0]?.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const [record] = h.jobs();
      if (entry.background) await workerExited(record.id ?? record.jobId);
      assert.equal(record.status, "done");
      assert.equal(record.background, Boolean(entry.background));
      assert.equal(record.delivery, entry.background ? "manual" : "foreground");
      assert.equal(record.request.backgroundShellBudget, Boolean(entry.shell && !entry.background));
      assert.equal(record.mode, entry.write && !entry.rawOptions ? "write" : "consult");
      assert.equal(record.request.ingress, entry.direct ? "argv" : "staged_file");
      if (transport) assert.equal(fs.existsSync(transport.file), false);
      const expected = entry.override === "2400" ? 2400 : entry.background ? backgroundTimeoutMs : entry.shell ? 900000 : foregroundTimeoutMs;
      const timeouts = probe.timeouts();
      assert.equal(timeouts.length, 1);
      if (engine === "grok") {
        assert.ok(timeouts[0] > expected - 10000 && timeouts[0] <= expected, `Expected a ${expected}ms budget, got ${timeouts[0]}ms`);
      } else {
        assert.equal(timeouts[0], expected);
      }
    });
  }

  await t.test("wrapper flag requires a supported transport with exactly one token", (t) => {
    const h = createHarness(t, { [timeoutEnv]: "" });
    const created = h.run(["transport-create"]);
    assert.equal(created.status, 0, created.stderr);
    const transport = JSON.parse(created.stdout);
    fs.writeFileSync(transport.file, [...modelArgs, "--", "inspect"].join(" "));
    for (const args of [
      ["task", "--transport-background-shell", "inspect"],
      ["task", "--transport-background-shell", "--transport-default-write", "--raw-args-token", transport.token],
      ["task", "--transport-background-shell", "--transport-background-shell", "--raw-args-token", transport.token],
      ["task", "--transport-background-shell", "--raw-args-token", transport.token, "--json"],
      [engine === "grok" ? "review" : "status", "--transport-background-shell", "--raw-args-token", transport.token],
      ["review", "--transport-background-shell", "--raw-args-token", transport.token, "--json"]
    ]) {
      const result = h.run(args);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /failure: input|"failureKind": "input"/);
      assert.equal(h.jobs().length, 0);
      assert.equal(fs.existsSync(transport.file), true);
    }
    fs.writeFileSync(transport.file, "--transport-background-shell -- inspect");
    const result = h.run(["task", "--raw-args-token", transport.token]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /failure: input/);
    assert.equal(h.jobs().length, 0);
    assert.equal(fs.existsSync(transport.file), false);
  });
}
