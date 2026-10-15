import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "../args.mjs";
import { resolveGrokBin, resolveTimeoutMs, sandboxProfileForMode, runGrok } from "../grok-exec.mjs";
import { getProcessIdentity } from "../process-identity.mjs";
import { extractFirstJsonObject, renderBackgroundLaunch, renderReviewFallback, renderReviewResult, renderTaskResult, validateReviewOutput } from "../render.mjs";
import { briefPath, createJobRecord, createJobRecordFile, generateJobId, jobFilePath, jobLogPath, launchRunningJobProcess, nowIso, readJobRecordFile, resolveDataDir, updateJobRecordFile, writeBrief } from "../state.mjs";
import { REVIEW_OUTPUT_SCHEMA } from "./config.mjs";
import { resolveGrokCompanionVersion, probeGrokVersion, requireTestedGrokFloor, requireQuotaAvailable } from "./version.mjs";
import { output, oneLineSummary, boundedTextTail, failureOutcomeMessage, resolveCwd, validateImplicitRepositoryCwd, findRequestedJobRecord, currentClaudeSessionId, commandArgs, backgroundDelivery, spawnBackgroundWorker } from "./base.mjs";
import { classifyFailure, finishJobRecord, resultFailed } from "./execution.mjs";
import { resultSpendPatch, outcomeFields, failureResultPayload, retainedResultPayload, failJob, describeLaunchFailure, launchFailureError, appendFailureLog, recordSpawnFailure } from "./outcome.mjs";
import { SELF_PATH, REVIEW_PROMPT_FILE } from "./paths.mjs";

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

function resolveRepositoryTopLevel(cwd) {
  try {
    const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    const value = String(result.stdout ?? "").trim();
    return value || null;
  } catch {
    return null;
  }
}

function untrackedReviewExcerpts(cwd) {
  const files = runGit(["ls-files", "--others", "--exclude-standard", "-z"], cwd).split("\0").filter(Boolean);
  const sections = [];
  let remaining = 64 * 1024;
  for (const file of files) {
    const heading = `- ${JSON.stringify(file)}`;
    let note = null;
    let content = "";
    try {
      const location = path.join(cwd, file);
      const stat = fs.lstatSync(location);
      if (!stat.isFile()) {
        note = "omitted: not a regular file";
      } else if (stat.size > 1024 * 1024) {
        note = "omitted: file exceeds 1 MiB";
      } else if (remaining === 0) {
        note = "omitted: 64 KiB total content limit reached";
      } else {
        const limit = Math.min(stat.size, 16 * 1024, remaining);
        const buffer = Buffer.alloc(stat.size);
        const fd = fs.openSync(location, "r");
        let read = 0;
        try {
          while (read < buffer.length) {
            const count = fs.readSync(fd, buffer, read, buffer.length - read, read);
            if (count === 0) break;
            read += count;
          }
        } finally {
          fs.closeSync(fd);
        }
        const full = buffer.subarray(0, read);
        const sample = full.subarray(0, limit);
        if (full.some((byte) => byte === 0 || (byte < 32 && ![9, 10, 12, 13].includes(byte)))) {
          note = "omitted: binary file";
        } else {
          let decoded = null;
          try {
            new TextDecoder("utf-8", { fatal: true }).decode(full);
          } catch {
            note = "omitted: binary or invalid UTF-8 file";
          }
          for (let trim = 0; note === null && trim <= Math.min(3, sample.length); trim += 1) {
            try {
              decoded = new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, sample.length - trim));
              break;
            } catch { /* The byte limit may split a UTF-8 character. */ }
          }
          if (decoded === null) {
            note = "omitted: binary or invalid UTF-8 file";
          } else {
            const lines = decoded.split(/\r?\n/);
            const overLines = lines.length > 200 && !(lines.length === 201 && lines[200] === "");
            content = overLines ? lines.slice(0, 200).join("\n") : decoded;
            remaining -= Buffer.byteLength(content, "utf8");
            if (overLines || sample.length < stat.size) note = "omitted: content truncated at 200 lines, 16 KiB per file, or 64 KiB total";
          }
        }
      }
    } catch {
      note = "omitted: file could not be read";
    }
    sections.push([heading, content, note ? `[${note}]` : ""].filter(Boolean).join("\n"));
  }
  return sections;
}

