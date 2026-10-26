import { PEER_RESCUE_AGENT_NAMES } from "../engines.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_ID_ALTERNATION, PEER_JOB_FOOTER_AGENTS, engineForAgentType, engineRoleFromBrief } from "../engines.mjs";
import { readRoutingDefaults } from "../model-table.mjs";
import { tagMessage } from "../user-messages.mjs";
import { canonicalWorkerAgentType, createWorkerRecord, createWorkerTaskId, readWorkerRecords, updateWorkerSessionState, workerRecordFile, writePrivateText, WORKER_TERMINAL_STATUSES } from "../worker-state.mjs";
import { workerLimits } from "./budget.mjs";
import { updateLifecycleWorkerRecord } from "./records.mjs";
import { PARENT_CONTEXT_ADVISORY_TOKENS_ENV, VERIFICATION_MANIFEST_ENV, DEFAULT_BRIEF_MAX_BYTES, SIZING_ADVISORY_BYTES, DEFAULT_PARENT_CONTEXT_ADVISORY_TOKENS, PARENT_CONTEXT_TAIL_MAX_BYTES, BRIEF_AGENTS } from "./constants.mjs";

function allowAgentWithTaskId(toolInput, taskId, additionalContext = null) {
  const prompt = promptText(toolInput);
  const marker = `fusion-task-id: ${taskId}`;
  const lines = prompt.split(/\r?\n/).filter((line) => !/^fusion-task-id:\s*/i.test(line.trim()));
  const firstNonBlankLine = lines.findIndex((line) => line.trim());
  lines.splice(lines[firstNonBlankLine]?.trim() === "fusion-brief: v1" ? firstNonBlankLine + 1 : 0, 0, marker);
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...toolInput, prompt: lines.join("\n") }, ...(additionalContext ? { additionalContext } : {}) } };
}

function promptText(toolInput) {
  return typeof toolInput?.prompt === "string" ? toolInput.prompt : "";
}

