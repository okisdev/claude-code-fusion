import fs from "node:fs";

import { resolveAgyBin, probeAgyVersion, compareAgyVersion, TESTED_AGY_INTERVAL, buildAgyChildEnv, runAgy, classifyAgyFailure, redactCredentialValue } from "./lib/agy-exec.mjs";
import { prepareGeminiDirectory, projectConfigFiles } from "./lib/agy-home.mjs";
import { readModelCatalog, resolveModelRequest, createSelectionResolver } from "./lib/agy-models.mjs";
import * as render from "./lib/render.mjs";
import * as state from "./lib/state.mjs";
import { cleanupRawCommandTransportsForSession } from "./lib/raw-transport.mjs";
import { createCleanupWaiter, createCompanionCommands, errorWithFailure } from "./lib/companion-commands.mjs";

export { cleanupRawCommandTransportsForSession };

function prepareJob(options, dataDir, cwd) {
  const selection = resolveModelRequest(options.model, options.effort);
  const probe = probeAgyVersion(resolveAgyBin());
  if (compareAgyVersion(probe.version, TESTED_AGY_INTERVAL.floor) < 0) throw errorWithFailure(`Antigravity CLI ${probe.version} is below tested floor ${TESTED_AGY_INTERVAL.floor}.`, "setup");
  return {
    fields: { agyVersion: probe.version, agyBuildPath: probe.buildPath,
      requestedModel: options.model ?? null, requestedEffort: selection.effort, billingPool: "subscription",
      warnings: projectConfigFiles(cwd).map((directory) => `workspace instructions may affect Antigravity: ${directory}`) },
    request: selection
  };
}

async function runJob({ record, source, dataDir, brief, signal, timeoutMs, exitGraceMs, onProcess, launchProcess }) {
  const { geminiDir } = prepareGeminiDirectory({ dataDir });
  const resolver = createSelectionResolver({ ...record.request, preserveModel: Boolean(source && !record.request?.model) });
  const outcome = await runAgy({ bin: record.agyBuildPath, cwd: record.cwd, version: record.agyVersion,
    env: buildAgyChildEnv(), geminiDir, brief, mode: record.mode, resumeSessionId: source?.sessionId, resolveSelection: resolver,
    signal, timeoutMs, exitGraceMs, onSpawn: (child) => onProcess(child.pid), launchProcess });
  return { ...outcome, effortApplied: resolver.effortApplied };
}

function outcomeFields(outcome) {
  return { resolvedModel: outcome.appliedOptions?.model ?? null, resolvedEffort: outcome.resolvedEffort ?? null,
    stopReason: outcome.stopReason ?? null, agentVersion: outcome.agentVersion ?? null,
    permissionsAllowed: outcome.permissionsAllowed ?? 0, permissionsRejected: outcome.permissionsRejected ?? 0,
    toolCalls: outcome.toolCalls ?? 0, effortApplied: outcome.effortApplied ?? false,
    ...(outcome.refusedCommandContinuation ? { refusedCommandContinuation: true } : {}),
    ...(outcome.usageIsIncomplete ? { usageIsIncomplete: true } : {}) };
}

function refusedDetail(outcome) {
  const entries = Array.isArray(outcome.refusedPermissions) ? outcome.refusedPermissions : [];
  const detail = entries.map((entry) => [entry?.tool, entry?.command].filter((part) => typeof part === "string" && part).map((part) => redactCredentialValue(part)).join(": ")).filter(Boolean).join(", ");
  return detail ? ` (${detail})` : "";
}

const waitForCleanup = createCleanupWaiter({ engine: "agy" });

function reportAsyncError(error, json, output) {
  const kind = error.failureKind ?? "error";
  output(json ? { status: "error", transportStatus: "error", semanticStatus: "unverified", delivery: "foreground", deliveryStatus: "delivered", resolvedModel: null, resolvedEffort: null, failureKind: kind, message: error.message }
    : render.renderTaskResult({ text: error.message, status: "error", failureKind: kind }), json);
  process.exitCode = 1;
}

function handleModels(argv, transport, { commandArgs, output }) {
  const { options, positionals } = commandArgs(argv, { booleanOptions: ["json", "refresh"] }, transport);
  if (positionals.length) throw errorWithFailure("Models accepts only --json and --refresh.");
  const probe = probeAgyVersion(resolveAgyBin());
  if (compareAgyVersion(probe.version, TESTED_AGY_INTERVAL.floor) < 0) throw errorWithFailure(`Antigravity CLI ${probe.version} is below tested floor ${TESTED_AGY_INTERVAL.floor}.`, "setup");
  readModelCatalog({ dataDir: state.resolveDataDir(), bin: probe.buildPath, maxAgeMs: options.refresh ? 0 : 3600000 }).then((catalog) => {
    const report = { engine: "agy", models: catalog.models, source: catalog.source };
    output(options.json ? report : report.models.map((model) => `${model.id} - ${model.displayName}`).join("\n") + "\n", options.json);
  }).catch((error) => reportAsyncError(error, options.json, output));
}

function handleSetup(argv, transport, { commandArgs, output }) {
  const { options, positionals } = commandArgs(argv, { booleanOptions: ["json"] }, transport);
  if (positionals.length) throw errorWithFailure("Setup accepts only --json.");
  setupReport().then((report) => output(options.json ? report : render.renderSetupReport(report), options.json))
    .catch((error) => reportAsyncError(error, options.json, output));
}

