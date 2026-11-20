import { spawnSync } from "node:child_process";
import path from "node:path";
import { clearRunTimers, createProcessTransport, destroyRunStreams, executablePath, inheritChildEnv, runProcess, settleRun as settleProcessRun } from "./process-run.mjs";

export const TESTED_DEVIN_INTERVAL = { floor: "3000.11", ceiling: "3000.15" };

const READ_TOOLS = ["read", "grep", "glob", "find_file_by_name", "notebook_read", "todo_write", "web_search"];
const WRITE_TOOLS = [...READ_TOOLS, "edit", "write", "notebook_edit", "exec", "get_output", "kill_shell", "write_to_process"];
const STREAM_MAX_BYTES = 2 * 1024 * 1024;
const { appendTail, signalRunGroup, terminateRun: terminateProcessRun, finishProcessGroup, startProcess } = createProcessTransport({
  processLine: processDevinLine,
  streamLength: Buffer.byteLength,
  preserveStderrUtf8: true,
  onStreamOverflow: (run) => failProtocol(run, "Stream line exceeds size limit")
});

export function resolveDevinBin(env = process.env) {
  return env.DEVIN_BIN?.trim() || "devin";
}

export function probeDevinVersion(bin, env = process.env) {
  const buildPath = executablePath(bin, env, "Devin");
  const result = spawnSync(buildPath, ["--version"], { env, encoding: "utf8", timeout: 60000 });
  const output = String(result.stdout || "").trim();
  const version = output.match(/^devin (\d+(?:\.\d+)+) \([^\s()]+\)$/)?.[1];
  if (result.error || result.status !== 0 || !version) {
    const error = new Error(`Devin CLI version probe failed: ${result.error?.message || result.stderr?.trim() || output}`);
    error.failureKind = ["ENOENT", "EACCES", "ENOEXEC"].includes(result.error?.code) ? "missing_cli" : "setup";
    throw error;
  }
  return { version, buildPath };
}

export function compareDevinVersion(left, right) {
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
  throw new Error(`Invalid Devin mode: ${mode}`);
}

export function buildDevinChildEnv({ env = process.env, homeDir, configDir, mode }) {
  const childEnv = inheritChildEnv(env, ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]);
  childEnv.HOME = homeDir;
  childEnv.XDG_DATA_HOME = path.join(homeDir, ".local", "share");
  childEnv.XDG_STATE_HOME = path.join(homeDir, ".local", "state");
  childEnv.XDG_CACHE_HOME = path.join(homeDir, ".cache");
  childEnv.XDG_CONFIG_HOME = configDir;
  childEnv.RUST_LOG = "error";
  if (mode === "write") childEnv.DEVIN_SANDBOX = "true";
  return childEnv;
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

function requestDevin(run, method, params) {
  if (run.ending || run.closed || run.settled) return Promise.resolve(undefined);
  const id = run.nextId++;
  return new Promise((resolve) => {
    run.pending.set(id, { method, resolve });
    if (method === "session/prompt") run.promptSent = true;
    writeMessage(run, { id, method, params });
  });
}

async function applyOption(run, { configId, value }) {
  const result = await requestDevin(run, "session/set_config_option", { sessionId: run.outcome.sessionId, configId, value });
  if (run.ending || run.closed || run.settled) return;
  const options = result?.configOptions;
  if (!Array.isArray(options) || !options.some((option) => option?.id === configId && option.currentValue === value)) {
    failSetup(run, `Devin did not apply config option '${configId}' with value '${value}'`);
    return;
  }
  run.configOptions = options;
  run.outcome.appliedOptions[configId] = value;
}

