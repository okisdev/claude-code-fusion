import fs from "node:fs";
import { parseArgs } from "../args.mjs";
import { normalizeGrokSessionId, resolveGrokBin, resolveTimeoutMs, sandboxProfileForMode, runGrok, terminalRecordAttribution } from "../grok-exec.mjs";
import { getProcessIdentity } from "../process-identity.mjs";
import { renderBackgroundLaunch, renderTaskResult } from "../render.mjs";
import { briefPath, clearQuotaCooldown, claimResumeSessionLease, createJobRecord, createJobRecordFile, generateJobId, jobFilePath, jobLogPath, launchRunningJobProcess, nowIso, readJobRecordFile, resolveDataDir, updateJobRecordFile, finishSuccessfulJobRecordFile, writeBrief } from "../state.mjs";
import { CONTINUE_PROMPT } from "./config.mjs";
import { resolveGrokCompanionVersion, probeGrokVersion, requireTestedGrokFloor, requireQuotaAvailable } from "./version.mjs";
import { output, oneLineSummary, failureOutcomeMessage, resolveCwd, validateImplicitRepositoryCwd, findRequestedJobRecord, currentClaudeSessionId, continuityPolicy, parsePositiveInteger, parseJsonSchema, commandArgs, readTaskPrompt, isFusionRoutedPrompt, grokRoleFromPrompt, backgroundDelivery, spawnBackgroundWorker } from "./base.mjs";
import { inputError, resolveLastSessionJob, validateResumeSession } from "./session.mjs";
import { grokFailureMessage, classifyFailure, finishJobRecord, resultFailed, failureTail } from "./execution.mjs";
import { resultSpendPatch, outcomeFields, taskSuccessPayload, failureResultPayload, retainedResultPayload, failJob, finishTaskStructuredFailure, describeLaunchFailure, launchFailureError, appendFailureLog, recordSpawnFailure } from "./outcome.mjs";
import { resolveRepositoryTopLevel, consumeTaskStructuredResult } from "./review.mjs";
import { SELF_PATH } from "./paths.mjs";

