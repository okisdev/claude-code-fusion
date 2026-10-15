import { WORKER_TERMINAL_STATUSES } from "../worker-state.mjs";
import { settleQueuedVerdict } from "./collection.mjs";
import { activeSessionRecords, updateLifecycleWorkerRecord } from "./records.mjs";

function handleSessionEnd(input, env) {
  const now = new Date().toISOString();
  for (const record of activeSessionRecords(input.session_id, env)) {
    updateLifecycleWorkerRecord(record.taskId, env, (current) => {
      if (!current || WORKER_TERMINAL_STATUSES.has(current.transportStatus)) {
        return null;
      }
      return settleQueuedVerdict({
        ...current,
        transportStatus: "owner_ended",
        failureKind: current.failureKind ?? "owner_lost",
        finishedAt: now
      }, now, env);
    });
  }
}


export { handleSessionEnd };
