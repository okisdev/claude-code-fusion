import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolveDevinBin, probeDevinVersion, compareDevinVersion, TESTED_DEVIN_INTERVAL, buildDevinChildEnv, runDevin, classifyDevinFailure } from "./lib/devin-exec.mjs";
import { ensurePrivateHome, buildJobConfig, worktreeGitDirs, projectConfigFiles } from "./lib/devin-home.mjs";
import { readModelCatalog, findCatalogFamily, createSelectionResolver, createSpeedResolver, billingPoolForModel, isPinnableFamily } from "./lib/devin-models.mjs";
import * as render from "./lib/render.mjs";
import * as state from "./lib/state.mjs";
import { cleanupRawCommandTransportsForSession } from "./lib/raw-transport.mjs";
import { createCleanupWaiter, createCompanionCommands, createModelsCommand, errorWithFailure, realUserHome } from "./lib/companion-commands.mjs";

export { cleanupRawCommandTransportsForSession };

function prepareJob(options, dataDir, cwd) {
  const probe = probeDevinVersion(resolveDevinBin());
  if (compareDevinVersion(probe.version, TESTED_DEVIN_INTERVAL.floor) < 0) throw errorWithFailure(`Devin CLI ${probe.version} is below tested floor ${TESTED_DEVIN_INTERVAL.floor}.`, "setup");
  const { homeDir } = ensurePrivateHome({ dataDir, realHome: realUserHome() });
  fs.mkdirSync(path.join(homeDir, ".config"), { recursive: true, mode: 0o700 });
  const catalog = readModelCatalog({ dataDir, bin: probe.buildPath, env: buildDevinChildEnv({ homeDir, configDir: path.join(homeDir, ".config"), mode: "consult" }) });
  const family = options.model ? findCatalogFamily(catalog, options.model) : null;
  const effort = options.effort ?? "default";
  if (!family && effort !== "default") throw errorWithFailure("--effort requires --model unless effort is default.");
  return {
    fields: { devinVersion: probe.version, devinBuildPath: probe.buildPath,
      requestedModel: options.model ?? null, requestedEffort: effort, billingPool: family ? billingPoolForModel(family.slug) : null,
      warnings: projectConfigFiles(cwd).map((file) => `project configuration may affect Devin permissions: ${file}`) },
    request: { model: options.model ?? null, family, effort }
  };
}

function servedBySelectedModel(observed, selected) {
  const label = observed.trim().toLowerCase();
  const name = selected.trim().toLowerCase();
  return label === name || label.startsWith(`${name} `);
}

async function runJob({ record, source, dataDir, brief, signal, timeoutMs, exitGraceMs, onProcess, launchProcess }) {
  const { homeDir } = ensurePrivateHome({ dataDir, realHome: realUserHome() });
  buildJobConfig({ configDir: record.configDir, mode: record.mode, cwd: record.cwd, realHome: realUserHome(), homeDir, gitDirs: record.mode === "write" ? worktreeGitDirs(record.cwd) : {} });
  const resolver = record.request?.model ? createSelectionResolver({ family: record.request.family, effort: record.request.effort }) : createSpeedResolver();
  let selectedDisplayName = null;
  const selection = (context) => {
    const changes = resolver(context);
    if (context.stage === "model" && changes[0]) {
      selectedDisplayName = context.configOptions.find((item) => item.id === "model")?.options?.find((item) => item.value === changes[0].value)?.name ?? null;
    }
    return changes;
  };
  const outcome = await runDevin({ bin: record.devinBuildPath, cwd: record.cwd, version: record.devinVersion,
    env: buildDevinChildEnv({ homeDir, configDir: record.configDir, mode: record.mode }),
    brief, mode: record.mode, resumeSessionId: source?.sessionId, resolveSelection: selection,
    signal, timeoutMs, exitGraceMs, onSpawn: (child) => onProcess(child.pid), launchProcess });
  return { ...outcome, effortApplied: resolver?.effortApplied ?? false, selectedDisplayName };
}

function outcomeFields(outcome) {
  return { resolvedModel: outcome.appliedOptions?.model ?? null, resolvedEffort: outcome.resolvedEffort ?? null,
    stopCause: outcome.stopCause, effortApplied: outcome.effortApplied ?? false };
}

const waitForCleanup = createCleanupWaiter({ engine: "devin" });

const handleModels = createModelsCommand({
  engine: "devin",
  readCatalog(maxAgeMs) {
    const dataDir = state.resolveDataDir();
    const { homeDir } = ensurePrivateHome({ dataDir, realHome: realUserHome() });
    return readModelCatalog({ dataDir, bin: probeDevinVersion(resolveDevinBin()).buildPath, env: buildDevinChildEnv({ homeDir, configDir: path.join(homeDir, ".config"), mode: "consult" }), maxAgeMs });
  },
  models: (catalog) => catalog.families.filter(isPinnableFamily).map(({ slug, label }) => ({ id: slug, displayName: label }))
});

