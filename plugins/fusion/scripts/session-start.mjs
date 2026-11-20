#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { main as syncRules } from "./rules-sync.mjs";
import { run as checkBreaker } from "./breaker-check.mjs";
import { renderModelTableFromFile, resolveModelRoutingPath } from "./lib/model-table.mjs";
import { tagMessage } from "./lib/user-messages.mjs";
import { pacingLines, quotaResults } from "./lib/quota.mjs";
import { fusionVersion, newerInstalledFusionVersion } from "./lib/engine-acceptance.mjs";

function main(env = process.env, compact = false) {
  const output = [];
  if (compact) {
    output.push(`${tagMessage("session.compact-reposture", "Fusion rules are in ~/.claude/rules/orchestration.md. Collect and settle any in-flight work.")}\n`);
  } else {
    try {
      syncRules(env, (message) => output.push(`${message}\n`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(tagMessage("rules-sync.sync-failed", `fusion: rules sync failed: ${message}`));
    }
    try {
      checkBreaker(env, Date.now(), (text) => output.push(text));
    } catch {
      void 0;
    }
  }
  try {
    const newer = newerInstalledFusionVersion(env);
    if (newer) {
      output.push(`${tagMessage("session.plugin-stale", `This session runs Fusion ${fusionVersion()} while ${newer} is installed, so its hooks and rules predate the update. Restart the session to load ${newer}.`)}\n`);
    }
  } catch {}
  try {
    for (const line of pacingLines(quotaResults(env))) output.push(`${line}\n`);
  } catch {}
  output.push(renderModelTableFromFile(resolveModelRoutingPath(env), undefined, {
    warn: (message) => console.error(tagMessage("rules-sync.model-table-warning", message))
  }));
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: output.join("") } })}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(main(process.env, process.argv.includes("--compact")));
}
