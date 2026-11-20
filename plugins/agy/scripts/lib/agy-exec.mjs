import { spawnSync } from "node:child_process";
import path from "node:path";
import { browserBlockerDir } from "./agy-home.mjs";
import { isReadOnlyCommand } from "./agy-command-check.mjs";
import { createSelectionResolver } from "./agy-models.mjs";
import { clearRunTimers, createProcessTransport, destroyRunStreams, executablePath, inheritChildEnv, runProcess, settleRun as settleProcessRun } from "./process-run.mjs";

export const TESTED_AGY_INTERVAL = { floor: "1.5", ceiling: "1.6" };
export const OPERATING_LIMITS_NOTE = "Operating limits: read files with your file tools. A shell command is allowed only when it is a single read only program (ls, pwd, cat, head, tail, wc, stat, grep, rg, find, or git status, log, show, diff, ls-files, grep, blame, rev-parse, or branch) with no pipes, redirection, variables, or chained commands; any other command or tool request is refused and ends your turn.";

const READ_TOOLS = ["read_file", "search_web", "run_command"];
const WRITE_TOOLS = [...READ_TOOLS, "edit_file", "write_file"];
const STREAM_MAX_BYTES = 2 * 1024 * 1024;
const { appendTail, signalRunGroup, terminateRun: terminateProcessRun, finishProcessGroup, startProcess } = createProcessTransport({
  processLine: processAgyLine,
  streamLength: Buffer.byteLength,
  preserveStderrUtf8: true,
  onStreamOverflow: (run) => failProtocol(run, "Stream line exceeds size limit")
});

export function resolveAgyBin(env = process.env) {
  return env.AGY_BIN?.trim() || "agy";
}

export function probeAgyVersion(bin, env = process.env) {
  const buildPath = executablePath(bin, env, "Antigravity");
  const result = spawnSync(buildPath, ["--version"], { env: buildAgyChildEnv({ env }), encoding: "utf8", timeout: 60000 });
  const output = String(result.stdout || "").trim();
  const version = output.match(/^(\d+\.\d+\.\d+)$/)?.[1];
  if (result.error || result.status !== 0 || !version) {
    const error = new Error(`Antigravity CLI version probe failed: ${result.error?.message || result.stderr?.trim() || output}`);
    error.failureKind = ["ENOENT", "EACCES", "ENOEXEC"].includes(result.error?.code) ? "missing_cli" : "setup";
    throw error;
  }
  return { version, buildPath };
}

export function compareAgyVersion(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function toolsForMode(mode) {
  if (mode === "consult" || mode === "review") return [...READ_TOOLS];
  if (mode === "write") return [...WRITE_TOOLS];
  throw new Error(`Invalid Antigravity mode: ${mode}`);
}

const CREDENTIAL_FIELD = /(--[\w-]*(?:token|key|secret|password|auth|bearer|authorization)[\w-]*[ \t]*(?:[=:][ \t]*|[ \t]+)|[\w-]*(?:token|key|secret|password|auth|bearer|authorization)[\w-]*[ \t]*[=:][ \t]*|bearer[ \t]+)((?:bearer|basic|digest|negotiate|oauth|token)[ \t]+)?("[^"]*"|'[^']*'|[^\s'"]+)/gi;

export function redactCredentialValue(value) {
  return String(value)
    .replace(CREDENTIAL_FIELD, "$1$2[redacted]")
    .replace(/[A-Za-z0-9+/_=-]{24,}/g, "[redacted]");
}

let resolvedDeveloperDir;

function developerDir(platform) {
  if (platform !== "darwin") return null;
  if (resolvedDeveloperDir === undefined) {
    const result = spawnSync("xcode-select", ["-p"], { encoding: "utf8", timeout: 5000 });
    resolvedDeveloperDir = result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
  }
  return resolvedDeveloperDir;
}

export function buildAgyChildEnv({ env = process.env, platform = process.platform } = {}) {
  const childEnv = inheritChildEnv(env, ["HOME", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]);
  const developer = childEnv.DEVELOPER_DIR || developerDir(platform);
  return developer ? { ...childEnv, DEVELOPER_DIR: developer } : childEnv;
}