async function setupReport() {
  const bin = resolveAgyBin();
  const dataDir = state.resolveDataDir();
  const nextSteps = ["Set Antigravity overage to never so subscription exhaustion cannot buy AI credits."];
  let probe = null;
  let detail = null;
  try { probe = probeAgyVersion(bin); }
  catch (error) { detail = error.message; nextSteps.push(error.failureKind === "missing_cli" ? "Install the antigravity-cli Homebrew cask, then rerun /agy:setup." : error.message); }
  const compatibility = !probe ? "unknown" : compareAgyVersion(probe.version, TESTED_AGY_INTERVAL.floor) < 0 ? "older than the tested interval" : compareAgyVersion(probe.version, TESTED_AGY_INTERVAL.ceiling) >= 0 ? "newer than the tested interval" : "tested";
  if (compatibility === "older than the tested interval") nextSteps.push(`Upgrade Antigravity to ${TESTED_AGY_INTERVAL.floor} or newer.`);
  if (compatibility === "newer than the tested interval") nextSteps.push(`Antigravity CLI version ${probe.version} is newer than the tested interval (${TESTED_AGY_INTERVAL.floor} to before ${TESTED_AGY_INTERVAL.ceiling}); run a verification pass.`);
  let auth = { authenticated: false, detail: "not checked" };
  let catalog = null;
  let dataWritable = false;
  let dataDetail = null;
  try { fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); fs.accessSync(dataDir, fs.constants.W_OK); dataWritable = true; }
  catch (error) { dataDetail = error.message; nextSteps.push(error.message); }
  if (probe && dataWritable && compatibility !== "older than the tested interval") {
    try {
      const { geminiDir } = prepareGeminiDirectory({ dataDir });
      const outcome = await runAgy({ bin: probe.buildPath, cwd: process.cwd(), env: buildAgyChildEnv(), geminiDir, mode: "consult", sessionOnly: true, timeoutMs: 60000 });
      auth = { authenticated: Boolean(outcome.sessionReady), detail: outcome.sessionReady ? "session/new succeeded" : outcome.rpcError?.message || outcome.setupError || outcome.protocolError || outcome.stderrTail || "session/new failed" };
      if (!auth.authenticated) nextSteps.push("Log in by running agy once in a desktop terminal, then rerun /agy:setup. If agy is already logged in, this session cannot unlock the login keychain (an ssh or other headless session); run Claude Code from a desktop session.");
      catalog = await readModelCatalog({ dataDir, bin: probe.buildPath, maxAgeMs: 0, run: async () => outcome });
    } catch (error) { nextSteps.push(error.message); }
  }
  const configFiles = projectConfigFiles(process.cwd());
  return {
    ready: Boolean(probe && compatibility !== "older than the tested interval" && auth.authenticated && catalog && dataWritable),
    agy: { available: Boolean(probe), bin, buildPath: probe?.buildPath ?? null, version: probe?.version ?? null, detail: detail ?? probe?.version ?? null },
    compatibility, testedInterval: TESTED_AGY_INTERVAL, auth,
    catalogSize: catalog?.models.length ?? 0, models: catalog?.models ?? [],
    catalog: { detail: catalog ? `${catalog.models.length} Google models (${catalog.source})` : "unavailable", source: catalog?.source ?? null },
    projectConfigFiles: configFiles, projectConfigWarnings: configFiles.map((directory) => `workspace instructions may affect Antigravity: ${directory}`),
    dataDir: { path: dataDir, writable: dataWritable, detail: dataDetail }, nextSteps
  };
}

const { cancelJobRecord, run } = createCompanionCommands({
  engine: "agy", engineName: "Antigravity", entryUrl: import.meta.url, state, render,
  supportsWindDown: true,
  sessionIdPattern: state.AGY_SESSION_ID_PATTERN,
  sweep: state.sweepAgyRuns,
  jobDirectory: (dataDir, id) => ({ configDir: state.runConfigDir(dataDir, id) }),
  resumeEligible: (record) => record.failureKind !== "policy" && !(record.status === "running" && record.refusedCommandContinuation),
  validateResumeSource() {},
  historyResumable: (record) => record.failureKind !== "policy",
  resolvedEffort: (record) => record.resolvedEffort,
  payloadFields: (record) => ({ stopReason: record.stopReason, agentVersion: record.agentVersion, permissionsAllowed: record.permissionsAllowed, permissionsRejected: record.permissionsRejected }),
  historyFields: (record) => ({ resolvedEffort: record.resolvedEffort }),
  outcomeFields,
  outcomeWarnings: (outcome) => {
    if (outcome.refusedCommandContinuation && !classifyAgyFailure(outcome)) return ["refused_command_continued"];
    return outcome.permissionsRejected ? [`permission_refused: ${outcome.permissionsRejected} request(s) refused${refusedDetail(outcome)}, which ends the Antigravity turn early`] : [];
  },
  cancelledFields: (outcome) => ({ sessionId: outcome.sessionId, usage: outcome.usage, ...outcomeFields(outcome) }),
  modelDrift: () => null,
  driftWarning: () => "model_mismatch",
  failureMessage: (outcome) => outcome.policyViolation ? `Antigravity called forbidden tool ${outcome.policyViolation.tool}${outcome.policyViolation.bypassSandbox ? " with sandbox bypass" : ""}.` : outcome.selectionError?.message || outcome.setupError || outcome.rpcError?.message || (outcome.resultSeen && outcome.permissionsRejected > 0 && !outcome.resultText?.trim() ? `Antigravity refused ${outcome.permissionsRejected} permission request(s)${refusedDetail(outcome)} and returned no result, so the turn ended early.` : null),
  classifyFailure: classifyAgyFailure,
  prepareJob, runJob, waitForCleanup, handleModels, handleSetup
});

export { cancelJobRecord };

run();
