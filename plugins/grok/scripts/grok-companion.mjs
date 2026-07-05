#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import {
  buildGrokArgs,
  resolveGrokBin,
  resolveTimeoutMs,
  runGrok,
  runningJobLiveness,
  terminateProcessGroup
} from "./lib/grok-exec.mjs";
import {
  extractFirstJsonObject,
  renderBackgroundLaunch,
  renderCancelReport,
  renderJobDetail,
  renderReviewFallback,
  renderReviewResult,
  renderSetupReport,
  renderStatsReport,
  renderStatusTable,
  renderTaskResult,
  validateReviewOutput
} from "./lib/render.mjs";
import {
  SESSION_ID_ENV,
  createJobRecord,
  findJobRecordById,
  generateJobId,
  jobFilePath,
  jobLogPath,
  listAllJobRecords,
  listJobRecords,
  nowIso,
  readJobRecordFile,
  readLogTail,
  resolveDataDir,
  updateJobRecordFile,
  updateJobRecordFileWithCurrent,
  finishSuccessfulJobRecordFile,
  writeBrief,
  writeJobRecordFile,
  appendJobLog
} from "./lib/state.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SELF_PATH), "..");
const REVIEW_PROMPT_FILE = path.join(ROOT_DIR, "prompts", "review.md");
const STOP_GATE_PROMPT_FILE = path.join(ROOT_DIR, "prompts", "stop-gate.md");
const STOP_GATE_TIMEOUT_MS = 240000;
const STOP_GATE_MAX_TURNS = 15;
const CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/grok-companion.mjs task [prompt] [--prompt-file <path>] [--write] [--web] [--background] [--resume <uuid>] [--resume-last] [--model <id>] [--effort <level>] [--max-turns <n>] [--best-of-n <n>] [--cwd <dir>] [--json]",
      "  node scripts/grok-companion.mjs review [--base <ref>] [--focus <text>] [--cwd <dir>] [--json]",
      "  node scripts/grok-companion.mjs status [job-id] [--cwd <dir>] [--json]",
      "  node scripts/grok-companion.mjs result <job-id> [--json]",
      "  node scripts/grok-companion.mjs cancel <job-id> [--cwd <dir>] [--json]",
      "  node scripts/grok-companion.mjs stats [--all] [--cwd <dir>] [--json]",
      "  node scripts/grok-companion.mjs setup [--enable-stop-gate] [--disable-stop-gate] [--json]",
      "  node scripts/grok-companion.mjs stop-gate"
    ].join("\n")
  );
}