function releaseRequests(run) {
  for (const request of run.pending.values()) request.resolve(undefined);
  run.pending.clear();
}

function settleRun(run) {
  settleProcessRun(run, releaseRequests);
}

function finishRun(run) {
  if (run.ending || run.settled) return;
  run.ending = true;
  clearTimeout(run.runTimer);
  releaseRequests(run);
  run.child.stdin.end();
  if (!run.exited && !run.closed) run.exitTimer = setTimeout(() => handleExitGrace(run), run.options.exitGraceMs);
}

function terminateRun(run) {
  terminateProcessRun(run, () => {
    run.drainTimer ??= setTimeout(() => drainRun(run), run.options.killGraceMs);
  });
}

function writeMessage(run, message) {
  if (run.settled || run.child.stdin.destroyed || run.child.stdin.writableEnded) return;
  run.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function cancelRun(run) {
  if (run.outcome.sessionId) writeMessage(run, { method: "session/cancel", params: { sessionId: run.outcome.sessionId } });
  finishRun(run);
  terminateRun(run);
}

function abortRun(run) {
  if (run.settled || run.closed) return;
  run.outcome.cancelled = true;
  cancelRun(run);
}

function failProtocol(run, message) {
  run.outcome.protocolError ??= message;
  finishRun(run);
}

function failSetup(run, message) {
  run.outcome.setupError ??= message;
  finishRun(run);
}

function requestAgy(run, method, params) {
  if (run.ending || run.closed || run.settled) return Promise.resolve(undefined);
  const id = run.nextId++;
  return new Promise((resolve) => {
    run.pending.set(id, { method, resolve });
    if (method === "session/prompt") run.promptSent = true;
    writeMessage(run, { id, method, params });
  });
}

async function applyOption(run, { configId, value }) {
  const result = await requestAgy(run, "session/set_config_option", { sessionId: run.outcome.sessionId, configId, value });
  if (run.ending || run.closed || run.settled) return;
  const options = result?.configOptions;
  if (!Array.isArray(options) || !Object.entries({ ...run.outcome.appliedOptions, [configId]: value }).every(([id, selected]) => options.some((option) => option?.id === id && option.currentValue === selected))) {
    failSetup(run, `Antigravity did not apply config option '${configId}' with value '${value}'`);
    return;
  }
  run.configOptions = options;
  run.outcome.appliedOptions[configId] = value;
}

async function configureSession(run) {
  const modeId = run.options.mode === "write" ? "accept-edits" : "default";
  await requestAgy(run, "session/set_mode", { sessionId: run.outcome.sessionId, modeId });
  if (run.ending || run.closed || run.settled) return;
  run.outcome.appliedOptions.mode = modeId;
  if (!run.options.resolveSelection) return;
  for (const stage of ["model", "effort"]) {
    if (run.ending || run.closed || run.settled) return;
    let selection;
    try {
      selection = await run.options.resolveSelection({ stage, configOptions: run.configOptions });
      if (!Array.isArray(selection)) throw new Error("Antigravity selection must return config option pairs");
    } catch (error) {
      if (run.ending || run.closed || run.settled) return;
      run.outcome.selectionError = { failureKind: error.failureKind === "input" ? "input" : "setup", message: error.message };
      finishRun(run);
      return;
    }
    for (const option of selection) {
      if (run.ending || run.closed || run.settled) return;
      await applyOption(run, option);
    }
  }
}

async function initializeSession(run) {
  const { cwd, brief, resumeSessionId } = run.options;
  const initialized = await requestAgy(run, "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  if (run.ending || run.closed || run.settled) return;
  if (initialized?.protocolVersion !== 1) {
    failSetup(run, "Antigravity must support ACP protocol version 1");
    return;
  }
  run.outcome.agentVersion = initialized.agentInfo?.version ?? null;
  const session = await requestAgy(run, resumeSessionId ? "session/load" : "session/new", { ...(resumeSessionId ? { sessionId: resumeSessionId } : {}), cwd, mcpServers: [] });
  if (run.ending || run.closed || run.settled) return;
  const sessionId = session?.sessionId;
  if (!session || typeof sessionId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sessionId) || resumeSessionId && sessionId !== resumeSessionId) {
    failProtocol(run, "Missing sessionId in session response");
    return;
  }
  run.outcome.sessionId = sessionId;
  run.configOptions = session.configOptions;
  if (run.options.sessionOnly) {
    run.outcome.sessionReady = true;
    run.outcome.configOptions = session.configOptions;
    finishRun(run);
    return;
  }
  await configureSession(run);
  run.outcome.resolvedEffort = run.configOptions?.find((option) => option?.id === "thought_level")?.currentValue ?? null;
  await requestAgy(run, "session/prompt", { sessionId: run.outcome.sessionId, prompt: [{ type: "text", text: `${OPERATING_LIMITS_NOTE}\n\n${brief ?? ""}` }] });
}

function processToolUpdate(run, update) {
  const id = update.toolCallId;
  const previous = run.tools.get(id);
  const tool = update.name ?? previous?.name;
  const rawInput = { ...previous?.rawInput, ...update.rawInput };
  if (typeof id !== "string" || !id || typeof tool !== "string" || !tool) {
    failProtocol(run, "Tool call missing tool name or id");
    return;
  }
  if (!run.tools.has(id)) run.outcome.toolCalls += 1;
  run.tools.set(id, { name: tool, rawInput, status: update.status ?? previous?.status });
  if (!run.allowedTools.includes(tool) || tool === "run_command" && rawInput.BypassSandbox === true && (update.status ?? previous?.status) === "completed") {
    run.outcome.policyViolation ??= { tool, bypassSandbox: rawInput.BypassSandbox === true };
    finishRun(run);
    terminateRun(run);
  }
}

function processNotification(run, event) {
  const { outcome } = run;
  if (event.method === "session/update") {
    const update = event.params?.update;
    if (update?.sessionUpdate === "agent_message_chunk" && run.promptSent && update.content?.type === "text" && typeof update.content.text === "string") {
      outcome.resultText += update.content.text;
    } else if (["tool_call", "tool_call_update"].includes(update?.sessionUpdate)) {
      processToolUpdate(run, update);
    }
  }
}

function processResponse(run, event) {
  const request = run.pending.get(event.id);
  if (!request) {
    failProtocol(run, "Response for unknown request id");
    return;
  }
  if (Object.hasOwn(event, "result") === Object.hasOwn(event, "error")) {
    failProtocol(run, "Malformed JSON-RPC response");
    return;
  }
  if (Object.hasOwn(event, "error")) {
    if (typeof event.error?.code !== "number" || typeof event.error?.message !== "string") {
      failProtocol(run, "Malformed JSON-RPC error");
      return;
    }
    run.outcome.rpcError = { method: request.method, code: event.error.code, message: event.error.message, ...(Object.hasOwn(event.error, "data") ? { data: event.error.data } : {}) };
    if (["session/set_config_option", "session/set_mode"].includes(request.method) && event.error.code === -32602) run.outcome.setupError = String(event.error.data ?? event.error.message);
    finishRun(run);
    return;
  }
  run.pending.delete(event.id);
  request.resolve(event.result);
  if (request.method === "session/prompt") {
    if (typeof event.result?.stopReason !== "string") {
      failProtocol(run, "Missing stopReason in prompt result");
      return;
    }
    run.outcome.resultSeen = true;
    run.outcome.stopReason = event.result.stopReason;
    run.outcome.usage = event.result.usage ?? null;
    finishRun(run);
  }
}

function permissionOutcome(run, params) {
  const tool = params?.toolCall;
  const allowed = tool?.name === "run_command" && (tool.rawInput?.BypassSandbox === undefined || tool.rawInput.BypassSandbox === false)
    && isReadOnlyCommand(tool.rawInput?.CommandLine);
  const options = Array.isArray(params?.options) ? params.options : [];
  const option = allowed ? options.find((entry) => entry?.kind === "allow_once" && typeof entry.optionId === "string") : null;
  const selected = option ?? options.find((entry) => entry?.kind === "reject_once" && typeof entry.optionId === "string");
  if (option) run.outcome.permissionsAllowed += 1;
  else {
    run.outcome.permissionsRejected += 1;
    if (run.outcome.refusedPermissions.length < 5) {
      const command = tool?.rawInput?.CommandLine;
      run.outcome.refusedPermissions.push({ tool: typeof tool?.name === "string" ? tool.name : null, command: typeof command === "string" ? redactCredentialValue(command).slice(0, 200) : null });
    }
  }
  return { outcome: selected ? { outcome: "selected", optionId: selected.optionId } : { outcome: "cancelled" } };
}

function processAgyLine(run, line) {
  if (!line.trim()) return;
  if (Buffer.byteLength(line) > STREAM_MAX_BYTES) {
    failProtocol(run, "Stream line exceeds size limit");
    return;
  }
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    failProtocol(run, "Malformed stream line");
    return;
  }
  if (!event || typeof event !== "object" || Array.isArray(event) || event.jsonrpc !== "2.0") {
    failProtocol(run, "Malformed JSON-RPC event");
    return;
  }
  if (typeof event.method === "string") {
    if (Object.hasOwn(event, "id")) {
      writeMessage(run, event.method === "session/request_permission"
        ? { id: event.id, result: permissionOutcome(run, event.params) }
        : { id: event.id, error: { code: -32601, message: "Method not found" } });
    } else {
      processNotification(run, event);
    }
  } else if (Object.hasOwn(event, "id")) {
    processResponse(run, event);
  } else {
    failProtocol(run, "Malformed JSON-RPC event");
  }
}

