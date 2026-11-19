import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFusionStats, renderFusionStats } from "../plugins/fusion/scripts/fusion-stats.mjs";
import { appendModelAuditObservations, appendTokenUsageObservation, loadModelAuditObservations, loadTokenUsageObservations } from "../plugins/fusion/scripts/lib/stats/evidence.mjs";

test("fixture ledger keeps JSON and Markdown report bytes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-stats-modules-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, "codex-state");
  const jobs = path.join(state, "fixture", "jobs");
  fs.mkdirSync(jobs, { recursive: true });
  fs.writeFileSync(path.join(jobs, `${"a".repeat(32)}.json`), JSON.stringify({
    id: "a".repeat(32),
    workspaceRoot: "/fixture/workspace",
    status: "done",
    jobClass: "task",
    createdAt: "2026-08-01T00:00:00Z",
    startedAt: "2026-08-01T00:00:01Z",
    finishedAt: "2026-08-01T00:00:04Z",
    resolvedModel: "gpt-5",
    resolvedEffort: "high"
  }));
  const env = {
    HOME: path.join(dir, "home"),
    FUSION_DATA_DIR: path.join(dir, "fusion-data"),
    FUSION_WORKER_STATE_DIR: path.join(dir, "workers"),
    FUSION_INLINE_GUARD_AUDIT_DIR: path.join(dir, "audit"),
    FUSION_CODEX_STATE: state,
    FUSION_CODEX_STATE_DIR: path.join(dir, "codex-compat"),
    GROK_COMPANION_DATA: path.join(dir, "grok"),
    CURSOR_COMPANION_DATA: path.join(dir, "cursor"),
    CODEX_COMPANION_DATA: path.join(dir, "codex")
  };
  const report = buildFusionStats({ all: true, env, cwd: "/fixture/workspace" });
  assert.deepStrictEqual(report.verificationEvidence.recent, { days: 7, accepted: 0, evidenced: 0, rate: 0 });
  assert.deepStrictEqual(report.wrapperDelivery, []);
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  assert.equal(digest(JSON.stringify(report, null, 2) + "\n"), "098edcc8ad081d78406af060143eb9cf5dac80e25fde30c51d52d1ec387f5495");
  assert.equal(digest(renderFusionStats(report)), "4be44bf40d96006964e4c6fb4906ffe42479e12b83f83658ee89c9dffd066780");
});

test("evidence sidecars preserve live lock owners and release locks on merge errors", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-evidence-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const append of [
    (file) => appendModelAuditObservations(file, [{ jobId: "one", source: "argv", model: "a" }]),
    (file) => appendTokenUsageObservation(file, { jobId: "one", availability: "available" })
  ]) {
    const file = path.join(dir, "observations.jsonl");
    const lock = `${file}.lock`;
    fs.writeFileSync(lock, String(process.pid));
    const old = new Date(Date.now() - 31_000);
    fs.utimesSync(lock, old, old);
    assert.strictEqual(append(file), false);
    assert.strictEqual(fs.readFileSync(lock, "utf8"), String(process.pid));
    assert.strictEqual(fs.existsSync(file), false);
    fs.rmSync(lock);
  }
  const file = path.join(dir, "model-audit.jsonl");
  const failure = Object.assign(new Error("merge failed"), { code: "ETIMEDOUT" });
  assert.throws(() => appendModelAuditObservations(file, [{ jobId: "one", source: "argv" }], () => { throw failure; }), (error) => error === failure);
  assert.strictEqual(fs.existsSync(`${file}.lock`), false);
  assert.strictEqual(loadModelAuditObservations(file).size, 1);
});

test("failed evidence replacement preserves the sidecar and cleans temporary files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-evidence-atomic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "model-audit.jsonl");
  assert.strictEqual(appendModelAuditObservations(file, [{ jobId: "one", source: "argv", model: "original" }]), true);
  const original = fs.readFileSync(file, "utf8");
  const rename = t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("rename failed"), { code: "EIO" }); });
  try {
    assert.throws(() => appendModelAuditObservations(file, [{ jobId: "one", source: "rollout-turn-context", model: "replacement" }]), { code: "EIO" });
  } finally {
    rename.mock.restore();
  }
  assert.strictEqual(fs.readFileSync(file, "utf8"), original);
  assert.deepStrictEqual(fs.readdirSync(dir), ["model-audit.jsonl"]);
});

