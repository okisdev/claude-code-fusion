import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFusionStats, renderFusionStats } from "../plugins/fusion/scripts/fusion-stats.mjs";

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
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  assert.equal(digest(JSON.stringify(report, null, 2) + "\n"), "7cd0307e51c50fde9190464adfb5ef56e36b85cc42a5242a794830625f3043c5");
  assert.equal(digest(renderFusionStats(report)), "c65c6cf0f03ef0f16168dd963d1cdb551c76f8a8d779c1a2eb402e7423756b8f");
});
