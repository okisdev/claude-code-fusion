import { engineAcceptanceTransport, recordEngineAcceptance } from "../../lib/engine-acceptance.mjs";
import { readEngineJobRecord } from "../../lib/engine-job-state.mjs";
import { ENGINE_IDS, ENGINE_TERMINAL_STATUSES, engineDisplayName, engineDisplayNameList, engineStateRoots, isEngineId } from "../../lib/engines.mjs";
import { WORKER_TERMINAL_STATUSES, readWorkerRecord, readWorkerRecords, recordWorkerAcceptance, validateWorkerAcceptance } from "../../lib/worker-state.mjs";
import { FILE_ENGINE_DESCRIPTORS } from "./engine-evidence.mjs";
import { ENGINE_JOB_ID_PATTERN, FUSION_TASK_ID_PATTERN, nonEmptyString } from "./evidence.mjs";

function resolveEngineJob(jobId, env) {
  const found = ENGINE_IDS.filter((engine) => FILE_ENGINE_DESCRIPTORS[engine].enumerateJobs(engineStateRoots(engine, env)[0], { env }).some((job) => nonEmptyString(job?.id) === jobId));
  if (found.length > 1) {
    const names = new Intl.ListFormat("en", { type: "conjunction" }).format(found.map((engine) => engineDisplayName(engine)));
    throw new Error(`Engine job ${jobId} exists in ${names} state.`);
  }
  if (found.length === 1) {
    return found[0];
  }
  throw new Error(`Engine job ${jobId} was not found in ${engineDisplayNameList("disjunction")} state.`);
}

function writeRecordConfirmation({ kind, engine = null, jobId = null, worker = null, queued = false, asJson, stdout }) {
  if (asJson) {
    stdout.write(`${JSON.stringify(kind === "engine" ? { kind, engine, jobId, acceptance: worker?.acceptance } : { kind, taskId: worker.taskId, acceptance: queued ? worker.pendingVerdict?.acceptance : worker.acceptance, ...(queued ? { queued: true } : {}) })}\n`);
    return;
  }
  if (kind === "engine") {
    stdout.write(`Recorded ${worker.acceptance} for ${engineDisplayName(engine)} job ${jobId}.\n`);
    return;
  }
  if (queued) {
    stdout.write(`Queued ${worker.pendingVerdict?.acceptance} for ${worker.taskId}; applies when the record turns terminal.\n`);
    return;
  }
  stdout.write(`Recorded ${worker.acceptance} for Fusion worker task ${worker.taskId}.\n`);
}

function settleWorkerRecord({ taskId, verdict, source, reason, failureKind, acceptFailedTransport = false, asJson, env, stdout, stderr }) {
  const current = readWorkerRecord(taskId, env);
  const terminal = WORKER_TERMINAL_STATUSES.has(current?.transportStatus);
  const peerJobId = terminal && typeof current.peerJobId === "string" && ENGINE_JOB_ID_PATTERN.test(current.peerJobId) ? current.peerJobId : null;
  const previousJobIds = new Set((Array.isArray(current?.continuations) ? current.continuations : []).flatMap((round) => Array.isArray(round?.peerJobIds) ? round.peerJobIds : []));
  const peerJobIds = terminal ? [...new Set([
    ...(Array.isArray(current?.peerJobIds) ? current.peerJobIds.filter((id) => typeof id === "string" && ENGINE_JOB_ID_PATTERN.test(id)) : []),
    ...(peerJobId ? [peerJobId] : [])
  ].filter((id) => !previousJobIds.has(id)))] : [];
  if (peerJobIds.length === 0) {
    const settlement = recordWorkerAcceptance({ taskId, acceptance: verdict, env, source, reason, failureKind, acceptFailedTransport });
    const worker = settlement.record;
    writeRecordConfirmation({ kind: "worker", worker, queued: settlement.queued, asJson, stdout });
    return [worker];
  }
  validateWorkerAcceptance({ record: current, taskId, acceptance: verdict, source, reason, failureKind, acceptFailedTransport });
  const settledPeers = [];
  for (const jobId of peerJobIds) {
    const finalPeer = jobId === peerJobId;
    const retainedEngines = finalPeer ? [] : ENGINE_IDS.filter((engine) => readEngineJobRecord(engine, jobId, env) !== null);
    if (!finalPeer && retainedEngines.length === 0) {
      continue;
    }
    let engine;
    try {
      engine = isEngineId(current.peerEngine) ? current.peerEngine : resolveEngineJob(jobId, env);
    } catch (error) {
      if (finalPeer) {
        throw error;
      }
      stderr.write(`Skipped engine settlement for job ${jobId}: ${error instanceof Error ? error.message : String(error)}\n`);
      continue;
    }
    if (!finalPeer && !retainedEngines.includes(engine)) {
      continue;
    }
    const transport = engineAcceptanceTransport({ engine, jobId, acceptance: verdict, acceptFailedTransport, env });
    if (!finalPeer && verdict === "accepted" && transport.failedTransport && !transport.salvage) {
      stderr.write(`Skipped engine settlement for ${engineDisplayName(engine)} job ${jobId}: error transport is not a salvage failure.\n`);
      continue;
    }
    try {
      recordEngineAcceptance({ engine, jobId, acceptance: verdict, source, reason, failureKind, acceptFailedTransport: transport.acceptFailedTransport, asJson, env });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!finalPeer) {
        stderr.write(`Skipped engine settlement for ${engineDisplayName(engine)} job ${jobId}: ${message}\n`);
        continue;
      }
      throw new Error(`Engine settlement failed for ${engineDisplayName(engine)} job ${jobId}: ${message}`);
    }
    settledPeers.push({ engine, jobId, acceptance: verdict });
  }
  let settlement;
  try {
    settlement = recordWorkerAcceptance({ taskId, acceptance: verdict, env, source, reason, failureKind, acceptFailedTransport });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const settled = settledPeers.map(({ engine, jobId }) => `${engineDisplayName(engine)} job ${jobId}`).join(", ");
    throw new Error(`${settled ? `Engine settlement succeeded for ${settled}, but ` : ""}Fusion worker task ${taskId} was not settled: ${message}`);
  }
  const worker = settlement.record;
  if (settlement.queued) {
    writeRecordConfirmation({ kind: "worker", worker, asJson, stdout });
    return [worker];
  }
  writeRecordConfirmation({ kind: "worker", worker, asJson, stdout });
  for (const { engine, jobId } of settledPeers) {
    writeRecordConfirmation({ kind: "engine", engine, jobId, worker, asJson, stdout });
  }
  return [worker, ...settledPeers];
}

