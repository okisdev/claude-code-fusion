#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFusionDataDir } from "./lib/worker-state.mjs";
import { readRoutingDefaults } from "./lib/model-table.mjs";
import { normalizeSessionId } from "./inline-delegation-guard.mjs";
import { tagMessage } from "./lib/user-messages.mjs";
import { parentContextTokens, claimParentContextAdvisory } from "./lib/lifecycle/dispatch.mjs";

const FLEET_MODE_ENV = "FUSION_FLEET_MODE";
const FLEET_MODE_FILE = "fleet-mode";
const DEEP_REASONER_HINT = tagMessage("fleet-posture.deep-reasoner-hint", "This reads as a design or root-cause question. Consult fusion:deep-reasoner with a scoped brief before deciding.");
const DESIGN_QUESTION_PATTERN = /思考|分析|重构|架构|根本|为什么|怎么设计|root cause|architecture|redesign|refactor|why does|why is|how should we/i;

function isDesignQuestion(input) {
  const prompt = input?.prompt;
  if (typeof prompt !== "string" || prompt.length > 4000 || input.isMeta === true || input.origin?.kind === "task-notification") return false;
  const trimmed = prompt.trimStart();
  if (trimmed.startsWith("/") || /<task-notification\b/i.test(trimmed) || /^\{[\s\S]*"(?:hook_event_name|hookEventName|hookSpecificOutput|tool_name|tool_input|session_id)"\s*:/.test(trimmed)) return false;
  return DESIGN_QUESTION_PATTERN.test(prompt);
}

function sessionLanesReminder(env = process.env) {
  const { breadth, codex: { flagship, quick, volume } } = readRoutingDefaults(env);
  return tagMessage("fleet-posture.session-lanes-reminder", `fusion lanes ready: codex ${flagship.model} for spec grade and deep review, ${quick.model} and ${volume.model} for quick and volume packages, grok under its four roles on the routing table's lane defaults, ${breadth} under diversity for a model family no other lane carries and under burst for bounded worktree implementation, claude workers for the Claude surface. Independent packages dispatch together in one message; three or more convene /fusion:ultra; a single coherent change stays inline.`);
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

function cleanupReminderMarkers(directory, dataDirectory) {
  try {
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".marker")) {
        continue;
      }
      const file = path.join(directory, entry.name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) {
          fs.unlinkSync(file);
        }
      } catch {
        void 0;
      }
    }
  } catch {
    void 0;
  }
  try {
    fs.rmSync(path.join(dataDirectory, "fleet-posture", "narrow-wave-reminders"), { recursive: true, force: true });
  } catch {
    void 0;
  }
}

function claimReminder(input, markerDirectory, env = process.env) {
  const sessionId = normalizeSessionId(input?.session_id);
  if (!sessionId) {
    return false;
  }
  const dataDirectory = resolveFusionDataDir(env);
  const file = path.join(dataDirectory, "fleet-posture", markerDirectory, `${sessionId}.marker`);
  const directory = path.dirname(file);
  let descriptor;
  try {
    try {
      descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") {
        return false;
      }
      if (error?.code !== "ENOENT") {
        throw error;
      }
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    }
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(descriptor, "\n", "utf8");
    fs.fchmodSync(descriptor, 0o600);
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
  cleanupReminderMarkers(directory, dataDirectory);
  return true;
}

function main() {
  const input = readHookInput();
  if (!input) {
    return;
  }
  const contexts = [];
  let advisory = null;
  try {
    advisory = claimParentContextAdvisory(input.session_id, parentContextTokens(input.transcript_path), process.env);
  } catch {
    void 0;
  }
  if (fleetEnabled()) {
    try {
      if (claimReminder(input, "session-lanes-reminders")) contexts.unshift(sessionLanesReminder());
    } catch {
      void 0;
    }
  }
  if (isDesignQuestion(input)) contexts.push(DEEP_REASONER_HINT);
  if (contexts.length || advisory) {
    process.stdout.write(`${JSON.stringify({ ...(contexts.length ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: contexts.join("\n\n") } } : {}), ...(advisory ? { systemMessage: advisory } : {}) })}\n`);
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
