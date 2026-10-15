#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeHook, readHookInput, runAllowCommand } from "./lib/guard/handler.mjs";

function main() {
  const [subcommand] = process.argv.slice(2);
  if (subcommand === "allow") {
    runAllowCommand();
    return;
  }
  executeHook(readHookInput());
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  main();
}

export { DEFAULT_LOCK_TIMEOUT_MS } from "./lib/guard/constants.mjs";
export { handleInlineDelegationHook } from "./lib/guard/handler.mjs";
export { listAuditSegments, normalizeAuditEvent, readAuditEvents } from "./lib/guard/audit.mjs";
export { normalizeSessionId, stateFile } from "./lib/guard/state.mjs";
export { resolveAuditDir, resolveLockTimeoutMs, resolveMode, resolveStateDir, resolveTailAllowance, resolveTailMaxBytes, resolveZeroDispatchMaxBytes, resolveZeroDispatchWrites } from "./lib/guard/config.mjs";
export { totalDispatches } from "./lib/guard/dispatch.mjs";