function settleEngineRecord({ jobId, verdict, source, reason, failureKind, acceptFailedTransport = false, asJson, env, stdout }) {
  const engine = resolveEngineJob(jobId, env);
  const confirmation = { engine, jobId, acceptance: verdict };
  recordEngineAcceptance({ engine, jobId, acceptance: verdict, source, reason, failureKind, acceptFailedTransport, asJson, env });
  writeRecordConfirmation({ kind: "engine", engine, jobId, worker: confirmation, asJson, stdout });
  const writes = [confirmation];
  for (const record of readWorkerRecords(env).filter((candidate) => candidate.peerJobId === jobId)) {
    const settlement = recordWorkerAcceptance({ taskId: record.taskId, acceptance: verdict, env, source, reason, failureKind, acceptFailedTransport });
    writeRecordConfirmation({ kind: "worker", worker: settlement.record, queued: settlement.queued, asJson, stdout });
    writes.push(settlement.record);
  }
  return writes;
}

function validateWorkerSettlement({ taskId, verdict, source, reason, failureKind, acceptFailedTransport, env }) {
  const current = readWorkerRecord(taskId, env);
  validateWorkerAcceptance({ record: current, taskId, acceptance: verdict, source, reason, failureKind, acceptFailedTransport });
  const peerJobId = WORKER_TERMINAL_STATUSES.has(current?.transportStatus) && typeof current.peerJobId === "string" && ENGINE_JOB_ID_PATTERN.test(current.peerJobId) ? current.peerJobId : null;
  if (peerJobId && !isEngineId(current.peerEngine)) {
    resolveEngineJob(peerJobId, env);
  }
  if (peerJobId) {
    const engine = isEngineId(current.peerEngine) ? current.peerEngine : resolveEngineJob(peerJobId, env);
    requireTerminalEngineSettlement(engine, peerJobId, env);
  }
}

function requireTerminalEngineSettlement(engine, jobId, env) {
  const record = readEngineJobRecord(engine, jobId, env);
  if (record && !ENGINE_TERMINAL_STATUSES.has(record.status)) {
    throw new TypeError(`${engineDisplayName(engine)} job ${jobId} is not terminal; record its verdict after it finishes.`);
  }
}

function validateEngineSettlement({ jobId, verdict, source, reason, failureKind, acceptFailedTransport, env }) {
  const engine = resolveEngineJob(jobId, env);
  requireTerminalEngineSettlement(engine, jobId, env);
  for (const record of readWorkerRecords(env).filter((candidate) => candidate.peerJobId === jobId)) {
    validateWorkerAcceptance({ record, taskId: record.taskId, acceptance: verdict, source, reason, failureKind, acceptFailedTransport });
  }
}

function validateRecordSettlements({ records, source, acceptFailedTransport, env }) {
  for (const { id, verdict, reason = null, failureKind = null, acceptFailedTransport: pairAcceptFailedTransport } of records) {
    const pairOverride = acceptFailedTransport || pairAcceptFailedTransport;
    if (FUSION_TASK_ID_PATTERN.test(id)) {
      validateWorkerSettlement({ taskId: id, verdict, source, reason, failureKind, acceptFailedTransport: pairOverride, env });
    } else {
      validateEngineSettlement({ jobId: id, verdict, source, reason, failureKind, acceptFailedTransport: pairOverride, env });
    }
  }
}

export function settleRecords({ records, source, acceptFailedTransport = false, asJson, env, stdout, stderr }) {
  validateRecordSettlements({ records, source, acceptFailedTransport, env });
  const writes = [];
  const errors = [];
  for (const { id, verdict, reason = null, failureKind = null, acceptFailedTransport: pairAcceptFailedTransport } of records) {
    const pairOverride = acceptFailedTransport || pairAcceptFailedTransport;
    try {
      if (FUSION_TASK_ID_PATTERN.test(id)) {
        writes.push(...settleWorkerRecord({ taskId: id, verdict, source, reason, failureKind, acceptFailedTransport: pairOverride, asJson, env, stdout, stderr }));
      } else {
        writes.push(...settleEngineRecord({ jobId: id, verdict, source, reason, failureKind, acceptFailedTransport: pairOverride, asJson, env, stdout }));
      }
    } catch (error) {
      const failure = { id, error };
      errors.push(failure);
      stderr.write(`Failed to settle ${id}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return { writes, errors };
}
