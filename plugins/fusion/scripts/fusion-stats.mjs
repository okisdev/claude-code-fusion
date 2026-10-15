#!/usr/bin/env node

import path from "node:path";
import { RawArgsTransportError, consumeRawArgsTransport, createRawArgsTransport, splitRawArgs } from "./lib/raw-args-transport.mjs";
import { buildFusionStats, buildUnsettledReport } from "./lib/stats/aggregation.mjs";
import { RECORD_REASON_EXAMPLE, UsageError, argumentValue, hasRejectedRecordPair, isIntegerToken, isStrictDirectRecordArguments, isStrictDirectReportOrMaintenanceArguments, parseRecordArguments, readMessageOccurrences, renderMessageDetails, renderMessageRegistry, sessionIdFromArgs, validateArgumentShape } from "./lib/stats/arguments.mjs";
import { pruneDeadWorkspaces, pruneOldObservationSidecars } from "./lib/stats/pruning.mjs";
import { renderAuditReport, renderFusionStats, renderPruneReport, renderSessionReport, renderTraceReport, renderUnsettledReport } from "./lib/stats/rendering.mjs";
import { buildAuditReport, buildSessionReport, buildTraceReport, positiveAuditDays } from "./lib/stats/reports.mjs";
import { settleRecords } from "./lib/stats/settlement.mjs";
import { MESSAGE_REGISTRY, registryEntry, tagMessage } from "./lib/user-messages.mjs";
import { fileURLToPath } from "node:url";

export { fusionWorkspaceKey, resolveFusionDataDir, modelAuditSidecarPath, tokenUsageSidecarPath, loadModelAuditObservations, normalizeCollectionMethod, resolveCodexJobModel, resolveCodexJobEffort, appendTokenUsageObservation, appendModelAuditObservations, appendModelAuditObservation, resolveGitRepositoryCommonDir, fusionRepositoryKey, workspaceRootsShareRepository } from "./lib/stats/evidence.mjs";
export { FILE_ENGINE_DESCRIPTORS, normalizeCodexTokenUsage } from "./lib/stats/engine-evidence.mjs";
export { fileBasedEngineStats, codexStats, claudeWorkerStats, WORKSPACE_ENGINE_DESCRIPTORS, STATS_PROVIDER_REGISTRY, buildFusionStats } from "./lib/stats/aggregation.mjs";
export { buildAuditReport, buildTraceReport, buildSessionReport } from "./lib/stats/reports.mjs";
export { renderAuditReport, renderSessionReport, renderPruneReport, renderFusionStats } from "./lib/stats/rendering.mjs";
export { pruneOldObservationSidecars, findDeadWorkspaces, pruneDeadWorkspaces } from "./lib/stats/pruning.mjs";
export { clusterDispatchBursts, buildFleetUsageStats } from "./lib/stats/fleet.mjs";
export { isStrictDirectReportOrMaintenanceArguments } from "./lib/stats/arguments.mjs";
export { EnginePluginUpgradeRequiredError, newestEngineCompanion } from "./lib/engine-acceptance.mjs";

