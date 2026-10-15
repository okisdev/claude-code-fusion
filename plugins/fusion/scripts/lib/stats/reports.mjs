import fs from "node:fs";
import path from "node:path";
import { readAuditEvents as readGuardAuditEvents, resolveStateDir as resolveGuardStateDir, stateFile as guardStateFile } from "../../inline-delegation-guard.mjs";
import { ENGINE_TERMINAL_STATUSES, engineStateRoots } from "../../lib/engines.mjs";
import { canonicalWorkerAgentType, readWorkerRecords } from "../../lib/worker-state.mjs";
import { WORKSPACE_ENGINE_DESCRIPTORS, acceptanceGap, acceptanceSummary, automaticPeerInfrastructureKind, claudeWorkerStats, countJudged, emptyAcceptanceGaps, resolvedEngineAcceptance, workerSnapshot } from "./aggregation.mjs";
import { FILE_ENGINE_DESCRIPTORS, isSupersededCodexJob, resolveAcceptanceEpoch } from "./engine-evidence.mjs";
import { bump, nonEmptyString, selectPreferredJobs } from "./evidence.mjs";
import { spawnSync } from "node:child_process";

function readGuardSessionState(env, sessionId) {
  if (!sessionId) {
    return null;
  }
  const stateDir = resolveGuardStateDir(env);
  const file = guardStateFile(stateDir, sessionId);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        writeCount: Number.isFinite(parsed.writeCount) ? parsed.writeCount : 0,
        dispatches: parsed.dispatches && typeof parsed.dispatches === "object" ? { ...parsed.dispatches } : {},
        source: "session state",
        malformedCount: 0
      };
    }
  } catch {
    void 0;
  }
  const audit = readGuardAuditEvents({ env, sessionId });
  if (audit.events.length === 0) {
    return null;
  }
  const dispatches = {};
  let writeCount = 0;
  for (const event of audit.events) {
    if (event.event === "write") {
      writeCount += 1;
    } else if (event.event === "dispatch") {
      bump(dispatches, event.lane);
    }
  }
  return { writeCount, dispatches, source: "long term audit", malformedCount: audit.malformedCount };
}

function readGuardDispatchLog(env, sessionId) {
  if (!sessionId) {
    return [];
  }
  const stateDir = resolveGuardStateDir(env);
  const file = guardStateFile(stateDir, sessionId);
  let stateEntries = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    stateEntries = Array.isArray(parsed?.dispatchLog) ? parsed.dispatchLog : [];
  } catch {
    void 0;
  }
  const auditEntries = readGuardAuditEvents({ env, sessionId }).events
    .filter((event) => event.event === "dispatch")
    .map((event) => ({ at: event.at, lane: event.lane, ...(event.description ? { description: event.description } : {}) }));
  const merged = new Map();
  for (const entry of [...auditEntries, ...stateEntries]) {
    const key = `${entry?.at ?? ""}\u0000${entry?.lane ?? ""}\u0000${entry?.description ?? ""}`;
    merged.set(key, entry);
  }
  return [...merged.values()].sort((left, right) => (traceTimestamp(left?.at) ?? 0) - (traceTimestamp(right?.at) ?? 0));
}

export function positiveAuditDays(value) {
  if (value == null) {
    return 7;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 3650) {
    throw new TypeError("Fusion audit days must be an integer from 1 to 3650.");
  }
  return parsed;
}

export function buildAuditReport({ env = process.env, sessionId = null, days = 7, all = false, now = Date.now() } = {}) {
  const windowDays = all ? null : positiveAuditDays(days);
  const sinceMs = all ? null : now - windowDays * 24 * 60 * 60 * 1000;
  const { events, malformedCount } = readGuardAuditEvents({ env, sessionId, sinceMs, untilMs: now });
  const windowLabel = all ? "all retained audit events" : `last ${windowDays} ${windowDays === 1 ? "day" : "days"}`;
  const byEvent = {};
  const eventsByDay = {};
  const dispatchesByLane = {};
  const verificationByEvidence = {};
  const sessions = new Set();
  for (const event of events) {
    bump(byEvent, event.event);
    const day = event.at.slice(0, 10);
    const counts = eventsByDay[day] ?? { dispatch: 0, write: 0, deny: 0, warn: 0 };
    counts[event.event] = (counts[event.event] ?? 0) + 1;
    eventsByDay[day] = counts;
    sessions.add(event.session);
    if (event.event === "dispatch") {
      bump(dispatchesByLane, event.lane);
    }
    if (event.event === "verification" && (event.evidence === "exit-status" || event.evidence === "output-summary")) {
      bump(verificationByEvidence, event.evidence);
    }
  }
  return {
    scope: sessionId ? `session ${sessionId}, ${windowLabel}` : windowLabel,
    sessionId,
    days: windowDays,
    totalEvents: events.length,
    sessionCount: sessions.size,
    byEvent,
    eventsByDay,
    dispatchesByLane,
    verificationByEvidence,
    earliestAt: events[0]?.at ?? null,
    latestAt: events.at(-1)?.at ?? null,
    malformedCount
  };
}

