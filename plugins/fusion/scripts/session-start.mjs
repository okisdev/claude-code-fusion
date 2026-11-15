#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { main as syncRules } from "./rules-sync.mjs";
import { run as checkBreaker } from "./breaker-check.mjs";
import { tagMessage } from "./lib/user-messages.mjs";

function main(env = process.env) {
  const output = [];
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
  return output.join("");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stdout = main();
  if (stdout) process.stdout.write(stdout);
}