function collectReviewTarget(cwd, base) {
  if (base) {
    const range = runGit(["diff", `${base}...HEAD`], cwd);
    const uncommitted = runGit(["diff", "HEAD"], cwd);
    const parts = [range.trim(), uncommitted.trim()].filter(Boolean);
    return { label: `changes since ${base}`, diff: parts.join("\n\n") };
  }

  const tracked = runGit(["diff", "HEAD"], cwd);
  const untracked = untrackedReviewExcerpts(cwd);

  const parts = [tracked.trim()].filter(Boolean);
  if (untracked.length > 0) {
    parts.push(["Untracked files:", ...untracked].join("\n"));
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

function evaluateStructuredResult(result, textEvaluator, validator = null) {
  if (typeof result?.structuredOutputError === "string" && result.structuredOutputError.trim()) {
    return { valid: false, error: oneLineSummary(result.structuredOutputError) };
  }
  if (result?.structuredOutput !== undefined) {
    if (validator) {
      const validation = validator(result.structuredOutput);
      return validation.valid
        ? { valid: true, value: validation.value }
        : { valid: false, error: validation.error };
    }
    if (result.structuredOutput === null) {
      return { valid: false, error: "Grok returned a null structured output." };
    }
    return { valid: true, value: result.structuredOutput };
  }
  return textEvaluator(result?.text);
}

function evaluateTaskText(text) {
  const parsed = extractFirstJsonObject(text);
  return parsed
    ? { valid: true, value: parsed }
    : { valid: false, error: "No JSON object found in the reply." };
}

function evaluateTaskResult(result) {
  return evaluateStructuredResult(result, evaluateTaskText);
}

function consumeTaskStructuredResult(result, schemaRequested) {
  if (!schemaRequested) {
    return { valid: true, value: result?.text };
  }
  const evaluation = evaluateTaskResult(result);
  if (evaluation.valid && result.structuredOutput === undefined) {
    result.structuredOutput = evaluation.value;
    result.structuredOutputError = null;
  }
  return evaluation;
}

function evaluateReviewResult(result) {
  return evaluateStructuredResult(result, evaluateReviewText, validateReviewOutput);
}

async function runReviewJob(record, jobFile, options = {}) {
  const logFile = jobLogPath(resolveDataDir(), record.cwd, record.id);
  const timeoutMs = resolveTimeoutMs({ background: Boolean(options.background), env: process.env });
  let first;
  try {
    const prompt = fs.readFileSync(record.briefFile, "utf8");
    first = await runGrok({
      briefFile: record.briefFile,
      prompt,
      mode: "consult",
      jsonSchema: REVIEW_OUTPUT_SCHEMA,
      cwd: record.cwd,
      logFile,
      timeoutMs,
      launchProcess: (launch) => {
        requireQuotaAvailable(resolveDataDir());
        return launchRunningJobProcess(jobFile, launch);
      }
    });
  } catch (error) {
    recordSpawnFailure(jobFile, error);
    throw launchFailureError(error, record);
  }
  if (resultFailed(first)) {
    failJob(jobFile, logFile, first, timeoutMs);
  }

  const review = evaluateReviewResult(first);
  const sessionId = first.sessionId;
  const finalText = first.text;
  const spend = resultSpendPatch(first);

  const targetLabel = record.request?.reviewTargetLabel ?? "working tree changes";
  const body = review.valid
    ? renderReviewResult(review.value, { targetLabel })
    : renderReviewFallback(finalText, { parseError: review.error });
  const validationMessage = review.valid
    ? null
    : `Grok review output failed validation: ${review.error}`;

  const payload = {
    jobId: record.id,
    status: review.valid ? "done" : "error",
    ...outcomeFields(record, review.valid ? "done" : "error"),
    jobClass: "review",
    mode: "consult",
    background: record.background,
    memoryEnabled: false,
    sessionId,
    valid: review.valid,
    review: review.valid ? review.value : null,
    parseError: review.valid ? null : review.error,
    ...spend,
    failureKind: review.valid ? null : "error",
    rawText: finalText,
    rendered: body
  };

  finishJobRecord(jobFile, {
    status: review.valid ? "done" : "error",
    pid: null,
    grokPid: null,
    finishedAt: nowIso(),
    exitCode: 0,
    sessionId,
    resultText: body,
    resultPayload: retainedResultPayload(record, payload),
    ...spend,
    errorMessage: validationMessage,
    errorTail: review.valid ? null : boundedTextTail(finalText) || validationMessage,
    failureKind: review.valid ? null : "error",
    cancelRequestedAt: null
  });
  return payload;
}

async function handleReview(argv, transport = {}) {
  const { options, positionals, positionalText } = commandArgs(argv, {
    valueOptions: ["base", "focus", "cwd"],
    booleanOptions: ["background", "json"],
    optionsBeforePositionals: true
  }, transport);

  const cwd = resolveCwd(options);
  const repositoryTopLevel = resolveRepositoryTopLevel(cwd);
  validateImplicitRepositoryCwd(options, cwd, repositoryTopLevel);
  const dataDir = resolveDataDir();
  const background = transport.defaultBackground ? true : Boolean(options.background);
  ensureGitRepository(cwd);

  const target = collectReviewTarget(cwd, options.base);
  if (!target.diff.trim()) {
    throw new Error("No changes found to review.");
  }

  const focus = [options.focus ?? "", positionalText ?? positionals.join(" ")].join(" ").trim();
  const prompt = interpolateTemplate(loadReviewTemplate(), {
    TARGET_LABEL: target.label,
    USER_FOCUS: focus || "No extra focus provided.",
    DIFF: target.diff
  });
  requireQuotaAvailable(dataDir);
  const grok = probeGrokVersion(resolveGrokBin(), process.env);

  const jobId = generateJobId();
  const briefFile = briefPath(dataDir, cwd, jobId);
  const jobFile = jobFilePath(dataDir, cwd, jobId);
  const record = {
    ...createJobRecord({
      id: jobId,
      companionVersion: resolveGrokCompanionVersion(),
      grokVersion: grok.version,
      pid: background ? null : process.pid,
      mode: "consult",
      cwd,
      briefFile,
      background,
      delivery: background ? backgroundDelivery() : "foreground",
      claudeSessionId: currentClaudeSessionId(),
      jobClass: "review",
      request: {
        reviewTargetLabel: target.label,
        memory: false,
        sandboxProfile: sandboxProfileForMode("consult"),
        outputJson: Boolean(options.json),
        ingress: transport.ingress ?? "argv"
      }
    }),
    repositoryTopLevel
  };
  createJobRecordFile(jobFile, record);
  try {
    requireTestedGrokFloor(grok);
    requireQuotaAvailable(dataDir);
    writeBrief(dataDir, cwd, jobId, prompt);
  } catch (error) {
    recordSpawnFailure(jobFile, error);
    throw launchFailureError(error, record);
  }

  if (background) {
    try {
      await spawnBackgroundWorker([SELF_PATH, "review-worker", "--job-id", jobId, "--cwd", cwd], jobFile);
    } catch (error) {
      recordSpawnFailure(jobFile, error);
      throw launchFailureError(error, record);
    }
    const payload = {
      jobId,
      status: "running",
      ...outcomeFields(record, "running"),
      jobClass: "review",
      mode: "consult",
      background: true,
      memoryEnabled: false,
      resolvedModel: null,
      resolvedEffort: null,
      failureKind: null
    };
    output(options.json ? payload : renderBackgroundLaunch(jobId, record.delivery), options.json);
    return;
  }

  const payload = await runReviewJob(record, jobFile);
  if (!payload.valid) {
    throw new Error(
      failureOutcomeMessage({
        message: `Grok review output failed validation: ${payload.parseError}`,
        detail: payload.rendered,
        record,
        failureKind: "error"
      })
    );
  }
  output(
    options.json
      ? payload
      : renderTaskResult({ text: payload.rendered.trimEnd(), sessionId: payload.sessionId, jobId, cwd: record.cwd, delivery: record.delivery, semanticStatus: record.semanticStatus }),
    options.json
  );
}

async function handleReviewWorker(argv) {
  const { options } = parseArgs(argv, { valueOptions: ["job-id", "cwd"] });
  const jobId = options["job-id"];
  if (!jobId) {
    throw new Error("Missing required --job-id for review-worker.");
  }

  const dataDir = resolveDataDir();
  const found = findRequestedJobRecord(dataDir, jobId, options);
  if (!found) {
    throw new Error(`No job record found for ${jobId}.`);
  }

  if (found.record.status !== "running") {
    return;
  }

  const record = updateJobRecordFile(found.file, { pid: process.pid, pidIdentity: getProcessIdentity(process.pid) });
  const logFile = jobLogPath(dataDir, record.cwd, record.id);
  try {
    await runReviewJob(record, found.file, { background: true });
  } catch (error) {
    const current = readJobRecordFile(found.file);
    if (current?.status !== "running") {
      return;
    }
    if (error?.cleanupRequired || current.cleanupRequired) {
      recordSpawnFailure(found.file, error);
      return;
    }
    const message = describeLaunchFailure(error);
    const failureKind = classifyFailure({ spawnError: error });
    const errorTail = appendFailureLog(logFile, message);
    finishJobRecord(found.file, {
      status: "error",
      pid: null,
      grokPid: null,
      finishedAt: nowIso(),
      resultPayload: retainedResultPayload(
        record,
        failureResultPayload(record, { status: "error", failureKind, message })
      ),
      errorMessage: oneLineSummary(message),
      errorTail,
      failureKind
    });
  }
}

export { runGit, ensureGitRepository, resolveRepositoryTopLevel, untrackedReviewExcerpts, collectReviewTarget, loadReviewTemplate, interpolateTemplate, evaluateReviewText, evaluateStructuredResult, evaluateTaskText, evaluateTaskResult, consumeTaskStructuredResult, evaluateReviewResult, runReviewJob, handleReview, handleReviewWorker };
