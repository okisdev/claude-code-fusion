import fs from "node:fs";
import { listAuditSegments as listGuardAuditSegments, normalizeAuditEvent as normalizeGuardAuditEvent, readAuditEvents as readGuardAuditEvents, resolveAuditDir as resolveGuardAuditDir } from "../../inline-delegation-guard.mjs";
import { bump, nonEmptyString } from "./evidence.mjs";
import { messageCode } from "../user-messages.mjs";

const DEFAULT_FLEET_WAVE_GAP_MS = 120000;
export const FLEET_SHAPED_MIN_WIDTH = 3;
const COERCION_LEDGER_EVENTS = new Set(["dispatch", "write", "deny", "warn", "verification"]);
const COERCION_LEDGER_WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit", "Bash"]);
const COERCION_LEDGER_SPRAWL_MULTIPLE = 2;
const COERCION_LEDGER_DEFAULT_BUDGET = 5;

function emptyFleetUsageStats() {
  return {
    surface: "ultra",
    totalDispatches: 0,
    totalBursts: 0,
    fleetShapedBursts: 0,
    widthDistribution: {},
    byDay: {},
    widest: null
  };
}

function fleetWaveGapMs(env) {
  const parsed = Number.parseInt(String(env.FUSION_FLEET_WAVE_GAP_MS), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_FLEET_WAVE_GAP_MS;
}

export function clusterDispatchBursts(dispatchEvents, gapMs = DEFAULT_FLEET_WAVE_GAP_MS) {
  const bySession = new Map();
  for (const event of dispatchEvents) {
    const session = nonEmptyString(event?.session);
    const at = nonEmptyString(event?.at);
    const atMs = at ? Date.parse(at) : Number.NaN;
    if (!session || !Number.isFinite(atMs)) {
      continue;
    }
    const list = bySession.get(session) ?? [];
    list.push({ at, atMs, session, day: at.slice(0, 10), messageId: nonEmptyString(event?.messageId) });
    bySession.set(session, list);
  }
  const bursts = [];
  for (const [session, events] of bySession) {
    events.sort((left, right) => left.atMs - right.atMs || left.at.localeCompare(right.at));
    let current = null;
    let previous = null;
    for (const event of events) {
      const sameWave = previous && (previous.messageId && event.messageId ? previous.messageId === event.messageId : event.atMs - previous.atMs <= gapMs);
      if (!sameWave) {
        current = {
          session,
          day: event.day,
          width: 1,
          firstAt: event.at,
          lastAt: event.at,
          lastAtMs: event.atMs
        };
        bursts.push(current);
      } else {
        current.width += 1;
        current.lastAt = event.at;
        current.lastAtMs = event.atMs;
      }
      previous = event;
    }
  }
  return bursts;
}

function summarizeFleetBursts(bursts) {
  const widthDistribution = {};
  const byDay = {};
  let fleetShapedBursts = 0;
  let widest = null;
  for (const burst of bursts) {
    bump(widthDistribution, String(burst.width));
    if (burst.width >= FLEET_SHAPED_MIN_WIDTH) {
      fleetShapedBursts += 1;
    }
    if (!widest || burst.width > widest.width || (burst.width === widest.width && (burst.firstAt < widest.at || (burst.firstAt === widest.at && burst.session < widest.session)))) {
      widest = { width: burst.width, session: burst.session, day: burst.day, at: burst.firstAt };
    }
    const dayStats = byDay[burst.day] ?? {
      bursts: 0,
      fleetShapedBursts: 0,
      widthDistribution: {},
      widest: null
    };
    dayStats.bursts += 1;
    bump(dayStats.widthDistribution, String(burst.width));
    if (burst.width >= FLEET_SHAPED_MIN_WIDTH) {
      dayStats.fleetShapedBursts += 1;
    }
    if (!dayStats.widest || burst.width > dayStats.widest.width || (burst.width === dayStats.widest.width && (burst.firstAt < dayStats.widest.at || (burst.firstAt === dayStats.widest.at && burst.session < dayStats.widest.session)))) {
      dayStats.widest = { width: burst.width, session: burst.session, at: burst.firstAt };
    }
    byDay[burst.day] = dayStats;
  }
  return {
    surface: "ultra",
    totalDispatches: bursts.reduce((sum, burst) => sum + burst.width, 0),
    totalBursts: bursts.length,
    fleetShapedBursts,
    widthDistribution,
    byDay,
    widest: widest ? { width: widest.width, session: widest.session, day: widest.day } : null
  };
}

function narrowWaveWatch(dispatchEvents, gapMs) {
  const byDaySession = new Map();
  for (const event of dispatchEvents) {
    const session = nonEmptyString(event?.session);
    const at = nonEmptyString(event?.at);
    const atMs = at ? Date.parse(at) : Number.NaN;
    if (!session || !Number.isFinite(atMs)) {
      continue;
    }
    const day = at.slice(0, 10);
    const key = `${day}\u0000${session}`;
    const events = byDaySession.get(key) ?? [];
    events.push({ at, atMs, session, day, messageId: event.messageId });
    byDaySession.set(key, events);
  }
  return [...byDaySession.values()]
    .filter((events) => events.length >= 8)
    .map((events) => ({ day: events[0].day, session: events[0].session, dispatches: events.length, bursts: clusterDispatchBursts(events, gapMs) }))
    .filter((entry) => entry.bursts.every((burst) => burst.width === 1))
    .sort((left, right) => left.day.localeCompare(right.day) || left.session.localeCompare(right.session))
    .map(({ day, session, dispatches }) => ({ day, session, dispatches }));
}

/**
 * Derive ultra / fleet visibility from inline-guard audit dispatch events.
 * Pure read-side: clusters same-session dispatches within a short window into bursts.
 */
export function buildFleetUsageStats({ env = process.env, audit = null } = {}) {
  let events;
  try {
    events = audit ? audit.guardEvents : readGuardAuditEvents({ env }).events;
  } catch {
    return emptyFleetUsageStats();
  }
  const dispatches = events.filter((event) => event?.event === "dispatch");
  if (dispatches.length === 0) {
    return emptyFleetUsageStats();
  }
  const gapMs = fleetWaveGapMs(env);
  const fleet = summarizeFleetBursts(clusterDispatchBursts(dispatches, gapMs));
  const watch = narrowWaveWatch(dispatches, gapMs);
  return watch.length > 0 ? { ...fleet, narrowWaveWatch: watch } : fleet;
}

function emptyCoercionLedger(fleetShapedWaves = 0) {
  return {
    readStreakAdvisories: 0,
    fleetShapedWaves,
    verificationResets: 0,
    inlineSprawlWindows: 0,
    deepestUnverifiedWindow: 0
  };
}

function normalizeCoercionAuditEvent(value, guardEvent) {
  if (value?.event === "replay") {
    return guardEvent ? { ...guardEvent, atMs: Date.parse(guardEvent.at) } : null;
  }
  if (!value || typeof value !== "object" || value.schemaVersion !== 1 || typeof value.at !== "string" || typeof value.session !== "string" || typeof value.event !== "string") {
    return null;
  }
  const atMs = Date.parse(value.at);
  const session = value.session.trim();
  if (!Number.isFinite(atMs) || !session) {
    return null;
  }
  if (!COERCION_LEDGER_EVENTS.has(value.event)) {
    return null;
  }
  if (value.event === "verification" && value.lane !== "main") {
    return null;
  }
  const mainWriteObservation = ["write", "warn"].includes(value.event) && value.lane === "main" && COERCION_LEDGER_WRITE_TOOLS.has(value.tool);
  const heartbeatDeny = value.event === "deny" && value.tool === "Bash" && value.messageCode === messageCode("inline-guard.no-op-heartbeat-deny");
  const unverifiedWindowWrites = mainWriteObservation && Number.isInteger(value.writeCount) && value.writeCount >= 0 ? value.writeCount : null;
  const budget = Number.isInteger(value.budget) && value.budget > 0 ? value.budget : null;
  const replayTokens = !heartbeatDeny && value.lane === "main" && ["write", "warn", "deny", "verification"].includes(value.event) && Number.isSafeInteger(value.replayTokens) && value.replayTokens >= 0 ? value.replayTokens : null;
  return {
    atMs,
    session,
    event: value.event,
    writeCount: value.event === "verification" && Number.isInteger(value.writeCount) ? value.writeCount : null,
    readStreakAdvisory: value.event === "warn" && value.reason === "read-streak-advisory",
    unverifiedWindowWrites,
    inlineSprawl: replayTokens !== null
      ? budget !== null && replayTokens >= COERCION_LEDGER_SPRAWL_MULTIPLE * budget
      : unverifiedWindowWrites !== null && unverifiedWindowWrites >= COERCION_LEDGER_SPRAWL_MULTIPLE * (budget ?? COERCION_LEDGER_DEFAULT_BUDGET)
  };
}

export function readStatsAuditEvents(env, { sessionId = null, sinceMs = null, untilMs = null } = {}) {
  const events = [];
  const guardEvents = [];
  let malformedCount = 0;
  let order = 0;
  let firstDay = null;
  let lastDay = null;
  try {
    const segments = listGuardAuditSegments(resolveGuardAuditDir(env)).sort((left, right) => left.date.localeCompare(right.date) || left.index - right.index);
    for (const segment of segments) {
      let text;
      try {
        text = fs.readFileSync(segment.file, "utf8");
      } catch {
        malformedCount += 1;
        continue;
      }
      firstDay = firstDay ?? segment.date;
      lastDay = segment.date;
      for (const line of text.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        try {
          const value = JSON.parse(line);
          const guardEvent = normalizeGuardAuditEvent(value);
          if (!guardEvent) {
            malformedCount += 1;
          } else {
            const atMs = Date.parse(guardEvent.at);
            if ((sessionId == null || guardEvent.session === sessionId) && (sinceMs == null || atMs >= sinceMs) && (untilMs == null || atMs <= untilMs)) {
              guardEvents.push(guardEvent);
            }
          }
          const event = normalizeCoercionAuditEvent(value, guardEvent);
          if (event && (sessionId == null || event.session === sessionId) && (sinceMs == null || event.atMs >= sinceMs) && (untilMs == null || event.atMs <= untilMs)) {
            events.push({ ...event, order });
            order += 1;
          }
        } catch {
          malformedCount += 1;
        }
      }
    }
  } catch {
    return { events: [], guardEvents: [], malformedCount, startMs: null, endMs: null };
  }
  return {
    events: events.sort((left, right) => left.atMs - right.atMs || left.order - right.order),
    guardEvents: guardEvents.sort((left, right) => Date.parse(left.at) - Date.parse(right.at)),
    malformedCount,
    startMs: sinceMs ?? (firstDay ? Date.parse(`${firstDay}T00:00:00.000Z`) : null),
    endMs: lastDay ? Date.parse(`${lastDay}T00:00:00.000Z`) + 86400000 : null
  };
}

function inlineWindowFor(windows, session) {
  if (!windows.has(session)) {
    windows.set(session, { sprawl: false });
  }
  return windows.get(session);
}

function closeInlineWindow(summary, window) {
  if (window.sprawl) {
    summary.inlineSprawlWindows += 1;
  }
  window.sprawl = false;
}

function summarizeInlineWindows(events) {
  const windows = new Map();
  const summary = { inlineSprawlWindows: 0, deepestUnverifiedWindow: 0 };
  for (const event of events) {
    const window = inlineWindowFor(windows, event.session);
    window.sprawl ||= event.inlineSprawl === true;
    if (event.event === "verification") {
      closeInlineWindow(summary, window);
      continue;
    }
    if (event.event === "dispatch") {
      closeInlineWindow(summary, window);
      continue;
    }
    if (event.unverifiedWindowWrites != null) {
      summary.deepestUnverifiedWindow = Math.max(summary.deepestUnverifiedWindow, event.unverifiedWindowWrites);
    }
  }
  for (const window of windows.values()) {
    closeInlineWindow(summary, window);
  }
  return summary;
}

export function buildCoercionLedger({ env = process.env, fleet = null, audit = null } = {}) {
  const fleetShapedWaves = Number.isSafeInteger(fleet?.fleetShapedBursts) && fleet.fleetShapedBursts >= 0 ? fleet.fleetShapedBursts : buildFleetUsageStats({ env }).fleetShapedBursts;
  const ledger = emptyCoercionLedger(fleetShapedWaves);
  const events = (audit ?? readStatsAuditEvents(env)).events;
  for (const event of events) {
    if (event.readStreakAdvisory) {
      ledger.readStreakAdvisories += 1;
    }
    if (event.event === "verification" && event.writeCount > 0) {
      ledger.verificationResets += 1;
    }
  }
  Object.assign(ledger, summarizeInlineWindows(events));
  return ledger;
}

export function hasCoercionLedgerData(ledger) {
  if (!ledger || typeof ledger !== "object") {
    return false;
  }
  return (
    ["readStreakAdvisories", "fleetShapedWaves", "verificationResets", "inlineSprawlWindows", "deepestUnverifiedWindow"].some(
      (key) => (ledger[key] ?? 0) > 0
    )
  );
}
