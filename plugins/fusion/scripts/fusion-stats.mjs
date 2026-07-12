#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStateDir as resolveGuardStateDir, stateFile as guardStateFile } from "./inline-delegation-guard.mjs";

const GROK_DATA_DIR_ENV = "GROK_COMPANION_DATA";
const FUSION_DATA_DIR_ENV = "FUSION_DATA_DIR";
const CODEX_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const GROK_TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);
const PRUNE_EVIDENCE = Symbol("pruneEvidence");

export function fusionWorkspaceKey(workspaceRoot) {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}

export function resolveFusionDataDir(env = process.env) {
  const override = env[FUSION_DATA_DIR_ENV];
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "fusion-claude-code-fusion");
}

export function modelAuditSidecarPath(workspaceRoot, env = process.env) {
  return path.join(resolveFusionDataDir(env), "observations", fusionWorkspaceKey(workspaceRoot), "model-audit.jsonl");
}

export function loadModelAuditObservations(sidecarPath) {
  const byJobId = new Map();
  let text;
  try {
    text = fs.readFileSync(sidecarPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      void 0;
    }
    return byJobId;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const observation = JSON.parse(line);
      if (observation?.jobId && typeof observation.jobId === "string" && !byJobId.has(observation.jobId)) {
        byJobId.set(observation.jobId, observation);
      }
    } catch {
      void 0;
    }
  }
  return byJobId;
}

function nonEmptyString(value) {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
}

export function resolveCodexJobModel(raw, observation) {
  return nonEmptyString(raw?.request?.model) ?? nonEmptyString(observation?.model) ?? "unknown";
}

export function resolveCodexJobEffort(raw, observation) {
  return nonEmptyString(raw?.request?.effort) ?? nonEmptyString(observation?.effort) ?? null;
}

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

function resolveGrokDataDir(env = process.env) {
  const override = env[GROK_DATA_DIR_ENV];
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "grok-claude-code-fusion");
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
    includeByModel: true,
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
    },
    resolveModel(raw, observation) {
      return resolveCodexJobModel(raw, observation);
    }
  }
};

function observationForJob(raw, env, auditCache) {
  const workspaceRoot = typeof raw?.workspaceRoot === "string" ? raw.workspaceRoot : null;
  if (!workspaceRoot) {
    return null;
  }
  if (!auditCache.has(workspaceRoot)) {
    auditCache.set(workspaceRoot, loadModelAuditObservations(modelAuditSidecarPath(workspaceRoot, env)));
  }
  const jobId = typeof raw?.id === "string" ? raw.id : null;
  if (!jobId) {
    return null;
  }
  return auditCache.get(workspaceRoot).get(jobId) ?? null;
}

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
  const byModel = {};
  const auditCache = new Map();
  let durationSum = 0;
  let durationCount = 0;
  let earliest = null;
  let latest = null;
  for (const raw of scoped) {
    const job = descriptor.normalizeJob(raw);
    bump(byStatus, job.status);
    bump(byKind, job.kind);
    if (descriptor.includeByModel && typeof descriptor.resolveModel === "function") {
      bump(byModel, descriptor.resolveModel(raw, observationForJob(raw, env, auditCache)));
    }
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
    ...(descriptor.includeByModel ? { byModel } : {}),
    meanWallClockSeconds: durationCount > 0 ? Math.round((durationSum / durationCount) * 1000) / 1000 : null,
    earliestCreatedAt: earliest,
    latestCreatedAt: latest,
    note: descriptor.note
  };
}

export function codexStats(options = {}) {
  return fileBasedEngineStats(FILE_ENGINE_DESCRIPTORS.codex, options);
}

