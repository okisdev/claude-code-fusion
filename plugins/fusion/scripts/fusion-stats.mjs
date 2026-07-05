#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function newestGrokCompanion(env = process.env) {
  const override = env.FUSION_GROK_COMPANION;
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

export function grokStats({ all = false, env = process.env, cwd = process.cwd() } = {}) {
  const bin = newestGrokCompanion(env);
  if (!bin) {
    return { available: false, reason: "grok companion not found in the plugin cache or the sibling plugin" };
  }
  const result = spawnSync(process.execPath, [bin, "stats", ...(all ? ["--all"] : ["--cwd", cwd]), "--json"], { encoding: "utf8", env });
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

function resolveStateRoot(descriptor, env) {
  const override = env[descriptor.stateEnvVar];
  return override || descriptor.defaultStateRoot(env);
}

function readWorkspaceJobFiles(stateRoot) {
  const jobs = [];
  for (const workspace of fs.readdirSync(stateRoot)) {
    const dir = path.join(stateRoot, workspace, "jobs");
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
  return jobs;
}

export const FILE_ENGINE_DESCRIPTORS = {
  codex: {
    id: "codex",
    stateEnvVar: "FUSION_CODEX_STATE",
    defaultStateRoot: () => path.join(os.homedir(), ".claude", "plugins", "data", "codex-openai-codex", "state"),
    unavailableReason: "codex plugin job state not found; the codex plugin may not be installed",
    note: "read best effort from the codex plugin's internal job state",
    enumerateJobs: readWorkspaceJobFiles,
    matchesWorkspace: (raw, cwd) => raw.workspaceRoot === cwd,
    normalizeJob(raw) {
      const finished = raw.completedAt ?? raw.updatedAt ?? null;
      let durationSeconds = null;
      if (raw.status === "completed" && raw.startedAt && finished) {
        const span = (Date.parse(finished) - Date.parse(raw.startedAt)) / 1000;
        if (Number.isFinite(span) && span >= 0) {
          durationSeconds = span;
        }
      }
      return {
        status: raw.status ?? "unknown",
        kind: raw.jobClass ?? raw.kind ?? "unknown",
        createdAt: raw.createdAt ?? null,
        durationSeconds
      };
    }
  }
};

export function fileBasedEngineStats(descriptor, { all = false, env = process.env, cwd = process.cwd() } = {}) {
  const root = resolveStateRoot(descriptor, env);
  if (!fs.existsSync(root)) {
    return { available: false, reason: descriptor.unavailableReason };
  }
  let jobs;
  try {
    jobs = descriptor.enumerateJobs(root);
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const scoped = all ? jobs : jobs.filter((job) => descriptor.matchesWorkspace(job, cwd));
  const byStatus = {};
  const byKind = {};
  let durationSum = 0;
  let durationCount = 0;
  let earliest = null;
  let latest = null;
  for (const raw of scoped) {
    const job = descriptor.normalizeJob(raw);
    bump(byStatus, job.status);
    bump(byKind, job.kind);
    if (job.durationSeconds != null) {
      durationSum += job.durationSeconds;
      durationCount += 1;
    }
    const created = job.createdAt;
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
    note: descriptor.note
  };
}

export function codexStats(options = {}) {
  return fileBasedEngineStats(FILE_ENGINE_DESCRIPTORS.codex, options);
}

export const STATS_PROVIDER_REGISTRY = [
  {
    id: "grok",
    displayName: "Grok",
    collect: (options) => grokStats(options)
  },
  {
    id: "codex",
    displayName: "Codex",
    collect: (options) => fileBasedEngineStats(FILE_ENGINE_DESCRIPTORS.codex, options)
  }
];

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

export function buildFusionStats({ all = false, env = process.env, cwd = process.cwd() } = {}) {
  const options = { all, env, cwd };
  const engines = {};
  for (const provider of STATS_PROVIDER_REGISTRY) {
    engines[provider.id] = provider.collect(options);
  }
  return {
    scope: all ? "all" : cwd,
    ...engines
  };
}

export function renderFusionStats(report) {
  const lines = ["# Fusion stats", "", `Scope: ${report.scope === "all" ? "all workspaces" : `workspace ${report.scope}`}`];
  for (const provider of STATS_PROVIDER_REGISTRY) {
    renderEngine(lines, provider.displayName, report[provider.id]);
  }
  lines.push("", "Token usage lives with each vendor: ccusage for the Claude side, the OpenAI and xAI dashboards for the peers.");
  return `${lines.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2), { env = process.env, cwd = process.cwd(), stdout = process.stdout } = {}) {
  const all = argv.includes("--all");
  const asJson = argv.includes("--json");
  const report = buildFusionStats({ all, env, cwd });
  if (asJson) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stdout.write(renderFusionStats(report));
  }
  return report;
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  main();
}