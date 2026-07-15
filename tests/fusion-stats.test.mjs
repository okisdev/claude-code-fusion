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
  buildAuditReport,
  buildFusionStats,
  buildSessionReport,
  buildTraceReport,
  acceptanceSidecarPath,
  codexStats,
  fileBasedEngineStats,
  findDeadWorkspaces,
  fusionRepositoryKey,
  normalizeCodexTokenUsage,
  pruneDeadWorkspaces,
  recordCodexAcceptance,
  resolveGitRepositoryCommonDir,
  renderAuditReport,
  renderFusionStats,
  renderPruneReport,
  renderSessionReport,
  workspaceRootsShareRepository
} from "../plugins/fusion/scripts/fusion-stats.mjs";
import { resolveStateDir as guardResolveStateDir, stateFile as guardStateFile } from "../plugins/fusion/scripts/inline-delegation-guard.mjs";
import { resolveCodexStateRoots } from "../plugins/fusion/scripts/lib/codex-state-roots.mjs";

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
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, workspaceRoot, ...fields }));
  return file;
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

function createSiblingWorktree(root) {
  const main = path.join(root, "main");
  const sibling = path.join(root, "sibling");
  fs.mkdirSync(main, { recursive: true });
  const initialized = spawnSync("git", ["init", "-q"], { cwd: main, encoding: "utf8" });
  assert.strictEqual(initialized.status, 0, initialized.stderr);
  const added = spawnSync("git", ["worktree", "add", "--orphan", sibling], { cwd: main, encoding: "utf8" });
  assert.strictEqual(added.status, 0, added.stderr);
  return { main, sibling };
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

test("Codex stats aggregate canonical and legacy roots without mutating legacy state", (t) => {
  const dir = sandbox(t);
  const [canonicalState, legacyState] = resolveCodexStateRoots({ HOME: dir });
  writeCodexJob(canonicalState, dir, "canonical", { status: "done", jobClass: "task", createdAt: "2026-07-14T01:00:00.000Z", finishedAt: "2026-07-14T01:00:01.000Z" });
  const legacyFile = writeCodexJob(legacyState, dir, "legacy", { status: "completed", jobClass: "task", createdAt: "2026-07-13T01:00:00.000Z", completedAt: "2026-07-13T01:00:01.000Z" });
  const before = fs.readFileSync(legacyFile, "utf8");
  const result = codexStats({ all: true, env: { HOME: dir, FUSION_DATA_DIR: path.join(dir, "fusion-data") }, cwd: dir });
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.totalJobs, 2);
  assert.strictEqual(result.byStatus.done, 1);
  assert.strictEqual(result.byStatus.completed, 1);
  assert.strictEqual(fs.readFileSync(legacyFile, "utf8"), before);
});

test("Codex stats deduplicate a job mirrored across canonical and legacy roots", (t) => {
  const dir = sandbox(t);
  const [canonicalState, legacyState] = resolveCodexStateRoots({ HOME: dir });
  const fields = { status: "completed", jobClass: "task", createdAt: "2026-07-14T01:00:00.000Z", completedAt: "2026-07-14T01:00:01.000Z" };
  writeCodexJob(canonicalState, dir, "mirrored", fields);
  writeCodexJob(legacyState, dir, "mirrored", fields);
  const result = codexStats({ all: true, env: { HOME: dir }, cwd: dir });
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.totalJobs, 1);
});

test("Codex stats collapse stale legacy running mirrors for a deleted workspace", (t) => {
  const dir = sandbox(t);
  const [, legacyState] = resolveCodexStateRoots({ HOME: dir });
  const deletedWorkspace = path.join(dir, "deleted-worktree");
  writeCodexJob(legacyState, deletedWorkspace, "legacy-mirror", { status: "running", jobClass: "task", createdAt: "2026-07-14T01:00:00.000Z" });
  writeCodexJob(legacyState, deletedWorkspace, "legacy-mirror", { status: "completed", jobClass: "task", createdAt: "2026-07-14T01:00:00.000Z", completedAt: "2026-07-14T01:00:01.000Z" });
  const result = codexStats({ all: true, env: { HOME: dir }, cwd: dir });
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.totalJobs, 1);
  assert.strictEqual(result.byStatus.completed, 1);
  assert.strictEqual(result.pendingTransportJobs, 0);
});

test("the compatibility state override retains legacy stale mirror semantics", (t) => {
  const dir = sandbox(t);
  const stateRoot = path.join(dir, "custom-legacy-state");
  const deletedWorkspace = path.join(dir, "deleted-worktree");
  writeCodexJob(stateRoot, deletedWorkspace, "legacy-mirror", { status: "running", jobClass: "task", createdAt: "2026-07-14T01:00:00.000Z" });
  writeCodexJob(stateRoot, deletedWorkspace, "legacy-mirror", { status: "completed", jobClass: "task", createdAt: "2026-07-14T01:00:00.000Z", completedAt: "2026-07-14T01:00:01.000Z" });
  const result = codexStats({ all: true, env: { HOME: dir, FUSION_CODEX_STATE_DIR: stateRoot }, cwd: dir });
  assert.strictEqual(result.totalJobs, 1);
  assert.strictEqual(result.byStatus.completed, 1);
  assert.strictEqual(result.pendingTransportJobs, 0);
});

test("an explicit Codex state override excludes legacy home stats", (t) => {
  const dir = sandbox(t);
  const [, legacyState] = resolveCodexStateRoots({ HOME: dir });
  writeCodexJob(legacyState, dir, "legacy", { status: "completed", jobClass: "task", createdAt: "2026-07-14T01:00:00.000Z" });
  const result = codexStats({ all: true, env: { HOME: dir, FUSION_CODEX_STATE: path.join(dir, "isolated-state") }, cwd: dir });
  assert.strictEqual(result.available, false);
});