async function handleTask(argv, transport = {}) {
  const { options, positionals, positionalText } = commandArgs(argv, {
    valueOptions: ["prompt-file", "resume", "model", "effort", "max-turns", "cwd", "json-schema"],
    booleanOptions: ["write", "background", "resume-last", "fresh", "memory", "web", "json"],
    optionsBeforePositionals: true
  }, transport);

  const jsonSchema = options["json-schema"] === undefined ? null : parseJsonSchema(options["json-schema"]);
  const cwd = resolveCwd(options);
  const repositoryTopLevel = resolveRepositoryTopLevel(cwd);
  validateImplicitRepositoryCwd(options, cwd, repositoryTopLevel);
  const dataDir = resolveDataDir();
  const claudeSessionId = currentClaudeSessionId();

  const maxTurns = options["max-turns"] ? parsePositiveInteger(options["max-turns"], "--max-turns") : null;
  const write = options.write === undefined ? Boolean(transport.defaultWrite) : Boolean(options.write);
  const background = Boolean(options.background);
  const mode = write ? "write" : "consult";
  const memory = Boolean(options.memory);
  const selectedContinuityPolicy = continuityPolicy(dataDir);
  const explicitResume = options.resume != null;
  const resumeLast = Boolean(options["resume-last"]);
  const fresh = Boolean(options.fresh);

  if (explicitResume && resumeLast) {
    throw inputError("Use only one of --resume or --resume-last.");
  }
  if (fresh && (explicitResume || resumeLast)) {
    throw inputError("--fresh cannot be combined with --resume or --resume-last.");
  }
  let prompt = readTaskPrompt(cwd, options, positionals, positionalText);
  const fusionRouted = isFusionRoutedPrompt(prompt);
  if (memory && fusionRouted) {
    throw inputError("--memory is available only for direct ordinary tasks, not Fusion routed briefs.");
  }
  let resumeSource = null;
  let resumeReason = null;
  if (explicitResume) {
    resumeSource = validateResumeSession(dataDir, cwd, options.resume, mode, memory);
    resumeReason = "explicit";
  } else if (resumeLast) {
    resumeSource = resolveLastSessionJob(dataDir, cwd, claudeSessionId, mode, memory);
    resumeReason = "last";
  } else if (
    prompt &&
    !fresh &&
    selectedContinuityPolicy === "claude-session" &&
    claudeSessionId &&
    !fusionRouted
  ) {
    resumeSource = resolveLastSessionJob(dataDir, cwd, claudeSessionId, mode, memory, {
      doneOnly: true,
      optional: true
    });
    resumeReason = resumeSource ? "affinity" : null;
  }
  const resumeSessionId = resumeSource ? normalizeGrokSessionId(resumeSource.sessionId) : null;
  if (!prompt) {
    if (!resumeSessionId) {
      throw new Error("Provide a prompt, a prompt file, piped stdin, or a session to resume.");
    }
    prompt = CONTINUE_PROMPT;
  }
  const role = grokRoleFromPrompt(prompt);
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
      mode,
      cwd,
      briefFile,
      background,
      delivery: background ? backgroundDelivery() : "foreground",
      claudeSessionId,
      jobClass: "task",
      role,
      request: {
        model: options.model ?? null,
        effort: options.effort ?? null,
        maxTurns,
        web: Boolean(options.web),
        memory,
        sandboxProfile: sandboxProfileForMode(mode),
        resumeSessionId,
        resumeSourceJobId: resumeSource?.id ?? null,
        resumeReason,
        continuityPolicy: selectedContinuityPolicy,
        role,
        jsonSchema,
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
    if (resumeSessionId) {
      claimResumeSessionLease(dataDir, cwd, resumeSessionId, jobId);
    }
  } catch (error) {
    recordSpawnFailure(jobFile, error);
    throw launchFailureError(error, record);
  }

  if (background) {
    try {
      await spawnBackgroundWorker([SELF_PATH, "task-worker", "--job-id", jobId, "--cwd", cwd], jobFile);
    } catch (error) {
      recordSpawnFailure(jobFile, error);
      throw launchFailureError(error, record);
    }
    const payload = {
      jobId,
      status: "running",
      ...outcomeFields(record, "running"),
      jobClass: record.jobClass,
      mode,
      background: true,
      memoryEnabled: memory,
      resolvedModel: null,
      resolvedEffort: null,
      failureKind: null
    };
    output(options.json ? payload : renderBackgroundLaunch(jobId, record.delivery), options.json);
    return;
  }

  const logFile = jobLogPath(dataDir, cwd, jobId);
  const timeoutMs = resolveTimeoutMs({ env: process.env });
  let result;
  try {
    result = await runGrok({
      briefFile,
      prompt,
      mode,
      resumeSessionId,
      model: options.model ?? null,
      effort: options.effort ?? null,
      maxTurns,
      web: Boolean(options.web),
      memory,
      jsonSchema,
      cwd,
      logFile,
      timeoutMs,
      launchProcess: (launch) => {
        requireQuotaAvailable(dataDir);
        return launchRunningJobProcess(jobFile, launch);
      }
    });
  } catch (error) {
    recordSpawnFailure(jobFile, error);
    throw launchFailureError(error, record);
  }

  if (resultFailed(result)) {
    failJob(jobFile, logFile, result, timeoutMs);
  }

  const structured = consumeTaskStructuredResult(result, jsonSchema !== null);
  if (!structured.valid) {
    throw new Error(finishTaskStructuredFailure(jobFile, result, structured));
  }

  const payload = taskSuccessPayload(record, result);
  const finishedAt = nowIso();
  const successPatch = {
    status: "done",
    pid: null,
    grokPid: null,
    finishedAt,
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    resultText: result.text,
    resultPayload: retainedResultPayload(record, payload),
    ...resultSpendPatch(result),
    failureKind: null
  };
  const final = finishSuccessfulJobRecordFile(jobFile, {
    ...successPatch,
    terminalAttribution: terminalRecordAttribution(record, successPatch)
  });
  if (final.status === "done") clearQuotaCooldown(dataDir);

  if (final.status === "cancelled") {
    throw new Error(
      failureOutcomeMessage({
        message: "Job was cancelled.",
        record: final,
        status: "cancelled",
        failureKind: "cancelled"
      })
    );
  }

  output(
    options.json
      ? payload
      : renderTaskResult({
          text: result.text,
          structuredOutput: result.structuredOutput,
          structuredOutputError: result.structuredOutputError,
          schemaRequested: jsonSchema !== null,
          sessionId: result.sessionId,
          jobId,
          cwd: final.cwd,
          delivery: final.delivery,
          semanticStatus: final.semanticStatus
        }),
    options.json
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseArgs(argv, { valueOptions: ["job-id", "cwd"] });
  const jobId = options["job-id"];
  if (!jobId) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const dataDir = resolveDataDir();
  const found = findRequestedJobRecord(dataDir, jobId, options);
  if (!found) {
    throw new Error(`No job record found for ${jobId}.`);
  }

  const record = found.record;
  if (record.status !== "running") {
    return;
  }
  const logFile = jobLogPath(dataDir, record.cwd, record.id);
  updateJobRecordFile(found.file, { pid: process.pid, pidIdentity: getProcessIdentity(process.pid) });

  const request = record.request ?? {};
  const timeoutMs = resolveTimeoutMs({ background: true, env: process.env });

  try {
    const prompt = fs.readFileSync(record.briefFile, "utf8");
    const result = await runGrok({
      briefFile: record.briefFile,
      prompt,
      mode: record.mode,
      resumeSessionId: request.resumeSessionId ?? null,
      model: request.model ?? null,
      effort: request.effort ?? null,
      maxTurns: request.maxTurns ?? null,
      web: Boolean(request.web),
      memory: request.memory === true,
      jsonSchema: request.jsonSchema ?? null,
      cwd: record.cwd,
      logFile,
      timeoutMs,
      launchProcess: (launch) => {
        requireQuotaAvailable(dataDir);
        return launchRunningJobProcess(found.file, launch);
      }
    });

    const finishedAt = nowIso();
    if (!resultFailed(result)) {
      const structured = consumeTaskStructuredResult(result, request.jsonSchema != null);
      if (!structured.valid) {
        finishTaskStructuredFailure(found.file, result, structured);
        return;
      }
      const payload = taskSuccessPayload(record, result);
      const final = finishSuccessfulJobRecordFile(found.file, {
        status: "done",
        pid: null,
        grokPid: null,
        finishedAt,
        exitCode: result.exitCode,
        sessionId: result.sessionId,
        resultText: result.text,
        resultPayload: retainedResultPayload(record, payload),
        ...resultSpendPatch(result),
        failureKind: null
      });
      if (final.status === "done") clearQuotaCooldown(dataDir);
      return;
    }

    const tail = failureTail(logFile, result);
    const current = readJobRecordFile(found.file);
    const failureKind =
      current?.status === "cancelled" || current?.cancelRequestedAt
        ? "cancelled"
        : classifyFailure({ result, logTail: tail });
    const message = grokFailureMessage(result, timeoutMs, failureKind, tail);
    const status = failureKind === "cancelled" ? "cancelled" : "error";
    const renderedMessage = failureOutcomeMessage({ message, detail: tail, record: current ?? record, status, failureKind });
    finishJobRecord(found.file, {
      status,
      pid: null,
      grokPid: null,
      finishedAt,
      exitCode: result.exitCode,
      sessionId: result.sessionId,
      resultText: result.text ?? null,
      resultPayload: retainedResultPayload(
        record,
        failureResultPayload(record, { status, failureKind, message: renderedMessage, result })
      ),
      ...resultSpendPatch(result),
      errorMessage: oneLineSummary(message),
      errorTail: tail || message,
      failureKind,
      cancelRequestedAt: null
    });
  } catch (error) {
    const message = describeLaunchFailure(error);
    appendFailureLog(logFile, message);
    recordSpawnFailure(found.file, error);
  }
}

export { handleTask, handleTaskWorker };
