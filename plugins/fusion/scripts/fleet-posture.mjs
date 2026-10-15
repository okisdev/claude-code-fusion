#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isStrictPosture, resolveFusionDataDir } from "./lib/posture.mjs";
import { readRoutingDefaults } from "./lib/model-table.mjs";
import { normalizeSessionId } from "./inline-delegation-guard.mjs";
import { tagMessage } from "./lib/user-messages.mjs";

const FLEET_MODE_ENV = "FUSION_FLEET_MODE";
const FLEET_MODE_FILE = "fleet-mode";
const ADDITIONAL_CONTEXT = tagMessage("fleet-posture.strict-fleet-reminder", "fleet-default active: a goal that decomposes into three or more independent work packages convenes /fusion:ultra once bootstrap dependencies are resolved; narrower execution states `fleet-decline: <reason>` visibly in the reply.");

function sessionLanesReminder(env = process.env) {
  const { flagship, quick, volume } = readRoutingDefaults(env).codex;
  return tagMessage("fleet-posture.session-lanes-reminder", `fusion lanes ready: codex ${flagship.model} for spec grade and deep review, ${quick.model} and ${volume.model} for quick and volume packages, grok under its four roles on the routing table's lane defaults, claude workers for the Claude surface. Independent packages dispatch together in one message; three or more convene /fusion:ultra; a single coherent change stays inline.`);
}

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

function claimReminder(input, markerDirectory, env = process.env) {
  const sessionId = normalizeSessionId(input?.session_id);
  if (!sessionId) {
    return false;
  }
  const file = path.join(resolveFusionDataDir(env), "fleet-posture", markerDirectory, `${sessionId}.marker`);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(descriptor, "\n", "utf8");
    fs.fchmodSync(descriptor, 0o600);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function main() {
  if (!fleetEnabled()) {
    return;
  }
  const input = readHookInput();
  if (!input) {
    return;
  }
  if (isStrictPosture()) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ADDITIONAL_CONTEXT } })}\n`);
    return;
  }
  if (claimReminder(input, "session-lanes-reminders")) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: sessionLanesReminder() } })}\n`);
    return;
  }
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