async function configureSession(run) {
  await applyOption(run, { configId: "mode", value: run.options.mode === "write" ? "autonomous" : "ask" });
  if (!run.options.resolveSelection) return;
  for (const stage of ["model", "effort"]) {
    if (run.ending || run.closed || run.settled) return;
    let selection;
    try {
      selection = await run.options.resolveSelection({ stage, configOptions: run.configOptions });
      if (!Array.isArray(selection)) throw new Error("Devin selection must return config option pairs");
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
  const initialized = await requestDevin(run, "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  if (run.ending || run.closed || run.settled) return;
  if (initialized?.protocolVersion !== 1) {
    failSetup(run, "Devin must support ACP protocol version 1");
    return;
  }
  const session = await requestDevin(run, resumeSessionId ? "session/load" : "session/new", { ...(resumeSessionId ? { sessionId: resumeSessionId } : {}), cwd, mcpServers: [] });
  if (run.ending || run.closed || run.settled) return;
  const sessionId = resumeSessionId ?? session?.sessionId;
  if (!session || typeof sessionId !== "string" || !sessionId.trim()) {
    failProtocol(run, "Missing sessionId in session response");
    return;
  }
  run.outcome.sessionId = sessionId;
  run.configOptions = session.configOptions;
  await configureSession(run);
  run.outcome.resolvedEffort = run.configOptions?.find((option) => option?.id === "thought_level")?.currentValue ?? null;
  await requestDevin(run, "session/prompt", { sessionId: run.outcome.sessionId, prompt: [{ type: "text", text: brief ?? "" }] });
}

function processToolUpdate(run, update) {
  const id = update.toolCallId;
  const tool = update._meta?.["cognition.ai/inferenceToolName"] ?? run.tools.get(id);
  if (typeof id !== "string" || !id || typeof tool !== "string" || !tool) {
    failProtocol(run, "Tool call missing tool name or id");
    return;
  }
  if (!run.tools.has(id)) run.outcome.toolCalls += 1;
  run.tools.set(id, tool);
  if (tool !== "request_scope" && tool !== "mcp_list_servers" && !run.allowedTools.includes(tool)) {
    run.outcome.policyViolation ??= { tool };
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
  } else if (event.method === "_cognition.ai/agent_stopped") {
    outcome.stopCause = event.params?.cause ?? outcome.stopCause;
    outcome.observedModel = event.params?.stats?.modelLabel ?? outcome.observedModel;
    outcome.requestId = event.params?.stats?.requestId ?? outcome.requestId;
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
    if (request.method === "session/set_config_option" && event.error.code === -32602) run.outcome.setupError = String(event.error.data ?? event.error.message);
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

function processDevinLine(run, line) {
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
        ? { id: event.id, result: { outcome: { outcome: "cancelled" } } }
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
  if (run.stdoutRemainder.trim()) processDevinLine(run, run.stdoutRemainder);
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

function startDevinRun(run, resolve) {
  const { timeoutMs, exitGraceMs, killGraceMs, signal, onSpawn } = run.options;
  const args = ["acp", ...(run.options.version && compareDevinVersion(run.options.version, "3000.13") >= 0 ? ["--process-model", "in-process"] : [])];
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

export function runDevin({ bin, cwd, env, brief, mode, version, resumeSessionId, resolveSelection, timeoutMs = 540000, exitGraceMs = 15000, killGraceMs = 5000, launchProcess, signal, onSpawn }) {
  return runProcess({ bin, cwd, env, brief, mode, version, resumeSessionId, resolveSelection, timeoutMs, exitGraceMs, killGraceMs, launchProcess, signal, onSpawn }, {
    outcome: {
      resultText: "", resolvedEffort: null, stopReason: null, stopCause: null, appliedOptions: {}, rpcError: null,
      setupError: null, selectionError: null, toolCalls: 0
    },
    state: {
      exited: false, ending: false, promptSent: false,
      nextId: 1, pending: new Map(), configOptions: [], tools: new Map(), allowedTools: toolsForMode(mode)
    },
    start: startDevinRun,
    abort: abortRun
  });
}

export function classifyDevinFailure(outcome) {
  const message = [outcome.stderrTail, outcome.rpcError?.message, JSON.stringify(outcome.rpcError?.data), outcome.rpcError?.code].filter((value) => value != null).join("\n");
  if (outcome.cancelled) return "cancelled";
  if (["ENOENT", "EACCES", "ENOEXEC"].includes(outcome.spawnError?.code)) return "missing_cli";
  if (outcome.selectionError) return outcome.selectionError.failureKind;
  if (outcome.policyViolation) return "policy";
  if (outcome.timedOut) return "timeout";
  if (outcome.resultSeen && outcome.stopReason === "end_turn" && (outcome.stopCause == null || outcome.stopCause === "complete") && !outcome.rpcError && !outcome.setupError && !outcome.protocolError && (outcome.exitCode === 0 || outcome.lateClose)) return null;
  if (outcome.setupError || /sandbox.{0,80}(?:cannot|could not|unable|unavailable|failed|failure)|(?:cannot|could not|unable|failed|failure).{0,80}(?:sandbox|seatbelt|bubblewrap)|(?:seatbelt|bubblewrap).{0,80}(?:unavailable|failed|failure)/i.test(message)) return "setup";
  if (outcome.stopCause === "auth_required" || /log in|not logged in|unauthorized|\b(?:401|403)\b/i.test(message)) return "auth";
  if (/usage limit|quota|allowance|spend limit|insufficient credit|\b402\b/i.test(message)) return "quota";
  if (/rate.?limit|too many requests|\b429\b/i.test(message)) return "rate_limited";
  if (!outcome.resultSeen && /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|DNS|fetch fail/i.test(message)) return "network";
  if (outcome.stopCause === "tool_rejected") return "permission";
  if (outcome.stopReason === "refusal") return "refused";
  if (outcome.protocolError) return "protocol";
  if (outcome.signal && !outcome.lateClose) return "process";
  return "error";
}