test("aggregates the canonical Codex lifecycle and direct token usage", (t) => {
  const dir = sandbox(t);
  const stateRoot = path.join(dir, "state");
  writeCodexJob(stateRoot, dir, "task-direct", {
    status: "done",
    jobClass: "task",
    createdAt: "2026-07-02T06:00:00.000Z",
    startedAt: "2026-07-02T06:00:01.000Z",
    finishedAt: "2026-07-02T06:00:06.000Z",
    request: { model: "gpt-5.4", effort: "high" },
    tokenUsageAvailability: "available",
    tokenUsage: { inputTokens: 120, cachedInputTokens: 40, outputTokens: 30, reasoningOutputTokens: 12, totalTokens: 150 }
  });
  writeCodexJob(stateRoot, dir, "task-error", {
    status: "error",
    jobClass: "task",
    createdAt: "2026-07-02T06:01:00.000Z",
    startedAt: "2026-07-02T06:01:00.000Z",
    finishedAt: "2026-07-02T06:01:03.000Z",
    tokenUsageAvailability: "unavailable"
  });

  const result = run({ cwd: dir, codexState: stateRoot }, ["--json"]);
  assert.strictEqual(result.status, 0, result.stderr);
  const stats = JSON.parse(result.stdout).codex;
  assert.deepStrictEqual(stats.byTransportStatus, { done: 1, error: 1 });
  assert.strictEqual(stats.meanWallClockSeconds, 4);
  assert.deepStrictEqual(stats.byModel, { "gpt-5.4@high": 1, unknown: 1 });
  assert.strictEqual(stats.tokenUsage.availability, "partial");
  assert.strictEqual(stats.tokenUsage.jobsWithUsage, 1);
  assert.strictEqual(stats.tokenUsage.jobsWithoutUsage, 1);
  assert.deepStrictEqual(stats.tokenUsage.totals, { inputTokens: 120, cachedInputTokens: 40, outputTokens: 30, reasoningOutputTokens: 12, totalTokens: 150 });
});

test("counts canonical running records without repairing or signalling them", (t) => {
  const dir = sandbox(t);
  const stateRoot = path.join(dir, "state");
  const staleFile = writeCodexJob(stateRoot, dir, "stale-running", {
    schemaVersion: 1,
    engine: "codex",
    status: "running",
    phase: "executing",
    pid: null,
    codexPid: null,
    createdAt: "2026-07-02T06:00:00.000Z",
    startedAt: "2026-07-02T06:00:00.000Z",
    finishedAt: null
  });
  const liveFile = writeCodexJob(stateRoot, dir, "live-running", {
    schemaVersion: 1,
    engine: "codex",
    status: "running",
    phase: "executing",
    pid: process.pid,
    codexPid: null,
    createdAt: "2026-07-02T06:00:00.000Z",
    startedAt: "2026-07-02T06:00:00.000Z",
    finishedAt: null
  });
  const timeoutFile = writeCodexJob(stateRoot, dir, "expired-running", {
    schemaVersion: 1,
    engine: "codex",
    status: "running",
    phase: "executing",
    pid: process.pid,
    codexPid: null,
    createdAt: "2026-07-02T06:00:00.000Z",
    startedAt: "2026-07-02T06:00:00.000Z",
    deadlineAt: "2026-07-02T06:01:00.000Z",
    finishedAt: null
  });
  const cancelledFile = writeCodexJob(stateRoot, dir, "cancel-requested", {
    schemaVersion: 1,
    engine: "codex",
    status: "running",
    phase: "cancelling",
    pid: process.pid,
    codexPid: null,
    createdAt: "2026-07-02T06:00:00.000Z",
    startedAt: "2026-07-02T06:00:00.000Z",
    deadlineAt: "2026-07-02T06:01:00.000Z",
    cancelRequestedAt: "2026-07-02T06:00:30.000Z",
    finishedAt: null
  });

  const files = [staleFile, liveFile, timeoutFile, cancelledFile];
  const before = files.map((file) => fs.readFileSync(file, "utf8"));
  const stats = codexStats({ env: { FUSION_CODEX_STATE: stateRoot }, cwd: dir });
  assert.deepStrictEqual(stats.byTransportStatus, { running: 4 });
  assert.strictEqual(stats.pendingTransportJobs, 4);
  assert.deepStrictEqual(files.map((file) => fs.readFileSync(file, "utf8")), before);
});

test("scopes Codex jobs by Git repository identity across sibling worktrees", (t) => {
  const dir = sandbox(t);
  const { main, sibling } = createSiblingWorktree(dir);
  const unrelated = path.join(dir, "unrelated");
  fs.mkdirSync(unrelated, { recursive: true });
  const initialized = spawnSync("git", ["init", "-q"], { cwd: unrelated, encoding: "utf8" });
  assert.strictEqual(initialized.status, 0, initialized.stderr);
  const stateRoot = path.join(dir, "state");
  writeCodexJob(stateRoot, sibling, "sibling-task", { status: "completed", jobClass: "task", createdAt: "2026-07-02T06:00:00.000Z" });
  writeCodexJob(stateRoot, unrelated, "unrelated-task", { status: "completed", jobClass: "task", createdAt: "2026-07-02T06:01:00.000Z" });
  const parentKey = createHash("sha256").update(dir).digest("hex").slice(0, 16);
  fs.writeFileSync(path.join(stateRoot, `codex-jobs-monitor-announced.parent.${parentKey}.json`), `${JSON.stringify(["parent-task:completed"])}\n`);

  assert.strictEqual(resolveGitRepositoryCommonDir(main), resolveGitRepositoryCommonDir(sibling));
  assert.strictEqual(workspaceRootsShareRepository(main, sibling), true);
  assert.strictEqual(workspaceRootsShareRepository(main, unrelated), false);

  const result = run({ cwd: main, codexState: stateRoot }, ["--json"]);
  assert.strictEqual(result.status, 0, result.stderr);
  const stats = JSON.parse(result.stdout).codex;
  assert.strictEqual(stats.totalJobs, 1);
  assert.deepStrictEqual(stats.byTransportStatus, { completed: 1 });
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
  assert.strictEqual(FILE_ENGINE_DESCRIPTORS.codex.defaultStateRoot({}), path.join(os.homedir(), ".claude", "plugins", "data", "codex-claude-code-fusion", "state"));
  assert.strictEqual(FILE_ENGINE_DESCRIPTORS.codex.defaultStateRoot({ CODEX_COMPANION_DATA: "/adapter-data" }), "/adapter-data/state");
  assert.strictEqual(typeof fileBasedEngineStats, "function");
});

