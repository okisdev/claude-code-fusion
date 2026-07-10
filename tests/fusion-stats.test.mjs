import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FILE_ENGINE_DESCRIPTORS,
  STATS_PROVIDER_REGISTRY,
  WORKSPACE_ENGINE_DESCRIPTORS,
  buildFusionStats,
  buildSessionReport,
  codexStats,
  fileBasedEngineStats,
  findDeadWorkspaces,
  pruneDeadWorkspaces,
  renderFusionStats,
  renderPruneReport,
  renderSessionReport
} from "../plugins/fusion/scripts/fusion-stats.mjs";
import { resolveStateDir as guardResolveStateDir, stateFile as guardStateFile } from "../plugins/fusion/scripts/inline-delegation-guard.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "fusion", "scripts", "fusion-stats.mjs");

function sandbox(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-stats-test-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let slugCounter = 0;

function writeCodexJob(stateRoot, workspaceRoot, id, fields) {
  slugCounter += 1;
  const dir = path.join(stateRoot, `ws-${slugCounter}`, "jobs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, workspaceRoot, ...fields }));
}

function grokWorkspaceSlug(cwd) {
  const absolute = path.resolve(cwd);
  const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 16);
  return `${path.basename(absolute)}-${hash}`;
}

function writeGrokJob(dataDir, cwd, id, fields) {
  const dir = path.join(dataDir, "state", grokWorkspaceSlug(cwd), "jobs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, cwd, ...fields }));
}

function run(env, extraArgs = [], extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    cwd: env.cwd,
    encoding: "utf8",
    env: { ...process.env, FUSION_GROK_COMPANION: "/nonexistent/grok-companion.mjs", FUSION_CODEX_STATE: env.codexState, ...extraEnv }
  });
}