function traceTimestamp(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function truncateTraceDescription(value) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 120) : null;
}

function dispatchTraceEntries(env, sessionId) {
  const entries = [];
  for (const entry of readGuardDispatchLog(env, sessionId)) {
    const timestamp = traceTimestamp(entry?.at);
    if (timestamp == null) {
      continue;
    }
    const description = truncateTraceDescription(entry.description);
    entries.push({
      time: entry.at,
      timestamp,
      source: "dispatch",
      lane: typeof entry.lane === "string" && entry.lane ? entry.lane : "unknown",
      ...(typeof entry.subagentType === "string" && entry.subagentType ? { subagentType: entry.subagentType } : {}),
      ...(description ? { description } : {})
    });
  }
  return entries;
}

function traceWorkspaceJobs(descriptor, env) {
  if (!descriptor) {
    return [];
  }
  const root = descriptor.resolveRoot(env);
  const availableRoots = descriptor.multiRootState ? engineStateRoots(descriptor.id, env) : [root];
  if (!availableRoots.some((candidate) => fs.existsSync(candidate))) {
    return [];
  }
  try {
    return descriptor.enumerateJobs(root, { env });
  } catch {
    return [];
  }
}

function resolveTraceGitRoot(cwd) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (!result.error && result.status === 0 && result.stdout.trim()) {
    return path.resolve(result.stdout.trim());
  }
  return path.resolve(cwd);
}

export function formatTraceModel(model, effort) {
  if (!model) {
    return effort ? `unknown@${effort}` : null;
  }
  return effort ? `${model}@${effort}` : model;
}

