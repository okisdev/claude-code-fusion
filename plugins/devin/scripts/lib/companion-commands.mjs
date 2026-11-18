import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";

import { configureRawTransport, createRawCommandTransport as allocateRawCommandTransport, consumeRawCommandTransport } from "./raw-transport.mjs";
import { awaitOutput } from "./await-output.mjs";
import { executionTimeoutMs, resolveExecutionTransport } from "./execution-budget.mjs";
import { parseArgs, parseRawArgs, rawBooleanOptionRequested } from "./args.mjs";
import { getProcessIdentity, processGroupAlive, processIdentityMatches, processIsDirectlyAlive } from "./process-identity.mjs";

const JOB_ID_PATTERN = /^[a-f0-9]{32}$/;
const ACCEPTANCE_VALUES = new Set(["accepted", "rejected", "unverified"]);
const ACCEPTANCE_SOURCES = new Set(["collector", "main-loop", "stats"]);
const SEMANTIC_FAILURE_KINDS = new Set(["intent_override", "scope_rewrite", "wrong_approach", "style_mismatch", "oversized"]);

export function errorWithFailure(message, failureKind = "input") {
  const error = new Error(message);
  error.failureKind = failureKind;
  return error;
}

export function realUserHome() {
  return process.env.HOME || os.homedir();
}