function leadingCompanionOptions(prompt) {
  const tokens = [...prompt.matchAll(/(?:[^\s"'\\]|\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')+/g)];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index][0];
    if (token === "--") {
      return { options: tokens.slice(0, index).map((entry) => entry[0]), brief: prompt.slice(tokens[index].index + 2).trimStart(), separated: true };
    }
    if (!/^--[a-z][\w-]*(?:=.+)?$/i.test(token)) {
      return { options: [], brief: prompt, separated: false };
    }
    if (!token.includes("=") && tokens[index + 1] && !tokens[index + 1][0].startsWith("--")) {
      index += 1;
    }
  }
  return { options: [], brief: prompt, separated: false };
}

function optionValue(options, name) {
  const index = options.findIndex((option) => option === name || option.startsWith(`${name}=`));
  if (index < 0) {
    return null;
  }
  const value = options[index] === name ? options[index + 1] ?? "" : options[index].slice(name.length + 1);
  return value.replace(/^(["'])(.*)\1$/s, "$2");
}

function injectedPeerDefaults(prompt, agentType, env) {
  if (typeof prompt !== "string") {
    return null;
  }
  const { options, brief, separated } = leadingCompanionOptions(prompt);
  const header = brief.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  const roleField = new RegExp(`(?:^|\\|\\s*)(?:${ENGINE_ID_ALTERNATION})-role:`, "i");
  if (!/^lane:/i.test(header) && !roleField.test(header)) {
    return null;
  }
  const engine = engineForAgentType(agentType);
  const role = engineRoleFromBrief(engine, brief);
  if (role === null) {
    return null;
  }
  const defaults = readRoutingDefaults(env, { warn: null });
  const choice = defaults[engine]?.[role];
  if (!choice) {
    return null;
  }
  const lane = `${engine} ${role}`;
  const model = optionValue(options, "--model");
  const effort = optionValue(options, "--effort");
  const filled = [];
  if (model === null) {
    filled.push("--model", choice.model);
  }
  if (effort === null) {
    const matched = Object.values(defaults[engine]).find((entry) => entry.model === (model ?? choice.model));
    filled.push("--effort", matched?.effort ?? choice.effort);
  }
  if (filled.length === 0) {
    return null;
  }
  return {
    prompt: `${filled.join(" ")} ${separated ? prompt : `-- ${prompt}`}`,
    context: tagMessage("worker-lifecycle.lane-default-injection", `Filled ${filled.join(" ")} from the routing table's ${lane} lane default.`)
  };
}

function parentContextAdvisoryTokens(env) {
  const raw = env[PARENT_CONTEXT_ADVISORY_TOKENS_ENV];
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
    return DEFAULT_PARENT_CONTEXT_ADVISORY_TOKENS;
  }
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_PARENT_CONTEXT_ADVISORY_TOKENS;
}

function hostPeerCapacity(totalMemoryBytes = os.totalmem()) {
  return Math.max(2, Math.floor(totalMemoryBytes / (3 * 1024 ** 3)));
}

function hostPeerCapacityDenial(env, now = Date.now(), totalMemoryBytes = os.totalmem()) {
  const capacity = hostPeerCapacity(totalMemoryBytes);
  const inFlight = readWorkerRecords(env, { strict: true }).filter((record) => {
    if (!PEER_RESCUE_AGENT_NAMES.has(record.agentType) || WORKER_TERMINAL_STATUSES.has(record.transportStatus)) {
      return false;
    }
    const livenessAt = Date.parse(record.lastLivenessAt ?? record.startedAt ?? record.createdAt ?? "");
    const stallMs = Number.isSafeInteger(record.limits?.stallMs) && record.limits.stallMs > 0
      ? record.limits.stallMs
      : workerLimits(record.agentType, env).stallMs;
    return Number.isFinite(livenessAt) && now - livenessAt <= stallMs;
  }).length;
  if (inFlight < capacity) {
    return null;
  }
  const totalGiB = Math.round(totalMemoryBytes / 1024 ** 3 * 10) / 10;
  return tagMessage("worker-lifecycle.host-capacity-deny", `Host peer capacity reached: ${inFlight} peer wrapper jobs in flight (capacity ${capacity}; total memory ${totalGiB} GiB). Relaunch after a completion notification.`);
}

function parentContextTokens(transcriptPath) {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) {
    return null;
  }
  let descriptor;
  try {
    descriptor = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(descriptor).size;
    const length = Math.min(size, PARENT_CONTEXT_TAIL_MAX_BYTES);
    const start = size - length;
    const buffer = Buffer.allocUnsafe(length);
    const read = fs.readSync(descriptor, buffer, 0, length, start);
    let tail = buffer.subarray(0, read).toString("utf8");
    if (start > 0) {
      const newline = tail.indexOf("\n");
      tail = newline < 0 ? "" : tail.slice(newline + 1);
    }
    for (const line of tail.trimEnd().split("\n").reverse()) {
      try {
        const entry = JSON.parse(line);
        if (entry?.type !== "assistant" || entry.isSidechain === true || entry.isMeta === true) {
          continue;
        }
        const usage = entry.message?.usage;
        const counts = [usage?.input_tokens, usage?.cache_read_input_tokens ?? 0, usage?.cache_creation_input_tokens ?? 0];
        if (counts.every((value) => Number.isSafeInteger(value) && value >= 0)) {
          const tokens = counts.reduce((total, value) => total + value, 0);
          if (Number.isSafeInteger(tokens)) {
            return tokens;
          }
        }
      } catch {
        void 0;
      }
    }
  } catch {
    return null;
  } finally {
    if (descriptor != null) {
      fs.closeSync(descriptor);
    }
  }
  return null;
}

function verificationManifestPath(env) {
  const configured = env[VERIFICATION_MANIFEST_ENV];
  return typeof configured === "string" && configured.trim()
    ? path.resolve(configured)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "verification-manifest.json");
}

function globToRegExp(glob) {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        while (glob[index + 1] === "*") {
          index += 1;
        }
        if (glob[index + 1] === "/") {
          pattern += "(?:.*/)?";
          index += 1;
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (character === "?") {
      pattern += "[^/]";
    } else {
      pattern += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}

function readVerificationManifest(env) {
  try {
    const manifest = JSON.parse(fs.readFileSync(verificationManifestPath(env), "utf8"));
    if (!Array.isArray(manifest) || !manifest.every((entry) => entry && typeof entry === "object" && Array.isArray(entry.paths) && entry.paths.length > 0 && entry.paths.every((value) => typeof value === "string" && value) && Array.isArray(entry.suites) && entry.suites.length > 0 && entry.suites.every((value) => typeof value === "string" && value))) {
      return [];
    }
    return manifest.map((entry) => ({ paths: entry.paths.map((glob) => globToRegExp(glob)), suites: entry.suites }));
  } catch {
    return [];
  }
}

function pathsNamedInBrief(prompt) {
  const paths = new Set();
  for (const line of prompt.split(/\r?\n/)) {
    const field = line.match(/^(?:scope|goal):\s*(.*)$/i);
    if (!field) {
      continue;
    }
    for (const match of field[1].matchAll(/(?:\.\/)?(?:[A-Za-z0-9_@.+*?\[\]{}-]+\/)+[A-Za-z0-9_@.+*?\[\]{}-]+/g)) {
      paths.add(match[0].replace(/^\.\//, "").replace(/[.,:;!?)\]}]+$/, ""));
    }
  }
  return paths;
}

function missingVerificationSuites(prompt, env) {
  const verification = prompt.split(/\r?\n/).find((line) => /^verification:\s*\S/i.test(line));
  if (!verification) {
    return [];
  }
  const namedPaths = pathsNamedInBrief(prompt);
  if (namedPaths.size === 0) {
    return [];
  }
  const required = new Set();
  for (const entry of readVerificationManifest(env)) {
    if ([...namedPaths].some((namedPath) => entry.paths.some((pattern) => pattern.test(namedPath)))) {
      for (const suite of entry.suites) {
        required.add(suite);
      }
    }
  }
  return [...required].filter((suite) => !verification.includes(suite));
}

function briefAdvisories(prompt, briefBytes, hasSizing, env) {
  const advisories = [];
  const missingSuites = missingVerificationSuites(prompt, env);
  if (missingSuites.length > 0) {
    advisories.push(`Verification advisory: add the required suite${missingSuites.length === 1 ? "" : "s"} to \`verification:\`: ${missingSuites.join(", ")}.`);
  }
  if (briefBytes > SIZING_ADVISORY_BYTES && !hasSizing) {
    advisories.push("Sizing advisory: this brief exceeds 8192 bytes without a `sizing:` field. Add `sizing: large` or split the package into smaller briefs.");
  }
  return advisories;
}

function validateWorkerBrief(prompt, agentType, env = process.env) {
  const canonical = canonicalWorkerAgentType(agentType);
  if (!BRIEF_AGENTS.has(canonical)) {
    return { ok: true };
  }
  const maximumBytes = DEFAULT_BRIEF_MAX_BYTES;
  if (Buffer.byteLength(prompt) > maximumBytes) {
    return { ok: false, reason: `Fusion worker brief exceeds ${maximumBytes} bytes; reduce it to the minimal self-contained task context.` };
  }
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim())?.trim();
  if (firstLine !== "fusion-brief: v1") {
    return { ok: false, reason: "Fusion worker briefs must start with `fusion-brief: v1`." };
  }
  const required = [
    [/^context-mode:\s*isolated\s*$/im, "context-mode: isolated"],
    [/^goal:\s*\S/im, "goal:"],
    [/^scope:\s*\S/im, "scope:"]
  ];
  for (const [pattern, label] of required) {
    if (!pattern.test(prompt)) {
      return { ok: false, reason: `Fusion worker brief is missing \`${label}\`.` };
    }
  }
  if (!/^(?:verification|acceptance):\s*\S/im.test(prompt)) {
    return { ok: false, reason: "Fusion worker brief must include `verification:` for execution or `acceptance:` for analysis." };
  }
  if (/\b(?:the conversation above|all previous messages|full parent transcript|inherit(?:ed)? conversation)\b/i.test(prompt)) {
    return { ok: false, reason: "Fusion workers receive a minimal isolated brief, not the parent conversation or transcript." };
  }
  if (/^fusion-task-id:\s*/im.test(prompt)) {
    return { ok: false, reason: "`fusion-task-id` is reserved for the lifecycle guard." };
  }
  const packageTypeLines = prompt.split(/\r?\n/).filter((line) => /^package-type\s*:/i.test(line.trim()));
  if (packageTypeLines.length > 1) {
    return { ok: false, reason: "Fusion worker brief `package-type:` may appear once and must be one of `implementation`, `consult`, `review`, `research`, or `design`." };
  }
  const packageType = packageTypeLines.length === 1
    ? packageTypeLines[0].match(/^package-type\s*:\s*(implementation|consult|review|research|design)\s*$/i)?.[1]?.toLowerCase()
    : /^verification:\s*\S/im.test(prompt) ? "implementation" : "consult";
  if (!packageType) {
    return { ok: false, reason: "Fusion worker brief `package-type:` must be one of `implementation`, `consult`, `review`, `research`, or `design`." };
  }
  const sizingLines = prompt.split(/\r?\n/).filter((line) => /^sizing\s*:/i.test(line.trim()));
  if (sizingLines.length > 1) {
    return { ok: false, reason: "Fusion worker brief `sizing:` may appear once and must be one of `small`, `standard`, or `large`." };
  }
  if (sizingLines.length === 1) {
    const sizing = sizingLines[0].match(/^sizing\s*:\s*(small|standard|large)\s*$/i)?.[1]?.toLowerCase();
    if (!sizing) {
      return { ok: false, reason: "Fusion worker brief `sizing:` must be one of `small`, `standard`, or `large`." };
    }
    const briefBytes = Buffer.byteLength(prompt);
    return { ok: true, sizing, packageType, briefBytes, advisories: briefAdvisories(prompt, briefBytes, true, env) };
  }
  const briefBytes = Buffer.byteLength(prompt);
  return { ok: true, packageType, briefBytes, advisories: briefAdvisories(prompt, briefBytes, false, env) };
}

function externalUserText(entry) {
  if (entry?.type !== "user" || entry?.toolUseResult != null || entry?.sourceToolAssistantUUID) {
    return null;
  }
  const content = entry?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
  return text || null;
}

function latestUserRequestedBackground(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    return false;
  }
  let text;
  try {
    const stat = fs.statSync(transcriptPath);
    const start = Math.max(0, stat.size - 1024 * 1024);
    const descriptor = fs.openSync(transcriptPath, "r");
    try {
      const buffer = Buffer.allocUnsafe(stat.size - start);
      fs.readSync(descriptor, buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(descriptor);
    }
    if (start > 0) {
      text = text.slice(text.indexOf("\n") + 1);
    }
  } catch {
    return false;
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(JSON.parse(line));
    } catch {
      void 0;
    }
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const userText = externalUserText(entries[index]);
    if (userText != null) {
      return /(?:^|\s)--background(?:\s|$)/.test(userText);
    }
  }
  return false;
}

function safeDescription(value) {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 120) : null;
}

function completionContract(agentType, prompt) {
  const canonical = canonicalWorkerAgentType(agentType);
  if (canonical === "fusion:job-collector") {
    return "collector";
  }
  if (PEER_JOB_FOOTER_AGENTS.has(agentType)) {
    return "transport";
  }
  if (canonical === "fusion:deep-reasoner" || (!/^verification:\s*\S/im.test(prompt) && /^acceptance:\s*\S/im.test(prompt))) {
    return "coverage";
  }
  return "verification";
}

function collectorRequestIdentity(prompt) {
  const lines = String(prompt ?? "").split(/\r?\n/).map((line) => line.trim());
  const engineLines = lines.filter((line) => /^engine\s*:/i.test(line));
  const jobLines = lines.filter((line) => /^job\s*:/i.test(line));
  if (engineLines.length !== 1 || jobLines.length !== 1) {
    return null;
  }
  const engine = engineLines[0].match(new RegExp(String.raw`^engine:\s*(${ENGINE_ID_ALTERNATION})\s*$`))?.[1] ?? null;
  const jobId = jobLines[0].match(/^job:\s*([a-f0-9]{32})\s*$/)?.[1] ?? null;
  return engine && jobId ? { expectedPeerEngine: engine, expectedPeerJobId: jobId } : null;
}

function fallbackPackageType(agentType, prompt) {
  if (!PEER_RESCUE_AGENT_NAMES.has(agentType)) {
    return /^verification:\s*\S/im.test(prompt) ? "implementation" : "consult";
  }
  const packageTypeLines = prompt.split(/\r?\n/).filter((line) => /^package-type\s*:/i.test(line.trim()));
  const explicitPackageType = packageTypeLines.length === 1
    ? packageTypeLines[0].match(/^package-type\s*:\s*(implementation|consult|review|research|design)\s*$/i)?.[1]?.toLowerCase()
    : null;
  if (explicitPackageType) {
    return explicitPackageType;
  }
  const separator = /(?:^|\s)--(?=\s|$)/.exec(prompt);
  const peerPromptPrefix = separator ? prompt.slice(0, separator.index) : prompt;
  if (/(?:^|\s)--(?:write|transport-default-write)(?=\s|$)/.test(peerPromptPrefix)) {
    return "implementation";
  }
  return /^verification:\s*\S/im.test(prompt) ? "implementation" : "consult";
}

function createDispatch(input, agentType, userBackgroundAuthorized, env, validation = {}) {
  const taskId = createWorkerTaskId(input.session_id, input.tool_use_id);
  const prompt = promptText(input.tool_input);
  const collectorIdentity = canonicalWorkerAgentType(agentType) === "fusion:job-collector" ? collectorRequestIdentity(prompt) : null;
  let parentTranscriptBytesAtDispatch = null;
  try {
    parentTranscriptBytesAtDispatch = fs.statSync(input.transcript_path).size;
  } catch {
    void 0;
  }
  const record = createWorkerRecord({
    taskId,
    sessionId: input.session_id,
    dispatchToolUseId: input.tool_use_id ?? null,
    agentType,
    description: safeDescription(input.tool_input?.description),
    workspaceRoot: input.cwd,
    expectedDelivery: userBackgroundAuthorized ? "manual-background" : "foreground",
    userBackgroundAuthorized,
    parentTranscriptPath: typeof input.transcript_path === "string" ? input.transcript_path : null,
    parentTranscriptBytesAtDispatch,
    parentContextTokensAtDispatch: parentContextTokens(input.transcript_path),
    packageType: validation.packageType ?? fallbackPackageType(agentType, prompt),
    briefBytes: validation.briefBytes ?? null,
    completionContract: completionContract(agentType, prompt),
    ...collectorIdentity,
    limits: workerLimits(agentType, env, validation.sizing)
  }, env);
  if (!PEER_RESCUE_AGENT_NAMES.has(agentType)) {
    return record;
  }
  try {
    const briefFile = briefArtifactPath(record, env);
    writePrivateText(briefFile, prompt);
    return updateLifecycleWorkerRecord(record.taskId, env, (current) => current ? { ...current, briefFile } : null);
  } catch {
    return record;
  }
}

function claimParentContextAdvisory(sessionId, tokens, env) {
  const threshold = parentContextAdvisoryTokens(env);
  if (threshold === 0 || !Number.isSafeInteger(tokens)) {
    return null;
  }
  const claimed = [];
  try {
    updateWorkerSessionState(sessionId, env, (current) => {
      const next = { ...(current ?? {}) };
      if (tokens >= threshold && current?.parentContextAdvisorySent !== true) {
        claimed.push(threshold);
        next.parentContextAdvisorySent = true;
      }
      if (tokens >= 800000 && current?.parentContextAdvisory800kSent !== true && threshold !== 800000) {
        claimed.push(800000);
        next.parentContextAdvisory800kSent = true;
      }
      return claimed.length ? next : null;
    });
  } catch {
    return null;
  }
  return claimed.length ? claimed.map(() => `The main loop context is ${Math.round(tokens / 1000)}k tokens and every turn replays it. Finish this wave, then prefer /compact or a fresh session before the next goal.`).join("\n") : null;
}

function briefArtifactPath(record, env) {
  return path.join(path.dirname(workerRecordFile(record.taskId, env)), `${record.taskId}.brief.txt`);
}


export { allowAgentWithTaskId, promptText, leadingCompanionOptions, optionValue, injectedPeerDefaults, parentContextAdvisoryTokens, parentContextTokens, hostPeerCapacity, hostPeerCapacityDenial, verificationManifestPath, globToRegExp, readVerificationManifest, pathsNamedInBrief, missingVerificationSuites, briefAdvisories, validateWorkerBrief, externalUserText, latestUserRequestedBackground, safeDescription, completionContract, collectorRequestIdentity, createDispatch, claimParentContextAdvisory, briefArtifactPath };