function engineTraceEntry(raw, { engine, join, model, effort }) {
  const timestamp = traceTimestamp(raw?.createdAt);
  if (timestamp == null) {
    return null;
  }
  return {
    time: raw.createdAt,
    timestamp,
    source: "engine job",
    engine,
    join,
    ...(nonEmptyString(raw?.id) ? { jobId: raw.id } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    status: raw.status ?? "unknown"
  };
}

function traceSpan(entries) {
  if (entries.length === 0) {
    return null;
  }
  const timestamps = entries.map((entry) => entry.timestamp);
  return { start: Math.min(...timestamps) - 60 * 1000, end: Math.max(...timestamps) + 60 * 60 * 1000 };
}

export function buildTraceReport({ env = process.env, cwd = process.cwd(), sessionId = env.CLAUDE_CODE_SESSION_ID || null } = {}) {
  if (!sessionId) {
    return { available: false, reason: "CLAUDE_CODE_SESSION_ID is unset", sessionId: null, workspaceRoot: null, timeline: [] };
  }

  const gitRoot = resolveTraceGitRoot(cwd);
  const dispatches = dispatchTraceEntries(env, sessionId);
  const timeline = [...dispatches];
  for (const record of readWorkerRecords(env)) {
    const agentType = canonicalWorkerAgentType(record.agentType);
    if (record.sessionId !== sessionId || !agentType || agentType === "fusion:job-collector") {
      continue;
    }
    const timestamp = traceTimestamp(record.createdAt);
    if (timestamp == null) {
      continue;
    }
    timeline.push({
      time: record.createdAt,
      timestamp,
      source: "Claude worker",
      engine: "claude",
      join: "exact",
      taskId: record.taskId,
      agentId: record.agentId ?? null,
      backgroundTaskId: record.backgroundTaskId ?? null,
      model: record.resolvedModel ?? null,
      status: record.transportStatus ?? "unknown"
    });
  }
  const span = traceSpan(dispatches);
  for (const descriptor of WORKSPACE_ENGINE_DESCRIPTORS) {
    const repositoryCache = new Map();
    const jobs = traceWorkspaceJobs(descriptor, env).filter((raw) => !descriptor.traceApproximate || FILE_ENGINE_DESCRIPTORS[descriptor.id].matchesWorkspace(raw, cwd, gitRoot, repositoryCache));
    const auditCache = new Map();
    const selected = descriptor.traceApproximate ? selectPreferredJobs(jobs, FILE_ENGINE_DESCRIPTORS[descriptor.id], () => true) : jobs;
    for (const raw of selected) {
      const recordedSessionId = descriptor.sessionOf(raw);
      const createdAt = traceTimestamp(raw?.createdAt);
      const exact = recordedSessionId === sessionId;
      const approximate = descriptor.traceApproximate && !recordedSessionId && span && createdAt != null && createdAt >= span.start && createdAt <= span.end;
      if (!exact && !approximate) {
        continue;
      }
      const model = descriptor.traceModel(raw, env, auditCache);
      const effort = descriptor.traceEffort(raw, env, auditCache);
      const entry = engineTraceEntry(raw, { engine: descriptor.id, join: exact ? "exact" : "approximate", model, effort });
      if (entry) {
        timeline.push(entry);
      }
    }
  }

  timeline.sort((left, right) => left.timestamp - right.timestamp || left.source.localeCompare(right.source));
  return {
    available: true,
    sessionId,
    workspaceRoot: gitRoot,
    timeline: timeline.map(({ timestamp, ...entry }) => entry)
  };
}

function sessionScopedEngineStats(descriptor, sessionId, env, workers) {
  const root = descriptor.resolveRoot(env);
  const availableRoots = descriptor.multiRootState ? engineStateRoots(descriptor.id, env) : [root];
  if (!availableRoots.some((candidate) => fs.existsSync(candidate))) {
    return { available: false, reason: descriptor.unavailableReason };
  }
  const byStatus = {};
  const byAcceptance = {};
  const infrastructureDeaths = { total: 0, byKind: {} };
  const judgedExcludingInfrastructure = acceptanceSummary();
  const verdicts = workers.byPeerJobId;
  const acceptanceGaps = emptyAcceptanceGaps();
  const acceptanceEpoch = resolveAcceptanceEpoch(env);
  let totalJobs = 0;
  let pendingTransportJobs = 0;
  if (sessionId) {
    const jobs = descriptor.enumerateJobs(root, { env });
    const preferredJobs = descriptor.usesSupersededJobs ? selectPreferredJobs(jobs, descriptor, () => true) : [];
    const scoped = selectPreferredJobs(jobs, descriptor, (raw) => descriptor.sessionOf(raw) === sessionId);
    totalJobs = scoped.length;
    for (const raw of scoped) {
      const status = raw.status ?? "unknown";
      bump(byStatus, status);
      if (ENGINE_TERMINAL_STATUSES.has(status)) {
        const acceptance = resolvedEngineAcceptance(raw, descriptor.id, verdicts, descriptor.usesSupersededJobs && isSupersededCodexJob(raw, preferredJobs));
        const joined = verdicts.get(descriptor.id)?.get(raw?.id);
        const infrastructureKind = joined?.infrastructureKind ?? automaticPeerInfrastructureKind(raw, joined);
        bump(byAcceptance, acceptance);
        if (acceptance === "untracked" || acceptance === "unverified") {
          acceptanceGaps[acceptanceGap(raw, joined, acceptanceEpoch)] += 1;
        }
        countJudged(judgedExcludingInfrastructure, acceptance, infrastructureKind);
        if (infrastructureKind) {
          infrastructureDeaths.total += 1;
          bump(infrastructureDeaths.byKind, infrastructureKind);
        }
      } else {
        pendingTransportJobs += 1;
      }
    }
  }
  return {
    available: true,
    totalJobs,
    byStatus,
    byAcceptance,
    acceptanceGaps,
    infrastructureDeaths,
    judgedExcludingInfrastructure,
    acceptanceScope: "terminal transport jobs only",
    pendingTransportJobs,
    ...(descriptor.exposesTransportStatus ? { byTransportStatus: { ...byStatus } } : {})
  };
}

export function buildSessionReport({ env = process.env, sessionId = env.CLAUDE_CODE_SESSION_ID || null } = {}) {
  const engines = {};
  if (!sessionId) {
    const reason = "CLAUDE_CODE_SESSION_ID is unset";
    for (const descriptor of WORKSPACE_ENGINE_DESCRIPTORS) {
      engines[descriptor.id] = { available: false, reason };
    }
    return { available: false, reason, sessionId, guard: null, workers: null, engines };
  }
  const workers = workerSnapshot(env);
  for (const descriptor of WORKSPACE_ENGINE_DESCRIPTORS) {
    engines[descriptor.id] = sessionScopedEngineStats(descriptor, sessionId, env, workers);
  }
  return { available: true, sessionId, guard: readGuardSessionState(env, sessionId), workers: claudeWorkerStats({ all: true, env, sessionId, workers }), engines };
}
