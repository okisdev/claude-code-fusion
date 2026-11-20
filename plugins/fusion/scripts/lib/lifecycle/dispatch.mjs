import { PEER_RESCUE_AGENT_NAMES } from "../engines.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINES, ENGINE_ID_ALTERNATION, PEER_JOB_FOOTER_AGENTS, engineDisplayName, engineForAgentType, engineRoleFromBrief, routedEngineIds } from "../engines.mjs";
import { readModelRoutingFile, readRoutingDefaults, resolveModelRoutingPath } from "../model-table.mjs";
import { quotaResults } from "../quota.mjs";
import { newestEngineCompanion } from "../engine-acceptance.mjs";
import { engineHealth, readEngineHealthRecords } from "../engine-health.mjs";
import { engineCliAvailable } from "../../breaker-check.mjs";
import { tagMessage } from "../user-messages.mjs";
import { canonicalWorkerAgentType, claudeModelFamily, createWorkerRecord, createWorkerTaskId, readPeerCapacityReservations, readWorkerRecord, readWorkerRecords, updateWorkerSessionState, withPeerCapacityReservations, workerRecordFile, writePrivateText, WORKER_TERMINAL_STATUSES } from "../worker-state.mjs";
import { workerLimits } from "./budget.mjs";
import { sessionRecords, updateLifecycleWorkerRecord } from "./records.mjs";
import { withClaudeQuotaFailure } from "./collection.mjs";
import { finalAssistantTextFromTranscript } from "./notifications.mjs";
import { PARENT_CONTEXT_ADVISORY_TOKENS_ENV, VERIFICATION_MANIFEST_ENV, DEFAULT_BRIEF_MAX_BYTES, SIZING_ADVISORY_BYTES, DEFAULT_PARENT_CONTEXT_ADVISORY_TOKENS, PARENT_CONTEXT_TAIL_MAX_BYTES, BRIEF_AGENTS } from "./constants.mjs";

function allowAgentWithTaskId(toolInput, taskId, additionalContext = null) {
  const prompt = promptText(toolInput);
  const marker = `fusion-task-id: ${taskId}`;
  const lines = prompt.split(/\r?\n/).filter((line) => !/^fusion-task-id:\s*/i.test(line.trim()));
  const firstNonBlankLine = lines.findIndex((line) => line.trim());
  lines.splice(/^fusion-brief\s*:\s*v1\.?$/i.test(lines[firstNonBlankLine]?.trim() ?? "") ? firstNonBlankLine + 1 : 0, 0, marker);
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...toolInput, prompt: lines.join("\n") }, ...(additionalContext ? { additionalContext } : {}) } };
}

function promptText(toolInput) {
  return typeof toolInput?.prompt === "string" ? toolInput.prompt : "";
}

function briefEnvelope(prompt) {
  const lines = prompt.trimStart().split(/\r?\n/);
  const end = lines.findIndex((line) => !line.trim());
  return lines.slice(0, end < 0 ? lines.length : end).map((line) => line.trim().replace(/\.$/, "").trim().replace(/^([^:]+):\s*/, (_, key) => `${key.trim()}: `).toLowerCase());
}

