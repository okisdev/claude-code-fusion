const VALID_VERDICTS = new Set(["approve", "request_changes"]);
const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

function scanBalancedObject(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return null;
}

export function extractFirstJsonObject(text) {
  const source = String(text ?? "").replace(/```[^\n`]*\n?/g, "");
  let start = source.indexOf("{");
  while (start !== -1) {
    const candidate = scanBalancedObject(source, start);
    if (candidate) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        start = source.indexOf("{", start + 1);
        continue;
      }
    }
    start = source.indexOf("{", start + 1);
  }
  return null;
}

function invalid(error) {
  return { valid: false, error };
}

export function validateReviewOutput(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return invalid("Expected a top level JSON object.");
  }
  if (typeof data.verdict !== "string" || !VALID_VERDICTS.has(data.verdict)) {
    return invalid("Expected verdict to be approve or request_changes.");
  }
  if (typeof data.summary !== "string") {
    return invalid("Expected summary to be a string.");
  }
  if (!Array.isArray(data.findings)) {
    return invalid("Expected findings to be an array.");
  }
  for (const [index, finding] of data.findings.entries()) {
    const label = `finding ${index + 1}`;
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      return invalid(`Expected ${label} to be an object.`);
    }
    if (!VALID_SEVERITIES.has(finding.severity)) {
      return invalid(`Expected ${label} severity to be critical, high, medium, or low.`);
    }
    if (typeof finding.file !== "string") {
      return invalid(`Expected ${label} file to be a string.`);
    }
    if (finding.line !== null && !Number.isInteger(finding.line)) {
      return invalid(`Expected ${label} line to be an integer or null.`);
    }
    if (typeof finding.title !== "string") {
      return invalid(`Expected ${label} to have a string title.`);
    }
    if (typeof finding.body !== "string") {
      return invalid(`Expected ${label} to have a string body.`);
    }
  }
  return {
    valid: true,
    value: {
      verdict: data.verdict,
      summary: data.summary,
      findings: data.findings
    }
  };
}

