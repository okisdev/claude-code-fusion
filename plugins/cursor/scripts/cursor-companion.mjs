import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolveCursorBin, probeCursorVersion, compareCursorVersion, TESTED_CURSOR_INTERVAL, buildCursorArgs, buildCursorChildEnv, runCursor, classifyCursorFailure, reapPrivateHomeHelpers } from "./lib/cursor-exec.mjs";
import { buildPrivateHome, copyChatForResume, cursorChatDir, projectHookFiles, CURSOR_SESSION_ID_PATTERN } from "./lib/cursor-home.mjs";
import { readModelCatalog, resolveCursorModel } from "./lib/cursor-models.mjs";
import * as render from "./lib/render.mjs";
import * as state from "./lib/state.mjs";
import { cleanupRawCommandTransportsForSession } from "./lib/raw-transport.mjs";
import { createCleanupWaiter, createCompanionCommands, createModelsCommand, errorWithFailure, realUserHome } from "./lib/companion-commands.mjs";

export { cleanupRawCommandTransportsForSession };

function sandboxHelperPath(probe) {
  return path.join(path.dirname(probe.buildPath), "cursorsandbox");
}

function requireSandboxHelper(probe) {
  if (!fs.existsSync(sandboxHelperPath(probe))) {
    throw errorWithFailure(`Cursor sandbox helper is missing at ${sandboxHelperPath(probe)}. Run /cursor:setup and repair or reinstall Cursor Agent.`, "sandbox");
  }
}

function selectedModel() {
  const file = path.join(realUserHome(), ".cursor", "cli-config.json");
  try {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    return config.selectedModel?.modelId || config.model?.modelId || null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw errorWithFailure(`Cannot read the selected Cursor model: ${error.message}`);
  }
}

function prepareJob(options, dataDir, cwd) {
  const probe = probeCursorVersion(resolveCursorBin());
  if (compareCursorVersion(probe.version, TESTED_CURSOR_INTERVAL.floor) < 0) throw errorWithFailure(`Cursor CLI ${probe.version} is below tested floor ${TESTED_CURSOR_INTERVAL.floor}.`, "setup");
  requireSandboxHelper(probe);
  const requestedModel = options.model || selectedModel();
  if (!requestedModel) throw errorWithFailure("Select a Cursor model in ~/.cursor/cli-config.json or pass --model.");
  const catalog = readModelCatalog({ dataDir, bin: probe.buildPath });
  const requestedEffort = options.effort ?? "default";
  const resolved = resolveCursorModel({ catalog, model: requestedModel, effort: requestedEffort });
  return {
    fields: { cursorVersion: probe.version, cursorBuildPath: probe.buildPath, requestedModel,
      resolvedModel: resolved.variant, requestedEffort, effortApplied: resolved.effortApplied, billingPool: resolved.billingPool,
      warnings: projectHookFiles(cwd).map((file) => `project hooks run outside the Cursor sandbox: ${file}`) },
    request: { model: requestedModel, effort: requestedEffort,
      catalogDisplayName: catalog.models.find((item) => item.id === resolved.variant)?.displayName ?? null }
  };
}

async function runJob({ record, source, dataDir, brief, signal, timeoutMs, exitGraceMs, onProcess, launchProcess }) {
  buildPrivateHome({ homeDir: record.homeDir, mode: record.mode, cwd: record.cwd, realHome: realUserHome() });
  if (source && !copyChatForResume({ fromHome: source.homeDir, toHome: record.homeDir, cwd: record.cwd, sessionId: source.sessionId })) {
    throw errorWithFailure(`Cursor chat ${source.sessionId} was not found in the parent private home.`);
  }
  return runCursor({ bin: record.cursorBuildPath,
    args: buildCursorArgs({ mode: record.mode, variant: record.resolvedModel, cwd: record.cwd, resumeSessionId: source?.sessionId }),
    cwd: record.cwd, env: buildCursorChildEnv({ homeDir: record.homeDir, dataDir }), brief, mode: record.mode,
    signal, timeoutMs, exitGraceMs, onInit: onProcess, launchProcess });
}

const waitForCleanup = createCleanupWaiter({ engine: "cursor", reap: (record) => reapPrivateHomeHelpers(record.homeDir) });

const handleModels = createModelsCommand({
  engine: "cursor",
  readCatalog: (maxAgeMs) => readModelCatalog({ dataDir: state.resolveDataDir(), bin: resolveCursorBin(), maxAgeMs }),
  models: (catalog) => catalog.models.map(({ id, displayName }) => ({ id, displayName }))
});

