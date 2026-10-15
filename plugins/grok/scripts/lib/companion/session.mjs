import { normalizeGrokSessionId, sandboxProfileForMode } from "../grok-exec.mjs";
import { listJobRecords } from "../state.mjs";

function inputError(message) {
  const error = new Error(message);
  error.failureKind = "input";
  return error;
}

function jobClassForRecord(job) {
  if (job?.jobClass === "task" || job?.jobClass === "review" || job?.jobClass === "stop_gate") {
    return job.jobClass;
  }
  return "unknown";
}

function memoryEnabledForRecord(job) {
  return job?.request?.memory === true;
}

function terminalJob(job) {
  return job?.status === "done" || job?.status === "error" || job?.status === "cancelled";
}

function resumeCompatible(job, mode, memory) {
  return (
    terminalJob(job) &&
    jobClassForRecord(job) === "task" &&
    normalizeGrokSessionId(job.sessionId) &&
    job.mode === mode &&
    job.request?.sandboxProfile === sandboxProfileForMode(mode) &&
    memoryEnabledForRecord(job) === memory
  );
}

function newestFirst(left, right) {
  return (
    String(right.finishedAt ?? right.createdAt ?? "").localeCompare(
      String(left.finishedAt ?? left.createdAt ?? "")
    ) || String(right.id ?? "").localeCompare(String(left.id ?? ""))
  );
}

function sessionMemoryModes(jobs) {
  const memoryModesBySession = new Map();
  for (const job of jobs) {
    const sessionId = normalizeGrokSessionId(job.sessionId);
    if (!sessionId || !terminalJob(job) || jobClassForRecord(job) !== "task") {
      continue;
    }
    const modes = memoryModesBySession.get(sessionId) ?? new Set();
    modes.add(memoryEnabledForRecord(job));
    memoryModesBySession.set(sessionId, modes);
  }
  return memoryModesBySession;
}

function resumableJobs(dataDir, cwd, mode, memory, options = {}) {
  const jobs = listJobRecords(dataDir, cwd);
  const memoryModesBySession = sessionMemoryModes(jobs);
  return jobs
    .filter((job) => resumeCompatible(job, mode, memory))
    .filter((job) => memoryModesBySession.get(normalizeGrokSessionId(job.sessionId))?.size === 1)
    .filter((job) => !options.doneOnly || job.status === "done")
    .sort(newestFirst);
}

function resolveLastSessionJob(dataDir, cwd, claudeSessionId, mode, memory, options = {}) {
  const finished = resumableJobs(dataDir, cwd, mode, memory, options);
  if (claudeSessionId) {
    const owned = finished.filter((job) => job.claudeSessionId === claudeSessionId);
    if (owned.length === 0) {
      if (options.optional) {
        return null;
      }
      throw inputError(`No finished ${mode} grok task with a compatible sandbox and memory mode was found for Claude session ${claudeSessionId} in this workspace.`);
    }
    return owned[0];
  }
  if (finished.length === 0) {
    if (options.optional) {
      return null;
    }
    throw inputError(`No finished ${mode} grok task with a compatible sandbox and memory mode was found for this workspace.`);
  }
  return finished[0];
}

function resolveLastSessionId(dataDir, cwd, claudeSessionId, mode = "consult", memory = false) {
  return normalizeGrokSessionId(resolveLastSessionJob(dataDir, cwd, claudeSessionId, mode, memory).sessionId);
}

function validateResumeSession(dataDir, cwd, sessionId, mode, memory) {
  const normalizedSessionId = normalizeGrokSessionId(sessionId);
  if (!normalizedSessionId) {
    throw inputError("Grok session ids must be UUIDs returned by the companion.");
  }
  const allSessionJobs = listJobRecords(dataDir, cwd).filter(
    (job) => terminalJob(job) && normalizeGrokSessionId(job.sessionId) === normalizedSessionId
  );
  const taskJobs = allSessionJobs.filter((job) => jobClassForRecord(job) === "task");
  const memoryModes = new Set(taskJobs.map(memoryEnabledForRecord));
  if (memoryModes.size > 1) {
    throw inputError(`Grok session ${normalizedSessionId} has inconsistent recorded memory modes and cannot be resumed safely.`);
  }
  const compatible = taskJobs
    .filter(
      (job) =>
        job.mode === mode &&
        job.request?.sandboxProfile === sandboxProfileForMode(mode)
    )
    .sort(newestFirst);
  if (compatible.length > 0) {
    if (memoryEnabledForRecord(compatible[0]) !== memory) {
      const requiredFlag = memoryEnabledForRecord(compatible[0]) ? " with --memory" : " without --memory";
      throw inputError(`Grok session ${normalizedSessionId} must be resumed${requiredFlag} to preserve its recorded memory boundary.`);
    }
    return compatible[0];
  }
  if (taskJobs.length > 0) {
    throw inputError(`Grok session ${normalizedSessionId} cannot resume in ${mode} mode because its recorded sandbox profile is incompatible. Start a fresh task.`);
  }
  if (allSessionJobs.length > 0) {
    throw inputError(`Grok session ${normalizedSessionId} belongs to a non-task job and cannot be resumed.`);
  }
  throw inputError(`No finished companion task owns Grok session ${normalizedSessionId} in this workspace.`);
}

function validateResumeSessionId(dataDir, cwd, sessionId, mode, memory = false) {
  return normalizeGrokSessionId(validateResumeSession(dataDir, cwd, sessionId, mode, memory).sessionId);
}

export { inputError, jobClassForRecord, memoryEnabledForRecord, terminalJob, resumeCompatible, newestFirst, sessionMemoryModes, resumableJobs, resolveLastSessionJob, resolveLastSessionId, validateResumeSession, validateResumeSessionId };