function listWorkspaceEntries(stateRoot) {
  if (!fs.existsSync(stateRoot)) {
    return [];
  }
  return fs
    .readdirSync(stateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function readJobFilesInWorkspace(stateRoot, workspace) {
  const dir = path.join(stateRoot, workspace, "jobs");
  if (!fs.existsSync(dir)) {
    return [];
  }
  const jobs = [];
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
  return jobs;
}

export const WORKSPACE_ENGINE_DESCRIPTORS = [
  {
    id: "grok",
    displayName: "Grok",
    unavailableReason: "grok plugin job state not found; the grok plugin may not be installed",
    resolveRoot: (env) => path.join(resolveGrokDataDir(env), "state"),
    cwdOf: (raw) => (typeof raw.cwd === "string" ? raw.cwd : null),
    sessionOf: (raw) => (typeof raw.claudeSessionId === "string" ? raw.claudeSessionId : null),
    isLive: (raw) => !GROK_TERMINAL_STATUSES.has(raw.status)
  },
  {
    id: "codex",
    displayName: "Codex",
    unavailableReason: FILE_ENGINE_DESCRIPTORS.codex.unavailableReason,
    resolveRoot: (env) => resolveStateRoot(FILE_ENGINE_DESCRIPTORS.codex, env),
    cwdOf: (raw) => (typeof raw.workspaceRoot === "string" ? raw.workspaceRoot : null),
    sessionOf: (raw) => (typeof raw.sessionId === "string" ? raw.sessionId : null),
    isLive: (raw) => !CODEX_TERMINAL_STATUSES.has(raw.status)
  }
];

function readGuardSessionState(env, sessionId) {
  if (!sessionId) {
    return null;
  }
  const stateDir = resolveGuardStateDir(env);
  const file = guardStateFile(stateDir, sessionId);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      writeCount: Number.isFinite(parsed.writeCount) ? parsed.writeCount : 0,
      dispatches: parsed.dispatches && typeof parsed.dispatches === "object" ? { ...parsed.dispatches } : {}
    };
  } catch {
    return null;
  }
}

function sessionScopedEngineStats(descriptor, sessionId, env) {
  const root = descriptor.resolveRoot(env);
  if (!fs.existsSync(root)) {
    return { available: false, reason: descriptor.unavailableReason };
  }
  const byStatus = {};
  let totalJobs = 0;
  if (sessionId) {
    for (const workspace of listWorkspaceEntries(root)) {
      for (const raw of readJobFilesInWorkspace(root, workspace)) {
        if (descriptor.sessionOf(raw) !== sessionId) {
          continue;
        }
        totalJobs += 1;
        bump(byStatus, raw.status ?? "unknown");
      }
    }
  }
  return { available: true, totalJobs, byStatus };
}

export function buildSessionReport({ env = process.env } = {}) {
  const sessionId = env.CLAUDE_CODE_SESSION_ID || null;
  const engines = {};
  if (!sessionId) {
    const reason = "CLAUDE_CODE_SESSION_ID is unset";
    for (const descriptor of WORKSPACE_ENGINE_DESCRIPTORS) {
      engines[descriptor.id] = { available: false, reason };
    }
    return { available: false, reason, sessionId, guard: null, engines };
  }
  for (const descriptor of WORKSPACE_ENGINE_DESCRIPTORS) {
    engines[descriptor.id] = sessionScopedEngineStats(descriptor, sessionId, env);
  }
  return { available: true, sessionId, guard: readGuardSessionState(env, sessionId), engines };
}

export function renderSessionReport(report) {
  const lines = ["# Fusion session stats", "", `Session: ${report.sessionId ?? "unset"}`, "", "## Inline guard"];
  if (report.available === false) {
    lines.push("", `Session data unavailable: ${report.reason}`, "", "no dispatches recorded");
  } else if (!report.guard) {
    lines.push("", "no dispatches recorded");
  } else {
    lines.push("", `Write tool calls: ${report.guard.writeCount}`);
    renderCounts(lines, "Agent dispatches by lane", report.guard.dispatches);
  }
  for (const descriptor of WORKSPACE_ENGINE_DESCRIPTORS) {
    const stats = report.engines[descriptor.id];
    lines.push("", `## ${descriptor.displayName} jobs (session scope)`);
    if (!stats.available) {
      lines.push("", `Unavailable: ${stats.reason}`);
      continue;
    }
    lines.push("", `Total jobs: ${stats.totalJobs}`);
    renderCounts(lines, "By status", stats.byStatus);
  }
  return `${lines.join("\n")}\n`;
}

function isWorkspaceDead(jobs, descriptor) {
  for (const raw of jobs) {
    if (descriptor.isLive(raw)) {
      return false;
    }
    const cwd = descriptor.cwdOf(raw);
    if (typeof cwd !== "string" || !cwd.trim() || !path.isAbsolute(cwd) || !isPathPositivelyAbsent(cwd)) {
      return false;
    }
  }
  return true;
}

function isPathPositivelyAbsent(target) {
  try {
    fs.statSync(target);
    return false;
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR";
  }
}

