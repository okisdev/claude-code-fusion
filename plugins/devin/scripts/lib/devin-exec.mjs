import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const TESTED_DEVIN_INTERVAL = { floor: "3000.11", ceiling: "3000.12" };

const READ_TOOLS = ["read", "grep", "glob", "find_file_by_name", "notebook_read", "todo_write", "web_search"];
const WRITE_TOOLS = [...READ_TOOLS, "edit", "write", "notebook_edit", "exec", "get_output", "kill_shell", "write_to_process"];
const STDERR_MAX_BYTES = 64 * 1024;
const STREAM_MAX_BYTES = 2 * 1024 * 1024;

export function resolveDevinBin(env = process.env) {
  return env.DEVIN_BIN?.trim() || "devin";
}

function executablePath(bin, env) {
  const candidates = bin.includes(path.sep) ? [path.resolve(bin)] : String(env.PATH || "").split(path.delimiter).map((directory) => path.join(directory || ".", bin));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {}
  }
  const error = new Error(`Devin CLI executable not found: ${bin}`);
  error.failureKind = "missing_cli";
  throw error;
}

export function probeDevinVersion(bin, env = process.env) {
  const buildPath = executablePath(bin, env);
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
  const allowed = new Set(["PATH", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TMPDIR", "TZ", "USER", "LOGNAME", "SHELL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "JAVA_HOME", "GOROOT", "GOPATH", "CARGO_HOME", "RUSTUP_HOME", "PNPM_HOME", "BUN_INSTALL", "VOLTA_HOME", "MISE_DATA_DIR", "MISE_CONFIG_DIR", "MISE_CACHE_DIR", "ANDROID_HOME", "ANDROID_SDK_ROOT", "DEVELOPER_DIR", "SDKROOT"]);
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key) || key.startsWith("LC_")));
  childEnv.HOME = homeDir;
  childEnv.XDG_DATA_HOME = path.join(homeDir, ".local", "share");
  childEnv.XDG_STATE_HOME = path.join(homeDir, ".local", "state");
  childEnv.XDG_CACHE_HOME = path.join(homeDir, ".cache");
  childEnv.XDG_CONFIG_HOME = configDir;
  childEnv.RUST_LOG = "error";
  if (mode === "write") childEnv.DEVIN_SANDBOX = "true";
  return childEnv;
}

function appendTail(previous, chunk) {
  const combined = Buffer.from(previous + chunk, "utf8");
  let start = Math.max(0, combined.length - STDERR_MAX_BYTES);
  while (start < combined.length && (combined[start] & 0xc0) === 0x80) start += 1;
  return combined.subarray(start).toString("utf8");
}

