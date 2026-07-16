function footer(record) {
  const lines = [];
  if (record.threadId) {
    lines.push(`codex-session: ${record.threadId}`);
  }
  lines.push(`job: ${record.id}`, `delivery: ${record.delivery ?? (record.background ? "manual" : "foreground")}`, `semantic: ${record.semanticStatus ?? "unverified"}`);
  lines.push(`state: ${record.status}`);
  if (record.status === "error" || record.status === "cancelled") {
    lines.push(`failure: ${record.failureKind ?? (record.status === "cancelled" ? "cancelled" : "error")}`);
  }
  return lines.join("\n");
}

function withFooter(body, record) {
  const text = String(body ?? "").trimEnd();
  return `${text ? `${text}\n\n` : ""}${footer(record)}\n`;
}

function ageSeconds(value, now = Date.now()) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? Math.max(0, Math.floor((now - timestamp) / 1000)) : null;
}

function duration(record) {
  const start = Date.parse(record.startedAt ?? record.createdAt ?? "");
  const end = Date.parse(record.finishedAt ?? record.updatedAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return Math.floor((end - start) / 1000);
}

function compact(value, limit = 72) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

export function renderBackgroundLaunch(record) {
  return [
    `Codex job ${record.id} started in the background.`,
    `Use /codex:status ${record.id} to inspect it.`,
    `Use /codex:result ${record.id} to collect the terminal result.`,
    "",
    `job: ${record.id}`,
    `delivery: ${record.delivery ?? "manual"}`,
    "state: running",
    ""
  ].join("\n");
}

export function renderTerminalResult(record) {
  if (record.status === "done") {
    const semanticNotice = record.semanticStatus === "rejected"
      ? record.semanticFailureMessage || "Codex returned a transport result that did not satisfy semantic delivery."
      : record.semanticStatus !== "accepted"
        ? "Codex transport completed, but semantic acceptance remains unverified. Check the result against the requested completion criteria before relying on it."
        : null;
    return withFooter([semanticNotice, record.resultText || "Codex completed without a final response."].filter(Boolean).join("\n\n"), record);
  }
  if (record.status === "cancelled") {
    const partial = record.partialResultText ? `Partial Codex output:\n\n${record.partialResultText}` : null;
    const body = [record.errorMessage || "Codex job was cancelled.", partial].filter(Boolean).join("\n\n");
    return withFooter(body, record);
  }
  const partial = record.partialResultText ? `Partial Codex output:\n\n${record.partialResultText}` : null;
  const body = [record.errorMessage || "Codex job failed.", partial, record.errorTail].filter(Boolean).join("\n\n");
  return withFooter(body, record);
}

export function renderRunningResult(record) {
  const lines = [
    `Codex job ${record.id} is still running.`,
    `Phase: ${record.phase ?? "executing"}`,
    `Elapsed: ${ageSeconds(record.startedAt ?? record.createdAt) ?? 0}s`,
    `Use /codex:status ${record.id} for progress.`,
    "",
    `job: ${record.id}`,
    "state: running",
    ""
  ];
  return lines.join("\n");
}

export function renderJobDetail(record) {
  const lines = [
    `Job: ${record.id}`,
    `Status: ${record.status}`,
    `Phase: ${record.phase ?? "unknown"}`,
    `Kind: ${record.jobClass ?? record.kind ?? "task"}`,
    `Workspace: ${record.workspaceRoot}`,
    `Background: ${record.background ? "yes" : "no"}`,
    `Delivery: ${record.delivery ?? (record.background ? "manual" : "foreground")}`,
    `Delivery collected: ${record.deliveryCollectedAt ?? "no"}`,
    `Semantic status: ${record.semanticStatus ?? "unverified"}`,
    `Companion PID: ${record.pid ?? "none"}`,
    `Codex PID: ${record.codexPid ?? "none"}`,
    `Codex session: ${record.threadId ?? "not reported"}`,
    `Elapsed: ${record.status === "running" ? ageSeconds(record.startedAt ?? record.createdAt) ?? 0 : duration(record) ?? 0}s`
  ];
  if (record.resolvedModel) {
    lines.push(`Resolved model: ${record.resolvedModel}`);
  } else if (record.request?.model) {
    lines.push(`Requested model: ${record.request.model}`);
  }
  if (record.resolvedEffort) {
    lines.push(`Resolved effort: ${record.resolvedEffort}`);
  } else if (record.request?.effort) {
    lines.push(`Requested effort: ${record.request.effort}`);
  }
  if (record.tokenUsageAvailability) {
    lines.push(`Token usage: ${record.tokenUsageAvailability}`);
  }
  if (record.errorMessage) {
    lines.push(`Error: ${record.errorMessage}`);
  }
  if (record.logFile) {
    lines.push(`Log: ${record.logFile}`);
  }
  lines.push("", footer(record), "");
  return lines.join("\n");
}

export function renderStatusTable(records) {
  const persistenceNotice = "Codex exec sessions are persisted locally and resumable by thread id. Codex Desktop does not guarantee that exec sourced sessions appear in its sidebar.";
  if (records.length === 0) {
    return `${persistenceNotice}\n\nNo canonical Codex jobs found.\n`;
  }
  const lines = [
    persistenceNotice,
    "",
    "| Job | Thread | Kind | State | Delivery | Semantic | Model | Effort | Age | Summary |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- |"
  ];
  for (const record of records) {
    const seconds = record.status === "running" ? ageSeconds(record.startedAt ?? record.createdAt) : duration(record);
    lines.push(`| ${record.id} | ${record.threadId ?? "pending"} | ${record.jobClass ?? record.kind ?? "task"} | ${record.status} | ${record.delivery ?? (record.background ? "manual" : "foreground")} | ${record.semanticStatus ?? "unverified"} | ${record.resolvedModel ?? "unknown"} | ${record.resolvedEffort ?? "unknown"} | ${seconds ?? 0}s | ${compact(record.resultText || record.partialResultText || record.errorMessage || "")} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderCancelReport(record) {
  return withFooter(record.errorMessage || "Cancellation requested.", record);
}

export function renderSetupReport(report) {
  const lines = [
    `Codex CLI: ${report.codex.available ? report.codex.version ?? "available" : "unavailable"}`,
    `Authentication: ${report.authenticated ? "ready" : "not ready"}`,
    `Adapter data: ${report.dataDir}`,
    `Adapter status: ${report.ready ? "ready" : "needs attention"}`
  ];
  if (report.compatibility) {
    lines.push(`Compatibility: ${report.compatibility}`);
  }
  for (const step of report.nextSteps ?? []) {
    lines.push(`Next: ${step}`);
  }
  return `${lines.join("\n")}\n`;
}