test("Codex token normalization rejects inconsistent counters", () => {
  assert.strictEqual(normalizeCodexTokenUsage({ inputTokens: 10, cachedInputTokens: 11, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 12 }), null);
  assert.strictEqual(normalizeCodexTokenUsage({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 2, reasoningOutputTokens: 3, totalTokens: 12 }), null);
  assert.strictEqual(normalizeCodexTokenUsage({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 13 }), null);
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

function writeTraceFixture(dir) {
  const guardStateDir = path.join(dir, "guard-state");
  const grokDataDir = path.join(dir, "grok-data");
  const codexState = path.join(dir, "codex-state");
  writeGuardState(guardStateDir, "session-trace", {
    writeCount: 0,
    dispatches: { grok: 1, codex: 1 },
    dispatchLog: [
      { at: "2026-07-10T10:00:00.000Z", lane: "grok", subagentType: "grok:grok-rescue", description: "first dispatch" },
      { at: "2026-07-10T10:10:00.000Z", lane: "codex", subagentType: "codex:codex-rescue", description: "last dispatch" }
    ],
    advisedMultiples: [],
    createdAt: "2026-07-10T10:00:00.000Z",
    updatedAt: "2026-07-10T10:10:00.000Z"
  });
  writeGrokJob(grokDataDir, dir, "grok-exact", {
    status: "done",
    mode: "consult",
    claudeSessionId: "session-trace",
    createdAt: "2026-07-10T10:04:00.000Z",
    request: { model: "grok-model", effort: "high" }
  });
  writeCodexJob(codexState, dir, "codex-approximate", {
    status: "completed",
    jobClass: "task",
    createdAt: "2026-07-10T10:06:00.000Z",
    request: { model: "codex-model", effort: "xhigh" }
  });
  writeCodexJob(codexState, dir, "codex-outside-span", {
    status: "completed",
    jobClass: "task",
    createdAt: "2026-07-10T11:11:00.000Z",
    request: { model: "outside-model", effort: "low" }
  });
  return { guardStateDir, grokDataDir, codexState };
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

test("--trace joins exact Grok and approximate Codex jobs into dispatch time order", (t) => {
  const dir = sandbox(t);
  const fixture = writeTraceFixture(dir);
  const result = run({ cwd: dir, codexState: fixture.codexState }, ["--trace", "--session", "session-trace"], {
    CLAUDE_CODE_SESSION_ID: "different-session",
    FUSION_INLINE_GUARD_STATE: fixture.guardStateDir,
    GROK_COMPANION_DATA: fixture.grokDataDir
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const rows = result.stdout.split("\n").filter((line) => line.startsWith("2026-07-10T"));
  assert.deepStrictEqual(rows.map((row) => row.split(" | ").slice(0, 3)), [
    ["2026-07-10T10:00:00.000Z", "dispatch", "grok"],
    ["2026-07-10T10:04:00.000Z", "engine job", "grok"],
    ["2026-07-10T10:06:00.000Z", "engine job", "codex (approximate)"],
    ["2026-07-10T10:10:00.000Z", "dispatch", "codex"]
  ]);
  assert.match(result.stdout, /grok-model@high \| done/);
  assert.match(result.stdout, /codex-model@xhigh \| completed/);
  assert.match(result.stdout, /codex \(approximate\)/);
  assert.doesNotMatch(result.stdout, /outside-model/);
});

test("--trace --json returns the session timeline shape", (t) => {
  const dir = sandbox(t);
  const fixture = writeTraceFixture(dir);
  const result = run({ cwd: dir, codexState: fixture.codexState }, ["--trace", "--session", "session-trace", "--json"], {
    FUSION_INLINE_GUARD_STATE: fixture.guardStateDir,
    GROK_COMPANION_DATA: fixture.grokDataDir
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.strictEqual(data.available, true);
  assert.strictEqual(data.sessionId, "session-trace");
  assert.strictEqual(data.workspaceRoot, dir);
  assert.ok(Array.isArray(data.timeline));
  assert.deepStrictEqual(data.timeline.map((entry) => entry.source), ["dispatch", "engine job", "engine job", "dispatch"]);
  assert.deepStrictEqual(data.timeline[0], {
    time: "2026-07-10T10:00:00.000Z",
    source: "dispatch",
    lane: "grok",
    subagentType: "grok:grok-rescue",
    description: "first dispatch"
  });
  assert.deepStrictEqual(data.timeline[1], {
    time: "2026-07-10T10:04:00.000Z",
    source: "engine job",
    engine: "grok",
    join: "exact",
    model: "grok-model",
    effort: "high",
    status: "done"
  });
  assert.deepStrictEqual(data.timeline[2], {
    time: "2026-07-10T10:06:00.000Z",
    source: "engine job",
    engine: "codex",
    join: "approximate",
    model: "codex-model",
    effort: "xhigh",
    status: "completed"
  });
});

test("--trace uses canonical Codex session ids exactly and keeps legacy time fallback isolated", (t) => {
  const dir = sandbox(t);
  const fixture = writeTraceFixture(dir);
  writeCodexJob(fixture.codexState, dir, "codex-exact", {
    status: "done",
    sessionId: "session-trace",
    createdAt: "2026-07-10T12:00:00.000Z",
    request: { model: "exact-model", effort: "high" }
  });
  writeCodexJob(fixture.codexState, dir, "codex-other-session", {
    status: "done",
    sessionId: "other-session",
    createdAt: "2026-07-10T10:08:00.000Z",
    request: { model: "other-model", effort: "high" }
  });
  writeCodexJob(fixture.codexState, dir, "codex-session-alias", {
    status: "done",
    sessionId: "",
    claudeSessionId: "session-trace",
    createdAt: "2026-07-10T13:00:00.000Z",
    request: { model: "alias-model", effort: "high" }
  });

  const result = run({ cwd: dir, codexState: fixture.codexState }, ["--trace", "--session", "session-trace", "--json"], {
    FUSION_INLINE_GUARD_STATE: fixture.guardStateDir,
    GROK_COMPANION_DATA: fixture.grokDataDir
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const codexEntries = JSON.parse(result.stdout).timeline.filter((entry) => entry.engine === "codex");
  assert.deepStrictEqual(codexEntries.map((entry) => [entry.model, entry.join]), [
    ["codex-model", "approximate"],
    ["exact-model", "exact"],
    ["alias-model", "exact"]
  ]);
  assert.ok(!codexEntries.some((entry) => entry.model === "other-model"));
});

test("--trace includes Codex jobs from a sibling worktree in the same repository", (t) => {
  const dir = sandbox(t);
  const { main, sibling } = createSiblingWorktree(dir);
  const fixture = writeTraceFixture(main);
  writeCodexJob(fixture.codexState, sibling, "codex-sibling", {
    status: "completed",
    jobClass: "task",
    createdAt: "2026-07-10T10:07:00.000Z",
    request: { model: "sibling-model", effort: "high" }
  });

  const result = run({ cwd: main, codexState: fixture.codexState }, ["--trace", "--session", "session-trace"], {
    FUSION_INLINE_GUARD_STATE: fixture.guardStateDir,
    GROK_COMPANION_DATA: fixture.grokDataDir
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /sibling-model@high \| completed/);
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

function writeModelAudit(fusionData, workspaceRoot, observations) {
  const workspaceKey = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  const file = path.join(fusionData, "observations", workspaceKey, "model-audit.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, observations.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return file;
}

function writeTerminalLedger(stateRoot, workspaceRoot, records, { sessionId = "session-ledger" } = {}) {
  fs.mkdirSync(stateRoot, { recursive: true });
  const workspaceKey = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  const repositoryKey = fusionRepositoryKey(workspaceRoot);
  const file = path.join(stateRoot, `codex-jobs-monitor-announced.${sessionId}.${workspaceKey}.json`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      schemaVersion: 3,
      engine: "codex",
      workspaceRoot,
      repositoryKey,
      updatedAt: "2026-07-14T00:00:00.000Z",
      keys: records.map((record) => `${record.jobId}:${record.transportStatus}`),
      records: records.map((record) => ({ repositoryKey, ...record }))
    })}\n`
  );
  return file;
}

function writeTokenUsage(fusionData, workspaceRoot, observations) {
  const workspaceKey = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  const file = path.join(fusionData, "observations", workspaceKey, "token-usage.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${observations.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return file;
}

test("codex byModel includes effort from request fields first then sidecar in JSON and rendered output", (t) => {
  const dir = sandbox(t);
  const stateRoot = path.join(dir, "state");
  const fusionData = path.join(dir, "fusion-data");

  writeCodexJob(stateRoot, dir, "from-request", {
    status: "completed",
    jobClass: "task",
    createdAt: "2026-07-02T06:00:00.000Z",
    request: { model: "request-model", effort: "high" }
  });
  writeCodexJob(stateRoot, dir, "from-sidecar", {
    status: "completed",
    jobClass: "task",
    createdAt: "2026-07-02T06:01:00.000Z"
  });
  writeCodexJob(stateRoot, dir, "unknown-job", {
    status: "failed",
    jobClass: "task",
    createdAt: "2026-07-02T06:02:00.000Z"
  });
  writeCodexJob(stateRoot, dir, "request-over-sidecar", {
    status: "completed",
    jobClass: "task",
    createdAt: "2026-07-02T06:03:00.000Z",
    request: { model: "wins-from-request" }
  });

  writeModelAudit(fusionData, dir, [
    { jobId: "from-request", engine: "codex", model: "should-lose", effort: "low", source: "argv", observedAt: "2026-07-02T06:00:30.000Z" },
    { jobId: "from-sidecar", engine: "codex", model: "sidecar-model", effort: "low", source: "argv", observedAt: "2026-07-02T06:01:30.000Z" },
    { jobId: "request-over-sidecar", engine: "codex", model: "should-lose", effort: "xhigh", source: "argv", observedAt: "2026-07-02T06:03:30.000Z" }
  ]);

  const result = run({ cwd: dir, codexState: stateRoot }, ["--json"], { FUSION_DATA_DIR: fusionData });
  assert.strictEqual(result.status, 0, result.stderr);
  const codex = JSON.parse(result.stdout).codex;
  assert.strictEqual(codex.totalJobs, 4);
  assert.deepStrictEqual(codex.byModel, {
    "request-model@high": 1,
    "sidecar-model@low": 1,
    unknown: 1,
    "wins-from-request@xhigh": 1
  });

  const viaApi = codexStats({ env: { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: fusionData }, cwd: dir });
  assert.deepStrictEqual(viaApi.byModel, codex.byModel);

  const rendered = run({ cwd: dir, codexState: stateRoot }, [], { FUSION_DATA_DIR: fusionData });
  assert.strictEqual(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /By model:\n- request-model@high: 1/);
  assert.match(rendered.stdout, /- sidecar-model@low: 1/);
  assert.match(rendered.stdout, /- wins-from-request@xhigh: 1/);
});

test("codex stats dedupe mirrored job ids and prefer the terminal workspace copy", (t) => {
  const dir = sandbox(t);
  const stateRoot = path.join(dir, "state");
  const worktreeRoot = path.join(dir, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(worktreeRoot, { recursive: true });
  writeCodexJob(stateRoot, dir, "mirrored-job", {
    status: "running",
    jobClass: "task",
    createdAt: "2026-07-02T06:00:00.000Z",
    updatedAt: "2026-07-02T06:00:05.000Z",
    request: { model: "stale-model", effort: "low" }
  });
  writeCodexJob(stateRoot, worktreeRoot, "mirrored-job", {
    status: "completed",
    jobClass: "task",
    createdAt: "2026-07-02T06:00:00.000Z",
    completedAt: "2026-07-02T06:01:00.000Z",
    request: { model: "terminal-model", effort: "high" }
  });

  const result = run({ cwd: dir, codexState: stateRoot }, ["--json"]);
  assert.strictEqual(result.status, 0, result.stderr);
  const codex = JSON.parse(result.stdout).codex;
  assert.strictEqual(codex.totalJobs, 1);
  assert.deepStrictEqual(codex.byStatus, { completed: 1 });
  assert.deepStrictEqual(codex.byModel, { "terminal-model@high": 1 });
});

test("codex workspace scope resolves the git root and includes descendant worktrees", (t) => {
  const dir = sandbox(t);
  const repo = path.join(dir, "repo");
  const nested = path.join(repo, "packages", "app");
  const worktree = path.join(repo, ".claude", "worktrees", "agent-one");
  const stateRoot = path.join(dir, "state");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  assert.strictEqual(spawnSync("git", ["init", "--quiet", repo]).status, 0);
  writeCodexJob(stateRoot, worktree, "worktree-job", { status: "completed", jobClass: "task", createdAt: "2026-07-14T00:00:00.000Z" });

  const result = run({ cwd: nested, codexState: stateRoot }, ["--json"]);
  assert.strictEqual(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.strictEqual(data.scope, repo);
  assert.strictEqual(data.codex.scope, repo);
  assert.strictEqual(data.codex.totalJobs, 1);
});

test("terminal ledgers supplement cleaned jobs and safely dedupe live state", (t) => {
  const dir = sandbox(t);
  const stateRoot = path.join(dir, "state");
  writeTerminalLedger(stateRoot, dir, [
    {
      schemaVersion: 1,
      jobId: "cleaned-job",
      transportStatus: "completed",
      workspaceRoot: dir,
      sessionId: "session-ledger",
      kind: "review",
      createdAt: "2026-07-14T00:00:00.000Z",
      startedAt: "2026-07-14T00:00:01.000Z",
      finishedAt: "2026-07-14T00:00:11.000Z",
      observedAt: "2026-07-14T00:00:12.000Z",
      model: "ledger-model",
      effort: "high",
      tokenUsage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 },
      tokenUsageAvailability: "available"
    }
  ]);

  const recovered = codexStats({ env: { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: path.join(dir, "fusion") }, cwd: dir });
  assert.strictEqual(recovered.totalJobs, 1);
  assert.deepStrictEqual(recovered.byTransportStatus, { completed: 1 });
  assert.deepStrictEqual(recovered.byAcceptance, { unverified: 1 });
  assert.deepStrictEqual(recovered.byModel, { "ledger-model@high": 1 });
  assert.strictEqual(recovered.evidence.recoveredTerminalJobs, 1);
  assert.deepStrictEqual(recovered.tokenUsage.totals, { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 });

  writeCodexJob(stateRoot, dir, "cleaned-job", {
    status: "completed",
    jobClass: "review",
    createdAt: "2026-07-14T00:00:00.000Z",
    request: { model: "state-model", effort: "xhigh" }
  });
  const deduped = codexStats({ env: { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: path.join(dir, "fusion") }, cwd: dir });
  assert.strictEqual(deduped.totalJobs, 1);
  assert.deepStrictEqual(deduped.byModel, { "state-model@xhigh": 1 });
  assert.deepStrictEqual(deduped.evidence.bySource, { state: 1 });
});

test("terminal ledger repository identity survives removal of a sibling worktree", (t) => {
  const dir = sandbox(t);
  const { main, sibling } = createSiblingWorktree(dir);
  const stateRoot = path.join(dir, "state");
  writeCodexJob(stateRoot, sibling, "removed-sibling-job", {
    status: "completed",
    jobClass: "task",
    createdAt: "2026-07-14T00:00:00.000Z"
  });
  writeTerminalLedger(stateRoot, sibling, [
    {
      schemaVersion: 1,
      jobId: "removed-sibling-job",
      transportStatus: "completed",
      workspaceRoot: sibling,
      kind: "task",
      createdAt: "2026-07-14T00:00:00.000Z"
    }
  ]);
  const removed = spawnSync("git", ["worktree", "remove", "--force", sibling], { cwd: main, encoding: "utf8" });
  assert.strictEqual(removed.status, 0, removed.stderr);

  const stats = codexStats({ env: { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: path.join(dir, "fusion") }, cwd: main });
  assert.strictEqual(stats.totalJobs, 1);
  assert.deepStrictEqual(stats.byTransportStatus, { completed: 1 });
  assert.strictEqual(stats.evidence.recoveredTerminalJobs, 1);

  const all = codexStats({ all: true, env: { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: path.join(dir, "fusion") }, cwd: main });
  assert.strictEqual(all.totalJobs, 1);
  assert.deepStrictEqual(all.byTransportStatus, { completed: 1 });
  assert.deepStrictEqual(all.evidence.bySource, { state: 1 });
});

test("canonical state repository identity survives removal of a sibling worktree without a ledger", (t) => {
  const dir = sandbox(t);
  const { main, sibling } = createSiblingWorktree(dir);
  const stateRoot = path.join(dir, "state");
  const repositoryKey = fusionRepositoryKey(sibling);
  writeCodexJob(stateRoot, sibling, "stored-repository-job", {
    status: "done",
    jobClass: "task",
    createdAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:00:01.000Z",
    repositoryKey
  });
  const removed = spawnSync("git", ["worktree", "remove", "--force", sibling], { cwd: main, encoding: "utf8" });
  assert.strictEqual(removed.status, 0, removed.stderr);

  const stats = codexStats({ env: { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: path.join(dir, "fusion") }, cwd: main });
  assert.strictEqual(stats.totalJobs, 1);
  assert.deepStrictEqual(stats.byTransportStatus, { done: 1 });
  assert.deepStrictEqual(stats.evidence.bySource, { state: 1 });
});

test("authoritative terminal ledger repository identity rejects a conflicting path scope", (t) => {
  const dir = sandbox(t);
  const main = path.join(dir, "main");
  const nested = path.join(main, "nested");
  fs.mkdirSync(nested, { recursive: true });
  assert.strictEqual(spawnSync("git", ["init", "-q"], { cwd: main }).status, 0);
  assert.strictEqual(spawnSync("git", ["init", "-q"], { cwd: nested }).status, 0);
  const stateRoot = path.join(dir, "state");
  writeTerminalLedger(stateRoot, main, [
    {
      schemaVersion: 1,
      jobId: "nested-repo-job",
      transportStatus: "completed",
      workspaceRoot: nested,
      repositoryKey: fusionRepositoryKey(nested),
      kind: "task"
    }
  ]);

  const scoped = codexStats({ env: { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: path.join(dir, "fusion") }, cwd: main });
  assert.strictEqual(scoped.totalJobs, 0);
  const all = codexStats({ all: true, env: { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: path.join(dir, "fusion") }, cwd: main });
  assert.strictEqual(all.totalJobs, 1);
});

test("deleted worktree evidence does not merge with an unrelated repository that reuses the path", (t) => {
  const dir = sandbox(t);
  const { main, sibling } = createSiblingWorktree(dir);
  const stateRoot = path.join(dir, "state");
  writeTerminalLedger(stateRoot, sibling, [
    {
      schemaVersion: 1,
      jobId: "reused-path-job",
      transportStatus: "completed",
      workspaceRoot: sibling,
      kind: "task"
    }
  ]);
  const removed = spawnSync("git", ["worktree", "remove", "--force", sibling], { cwd: main, encoding: "utf8" });
  assert.strictEqual(removed.status, 0, removed.stderr);
  fs.mkdirSync(sibling, { recursive: true });
  assert.strictEqual(spawnSync("git", ["init", "-q"], { cwd: sibling }).status, 0);
  writeCodexJob(stateRoot, sibling, "reused-path-job", { status: "failed", jobClass: "task" });

  const env = { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: path.join(dir, "fusion") };
  const all = codexStats({ all: true, env, cwd: main });
  assert.strictEqual(all.totalJobs, 2);
  assert.deepStrictEqual(all.byTransportStatus, { failed: 1, completed: 1 });

  const original = codexStats({ env, cwd: main });
  assert.strictEqual(original.totalJobs, 1);
  assert.deepStrictEqual(original.byTransportStatus, { completed: 1 });
  const replacement = codexStats({ env, cwd: sibling });
  assert.strictEqual(replacement.totalJobs, 1);
  assert.deepStrictEqual(replacement.byTransportStatus, { failed: 1 });
});

test("legacy string announcement ledgers remain a scoped synthetic lower bound", (t) => {
  const dir = sandbox(t);
  const stateRoot = path.join(dir, "state");
  fs.mkdirSync(stateRoot, { recursive: true });
  const key = createHash("sha256").update(dir).digest("hex").slice(0, 16);
  fs.writeFileSync(path.join(stateRoot, `codex-jobs-monitor-announced.legacy.${key}.json`), `${JSON.stringify(["legacy-job:failed"])}\n`);

  const stats = codexStats({ env: { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: path.join(dir, "fusion") }, cwd: dir });
  assert.strictEqual(stats.totalJobs, 1);
  assert.deepStrictEqual(stats.byTransportStatus, { failed: 1 });
  assert.deepStrictEqual(stats.byModel, { unknown: 1 });
  assert.deepStrictEqual(stats.byEffort, { unavailable: 1 });
  assert.strictEqual(stats.tokenUsage.availability, "unavailable");
  assert.strictEqual(stats.evidence.recoveredLegacyTerminalJobs, 1);
});

test("codex dedupe keeps identical ids from unrelated workspaces and merges legacy evidence with descendants", (t) => {
  const dir = sandbox(t);
  const stateRoot = path.join(dir, "state");
  const firstRoot = path.join(dir, "first");
  const firstWorktree = path.join(firstRoot, ".claude", "worktrees", "one");
  const secondRoot = path.join(dir, "second");
  fs.mkdirSync(firstWorktree, { recursive: true });
  fs.mkdirSync(secondRoot, { recursive: true });
  writeCodexJob(stateRoot, firstWorktree, "shared-id", { status: "completed", jobClass: "task" });
  writeCodexJob(stateRoot, secondRoot, "shared-id", { status: "failed", jobClass: "task" });
  const firstKey = createHash("sha256").update(firstRoot).digest("hex").slice(0, 16);
  fs.writeFileSync(path.join(stateRoot, `codex-jobs-monitor-announced.legacy.${firstKey}.json`), `${JSON.stringify(["shared-id:completed"])}\n`);

  const all = codexStats({ all: true, env: { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: path.join(dir, "fusion") }, cwd: dir });
  assert.strictEqual(all.totalJobs, 2);
  assert.deepStrictEqual(all.byTransportStatus, { completed: 1, failed: 1 });

  const first = codexStats({ env: { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: path.join(dir, "fusion") }, cwd: firstRoot });
  assert.strictEqual(first.totalJobs, 1);
  assert.deepStrictEqual(first.evidence.bySource, { state: 1 });
});

test("semantic acceptance is explicit and excludes non-terminal transport jobs", (t) => {
  const dir = sandbox(t);
  const stateRoot = path.join(dir, "state");
  const fusionData = path.join(dir, "fusion");
  writeCodexJob(stateRoot, dir, "completed-job", { status: "completed", jobClass: "task", createdAt: "2026-07-14T00:00:00.000Z" });
  writeCodexJob(stateRoot, dir, "running-job", { status: "running", jobClass: "task", createdAt: "2026-07-14T00:01:00.000Z" });

  const before = codexStats({ env: { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: fusionData }, cwd: dir });
  assert.deepStrictEqual(before.byAcceptance, { unverified: 1 });
  assert.strictEqual(before.pendingTransportJobs, 1);
  assert.strictEqual(before.acceptanceScope, "terminal transport jobs only");

  recordCodexAcceptance({
    jobId: "completed-job",
    acceptance: "accepted",
    workspaceRoot: dir,
    env: { FUSION_DATA_DIR: fusionData },
    sessionId: "session-one",
    source: "collector",
    recordedAt: "2026-07-14T00:02:00.000Z"
  });
  const after = codexStats({ env: { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: fusionData }, cwd: dir });
  assert.deepStrictEqual(after.byAcceptance, { accepted: 1 });

  recordCodexAcceptance({
    jobId: "completed-job",
    acceptance: "rejected",
    workspaceRoot: dir,
    env: { FUSION_DATA_DIR: fusionData },
    sessionId: "session-one",
    source: "collector",
    recordedAt: "2026-07-14T00:03:00.000Z"
  });
  const rejected = codexStats({ env: { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: fusionData }, cwd: dir });
  assert.deepStrictEqual(rejected.byAcceptance, { rejected: 1 });
});

test("Codex acceptance and token observations stay scoped when unrelated repositories reuse a job id", (t) => {
  const dir = sandbox(t);
  const firstRoot = path.join(dir, "first");
  const secondRoot = path.join(dir, "second");
  fs.mkdirSync(firstRoot, { recursive: true });
  fs.mkdirSync(secondRoot, { recursive: true });
  assert.strictEqual(spawnSync("git", ["init", "-q"], { cwd: firstRoot }).status, 0);
  assert.strictEqual(spawnSync("git", ["init", "-q"], { cwd: secondRoot }).status, 0);
  const stateRoot = path.join(dir, "state");
  const fusionData = path.join(dir, "fusion");
  writeCodexJob(stateRoot, firstRoot, "shared-observation-id", { status: "completed", jobClass: "task" });
  writeCodexJob(stateRoot, secondRoot, "shared-observation-id", { status: "completed", jobClass: "task" });
  writeTokenUsage(fusionData, firstRoot, [
    { jobId: "shared-observation-id", tokenUsage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 13 }, observedAt: "2026-07-14T00:01:00.000Z" }
  ]);
  writeTokenUsage(fusionData, secondRoot, [
    { jobId: "shared-observation-id", tokenUsage: { inputTokens: 99, cachedInputTokens: 9, outputTokens: 9, reasoningOutputTokens: 4, totalTokens: 108 }, observedAt: "2026-07-14T00:02:00.000Z" }
  ]);
  recordCodexAcceptance({ jobId: "shared-observation-id", acceptance: "accepted", workspaceRoot: firstRoot, env: { FUSION_DATA_DIR: fusionData }, sessionId: "session-first", recordedAt: "2026-07-14T00:01:00.000Z" });
  recordCodexAcceptance({ jobId: "shared-observation-id", acceptance: "rejected", workspaceRoot: secondRoot, env: { FUSION_DATA_DIR: fusionData }, sessionId: "session-second", recordedAt: "2026-07-14T00:02:00.000Z" });

  const first = codexStats({ env: { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: fusionData }, cwd: firstRoot });
  assert.deepStrictEqual(first.byAcceptance, { accepted: 1 });
  assert.strictEqual(first.tokenUsage.totals.totalTokens, 13);
  const second = codexStats({ env: { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: fusionData }, cwd: secondRoot });
  assert.deepStrictEqual(second.byAcceptance, { rejected: 1 });
  assert.strictEqual(second.tokenUsage.totals.totalTokens, 108);
});

test("acceptance CLI validates fields, redacts short reasons, and recovers stale locks", (t) => {
  const dir = sandbox(t);
  const stateRoot = path.join(dir, "state");
  const fusionData = path.join(dir, "fusion");
  fs.mkdirSync(stateRoot, { recursive: true });
  const sidecar = acceptanceSidecarPath(dir, { FUSION_DATA_DIR: fusionData });
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.writeFileSync(`${sidecar}.lock`, "stale\n");
  const stale = new Date(Date.now() - 60000);
  fs.utimesSync(`${sidecar}.lock`, stale, stale);
  const secret = `sk-${"a".repeat(20)}`;

  const result = run(
    { cwd: dir, codexState: stateRoot },
    ["--record-acceptance", "task-safe", "rejected", "--reason", `verification failed ${secret}`, "--source", "main-loop", "--json"],
    { FUSION_DATA_DIR: fusionData, CLAUDE_CODE_SESSION_ID: "session-safe" }
  );
  assert.strictEqual(result.status, 0, result.stderr);
  const observation = JSON.parse(result.stdout);
  assert.strictEqual(observation.acceptance, "rejected");
  assert.strictEqual(observation.reason, "verification failed [redacted]");
  assert.strictEqual(fs.existsSync(`${sidecar}.lock`), false);
  assert.strictEqual(fs.readFileSync(sidecar, "utf8").includes(secret), false);

  assert.throws(
    () => recordCodexAcceptance({ jobId: "bad job id", acceptance: "accepted", workspaceRoot: dir, env: { FUSION_DATA_DIR: fusionData } }),
    /job id is invalid/
  );
  assert.throws(
    () => recordCodexAcceptance({ jobId: "task-safe", acceptance: "accepted", workspaceRoot: dir, env: { FUSION_DATA_DIR: fusionData }, reason: "line one\nline two" }),
    /single non-sensitive line/
  );
});

test("exact rollout model observations override request and argv values", (t) => {
  const dir = sandbox(t);
  const stateRoot = path.join(dir, "state");
  const fusionData = path.join(dir, "fusion");
  writeCodexJob(stateRoot, dir, "model-conflict", {
    status: "completed",
    jobClass: "task",
    createdAt: "2026-07-14T00:00:00.000Z",
    request: { model: "requested-model", effort: "low" }
  });
  writeModelAudit(fusionData, dir, [
    { jobId: "model-conflict", model: "argv-model", effort: "medium", source: "argv", observedAt: "2026-07-14T00:00:01.000Z" },
    { jobId: "model-conflict", model: "actual-model", effort: "xhigh", source: "rollout-turn-context", observedAt: "2026-07-14T00:00:02.000Z" }
  ]);

  const stats = codexStats({ env: { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: fusionData }, cwd: dir });
  assert.deepStrictEqual(stats.byModel, { "actual-model@xhigh": 1 });
  assert.deepStrictEqual(stats.byEffort, { xhigh: 1 });
});

test("token totals aggregate exact sidecars and mark missing jobs unavailable", (t) => {
  const dir = sandbox(t);
  const stateRoot = path.join(dir, "state");
  const fusionData = path.join(dir, "fusion");
  writeCodexJob(stateRoot, dir, "with-usage", { status: "completed", jobClass: "task", createdAt: "2026-07-14T00:00:00.000Z" });
  writeCodexJob(stateRoot, dir, "without-usage", { status: "failed", jobClass: "task", createdAt: "2026-07-14T00:01:00.000Z" });
  writeTokenUsage(fusionData, dir, [
    {
      jobId: "with-usage",
      availability: "available",
      tokenUsage: { inputTokens: 80, cachedInputTokens: 30, outputTokens: 20, reasoningOutputTokens: 7, totalTokens: 100 },
      observedAt: "2026-07-14T00:02:00.000Z"
    }
  ]);

  const stats = codexStats({ env: { FUSION_CODEX_STATE: stateRoot, FUSION_DATA_DIR: fusionData }, cwd: dir });
  assert.strictEqual(stats.tokenUsage.availability, "partial");
  assert.strictEqual(stats.tokenUsage.jobsWithUsage, 1);
  assert.strictEqual(stats.tokenUsage.jobsWithoutUsage, 1);
  assert.deepStrictEqual(stats.tokenUsage.totals, { inputTokens: 80, cachedInputTokens: 30, outputTokens: 20, reasoningOutputTokens: 7, totalTokens: 100 });
});

test("rendered peer usage includes Grok exact totals", () => {
  const report = {
    scope: "all",
    grok: {
      available: true,
      totalJobs: 2,
      byStatus: { done: 2 },
      usage: { reportedJobs: 1, inputTokens: 10, cacheReadInputTokens: 4, outputTokens: 3, reasoningTokens: 2, totalTokens: 13 }
    },
    codex: { available: false, reason: "not installed" }
  };
  const rendered = renderFusionStats(report);
  assert.match(rendered, /Exact token usage coverage: partial \(1 complete, 0 incomplete, 1 unreported\)/);
  assert.match(rendered, /Observed tokens: 13 total, 10 input, 4 cached input, 3 output, 2 reasoning output/);
  assert.match(rendered, /Unavailable jobs are never estimated/);
});

test("rendered Grok usage states when no job reports tokens", () => {
  const rendered = renderFusionStats({
    scope: "all",
    grok: { available: true, totalJobs: 2, byStatus: { done: 2 }, usage: null },
    codex: { available: false, reason: "not installed" }
  });
  assert.match(rendered, /Exact token usage coverage: unavailable \(0 complete, 0 incomplete, 2 unreported\)/);
});

test("rendered Grok usage distinguishes incomplete from unreported jobs", () => {
  const rendered = renderFusionStats({
    scope: "all",
    grok: {
      available: true,
      totalJobs: 3,
      byStatus: { done: 3 },
      usage: { reportedJobs: 1, inputTokens: 10, cacheReadInputTokens: 4, outputTokens: 3, reasoningTokens: 2, totalTokens: 13 },
      usageCoverage: { availability: "partial", completeJobs: 1, incompleteJobs: 1, unreportedJobs: 1 }
    },
    codex: { available: false, reason: "not installed" }
  });
  assert.match(rendered, /Exact token usage coverage: partial \(1 complete, 1 incomplete, 1 unreported\)/);
  assert.match(rendered, /Observed tokens: 13 total/);
});

test("long-term guard audit aggregates recent events without exposing event details", (t) => {
  const dir = sandbox(t);
  const auditDir = path.join(dir, "audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const events = [
    { schemaVersion: 1, at: "2026-07-13T00:00:00.000Z", session: "session-a", event: "write", lane: "main", tool: "Edit", path: "src/a.mjs" },
    { schemaVersion: 1, at: "2026-07-13T00:01:00.000Z", session: "session-a", event: "dispatch", lane: "codex", tool: "Agent", description: "implement repair" },
    { schemaVersion: 1, at: "2026-07-13T00:02:00.000Z", session: "session-b", event: "dispatch", lane: "grok", tool: "Task", description: "review repair" }
  ];
  fs.writeFileSync(path.join(auditDir, "events-2026-07-13.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n{ malformed\n`, "utf8");
  const env = { FUSION_INLINE_GUARD_AUDIT_DIR: auditDir };
  const report = buildAuditReport({ env, days: 7, now: Date.parse("2026-07-14T00:00:00.000Z") });
  assert.deepStrictEqual(report.byEvent, { write: 1, dispatch: 2 });
  assert.deepStrictEqual(report.dispatchesByLane, { codex: 1, grok: 1 });
  assert.strictEqual(report.totalEvents, 3);
  assert.strictEqual(report.sessionCount, 2);
  assert.strictEqual(report.malformedCount, 1);
  const rendered = renderAuditReport(report);
  assert.match(rendered, /Total events: 3/);
  assert.match(rendered, /Malformed audit entries skipped: 1/);
  assert.doesNotMatch(rendered, /src\/a\.mjs|implement repair|review repair/);
});

test("session stats and trace fall back to the long-term audit after short-lived state expires", (t) => {
  const dir = sandbox(t);
  const auditDir = path.join(dir, "audit");
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, "events-2026-07-13.jsonl"),
    `${JSON.stringify({ schemaVersion: 1, at: "2026-07-13T00:00:00.000Z", session: "expired-session", event: "write", lane: "main", tool: "Edit", path: "src/a.mjs" })}\n${JSON.stringify({ schemaVersion: 1, at: "2026-07-13T00:01:00.000Z", session: "expired-session", event: "dispatch", lane: "codex", tool: "Agent", description: "implement repair" })}\n`,
    "utf8"
  );
  const env = {
    FUSION_INLINE_GUARD_STATE: path.join(dir, "missing-state"),
    FUSION_INLINE_GUARD_AUDIT_DIR: auditDir,
    GROK_COMPANION_DATA: path.join(dir, "missing-grok"),
    FUSION_CODEX_STATE: path.join(dir, "missing-codex")
  };
  const session = buildSessionReport({ env, sessionId: "expired-session" });
  assert.deepStrictEqual(session.guard, { writeCount: 1, dispatches: { codex: 1 }, source: "long term audit", malformedCount: 0 });
  const trace = buildTraceReport({ env, cwd: dir, sessionId: "expired-session" });
  assert.strictEqual(trace.timeline.length, 1);
  assert.strictEqual(trace.timeline[0].lane, "codex");
  assert.strictEqual(trace.timeline[0].description, "implement repair");
});

test("--audit supports a recent window, explicit session scope, and JSON output", (t) => {
  const dir = sandbox(t);
  const auditDir = path.join(dir, "audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const now = new Date();
  fs.writeFileSync(
    path.join(auditDir, `events-${now.toISOString().slice(0, 10)}.jsonl`),
    `${JSON.stringify({ schemaVersion: 1, at: now.toISOString(), session: "session-a", event: "dispatch", lane: "codex", tool: "Agent" })}\n${JSON.stringify({ schemaVersion: 1, at: now.toISOString(), session: "session-b", event: "write", lane: "main", tool: "Write", path: "README.md" })}\n`,
    "utf8"
  );
  const result = run(
    { cwd: dir, codexState: path.join(dir, "missing") },
    ["--audit", "--days", "1", "--session", "session-a", "--json"],
    { FUSION_INLINE_GUARD_AUDIT_DIR: auditDir }
  );
  assert.strictEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.scope, "session session-a, last 1 day");
  assert.deepStrictEqual(report.byEvent, { dispatch: 1 });
  assert.deepStrictEqual(report.dispatchesByLane, { codex: 1 });
});