function devinGroupSignalable(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function signalRunGroup(run, signal) {
  if (!Number.isInteger(run.pid) || run.pid <= 1) return;
  try {
    process.kill(-run.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") run.outcome.stderrTail = appendTail(run.outcome.stderrTail, `\n${error.message}`);
  }
}

function clearRunTimers(run) {
  clearTimeout(run.runTimer);
  clearTimeout(run.exitTimer);
  clearTimeout(run.killTimer);
  clearTimeout(run.drainTimer);
  clearTimeout(run.deadlineTimer);
}

function releaseRequests(run) {
  for (const request of run.pending.values()) request.resolve(undefined);
  run.pending.clear();
}

function settleRun(run) {
  if (run.settled) return;
  run.settled = true;
  clearRunTimers(run);
  releaseRequests(run);
  run.options.signal?.removeEventListener("abort", run.abort);
  run.resolve(run.outcome);
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
  signalRunGroup(run, "SIGTERM");
  run.killTimer ??= setTimeout(() => {
    signalRunGroup(run, "SIGKILL");
    run.drainTimer ??= setTimeout(() => drainRun(run), run.options.killGraceMs);
  }, run.options.killGraceMs);
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
  if (!run.allowedTools.includes(tool)) {
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

function handleStdoutData(run, chunk) {
  run.stdoutRemainder += chunk;
  let newline;
  while ((newline = run.stdoutRemainder.indexOf("\n")) !== -1) {
    const line = run.stdoutRemainder.slice(0, newline).replace(/\r$/, "");
    run.stdoutRemainder = run.stdoutRemainder.slice(newline + 1);
    processDevinLine(run, line);
  }
  if (Buffer.byteLength(run.stdoutRemainder) > STREAM_MAX_BYTES) {
    run.stdoutRemainder = "";
    failProtocol(run, "Stream line exceeds size limit");
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
  run.child.stdout.destroy();
  run.child.stderr.destroy();
  run.child.stdin.destroy();
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
  signalRunGroup(run, "SIGTERM");
  const deadline = Date.now() + run.options.killGraceMs;
  while (devinGroupSignalable(run.pid) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, Math.min(50, deadline - Date.now())));
  }
  if (devinGroupSignalable(run.pid)) signalRunGroup(run, "SIGKILL");
  settleRun(run);
}

function handleRunTimeout(run) {
  if (run.closed || run.exited || run.ending) return;
  run.outcome.timedOut = true;
  cancelRun(run);
}

function launchDevinProcess(bin, cwd, env) {
  return spawn(bin, ["acp"], { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
}

function startDevinRun(run, resolve) {
  run.resolve = resolve;
  const { bin, cwd, env, timeoutMs, exitGraceMs, killGraceMs, launchProcess, signal, onSpawn } = run.options;
  let spawned;
  const launch = () => {
    spawned = launchDevinProcess(bin, cwd, env);
    spawned.on("error", () => {});
    return spawned;
  };
  try {
    run.child = launchProcess ? launchProcess(launch) : launch();
  } catch (error) {
    if (spawned?.pid) {
      spawned.stdin.destroy();
      try {
        process.kill(-spawned.pid, "SIGKILL");
      } catch {}
    }
    run.outcome.spawnError = error;
    run.outcome.stderrTail = appendTail("", error.message);
    settleRun(run);
    return;
  }
  run.pid = run.child.pid;
  run.child.stdout.setEncoding("utf8");
  run.child.stderr.setEncoding("utf8");
  run.child.stdout.on("data", (chunk) => handleStdoutData(run, chunk));
  run.child.stderr.on("data", (chunk) => { run.outcome.stderrTail = appendTail(run.outcome.stderrTail, chunk); });
  run.child.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") run.outcome.stderrTail = appendTail(run.outcome.stderrTail, `\n${error.message}`);
    if (!run.ending) failProtocol(run, "Failed to write ACP request");
  });
  run.child.on("error", (error) => {
    run.outcome.spawnError = error;
    run.outcome.stderrTail = appendTail(run.outcome.stderrTail, error.message);
    finishRun(run);
  });
  run.child.on("exit", (code, childSignal) => handleChildExit(run, code, childSignal));
  run.child.on("close", (code, childSignal) => handleChildClose(run, code, childSignal));
  run.child.once("spawn", () => {
    try {
      onSpawn?.(run.child);
    } catch (error) {
      failSetup(run, error.message);
      return;
    }
    initializeSession(run).catch((error) => {
      if (!run.ending && !run.settled) failSetup(run, error.message);
    });
  });
  run.deadlineTimer = setTimeout(() => {
    handleRunTimeout(run);
    drainRun(run);
  }, timeoutMs + exitGraceMs + 2 * killGraceMs);
  run.runTimer = setTimeout(() => handleRunTimeout(run), timeoutMs);
  signal?.addEventListener("abort", run.abort, { once: true });
  if (signal?.aborted) abortRun(run);
}

export function runDevin({ bin, cwd, env, brief, mode, resumeSessionId, resolveSelection, timeoutMs = 540000, exitGraceMs = 15000, killGraceMs = 5000, launchProcess, signal, onSpawn }) {
  const run = {
    options: { bin, cwd, env, brief, mode, resumeSessionId, resolveSelection, timeoutMs, exitGraceMs, killGraceMs, launchProcess, signal, onSpawn },
    outcome: {
      exitCode: null, signal: null, sessionId: null, requestId: null, resultText: "", usage: null,
      observedModel: null, resolvedEffort: null, stopReason: null, stopCause: null, appliedOptions: {}, rpcError: null,
      protocolError: null, setupError: null, policyViolation: null, selectionError: null,
      timedOut: false, lateClose: false, cancelled: false, stderrTail: "", toolCalls: 0, resultSeen: false
    },
    child: undefined, pid: undefined, resolve: undefined, abort: undefined,
    closed: false, exited: false, settled: false, draining: false, ending: false, promptSent: false,
    stdoutRemainder: "", nextId: 1, pending: new Map(), configOptions: [], tools: new Map(), allowedTools: toolsForMode(mode),
    runTimer: undefined, exitTimer: undefined, killTimer: undefined, drainTimer: undefined, deadlineTimer: undefined
  };
  run.abort = () => abortRun(run);
  return new Promise((resolve) => startDevinRun(run, resolve));
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
