#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PEER_RESCUE_AGENTS } from "./lib/engines.mjs";
import { askJev } from "./lib/jev.mjs";
import { tagMessage } from "./lib/user-messages.mjs";

const BRIEF_MIN_CHARS = 200;
const FLAG_THRESHOLD = 0.7;
const CHECKS = [
  {
    id: "mixedConcern",
    instructions: "Does this brief ask the worker to both find the unknown cause of a problem and change code to fix it within the same package?",
    finding: "It asks one package to find a cause and to fix it",
    remedy: "Split it into a diagnosis dispatch and an implementation dispatch written from that result."
  },
  {
    id: "tasteAsProse",
    instructions: "Does this brief demand a style, tone, naming, or design quality without pointing to an exemplar file, a signature, a test, or another checkable constraint?",
    finding: "It carries style or design intent only as prose",
    remedy: "Attach an exemplar file, a signature, or a named test, or keep that part in the main session."
  },
  {
    id: "noDoneCriteria",
    instructions: "Is this brief missing a checkable completion condition, meaning it names no verification command, no acceptance or coverage criteria, and no exact expected output?",
    finding: "It names no checkable completion condition",
    remedy: "Add a verification command or explicit acceptance criteria."
  },
  {
    id: "unbounded",
    instructions: "Does this brief ask for a sweep of a whole repository or of many subsystems without naming the specific paths to cover?",
    finding: "It asks for a sweep without named paths",
    remedy: "Scope it to one subsystem with named paths per brief."
  }
];
const QUESTIONS = Object.fromEntries(CHECKS.map(({ id, instructions }) => [id, { type: "noul", instructions }]));

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

function peerBrief(input) {
  if (input?.hook_event_name !== "PreToolUse" || !["Agent", "Task"].includes(input.tool_name) || !PEER_RESCUE_AGENTS.has(input.tool_input?.subagent_type)) {
    return null;
  }
  const prompt = typeof input.tool_input.prompt === "string" ? input.tool_input.prompt.trim() : "";
  const separator = prompt.startsWith("--") ? prompt.match(/\s--\s/) : null;
  const brief = separator ? prompt.slice(separator.index + separator[0].length).trim() : prompt;
  return brief.length >= BRIEF_MIN_CHARS ? brief : null;
}

function briefAdvisory(answers) {
  const flagged = CHECKS.filter(({ id }) => Number.isFinite(answers?.[id]?.noul) && answers[id].noul >= FLAG_THRESHOLD);
  if (flagged.length === 0) {
    return null;
  }
  const findings = flagged.map(({ id, finding, remedy }) => `${finding} (p=${answers[id].noul.toFixed(2)}). ${remedy}`).join(" ");
  return tagMessage("brief-sensor.readiness-advisory", `Jev flagged this peer brief. ${findings} This is a classifier estimate, not a gate, and the dispatch proceeds.`);
}

async function main() {
  const brief = peerBrief(readHookInput());
  if (!brief) {
    return;
  }
  const additionalContext = briefAdvisory(await askJev(brief, QUESTIONS));
  if (additionalContext) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext } })}\n`);
  }
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  main().catch(() => void 0);
}

export { FLAG_THRESHOLD, QUESTIONS, briefAdvisory, peerBrief };
