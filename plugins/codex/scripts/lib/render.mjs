function footer(record) {
  const lines = [];
  if (record.threadId) {
    lines.push(`codex-session: ${record.threadId}`);
  }
  lines.push(`job: ${record.id}`, `state: ${record.status}`);
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
    "state: running",
    ""
  ].join("\n");
}

export function renderTerminalResult(record) {
  if (record.status === "done") {
    return withFooter(record.resultText || "Codex completed without a final response.", record);
  }
  if (record.status === "cancelled") {
    return withFooter(record.errorMessage || "Codex job was cancelled.", record);
  }
  const body = [record.errorMessage || "Codex job failed.", record.errorTail].filter(Boolean).join("\n\n");
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
    `Companion PID: ${record.pid ?? "none"}`,
    `Codex PID: ${record.codexPid ?? "none"}`,
    `Codex session: ${record.threadId ?? "not reported"}`,
    `Elapsed: ${record.status === "running" ? ageSeconds(record.startedAt ?? record.createdAt) ?? 0 : duration(record) ?? 0}s`
  ];
  if (record.request?.model) {
    lines.push(`Model: ${record.request.model}`);
  }
  if (record.request?.effort) {
    lines.push(`Effort: ${record.request.effort}`);
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
  if (records.length === 0) {
    return "No Codex jobs found for this workspace.\n";
  }
  const lines = ["| Job | Kind | State | Mode | Age | Summary |", "| --- | --- | --- | --- | ---: | --- |"];
  for (const record of records) {
    const seconds = record.status === "running" ? ageSeconds(record.startedAt ?? record.createdAt) : duration(record);
    lines.push(`| ${record.id} | ${record.jobClass ?? record.kind ?? "task"} | ${record.status} | ${record.background ? "background" : "foreground"} | ${seconds ?? 0}s | ${compact(record.resultText || record.errorMessage || "")} |`);
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