export function formatAge(iso, now = Date.now()) {
  const timestamp = Date.parse(iso ?? "");
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

function historyCell(value, fallback = "unknown") {
  const text = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  return (text.trim() || fallback)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;");
}

function booleanLabel(value) {
  return value === true ? "yes" : value === false ? "no" : "unknown";
}

function deliveryLabel(job) {
  return `${job?.delivery ?? "unknown"}/${job?.deliveryStatus ?? "unknown"}`;
}

export function renderHistoryReport(history, now = Date.now()) {
  const jobs = Array.isArray(history?.jobs) ? history.jobs : [];
  const allWorkspaces = history?.scope === "all";
  if (jobs.length === 0) {
    return allWorkspaces
      ? "No Devin jobs recorded across workspaces.\n"
      : "No Devin jobs recorded for this workspace.\n";
  }
  const totalJobs = Number.isSafeInteger(history?.totalJobs) && history.totalJobs >= jobs.length ? history.totalJobs : jobs.length;
  const lines = [
    "# Devin history",
    "",
    `Scope: ${allWorkspaces ? "all workspaces" : "current workspace"}`,
    `Showing ${jobs.length} of ${totalJobs} jobs, newest first.`,
    ""
  ];
  const headings = ["age", "job", "class", "status", "mode", "delivery", "requested model", "resolved model", "observed model", "effort applied", "billing pool", "devin version", "session", "resumable", "owned"];
  if (allWorkspaces) {
    headings.push("workspace");
  }
  lines.push(`| ${headings.join(" | ")} |`, `| ${headings.map(() => "---").join(" | ")} |`);
  for (const job of jobs) {
    const status = job?.cleanupRequired ? `${job.status ?? "unknown"} (cleanup required)` : job?.status;
    const cells = [
      historyCell(formatAge(job?.createdAt, now)),
      historyCell(job?.jobId),
      historyCell(job?.jobClass),
      historyCell(status),
      historyCell(job?.mode),
      historyCell(deliveryLabel(job)),
      historyCell(job?.requestedModel),
      historyCell(job?.resolvedModel),
      historyCell(job?.observedModel),
      booleanLabel(job?.effortApplied),
      historyCell(job?.billingPool),
      historyCell(job?.devinVersion),
      historyCell(job?.sessionId, "none"),
      job?.resumable === true ? "yes" : "no",
      booleanLabel(job?.ownedByCurrentSession)
    ];
    if (allWorkspaces) {
      cells.push(historyCell(job?.cwd));
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

function footerLines(record) {
  const lines = [];
  if (record.sessionId) {
    lines.push(`devin-session: ${record.sessionId}`);
  }
  if (record.id) {
    if (typeof record.cwd !== "string" || !record.cwd) {
      throw new TypeError("A job footer requires a workspace path.");
    }
    lines.push(`job: ${record.id}`);
    if (record.resumedFromJobId) {
      lines.push(`resumed-from: ${record.resumedFromJobId}`);
    }
    lines.push(`sandbox: ${record.cwd}`);
  }
  if (record.delivery) {
    lines.push(`delivery: ${record.delivery}`);
  }
  if (record.semanticStatus) {
    lines.push(`semantic: ${record.semanticStatus}`);
  }
  for (const warning of record.warnings ?? []) {
    lines.push(`warning: ${String(warning).replace(/[\r\n]+/g, " ")}`);
  }
  lines.push(`state: ${record.status ?? "done"}`);
  if (record.status === "cancelled" || record.status === "error") {
    lines.push(`failure: ${record.failureKind ?? (record.status === "cancelled" ? "cancelled" : "error")}`);
  }
  return lines;
}

export function renderTaskResult({ text, sessionId, jobId, cwd, record, resumedFromJobId, delivery, semanticStatus, warnings, status, failureKind }) {
  const job = {
    id: jobId,
    cwd,
    sessionId,
    resumedFromJobId,
    delivery,
    semanticStatus,
    warnings,
    status: status ?? "done",
    failureKind,
    ...record
  };
  const lines = [String(text ?? "").trimEnd() || "Devin returned no output.", "", ...footerLines(job)];
  return `${lines.join("\n")}\n`;
}

export function renderBackgroundLaunch(jobId, delivery, cwd) {
  return [
    `Started background job ${jobId}.`,
    `Check progress with /devin:status ${jobId}.`,
    `Fetch the result with /devin:result ${jobId}.`,
    "",
    ...footerLines({ id: jobId, cwd, delivery, status: "running" }),
    ""
  ].join("\n");
}

export function renderStatusTable(jobs, claudeSessionId = null, now = Date.now()) {
  if (jobs.length === 0) {
    return "No jobs recorded for this workspace.\n";
  }
  const lines = [
    "| id | status | mode | background | age | owned | requested model | resolved model | observed model | effort applied | billing pool | devin version |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  ];
  for (const job of jobs) {
    const owned = (job.claudeSessionId ?? null) === claudeSessionId ? "yes" : "no";
    lines.push(`| ${[
      job.id,
      job.status,
      job.mode,
      job.background ? "yes" : "no",
      formatAge(job.createdAt, now),
      owned,
      job.requestedModel,
      job.resolvedModel,
      job.observedModel,
      booleanLabel(job.effortApplied),
      job.billingPool,
      job.devinVersion
    ].map((value) => historyCell(value)).join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderJobDetail(job, options = {}) {
  const lines = [
    `Job ${job.id}`,
    "",
    `Status: ${job.status}`,
    `Class: ${job.jobClass ?? "unknown"}`,
    `Mode: ${job.mode}`,
    `Background: ${job.background ? "yes" : "no"}`,
    `Requested model: ${job.requestedModel ?? "unknown"}`,
    `Resolved model: ${job.resolvedModel ?? "unknown"}`,
    `Observed model: ${job.observedModel ?? "unknown"}`,
    `Requested effort: ${job.requestedEffort ?? "unknown"}`,
    `Effort applied: ${booleanLabel(job.effortApplied)}`,
    `Billing pool: ${job.billingPool ?? "unknown"}`,
    `Devin version: ${job.devinVersion ?? "unknown"}`,
    `Created: ${job.createdAt}`
  ];
  if (job.stopCause) {
    lines.push(`Stop cause: ${job.stopCause}`);
  }
  if (job.finishedAt) {
    lines.push(`Finished: ${job.finishedAt}`);
  }
  if (job.exitCode != null) {
    lines.push(`Exit code: ${job.exitCode}`);
  }
  if (job.sessionId) {
    lines.push(`Devin session: ${job.sessionId}`);
  }
  if (job.briefFile) {
    lines.push(`Brief: ${job.briefFile}`);
  }
  if (job.status === "running") {
    lines.push("", `Cancel with /devin:cancel ${job.id}.`);
  }
  if (job.status === "done") {
    lines.push("", `Fetch the result with /devin:result ${job.id}.`);
  }
  const logTail = options.logTail || job.errorTail || "";
  if (job.status === "error" && logTail) {
    lines.push("", "Log tail:", "", "```text", logTail, "```");
  }
  lines.push("", ...footerLines(job));
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(review, meta = {}) {
  const lines = [];
  if (meta.targetLabel) {
    lines.push(`Target: ${meta.targetLabel}`, "");
  }
  lines.push(`Verdict: ${review.verdict}`, `Summary: ${review.summary}`);
  if (review.findings.length === 0) {
    lines.push("", "No findings.");
  } else {
    for (const severity of SEVERITY_ORDER) {
      const findings = review.findings.filter((finding) => finding.severity === severity);
      if (findings.length === 0) {
        continue;
      }
      lines.push("", `${severity.charAt(0).toUpperCase()}${severity.slice(1)} severity:`);
      for (const finding of findings) {
        const location = `${finding.file}${finding.line === null ? "" : `:${finding.line}`}`;
        lines.push(`- ${finding.severity} | ${finding.title} | ${location}`, `  ${finding.body}`);
      }
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  return [
    `Cancelled job ${job.id}.`,
    "Check /devin:status for the updated list.",
    "",
    ...footerLines({ ...job, status: "cancelled", failureKind: "cancelled" }),
    ""
  ].join("\n");
}

export function renderRecordAcceptance(record) {
  return `Recorded verdict for Devin job ${record.id}: ${record.semanticStatus}.\n`;
}

export function renderSetupReport(report) {
  const devin = report.devin ?? {};
  const lines = [
    "# Devin setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- devin binary (${devin.buildPath ?? devin.bin ?? "devin"}): ${devin.available ? devin.detail : `unavailable, ${devin.detail ?? "not checked"}`}`,
    `- version: ${devin.version ?? "unknown"}`,
    `- compatibility: ${report.compatibility ?? "unknown"}`,
    `- authentication: ${report.auth?.authenticated ? "authenticated" : report.auth?.detail ?? "not checked"}`,
    `- plan tier: ${report.planTier ?? report.auth?.planTier ?? "unknown"}`,
    `- catalog: ${report.catalog?.detail ?? (Number.isInteger(report.catalogSize) ? `${report.catalogSize} families` : "not checked")}`,
    `- project configuration: ${report.projectConfigFiles?.length ? report.projectConfigFiles.join(", ") : "none detected"}`,
    `- data dir: ${report.dataDir?.writable ? `writable (${report.dataDir.path})` : `not writable (${report.dataDir?.detail ?? "not checked"})`}`
  ];
  for (const step of report.nextSteps ?? []) {
    lines.push(`- ${step}`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