export function main(argv = process.argv.slice(2), { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, rawArgs = false } = {}) {
  validateArgumentShape(argv);
  const asJson = argv.includes("--json");

  if (argv.includes("--messages")) {
    stdout.write(renderMessageRegistry());
    return MESSAGE_REGISTRY;
  }

  if (argv.includes("--message")) {
    const codeValue = argv[argv.indexOf("--message") + 1];
    if (!isIntegerToken(codeValue)) {
      stderr.write("The --message code must be an integer. Run --messages to list every fusion message digest.\n");
      return { exitCode: 1 };
    }
    const entry = registryEntry(Number(codeValue));
    if (!entry) {
      stderr.write(`Unknown fusion message code ${codeValue}. Run --messages to list every fusion message digest.\n`);
      return { exitCode: 1 };
    }
    const occurrences = readMessageOccurrences(entry.code, env);
    stdout.write(renderMessageDetails(entry, occurrences));
    return { entry, occurrences };
  }

  if (argv.includes("--audit")) {
    const all = argv.includes("--all");
    const report = buildAuditReport({
      env,
      sessionId: argv.includes("--session") ? sessionIdFromArgs(argv, env) : null,
      days: all ? null : positiveAuditDays(argumentValue(argv, "--days")),
      all
    });
    stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : renderAuditReport(report));
    return report;
  }

  if (argv.includes("--record")) {
    const request = parseRecordArguments(argv, { allowPerPairReasons: rawArgs });
    const result = settleRecords({ ...request, workspaceRoot: cwd, env, stdout, stderr });
    if (result.errors.length > 0) {
      throw new Error(`${result.errors.length} record settlement ${result.errors.length === 1 ? "failed" : "failures"}.`);
    }
    return result.writes;
  }

  if (argv.includes("--prune-dead")) {
    const result = pruneDeadWorkspaces({ env, yes: argv.includes("--yes") });
    stdout.write(asJson ? `${JSON.stringify(result, null, 2)}\n` : renderPruneReport(result));
    return result;
  }

  if (argv.includes("--unsettled")) {
    const report = buildUnsettledReport({ env });
    stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : renderUnsettledReport(report));
    return report;
  }

  if (argv.includes("--trace")) {
    const report = buildTraceReport({ env, cwd, sessionId: sessionIdFromArgs(argv, env) });
    stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : renderTraceReport(report));
    return report;
  }

  if (argv.includes("--session")) {
    const report = buildSessionReport({ env, sessionId: sessionIdFromArgs(argv, env) });
    stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : renderSessionReport(report));
    return report;
  }

  const all = argv.includes("--all");
  try { pruneOldObservationSidecars(env); } catch { void 0; }
  const report = buildFusionStats({ all, env, cwd });
  if (asJson) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stdout.write(renderFusionStats(report, { identities: argv.includes("--identities"), byDay: argv.includes("--by-day") }));
  }
  return report;
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function runCli(argv = process.argv.slice(2)) {
  let transportConsumed = false;
  try {
    if (argv[0] === "transport-create") {
      if (argv.length !== 1) {
        throw new TypeError("transport-create does not accept arguments.");
      }
      process.stdout.write(`${JSON.stringify(createRawArgsTransport())}\n`);
      return;
    }
    if (argv[0] === "transport-discard") {
      if (argv.length !== 3 || argv[1] !== "--raw-args-token") {
        throw new TypeError("transport-discard requires --raw-args-token TOKEN.");
      }
      consumeRawArgsTransport(argv[2]);
      return;
    }
    if (argv[0] !== "--raw-args-token") validateArgumentShape(argv);
    if (isStrictDirectRecordArguments(argv) || isStrictDirectReportOrMaintenanceArguments(argv)) {
      if (hasRejectedRecordPair(argv)) {
        process.stderr.write(`${tagMessage("stats.raw-args-required", "Rejected verdicts require --reason through the raw-args transport. For batch settlements, use --reason-for <id> <text> for each rejected pair.")}\n`);
        process.exitCode = 1;
        return;
      }
      const result = main(argv);
      if (result?.exitCode) {
        process.exitCode = result.exitCode;
      }
      return;
    }
    if (argv[0] !== "--raw-args-token") {
      throw new TypeError("Fusion stats requests must be supplied through --raw-args-token.");
    }
    if (argv.length !== 2) {
      throw new RawArgsTransportError("The Fusion input transport requires exactly one token.");
    }
    const request = consumeRawArgsTransport(argv[1]);
    transportConsumed = true;
    const result = main(splitRawArgs(request), { rawArgs: true });
    if (result?.exitCode) {
      process.exitCode = result.exitCode;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`Usage: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (!(error instanceof TypeError || error instanceof RawArgsTransportError)) {
      throw error;
    }
    const grammarError = error.message.endsWith(`\n${RECORD_REASON_EXAMPLE}`);
    const message = grammarError ? error.message.slice(0, -RECORD_REASON_EXAMPLE.length - 1) : error.message;
    const retry = transportConsumed ? " The transport token was consumed; run transport-create again before retrying." : "";
    process.stderr.write(`${tagMessage("stats.request-error", `${message}${retry}`)}\n`);
    if (grammarError) {
      process.stderr.write(`${RECORD_REASON_EXAMPLE}\n`);
    }
    process.exitCode = 1;
  }
}

if (isMain()) {
  runCli();
}