export function createCleanupWaiter({ engine, reap }) {
  const pidField = `${engine}Pid`;
  const identityField = `${engine}PidIdentity`;
  return async function waitForCleanup(record, { processOwned, cleanupProcessesAlive }) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (!cleanupProcessesAlive(record)) {
        await reap?.(record);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const [pid, group] of [[record[pidField], true], [record.pid, record.background]]) {
      if (pid !== process.pid && (group ? processGroupAlive(pid) : processIsDirectlyAlive(pid)) && (!processIsDirectlyAlive(pid) || processOwned(pid, pid === record.pid ? record.pidIdentity : record[identityField]))) {
        try { process.kill(group ? -pid : pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") return false; }
      }
    }
    const killDeadline = Date.now() + 500;
    while (cleanupProcessesAlive(record) && Date.now() < killDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (cleanupProcessesAlive(record)) return false;
    await reap?.(record);
    return true;
  };
}

export function createModelsCommand({ engine, readCatalog, models }) {
  return function handleModels(argv, transport, { commandArgs, output }) {
    const { options, positionals } = commandArgs(argv, { booleanOptions: ["refresh", "json"] }, transport);
    if (positionals.length) throw errorWithFailure("Models accepts only --refresh and --json.");
    const catalog = readCatalog(options.refresh ? 0 : 3600000);
    const report = { engine, models: models(catalog), source: catalog.source };
    output(options.json ? report : report.models.map((model) => `${model.id} - ${model.displayName}`).join("\n") + "\n", options.json);
  };
}

export function createCompanionCommands(adapter) {
  const { engine, engineName, entryUrl, sessionIdPattern } = adapter;
  const SELF_PATH = fileURLToPath(entryUrl);
  const COMPANION_VERSION = JSON.parse(fs.readFileSync(new URL("../.claude-plugin/plugin.json", entryUrl), "utf8")).version;
  const envPrefix = `${engine.toUpperCase()}_COMPANION_`;
  const pidField = `${engine}Pid`;
  const identityField = `${engine}PidIdentity`;
  const versionField = `${engine}Version`;
  const { SESSION_ID_ENV, resolveDataDir, generateJobId, nowIso, createJobRecord, createJobRecordFile, updateJobRecordFile, updateJobRecordFileWithCurrent, finishSuccessfulJobRecordFile, launchRunningJobProcess, listJobRecords, listAllJobRecords, findJobRecordById, jobFilePath, jobLogPath, briefPath, readJobRecordFile, writeBrief, appendJobLog, readLogTail, markDeliveryCollectedFile, claimResumeSessionLease } = adapter.state;
  const { extractFirstJsonObject, validateReviewOutput, renderReviewResult, renderBackgroundLaunch, renderTaskResult, renderStatusTable, renderJobDetail, renderHistoryReport, renderCancelReport, renderRecordAcceptance } = adapter.render;

  let activeArgv = null;
  let activeOptions = null;
  let activeIngress = "argv";
  let activeConfig = null;

  function output(value, json = false) {
    process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : String(value));
  }

  function currentClaudeSessionId() {
    return process.env[SESSION_ID_ENV] ?? null;
  }

  configureRawTransport({
    engineName: engine,
    sessionIdEnv: SESSION_ID_ENV,
    makeError: errorWithFailure,
    maxRawArgumentBytes: 4 * 1024 * 1024 + 64 * 1024
  });

  function createRawCommandTransport() {
    output(allocateRawCommandTransport(), true);
  }

  function commandArgs(argv, config, transport = {}) {
    activeConfig = config;
    activeOptions = null;
    try {
      const parsed = transport.ingress === "staged_file" ? parseRawArgs(argv[0] ?? "", config) : { ...parseArgs(argv, config), positionalText: null };
      activeOptions = parsed.options;
      return parsed;
    } catch (error) {
      throw errorWithFailure(error.message, error.failureKind ?? "input");
    }
  }

  function positiveDuration(envName, fallback) {
    const value = Number(process.env[envName]);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }

  function resolveCwd(options) {
    const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
    let stats;
    try { stats = fs.statSync(cwd); } catch { throw errorWithFailure(`Working directory does not exist: ${cwd}.`); }
    if (!stats.isDirectory()) throw errorWithFailure(`Working directory is not a directory: ${cwd}.`);
    return cwd;
  }

  function repositoryTopLevel(cwd) {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
  }

  function validateImplicitCwd(options, cwd) {
    if (options.cwd !== undefined) return;
    const root = repositoryTopLevel(cwd);
    if (root && fs.realpathSync(cwd) !== fs.realpathSync(root)) {
      throw errorWithFailure(`Implicit working directory ${cwd} is inside repository ${root} but is not its root. Pass --cwd to confirm the sandbox root.`);
    }
  }

  function readStdinIfPiped() {
    if (isatty(0)) return "";
    const chunks = [];
    const buffer = Buffer.alloc(65536);
    for (;;) {
      let bytes;
      try { bytes = fs.readSync(0, buffer, 0, buffer.length, null); }
      catch (error) { if (error.code === "EAGAIN") continue; throw error; }
      if (bytes === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytes)));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  const roles = new Set(["diversity", "burst"]);
  const lanePattern = new RegExp(`^lane:\\s*${engine}\\s+([a-z][a-z-]*)`, "i");
  const rolePattern = new RegExp(`(?:^|[\\s;,|])${engine}-role:\\s*([^\\s;,|]+)`, "i");

  function taskRole(brief) {
    const lines = brief.split(/\r?\n/).filter((line) => line.trim()).slice(0, 12);
    const lane = lines[0]?.trim().match(lanePattern)?.[1]?.toLowerCase();
    if (roles.has(lane)) return lane;
    for (const line of lines) {
      const role = line.match(rolePattern)?.[1]?.toLowerCase();
      if (role) return roles.has(role) ? role : null;
    }
    return null;
  }

  function terminal(record) {
    return ["done", "error", "cancelled"].includes(record.status);
  }

  function resumeSource(dataDir, cwd, mode, options) {
    if (options.resume && (options["resume-last"] || options.fresh) || options["resume-last"] && options.fresh) {
      throw errorWithFailure("Use only one of --resume, --resume-last, or --fresh.");
    }
    if (!options.resume && !options["resume-last"]) return null;
    if (options.resume && !sessionIdPattern.test(options.resume)) throw errorWithFailure(`Invalid ${engineName} session id.`);
    const eligible = listJobRecords(dataDir, cwd).filter((record) => terminal(record) && record.jobClass === "task" && record.mode === mode && sessionIdPattern.test(record.sessionId) && adapter.resumeEligible(record));
    if (options.resume) {
      const source = eligible.find((record) => record.sessionId === options.resume);
      if (!source) throw errorWithFailure(`No finished ${mode} ${engineName} task owns session ${options.resume} in this workspace.`);
      adapter.validateResumeSource(source, cwd);
      return source;
    }
    const sessionId = currentClaudeSessionId();
    const source = eligible.find((record) => !sessionId || record.claudeSessionId === sessionId);
    if (!source) throw errorWithFailure(`No finished ${mode} ${engineName} task can be resumed in this workspace.`);
    adapter.validateResumeSource(source, cwd);
    return source;
  }

  function taskPayload(record) {
    return {
      jobId: record.id, status: record.status, transportStatus: record.transportStatus,
      semanticStatus: record.semanticStatus, delivery: record.delivery, deliveryStatus: record.deliveryStatus,
      jobClass: record.jobClass, mode: record.mode, background: record.background, exitCode: record.exitCode,
      sessionId: record.sessionId, requestId: record.requestId, resumedFromJobId: record.resumedFromJobId ?? null,
      requestedModel: record.requestedModel,
      resolvedModel: record.resolvedModel, observedModel: record.observedModel, modelDrift: record.modelDrift,
      companionVersion: record.companionVersion,
      requestedEffort: record.requestedEffort, resolvedEffort: adapter.resolvedEffort(record),
      effortApplied: record.effortApplied, billingPool: record.billingPool, usage: record.usage,
      usageIsIncomplete: record.usageIsIncomplete, ...adapter.payloadFields(record), warnings: record.warnings,
      failureKind: record.failureKind,
      ...(record.jobClass === "review" ? { valid: record.status === "done", review: record.review ?? null, parseError: record.parseError ?? null } : {}),
      ...(record.status === "done" ? { text: record.resultText } : { message: record.errorMessage })
    };
  }

  function renderOutcome(record) {
    if (record.status === "done") return renderTaskResult({ text: record.resultText, record });
    if (record.status === "cancelled") return renderTaskResult({ text: `Job ${record.id} was cancelled.`, record });
    const tail = record.errorTail && record.errorTail !== record.errorMessage ? `\n\nLog tail:\n\n\`\`\`text\n${record.errorTail}\n\`\`\`` : "";
    return renderTaskResult({ text: `Job ${record.id} failed.\n\n${record.errorMessage ?? `${engineName} returned an error.`}${tail}`, record });
  }

  function finishFailure(file, outcome, kind, warnings, modelDrift, timeoutMs) {
    const message = kind === "timeout" ? `${engineName} timed out after ${timeoutMs}ms and was terminated.` : adapter.failureMessage(outcome) || outcome.protocolError || outcome.stderrTail?.trim() || outcome.spawnError?.message || `${engineName} exited with ${outcome.exitCode ?? outcome.signal ?? "an error"}.`;
    return finishSuccessfulJobRecordFile(file, {
      status: "error", finishedAt: nowIso(), exitCode: outcome.exitCode, sessionId: outcome.sessionId,
      requestId: outcome.requestId, resultText: outcome.resultText, observedModel: outcome.observedModel,
      usage: outcome.usage, usageIsIncomplete: outcome.usage == null, warnings, modelDrift,
      ...adapter.outcomeFields(outcome),
      failureKind: kind, errorMessage: message.split(/\r?\n/)[0], errorTail: String(outcome.stderrTail || message).slice(-65536)
    });
  }

  async function runRecordedJob(record, file) {
    const dataDir = resolveDataDir();
    const timeoutMs = positiveDuration(`${envPrefix}TIMEOUT_MS`, executionTimeoutMs(540000, record.request?.backgroundShellBudget));
    let outcome;
    let signalExitCode = null;
    try {
      const brief = fs.readFileSync(record.briefFile, "utf8");
      const sourceId = record.request?.resumeSourceJobId;
      const source = sourceId ? readJobRecordFile(jobFilePath(dataDir, record.cwd, sourceId)) : null;
      if (sourceId && (!source || !sessionIdPattern.test(source.sessionId) || source.sessionId !== record.request.resumeSessionId)) throw errorWithFailure("The resume source is unavailable.");
      const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
      const controller = new AbortController();
      const handlers = signals.map((signal) => [signal, () => {
        if (signalExitCode !== null) return;
        signalExitCode = signal === "SIGINT" ? 130 : 143;
        controller.abort();
      }]);
      for (const [signal, handler] of handlers) process.on(signal, handler);
      try {
        outcome = await adapter.runJob({ record, source, dataDir, brief, signal: controller.signal, timeoutMs,
          exitGraceMs: positiveDuration(`${envPrefix}EXIT_GRACE_MS`, 15000),
          onProcess: (pid) => updateJobRecordFileWithCurrent(file, (current) => current.status === "running" && current[pidField] === pid ? { ...current, [identityField]: getProcessIdentity(pid) } : current),
          launchProcess: (launch) => launchRunningJobProcess(file, () => {
            const child = launch();
            return { child, identity: getProcessIdentity(child.pid) };
          }).child });
      } finally {
        for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      }
    } catch (error) {
      outcome = { exitCode: null, stderrTail: error.message, spawnError: error, resultSeen: false };
    }
    const modelDrift = adapter.modelDrift(record, outcome);
    const warnings = [...record.warnings];
    if (outcome.lateClose) warnings.push("late_close");
    if (modelDrift) warnings.push(adapter.driftWarning(modelDrift));
    if (signalExitCode !== null) {
      finishSuccessfulJobRecordFile(file, { status: "cancelled", finishedAt: nowIso(), exitCode: outcome.exitCode,
        observedModel: outcome.observedModel, modelDrift, warnings, ...adapter.cancelledFields(outcome),
        failureKind: "cancelled", errorMessage: `The ${engineName} job was cancelled.` });
      process.exit(signalExitCode);
    }
    if (outcome.stderrTail) appendJobLog(jobLogPath(dataDir, record.cwd, record.id), outcome.stderrTail);
    const kind = outcome.spawnError?.failureKind ?? adapter.classifyFailure(outcome);
    if (kind) return finishFailure(file, outcome, kind, warnings, modelDrift, timeoutMs);
    const common = { finishedAt: nowIso(), exitCode: outcome.exitCode, sessionId: outcome.sessionId, requestId: outcome.requestId,
      observedModel: outcome.observedModel, usage: outcome.usage, usageIsIncomplete: outcome.usage == null,
      warnings, modelDrift, ...adapter.outcomeFields(outcome) };
    if (record.jobClass === "review") {
      const parsed = extractFirstJsonObject(outcome.resultText);
      const validation = parsed ? validateReviewOutput(parsed) : { valid: false, error: "No JSON object found in the reply." };
      if (!validation.valid) {
        const message = `${engineName} review output failed validation: ${validation.error}`;
        return finishSuccessfulJobRecordFile(file, { ...common, status: "error", failureKind: "error",
          errorMessage: message, errorTail: outcome.resultText?.slice(-65536) || message, parseError: validation.error });
      }
      return finishSuccessfulJobRecordFile(file, { ...common, status: "done", failureKind: null,
        review: validation.value, resultText: renderReviewResult(validation.value, { targetLabel: record.request.reviewTargetLabel }) });
    }
    return finishSuccessfulJobRecordFile(file, { ...common, status: "done", resultText: outcome.resultText, failureKind: null });
  }

  async function spawnBackgroundWorker(record, file) {
    let child;
    let identity;
    try {
      const launched = launchRunningJobProcess(file, () => {
        child = spawn(process.execPath, [SELF_PATH, `${record.jobClass}-worker`, record.id, "--cwd", record.cwd], {
          detached: true, stdio: "ignore", env: process.env
        });
        identity = getProcessIdentity(child.pid);
        return { child, identity };
      }, { processRole: "worker" });
      child = launched.child;
      const spawned = new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      await spawned;
      child.unref();
    } catch (error) {
      if (Number.isInteger(child?.pid) && child.pid > 1) {
        const cleanup = { pid: child.pid, pidIdentity: identity, background: true };
        const clean = terminateOwned(cleanup) && await waitForCleanup(cleanup);
        if (!clean) {
          updateJobRecordFileWithCurrent(file, (current) => current.status === "running" ? {
            ...current, cleanupRequired: true, failureKind: error.failureKind ?? "error",
            errorMessage: "Verified background worker cleanup did not complete."
          } : current);
          throw error;
        }
      }
      finishSuccessfulJobRecordFile(file, { status: "error", finishedAt: nowIso(), failureKind: error.failureKind ?? "error", errorMessage: error.message });
      throw error;
    }
  }

  function emitJob(record, json) {
    output(json ? taskPayload(record) : renderOutcome(record), json);
    if (record.status !== "done") process.exitCode = 1;
  }

  async function handleTask(argv, transport) {
    const { options, positionals, positionalText } = commandArgs(argv, {
      valueOptions: ["model", "effort", "resume", "cwd"],
      booleanOptions: ["write", "resume-last", "fresh", "background", "json"], optionsBeforePositionals: true
    }, transport);
    const cwd = resolveCwd(options);
    validateImplicitCwd(options, cwd);
    const mode = (options.write ?? transport.defaultWrite) ? "write" : "consult";
    const dataDir = resolveDataDir();
    adapter.sweep(dataDir);
    const source = resumeSource(dataDir, cwd, mode, options);
    const brief = (positionalText ?? positionals.join(" ")).trim() || readStdinIfPiped().trim();
    if (!brief) throw errorWithFailure("Provide a brief after -- or on stdin.");
    const prepared = adapter.prepareJob(options, dataDir, cwd);
    const id = generateJobId();
    if (source) claimResumeSessionLease(dataDir, cwd, source.sessionId, id, { preflight: true });
    const briefFile = briefPath(dataDir, cwd, id);
    const file = jobFilePath(dataDir, cwd, id);
    const background = Boolean(options.background);
    const record = createJobRecord({ id, companionVersion: COMPANION_VERSION, pid: background ? null : process.pid,
      mode, cwd, briefFile, background, claudeSessionId: currentClaudeSessionId(), jobClass: "task",
      role: taskRole(brief), ...prepared.fields, ...adapter.jobDirectory(dataDir, id),
      request: { ...prepared.request, backgroundShellBudget: Boolean(transport.backgroundShell && !background), resumeSessionId: source?.sessionId ?? null,
        resumeSourceJobId: source?.id ?? null, outputJson: Boolean(options.json), ingress: transport.ingress } });
    if (source) record.resumedFromJobId = source.id;
    createJobRecordFile(file, record);
    try {
      writeBrief(dataDir, cwd, id, brief);
    } catch (error) {
      finishSuccessfulJobRecordFile(file, { status: "error", finishedAt: nowIso(), failureKind: error.failureKind ?? "error", errorMessage: error.message });
      throw error;
    }
    if (background) {
      await spawnBackgroundWorker(record, file);
      output(options.json ? taskPayload(record) : renderBackgroundLaunch(id, record.delivery, cwd), options.json);
      return;
    }
    emitJob(await runRecordedJob(record, file), options.json);
  }

  async function handleWorker(argv, jobClass) {
    const { options, positionals } = parseArgs(argv, { valueOptions: ["cwd"] });
    if (positionals.length !== 1 || !JOB_ID_PATTERN.test(positionals[0]) || !options.cwd) throw errorWithFailure(`Invalid ${jobClass}-worker invocation.`);
    const file = jobFilePath(resolveDataDir(), resolveCwd(options), positionals[0]);
    let record = readJobRecordFile(file);
    const registration = Date.now() + 5000;
    while (record?.status === "running" && record.pid !== process.pid && Date.now() < registration) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      record = readJobRecordFile(file);
    }
    if (!record || record.jobClass !== jobClass || !record.background || record.status !== "running" || record.pid !== process.pid) return;
    try { await runRecordedJob(record, file); }
    catch (error) {
      finishSuccessfulJobRecordFile(file, { status: "error", finishedAt: nowIso(), failureKind: error.failureKind ?? "error", errorMessage: error.message });
    }
  }

  function runGit(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw errorWithFailure(`git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr?.trim() ?? "unknown error"}`);
    return result.stdout ?? "";
  }

  function collectReviewTarget(cwd, base) {
    if (base) {
      const range = runGit(["diff", `${base}...HEAD`], cwd);
      const uncommitted = runGit(["diff", "HEAD"], cwd);
      return { label: `changes since ${base}`, diff: [range.trim(), uncommitted.trim()].filter(Boolean).join("\n\n") };
    }
    const tracked = runGit(["diff", "HEAD"], cwd);
    const porcelain = runGit(["status", "--porcelain"], cwd);
    const untracked = porcelain.split(/\r?\n/).filter((line) => line.startsWith("??")).map((line) => line.slice(3).trim()).filter(Boolean);
    const parts = [tracked.trim()].filter(Boolean);
    if (untracked.length) parts.push(["Untracked files:", ...untracked.map((file) => `- ${file}`)].join("\n"));
    return { label: "working tree changes", diff: parts.join("\n\n") };
  }

  async function handleReview(argv, transport) {
    const { options, positionals, positionalText } = commandArgs(argv, {
      valueOptions: ["scope", "base", "focus", "model", "effort", "cwd"],
      booleanOptions: ["background", "json"], optionsBeforePositionals: true
    }, transport);
    if (positionals.length || positionalText?.trim()) throw errorWithFailure("Review accepts no positional arguments. Use --focus.");
    const scope = options.scope ?? "auto";
    if (!["auto", "working-tree", "branch"].includes(scope)) throw errorWithFailure("--scope must be auto, working-tree, or branch.");
    if (scope === "working-tree" && options.base) throw errorWithFailure("--base cannot be combined with --scope working-tree.");
    if (scope === "branch" && !options.base) throw errorWithFailure("--scope branch requires --base <ref>.");
    const cwd = resolveCwd(options);
    validateImplicitCwd(options, cwd);
    const target = collectReviewTarget(cwd, scope === "working-tree" ? null : options.base);
    if (!target.diff.trim()) throw errorWithFailure("No changes found to review.");
    const template = fs.readFileSync(new URL("../prompts/review.md", entryUrl), "utf8");
    const prompt = template.replace(/\{\{(\w+)\}\}/g, (match, key) => ({
      TARGET_LABEL: target.label, USER_FOCUS: options.focus?.trim() || "No extra focus provided.", DIFF: target.diff
    })[key] ?? match);
    const dataDir = resolveDataDir();
    adapter.sweep(dataDir);
    const prepared = adapter.prepareJob(options, dataDir, cwd);
    const id = generateJobId();
    const background = Boolean(options.background || transport.defaultBackground);
    const briefFile = briefPath(dataDir, cwd, id);
    const file = jobFilePath(dataDir, cwd, id);
    const record = createJobRecord({ id, companionVersion: COMPANION_VERSION, pid: background ? null : process.pid,
      mode: "review", cwd, briefFile, background, claudeSessionId: currentClaudeSessionId(), jobClass: "review",
      ...prepared.fields, ...adapter.jobDirectory(dataDir, id),
      request: { ...prepared.request, reviewTargetLabel: target.label,
        outputJson: Boolean(options.json), ingress: transport.ingress } });
    createJobRecordFile(file, record);
    try { writeBrief(dataDir, cwd, id, prompt); }
    catch (error) {
      finishSuccessfulJobRecordFile(file, { status: "error", finishedAt: nowIso(), failureKind: error.failureKind ?? "error", errorMessage: error.message });
      throw error;
    }
    if (background) {
      await spawnBackgroundWorker(record, file);
      output(options.json ? taskPayload(record) : renderBackgroundLaunch(id, record.delivery, cwd), options.json);
      return;
    }
    emitJob(await runRecordedJob(record, file), options.json);
  }

  function requestedJob(dataDir, id, options) {
    if (!JOB_ID_PATTERN.test(String(id ?? ""))) throw errorWithFailure(`${engineName} job ids must be exactly 32 lowercase hexadecimal characters.`);
    if (options.cwd === undefined) return findJobRecordById(dataDir, id);
    const file = jobFilePath(dataDir, resolveCwd(options), id);
    const record = readJobRecordFile(file);
    return record?.id === id ? { file, record } : null;
  }

  function processOwned(pid, identity) {
    return Number.isInteger(pid) && pid > 1 && identity && processIdentityMatches(pid, identity);
  }

  function runningAlive(record) {
    if (record.status !== "running") return false;
    if (record.pid) return processOwned(record.pid, record.pidIdentity);
    if (processOwned(record[pidField], record[identityField])) return true;
    if (!record.pid && !record[pidField]) {
      return Date.now() - Date.parse(record.createdAt) < positiveDuration(`${envPrefix}PIDLESS_RUNNING_GRACE_MS`, 15000);
    }
    return false;
  }

  function terminateOwned(record) {
    const driverOwned = Number.isInteger(record.pid) && record.pid > 1 && record.pid !== process.pid && processIsDirectlyAlive(record.pid) && processOwned(record.pid, record.pidIdentity);
    const targets = [[record[pidField], record[identityField], true, driverOwned], [record.pid, record.pidIdentity, record.background, false]];
    if (targets.some(([pid, identity, , covered]) => !covered && Number.isInteger(pid) && pid > 1 && pid !== process.pid && processIsDirectlyAlive(pid) && !processOwned(pid, identity))) return false;
    let safe = true;
    for (const [pid, identity, group] of targets) {
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
      if (group ? !processGroupAlive(pid) : !processIsDirectlyAlive(pid)) continue;
      if (processIsDirectlyAlive(pid) && !processOwned(pid, identity)) continue;
      try { process.kill(group ? -pid : pid, "SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") safe = false; }
    }
    return safe;
  }

  function cleanupProcessesAlive(record) {
    return processGroupAlive(record[pidField]) || (record.pid !== process.pid && processIsDirectlyAlive(record.pid));
  }

  function waitForCleanup(record) {
    return adapter.waitForCleanup(record, { processOwned, cleanupProcessesAlive });
  }

  async function refreshRunning(found) {
    const record = readJobRecordFile(found.file) ?? found.record;
    if (record.status !== "running" || runningAlive(record)) return record;
    const safe = terminateOwned(record);
    const clean = safe && await waitForCleanup(record);
    return updateJobRecordFileWithCurrent(found.file, (current) => {
      if (current.status !== "running" || runningAlive(current)) return current;
      if (!clean) {
        return { ...current, cleanupRequired: true, failureKind: current.cancelRequestedAt ? "cancelled" : "died", errorMessage: "Verified process cleanup did not complete." };
      }
      const cancelled = Boolean(current.cancelRequestedAt);
      return { ...current, status: cancelled ? "cancelled" : "error", finishedAt: nowIso(), failureKind: cancelled ? "cancelled" : "died", errorMessage: cancelled ? `The ${engineName} job was cancelled.` : `The ${engineName} job owner exited without recording an outcome.` };
    });
  }

  async function handleStatus(argv, transport) {
    const { options, positionals } = commandArgs(argv, { valueOptions: ["cwd"], booleanOptions: ["json", "all"] }, transport);
    if (positionals.length > 1) throw errorWithFailure("Status accepts at most one job id.");
    const dataDir = resolveDataDir();
    if (positionals[0]) {
      const found = requestedJob(dataDir, positionals[0], options);
      if (!found) throw errorWithFailure(`No job record found for ${positionals[0]}.`);
      const record = await refreshRunning(found);
      output(options.json ? record : renderJobDetail(record, { logTail: readLogTail(jobLogPath(dataDir, record.cwd, record.id)) }), options.json);
      if (record.cleanupRequired) process.exitCode = 1;
      return;
    }
    const records = options.all ? listAllJobRecords(dataDir) : listJobRecords(dataDir, resolveCwd(options)).map((record) => ({ record, file: jobFilePath(dataDir, record.cwd, record.id) }));
    const jobs = await Promise.all(records.map(refreshRunning));
    output(options.json ? { jobs } : renderStatusTable(jobs, currentClaudeSessionId()), options.json);
    if (jobs.some((job) => job.cleanupRequired)) process.exitCode = 1;
  }

  function historyEntry(record) {
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : null;
    const mode = record.mode;
    const resumable = terminal(record) && adapter.historyResumable(record) && record.jobClass === "task" && sessionIdPattern.test(sessionId);
    return {
      jobId: record.id, sessionId, cwd: record.cwd, status: record.status, jobClass: record.jobClass, mode,
      background: Boolean(record.background), delivery: record.delivery, deliveryStatus: record.deliveryStatus,
      semanticStatus: record.semanticStatus, cleanupRequired: record.cleanupRequired, failureKind: record.failureKind,
      requestedModel: record.requestedModel, resolvedModel: record.resolvedModel, observedModel: record.observedModel,
      requestedEffort: record.requestedEffort, ...adapter.historyFields(record), effortApplied: record.effortApplied, billingPool: record.billingPool,
      [versionField]: record[versionField], createdAt: record.createdAt, finishedAt: record.finishedAt,
      resumable, resumeMode: resumable ? mode : null,
      ownedByCurrentSession: currentClaudeSessionId() == null ? null : record.claudeSessionId === currentClaudeSessionId()
    };
  }

  async function handleHistory(argv, transport) {
    const { options, positionals } = commandArgs(argv, { valueOptions: ["limit", "cwd"], booleanOptions: ["all", "json"] }, transport);
    if (positionals.length) throw errorWithFailure("History accepts no positional arguments.");
    const limit = options.limit === undefined ? 50 : Number(options.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw errorWithFailure("History limit must be 1 to 500.");
    const dataDir = resolveDataDir();
    const cwd = options.all ? null : resolveCwd(options);
    const entries = options.all ? listAllJobRecords(dataDir) : listJobRecords(dataDir, cwd).map((record) => ({ record, file: jobFilePath(dataDir, cwd, record.id) }));
    const jobs = (await Promise.all(entries.slice(0, limit).map(refreshRunning))).map(historyEntry);
    const report = { source: "canonical", scope: options.all ? "all" : "workspace", cwd, limit, totalJobs: entries.length, returnedJobs: jobs.length, truncated: entries.length > jobs.length, jobs };
    output(options.json ? report : renderHistoryReport(report), options.json);
  }

  async function handleResult(argv, transport) {
    const { options, positionals } = commandArgs(argv, { valueOptions: ["cwd", "wait-timeout-ms"], booleanOptions: ["wait", "json"] }, transport);
    if (positionals.length !== 1) throw errorWithFailure("Result requires one job id.");
    const dataDir = resolveDataDir();
    const found = requestedJob(dataDir, positionals[0], options);
    if (!found) throw errorWithFailure(`No job record found for ${positionals[0]}.`);
    const configured = options["wait-timeout-ms"] ?? process.env[`${envPrefix}WAIT_TIMEOUT_MS`];
    const timeout = configured === undefined ? 570000 : Number(configured);
    if (!Number.isSafeInteger(timeout) || timeout < 0) throw errorWithFailure("Wait timeout must be a nonnegative integer.");
    const deadline = Date.now() + Math.min(timeout, 570000);
    let record;
    for (;;) {
      record = await refreshRunning(found);
      if (!options.wait || record.status !== "running" || record.cleanupRequired || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(positiveDuration(`${envPrefix}WAIT_POLL_MS`, 2000), deadline - Date.now())));
    }
    const rendered = options.json ? `${JSON.stringify(record.request?.outputJson && record.status !== "running" ? taskPayload(record) : record, null, 2)}\n` : String(record.status === "running" ? renderJobDetail(record) : renderOutcome(record));
    await new Promise((resolve, reject) => process.stdout.write(rendered, (error) => error ? reject(error) : resolve()));
    if (record.status !== "running" && record.delivery !== "foreground") markDeliveryCollectedFile(found.file);
    if (record.cleanupRequired) process.exitCode = 1;
  }

  async function handleCancel(argv, transport) {
    const { options, positionals } = commandArgs(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] }, transport);
    if (positionals.length !== 1) throw errorWithFailure("Cancel requires one job id.");
    const found = requestedJob(resolveDataDir(), positionals[0], options);
    if (!found) throw errorWithFailure(`No job record found for ${positionals[0]}.`);
    const record = await cancelJobRecord(found);
    const text = record.status === "cancelled" ? renderCancelReport(record) : record.status !== "running" ? renderTaskResult({ text: `Job ${record.id} is not running (status: ${record.status}).`, record }) : renderJobDetail(record);
    output(options.json ? taskPayload(record) : text, options.json);
    if (record.cleanupRequired) process.exitCode = 1;
  }

  async function cancelJobRecord(found) {
    let record = readJobRecordFile(found.file) ?? found.record;
    if (record.status === "running") {
      record = updateJobRecordFile(found.file, { cancelRequestedAt: nowIso() });
      if (record.status === "running") {
        const safe = terminateOwned(record);
        const clean = safe && await waitForCleanup(record);
        record = updateJobRecordFileWithCurrent(found.file, (current) => {
          if (current.status !== "running") return current;
          if (!clean) return { ...current, cleanupRequired: true, failureKind: "cancelled", errorMessage: "Verified process cleanup did not complete." };
          return { ...current, status: "cancelled", finishedAt: nowIso(), failureKind: "cancelled", errorMessage: `The ${engineName} job was cancelled.`, cancelRequestedAt: null };
        });
      }
    }
    return record;
  }

  function handleRecordAcceptance(argv) {
    const { options, positionals } = commandArgs(argv, {
      valueOptions: ["job-id", "acceptance", "reason", "failure-kind", "source"],
      booleanOptions: ["accept-failed-transport", "json"]
    });
    if (positionals.length) throw errorWithFailure("Record acceptance accepts no positional arguments.");
    const id = options["job-id"];
    if (!JOB_ID_PATTERN.test(String(id ?? ""))) throw errorWithFailure("The --job-id option must be a 32 character lowercase hexadecimal job id.");
    if (!ACCEPTANCE_VALUES.has(options.acceptance)) throw errorWithFailure("The --acceptance option must be accepted, rejected, or unverified.");
    if (options["failure-kind"] !== undefined && (!SEMANTIC_FAILURE_KINDS.has(options["failure-kind"]) || options.acceptance !== "rejected")) throw errorWithFailure("The --failure-kind option requires rejected acceptance and a known semantic failure kind.");
    if (options.acceptance === "rejected" && !options.reason?.trim()) throw errorWithFailure("A rejected acceptance requires --reason.");
    const source = options.source ?? "stats";
    if (!ACCEPTANCE_SOURCES.has(source)) throw errorWithFailure("The --source option must be collector, main-loop, or stats.");
    const found = findJobRecordById(resolveDataDir(), id);
    if (!found) throw errorWithFailure(`No job record found for ${id}.`);
    const record = updateJobRecordFileWithCurrent(found.file, (current) => {
      if (options.acceptance === "accepted" && current.status !== "done" && !options["accept-failed-transport"]) throw errorWithFailure(`${engineName} job ${id} has transport status ${current.status}. Pass --accept-failed-transport to record accepted.`);
      return { ...current, semanticStatus: options.acceptance, semanticFailureKind: options.acceptance === "rejected" ? options["failure-kind"] ?? null : null,
        semanticFailureMessage: options.acceptance === "rejected" ? options.reason : null,
        acceptanceSource: source, acceptanceRecordedAt: nowIso() };
    }, { allowTerminal: true });
    output(options.json ? { id: record.id, semanticStatus: record.semanticStatus, semanticFailureKind: record.semanticFailureKind, acceptanceSource: record.acceptanceSource } : renderRecordAcceptance(record), options.json);
  }

  function printUsage() {
    output(`Usage: ${engine}-companion.mjs <task|review|status|result|await-output|cancel|history|models|setup|record-acceptance|transport-create|transport-discard> [options]\n`);
  }

  async function main() {
    const [command, ...received] = process.argv.slice(2);
    if (!command || command === "help" || command === "--help") { printUsage(); return; }
    if (command === "await-output") { process.exitCode = await awaitOutput(received); return; }
    if (command === "transport-create") {
      if (received.length) throw errorWithFailure("transport-create accepts no arguments.");
      createRawCommandTransport();
      return;
    }
    if (command === "transport-discard") {
      if (received.length !== 2 || received[0] !== "--raw-args-token") throw errorWithFailure("transport-discard requires exactly one raw argument token.");
      consumeRawCommandTransport(received[1], { allowMissing: true });
      return;
    }
    if (command === "record-acceptance") { activeArgv = received; handleRecordAcceptance(received); return; }
    const transport = resolveExecutionTransport(command, received);
    activeArgv = transport.argv;
    activeIngress = transport.ingress;
    if (transport.defaultBackground && command !== "review" || transport.defaultWrite && command !== "task") throw errorWithFailure("The raw transport default is invalid for this command.");
    switch (command) {
      case "task": await handleTask(transport.argv, transport); break;
      case "review": await handleReview(transport.argv, transport); break;
      case "task-worker": await handleWorker(transport.argv, "task"); break;
      case "review-worker": await handleWorker(transport.argv, "review"); break;
      case "status": await handleStatus(transport.argv, transport); break;
      case "result": await handleResult(transport.argv, transport); break;
      case "cancel": await handleCancel(transport.argv, transport); break;
      case "history": await handleHistory(transport.argv, transport); break;
      case "models": adapter.handleModels(transport.argv, transport, { commandArgs, output }); break;
      case "setup": adapter.handleSetup(transport.argv, transport, { commandArgs, output }); break;
      default: throw errorWithFailure(`Unknown subcommand: ${command}.`);
    }
  }

  function renderTopLevelError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind = error.failureKind ?? "error";
    const json = activeOptions?.json === true || (activeIngress === "staged_file" ? rawBooleanOptionRequested(activeArgv?.[0] ?? "", "json", activeConfig ?? {}) : (activeArgv ?? process.argv.slice(3)).includes("--json"));
    return json ? `${JSON.stringify({ status: "error", transportStatus: "error", semanticStatus: "unverified", delivery: "foreground", deliveryStatus: "delivered", resolvedModel: null, resolvedEffort: null, failureKind: kind, message }, null, 2)}\n` : `${message}\nstate: error\nfailure: ${kind}\n`;
  }

  return {
    cancelJobRecord,
    run() {
      if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
        main().catch((error) => { process.stderr.write(renderTopLevelError(error)); process.exitCode = 1; });
      }
    }
  };
}
