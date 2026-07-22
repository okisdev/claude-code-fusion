#!/usr/bin/env node

import fs from "node:fs";

const [, , answerPath] = process.argv;

if (!answerPath) {
  console.error("usage: node check-answer.mjs <path to answer.json>");
  process.exit(2);
}

const EXPECTED = {
  queue_concurrency: { final_default: 12, changed_in_version: "4.0.0" },
  retry_backoff_ms: { final_default: 900, changed_in_version: "4.2.0" },
  webhook_timeout_ms: { final_default: 8000, changed_in_version: "4.1.0" }
};

if (!fs.existsSync(answerPath)) {
  console.error(`answer file missing: ${answerPath}`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(answerPath, "utf8"));
} catch (err) {
  console.error(`answer file is not valid JSON: ${err.message}`);
  process.exit(1);
}

let ok = true;
for (const [key, expected] of Object.entries(EXPECTED)) {
  const actual = parsed && typeof parsed === "object" ? parsed[key] : undefined;
  if (!actual || typeof actual !== "object") {
    console.error(`${key}: missing or not an object`);
    ok = false;
    continue;
  }
  if (actual.final_default !== expected.final_default) {
    console.error(`${key}.final_default: expected ${expected.final_default}, got ${JSON.stringify(actual.final_default)}`);
    ok = false;
  }
  if (actual.changed_in_version !== expected.changed_in_version) {
    console.error(`${key}.changed_in_version: expected ${JSON.stringify(expected.changed_in_version)}, got ${JSON.stringify(actual.changed_in_version)}`);
    ok = false;
  }
}

if (!ok) {
  process.exit(1);
}

console.log("answer.json matches the expected research result.");