function finishStream(run) {
  if (run.stdoutRemainder.trim()) processAgyLine(run, run.stdoutRemainder);
  run.stdoutRemainder = "";
  if (!run.outcome.resultSeen && !run.ending) run.outcome.protocolError ??= "Exit before prompt result";
}

function drainRun(run) {
  if (run.settled || run.draining) return;
  run.draining = true;
  finishStream(run);
  destroyRunStreams(run);
  signalRunGroup(run, "SIGKILL");
  settleRun(run);
}

function handleExitGrace(run) {
  if (!run.exited && !run.closed) {
    run.outcome.lateClose = true;
    terminateRun(run);
  }
}

function handleChildExit(run, code, signal) {
  run.exited = true;
  run.outcome.exitCode = code;
  run.outcome.signal = signal;
  clearTimeout(run.runTimer);
  clearTimeout(run.exitTimer);
  signalRunGroup(run, "SIGTERM");
  run.drainTimer ??= setTimeout(() => drainRun(run), run.options.killGraceMs);
}

async function handleChildClose(run, code, signal) {
  if (run.settled || run.draining) return;
  run.closed = true;
  clearRunTimers(run);
  run.outcome.exitCode = code;
  run.outcome.signal = signal;
  finishStream(run);
  await finishProcessGroup(run);
  settleRun(run);
}

