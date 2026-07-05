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

export function renderTaskResult({ text, sessionId, jobId }) {
  const lines = [String(text ?? "").trimEnd() || "Grok returned no output."];
  lines.push("");
  if (sessionId) {
    lines.push(`grok-session: ${sessionId}`);
  }
  if (jobId) {
    lines.push(`job: ${jobId}`);
  }
  lines.push("state: done");
  return `${lines.join("\n")}\n`;
}

export function renderBackgroundLaunch(jobId) {
  return [
    `Started background job ${jobId}.`,
    `Check progress with /grok:status ${jobId}.`,
    `Fetch the result with /grok:result ${jobId}.`,
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
    `state: ${job.status}`,
    `Mode: ${job.mode}`,
    `Background: ${job.background ? "yes" : "no"}`,
    `Created: ${job.createdAt}`
  ];
  if (job.finishedAt) {
    lines.push(`Finished: ${job.finishedAt}`);
  }
  if (job.exitCode != null) {
    lines.push(`Exit code: ${job.exitCode}`);
  }
  if (job.failureKind) {
    lines.push(`failure: ${job.failureKind}`);
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
  pushCountSection(lines, "By failure kind", stats.byFailureKind);
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = [
    `Cancelled job ${job.id}.`,
    "state: cancelled",
  ];
  if (job.failureKind === "cancelled") {
    lines.push("failure: cancelled");
  }
  lines.push("Check /grok:status for the updated list.", "");
  return lines.join("\n");
}

export function renderSetupReport(report) {
  const lines = [
    "# Grok setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- grok binary (${report.grok.bin}): ${report.grok.available ? report.grok.detail : `unavailable, ${report.grok.detail}`}`,
    `- data dir: ${report.dataDir.writable ? `writable (${report.dataDir.path})` : `not writable (${report.dataDir.detail})`}`,
    `- stop gate: ${report.stopGate ? "enabled" : "disabled"}`
  ];

  const nextSteps = [];
  if (!report.grok.available) {
    nextSteps.push("Install the grok CLI and make sure `grok --version` works, or point GROK_BIN at the binary.");
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
    "Toggle the stop-time review gate with /grok:setup --enable-stop-gate or --disable-stop-gate."
  );

  return `${lines.join("\n").trimEnd()}\n`;
}
