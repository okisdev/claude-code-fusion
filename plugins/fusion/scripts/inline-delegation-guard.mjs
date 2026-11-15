#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeHook, readHookInput } from "./lib/guard/handler.mjs";
import { renderHookResult } from "./lib/lifecycle/output.mjs";

function main() {
  const input = readHookInput();
  const stdout = renderHookResult(executeHook(input), input?.hook_event_name ?? "PreToolUse");
  if (stdout) process.stdout.write(stdout);
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
export { resolveAuditDir, resolveLockTimeoutMs, resolveStateDir } from "./lib/guard/config.mjs";
export { totalDispatches } from "./lib/guard/dispatch.mjs";