function handleRunTimeout(run) {
  if (run.closed || run.exited || run.ending) return;
  run.outcome.timedOut = true;
  cancelRun(run);
}

function startAgyRun(run, resolve) {
  const { timeoutMs, exitGraceMs, killGraceMs, signal, onSpawn } = run.options;
  const args = ["acp", "--disable-telemetry", "--include-default-customizations=false", "--sandbox", "--gemini-dir", run.options.geminiDir, "--app-data-dir", "agy"];
  if (!startProcess(run, resolve, args, {
    launchError(run, error, spawned) {
      if (spawned?.pid) {
        spawned.stdin.destroy();
        try { process.kill(-spawned.pid, "SIGKILL"); } catch {}
      }
      run.outcome.spawnError = error;
      run.outcome.stderrTail = appendTail("", error.message);
      settleRun(run);
    },
    stdinError(run) {
      if (!run.ending) failProtocol(run, "Failed to write ACP request");
    },
    error: finishRun,
    exit: handleChildExit,
    close: handleChildClose,
    spawn(run) {
      try { onSpawn?.(run.child); }
      catch (error) { failSetup(run, error.message); return; }
      initializeSession(run).catch((error) => {
        if (!run.ending && !run.settled) failSetup(run, error.message);
      });
    }
  })) return;
  run.deadlineTimer = setTimeout(() => {
    handleRunTimeout(run);
    drainRun(run);
  }, timeoutMs + exitGraceMs + 2 * killGraceMs);
  run.runTimer = setTimeout(() => handleRunTimeout(run), timeoutMs);
  signal?.addEventListener("abort", run.abort, { once: true });
  if (signal?.aborted) abortRun(run);
}