function leadingCompanionOptions(prompt) {
  const tokens = [...prompt.matchAll(/(?:[^\s"'\\]|\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')+/g)];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index][0];
    if (token === "--") {
      return { options: tokens.slice(0, index).map((entry) => entry[0]), brief: prompt.slice(tokens[index].index + 2).trimStart(), separated: true };
    }
    if (!/^--[a-z][\w-]*(?:=.+)?$/i.test(token)) {
      return { options: tokens.slice(0, index).map((entry) => entry[0]), brief: prompt, separated: false };
    }
    if (!token.includes("=") && tokens[index + 1] && !tokens[index + 1][0].startsWith("--")) {
      index += 1;
    }
  }
  return { options: tokens.map((entry) => entry[0]), brief: prompt, separated: false };
}

function optionValue(options, name) {
  const index = options.findIndex((option) => option === name || option.startsWith(`${name}=`));
  if (index < 0) {
    return null;
  }
  const value = options[index] === name ? options[index + 1] ?? "" : options[index].slice(name.length + 1);
  return value.replace(/^(["'])(.*)\1$/s, "$2");
}

function dispatchEngineChoice(engine, prompt, env, records = null) {
  const { options, brief } = leadingCompanionOptions(prompt);
  const defaults = readRoutingDefaults(env, { warn: null })[engine];
  const role = engineRoleFromBrief(engine, brief);
  const explicitModel = optionValue(options, "--model");
  const choice = explicitModel === null ? defaults?.[role] : Object.values(defaults ?? {}).find((row) => row.model === explicitModel) ??
    readModelRoutingFile(resolveModelRoutingPath(env), { env }).data?.models.find((row) => row.lane === engine && row.id === explicitModel);
  const model = explicitModel ?? choice?.model ?? null;
  if (choice) return { model, pool: choice.pool };
  if (!model) return { model, pool: null };
  records ??= readEngineHealthRecords(env);
  const pool = (records.engines.get(engine) ?? [])
    .filter((record) => [record.requestedModel, record.resolvedModel, record.model].includes(model) && record.billingPool)
    .sort((left, right) => Date.parse(right.finishedAt ?? right.updatedAt ?? "") - Date.parse(left.finishedAt ?? left.updatedAt ?? ""))[0]?.billingPool ?? null;
  return { model, pool };
}

function engineInfraDenial(sessionId, agentType, userText, env, now = Date.now(), prompt = "", model = null, dispatchRecord = null) {
  model ??= dispatchRecord?.resolvedModel ?? dispatchRecord?.requestedModel;
  const canonical = canonicalWorkerAgentType(agentType);
  if (canonical && canonical !== "fusion:job-collector") {
    const name = canonical.slice(canonical.indexOf(":") + 1);
    if (new RegExp(String.raw`\b(?:fusion:)?${name}\b`, "i").test(userText ?? "")) return null;
    const requestedFamily = claudeModelFamily(model, env);
    const limits = sessionRecords(sessionId, env)
      .filter((record) => canonicalWorkerAgentType(record.agentType) === canonical && WORKER_TERMINAL_STATUSES.has(record.transportStatus) && record.failureKind === "quota" && record.infraFailure === true && Date.parse(record.finishedAt ?? "") <= now)
      .map((record) => {
        const reset = Date.parse(record.quotaResetAt ?? "");
        let family = claudeModelFamily(record.quotaModelFamily);
        if (!family) {
          family = withClaudeQuotaFailure(record, finalAssistantTextFromTranscript(record.transcriptPath), new Date(now).toISOString()).quotaModelFamily ?? claudeModelFamily(record.resolvedModel) ?? claudeModelFamily(record.requestedModel);
          if (family) {
            const migrated = updateLifecycleWorkerRecord(record.taskId, env, (current) => current?.failureKind === "quota" && WORKER_TERMINAL_STATUSES.has(current.transportStatus) && !claudeModelFamily(current.quotaModelFamily) ? { ...current, quotaModelFamily: family } : null);
            family = claudeModelFamily(migrated?.quotaModelFamily) ?? family;
          }
        }
        return { record, family, reset: Number.isFinite(reset) ? reset : Date.parse(record.finishedAt) + 60 * 60 * 1000 };
      })
      .filter(({ reset }) => reset > now)
      .sort((left, right) => right.reset - left.reset);
    const limited = limits.find(({ family }) => !requestedFamily || !family || family === requestedFamily);
    if (!limited) return null;
    const familyName = limited.family ? limited.family[0].toUpperCase() + limited.family.slice(1) : "Claude";
    const reset = limited.record.quotaResetText ? `${limited.record.quotaResetText} (${new Date(limited.reset).toISOString()})` : `${new Date(limited.reset).toISOString()} (1 hour fallback)`;
    const opusFamily = claudeModelFamily("opus", env);
    const fallback = opusFamily === "opus" && limited.family && limited.family !== opusFamily && !limits.some(({ family }) => !family || family === opusFamily)
      ? "; rerun with model: opus to use Opus 5.5 meanwhile."
      : limited.family ? "; rerun with model set to a different available Claude family meanwhile." : ".";
    return tagMessage("worker-lifecycle.engine-infra-deny", `${familyName} usage limit until ${reset}${fallback} Route this package to another agent type, or name ${name} to retry.`);
  }
  const engine = engineForAgentType(agentType);
  if (!engine || new RegExp(String.raw`\b(?:${engine}|${engineDisplayName(engine)})\b`, "i").test(userText ?? "")) {
    return null;
  }
  const mode = dispatchRecord
    ? dispatchRecord.mode === "write" || (!dispatchRecord.mode && dispatchRecord.packageType === "implementation") ? "write" : "consult"
    : fallbackPackageType(agentType, prompt) === "implementation" ? "write" : "consult";
  const records = readEngineHealthRecords(env, now);
  const pool = dispatchRecord ? dispatchRecord.peerBillingPool ?? dispatchRecord.billingPool ?? null : dispatchEngineChoice(engine, prompt, env, records).pool;
  const health = engineHealth(engine, mode, pool, { env, now, sessionId, records });
  if (health.healthy) return null;
  if (health.blockers.length > 0) {
    return tagMessage("worker-lifecycle.engine-infra-deny", `${engineDisplayName(engine)} ${mode} runs are blocked on this host: ${health.blockers.map((blocker) => `${blocker.kind}: ${blocker.message}`).join("; ")} Route this package to another eligible lane, or name the engine to retry.`);
  }
  const elapsedMs = now - health.failures[0].timestamp;
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  const remainingMinutes = Math.ceil((health.until - now) / 60_000);
  return tagMessage("worker-lifecycle.engine-infra-deny", `${engineDisplayName(engine)} failed with failure: ${health.reason} ${elapsedMinutes} minutes ago in this session. Route this package to another eligible lane. It reopens after ${remainingMinutes} minutes or after you name the engine in a message.`);
}

function injectedPeerDefaults(prompt, agentType, env) {
  if (typeof prompt !== "string") {
    return null;
  }
  const { options, brief, separated } = leadingCompanionOptions(prompt);
  const header = brief.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  const roleField = new RegExp(`(?:^|[|·,;]\\s*)(?:${ENGINE_ID_ALTERNATION})-role:`, "i");
  if (!/^lane:/i.test(header) && !roleField.test(header)) {
    return null;
  }
  const engine = engineForAgentType(agentType);
  const role = engineRoleFromBrief(engine, brief);
  if (role === null) {
    return null;
  }
  const defaults = readRoutingDefaults(env, { warn: null });
  if (!routedEngineIds(defaults.breadth).includes(engine)) {
    return null;
  }
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
    const matched = model !== null && model !== choice.model ? Object.values(defaults[engine]).find((entry) => entry.model === model) : null;
    filled.push("--effort", matched?.effort ?? choice.effort);
  }
  const pacing = codexPacingAdvisory(prompt, agentType, env);
  const prepaidAlternative = model === null && choice.costClass === "metered" &&
    (readModelRoutingFile(resolveModelRoutingPath(env), { env }).data?.models ?? []).some((row) =>
      row.lane === engine && row.id !== choice.model && ["free", "included"].includes(row.costClass) &&
      (role !== "diversity" || !["claude", "anthropic", ENGINES.agy.family].includes(row.family)));
  if (filled.length === 0 && !pacing) {
    return null;
  }
  return {
    prompt: filled.length ? `${filled.join(" ")} ${separated ? prompt : `-- ${prompt}`}` : prompt,
    context: [
      filled.length ? tagMessage("worker-lifecycle.lane-default-injection", `Filled ${filled.join(" ")} from the routing table's ${lane} lane default.${prepaidAlternative ? ` ${choice.model} bills a metered pool; pass --model explicitly to keep using it, or pick a free or included model with /fusion:config.` : ""}`) : null,
      pacing ? tagMessage("worker-lifecycle.dispatch-advisory", pacing) : null
    ].filter(Boolean).join("\n\n")
  };
}

function dispatchCodexPacing(env) {
  const pools = quotaResults(env, { engines: ["codex"], timeoutMs: 800 })
    .filter((result) => result.engine === "codex" && result.available)
    .flatMap((result) => result.pools)
    .filter((pool) => pool.pool === "codex" && Number.isFinite(pool.pacing));
  return pools.length ? Math.max(...pools.map((pool) => pool.pacing)) : null;
}

function codexPacingAdvisory(prompt, agentType, env) {
  if (engineForAgentType(agentType) !== "codex" || typeof prompt !== "string") return null;
  const { brief } = leadingCompanionOptions(prompt);
  const sizing = engineRoleFromBrief("codex", brief);
  if (!["quick", "volume"].includes(sizing)) return null;
  const defaults = readRoutingDefaults(env, { warn: null });
  const breadth = defaults.breadth;
  const burst = defaults[breadth].burst;
  if (!["free", "included"].includes(burst.costClass) || !engineHealth(breadth, "write", burst.pool, { env }).healthy) return null;
  const pacing = dispatchCodexPacing(env);
  if (!(pacing > 1.15)) return null;
  return `Codex is over pace (pacing ${pacing.toFixed(1)}); this ${sizing} package fits the ${breadth} burst lane on its prepaid pool. Prefer ${breadth}-role: burst unless the package needs Codex.`;
}

function prestagePeerPrompt(input, env) {
  if (!["Agent", "Task"].includes(input.tool_name) || !input.tool_use_id) {
    return null;
  }
  const prompt = promptText(input.tool_input);
  const { options, brief, separated } = leadingCompanionOptions(prompt);
  const engine = engineForAgentType(input.tool_input?.subagent_type);
  const role = engineRoleFromBrief(engine, separated ? brief : prompt);
  const header = (separated ? brief : prompt).split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  const review = /(?:^|[|·,;]\s*)operation\s*:\s*review(?![\w-])/i.test(header);
  const mode = review ? "read-only"
    : options.includes("--write") ? "write"
    : (separated && /\bread[ -]only\b|\bconsult\b/i.test(header)) || ENGINES[engine]?.consultOnlyRoles.includes(role) ? "read-only" : null;
  if (!mode) {
    return null;
  }
  let companion;
  let transport;
  let output = "";
  const companionEnv = { ...env, CLAUDE_CODE_SESSION_ID: input.session_id };
  try {
    companion = newestEngineCompanion(engine, env);
    if (!companion) {
      return null;
    }
    const result = spawnSync(process.execPath, [companion, "transport-create"], { env: companionEnv, encoding: "utf8", timeout: 3000 });
    output = result.stdout ?? "";
    transport = JSON.parse(output);
    if (result.error || result.status !== 0 || typeof transport?.token !== "string" || !/^[a-f0-9]{48}$/.test(transport.token) || typeof transport.file !== "string" || !path.isAbsolute(transport.file)) {
      throw new Error("Invalid transport creation result.");
    }
    fs.writeFileSync(transport.file, prompt, "utf8");
    const stagedPrompt = `fusion-staged-token: ${transport.token}\nmode: ${mode}${review && ["devin", "cursor", "agy"].includes(engine) ? "\noperation: review" : ""}`;
    withPeerCapacityReservations(env, (reservations) => {
      const reservation = reservations.find((entry) => entry.key === peerReservationKey(input));
      if (!reservation) {
        throw new Error("Missing peer capacity reservation.");
      }
      reservation.originalPrompt = prompt;
    });
    return stagedPrompt;
  } catch {
    try {
      const token = typeof transport?.token === "string" && /^[a-f0-9]{48}$/.test(transport.token) ? transport.token
        : typeof transport?.file === "string" ? path.basename(path.dirname(transport.file)).match(/-companion-input-([a-f0-9]{48})$/)?.[1]
        : output.match(/"token"\s*:\s*"([a-f0-9]{48})"/)?.[1];
      if (companion && token) {
        spawnSync(process.execPath, [companion, "transport-discard", "--raw-args-token", token], { env: companionEnv, encoding: "utf8", timeout: 3000 });
      }
    } catch {}
    return null;
  }
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

function livePeerReservations(reservations, env, now) {
  return reservations.filter((reservation) => PEER_RESCUE_AGENT_NAMES.has(reservation.agentType)
    && Number.isFinite(reservation.at) && reservation.at <= now
    && now - reservation.at <= workerLimits(reservation.agentType, env).wallClockMs);
}

function hostPeerCapacityDenial(env, now = Date.now(), totalMemoryBytes = os.totalmem(), reservations = readPeerCapacityReservations(env)) {
  const capacity = hostPeerCapacity(totalMemoryBytes);
  const liveReservations = livePeerReservations(reservations, env, now);
  const inFlight = liveReservations.length + readWorkerRecords(env, { strict: true, modifiedSinceMs: now - workerLimits(ENGINES.codex.rescueAgent, env).wallClockMs }).filter((record) => {
    if (!PEER_RESCUE_AGENT_NAMES.has(record.agentType) || WORKER_TERMINAL_STATUSES.has(record.transportStatus)) {
      return false;
    }
    if (liveReservations.some((reservation) => reservation.taskId === record.taskId
      || typeof reservation.toolUseId === "string" && reservation.sessionId === record.sessionId && reservation.toolUseId === record.dispatchToolUseId)) {
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

function peerReservationKey(input) {
  return JSON.stringify([input.session_id, input.tool_use_id ?? `${input.tool_name}:${input.tool_input?.to ?? input.tool_input?.subagent_type}:${companionCwd(input, input.tool_input?.message ?? promptText(input.tool_input))}`]);
}

function companionCwd(input, prompt = promptText(input.tool_input), fallback = input.cwd) {
  const configured = optionValue(leadingCompanionOptions(prompt).options, "--cwd");
  const base = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const cwd = path.resolve(base, configured ?? fallback ?? base);
  try {
    return fs.realpathSync(cwd);
  } catch {
    return cwd;
  }
}

function reserveHostPeerCapacity(input, agentType, env, taskId = null, now = Date.now(), totalMemoryBytes = os.totalmem()) {
  return withPeerCapacityReservations(env, (reservations) => {
    const live = livePeerReservations(reservations, env, now);
    reservations.splice(0, reservations.length, ...live);
    const key = peerReservationKey(input);
    if (reservations.some((reservation) => reservation.key === key) && (input.tool_use_id || engineForAgentType(agentType) !== "codex")) {
      return null;
    }
    const previous = taskId ? readWorkerRecord(taskId, env) : null;
    const cwd = companionCwd(input, input.tool_input?.message ?? promptText(input.tool_input), previous?.companionCwd ?? previous?.workspaceRoot ?? input.cwd);
    if (engineForAgentType(agentType) === "codex") {
      const held = reservations.some((reservation) => engineForAgentType(reservation.agentType) === "codex" && (taskId === null || reservation.taskId !== taskId) && reservation.companionCwd === cwd)
        || readWorkerRecords(env, { strict: true, modifiedSinceMs: now - workerLimits(ENGINES.codex.rescueAgent, env).wallClockMs }).some((record) => PEER_RESCUE_AGENT_NAMES.has(record.agentType) && engineForAgentType(record.agentType) === "codex" && record.taskId !== taskId && !WORKER_TERMINAL_STATUSES.has(record.transportStatus) && companionCwd({ cwd: record.companionCwd ?? record.workspaceRoot }) === cwd);
      if (held) {
        return tagMessage("worker-lifecycle.workspace-slot-deny", `Codex already has a wrapper running in ${cwd}. Use an isolated worktree with --cwd, or wait for that wrapper to finish.`);
      }
    }
    const denial = hostPeerCapacityDenial(env, now, totalMemoryBytes, reservations);
    if (!denial) {
      reservations.push({ key, sessionId: input.session_id, toolUseId: input.tool_use_id ?? null, taskId, agentType, companionCwd: cwd, at: now });
    }
    return denial;
  });
}

function releaseHostPeerCapacity(input, env) {
  return withPeerCapacityReservations(env, (reservations) => {
    const key = peerReservationKey(input);
    const index = reservations.findIndex((reservation) => reservation.key === key);
    if (index !== -1) {
      reservations.splice(index, 1);
    }
  });
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
  const fallbackWorker = ["fusion:claude-worker", "fusion:trivial-worker"].includes(canonical);
  const fallbackReasons = ["network", "toolchain", "long-build", "claude-surface", "privacy", "no-healthy-lane"];
  const envelopeLines = briefEnvelope(prompt);
  const envelope = envelopeLines.join("\n");
  const fallbackLines = envelopeLines.filter((line) => /^claude-fallback:/.test(line));
  const fallbackReason = fallbackWorker && fallbackLines.length === 1 ? fallbackLines[0].match(/^claude-fallback:\s*([^\s]+)\s*$/)?.[1] : null;
  const maximumBytes = DEFAULT_BRIEF_MAX_BYTES;
  if (Buffer.byteLength(prompt) > maximumBytes) {
    return { ok: false, reason: `Fusion worker brief exceeds ${maximumBytes} bytes; reduce it to the minimal self-contained task context.` };
  }
  const firstLine = envelopeLines[0];
  const required = [
    [firstLine === "fusion-brief: v1", "fusion-brief: v1 (first line)"],
    [/^context-mode:\s*isolated\s*$/im, "context-mode: isolated"],
    [/^goal:\s*\S/im, "goal:"],
    [/^scope:\s*\S/im, "scope:"]
  ];
  const missing = required.filter(([check]) => typeof check === "boolean" ? !check : !check.test(envelope)).map(([, label]) => label);
  if (!/^(?:verification|acceptance):\s*\S/im.test(envelope)) missing.push("verification: or acceptance:");
  if (fallbackWorker && fallbackLines.length === 0) missing.push(`claude-fallback: (${fallbackReasons.join(", ")})`);
  if (fallbackWorker && fallbackLines.length > 0 && !fallbackReasons.includes(fallbackReason)) {
    return { ok: false, reason: `Fusion worker brief requires exactly one \`claude-fallback:\` line with one of: ${fallbackReasons.join(", ")}. Copy this example and choose the reason:\n\nclaude-fallback: claude-surface` };
  }
  if (missing.length) {
    return { ok: false, reason: `Fusion worker brief is missing required lines: ${missing.join(", ")}. Copy this envelope and fill each value:\n\nfusion-brief: v1\ncontext-mode: isolated\ngoal: <task goal>\nscope: <files or boundaries>\nverification: <check or acceptance criterion>${fallbackWorker ? "\nclaude-fallback: claude-surface" : ""}` };
  }

  if (/\b(?:the conversation above|all previous messages|full parent transcript|inherit(?:ed)? conversation)\b/i.test(prompt)) {
    return { ok: false, reason: "Fusion workers receive a minimal isolated brief, not the parent conversation or transcript." };
  }
  if (/^fusion-task-id:\s*/im.test(envelope)) {
    return { ok: false, reason: "`fusion-task-id` is reserved for the lifecycle guard." };
  }
  const packageTypeLines = envelopeLines.filter((line) => /^package-type:/.test(line));
  if (packageTypeLines.length > 1) {
    return { ok: false, reason: "Fusion worker brief `package-type:` may appear once and must be one of `implementation`, `consult`, `review`, `research`, or `design`." };
  }
  const packageType = packageTypeLines.length === 1
    ? packageTypeLines[0].match(/^package-type\s*:\s*(implementation|consult|review|research|design)\s*$/i)?.[1]?.toLowerCase()
    : /^verification:\s*\S/im.test(envelope) ? "implementation" : "consult";
  if (!packageType) {
    return { ok: false, reason: "Fusion worker brief `package-type:` must be one of `implementation`, `consult`, `review`, `research`, or `design`." };
  }
  if (fallbackReason === "no-healthy-lane") {
    const now = Date.now();
    const records = readEngineHealthRecords(env, now);
    const defaults = readRoutingDefaults(env, { warn: null });
    const mode = packageType === "implementation" ? "write" : "consult";
    const healthy = routedEngineIds(defaults.breadth).filter((engine) => engineCliAvailable(engine, env) &&
      (engine === "codex" ? ["flagship", "quick"] : ["burst"]).some((role) => {
        const choice = defaults[engine]?.[role];
        return choice && !ENGINES[engine].consultOnlyRoles.includes(role) && engineHealth(engine, mode, choice.pool, { env, now, records }).healthy;
      }));
    if (healthy.length) {
      return { ok: false, reason: `Fusion worker brief claude-fallback: no-healthy-lane requires every implementation peer lane to be unhealthy for ${mode} mode. Healthy lanes: ${healthy.join(", ")}. Route this package to a healthy lane.` };
    }
  }
  const sizingLines = envelopeLines.filter((line) => /^sizing:/.test(line));
  if (sizingLines.length > 1) {
    return { ok: false, reason: "Fusion worker brief `sizing:` may appear once and must be one of `small`, `standard`, or `large`." };
  }
  if (sizingLines.length === 1) {
    const sizing = sizingLines[0].match(/^sizing\s*:\s*(small|standard|large)\s*$/i)?.[1]?.toLowerCase();
    if (!sizing) {
      return { ok: false, reason: "Fusion worker brief `sizing:` must be one of `small`, `standard`, or `large`." };
    }
    const briefBytes = Buffer.byteLength(prompt);
    return { ok: true, sizing, packageType, briefBytes, ...(fallbackReason ? { fallbackReason } : {}), advisories: briefAdvisories(prompt, briefBytes, true, env) };
  }
  const briefBytes = Buffer.byteLength(prompt);
  return { ok: true, packageType, briefBytes, ...(fallbackReason ? { fallbackReason } : {}), advisories: briefAdvisories(prompt, briefBytes, false, env) };
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

function latestUserText(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    return null;
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
    return null;
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
      return userText;
    }
  }
  return null;
}

function latestUserRequestedBackground(transcriptPath) {
  return /(?:^|\s)--background(?:\s|$)/.test(latestUserText(transcriptPath) ?? "");
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
  if (/^mode:\s*write\s*$/im.test(prompt)) return "implementation";
  const { brief } = leadingCompanionOptions(prompt);
  if (/^mode:\s*(?:consult|review|read[ -]only)\s*$/im.test(brief) || /\bread[ -]only\b|\bconsult\b/i.test(brief.split(/\r?\n/, 1)[0])) return "consult";
  if (engineRoleFromBrief(engineForAgentType(agentType), brief) === "burst") return "implementation";
  return /^verification:\s*\S/im.test(prompt) ? "implementation" : "consult";
}

function createDispatch(input, agentType, userBackgroundAuthorized, env, validation = {}) {
  const taskId = createWorkerTaskId(input.session_id, input.tool_use_id);
  const reservation = PEER_RESCUE_AGENT_NAMES.has(agentType)
    ? readPeerCapacityReservations(env).find((entry) => entry.key === peerReservationKey(input) && entry.agentType === agentType)
    : null;
  const prompt = typeof reservation?.originalPrompt === "string" ? reservation.originalPrompt : promptText(input.tool_input);
  const peerChoice = PEER_RESCUE_AGENT_NAMES.has(agentType) ? dispatchEngineChoice(engineForAgentType(agentType), prompt, env) : null;
  const packageType = validation.packageType ?? fallbackPackageType(agentType, prompt);
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
    requestedModel: peerChoice ? peerChoice.model : input.tool_input?.model,
    ...(peerChoice ? { mode: packageType === "implementation" ? "write" : "consult", billingPool: peerChoice.pool } : {}),
    description: safeDescription(input.tool_input?.description),
    workspaceRoot: input.cwd,
    ...(PEER_RESCUE_AGENT_NAMES.has(agentType) ? { companionCwd: companionCwd(input, prompt) } : {}),
    expectedDelivery: userBackgroundAuthorized ? "manual-background" : "foreground",
    userBackgroundAuthorized,
    parentTranscriptPath: typeof input.transcript_path === "string" ? input.transcript_path : null,
    parentTranscriptBytesAtDispatch,
    parentContextTokensAtDispatch: parentContextTokens(input.transcript_path),
    packageType,
    briefBytes: validation.briefBytes ?? null,
    fallbackReason: validation.fallbackReason ?? null,
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
  return claimed.length ? tagMessage("fleet-posture.context-advisory", `The main loop context is ${Math.round(tokens / 1000)}k tokens and every turn replays it. /compact or a fresh session before the next goal cuts that cost.`) : null;
}

function briefArtifactPath(record, env) {
  return path.join(path.dirname(workerRecordFile(record.taskId, env)), `${record.taskId}.brief.txt`);
}


export { allowAgentWithTaskId, promptText, leadingCompanionOptions, optionValue, engineInfraDenial, injectedPeerDefaults, codexPacingAdvisory, prestagePeerPrompt, parentContextAdvisoryTokens, parentContextTokens, hostPeerCapacity, hostPeerCapacityDenial, reserveHostPeerCapacity, releaseHostPeerCapacity, verificationManifestPath, globToRegExp, readVerificationManifest, pathsNamedInBrief, missingVerificationSuites, briefAdvisories, validateWorkerBrief, externalUserText, latestUserText, latestUserRequestedBackground, safeDescription, completionContract, collectorRequestIdentity, createDispatch, claimParentContextAdvisory, briefArtifactPath };