function output(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function errorWithFailure(message, failureKind) {
  const error = new Error(message);
  error.failureKind = failureKind;
  return error;
}

function resolveCwd(options) {
  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  let stats;
  try {
    stats = fs.statSync(cwd);
  } catch {
    throw errorWithFailure(`Working directory does not exist: ${cwd}.`, "input");
  }
  if (!stats.isDirectory()) {
    throw errorWithFailure(`Working directory is not a directory: ${cwd}.`, "input");
  }
  return cwd;
}

function currentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function configFilePath(dataDir) {
  return path.join(dataDir, "config.json");
}

function readConfig(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFilePath(dataDir), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeConfig(dataDir, patch) {
  const next = { ...readConfig(dataDir), ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(configFilePath(dataDir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer for ${flag}.`);
  }
  return parsed;
}

function parseBestOfN(value) {
  const parsed = parsePositiveInteger(value, "--best-of-n");
  if (parsed < 2 || parsed > 10) {
    throw new Error("Expected --best-of-n between 2 and 10.");
  }
  return parsed;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readStdinIfPiped() {
  if (isatty(0)) {
    return "";
  }
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  for (;;) {
    let bytes;
    try {
      bytes = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error.code === "EAGAIN") {
        sleepMs(20);
        continue;
      }
      break;
    }
    if (bytes === 0) {
      break;
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytes)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readTaskPrompt(cwd, options, positionals) {
  const positionalPrompt = positionals.join(" ").trim();
  if (positionalPrompt) {
    return positionalPrompt;
  }
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8").trim();
  }
  return readStdinIfPiped().trim();
}

function resolveLastSessionId(dataDir, cwd, claudeSessionId) {
  const finished = listJobRecords(dataDir, cwd)
    .filter((job) => job.status !== "running" && job.sessionId)
    .sort((left, right) =>
      String(right.finishedAt ?? right.createdAt ?? "").localeCompare(
        String(left.finishedAt ?? left.createdAt ?? "")
      )
    );
  if (finished.length === 0) {
    throw new Error("No finished grok job with a session id was found for this workspace.");
  }
  const owned = finished.find((job) => claudeSessionId && job.claudeSessionId === claudeSessionId);
  return (owned ?? finished[0]).sessionId;
}

const PERMISSION_FAILURE_MESSAGE =
  "Grok's turn was cancelled by the consult-mode permission gate (a tool call outside the read-only allow list). Re-dispatch with --write if repository changes are acceptable, or rewrite the brief to avoid shell commands.";

function isPermissionCancelled(result) {
  return Boolean(result) && result.exitCode === 0 && !result.timedOut && result.stopReason === "Cancelled";
}

function grokFailureMessage(result, timeoutMs, failureKind) {
  if (failureKind === "permission") {
    return PERMISSION_FAILURE_MESSAGE;
  }
  if (result.parseError) {
    return result.parseError;
  }
  return result.timedOut
    ? `Grok timed out after ${timeoutMs}ms and was terminated.`
    : `Grok exited with code ${result.exitCode}.`;
}

const STDERR_FAILURE_KINDS = [
  ["quota", /quota|insufficient credit|usage limit/i],
  ["rate_limited", /rate.?limit|429|too many requests/i],
  ["auth", /auth|unauthori[sz]ed|forbidden|login required/i]
];

function classifyFailure({ spawnError = null, result = null, logTail = "" } = {}) {
  if (spawnError?.failureKind) {
    return spawnError.failureKind;
  }
  if (spawnError?.code === "ENOENT") {
    return "missing_cli";
  }
  if (result?.timedOut) {
    return "timeout";
  }
  if (result?.cancelledByCompanion) {
    return "cancelled";
  }
  if (isPermissionCancelled(result)) {
    return "permission";
  }
  const tail = String(logTail ?? "");
  for (const [kind, pattern] of STDERR_FAILURE_KINDS) {
    if (pattern.test(tail)) {
      return kind;
    }
  }
  return "error";
}

function finishJobRecord(jobFile, patch) {
  const current = readJobRecordFile(jobFile);
  if (current?.status === "done" || current?.status === "error" || current?.status === "cancelled") {
    return current;
  }
  return updateJobRecordFile(jobFile, patch);
}

function deadProcessMessage(deadPids) {
  if (deadPids.length === 0) {
    return "No process id was recorded before the launch grace window elapsed.";
  }
  const label = deadPids.length === 1 ? "pid" : "pids";
  return `Recorded ${label} ${deadPids.join(", ")} exited without recording an outcome.`;
}

function finishDiedJobRecord(file) {
  return updateJobRecordFileWithCurrent(file, (current) => {
    if (current.status !== "running") {
      return current;
    }
    const liveness = runningJobLiveness(current);
    if (liveness.alive) {
      return current;
    }
    const message = deadProcessMessage(liveness.deadPids);
    return {
      ...current,
      status: "error",
      pid: null,
      grokPid: null,
      finishedAt: nowIso(),
      errorMessage: message,
      errorTail: message,
      failureKind: "died",
      cancelRequestedAt: null
    };
  });
}

export function refreshRunningJobRecord({ record, file }) {
  const current = readJobRecordFile(file) ?? record;
  const liveness = runningJobLiveness(current);
  if (liveness.alive) {
    return { record: current, changed: false };
  }
  const next = finishDiedJobRecord(file);
  return { record: next, changed: next.status === "error" && next.failureKind === "died" };
}

function resultFailed(result) {
  return Boolean(result.parseError) || result.exitCode !== 0 || result.timedOut || isPermissionCancelled(result);
}

function failureTail(logFile, result) {
  const tail = readLogTail(logFile, 20);
  if (!result?.parseError || !result.stdoutTail) {
    return tail;
  }
  return [tail, "Stdout tail:", result.stdoutTail].filter(Boolean).join("\n");
}

function failJob(jobFile, logFile, result, timeoutMs) {
  const tail = failureTail(logFile, result);
  const current = readJobRecordFile(jobFile);
  const failureKind =
    current?.status === "cancelled" || current?.cancelRequestedAt
      ? "cancelled"
      : classifyFailure({ result, logTail: tail });
  const message = grokFailureMessage(result, timeoutMs, failureKind);
  const status = failureKind === "cancelled" ? "cancelled" : "error";
  const stateLine = status === "cancelled" ? "state: cancelled" : "state: error";
  finishJobRecord(jobFile, {
    status,
    pid: null,
    grokPid: null,
    finishedAt: nowIso(),
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    resultText: result.text || null,
    errorTail: tail || message,
    failureKind,
    cancelRequestedAt: null
  });
  throw new Error([message, stateLine, `failure: ${failureKind}`, tail].filter(Boolean).join("\n"));
}

function describeLaunchFailure(error) {
  if (error?.code === "ENOENT") {
    return `The grok CLI (${resolveGrokBin()}) was not found on PATH. Install and authenticate it, then run /grok:setup to verify.`;
  }
  return error instanceof Error ? error.message : String(error);
}

function launchFailureError(error) {
  return new Error(
    [describeLaunchFailure(error), "state: error", `failure: ${classifyFailure({ spawnError: error })}`].join("\n")
  );
}

function recordSpawnFailure(jobFile, error) {
  const message = describeLaunchFailure(error);
  try {
    finishJobRecord(jobFile, {
      status: "error",
      pid: null,
      grokPid: null,
      finishedAt: nowIso(),
      errorTail: message,
      failureKind: classifyFailure({ spawnError: error })
    });
  } catch {
    return;
  }
}

async function handleTask(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["prompt-file", "resume", "model", "effort", "max-turns", "best-of-n", "cwd"],
    booleanOptions: ["write", "background", "resume-last", "web", "json"]
  });

  const cwd = resolveCwd(options);
  const dataDir = resolveDataDir();
  const claudeSessionId = currentClaudeSessionId();

  let resumeSessionId = options.resume ?? null;
  if (!resumeSessionId && options["resume-last"]) {
    resumeSessionId = resolveLastSessionId(dataDir, cwd, claudeSessionId);
  }

  let prompt = readTaskPrompt(cwd, options, positionals);
  if (!prompt) {
    if (!resumeSessionId) {
      throw new Error("Provide a prompt, a prompt file, piped stdin, or a session to resume.");
    }
    prompt = CONTINUE_PROMPT;
  }

  const bestOfN = options["best-of-n"] ? parseBestOfN(options["best-of-n"]) : null;
  const maxTurns = options["max-turns"] ? parsePositiveInteger(options["max-turns"], "--max-turns") : null;
  const mode = options.write || bestOfN ? "write" : "consult";

  const jobId = generateJobId();
  const briefFile = writeBrief(dataDir, cwd, jobId, prompt);
  const jobFile = jobFilePath(dataDir, cwd, jobId);
  const record = createJobRecord({
    id: jobId,
    pid: options.background ? null : process.pid,
    mode,
    cwd,
    briefFile,
    background: Boolean(options.background),
    claudeSessionId,
    request: {
      model: options.model ?? null,
      effort: options.effort ?? null,
      maxTurns,
      bestOfN,
      web: Boolean(options.web),
      resumeSessionId
    }
  });
  writeJobRecordFile(jobFile, record);

  if (options.background) {
    const child = spawn(process.execPath, [SELF_PATH, "task-worker", "--job-id", jobId], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    updateJobRecordFile(jobFile, { pid: child.pid ?? null });
    const payload = { jobId, status: "running", mode, background: true, failureKind: null };
    output(options.json ? payload : renderBackgroundLaunch(jobId), options.json);
    return;
  }

  const logFile = jobLogPath(dataDir, cwd, jobId);
  const timeoutMs = resolveTimeoutMs({ env: process.env });
  let result;
  try {
    result = await runGrok({
      briefFile,
      mode,
      resumeSessionId,
      model: options.model ?? null,
      effort: options.effort ?? null,
      maxTurns,
      bestOfN,
      web: Boolean(options.web),
      cwd,
      logFile,
      timeoutMs,
      onSpawn: (pid) => updateJobRecordFile(jobFile, { grokPid: pid ?? null })
    });
  } catch (error) {
    recordSpawnFailure(jobFile, error);
    throw launchFailureError(error);
  }

  if (resultFailed(result)) {
    failJob(jobFile, logFile, result, timeoutMs);
  }

  const finishedAt = nowIso();
  const final = finishSuccessfulJobRecordFile(jobFile, {
    status: "done",
    pid: null,
    grokPid: null,
    finishedAt,
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    resultText: result.text,
    failureKind: null
  });

  if (final.status === "cancelled") {
    throw new Error(["Job was cancelled.", "state: cancelled", "failure: cancelled"].join("\n"));
  }

  const payload = {
    jobId,
    status: "done",
    mode,
    background: false,
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    stopReason: result.stopReason,
    failureKind: null,
    text: result.text
  };
  output(
    options.json ? payload : renderTaskResult({ text: result.text, sessionId: result.sessionId, jobId }),
    options.json
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseArgs(argv, { valueOptions: ["job-id"] });
  const jobId = options["job-id"];
  if (!jobId) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const dataDir = resolveDataDir();
  const found = findJobRecordById(dataDir, jobId);
  if (!found) {
    throw new Error(`No job record found for ${jobId}.`);
  }

  const record = found.record;
  if (record.status !== "running") {
    return;
  }
  const logFile = jobLogPath(dataDir, record.cwd, record.id);
  updateJobRecordFile(found.file, { pid: process.pid });

  const request = record.request ?? {};
  const timeoutMs = resolveTimeoutMs({ background: true, env: process.env });

  try {
    const result = await runGrok({
      briefFile: record.briefFile,
      mode: record.mode,
      resumeSessionId: request.resumeSessionId ?? null,
      model: request.model ?? null,
      effort: request.effort ?? null,
      maxTurns: request.maxTurns ?? null,
      bestOfN: request.bestOfN ?? null,
      web: Boolean(request.web),
      cwd: record.cwd,
      logFile,
      timeoutMs,
      onSpawn: (pid) => updateJobRecordFile(found.file, { grokPid: pid ?? null })
    });

    const finishedAt = nowIso();
    if (!resultFailed(result)) {
      finishSuccessfulJobRecordFile(found.file, {
        status: "done",
        pid: null,
        grokPid: null,
        finishedAt,
        exitCode: result.exitCode,
        sessionId: result.sessionId,
        resultText: result.text,
        failureKind: null
      });
      return;
    }

    const tail = failureTail(logFile, result);
    const current = readJobRecordFile(found.file);
    const failureKind =
      current?.status === "cancelled" || current?.cancelRequestedAt
        ? "cancelled"
        : classifyFailure({ result, logTail: tail });
    const message = grokFailureMessage(result, timeoutMs, failureKind);
    finishJobRecord(found.file, {
      status: failureKind === "cancelled" ? "cancelled" : "error",
      pid: null,
      grokPid: null,
      finishedAt,
      exitCode: result.exitCode,
      sessionId: result.sessionId,
      resultText: result.text || null,
      errorTail: tail || message,
      failureKind,
      cancelRequestedAt: null
    });
  } catch (error) {
    appendJobLog(logFile, describeLaunchFailure(error));
    finishJobRecord(found.file, {
      status: "error",
      pid: null,
      grokPid: null,
      finishedAt: nowIso(),
      errorTail: readLogTail(logFile, 20),
      failureKind: classifyFailure({ spawnError: error })
    });
  }
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  }
  return result.stdout ?? "";
}

function ensureGitRepository(cwd) {
  const result = spawnSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error("Not inside a git repository.");
  }
}

function collectReviewTarget(cwd, base) {
  if (base) {
    const range = runGit(["diff", `${base}...HEAD`], cwd);
    const uncommitted = runGit(["diff", "HEAD"], cwd);
    const parts = [range.trim(), uncommitted.trim()].filter(Boolean);
    return { label: `changes since ${base}`, diff: parts.join("\n\n") };
  }

  const tracked = runGit(["diff", "HEAD"], cwd);
  const porcelain = runGit(["status", "--porcelain"], cwd);
  const untracked = porcelain
    .split(/\r?\n/)
    .filter((line) => line.startsWith("??"))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  const parts = [tracked.trim()].filter(Boolean);
  if (untracked.length > 0) {
    parts.push(["Untracked files:", ...untracked.map((file) => `- ${file}`)].join("\n"));
  }
  return { label: "working tree changes", diff: parts.join("\n\n") };
}

function loadReviewTemplate() {
  if (!fs.existsSync(REVIEW_PROMPT_FILE)) {
    throw new Error(`Missing review prompt template at ${REVIEW_PROMPT_FILE}.`);
  }
  return fs.readFileSync(REVIEW_PROMPT_FILE, "utf8");
}

function interpolateTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.hasOwn(values, key) ? values[key] : match
  );
}

function evaluateReviewText(text) {
  const parsed = extractFirstJsonObject(text);
  if (!parsed) {
    return { valid: false, error: "No JSON object found in the reply." };
  }
  const validation = validateReviewOutput(parsed);
  if (!validation.valid) {
    return { valid: false, error: validation.error };
  }
  return { valid: true, value: validation.value };
}

function buildCorrectivePrompt(error) {
  return [
    `Your previous reply was not a single valid JSON review object (${error}).`,
    'Reply with only one JSON object and nothing else: {"verdict": "approve" or "needs-attention", "findings": array of objects with required severity (high, medium, or low), title, body and optional file, line_start, line_end, confidence, recommendation, "next_steps": array of strings}.',
    "No markdown fences, no prose before or after the object."
  ].join(" ");
}

async function handleReview(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["base", "focus", "cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCwd(options);
  const dataDir = resolveDataDir();
  ensureGitRepository(cwd);

  const target = collectReviewTarget(cwd, options.base);
  if (!target.diff.trim()) {
    throw new Error("No changes found to review.");
  }

  const focus = [options.focus ?? "", positionals.join(" ")].join(" ").trim();
  const prompt = interpolateTemplate(loadReviewTemplate(), {
    TARGET_LABEL: target.label,
    USER_FOCUS: focus || "No extra focus provided.",
    DIFF: target.diff
  });

  const jobId = generateJobId();
  const briefFile = writeBrief(dataDir, cwd, jobId, prompt);
  const jobFile = jobFilePath(dataDir, cwd, jobId);
  writeJobRecordFile(
    jobFile,
    createJobRecord({
      id: jobId,
      pid: process.pid,
      mode: "consult",
      cwd,
      briefFile,
      background: false,
      claudeSessionId: currentClaudeSessionId()
    })
  );

  const logFile = jobLogPath(dataDir, cwd, jobId);
  const timeoutMs = resolveTimeoutMs({ env: process.env });
  const recordGrokPid = (pid) => updateJobRecordFile(jobFile, { grokPid: pid ?? null });
  let first;
  try {
    first = await runGrok({ briefFile, mode: "consult", cwd, logFile, timeoutMs, onSpawn: recordGrokPid });
  } catch (error) {
    recordSpawnFailure(jobFile, error);
    throw launchFailureError(error);
  }
  if (resultFailed(first)) {
    failJob(jobFile, logFile, first, timeoutMs);
  }

  let review = evaluateReviewText(first.text);
  let sessionId = first.sessionId;
  let finalText = first.text;

  if (!review.valid && first.sessionId) {
    const retryBrief = writeBrief(dataDir, cwd, `${jobId}-retry`, buildCorrectivePrompt(review.error));
    let retry;
    try {
      retry = await runGrok({
        briefFile: retryBrief,
        mode: "consult",
        resumeSessionId: first.sessionId,
        cwd,
        logFile,
        timeoutMs,
        onSpawn: recordGrokPid
      });
    } catch (error) {
      recordSpawnFailure(jobFile, error);
      throw launchFailureError(error);
    }
    if (!resultFailed(retry)) {
      review = evaluateReviewText(retry.text);
      if (retry.text) {
        finalText = retry.text;
      }
      sessionId = retry.sessionId ?? sessionId;
    }
  }

  const body = review.valid
    ? renderReviewResult(review.value, { targetLabel: target.label })
    : renderReviewFallback(finalText, { parseError: review.error });

  finishJobRecord(jobFile, {
    status: "done",
    pid: null,
    grokPid: null,
    finishedAt: nowIso(),
    exitCode: 0,
    sessionId,
    resultText: body,
    failureKind: null,
    cancelRequestedAt: null
  });

  const payload = {
    jobId,
    sessionId,
    valid: review.valid,
    review: review.valid ? review.value : null,
    parseError: review.valid ? null : review.error,
    failureKind: null,
    rawText: finalText,
    rendered: body
  };
  output(
    options.json ? payload : renderTaskResult({ text: body.trimEnd(), sessionId, jobId }),
    options.json
  );
}

function handleStatus(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const dataDir = resolveDataDir();
  const jobId = positionals[0];
  if (jobId) {
    const found = findJobRecordById(dataDir, jobId);
    if (!found) {
      throw new Error(`No job record found for ${jobId}.`);
    }
    const { record } = refreshRunningJobRecord(found);
    const logTail =
      record.status === "error" ? readLogTail(jobLogPath(dataDir, record.cwd, record.id), 20) : "";
    output(options.json ? record : renderJobDetail(record, { logTail }), options.json);
    return;
  }

  const jobs = listJobRecords(dataDir, resolveCwd(options)).map((record) =>
    refreshRunningJobRecord({ record, file: jobFilePath(dataDir, record.cwd, record.id) }).record
  );
  output(options.json ? { jobs } : renderStatusTable(jobs, currentClaudeSessionId()), options.json);
}

function renderFailedResult(record, dataDir) {
  const tail = readLogTail(jobLogPath(dataDir, record.cwd, record.id), 20) || record.errorTail || "";
  const lines = [
    `Job ${record.id} failed${record.exitCode != null ? ` with exit code ${record.exitCode}` : ""}.`,
    "state: error"
  ];
  if (record.failureKind) {
    lines.push(`failure: ${record.failureKind}`);
  }
  if (tail) {
    lines.push("", "Log tail:", "", "```text", tail, "```");
  }
  return `${lines.join("\n")}\n`;
}

function handleResult(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("Provide a job id, for example /grok:result <job-id>.");
  }

  const dataDir = resolveDataDir();
  const found = findJobRecordById(dataDir, jobId);
  if (!found) {
    throw new Error(`No job record found for ${jobId}.`);
  }

  const { record } = refreshRunningJobRecord(found);
  if (options.json) {
    output(record, true);
    return;
  }

  if (record.status === "running") {
    output(`Job ${record.id} is still running. Check /grok:status ${record.id} for progress.\n`, false);
    return;
  }

  if (record.status === "error") {
    output(renderFailedResult(record, dataDir), false);
    return;
  }

  if (record.status === "cancelled") {
    const lines = [`Job ${record.id} was cancelled.`, "state: cancelled"];
    if (record.failureKind) {
      lines.push(`failure: ${record.failureKind}`);
    }
    output(`${lines.join("\n")}\n`, false);
    return;
  }

  output(
    renderTaskResult({ text: record.resultText ?? "", sessionId: record.sessionId, jobId: record.id }),
    false
  );
}

async function handleCancel(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const jobId = positionals[0];
  if (!jobId) {
    throw new Error("Provide a job id, for example /grok:cancel <job-id>.");
  }

  const dataDir = resolveDataDir();
  const found = findJobRecordById(dataDir, jobId);
  if (!found) {
    throw new Error(`No job record found for ${jobId}.`);
  }

  const refreshed = refreshRunningJobRecord(found);
  const record = refreshed.record;
  if (record.status !== "running") {
    output(
      options.json
        ? record
        : refreshed.changed && record.status === "error"
          ? renderFailedResult(record, dataDir)
          : `Job ${record.id} is not running (status: ${record.status}).\n`,
      options.json
    );
    return;
  }
  const requested = updateJobRecordFile(found.file, { cancelRequestedAt: nowIso() });
  if (requested.status !== "running") {
    output(
      options.json ? requested : `Job ${requested.id} is not running (status: ${requested.status}).\n`,
      options.json
    );
    return;
  }

  const pids = new Set();
  if (record.grokPid) {
    pids.add(record.grokPid);
  }
  if (record.background || !record.grokPid) {
    pids.add(record.pid);
  }
  await Promise.all([...pids].map((pid) => terminateProcessGroup(pid)));
  const next = updateJobRecordFile(found.file, {
    status: "cancelled",
    pid: null,
    grokPid: null,
    finishedAt: nowIso(),
    failureKind: "cancelled",
    cancelRequestedAt: null
  });
  if (next.status !== "cancelled") {
    output(options.json ? next : `Job ${next.id} is not running (status: ${next.status}).\n`, options.json);
    return;
  }
  output(options.json ? next : renderCancelReport(next), options.json);
}

function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function aggregateJobStats(records) {
  const byStatus = {};
  const byMode = {};
  const byFailureKind = {};
  const doneDurations = [];
  let earliest = null;
  let latest = null;

  for (const record of records) {
    increment(byStatus, record.status ?? "unknown");
    increment(byMode, record.mode ?? "unknown");
    if (record.status === "error" || record.status === "cancelled") {
      increment(byFailureKind, record.failureKind ?? (record.status === "cancelled" ? "cancelled" : "error"));
    }
    const created = Date.parse(record.createdAt ?? "");
    if (Number.isFinite(created)) {
      if (earliest == null || record.createdAt < earliest) {
        earliest = record.createdAt;
      }
      if (latest == null || record.createdAt > latest) {
        latest = record.createdAt;
      }
    }
    if (record.status === "done") {
      const finished = Date.parse(record.finishedAt ?? "");
      if (Number.isFinite(created) && Number.isFinite(finished) && finished >= created) {
        doneDurations.push((finished - created) / 1000);
      }
    }
  }

  const meanWallClockSeconds =
    doneDurations.length > 0
      ? Math.round((doneDurations.reduce((sum, value) => sum + value, 0) / doneDurations.length) * 1000) / 1000
      : null;

  return {
    totalJobs: records.length,
    byStatus,
    byMode,
    byFailureKind,
    meanWallClockSeconds,
    earliestCreatedAt: earliest,
    latestCreatedAt: latest
  };
}

function handleStats(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["all", "json"]
  });

  const dataDir = resolveDataDir();
  const cwd = resolveCwd(options);
  const records = options.all
    ? listAllJobRecords(dataDir).map((entry) => refreshRunningJobRecord(entry).record)
    : listJobRecords(dataDir, cwd).map((record) =>
        refreshRunningJobRecord({ record, file: jobFilePath(dataDir, record.cwd, record.id) }).record
      );
  const stats = {
    scope: options.all ? "all" : "workspace",
    cwd: options.all ? null : cwd,
    ...aggregateJobStats(records)
  };
  output(options.json ? stats : renderStatsReport(stats), options.json);
}

function handleSetup(argv) {
  const { options } = parseArgs(argv, {
    booleanOptions: ["json", "enable-stop-gate", "disable-stop-gate"]
  });
  if (options["enable-stop-gate"] && options["disable-stop-gate"]) {
    throw new Error("Use either --enable-stop-gate or --disable-stop-gate, not both.");
  }

  const bin = resolveGrokBin();
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
  const available = !probe.error && probe.status === 0;
  const detail = available
    ? (probe.stdout || probe.stderr).trim() || "ok"
    : probe.error?.code === "ENOENT"
      ? "not found on PATH"
      : (probe.stderr || probe.stdout || probe.error?.message || `exit ${probe.status}`).trim();

  const dataDir = resolveDataDir();
  let writable = true;
  let writeDetail = dataDir;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);
  } catch (error) {
    writable = false;
    writeDetail = error instanceof Error ? error.message : String(error);
  }

  if (options["enable-stop-gate"]) {
    writeConfig(dataDir, { stopGate: true });
  } else if (options["disable-stop-gate"]) {
    writeConfig(dataDir, { stopGate: false });
  }

  const report = {
    ready: available && writable,
    grok: { available, detail, bin },
    dataDir: { path: dataDir, writable, detail: writeDetail },
    stopGate: Boolean(readConfig(dataDir).stopGate)
  };
  output(options.json ? report : renderSetupReport(report), options.json);
}

function parseStopGateInput() {
  const raw = readStdinIfPiped().trim();
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function emitStopGateBlock(reason) {
  const payload = {
    decision: "block",
    reason: `Grok stop-time review found issues that still need fixes before ending the session: ${reason}`
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function handleStopGate() {
  const input = parseStopGateInput();
  if (!input) {
    return;
  }

  const dataDir = resolveDataDir();
  if (!readConfig(dataDir).stopGate || input.stop_hook_active) {
    return;
  }

  const cwd = input.cwd ? path.resolve(String(input.cwd)) : process.cwd();
  const probe = spawnSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    return;
  }

  let target;
  try {
    target = collectReviewTarget(cwd, null);
  } catch {
    return;
  }
  if (!target.diff.trim()) {
    return;
  }

  if (!fs.existsSync(STOP_GATE_PROMPT_FILE)) {
    return;
  }
  const prompt = interpolateTemplate(fs.readFileSync(STOP_GATE_PROMPT_FILE, "utf8"), {
    DIFF: target.diff
  });

  const jobId = generateJobId();
  const briefFile = writeBrief(dataDir, cwd, jobId, prompt);
  const jobFile = jobFilePath(dataDir, cwd, jobId);
  writeJobRecordFile(
    jobFile,
    createJobRecord({
      id: jobId,
      pid: process.pid,
      mode: "consult",
      cwd,
      briefFile,
      background: false,
      claudeSessionId: input.session_id ?? currentClaudeSessionId(),
      request: { maxTurns: STOP_GATE_MAX_TURNS }
    })
  );

  const logFile = jobLogPath(dataDir, cwd, jobId);
  let result;
  try {
    result = await runGrok({
      briefFile,
      mode: "consult",
      maxTurns: STOP_GATE_MAX_TURNS,
      cwd,
      logFile,
      timeoutMs: STOP_GATE_TIMEOUT_MS,
      onSpawn: (pid) => updateJobRecordFile(jobFile, { grokPid: pid ?? null })
    });
  } catch (error) {
    recordSpawnFailure(jobFile, error);
    return;
  }

  if (resultFailed(result)) {
    const tail = failureTail(logFile, result);
    const failureKind = classifyFailure({ result, logTail: tail });
    finishJobRecord(jobFile, {
      status: "error",
      pid: null,
      grokPid: null,
      finishedAt: nowIso(),
      exitCode: result.exitCode,
      sessionId: result.sessionId,
      resultText: result.text || null,
      errorTail: tail || grokFailureMessage(result, STOP_GATE_TIMEOUT_MS, failureKind),
      failureKind
    });
    return;
  }

  finishJobRecord(jobFile, {
    status: "done",
    pid: null,
    grokPid: null,
    finishedAt: nowIso(),
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    resultText: result.text,
    failureKind: null,
    cancelRequestedAt: null
  });

  const text = String(result.text ?? "").trim();
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (firstLine?.startsWith("BLOCK:")) {
    emitStopGateBlock(firstLine.slice("BLOCK:".length).trim() || text);
  }
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "status":
      handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "stats":
      handleStats(argv);
      break;
    case "setup":
      handleSetup(argv);
      break;
    case "stop-gate":
      try {
        await handleStopGate();
      } catch {
        return;
      }
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}.`);
  }
}

function wantsJsonError() {
  return process.argv.slice(3).some((token) => token === "--json" || token === "--json=true");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorFailureKind(error, message) {
  if (error?.failureKind) {
    return error.failureKind;
  }
  const match = String(message ?? "").match(/^failure: ([a-z_]+)$/m);
  return match ? match[1] : "error";
}

function errorStatus(message) {
  const match = String(message ?? "").match(/^state: (done|error|cancelled|running)$/m);
  return match ? match[1] : "error";
}

function renderTopLevelError(error) {
  const message = errorMessage(error).trimEnd();
  const failureKind = errorFailureKind(error, message);
  const status = errorStatus(message);
  if (wantsJsonError()) {
    return `${JSON.stringify({ status, failureKind, message }, null, 2)}\n`;
  }
  const lines = [message || "Grok companion failed."];
  if (!/^state: /m.test(message)) {
    lines.push("state: error");
  }
  if (!/^failure: /m.test(message)) {
    lines.push(`failure: ${failureKind}`);
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  main().catch((error) => {
    process.stderr.write(renderTopLevelError(error));
    process.exitCode = 1;
  });
}