export function runAgy({ bin, cwd, env, brief, mode, version, geminiDir, sessionOnly = false, resumeSessionId, resolveSelection = createSelectionResolver({ preserveModel: Boolean(resumeSessionId) }), timeoutMs = 540000, exitGraceMs = 15000, killGraceMs = 5000, launchProcess, signal, onSpawn }) {
  const childEnv = geminiDir ? { ...env, PATH: [browserBlockerDir(geminiDir), env?.PATH].filter(Boolean).join(path.delimiter) } : env;
  return runProcess({ bin, cwd, env: childEnv, brief, mode, version, geminiDir, sessionOnly, resumeSessionId, resolveSelection, timeoutMs, exitGraceMs, killGraceMs, launchProcess, signal, onSpawn }, {
    outcome: {
      resultText: "", resolvedEffort: null, stopReason: null, appliedOptions: {}, rpcError: null,
      setupError: null, selectionError: null, toolCalls: 0, permissionsAllowed: 0, permissionsRejected: 0, refusedPermissions: []
    },
    state: {
      exited: false, ending: false, promptSent: false,
      nextId: 1, pending: new Map(), configOptions: [], tools: new Map(), allowedTools: toolsForMode(mode)
    },
    start: startAgyRun,
    abort: abortRun
  });
}

export function classifyAgyFailure(outcome) {
  const message = [outcome.stderrTail, outcome.rpcError?.message, JSON.stringify(outcome.rpcError?.data), outcome.rpcError?.code].filter((value) => value != null).join("\n");
  if (outcome.cancelled) return "cancelled";
  if (["ENOENT", "EACCES", "ENOEXEC"].includes(outcome.spawnError?.code)) return "missing_cli";
  if (outcome.selectionError) return outcome.selectionError.failureKind;
  if (outcome.policyViolation) return "policy";
  if (outcome.timedOut) return "timeout";
  if (outcome.setupError) return "setup";
  if (outcome.rpcError || !outcome.resultSeen && !outcome.sessionReady) {
    if (/language server.{0,80}(?:failed|failure|unable)|(?:failed|unable).{0,80}language server/i.test(message)) return "setup";
    if (/Authentication required|log in|sign in|not logged in|unauthorized|UNAUTHENTICATED|\b(?:401|403)\b/i.test(message)) return "auth";
    if (/quota|usage limit|weekly limit|credits?|\b402\b/i.test(message)) return "quota";
    if (/rate.?limit|too many requests|No capacity available|UNAVAILABLE|\b(?:429|503)\b/i.test(message)) return "rate_limited";
    if (!outcome.resultSeen && /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|DNS|fetch fail|connection (?:refused|reset)/i.test(message)) return "network";
  }
  if (outcome.signal && !outcome.lateClose && (!outcome.protocolError || outcome.protocolError === "Exit before prompt result")) return "process";
  if (outcome.protocolError) return "protocol";
  if (outcome.permissionsRejected > 0 && !outcome.resultText?.trim()) return "permission";
  if (!outcome.rpcError && (outcome.resultSeen && outcome.stopReason === "end_turn" || outcome.sessionReady)) return null;
  if (outcome.stopReason === "refusal") return "refused";
  if (!outcome.resultSeen && !outcome.rpcError) return "protocol";
  return "error";
}