test("reports both engines unavailable when neither has data", (t) => {
  const dir = sandbox(t);
  const result = run({ cwd: dir, codexState: path.join(dir, "missing") });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /## Grok\n\nUnavailable:/);
  assert.match(result.stdout, /## Codex\n\nUnavailable:/);
});

test("aggregates codex job state scoped to the workspace", (t) => {
  const dir = sandbox(t);
  const stateRoot = path.join(dir, "state");
  writeCodexJob(stateRoot, dir, "task-a", {
    status: "completed",
    jobClass: "task",
    createdAt: "2026-07-02T06:00:00.000Z",
    startedAt: "2026-07-02T06:00:00.000Z",
    completedAt: "2026-07-02T06:00:10.000Z"
  });
  writeCodexJob(stateRoot, "/somewhere/else", "task-b", { status: "failed", jobClass: "task", createdAt: "2026-07-02T05:00:00.000Z" });

  const scoped = run({ cwd: dir, codexState: stateRoot }, ["--json"]);
  assert.strictEqual(scoped.status, 0, scoped.stderr);
  const scopedData = JSON.parse(scoped.stdout).codex;
  assert.strictEqual(scopedData.totalJobs, 1);
  assert.strictEqual(scopedData.byStatus.completed, 1);
  assert.strictEqual(scopedData.meanWallClockSeconds, 10);

  const all = run({ cwd: dir, codexState: stateRoot }, ["--all", "--json"]);
  const allData = JSON.parse(all.stdout).codex;
  assert.strictEqual(allData.totalJobs, 2);
  assert.strictEqual(allData.byStatus.failed, 1);
});

test("survives a malformed codex job file", (t) => {
  const dir = sandbox(t);
  const stateRoot = path.join(dir, "state");
  const jobsDir = path.join(stateRoot, "ws-broken", "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, "broken.json"), "{ not json");
  fs.writeFileSync(
    path.join(jobsDir, "task-ok.json"),
    JSON.stringify({ id: "task-ok", workspaceRoot: dir, status: "completed", jobClass: "review", createdAt: "2026-07-02T06:00:00.000Z" })
  );

  const result = run({ cwd: dir, codexState: stateRoot }, ["--json"]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(JSON.parse(result.stdout).codex.totalJobs, 1);
});

test("Aggregates available Grok companion stats into the merged output", (t) => {
  const dir = sandbox(t);
  const dataDir = path.join(dir, "grok-data");
  const companion = path.join(path.dirname(SCRIPT), "..", "..", "grok", "scripts", "grok-companion.mjs");
  writeGrokJob(dataDir, dir, "grok-a", {
    status: "done",
    mode: "consult",
    createdAt: "2026-07-04T00:00:00.000Z",
    finishedAt: "2026-07-04T00:00:05.000Z"
  });
  writeGrokJob(dataDir, dir, "grok-b", {
    status: "error",
    mode: "write",
    failureKind: "quota",
    createdAt: "2026-07-04T00:01:00.000Z",
    finishedAt: "2026-07-04T00:01:03.000Z"
  });

  const result = run(
    { cwd: dir, codexState: path.join(dir, "missing-codex") },
    ["--json"],
    { FUSION_GROK_COMPANION: companion, GROK_COMPANION_DATA: dataDir }
  );
  assert.strictEqual(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.strictEqual(data.grok.available, true);
  assert.strictEqual(data.grok.totalJobs, 2);
  assert.deepStrictEqual(data.grok.byStatus, { done: 1, error: 1 });
  assert.deepStrictEqual(data.grok.byMode, { consult: 1, write: 1 });
  assert.deepStrictEqual(data.grok.byFailureKind, { quota: 1 });
});

test("file-based engine stats use the descriptor registry", () => {
  assert.ok(FILE_ENGINE_DESCRIPTORS.codex);
  assert.strictEqual(FILE_ENGINE_DESCRIPTORS.codex.stateEnvVar, "FUSION_CODEX_STATE");
  assert.strictEqual(typeof fileBasedEngineStats, "function");
});

test("codexStats matches fileBasedEngineStats with the codex descriptor", (t) => {
  const dir = sandbox(t);
  const stateRoot = path.join(dir, "state");
  writeCodexJob(stateRoot, dir, "via-wrapper", {
    status: "completed",
    jobClass: "task",
    createdAt: "2026-07-02T06:00:00.000Z",
    startedAt: "2026-07-02T06:00:00.000Z",
    completedAt: "2026-07-02T06:00:05.000Z"
  });
  const env = { FUSION_CODEX_STATE: stateRoot };
  const viaCodex = codexStats({ env, cwd: dir });
  const viaDescriptor = fileBasedEngineStats(FILE_ENGINE_DESCRIPTORS.codex, { env, cwd: dir });
  assert.deepStrictEqual(viaCodex, viaDescriptor);
});

test("report sections follow the stats provider registry order", (t) => {
  const saved = STATS_PROVIDER_REGISTRY.slice();
  t.after(() => {
    STATS_PROVIDER_REGISTRY.length = 0;
    STATS_PROVIDER_REGISTRY.push(...saved);
  });
  STATS_PROVIDER_REGISTRY.length = 0;
  STATS_PROVIDER_REGISTRY.push({
    id: "stub",
    displayName: "StubEngine",
    collect: () => ({ available: false, reason: "stub unavailable" })
  });
  const report = buildFusionStats({ cwd: "/tmp/stub-scope", env: process.env });
  const text = renderFusionStats(report);
  assert.match(text, /## StubEngine\n\nUnavailable: stub unavailable/);
  assert.doesNotMatch(text, /## Grok/);
});

function writeGuardState(guardStateDir, sessionId, state) {
  const file = guardStateFile(guardStateDir, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

function sessionRunEnv(dir, extra = {}) {
  return run({ cwd: dir, codexState: path.join(dir, "missing-codex") }, extra.args ?? [], {
    GROK_COMPANION_DATA: path.join(dir, "missing-grok"),
    ...extra.env
  });
}

test("--session prints a clean line when no guard state is recorded", (t) => {
  const dir = sandbox(t);
  const result = sessionRunEnv(dir, { args: ["--session"], env: { CLAUDE_CODE_SESSION_ID: "" } });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /no dispatches recorded/);
});

test("--session reports the seeded lane counters for the current session", (t) => {
  const dir = sandbox(t);
  const guardStateDir = path.join(dir, "guard-state");
  writeGuardState(guardStateDir, "session-abc", {
    writeCount: 7,
    dispatches: { grok: 2, "fusion:fast-worker": 1 },
    advisedMultiples: [1],
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:05.000Z"
  });

  const result = sessionRunEnv(dir, {
    args: ["--session", "--json"],
    env: { CLAUDE_CODE_SESSION_ID: "session-abc", FUSION_INLINE_GUARD_STATE: guardStateDir }
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.strictEqual(data.sessionId, "session-abc");
  assert.strictEqual(data.guard.writeCount, 7);
  assert.deepStrictEqual(data.guard.dispatches, { grok: 2, "fusion:fast-worker": 1 });
});

test("--session scopes per-engine job counts to the current session where available", (t) => {
  const dir = sandbox(t);
  const codexState = path.join(dir, "codex-state");
  writeCodexJob(codexState, dir, "own-job", { status: "completed", jobClass: "task", sessionId: "session-abc", createdAt: "2026-07-02T06:00:00.000Z" });
  writeCodexJob(codexState, dir, "other-job", { status: "completed", jobClass: "task", sessionId: "session-xyz", createdAt: "2026-07-02T06:00:00.000Z" });

  const grokDataDir = path.join(dir, "grok-data");
  writeGrokJob(grokDataDir, dir, "own-grok-job", { status: "done", mode: "consult", claudeSessionId: "session-abc", createdAt: "2026-07-04T00:00:00.000Z" });
  writeGrokJob(grokDataDir, dir, "other-grok-job", { status: "done", mode: "consult", claudeSessionId: "session-xyz", createdAt: "2026-07-04T00:00:00.000Z" });

  const result = run({ cwd: dir, codexState }, ["--session", "--json"], {
    GROK_COMPANION_DATA: grokDataDir,
    CLAUDE_CODE_SESSION_ID: "session-abc"
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.strictEqual(data.engines.codex.available, true);
  assert.strictEqual(data.engines.codex.totalJobs, 1);
  assert.deepStrictEqual(data.engines.codex.byStatus, { completed: 1 });
  assert.strictEqual(data.engines.grok.available, true);
  assert.strictEqual(data.engines.grok.totalJobs, 1);
  assert.deepStrictEqual(data.engines.grok.byStatus, { done: 1 });
});

test("buildSessionReport and renderSessionReport agree on an unset session", () => {
  const report = buildSessionReport({ env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", FUSION_INLINE_GUARD_STATE: "/nonexistent" } });
  assert.strictEqual(report.sessionId, null);
  assert.strictEqual(report.guard, null);
  assert.match(renderSessionReport(report), /no dispatches recorded/);
});

test("--prune-dead dry run lists only workspace dirs whose every job cwd is gone", (t) => {
  const dir = sandbox(t);
  const codexState = path.join(dir, "codex-state");
  const grokDataDir = path.join(dir, "grok-data");
  const goneCodexRoot = path.join(dir, "gone-codex-root");
  const goneGrokCwd = path.join(dir, "gone-grok-cwd");

  writeCodexJob(codexState, goneCodexRoot, "dead-codex", { status: "completed", jobClass: "task", createdAt: "2026-07-01T00:00:00.000Z" });
  writeCodexJob(codexState, dir, "live-codex", { status: "completed", jobClass: "task", createdAt: "2026-07-01T00:00:00.000Z" });

  writeGrokJob(grokDataDir, goneGrokCwd, "dead-grok-1", { status: "done", mode: "consult", createdAt: "2026-07-01T00:00:00.000Z" });
  writeGrokJob(grokDataDir, goneGrokCwd, "dead-grok-2", { status: "error", mode: "consult", createdAt: "2026-07-01T00:00:00.000Z" });
  writeGrokJob(grokDataDir, dir, "live-cwd-grok", { status: "done", mode: "consult", createdAt: "2026-07-01T00:00:00.000Z" });
  writeGrokJob(grokDataDir, goneGrokCwd, "running-grok", { status: "running", mode: "consult", createdAt: "2026-07-01T00:00:00.000Z" });

  const result = run({ cwd: dir, codexState }, ["--prune-dead", "--json"], { GROK_COMPANION_DATA: grokDataDir });
  assert.strictEqual(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.strictEqual(data.applied, false);
  assert.strictEqual(data.dead.codex.length, 1);
  assert.strictEqual(data.dead.codex[0].jobCount, 1);
  assert.match(data.dead.codex[0].dir, /codex-state/);

  assert.strictEqual(data.dead.grok.length, 0);

  const goneGrokWorkspace = path.join(grokDataDir, "state", grokWorkspaceSlug(goneGrokCwd));
  assert.ok(fs.existsSync(goneGrokWorkspace), "the running job keeps its workspace out of the dead list entirely");

  const text = renderPruneReport(data);
  assert.match(text, /## Codex\n\n- .*\(1 job\)/);
  assert.match(text, /## Grok\n\nno dead workspace directories found/);
  assert.match(text, /dry run: rerun with --prune-dead --yes/);
});

test("--prune-dead --yes removes only the all-dead workspace dirs and spares live ones", (t) => {
  const dir = sandbox(t);
  const codexState = path.join(dir, "codex-state");
  const grokDataDir = path.join(dir, "grok-data");
  const goneGrokCwd = path.join(dir, "gone-grok-cwd-2");

  writeCodexJob(codexState, path.join(dir, "gone-codex-root-2"), "dead-codex", {
    status: "failed",
    jobClass: "task",
    createdAt: "2026-07-01T00:00:00.000Z"
  });
  writeCodexJob(codexState, dir, "live-codex", { status: "completed", jobClass: "task", createdAt: "2026-07-01T00:00:00.000Z" });
  writeGrokJob(grokDataDir, goneGrokCwd, "dead-grok", { status: "done", mode: "consult", createdAt: "2026-07-01T00:00:00.000Z" });
  writeGrokJob(grokDataDir, dir, "live-cwd-grok", { status: "done", mode: "consult", createdAt: "2026-07-01T00:00:00.000Z" });

  const before = findDeadWorkspaces({
    FUSION_CODEX_STATE: codexState,
    GROK_COMPANION_DATA: grokDataDir
  });
  assert.strictEqual(before.codex.length, 1);
  assert.strictEqual(before.grok.length, 1);

  const liveCodexWorkspaceDirs = fs
    .readdirSync(codexState)
    .map((entry) => path.join(codexState, entry))
    .filter((entryDir) => entryDir !== before.codex[0].dir);
  const liveGrokWorkspaceDir = path.join(grokDataDir, "state", grokWorkspaceSlug(dir));

  const result = run({ cwd: dir, codexState }, ["--prune-dead", "--yes", "--json"], { GROK_COMPANION_DATA: grokDataDir });
  assert.strictEqual(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.strictEqual(data.applied, true);
  assert.strictEqual(data.dead.codex.length, 1);
  assert.strictEqual(data.dead.grok.length, 1);

  assert.strictEqual(fs.existsSync(before.codex[0].dir), false);
  assert.strictEqual(fs.existsSync(before.grok[0].dir), false);
  for (const stillThere of liveCodexWorkspaceDirs) {
    assert.ok(fs.existsSync(stillThere), `${stillThere} should survive the prune`);
  }
  assert.ok(fs.existsSync(liveGrokWorkspaceDir), "the live-cwd grok workspace should survive the prune");

  const after = findDeadWorkspaces({ FUSION_CODEX_STATE: codexState, GROK_COMPANION_DATA: grokDataDir });
  assert.strictEqual(after.codex.length, 0);
  assert.strictEqual(after.grok.length, 0);
});

test("pruneDeadWorkspaces never touches a workspace with any running job even without a live cwd", (t) => {
  const dir = sandbox(t);
  const grokDataDir = path.join(dir, "grok-data");
  const goneCwd = path.join(dir, "gone-cwd-3");
  writeGrokJob(grokDataDir, goneCwd, "finished", { status: "done", mode: "consult", createdAt: "2026-07-01T00:00:00.000Z" });
  writeGrokJob(grokDataDir, goneCwd, "still-running", { status: "running", mode: "consult", createdAt: "2026-07-01T00:00:00.000Z" });

  const env = { GROK_COMPANION_DATA: grokDataDir, FUSION_CODEX_STATE: path.join(dir, "missing-codex") };
  const dead = findDeadWorkspaces(env);
  assert.strictEqual(dead.grok.length, 0);

  const applied = pruneDeadWorkspaces({ env, yes: true });
  assert.strictEqual(applied.dead.grok.length, 0);
  assert.ok(fs.existsSync(path.join(grokDataDir, "state", grokWorkspaceSlug(goneCwd))));
});

test("WORKSPACE_ENGINE_DESCRIPTORS covers both peer engines", () => {
  const ids = WORKSPACE_ENGINE_DESCRIPTORS.map((descriptor) => descriptor.id);
  assert.deepStrictEqual(ids.sort(), ["codex", "grok"]);
});

test("prune-dead treats any unreadable job record as unsafe for the whole workspace", (t) => {
  const dir = sandbox(t);
  const codexState = path.join(dir, "codex-state");
  const workspaceDir = path.join(codexState, "unsafe-workspace");
  const jobsDir = path.join(workspaceDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobsDir, "dead.json"),
    JSON.stringify({ id: "dead", workspaceRoot: path.join(dir, "gone"), status: "completed" })
  );
  fs.mkdirSync(path.join(jobsDir, "unreadable.json"));

  const env = { FUSION_CODEX_STATE: codexState, GROK_COMPANION_DATA: path.join(dir, "missing-grok") };
  assert.deepStrictEqual(findDeadWorkspaces(env).codex, []);
  assert.deepStrictEqual(pruneDeadWorkspaces({ env, yes: true }).dead.codex, []);
  assert.ok(fs.existsSync(workspaceDir));
});

test("prune-dead requires every terminal record to carry an absolute missing cwd", (t) => {
  const dir = sandbox(t);
  const codexState = path.join(dir, "codex-state");
  writeCodexJob(codexState, undefined, "missing-cwd", { status: "completed" });
  writeCodexJob(codexState, "", "empty-cwd", { status: "failed" });
  writeCodexJob(codexState, "relative/workspace", "relative-cwd", { status: "cancelled" });

  const env = { FUSION_CODEX_STATE: codexState, GROK_COMPANION_DATA: path.join(dir, "missing-grok") };
  assert.deepStrictEqual(findDeadWorkspaces(env).codex, []);
  assert.deepStrictEqual(pruneDeadWorkspaces({ env, yes: true }).dead.codex, []);
  assert.strictEqual(fs.readdirSync(codexState).length, 3);
});

test("prune-dead revalidates directory mtime, file membership, and running state immediately before removal", (t) => {
  const dir = sandbox(t);
  const codexState = path.join(dir, "codex-state");
  writeCodexJob(codexState, path.join(dir, "gone-a"), "dead-a", { status: "completed" });
  writeCodexJob(codexState, path.join(dir, "gone-b"), "dead-b", { status: "failed" });
  const env = { FUSION_CODEX_STATE: codexState, GROK_COMPANION_DATA: path.join(dir, "missing-grok") };
  const candidates = findDeadWorkspaces(env).codex;
  assert.strictEqual(candidates.length, 2);

  const changedMtimeWorkspace = candidates[0].workspace;
  const result = pruneDeadWorkspaces({
    env,
    yes: true,
    beforeRemove(candidate) {
      const jobsDir = path.join(candidate.dir, "jobs");
      if (candidate.workspace === changedMtimeWorkspace) {
        const future = new Date(Date.now() + 60000);
        fs.utimesSync(jobsDir, future, future);
      } else {
        fs.writeFileSync(
          path.join(jobsDir, "new-running.json"),
          JSON.stringify({ id: "new-running", workspaceRoot: path.join(dir, "gone-b"), status: "running" })
        );
      }
    }
  });

  assert.deepStrictEqual(result.dead.codex, []);
  for (const candidate of candidates) {
    assert.ok(fs.existsSync(candidate.dir));
  }
});

test("--session explicitly reports unavailable data when the session id is unset", (t) => {
  const dir = sandbox(t);
  const report = buildSessionReport({
    env: {
      CLAUDE_CODE_SESSION_ID: "",
      FUSION_INLINE_GUARD_STATE: path.join(dir, "guard"),
      FUSION_CODEX_STATE: path.join(dir, "codex"),
      GROK_COMPANION_DATA: path.join(dir, "grok")
    }
  });
  assert.strictEqual(report.available, false);
  assert.match(report.reason, /CLAUDE_CODE_SESSION_ID is unset/);
  assert.strictEqual(report.engines.codex.available, false);
  assert.strictEqual(report.engines.grok.available, false);
  const rendered = renderSessionReport(report);
  assert.match(rendered, /Session data unavailable: CLAUDE_CODE_SESSION_ID is unset/);
  assert.doesNotMatch(rendered, /Total jobs: 0/);
});
