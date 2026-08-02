#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { syncRulesToLive } from "./lib/rules-template.mjs";
import { tagMessage } from "./lib/user-messages.mjs";

export function main(env = process.env) {
  return syncRulesToLive({ pluginRoot: env.CLAUDE_PLUGIN_ROOT, env });
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(tagMessage("rules-sync.sync-failed", `fusion: rules sync failed: ${message}`));
    process.exit(0);
  }

  process.exit(0);
}
