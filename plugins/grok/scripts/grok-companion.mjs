#!/usr/bin/env node

import path from "node:path";
import { createRawTransport } from "./lib/raw-transport.mjs";
import { rawBooleanOptionRequested } from "./lib/args.mjs";
import { SESSION_ID_ENV } from "./lib/state.mjs";
import { commandContext, output, errorWithFailure } from "./lib/companion/base.mjs";
import { handleTask, handleTaskWorker } from "./lib/companion/task.mjs";
import { handleReview, handleReviewWorker } from "./lib/companion/review.mjs";
import { handleStatus, handleHistory, handleResult, handleCancel } from "./lib/companion/inspection.mjs";
import { handleStats } from "./lib/companion/stats.mjs";
import { handleSetup } from "./lib/companion/setup.mjs";
import { handleModels } from "./lib/companion/models.mjs";
import { handleRecordAcceptance } from "./lib/companion/acceptance.mjs";
import { handleStopGate } from "./lib/companion/stop_gate.mjs";
import { SELF_PATH } from "./lib/companion/paths.mjs";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/grok-companion.mjs task [--prompt-file <path>] [--write] [--web] [--memory] [--background] [--resume <uuid>] [--resume-last] [--fresh] [--model <id>] [--effort <level>] [--max-turns <n>] [--cwd <dir>] [--json-schema <schema>] [--json] [--] [prompt]",
      "  node scripts/grok-companion.mjs review [--base <ref>] [--focus <text>] [--cwd <dir>] [--background] [--json]",
      "  node scripts/grok-companion.mjs status [job-id] [--cwd <dir>] [--json]",
      "  node scripts/grok-companion.mjs history [--all] [--limit <n>] [--cwd <dir>] [--json]",
      "  node scripts/grok-companion.mjs result <job-id> [--cwd <dir>] [--wait] [--wait-timeout-ms <ms>] [--json]",
      "  node scripts/grok-companion.mjs cancel <job-id> [--cwd <dir>] [--json]",
      "  node scripts/grok-companion.mjs record-acceptance --job-id <32 lowercase hex> --acceptance <accepted|rejected|unverified> [--reason <text>] [--failure-kind <intent_override|scope_rewrite|wrong_approach|style_mismatch|oversized>] [--accept-failed-transport]",
      "  node scripts/grok-companion.mjs stats [--all] [--cwd <dir>] [--json]",
      "  node scripts/grok-companion.mjs models [--json]",
      "  node scripts/grok-companion.mjs setup [--continuity <manual|claude-session>] [--enable-stop-gate] [--disable-stop-gate] [--clear-quota-cooldown] [--json]",
      "  node scripts/grok-companion.mjs stop-gate"
    ].join("\n")
  );
}

const { createRawCommandTransport: allocateRawCommandTransport, consumeRawCommandTransport, cleanupRawCommandTransportsForSession, resolveCommandTransport } = createRawTransport({
  engineName: "grok",
  sessionIdEnv: SESSION_ID_ENV,
  makeError: errorWithFailure,
  maxRawArgumentBytes: 4 * 1024 * 1024 + 64 * 1024
});

export { cleanupRawCommandTransportsForSession };
export { resolveLastSessionId, validateResumeSessionId } from "./lib/companion/session.mjs";
export { refreshRunningJobRecord } from "./lib/companion/outcome.mjs";

function createRawCommandTransport() {
  output(allocateRawCommandTransport(), true);
}

async function main() {
  const [subcommand, ...receivedArgv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }
  if (subcommand === "transport-create") {
    if (receivedArgv.length > 0) {
      throw errorWithFailure("transport-create accepts no arguments.", "input");
    }
    createRawCommandTransport();
    return;
  }
  if (subcommand === "transport-discard") {
    if (receivedArgv.length !== 2 || receivedArgv[0] !== "--raw-args-token") {
      throw errorWithFailure("transport-discard requires exactly one raw argument token.", "input");
    }
    consumeRawCommandTransport(receivedArgv[1]);
    return;
  }
  if (subcommand === "record-acceptance") {
    commandContext.argv = receivedArgv;
    handleRecordAcceptance(receivedArgv);
    return;
  }
  const transport = resolveCommandTransport(receivedArgv);
  commandContext.argv = transport.argv;
  commandContext.ingress = transport.ingress;
  if (transport.defaultWrite && subcommand !== "task") {
    throw errorWithFailure("The raw command transport write default is valid only for task.", "input");
  }
  if (transport.defaultBackground && subcommand !== "review") {
    throw errorWithFailure("The raw command transport background default is valid only for review.", "input");
  }
  const argv = transport.argv;

  switch (subcommand) {
    case "task":
      await handleTask(argv, transport);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "review":
      await handleReview(argv, transport);
      break;
    case "review-worker":
      await handleReviewWorker(argv);
      break;
    case "status":
      handleStatus(argv, transport);
      break;
    case "history":
      handleHistory(argv, transport);
      break;
    case "result":
      await handleResult(argv, transport);
      break;
    case "cancel":
      await handleCancel(argv, transport);
      break;
    case "stats":
      handleStats(argv, transport);
      break;
    case "models":
      handleModels(argv, transport);
      break;
    case "setup":
      handleSetup(argv, transport);
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
  if (commandContext.options) {
    return commandContext.options.json === true;
  }
  const argv = commandContext.argv ?? process.argv.slice(3);
  if (commandContext.ingress === "staged_file") {
    return rawBooleanOptionRequested(argv[0] ?? "", "json", commandContext.config ?? {});
  }
  return argv.some((token) => token === "--json" || token === "--json=true");
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
    return `${JSON.stringify({ status, transportStatus: status, semanticStatus: "unverified", delivery: "foreground", deliveryStatus: "delivered", resolvedModel: null, resolvedEffort: null, failureKind, message }, null, 2)}\n`;
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
