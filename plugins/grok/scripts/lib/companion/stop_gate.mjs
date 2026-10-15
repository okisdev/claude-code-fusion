import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveGrokBin, sandboxProfileForMode, runGrok } from "../grok-exec.mjs";
import { briefPath, createJobRecord, createJobRecordFile, generateJobId, jobFilePath, jobLogPath, launchRunningJobProcess, nowIso, resolveDataDir, writeBrief } from "../state.mjs";
import { STOP_GATE_TIMEOUT_MS, STOP_GATE_MAX_TURNS } from "./config.mjs";
import { resolveGrokCompanionVersion, probeGrokVersion, requireTestedGrokFloor, requireQuotaAvailable } from "./version.mjs";
import { oneLineSummary, currentClaudeSessionId, isStopGateEnabled, readStdinIfPiped } from "./base.mjs";
import { grokFailureMessage, classifyFailure, finishJobRecord, resultFailed, failureTail } from "./execution.mjs";
import { resultSpendPatch, recordSpawnFailure } from "./outcome.mjs";
import { resolveRepositoryTopLevel, collectReviewTarget, interpolateTemplate } from "./review.mjs";
import { STOP_GATE_PROMPT_FILE } from "./paths.mjs";

function parseStopGateInput() {
  const raw = readStdinIfPiped().trim();
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function emitStopGateBlock(reason) {
  const payload = {
    decision: "block",
    reason: `Grok stop-time review found issues that still need fixes before ending the session: ${reason}`
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function handleStopGate() {
  const input = parseStopGateInput();
  if (!input) {
    return;
  }

  const dataDir = resolveDataDir();
  if (!isStopGateEnabled(dataDir) || input.stop_hook_active) {
    return;
  }

  const cwd = input.cwd ? path.resolve(String(input.cwd)) : process.cwd();
  const probe = spawnSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    return;
  }

  let target;
  try {
    target = collectReviewTarget(cwd, null);
  } catch {
    return;
  }
  if (!target.diff.trim()) {
    return;
  }

  if (!fs.existsSync(STOP_GATE_PROMPT_FILE)) {
    return;
  }
  const prompt = interpolateTemplate(fs.readFileSync(STOP_GATE_PROMPT_FILE, "utf8"), {
    DIFF: target.diff
  });
  requireQuotaAvailable(dataDir);
  const grok = probeGrokVersion(resolveGrokBin(), process.env);

  const jobId = generateJobId();
  const briefFile = briefPath(dataDir, cwd, jobId);
  const jobFile = jobFilePath(dataDir, cwd, jobId);
  createJobRecordFile(jobFile, {
    ...createJobRecord({
      id: jobId,
      companionVersion: resolveGrokCompanionVersion(),
      grokVersion: grok.version,
      pid: process.pid,
      mode: "consult",
      cwd,
      briefFile,
      background: false,
      claudeSessionId: input.session_id ?? currentClaudeSessionId(),
      jobClass: "stop_gate",
      request: {
        maxTurns: STOP_GATE_MAX_TURNS,
        memory: false,
        sandboxProfile: sandboxProfileForMode("consult")
      }
    }),
    repositoryTopLevel: resolveRepositoryTopLevel(cwd)
  });
  try {
    requireTestedGrokFloor(grok);
    requireQuotaAvailable(dataDir);
    writeBrief(dataDir, cwd, jobId, prompt);
  } catch (error) {
    recordSpawnFailure(jobFile, error);
    return;
  }

  const logFile = jobLogPath(dataDir, cwd, jobId);
  let result;
  try {
    result = await runGrok({
      briefFile,
      prompt,
      mode: "consult",
      maxTurns: STOP_GATE_MAX_TURNS,
      cwd,
      logFile,
      timeoutMs: STOP_GATE_TIMEOUT_MS,
      launchProcess: (launch) => {
        requireQuotaAvailable(dataDir);
        return launchRunningJobProcess(jobFile, launch);
      }
    });
  } catch (error) {
    recordSpawnFailure(jobFile, error);
    return;
  }

  if (resultFailed(result)) {
    const tail = failureTail(logFile, result);
    const failureKind = classifyFailure({ result, logTail: tail });
    const message = grokFailureMessage(result, STOP_GATE_TIMEOUT_MS, failureKind, tail);
    finishJobRecord(jobFile, {
      status: "error",
      pid: null,
      grokPid: null,
      finishedAt: nowIso(),
      exitCode: result.exitCode,
      sessionId: result.sessionId,
      resultText: result.text || null,
      ...resultSpendPatch(result),
      errorMessage: oneLineSummary(message),
      errorTail: tail || message,
      failureKind
    });
    return;
  }

  finishJobRecord(jobFile, {
    status: "done",
    pid: null,
    grokPid: null,
    finishedAt: nowIso(),
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    resultText: result.text,
    ...resultSpendPatch(result),
    failureKind: null,
    cancelRequestedAt: null
  });

  const text = String(result.text ?? "").trim();
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (firstLine?.startsWith("BLOCK:")) {
    emitStopGateBlock(firstLine.slice("BLOCK:".length).trim() || text);
  }
}

export { parseStopGateInput, emitStopGateBlock, handleStopGate };