test("concurrent evidence writers preserve every job, model rank, and token deduplication", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-evidence-concurrent-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = `
    import assert from "node:assert/strict";
    import path from "node:path";
    import { appendModelAuditObservations, appendTokenUsageObservation } from ${JSON.stringify(new URL("../plugins/fusion/scripts/lib/stats/evidence.mjs", import.meta.url).href)};
    const [dir, worker] = process.argv.slice(1);
    const modelFile = path.join(dir, "model-audit.jsonl");
    const tokenFile = path.join(dir, "token-usage.jsonl");
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const retry = (operation) => {
      const deadline = performance.now() + 10_000;
      while (!operation()) {
        assert.ok(performance.now() < deadline, "evidence lock retry timed out");
        Atomics.wait(signal, 0, 0, 2);
      }
    };
    process.once("message", () => {
      for (let index = 0; index < 12; index += 1) {
        const jobId = worker + ":" + index;
        retry(() => appendModelAuditObservations(modelFile, [
          { jobId, source: "argv", model: jobId },
          { jobId: "shared", source: Number(worker) % 2 ? "argv" : "rollout-turn-context", model: Number(worker) % 2 ? "requested" : "resolved" }
        ], () => Atomics.wait(signal, 0, 0, 3)));
        retry(() => appendTokenUsageObservation(tokenFile, { jobId, availability: "available", observedAt: "2026-08-01T00:00:01.000Z" }));
        retry(() => appendTokenUsageObservation(tokenFile, { jobId: "shared", availability: Number(worker) % 2 ? "unavailable" : "available", observedAt: Number(worker) % 2 ? "2026-08-01T00:00:00.000Z" : "2026-08-01T00:00:01.000Z" }));
      }
      process.disconnect();
    });
    process.send("ready");
  `;
  const workers = Array.from({ length: 4 }, (_, index) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, dir, String(index)], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const ready = once(child, "message");
    const closed = once(child, "close").then(([status]) => ({ status, stderr }));
    t.after(() => { if (child.exitCode === null) child.kill(); });
    return { child, ready, closed };
  });
  await Promise.all(workers.map(({ ready }) => ready));
  for (const { child } of workers) child.send("start");
  for (const result of await Promise.all(workers.map(({ closed }) => closed))) {
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stderr, "");
  }
  const modelFile = path.join(dir, "model-audit.jsonl");
  const tokenFile = path.join(dir, "token-usage.jsonl");
  const models = loadModelAuditObservations(modelFile);
  const tokens = loadTokenUsageObservations(tokenFile);
  assert.strictEqual(models.size, 49);
  assert.strictEqual(tokens.size, 49);
  assert.strictEqual(models.get("shared").model, "resolved");
  assert.strictEqual(tokens.get("shared").availability, "available");
  for (let worker = 0; worker < 4; worker += 1) {
    for (let index = 0; index < 12; index += 1) {
      const jobId = `${worker}:${index}`;
      assert.strictEqual(models.get(jobId).model, jobId);
      assert.strictEqual(tokens.get(jobId).availability, "available");
    }
  }
  const modelLines = fs.readFileSync(modelFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const tokenLines = fs.readFileSync(tokenFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.strictEqual(modelLines.length, 49);
  assert.strictEqual(tokenLines.filter((entry) => entry.jobId !== "shared").length, 48);
  assert.strictEqual(tokenLines.filter((entry) => entry.jobId === "shared" && entry.availability === "available").length, 1);
  assert.ok(tokenLines.filter((entry) => entry.jobId === "shared").length <= 2);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ["model-audit.jsonl", "token-usage.jsonl"]);
  for (const file of [modelFile, tokenFile]) assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
});