function readPruneSnapshot(stateRoot, workspace) {
  const dir = path.join(stateRoot, workspace, "jobs");
  try {
    const initialStat = fs.statSync(dir);
    if (!initialStat.isDirectory()) {
      return null;
    }
    const entries = fs.readdirSync(dir).sort();
    const jobEntries = entries.filter((entry) => entry.endsWith(".json"));
    if (jobEntries.length === 0) {
      return null;
    }
    const jobs = jobEntries.map((entry) => JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")));
    const verifiedEntries = fs.readdirSync(dir).sort();
    const verifiedStat = fs.statSync(dir);
    if (initialStat.mtimeMs !== verifiedStat.mtimeMs || entries.length !== verifiedEntries.length || entries.some((entry, index) => entry !== verifiedEntries[index])) {
      return null;
    }
    return { dir, entries, jobs, mtimeMs: verifiedStat.mtimeMs };
  } catch {
    return null;
  }
}

function sameEntries(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function stillSafeToPrune(candidate, descriptor) {
  const evidence = candidate[PRUNE_EVIDENCE];
  if (!evidence) {
    return false;
  }
  const current = readPruneSnapshot(evidence.stateRoot, candidate.workspace);
  return current !== null && current.mtimeMs === evidence.mtimeMs && sameEntries(current.entries, evidence.entries) && isWorkspaceDead(current.jobs, descriptor);
}

function scanDeadWorkspaces(descriptor, env) {
  const root = descriptor.resolveRoot(env);
  if (!fs.existsSync(root)) {
    return [];
  }
  const candidates = [];
  for (const workspace of listWorkspaceEntries(root)) {
    const snapshot = readPruneSnapshot(root, workspace);
    if (!snapshot || !isWorkspaceDead(snapshot.jobs, descriptor)) {
      continue;
    }
    const candidate = { workspace, dir: path.join(root, workspace), jobCount: snapshot.jobs.length };
    Object.defineProperty(candidate, PRUNE_EVIDENCE, {
      value: { stateRoot: root, entries: snapshot.entries, mtimeMs: snapshot.mtimeMs }
    });
    candidates.push(candidate);
  }
  return candidates;
}

export function findDeadWorkspaces(env = process.env) {
  const dead = {};
  for (const descriptor of WORKSPACE_ENGINE_DESCRIPTORS) {
    dead[descriptor.id] = scanDeadWorkspaces(descriptor, env);
  }
  return dead;
}

export function pruneDeadWorkspaces({ env = process.env, yes = false, beforeRemove } = {}) {
  const dead = findDeadWorkspaces(env);
  if (!yes) {
    return { applied: false, dead };
  }
  const removed = {};
  for (const [engineId, candidates] of Object.entries(dead)) {
    removed[engineId] = [];
    const descriptor = WORKSPACE_ENGINE_DESCRIPTORS.find((entry) => entry.id === engineId);
    for (const candidate of candidates) {
      if (beforeRemove) {
        beforeRemove(candidate, descriptor);
      }
      if (!descriptor || !stillSafeToPrune(candidate, descriptor)) {
        continue;
      }
      fs.rmSync(candidate.dir, { recursive: true, force: true });
      removed[engineId].push(candidate);
    }
  }
  return { applied: true, dead: removed };
}

export function renderPruneReport(result) {
  const lines = [`# Fusion dead workspace ${result.applied ? "prune" : "prune (dry run)"}`];
  for (const descriptor of WORKSPACE_ENGINE_DESCRIPTORS) {
    const candidates = result.dead[descriptor.id] ?? [];
    lines.push("", `## ${descriptor.displayName}`);
    if (candidates.length === 0) {
      lines.push("", "no dead workspace directories found");
      continue;
    }
    lines.push("");
    for (const candidate of candidates) {
      lines.push(`- ${candidate.dir} (${candidate.jobCount} job${candidate.jobCount === 1 ? "" : "s"})`);
    }
  }
  lines.push(
    "",
    result.applied
      ? "removed the directories listed above"
      : "dry run: rerun with --prune-dead --yes to delete these directories"
  );
  return `${lines.join("\n")}\n`;
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
  renderCounts(lines, "By model", stats.byModel ?? {});
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
  const asJson = argv.includes("--json");

  if (argv.includes("--prune-dead")) {
    const result = pruneDeadWorkspaces({ env, yes: argv.includes("--yes") });
    stdout.write(asJson ? `${JSON.stringify(result, null, 2)}\n` : renderPruneReport(result));
    return result;
  }

  if (argv.includes("--session")) {
    const report = buildSessionReport({ env });
    stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : renderSessionReport(report));
    return report;
  }

  const all = argv.includes("--all");
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