function handleSetup(argv, transport, { commandArgs, output }) {
  const { options, positionals } = commandArgs(argv, { booleanOptions: ["json"] }, transport);
  if (positionals.length) throw errorWithFailure("Setup accepts only --json.");
  const bin = resolveDevinBin();
  const dataDir = state.resolveDataDir();
  const nextSteps = [];
  let probe = null;
  let detail = null;
  try { probe = probeDevinVersion(bin); } catch (error) { detail = error.message; nextSteps.push(error.message); }
  const compatibility = !probe ? "unknown" : compareDevinVersion(probe.version, TESTED_DEVIN_INTERVAL.floor) < 0 ? "older than the tested interval" : compareDevinVersion(probe.version, TESTED_DEVIN_INTERVAL.ceiling) >= 0 ? "newer than the tested interval" : "tested";
  if (compatibility === "older than the tested interval") nextSteps.push(`Upgrade Devin to ${TESTED_DEVIN_INTERVAL.floor} or newer.`);
  if (compatibility === "newer than the tested interval") nextSteps.push(`Devin CLI version ${probe.version} is newer than the tested interval (${TESTED_DEVIN_INTERVAL.floor} to before ${TESTED_DEVIN_INTERVAL.ceiling}); run a verification pass.`);
  let auth = { authenticated: false, detail: "not checked", planTier: null };
  let catalog = null;
  if (probe) {
    const status = spawnSync(probe.buildPath, ["auth", "status"], { encoding: "utf8", timeout: 60000 });
    const authText = String(status.error?.message || status.stdout || status.stderr || "status returned no output").trim();
    auth = { authenticated: status.status === 0 && !status.error, detail: authText, planTier: authText.match(/(?:plan(?:\s+tier)?|tier):\s*([^\r\n]+)/i)?.[1]?.trim() ?? null };
    if (!auth.authenticated) nextSteps.push("Run devin auth login.");
    try {
      const { homeDir } = ensurePrivateHome({ dataDir, realHome: realUserHome() });
      catalog = readModelCatalog({ dataDir, bin: probe.buildPath, env: buildDevinChildEnv({ homeDir, configDir: path.join(homeDir, ".config"), mode: "consult" }), maxAgeMs: 0 });
    } catch (error) { nextSteps.push(error.message); }
  }
  let dataWritable = false;
  let dataDetail = null;
  try { fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); fs.accessSync(dataDir, fs.constants.W_OK); dataWritable = true; }
  catch (error) { dataDetail = error.message; nextSteps.push(error.message); }
  let configFiles = [];
  try { configFiles = projectConfigFiles(process.cwd()); } catch (error) { nextSteps.push(error.message); }
  const report = {
    ready: Boolean(probe && compatibility !== "older than the tested interval" && auth.authenticated && catalog && dataWritable),
    devin: { available: Boolean(probe), bin, buildPath: probe?.buildPath ?? null, version: probe?.version ?? null, detail: detail ?? probe?.version ?? null },
    compatibility, testedInterval: TESTED_DEVIN_INTERVAL, auth, planTier: auth.planTier,
    catalogSize: catalog?.families.length ?? 0, catalog: { detail: catalog ? `${catalog.families.length} families (${catalog.source})` : "unavailable", source: catalog?.source ?? null },
    projectConfigFiles: configFiles, projectConfigWarnings: configFiles.map((file) => `project configuration may affect Devin permissions: ${file}`),
    dataDir: { path: dataDir, writable: dataWritable, detail: dataDetail }, nextSteps
  };
  const setupText = render.renderSetupReport(report).trimEnd() + "\n" + report.projectConfigWarnings.map((warning) => `warning: ${warning}\n`).join("");
  output(options.json ? report : setupText, options.json);
}

const { cancelJobRecord, run } = createCompanionCommands({
  engine: "devin", engineName: "Devin", entryUrl: import.meta.url, state, render,
  sessionIdPattern: state.DEVIN_SESSION_ID_PATTERN,
  sweep: state.sweepDevinRuns,
  jobDirectory: (dataDir, id) => ({ configDir: state.runConfigDir(dataDir, id) }),
  resumeEligible: () => true,
  validateResumeSource() {},
  historyResumable: () => true,
  resolvedEffort: (record) => record.resolvedEffort,
  payloadFields: (record) => ({ stopCause: record.stopCause }),
  historyFields: (record) => ({ resolvedEffort: record.resolvedEffort }),
  outcomeFields,
  cancelledFields: (outcome) => ({ sessionId: outcome.sessionId, requestId: outcome.requestId, usage: outcome.usage, ...outcomeFields(outcome) }),
  modelDrift: (record, outcome) => outcome.appliedOptions?.model && outcome.selectedDisplayName && outcome.observedModel && !servedBySelectedModel(outcome.observedModel, outcome.selectedDisplayName)
    ? { requested: outcome.appliedOptions.model, observed: outcome.observedModel } : null,
  driftWarning: () => "model_mismatch",
  failureMessage: (outcome) => outcome.policyViolation ? `Devin called forbidden tool ${outcome.policyViolation.tool}.` : outcome.selectionError?.message || outcome.setupError || outcome.rpcError?.message,
  classifyFailure: classifyDevinFailure,
  prepareJob, runJob, waitForCleanup, handleModels, handleSetup
});

export { cancelJobRecord };

run();
