import { STATS_PROVIDER_REGISTRY, WORKSPACE_ENGINE_DESCRIPTORS, acceptanceSummary } from "./aggregation.mjs";
import { COERCION_LEDGER_SMALL_FLEET_SHAPED_WAVES, FLEET_SHAPED_MIN_WIDTH, hasCoercionLedgerData } from "./fleet.mjs";
import { formatTraceModel } from "./reports.mjs";

export function renderAuditReport(report) {
  const lines = ["# Fusion inline audit", "", `Scope: ${report.scope}`, "", `Total events: ${report.totalEvents}`, `Sessions: ${report.sessionCount}`];
  if (report.earliestAt && report.latestAt) {
    lines.push(`Recorded between ${report.earliestAt} and ${report.latestAt}`);
  }
  renderCounts(lines, "By event", report.byEvent);
  const days = Object.keys(report.eventsByDay ?? {}).sort();
  if (days.length > 0) {
    lines.push("", "Events by day:");
    for (const day of days) {
      const { dispatch = 0, write = 0, deny = 0, warn = 0, verification = 0 } = report.eventsByDay[day];
      lines.push(`- ${day}: dispatch ${dispatch}, write ${write}, deny ${deny}, warn ${warn}${verification > 0 ? `, verification ${verification}` : ""}`);
    }
  }
  renderCounts(lines, "Dispatches by lane", report.dispatchesByLane);
  renderCounts(lines, "Verification evidence", report.verificationByEvidence);
  if (report.malformedCount > 0) {
    lines.push("", `Malformed audit entries skipped: ${report.malformedCount}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderTraceReport(report) {
  const lines = ["# Fusion session trace", "", `Session: ${report.sessionId ?? "unset"}`];
  if (!report.available) {
    lines.push("", `Session data unavailable: ${report.reason}`);
    return `${lines.join("\n")}\n`;
  }
  lines.push("", `Workspace root: ${report.workspaceRoot}`, "", "Time | Source | Lane or engine | Task or job | Model@effort | Status | Description");
  if (report.timeline.length === 0) {
    lines.push("no dispatches or matching engine jobs recorded");
  } else {
    for (const entry of report.timeline) {
      const subject = entry.source === "dispatch" ? entry.lane : `${entry.engine}${entry.join === "approximate" ? " (approximate)" : ""}`;
      lines.push(`${entry.time} | ${entry.source} | ${subject} | ${entry.taskId ?? entry.jobId ?? ""} | ${formatTraceModel(entry.model, entry.effort) ?? ""} | ${entry.status ?? ""} | ${entry.description ?? ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
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
    if (report.guard.source === "long term audit") {
      lines.push("", "Guard source: long term audit (short lived session state unavailable)");
    }
    if (report.guard.malformedCount > 0) {
      lines.push(`Malformed audit entries skipped: ${report.guard.malformedCount}`);
    }
  }
  if (report.workers) {
    lines.push("", "## Claude workers (session scope)", "", `Total jobs: ${report.workers.totalJobs}`);
    renderCounts(lines, "By transport status", report.workers.byTransportStatus);
    renderCounts(lines, "By semantic acceptance", report.workers.byAcceptance);
    renderInfrastructure(lines, report.workers);
    renderCounts(lines, "By collection method", report.workers.byCollectionMethod);
    lines.push("", `Semantic acceptance scope: ${report.workers.acceptanceScope}; ${report.workers.pendingTransportJobs} non-terminal job${report.workers.pendingTransportJobs === 1 ? "" : "s"} excluded`);
    renderWorkerIdentities(lines, report.workers.identities);
  }
  for (const descriptor of WORKSPACE_ENGINE_DESCRIPTORS) {
    const stats = report.engines[descriptor.id];
    lines.push("", `## ${descriptor.displayName} jobs (session scope)`);
    if (!stats.available) {
      lines.push("", `Unavailable: ${stats.reason}`);
      continue;
    }
    lines.push("", `Total jobs: ${stats.totalJobs}`);
    renderCounts(lines, stats.byTransportStatus ? "By transport status" : "By status", stats.byTransportStatus ?? stats.byStatus);
    renderCounts(lines, "By semantic acceptance", stats.byAcceptance ?? {});
    renderAcceptanceGaps(lines, stats.acceptanceGaps);
    renderInfrastructure(lines, stats);
    if (stats.acceptanceScope) {
      lines.push("", `Semantic acceptance scope: ${stats.acceptanceScope}; ${stats.pendingTransportJobs} non-terminal job${stats.pendingTransportJobs === 1 ? "" : "s"} excluded`);
    }
  }
  return `${lines.join("\n")}\n`;
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
  for (const [key, title] of [["observations", "Observation sidecars"], ["cursorRuns", "Orphan Cursor runs"]]) {
    lines.push("", `## ${title}`, "");
    const candidates = result.dead[key] ?? [];
    lines.push(...(candidates.length ? candidates.map((entry) => `- ${entry.dir}`) : ["none found"]));
  }
  lines.push(
    "",
    result.applied
      ? "removed the directories listed above"
      : "dry run: rerun with --prune-dead --yes to delete these directories"
  );
  return `${lines.join("\n")}\n`;
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

function renderAcceptanceAnomalies(lines, anomalies) {
  const acceptedWithErrorTransport = anomalies?.acceptedWithErrorTransport ?? [];
  const doneWithoutAcceptance = anomalies?.doneWithoutAcceptance ?? [];
  if (acceptedWithErrorTransport.length === 0 && doneWithoutAcceptance.length === 0) {
    return;
  }
  lines.push("", "Acceptance anomalies:");
  if (acceptedWithErrorTransport.length > 0) {
    lines.push(`- Accepted ledger entries with error transport: ${acceptedWithErrorTransport.length} (${renderAnomalyIds(acceptedWithErrorTransport.map((jobId) => jobId.slice(0, 8)))})`);
  }
  if (doneWithoutAcceptance.length > 0) {
    lines.push(`- Done jobs without acceptance records: ${doneWithoutAcceptance.length} (${renderAnomalyIds(doneWithoutAcceptance)})`);
  }
}

function renderAnomalyIds(ids) {
  return `${ids.slice(0, 10).join(", ")}${ids.length > 10 ? `, and ${ids.length - 10} more` : ""}`;
}

function renderInfrastructure(lines, stats) {
  if (!stats.infrastructureDeaths) {
    return;
  }
  lines.push("", `Infrastructure deaths: ${stats.infrastructureDeaths.total}`);
  renderCounts(lines, "By infrastructure kind", stats.infrastructureDeaths.byKind);
  const judged = stats.judgedExcludingInfrastructure ?? acceptanceSummary();
  lines.push(`Judged acceptance excluding infrastructure: ${judged.accepted}/${judged.judged} (${formatShare(judged.rate)})`);
}

function renderAcceptanceGaps(lines, gaps) {
  if (!gaps) {
    return;
  }
  lines.push("", "Jobs without a judged verdict:");
  lines.push(`- unsettled (linked Fusion worker): ${gaps.unsettled}`);
  lines.push(`- direct (no worker link): ${gaps.direct}`);
}

function formatShare(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function renderCodexSkuTrend(lines, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return;
  }
  lines.push("", "By SKU, last 7 days:", "SKU | jobs | output tokens | timeout share | near-cap share | salvaged");
  for (const row of rows) {
    const salvaged = `${row.salvagedTimeouts ?? 0}/${row.timeouts ?? 0}`;
    lines.push(`${row.sku} | ${row.jobs} | ${row.outputTokenOverflow ? "overflow" : row.outputTokens} | ${formatShare(row.timeoutShare)} | ${formatShare(row.nearCapShare)} | ${salvaged}`);
  }
}

function renderLaneSignalDrift(lines, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return;
  }
  lines.push("", "## Lane signal drift");
  for (const row of rows) {
    lines.push(`- ${row.sku}: judged acceptance ${formatShare(row.acceptanceRate)}, timeout share ${formatShare(row.timeoutShare)}; re-score via /fusion:config`);
  }
}

function renderEngine(lines, name, stats, { identities = false } = {}) {
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
  renderCounts(lines, stats.byTransportStatus ? "By transport status" : "By status", stats.byTransportStatus ?? stats.byStatus ?? {});
  renderCounts(lines, "By semantic acceptance", stats.byAcceptance ?? {});
  renderAcceptanceGaps(lines, stats.acceptanceGaps);
  renderInfrastructure(lines, stats);
  if (stats.acceptanceScope) {
    lines.push("", `Semantic acceptance scope: ${stats.acceptanceScope}; ${stats.pendingTransportJobs} non-terminal job${stats.pendingTransportJobs === 1 ? "" : "s"} excluded`);
  }
  renderAcceptanceAnomalies(lines, stats.acceptanceAnomalies);
  renderCounts(lines, "By mode", stats.byMode ?? {});
  renderCounts(lines, "By agent", stats.byAgent ?? {});
  renderCounts(lines, "By delivery", stats.byDelivery ?? {});
  renderCounts(lines, "By collection method", stats.byCollectionMethod ?? {});
  renderCounts(lines, "By kind", stats.byKind ?? {});
  renderCounts(lines, "By model", stats.byModel ?? {});
  renderCounts(lines, "By effort", stats.byEffort ?? {});
  renderCodexSkuTrend(lines, stats.last7DaysBySku);
  renderCounts(lines, "By failure kind", stats.byFailureKind ?? {});
  if (Number.isSafeInteger(stats.harnessAsyncDeliveries)) {
    lines.push("", `Harness async deliveries: ${stats.harnessAsyncDeliveries}`);
  }
  if (stats.tokenUsage) {
    const scope = stats.tokenUsage.scope ? `, ${stats.tokenUsage.scope}` : "";
    const incomplete = stats.tokenUsage.jobsWithIncompleteUsage ?? 0;
    const unreported = stats.tokenUsage.jobsWithUnreportedUsage ?? Math.max(0, stats.tokenUsage.jobsWithoutUsage - incomplete);
    lines.push("", `Exact token usage coverage${scope}: ${stats.tokenUsage.availability} (${stats.tokenUsage.jobsWithUsage} complete, ${incomplete} incomplete, ${unreported} unreported)`);
    if (stats.tokenUsage.totals) {
      const totals = stats.tokenUsage.totals;
      lines.push(Object.hasOwn(totals, "cacheWriteTokens")
        ? `Observed tokens: ${totals.totalTokens} total, ${totals.inputTokens} input, ${totals.cacheReadTokens} cache read, ${totals.cacheWriteTokens} cache write, ${totals.outputTokens} output`
        : `Observed tokens: ${totals.totalTokens} total, ${totals.inputTokens} input, ${totals.cachedInputTokens} cached input, ${totals.outputTokens} output, ${totals.reasoningOutputTokens} reasoning output`);
    }
  }
  if (stats.usageCoverage || Object.hasOwn(stats, "usage")) {
    const completeJobs = stats.usageCoverage?.completeJobs ?? stats.usage?.reportedJobs ?? 0;
    const incompleteJobs = stats.usageCoverage?.incompleteJobs ?? 0;
    const unreportedJobs = stats.usageCoverage?.unreportedJobs ?? Math.max(0, (stats.totalJobs ?? 0) - completeJobs - incompleteJobs);
    const availability = stats.usageCoverage?.availability ?? (completeJobs === 0 ? "unavailable" : completeJobs === (stats.totalJobs ?? 0) ? "available" : "partial");
    lines.push("", `Exact token usage coverage: ${availability} (${completeJobs} complete, ${incompleteJobs} incomplete, ${unreportedJobs} unreported)`);
    if (stats.usage && completeJobs > 0) {
      const reasoning = Number.isSafeInteger(stats.usage.reasoningTokens) ? `, ${stats.usage.reasoningTokens} reasoning output` : "";
      lines.push(`Observed tokens: ${stats.usage.totalTokens} total, ${stats.usage.inputTokens} input, ${stats.usage.cacheReadInputTokens} cached input, ${stats.usage.outputTokens} output${reasoning}`);
    }
  }
  if (stats.evidence?.recoveredTerminalJobs) {
    lines.push("", `Recovered from retained terminal ledgers: ${stats.evidence.recoveredTerminalJobs}`);
  }
  if (identities) {
    renderWorkerIdentities(lines, stats.identities);
  }
}

function renderWorkerIdentities(lines, identities) {
  if (!Array.isArray(identities) || identities.length === 0) {
    return;
  }
  const includesCollectionMethod = identities.some((identity) => identity.collectionMethod);
  const includesAcceptanceProvenance = identities.some((identity) => identity.acceptanceSource || identity.acceptanceRecordedAt);
  lines.push("", "Task identity map:", `task | session | agent | background task | transport${includesCollectionMethod ? " | collection" : ""} | acceptance${includesAcceptanceProvenance ? " | acceptance source | acceptance recorded at" : ""}`);
  for (const identity of identities) {
    lines.push(`${identity.taskId} | ${identity.sessionId ?? ""} | ${identity.agentId ?? ""} | ${identity.backgroundTaskId ?? ""} | ${identity.transportStatus}${includesCollectionMethod ? ` | ${identity.collectionMethod ?? ""}` : ""} | ${identity.acceptance}${includesAcceptanceProvenance ? ` | ${identity.acceptanceSource ?? ""} | ${identity.acceptanceRecordedAt ?? ""}` : ""}`);
  }
}

function renderFleetUsageStats(lines, fleet, { byDay = false } = {}) {
  if (!fleet || typeof fleet !== "object") {
    return;
  }
  lines.push("", "## Ultra usage surface", "", "Fleet visibility derived from inline-guard audit dispatches (same-session bursts within a short window).");
  lines.push(`Total dispatches: ${fleet.totalDispatches ?? 0}`);
  lines.push(`Dispatch bursts: ${fleet.totalBursts ?? 0}`);
  lines.push(`Fleet-shaped bursts (width ≥ ${FLEET_SHAPED_MIN_WIDTH}): ${fleet.fleetShapedBursts ?? 0}`);
  renderCounts(lines, "Burst width distribution", fleet.widthDistribution ?? {});
  if (fleet.widest) {
    lines.push("", `Widest burst: width ${fleet.widest.width}, session ${fleet.widest.session}${fleet.widest.day ? `, day ${fleet.widest.day}` : ""}`);
  } else {
    lines.push("", "Widest burst: none");
  }
  const days = Object.keys(fleet.byDay ?? {}).sort();
  if (byDay && days.length > 0) {
    lines.push("", "By day:");
    for (const day of days) {
      const dayStats = fleet.byDay[day];
      const widths = Object.keys(dayStats.widthDistribution ?? {})
        .sort((left, right) => Number(left) - Number(right))
        .map((width) => `${width}×${dayStats.widthDistribution[width]}`)
        .join(", ");
      const widest = dayStats.widest ? `; widest ${dayStats.widest.width} (session ${dayStats.widest.session})` : "";
      lines.push(`- ${day}: ${dayStats.bursts} burst${dayStats.bursts === 1 ? "" : "s"}, ${dayStats.fleetShapedBursts} fleet-shaped${widths ? ` [${widths}]` : ""}${widest}`);
    }
  }
  if (Array.isArray(fleet.narrowWaveWatch) && fleet.narrowWaveWatch.length > 0) {
    lines.push("", "Narrow-wave watch:");
    for (const watch of fleet.narrowWaveWatch) {
      lines.push(`- ${watch.day}, ${watch.session}, ${watch.dispatches}, all width 1`);
    }
  }
}

function renderCoercionLedger(lines, ledger) {
  if (!hasCoercionLedgerData(ledger)) {
    return;
  }
  lines.push("", "## Coercion ledger", "");
  lines.push(`Fleet declines: ${ledger.fleetDeclines ?? 0}`);
  lines.push(`Narrow-wave advisories: ${ledger.narrowWaveAdvisories ?? 0}`);
  lines.push(`Fleet-shaped waves: ${ledger.fleetShapedWaves ?? 0}`);
  lines.push(`Verification resets: ${ledger.verificationResets ?? 0}`);
  lines.push(`Unverified accumulations: ${ledger.unverifiedAccumulations ?? 0}`);
  lines.push(`Inline sprawl windows: ${ledger.inlineSprawlWindows ?? 0}`);
  lines.push(`Deepest unverified window: ${ledger.deepestUnverifiedWindow ?? 0}`);
  renderCounts(lines, "Posture mix", ledger.postureMix ?? {});
  const fleetDeclines = ledger.fleetDeclines ?? 0;
  const fleetShapedWaves = ledger.fleetShapedWaves ?? 0;
  if (fleetDeclines >= 5 && fleetShapedWaves <= COERCION_LEDGER_SMALL_FLEET_SHAPED_WAVES && fleetDeclines >= 5 * Math.max(1, fleetShapedWaves)) {
    lines.push("", `Advisory: Fleet declines to fleet-shaped waves are ${fleetDeclines}:${fleetShapedWaves}; the fleet default is being overridden more often than honored.`);
  }
}

export function renderFusionStats(report, { identities = false, byDay = false } = {}) {
  const lines = ["# Fusion stats", "", `Scope: ${report.scope === "all" ? "all workspaces" : `workspace ${report.scope}`}`];
  for (const provider of STATS_PROVIDER_REGISTRY) {
    if (report[provider.id]) {
      renderEngine(lines, provider.displayName, report[provider.id], { identities });
    }
  }
  for (const provider of STATS_PROVIDER_REGISTRY) {
    renderLaneSignalDrift(lines, report[provider.id]?.laneSignalDrift);
  }
  if (report.retiredWorkers) {
    const retired = report.retiredWorkers;
    lines.push("", "## Retired Claude workers", "", `Total jobs: ${retired.totalJobs}`);
    renderCounts(lines, "By agent", retired.byAgent);
    renderCounts(lines, "By acceptance", retired.byAcceptance);
    renderCounts(lines, "By failure kind", retired.byFailureKind);
    lines.push(`Token sums: ${retired.tokenSums.outputTokens} output, ${retired.tokenSums.uncachedTokens} uncached, ${retired.tokenSums.cacheReadInputTokens} cache read input`);
  }
  renderFleetUsageStats(lines, report.fleet, { byDay });
  renderCoercionLedger(lines, report.coercionLedger);
  lines.push("", "Peer token totals include only jobs with exact reported usage. Unavailable jobs are never estimated.");
  return `${lines.join("\n")}\n`;
}

export function renderUnsettledReport(report) {
  const lines = ["# Fusion unsettled jobs"];
  if (report.unsettled.length === 0) {
    lines.push("", "No terminal jobs are awaiting semantic acceptance.");
    return `${lines.join("\n")}\n`;
  }
  lines.push("", "Engine | ID | Description or kind | Finished at | Semantic verdict");
  for (const entry of report.unsettled) {
    const provenance = [
      entry.acceptanceSource ? `acceptance source: ${entry.acceptanceSource}` : null,
      entry.acceptanceRecordedAt ? `acceptance recorded at: ${entry.acceptanceRecordedAt}` : null
    ].filter(Boolean).join(", ");
    lines.push(`${entry.engine} | ${entry.id} | ${entry.description ?? entry.kind ?? "unknown"} | ${entry.finishedAt ?? ""} | ${entry.acceptance}${provenance ? ` (${provenance})` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}
