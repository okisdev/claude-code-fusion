const VALID_VERDICTS = new Set(["approve", "needs-attention"]);
const VALID_SEVERITIES = new Set(["high", "medium", "low"]);
const SEVERITY_ORDER = ["high", "medium", "low"];

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
    return invalid("Expected verdict to be approve or needs-attention.");
  }
  if (!Array.isArray(data.findings)) {
    return invalid("Expected findings to be an array.");
  }
  for (const [index, finding] of data.findings.entries()) {
    const label = `finding ${index + 1}`;
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      return invalid(`Expected ${label} to be an object.`);
    }
    if (typeof finding.severity !== "string" || !VALID_SEVERITIES.has(finding.severity)) {
      return invalid(`Expected ${label} severity to be high, medium, or low.`);
    }
    if (typeof finding.title !== "string" || !finding.title.trim()) {
      return invalid(`Expected ${label} to have a string title.`);
    }
    if (typeof finding.body !== "string" || !finding.body.trim()) {
      return invalid(`Expected ${label} to have a string body.`);
    }
    if (finding.file !== undefined && typeof finding.file !== "string") {
      return invalid(`Expected ${label} file to be a string.`);
    }
    if (finding.line_start !== undefined && !Number.isInteger(finding.line_start)) {
      return invalid(`Expected ${label} line_start to be an integer.`);
    }
    if (finding.line_end !== undefined && !Number.isInteger(finding.line_end)) {
      return invalid(`Expected ${label} line_end to be an integer.`);
    }
    if (
      finding.confidence !== undefined &&
      !(typeof finding.confidence === "number" && finding.confidence >= 0 && finding.confidence <= 1)
    ) {
      return invalid(`Expected ${label} confidence to be a number between 0 and 1.`);
    }
    if (finding.recommendation !== undefined && typeof finding.recommendation !== "string") {
      return invalid(`Expected ${label} recommendation to be a string.`);
    }
  }
  const nextSteps = data.next_steps === undefined ? [] : data.next_steps;
  if (!Array.isArray(nextSteps) || nextSteps.some((step) => typeof step !== "string")) {
    return invalid("Expected next_steps to be an array of strings.");
  }
  return {
    valid: true,
    value: {
      verdict: data.verdict,
      findings: data.findings,
      next_steps: nextSteps
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
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : "";
  const normalized = text.trim() || fallback;
  return normalized
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;");
}

function historyBooleanLabel(value) {
  if (value === true) {
    return "yes";
  }
  if (value === false) {
    return "no";
  }
  return "unknown";
}

function historyDeliveryLabel(job) {
  const delivery = typeof job?.delivery === "string" && job.delivery.trim() ? job.delivery.trim() : "unknown";
  const status =
    typeof job?.deliveryStatus === "string" && job.deliveryStatus.trim()
      ? job.deliveryStatus.trim()
      : "unknown";
  return `${delivery}/${status}`;
}

function historyModelLabel(job) {
  const model =
    typeof job?.resolvedModel === "string" && job.resolvedModel.trim()
      ? job.resolvedModel.trim()
      : "unknown";
  const effort =
    typeof job?.resolvedEffort === "string" && job.resolvedEffort.trim()
      ? job.resolvedEffort.trim()
      : null;
  return effort ? `${model} (${effort})` : model;
}

export function renderHistoryReport(history, now = Date.now()) {
  const jobs = Array.isArray(history?.jobs) ? history.jobs : [];
  const allWorkspaces = history?.scope === "all";
  if (jobs.length === 0) {
    return allWorkspaces
      ? "No Grok jobs recorded across workspaces.\n"
      : "No Grok jobs recorded for this workspace.\n";
  }

  const totalJobs =
    Number.isSafeInteger(history?.totalJobs) && history.totalJobs >= jobs.length
      ? history.totalJobs
      : jobs.length;
  const lines = [
    "# Grok history",
    "",
    `Scope: ${allWorkspaces ? "all workspaces" : "current workspace"}`,
    `Showing ${jobs.length} of ${totalJobs} jobs, newest first.`,
    ""
  ];
  const headings = [
    "age",
    "job",
    "class",
    "status",
    "mode",
    "delivery",
    "model",
    "memory",
    "session",
    "resumable",
    "owned"
  ];
  if (allWorkspaces) {
    headings.push("workspace");
  }
  lines.push(
    `| ${headings.join(" | ")} |`,
    `| ${headings.map(() => "---").join(" | ")} |`
  );
  for (const job of jobs) {
    const status = job?.cleanupRequired
      ? `${typeof job?.status === "string" ? job.status : "unknown"} (cleanup required)`
      : job?.status;
    const cells = [
      historyCell(formatAge(job?.createdAt, now)),
      historyCell(job?.jobId),
      historyCell(job?.jobClass),
      historyCell(status),
      historyCell(job?.mode),
      historyCell(historyDeliveryLabel(job)),
      historyCell(historyModelLabel(job)),
      historyBooleanLabel(job?.memoryEnabled),
      historyCell(job?.sessionId, "none"),
      job?.resumable === true ? "yes" : "no",
      historyBooleanLabel(job?.ownedByCurrentSession)
    ];
    if (allWorkspaces) {
      cells.push(historyCell(job?.cwd));
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderTaskResult({ text, structuredOutput, structuredOutputError, schemaRequested = false, sessionId, jobId, cwd }) {
  const lines = [String(text ?? "").trimEnd() || "Grok returned no output."];
  lines.push("");
  if (schemaRequested) {
    const structuredStatus = structuredOutputError || structuredOutput === null
      ? "invalid"
      : structuredOutput !== undefined
        ? "parsed"
        : "unavailable";
    lines.push(`structured: ${structuredStatus}`);
  }
  if (sessionId) {
    lines.push(`grok-session: ${sessionId}`);
  }
  if (jobId) {
    lines.push(`job: ${jobId}`);
  }
  if (cwd) {
    lines.push(`sandbox: ${cwd}`);
  }
  lines.push("state: done");
  return `${lines.join("\n")}\n`;
}

export function renderBackgroundLaunch(jobId, delivery) {
  return [
    `Started background job ${jobId}.`,
    `Check progress with /grok:status ${jobId}.`,
    `Fetch the result with /grok:result ${jobId}.`,
    `job: ${jobId}`,
    `delivery: ${delivery}`,
    "state: running",
    ""
  ].join("\n");
}

export function renderStatusTable(jobs, claudeSessionId = null, now = Date.now()) {
  if (jobs.length === 0) {
    return "No jobs recorded for this workspace.\n";
  }
  const lines = [
    "| id | status | mode | background | age | owned |",
    "| --- | --- | --- | --- | --- | --- |"
  ];
  for (const job of jobs) {
    const owned = (job.claudeSessionId ?? null) === claudeSessionId ? "yes" : "no";
    lines.push(
      `| ${job.id} | ${job.status} | ${job.mode} | ${job.background ? "yes" : "no"} | ${formatAge(job.createdAt, now)} | ${owned} |`
    );
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
    `Cross-session memory: ${job.request?.memory === true || job.memoryEnabled === true ? "enabled" : "disabled"}`,
    `Background: ${job.background ? "yes" : "no"}`,
    `Created: ${job.createdAt}`
  ];
  if (job.finishedAt) {
    lines.push(`Finished: ${job.finishedAt}`);
  }
  if (job.exitCode != null) {
    lines.push(`Exit code: ${job.exitCode}`);
  }
  if (job.sessionId) {
    lines.push(`Grok session: ${job.sessionId}`);
  }
  if (job.briefFile) {
    lines.push(`Brief: ${job.briefFile}`);
  }
  if (job.status === "running") {
    lines.push("", `Cancel with /grok:cancel ${job.id}.`);
  }
  if (job.status === "done") {
    lines.push("", `Fetch the result with /grok:result ${job.id}.`);
  }
  const logTail = options.logTail || job.errorTail || "";
  if (job.status === "error" && logTail) {
    lines.push("", "Log tail:", "", "```text", logTail, "```");
  }
  lines.push("", `job: ${job.id}`);
  if (job.status !== "running") {
    lines.push(`sandbox: ${job.cwd}`);
  }
  lines.push(`state: ${job.status}`);
  if (job.failureKind) {
    lines.push(`failure: ${job.failureKind}`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function formatFindingLocation(finding) {
  if (!finding.file) {
    return "";
  }
  let location = ` | ${finding.file}`;
  if (Number.isInteger(finding.line_start)) {
    location += `:${finding.line_start}`;
    if (Number.isInteger(finding.line_end) && finding.line_end !== finding.line_start) {
      location += `-${finding.line_end}`;
    }
  }
  return location;
}

export function renderReviewResult(review, meta = {}) {
  const lines = [];
  if (meta.targetLabel) {
    lines.push(`Target: ${meta.targetLabel}`, "");
  }
  lines.push(`Verdict: ${review.verdict}`);

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
        lines.push(`- ${finding.severity} | ${finding.title}${formatFindingLocation(finding)}`);
        lines.push(`  ${finding.body}`);
        if (finding.recommendation) {
          lines.push(`  Recommendation: ${finding.recommendation}`);
        }
      }
    }
  }

  if (review.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of review.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewFallback(rawText, meta = {}) {
  const lines = ["Warning: Grok did not return a valid review JSON object. Raw output follows."];
  if (meta.parseError) {
    lines.push(`Parse error: ${meta.parseError}`);
  }
  lines.push("", String(rawText ?? "").trim() || "Grok returned no output.");
  return `${lines.join("\n").trimEnd()}\n`;
}

function pushCountSection(lines, heading, counts) {
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    return;
  }
  lines.push("", `${heading}:`);
  for (const [key, count] of entries) {
    lines.push(`- ${key}: ${count}`);
  }
}

function pushUsageSection(lines, usage, coverage, totalJobs) {
  const completeJobs = coverage?.completeJobs ?? usage?.reportedJobs ?? 0;
  const incompleteJobs = coverage?.incompleteJobs ?? 0;
  const unreportedJobs = coverage?.unreportedJobs ?? Math.max(0, totalJobs - completeJobs - incompleteJobs);
  const availability = coverage?.availability ?? (completeJobs === 0 ? "unavailable" : completeJobs === totalJobs ? "available" : "partial");
  lines.push(
    "",
    `Exact token usage coverage: ${availability} (${completeJobs} complete, ${incompleteJobs} incomplete, ${unreportedJobs} unreported)`
  );
  if (!usage || completeJobs <= 0) {
    lines.push("Token totals: unavailable");
    return;
  }
  lines.push(
    `Observed exact tokens (${completeJobs} complete job${completeJobs === 1 ? "" : "s"}):`,
    `- input tokens: ${usage.inputTokens}`,
    `- cache read input tokens: ${usage.cacheReadInputTokens}`,
    `- output tokens: ${usage.outputTokens}`,
    `- reasoning tokens: ${usage.reasoningTokens}`,
    `- total tokens: ${usage.totalTokens}`
  );
}

function pushHeadlessMetricsSection(lines, metrics, totalJobs) {
  if (!metrics) {
    return;
  }
  lines.push(
    "",
    `Turn count coverage: ${metrics.turnsReportedJobs}/${totalJobs} jobs`,
    metrics.turnAggregationOverflow ? "Observed turns: unavailable (aggregate exceeds the safe integer range)" : `Observed turns: ${metrics.totalTurns}`,
    `Exact cost coverage: ${metrics.exactCostJobs} exact, ${metrics.partialCostJobs} partial, ${metrics.unreportedCostJobs} unreported`
  );
  if (metrics.exactCostJobs > 0) {
    if (metrics.costAggregationOverflow) {
      lines.push("Observed exact cost: unavailable (aggregate ticks exceed the safe integer range)");
      return;
    }
    lines.push(
      `Observed exact cost: $${metrics.totalCostUsd}`,
      `Observed exact cost ticks: ${metrics.totalCostUsdTicks}`
    );
  }
}

export function renderStatsReport(stats) {
  if (stats.totalJobs === 0) {
    return stats.scope === "all"
      ? "No jobs recorded.\n"
      : "No jobs recorded for this workspace.\n";
  }
  const lines = [
    "# Grok stats",
    "",
    `Scope: ${stats.scope === "all" ? "all workspaces" : `workspace ${stats.cwd}`}`,
    `Total jobs: ${stats.totalJobs}`,
    `Created between ${stats.earliestCreatedAt} and ${stats.latestCreatedAt}`
  ];
  if (stats.meanWallClockSeconds != null) {
    lines.push(`Mean wall clock for finished jobs: ${stats.meanWallClockSeconds.toFixed(1)}s`);
  }
  pushCountSection(lines, "By status", stats.byStatus);
  pushCountSection(lines, "By mode", stats.byMode);
  pushCountSection(lines, "By resolved model", stats.byResolvedModel);
  pushCountSection(lines, "By model", stats.byModel);
  pushCountSection(lines, "By resolved effort", stats.byResolvedEffort);
  pushCountSection(lines, "By failure kind", stats.byFailureKind);
  pushUsageSection(lines, stats.usage, stats.usageCoverage, stats.totalJobs);
  pushHeadlessMetricsSection(lines, stats.headlessMetrics, stats.totalJobs);
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = [
    `Cancelled job ${job.id}.`,
    "Check /grok:status for the updated list.",
    "",
    `job: ${job.id}`,
    `sandbox: ${job.cwd}`,
    "state: cancelled"
  ];
  if (job.failureKind === "cancelled") {
    lines.push("failure: cancelled");
  }
  return `${lines.join("\n")}\n`;
}

export function renderRecordAcceptance(record) {
  return `Recorded verdict for Grok job ${record.id}: ${record.semanticStatus ?? "unverified"}.\n`;
}

export function renderSetupReport(report) {
  const lines = [
    "# Grok setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- grok binary (${report.grok.bin}): ${report.grok.available ? report.grok.detail : `unavailable, ${report.grok.detail}`}`,
    `- headless safety capabilities: ${report.capabilities?.ready ? "ready" : `not ready, ${report.capabilities?.detail ?? "not checked"}`}`,
    `- host environment: ${report.hostEnvironment?.ready ? "ready" : `needs attention, ${report.hostEnvironment?.detail ?? "not checked"}`}`,
    `- data dir: ${report.dataDir.writable ? `writable (${report.dataDir.path})` : `not writable (${report.dataDir.detail})`}`,
    `- stop gate: ${report.stopGate ? "enabled" : "disabled"}`,
    `- continuity: ${report.continuityPolicy ?? "manual"}`,
    `- grok doctor: ${report.doctorCommand?.available ? "available" : `not available, ${report.doctorCommand?.detail ?? "not checked"}`}`
  ];

  const nextSteps = [];
  if (!report.grok.available) {
    nextSteps.push("Install the grok CLI and make sure `grok --version` works, or point GROK_BIN at the binary.");
  }
  if (report.grok.available && !report.capabilities?.ready) {
    nextSteps.push("Upgrade the grok CLI to a build that exposes the required headless safety capabilities.");
  }
  if (!report.hostEnvironment?.ready && report.hostEnvironment?.runtimeSocketSymlinks?.length > 0) {
    nextSteps.push(`Stop the Docker engine that creates ${report.hostEnvironment.runtimeSocketSymlinks.join(", ")}, or remove the symlink. Do not downgrade the sandbox.`);
  }
  if (!report.dataDir.writable) {
    nextSteps.push(`Fix permissions on ${report.dataDir.path}.`);
  }
  if (nextSteps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  lines.push(
    "",
    "Model and effort defaults live in ~/.grok/config.toml; the companion never passes -m or --effort unless explicitly requested.",
    "Cross-session memory stays disabled unless a task explicitly passes --memory.",
    "Continuity defaults to manual; use /grok:setup --continuity claude-session to enable same-session task affinity.",
    "Toggle the stop-time review gate from the plugin's Stop gate review setting; /grok:setup --enable-stop-gate or --disable-stop-gate is the scripting fallback."
  );

  return `${lines.join("\n").trimEnd()}\n`;
}
