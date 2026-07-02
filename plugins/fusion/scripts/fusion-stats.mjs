#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const all = args.includes("--all");
const asJson = args.includes("--json");

function newestGrokCompanion() {
  const override = process.env.FUSION_GROK_COMPANION;
  if (override) {
    return fs.existsSync(override) ? override : null;
  }
  const base = path.join(os.homedir(), ".claude", "plugins", "cache", "claude-code-fusion", "grok");
  try {
    const candidates = fs
      .readdirSync(base)
      .map((version) => path.join(base, version, "scripts", "grok-companion.mjs"))
      .filter((candidate) => fs.existsSync(candidate))
      .map((candidate) => ({ candidate, mtime: fs.statSync(candidate).mtimeMs }))
      .sort((left, right) => right.mtime - left.mtime);
    if (candidates.length > 0) {
      return candidates[0].candidate;
    }
  } catch {
    void 0;
  }
  const sibling = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "grok", "scripts", "grok-companion.mjs");
  return fs.existsSync(sibling) ? sibling : null;
}

function grokStats() {
  const bin = newestGrokCompanion();
  if (!bin) {
    return { available: false, reason: "grok companion not found in the plugin cache or the sibling plugin" };
  }
  const result = spawnSync(process.execPath, [bin, "stats", ...(all ? ["--all"] : []), "--json"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const reason = (result.stderr || result.error?.message || "grok stats failed").trim().split("\n")[0];
    return { available: false, reason };
  }
  try {
    return { available: true, ...JSON.parse(result.stdout) };
  } catch {
    return { available: false, reason: "grok stats returned unparseable output" };
  }
}

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function codexStats() {
  const root = process.env.FUSION_CODEX_STATE || path.join(os.homedir(), ".claude", "plugins", "data", "codex-openai-codex", "state");
  if (!fs.existsSync(root)) {
    return { available: false, reason: "codex plugin job state not found; the codex plugin may not be installed" };
  }
  const jobs = [];
  try {
    for (const workspace of fs.readdirSync(root)) {
      const dir = path.join(root, workspace, "jobs");
      if (!fs.existsSync(dir)) {
        continue;
      }
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith(".json")) {
          continue;
        }
        try {
          jobs.push(JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")));
        } catch {
          void 0;
        }
      }
    }
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const cwd = process.cwd();
  const scoped = all ? jobs : jobs.filter((job) => job.workspaceRoot === cwd);
  const byStatus = {};
  const byKind = {};
  let durationSum = 0;
  let durationCount = 0;
  let earliest = null;
  let latest = null;
  for (const job of scoped) {
    bump(byStatus, job.status ?? "unknown");
    bump(byKind, job.jobClass ?? job.kind ?? "unknown");
    const finished = job.completedAt ?? job.updatedAt ?? null;
    if (job.status === "completed" && job.startedAt && finished) {
      const span = (Date.parse(finished) - Date.parse(job.startedAt)) / 1000;
      if (Number.isFinite(span) && span >= 0) {
        durationSum += span;
        durationCount += 1;
      }
    }
    const created = job.createdAt ?? null;
    if (created) {
      if (!earliest || created < earliest) {
        earliest = created;
      }
      if (!latest || created > latest) {
        latest = created;
      }
    }
  }
  return {
    available: true,
    scope: all ? "all" : cwd,
    totalJobs: scoped.length,
    byStatus,
    byKind,
    meanWallClockSeconds: durationCount > 0 ? Math.round((durationSum / durationCount) * 1000) / 1000 : null,
    earliestCreatedAt: earliest,
    latestCreatedAt: latest,
    note: "read best effort from the codex plugin's internal job state"
  };
}

function renderCounts(lines, title, map) {
  const keys = Object.keys(map);
  if (keys.length === 0) {
    return;
  }
  lines.push("", `${title}:`);
  for (const key of keys.sort()) {
    lines.push(`- ${key}: ${map[key]}`);
  }
}

function renderEngine(lines, name, stats) {
  lines.push("", `## ${name}`);
  if (!stats.available) {
    lines.push("", `Unavailable: ${stats.reason}`);
    return;
  }
  lines.push("", `Total jobs: ${stats.totalJobs}`);
  if (stats.earliestCreatedAt && stats.latestCreatedAt) {
    lines.push(`Created between ${stats.earliestCreatedAt} and ${stats.latestCreatedAt}`);
  }
  if (stats.meanWallClockSeconds != null) {
    lines.push(`Mean wall clock for finished jobs: ${stats.meanWallClockSeconds}s`);
  }
  renderCounts(lines, "By status", stats.byStatus ?? {});
  renderCounts(lines, "By mode", stats.byMode ?? {});
  renderCounts(lines, "By kind", stats.byKind ?? {});
  renderCounts(lines, "By failure kind", stats.byFailureKind ?? {});
}

const grok = grokStats();
const codex = codexStats();

if (asJson) {
  console.log(JSON.stringify({ scope: all ? "all" : process.cwd(), grok, codex }, null, 2));
} else {
  const lines = ["# Fusion stats", "", `Scope: ${all ? "all workspaces" : `workspace ${process.cwd()}`}`];
  renderEngine(lines, "Grok", grok);
  renderEngine(lines, "Codex", codex);
  lines.push("", "Token usage lives with each vendor: ccusage for the Claude side, the OpenAI and xAI dashboards for the peers.");
  process.stdout.write(`${lines.join("\n")}\n`);
}
