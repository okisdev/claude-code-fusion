#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FLEET_MODE_ENV = "FUSION_FLEET_MODE";
const DATA_DIR_ENV = "FUSION_DATA_DIR";
const FLEET_MODE_FILE = "fleet-mode";
const ADDITIONAL_CONTEXT = "fleet-default active: a goal that decomposes into three or more independent work packages convenes /fusion:ultra once bootstrap dependencies are resolved; narrower execution states `fleet-decline: <reason>` visibly in the reply.";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveFusionDataDir(env = process.env) {
  const override = env[DATA_DIR_ENV];
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return path.join(os.homedir(), ".claude", "plugins", "data", "fusion-claude-code-fusion");
}

function fleetEnabled(env = process.env) {
  if (env[FLEET_MODE_ENV] !== undefined) {
    return env[FLEET_MODE_ENV] !== "off";
  }
  try {
    return fs.readFileSync(path.join(resolveFusionDataDir(env), FLEET_MODE_FILE), "utf8").trim() !== "off";
  } catch {
    return true;
  }
}

function main() {
  if (!readHookInput() || !fleetEnabled()) {
    return;
  }
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ADDITIONAL_CONTEXT } })}\n`);
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  try {
    main();
  } catch {
    void 0;
  }
}
