#!/usr/bin/env node
import path from "node:path";
import { buildTaskArgs, getCodexAvailability, runCodex } from "./lib/codex-exec.mjs";
import { ensurePrivateHome } from "./lib/opencode-home.mjs";
import { readProvider, requireApiKey } from "./lib/opencode-provider.mjs";
import * as sharedState from "./lib/state.mjs";
import { OPENCODE_SESSION_ID_PATTERN, sweepOpencodeRuns } from "./lib/state.mjs";
import { createCompanionRender, extractFirstJsonObject, validateReviewOutput, renderReviewResult } from "./lib/companion-render.mjs";
import { cleanupRawCommandTransportsForSession } from "./lib/raw-transport.mjs";
import { createCleanupWaiter, createCompanionCommands, createModelsCommand, errorWithFailure } from "./lib/companion-commands.mjs";

export { cleanupRawCommandTransportsForSession };

const TESTED_CODEX_INTERVAL = { floor: "0.154.0", ceiling: "0.173.0" };
const DEFAULT_MODELS = { bulk: "deepseek-v4.1-flash", "blind-check": "glm-5.3-flash" };
const render = {
  ...createCompanionRender({
    engine: "opencode", engineName: "OpenCode", resolvedEffortField: "resolvedEffort",
    renderFooterDetails(record) {
      const lines = [];
      if (record.codexHome) lines.push(`codex-home: ${record.codexHome}`);
      if (record.sandbox) lines.push(`codex-sandbox: ${record.sandbox}`);
      return lines;
    }
  }),
  extractFirstJsonObject, validateReviewOutput, renderReviewResult
};
const state = { ...sharedState, finishSuccessfulJobRecordFile(file, patch) {
  const current = sharedState.readJobRecordFile(file);
  if (current?.status === "running" && current.cleanupRequired) return current;
  return sharedState.finishSuccessfulJobRecordFile(file, patch);
} };

function probeCodex(dataDir) {
  const candidate = process.env.OPENCODE_CODEX_BIN?.trim() || "codex";
  const bin = candidate.includes(path.sep) ? path.resolve(candidate) : candidate;
  const probe = getCodexAvailability({ bin, env: { ...process.env, CODEX_HOME: path.join(dataDir, "codex-home") } });
  if (!probe.available) throw errorWithFailure("Codex CLI is unavailable or returned an unsupported version. Install Codex or set OPENCODE_CODEX_BIN.", probe.exitCode === 0 ? "setup" : "missing_cli");
  const version = probe.version.split("-")[0];
  const { floor, ceiling } = TESTED_CODEX_INTERVAL;
  if (version.localeCompare(floor, "en", { numeric: true }) < 0) throw errorWithFailure(`Codex CLI ${probe.version} is below tested floor ${floor}.`, "setup");
  return { ...probe, newerThanTested: version.localeCompare(ceiling, "en", { numeric: true }) >= 0 };
}

function prepareJob(options, dataDir) {
  requireApiKey();
  const probe = probeCodex(dataDir);
  const catalog = readProvider("models", { dataDir });
  ensurePrivateHome({ dataDir, bin: probe.bin, codexVersion: probe.version, models: catalog.models });
  const warnings = probe.newerThanTested ? [`Codex CLI ${probe.version} is newer than the tested interval (${TESTED_CODEX_INTERVAL.floor} to before ${TESTED_CODEX_INTERVAL.ceiling}); run a verification pass.`] : [];
  return { fields: { codexVersion: probe.version, codexBuildPath: probe.bin, requestedModel: options.model ?? null, requestedEffort: options.effort ?? "high", billingPool: "opencode", warnings },
    request: { model: options.model ?? null, effort: options.effort ?? "high" } };
}

