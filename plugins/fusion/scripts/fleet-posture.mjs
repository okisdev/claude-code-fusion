#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isStrictPosture, resolveFusionDataDir } from "./lib/posture.mjs";
import { normalizeSessionId, resolveStateDir, stateFile } from "./inline-delegation-guard.mjs";
import { tagMessage } from "./lib/user-messages.mjs";

const FLEET_MODE_ENV = "FUSION_FLEET_MODE";
const NARROW_WAVE_THRESHOLD_ENV = "FUSION_NARROW_WAVE_THRESHOLD";
const FLEET_MODE_FILE = "fleet-mode";
const DEFAULT_NARROW_WAVE_THRESHOLD = 2;
const ADDITIONAL_CONTEXT = tagMessage("fleet-posture.strict-fleet-reminder", "fleet-default active: a goal that decomposes into three or more independent work packages convenes /fusion:ultra once bootstrap dependencies are resolved; narrower execution states `fleet-decline: <reason>` visibly in the reply.");
const SESSION_LANES_REMINDER = tagMessage("fleet-posture.session-lanes-reminder", "fusion lanes ready: codex terra/luna for quick and volume packages, grok under its four roles, claude workers for the Claude surface. Independent packages dispatch together in one message; three or more convene /fusion:ultra; a single coherent change stays inline.");

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

function resolveNarrowWaveThreshold(env = process.env) {
  const parsed = Number.parseInt(String(env[NARROW_WAVE_THRESHOLD_ENV]), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_NARROW_WAVE_THRESHOLD;
}

function claimSessionLanesReminder(input, env = process.env) {
  const sessionId = normalizeSessionId(input?.session_id);
  if (!sessionId) {
    return false;
  }
  const file = path.join(resolveFusionDataDir(env), "fleet-posture", "session-lanes-reminders", `${sessionId}.marker`);
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

function readUnannouncedNarrowWaveStreak(input, env = process.env) {
  const sessionId = normalizeSessionId(input?.session_id);
  if (!sessionId) {
    return null;
  }
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(resolveStateDir(env), sessionId), "utf8"));
    if (!Number.isInteger(state?.consecutiveNarrowWaves) || state.consecutiveNarrowWaves < 0) {
      return null;
    }
    return state.lastAdvisedNarrowWaveStreak === state.consecutiveNarrowWaves ? null : state.consecutiveNarrowWaves;
  } catch {
    return null;
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
  if (claimSessionLanesReminder(input)) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: SESSION_LANES_REMINDER } })}\n`);
    return;
  }
  const streak = readUnannouncedNarrowWaveStreak(input);
  if (streak === null || streak < resolveNarrowWaveThreshold()) {
    return;
  }
  const additionalContext = tagMessage("fleet-posture.narrow-wave-reminder", `${streak} consecutive width one dispatch waves in this session. If the remaining packages are independent, dispatch them together in one message; /fusion:ultra is available when the goal is genuinely wide.`);
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } })}\n`);
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