function handleSetup(argv, transport, { commandArgs, output }) {
  const { options, positionals } = commandArgs(argv, { booleanOptions: ["json"] }, transport);
  if (positionals.length) throw errorWithFailure("Setup accepts only --json.");
  const bin = resolveCursorBin();
  const dataDir = state.resolveDataDir();
  const nextSteps = [];
  let probe = null;
  let detail = null;
  try { probe = probeCursorVersion(bin); } catch (error) { detail = error.message; nextSteps.push(error.message); }
  const namedCursorAgent = path.basename(bin) === "cursor-agent";
  const compatibility = !probe ? "unknown" : compareCursorVersion(probe.version, TESTED_CURSOR_INTERVAL.floor) < 0 ? "older than the tested interval" : compareCursorVersion(probe.version, TESTED_CURSOR_INTERVAL.ceiling) >= 0 ? "newer than the tested interval" : "tested";
  let auth = { authenticated: false, detail: "not checked" };
  let catalog = null;
  if (probe) {
    const status = spawnSync(probe.buildPath, ["status"], { encoding: "utf8", timeout: 60000 });
    auth = { authenticated: status.status === 0 && !status.error, detail: String(status.error?.message || status.stdout || status.stderr || "status returned no output").trim() };
    try { catalog = readModelCatalog({ dataDir, bin: probe.buildPath, maxAgeMs: 0 }); }
    catch (error) { nextSteps.push(error.message); }
  }
  const sandboxHelper = probe ? fs.existsSync(sandboxHelperPath(probe)) : false;
  if (probe && !sandboxHelper) nextSteps.push(`Repair or reinstall Cursor Agent so ${sandboxHelperPath(probe)} is available.`);
  let dataWritable = false;
  let dataDetail = null;
  try { fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); fs.accessSync(dataDir, fs.constants.W_OK); dataWritable = true; }
  catch (error) { dataDetail = error.message; nextSteps.push(error.message); }
  let hookFiles = [];
  try { hookFiles = projectHookFiles(process.cwd()); } catch (error) { nextSteps.push(error.message); }
  const report = {
    ready: Boolean(probe && namedCursorAgent && compatibility !== "older than the tested interval" && auth.authenticated && catalog && sandboxHelper && dataWritable),
    cursor: { available: Boolean(probe), bin, buildPath: probe?.buildPath ?? null, version: probe?.version ?? null, namedCursorAgent, detail: detail ?? probe?.version ?? null },
    compatibility, testedInterval: TESTED_CURSOR_INTERVAL, auth, catalogSize: catalog?.models.length ?? 0,
    sandboxHelper: { present: sandboxHelper, path: probe ? sandboxHelperPath(probe) : null },
    projectHookFiles: hookFiles, projectHookWarnings: hookFiles.map((file) => `project hooks run outside the Cursor sandbox: ${file}`),
    dataDir: { path: dataDir, writable: dataWritable, detail: dataDetail }, nextSteps
  };
  const setupText = render.renderSetupReport(report).trimEnd() + `\n- executable name: ${path.basename(bin)}\n- version: ${probe?.version ?? "unknown"}\n- authentication: ${auth.authenticated ? "authenticated" : auth.detail}\n- catalog size: ${report.catalogSize}\n- cursorsandbox helper: ${sandboxHelper ? "present" : "missing"}\n` + report.projectHookWarnings.map((warning) => `warning: ${warning}\n`).join("");
  output(options.json ? report : setupText, options.json);
}

const { cancelJobRecord, run } = createCompanionCommands({
  engine: "cursor", engineName: "Cursor", entryUrl: import.meta.url, state, render,
  sessionIdPattern: CURSOR_SESSION_ID_PATTERN,
  sweep: state.sweepCursorHomes,
  jobDirectory: (dataDir, id) => ({ homeDir: state.runHomeDir(dataDir, id) }),
  resumeEligible: (record) => Boolean(record.homeDir),
  validateResumeSource(source, cwd) {
    if (state.homeRetentionExpired(source) || !fs.lstatSync(cursorChatDir(source.homeDir, cwd, source.sessionId), { throwIfNoEntry: false })?.isDirectory()) throw errorWithFailure(`Cursor chat ${source.sessionId} is no longer retained.`);
  },
  historyResumable: (record) => !state.homeRetentionExpired(record) && Boolean(record.homeDir),
  resolvedEffort: (record) => record.requestedEffort,
  payloadFields: () => ({}),
  historyFields: () => ({}),
  outcomeFields: () => ({}),
  cancelledFields: () => ({}),
  modelDrift: (record, outcome) => outcome.observedModel && outcome.observedModel !== record.resolvedModel && outcome.observedModel !== record.request?.catalogDisplayName
    ? { requested: record.resolvedModel, observed: outcome.observedModel } : null,
  driftWarning: (drift) => `model drift: requested ${drift.requested}, observed ${drift.observed}`,
  failureMessage: (outcome) => outcome.policyViolation ? `Cursor called forbidden tool ${outcome.policyViolation}.` : null,
  classifyFailure: classifyCursorFailure,
  prepareJob, runJob, waitForCleanup, handleModels, handleSetup
});

export { cancelJobRecord };

run();
