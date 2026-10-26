import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { newestEngineCompanion, recordEngineAcceptance } from "../plugins/fusion/scripts/lib/engine-acceptance.mjs";
import { settleQueuedVerdict } from "../plugins/fusion/scripts/lib/lifecycle/collection.mjs";
import { createWorkerRecord, recordWorkerAcceptance } from "../plugins/fusion/scripts/lib/worker-state.mjs";

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-acceptance-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function companion(root, source) {
  const file = path.join(root, "codex-companion.mjs");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, source);
  return file;
}

function cachedCompanion(home, version, modifiedAt) {
  const file = companion(path.join(home, ".claude", "plugins", "cache", "claude-code-fusion", "codex", version, "scripts"), "export {};\n");
  fs.utimesSync(file, modifiedAt, modifiedAt);
  return file;
}

test("record acceptance survives a removed workspace", (t) => {
  const root = sandbox(t);
  const workspaceRoot = path.join(root, "removed-worktree");
  const ledger = path.join(root, "ledger.json");
  const bin = companion(path.join(root, "companion"), 'import fs from "node:fs";\nfs.writeFileSync(process.env.TEST_LEDGER, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n');
  fs.mkdirSync(workspaceRoot);
  fs.rmdirSync(workspaceRoot);

  const result = recordEngineAcceptance({ engine: "codex", jobId: "a".repeat(32), acceptance: "accepted", workspaceRoot, env: { ...process.env, FUSION_CODEX_COMPANION: bin, TEST_LEDGER: ledger } });

  assert.deepEqual(result, { updated: true });
  const written = JSON.parse(fs.readFileSync(ledger, "utf8"));
  assert.equal(written.cwd, fs.realpathSync(path.dirname(bin)));
  assert.deepEqual(written.args.slice(0, 5), ["record-acceptance", "--job-id", "a".repeat(32), "--acceptance", "accepted"]);
});

test("a spawn error reports its own cause", (t) => {
  const root = sandbox(t);
  const bin = companion(path.join(root, "companion"), "export {};\n");

  assert.throws(
    () => recordEngineAcceptance({ engine: "codex", jobId: "a".repeat(32), acceptance: "accepted", env: { ...process.env, FUSION_CODEX_COMPANION: bin, TEST_OVERSIZED_ENV: "x".repeat(4_000_000) } }),
    (error) => error.code === "E2BIG" && !/Upgrade the Codex plugin/.test(error.message)
  );
});

test("matching fusion version wins, then highest semantic version wins", (t) => {
  const root = sandbox(t);
  const home = path.join(root, "home");
  const current = JSON.parse(fs.readFileSync(new URL("../plugins/fusion/.claude-plugin/plugin.json", import.meta.url), "utf8")).version;
  const older = cachedCompanion(home, "0.0.9", new Date("2026-10-03"));
  const newer = cachedCompanion(home, "0.0.10", new Date("2026-10-01"));
  cachedCompanion(home, "0.0.10-beta.1", new Date("2026-10-04"));

  assert.equal(newestEngineCompanion("codex", { HOME: home }), newer);
  const matching = cachedCompanion(home, current, new Date("2026-09-01"));
  assert.equal(newestEngineCompanion("codex", { HOME: home }), matching);
  assert.equal(newestEngineCompanion("codex", { HOME: home, FUSION_CODEX_COMPANION: older }), older);
});

test("queued accepted verdict enables failed transport for a salvaged timeout", (t) => {
  const root = sandbox(t);
  const workspaceRoot = path.join(root, "worktree");
  const stateRoot = path.join(root, "codex-state");
  const jobId = "b".repeat(32);
  const taskId = `fusion-${"c".repeat(24)}`;
  const calls = path.join(root, "calls.json");
  const bin = companion(path.join(root, "companion"), 'import fs from "node:fs";\nconst args = process.argv.slice(2);\nfs.writeFileSync(process.env.TEST_CALLS, JSON.stringify(args));\nif (!args.includes("--accept-failed-transport")) { process.stderr.write("has transport status error. Pass --accept-failed-transport"); process.exitCode = 1; }\n');
  const jobFile = path.join(stateRoot, "retained-workspace", "jobs", `${jobId}.json`);
  fs.mkdirSync(path.dirname(jobFile), { recursive: true });
  fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, workspaceRoot, status: "error", failureKind: "timeout" }));
  fs.mkdirSync(workspaceRoot);
  const env = { ...process.env, FUSION_WORKER_STATE_DIR: path.join(root, "workers"), FUSION_CODEX_STATE: stateRoot, FUSION_CODEX_COMPANION: bin, TEST_CALLS: calls };
  createWorkerRecord({ taskId, sessionId: "session-1", agentType: "codex:codex-rescue", workspaceRoot }, env);
  const queued = recordWorkerAcceptance({ taskId, acceptance: "accepted", source: "main-loop", env });
  assert.equal(queued.queued, true);
  fs.rmdirSync(workspaceRoot);

  const settled = settleQueuedVerdict({ ...queued.record, transportStatus: "done", peerEngine: "codex", peerJobId: jobId }, new Date().toISOString(), env);

  assert.equal(settled.acceptance, "accepted");
  assert.equal(settled.engineSettlementError, undefined);
  assert.ok(JSON.parse(fs.readFileSync(calls, "utf8")).includes("--accept-failed-transport"));
});