function classifyFailure(outcome) {
  if (outcome.cancelled) return "cancelled";
  if (outcome.timedOut) return "timeout";
  if (outcome.failureKind && !["error", "process", "auth", "quota", "rate_limited", "network", "permission"].includes(outcome.failureKind)) return outcome.failureKind;
  const message = `${outcome.errorMessage ?? ""}\n${outcome.stderrTail ?? ""}`;
  if (/\b(?:HTTP(?:\/\d(?:\.\d)?)?\s*|status(?: code)?\s*[:=]?\s*)(?:401|403)\b/i.test(message)) return "auth";
  if (/\b(?:usage|allowance)\b.*\b(?:limit|exhausted|exceeded)\b|quota|insufficient (?:balance|credits)|payment required/i.test(message)) return "quota";
  if (/\b(?:HTTP(?:\/\d(?:\.\d)?)?\s*|status(?: code)?\s*[:=]?\s*)429\b|rate[ _-]?limit|too many requests/i.test(message)) return "rate_limited";
  return outcome.failureKind ?? (outcome.success && outcome.resultText?.trim() ? null : "error");
}

async function runJob({ record, source, dataDir, brief, signal, timeoutMs, exitGraceMs, onProcess, launchProcess }) {
  const apiKey = requireApiKey();
  if (record.jobClass !== "task") throw errorWithFailure("OpenCode Go supports only bulk and blind-check tasks.");
  const declared = brief.split(/\r?\n/).filter((line) => line.trim()).slice(0, 12).flatMap((line) => [...line.matchAll(/(?:^|[\s;,|])opencode-role:\s*([^\s;,|]+)/gi)].map((match) => match[1].toLowerCase()));
  if (declared.length > 1) throw errorWithFailure("Declare exactly one OpenCode Go role.");
  if (source && declared.length && declared[0] !== source.role) throw errorWithFailure("A resumed OpenCode Go task must keep its original role.");
  const role = source?.role ?? (declared.length === 1 ? declared[0] : null);
  if (!Object.hasOwn(DEFAULT_MODELS, role)) throw errorWithFailure("The brief must declare opencode-role: bulk or opencode-role: blind-check.");
  const model = record.request.model ?? source?.requestedModel ?? DEFAULT_MODELS[role];
  const effort = record.request.effort;
  const listing = readProvider("models", { dataDir, sessionId: record.id });
  const selected = listing.models.find((entry) => entry.id === model);
  if (!selected) throw errorWithFailure(`OpenCode Go model ${model} is unavailable or does not support tools.`);
  if (!selected.capabilities.reasoning.effort.includes(effort)) throw errorWithFailure(`OpenCode Go model ${model} does not support effort ${effort}.`);
  const { homeDir: codexHome } = ensurePrivateHome({ dataDir, bin: record.codexBuildPath, codexVersion: record.codexVersion, models: listing.models });
  const write = role === "bulk";
  const sandbox = write ? "workspace-write" : "read-only";
  const args = buildTaskArgs({ cwd: record.cwd, model, effort, write, sandboxMode: sandbox, skipGitRepoCheck: true, serviceTier: "none", resumeThreadId: source?.sessionId });
  args.push("-c", `model_providers.opencode.http_headers={"x-opencode-session"=${JSON.stringify(record.id)}}`, brief);
  const fields = { role, mode: write ? "write" : "consult", requestedModel: model, codexHome, sandbox };
  state.updateJobRecordFile(state.jobFilePath(dataDir, record.cwd, record.id), fields);
  Object.assign(record, fields);
  const outcome = await runCodex({ bin: record.codexBuildPath, args, cwd: record.cwd, env: { ...process.env, OPENCODE_GO_API_KEY: apiKey, CODEX_HOME: codexHome },
    signal, timeoutMs, terminationGraceMs: exitGraceMs, resumeThreadId: source?.sessionId,
    onSpawnAttempt: (pid) => { if (pid) launchProcess(() => ({ pid })); }, onSpawn: (pid) => onProcess(pid), onIdentitySettled: (pid) => onProcess(pid) });
  if (outcome.cleanupComplete === false) state.updateJobRecordFile(state.jobFilePath(dataDir, record.cwd, record.id), {
    cleanupRequired: true, failureKind: outcome.failureKind ?? "error", errorMessage: "Verified Codex process cleanup did not complete.", sessionId: outcome.threadId
  });
  return { ...outcome, sessionId: outcome.threadId, resultText: outcome.finalResponse, observedModel: outcome.resolvedModel,
    usage: outcome.tokenUsage, usageIsIncomplete: outcome.usageIsIncomplete || outcome.tokenUsageAvailability !== "available",
    selectedModel: model, selectedEffort: effort };
}

function outcomeFields(outcome) {
  return { resolvedModel: outcome.resolvedModel ?? outcome.selectedModel ?? null, resolvedEffort: outcome.resolvedEffort ?? outcome.selectedEffort ?? null,
    effortApplied: Boolean(outcome.selectedEffort), billingPool: "opencode", usageIsIncomplete: outcome.usageIsIncomplete ?? true };
}

const handleModels = createModelsCommand({ engine: "opencode", readCatalog: (maxAgeMs) => readProvider("models", { dataDir: state.resolveDataDir(), maxAgeMs }),
  models: (catalog) => catalog.models.map(({ id, name }) => ({ id, displayName: name })) });

function handleSetup(argv, transport, { commandArgs, output }) {
  const { options, positionals } = commandArgs(argv, { booleanOptions: ["json"] }, transport);
  if (positionals.length) throw errorWithFailure("Setup accepts only --json.");
  const dataDir = state.resolveDataDir();
  const nextSteps = ["Turn off Extra Usage in the OpenCode console to keep this lane on its included allowance."];
  let prepared;
  let failureKind = null;
  try { prepared = prepareJob({}, dataDir); nextSteps.push(...prepared.fields.warnings); }
  catch (error) { failureKind = error.failureKind ?? "setup"; nextSteps.push(error.message); }
  const report = { engine: "opencode", ready: Boolean(prepared), codexVersion: prepared?.fields.codexVersion ?? null,
    testedInterval: TESTED_CODEX_INTERVAL, dataDir, failureKind, nextSteps };
  output(options.json ? report : `OpenCode Go setup: ${report.ready ? "ready" : "needs attention"}\n${nextSteps.join("\n")}\n`, options.json);
}

export const quota = ({ dataDir = state.resolveDataDir(), env = process.env } = {}) => readProvider("quota", { dataDir, env });

const { cancelJobRecord, run } = createCompanionCommands({
  engine: "opencode", engineName: "OpenCode", entryUrl: import.meta.url, state, render,
  sessionIdPattern: OPENCODE_SESSION_ID_PATTERN, sweep: sweepOpencodeRuns, jobDirectory: () => ({}),
  resumeEligible: (record) => record.failureKind !== "policy", validateResumeSource() {}, historyResumable: (record) => record.failureKind !== "policy",
  resolvedEffort: (record) => record.resolvedEffort,
  payloadFields: (record) => ({ codexVersion: record.codexVersion, codexHome: record.codexHome ?? null, sandbox: record.sandbox ?? null, role: record.role }),
  historyFields: (record) => ({ codexVersion: record.codexVersion, resolvedEffort: record.resolvedEffort }),
  outcomeFields, cancelledFields: (outcome) => ({ sessionId: outcome.sessionId, usage: outcome.usage, ...outcomeFields(outcome) }),
  modelDrift: (record, outcome) => outcome.observedModel && outcome.observedModel !== record.requestedModel ? { requested: record.requestedModel, observed: outcome.observedModel } : null,
  driftWarning: () => "model_mismatch", failureMessage: (outcome) => outcome.errorMessage,
  classifyFailure, prepareJob, runJob, waitForCleanup: createCleanupWaiter({ engine: "opencode" }), handleModels, handleSetup, quota
});

export { cancelJobRecord };
run();
