import fs from "node:fs";
import path from "node:path";
import { PEER_JOB_FOOTER_AGENTS } from "../engines.mjs";
import { isTerminalWorkerStatus, markWorkerCollected, readWorkerSessionState, refreshWorkerTranscript, updateWorkerSessionState, WORKER_COLLECTION_METHODS } from "../worker-state.mjs";
import { workerRoundUsage } from "./budget.mjs";
import { absoluteOutputFile, capturedPeerIdentity, collectedHarnessAsyncDelivery, regularFileExists, settleQueuedVerdict, settleWrapperApiDeath, statusEvidence, writeFinalTextArtifact } from "./collection.mjs";
import { sessionRecords, updateLifecycleWorkerRecord } from "./records.mjs";
import { TASK_NOTIFICATION_SCAN_MAX_BYTES, TASK_NOTIFICATION_SCAN_CHUNK_BYTES, TASK_NOTIFICATION_MAX_LINE_BYTES, TASK_NOTIFICATION_FINAL_SCAN_MAX_BYTES, SUCCESSFUL_TASK_NOTIFICATION_STATUSES, CANCELLED_TASK_NOTIFICATION_STATUSES, FAILED_TASK_NOTIFICATION_STATUSES } from "./constants.mjs";

function taskNotificationTextParts(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(taskNotificationTextParts);
  }
  if (value && typeof value === "object" && value.type === "text" && typeof value.text === "string") {
    return [value.text];
  }
  return [];
}

function notificationField(block, names) {
  for (const name of names) {
    const match = new RegExp(`<${name}\\s*>\\s*([\\s\\S]*?)\\s*</${name}\\s*>`, "i").exec(block);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return null;
}

function taskNotificationsFromTranscriptLine(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return [];
  }
  const texts = taskNotificationTextParts(entry.message?.content).concat(taskNotificationTextParts(entry.content));
  const notifications = [];
  for (const text of texts) {
    const blocks = text.matchAll(/<task-notification(?:\s[^>]*)?\s*>([\s\S]*?)<\/task-notification\s*>/gi);
    for (const block of blocks) {
      const taskId = /<task-id\s*>\s*([^<\s]+)\s*<\/task-id\s*>/i.exec(block[1])?.[1] ?? null;
      const status = /<status\s*>\s*([^<]+?)\s*<\/status\s*>/i.exec(block[1])?.[1]?.trim().toLowerCase() ?? null;
      const outputFile = absoluteOutputFile(/<output-file\s*>\s*([^<]+?)\s*<\/output-file\s*>/i.exec(block[1])?.[1]?.trim());
      const notificationSummary = notificationField(block[1], ["notification-summary", "summary"]);
      const statusDetail = notificationField(block[1], ["status-detail", "status_detail", "detail"]);
      if (taskId && status && (SUCCESSFUL_TASK_NOTIFICATION_STATUSES.has(status) || CANCELLED_TASK_NOTIFICATION_STATUSES.has(status) || FAILED_TASK_NOTIFICATION_STATUSES.has(status))) {
        notifications.push({ taskId, status, outputFile, notificationSummary, statusDetail });
      }
    }
  }
  return notifications;
}

function taskNotificationScanOffset(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function initialTaskNotificationScanOffset(records) {
  const offsets = records.map((record) => taskNotificationScanOffset(record.parentTranscriptBytesAtDispatch)).filter((offset) => offset != null);
  return offsets.length > 0 ? Math.min(...offsets) : 0;
}

function parentTranscriptPathForTaskNotifications(records, input) {
  const configured = records.map((record) => record.parentTranscriptPath).find((transcriptPath) => typeof transcriptPath === "string" && path.isAbsolute(transcriptPath));
  if (configured) {
    return path.resolve(configured);
  }
  return typeof input.transcript_path === "string" && path.isAbsolute(input.transcript_path) ? path.resolve(input.transcript_path) : null;
}

function scanTaskNotifications(transcriptPath, requestedOffset) {
  let descriptor;
  try {
    descriptor = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(descriptor).size;
    const startOffset = Math.min(taskNotificationScanOffset(requestedOffset) ?? 0, size);
    const bytesToScan = Math.min(TASK_NOTIFICATION_SCAN_MAX_BYTES, size - startOffset);
    const notifications = new Map();
    let cursor = startOffset;
    let safeOffset = startOffset;
    let pending = Buffer.alloc(0);
    let skippingLongLine = false;
    let remaining = bytesToScan;

    while (remaining > 0) {
      const chunk = Buffer.allocUnsafe(Math.min(TASK_NOTIFICATION_SCAN_CHUNK_BYTES, remaining));
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, cursor);
      if (bytesRead === 0) {
        break;
      }
      const data = chunk.subarray(0, bytesRead);
      const chunkStart = cursor;
      let segmentStart = 0;
      while (segmentStart < data.length) {
        const lineEnd = data.indexOf(0x0a, segmentStart);
        const segmentEnd = lineEnd === -1 ? data.length : lineEnd;
        const segment = data.subarray(segmentStart, segmentEnd);
        if (!skippingLongLine) {
          if (pending.length + segment.length > TASK_NOTIFICATION_MAX_LINE_BYTES) {
            pending = Buffer.alloc(0);
            skippingLongLine = true;
          } else if (segment.length > 0) {
            pending = pending.length === 0 ? Buffer.from(segment) : Buffer.concat([pending, segment]);
          }
        }
        if (lineEnd === -1) {
          break;
        }
        if (!skippingLongLine && pending.length > 0) {
          for (const notification of taskNotificationsFromTranscriptLine(pending.toString("utf8").replace(/\r$/, ""))) {
            notifications.set(notification.taskId, { ...notification, byteOffset: chunkStart + lineEnd + 1 });
          }
        }
        pending = Buffer.alloc(0);
        skippingLongLine = false;
        safeOffset = chunkStart + lineEnd + 1;
        segmentStart = lineEnd + 1;
      }
      cursor += bytesRead;
      remaining -= bytesRead;
      if (skippingLongLine) {
        safeOffset = cursor;
      }
    }
    return { notifications, offset: safeOffset };
  } catch {
    return null;
  } finally {
    if (descriptor != null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        void 0;
      }
    }
  }
}

function transcriptEntryContent(entry) {
  if (Array.isArray(entry?.message?.content)) {
    return entry.message.content;
  }
  return Array.isArray(entry?.content) ? entry.content : [];
}

function boundedTranscriptTailText(transcriptPath) {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) {
    return null;
  }
  let descriptor;
  try {
    descriptor = fs.openSync(transcriptPath, "r");
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0) {
      return null;
    }
    const bytesToRead = Math.min(TASK_NOTIFICATION_FINAL_SCAN_MAX_BYTES, stat.size);
    const start = stat.size - bytesToRead;
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    const parts = [];
    for (const line of text.split("\n")) {
      if (!line.trim() || Buffer.byteLength(line) > TASK_NOTIFICATION_MAX_LINE_BYTES) {
        continue;
      }
      try {
        for (const block of transcriptEntryContent(JSON.parse(line))) {
          if (block?.type === "text" && typeof block.text === "string") {
            parts.push(block.text);
          }
        }
      } catch {
        void 0;
      }
    }
    return parts.length > 0 ? parts.join("\n") : text;
  } catch {
    return null;
  } finally {
    if (descriptor != null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        void 0;
      }
    }
  }
}

function finalAssistantTextFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) {
    return null;
  }
  let descriptor;
  try {
    descriptor = fs.openSync(transcriptPath, "r");
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0) {
      return null;
    }
    const bytesToRead = Math.min(TASK_NOTIFICATION_FINAL_SCAN_MAX_BYTES, stat.size);
    const start = stat.size - bytesToRead;
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].replace(/\r$/, "");
      if (!line.trim() || Buffer.byteLength(line) > TASK_NOTIFICATION_MAX_LINE_BYTES) {
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const content = transcriptEntryContent(entry);
      if (entry?.type === "assistant") {
        if (content.some((block) => block?.type === "tool_use")) {
          return null;
        }
        const blocks = content.filter((block) => block?.type === "text" && typeof block.text === "string" && block.text.length > 0).map((block) => block.text);
        if (blocks.length > 0) {
          return blocks.join("\n");
        }
      } else if (entry?.type === "user" && (entry.toolUseResult != null || content.some((block) => block?.type === "tool_result"))) {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (descriptor != null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        void 0;
      }
    }
  }
}

function taskNotificationTransition(record, notification, now, env) {
  const { status } = notification;
  const refreshed = refreshWorkerTranscript(record, record.transcriptPath);
  if (SUCCESSFUL_TASK_NOTIFICATION_STATUSES.has(status)) {
    const finalText = finalAssistantTextFromTranscript(refreshed.transcriptPath);
    const peerIdentity = PEER_JOB_FOOTER_AGENTS.has(refreshed.agentType)
      ? capturedPeerIdentity(refreshed.agentType, finalText ?? boundedTranscriptTailText(refreshed.transcriptPath), refreshed.peerEngine, refreshed)
      : {};
    if (!finalText) {
      const turnLimited = refreshed.failureKind === "turn_limit" || workerRoundUsage(refreshed).turns >= (refreshed.limits?.maxTurns ?? Number.POSITIVE_INFINITY);
      return settleQueuedVerdict({
        ...refreshed,
        transportStatus: "incomplete",
        failureKind: turnLimited ? "turn_limit" : "missing_final_text",
        ...(turnLimited ? { limitKind: "turns", cancelReason: `turn budget reached (${refreshed.limits?.maxTurns ?? "unknown"})` } : {}),
        ...peerIdentity,
        finishedAt: refreshed.finishedAt ?? now,
        lastActivityAt: now
      }, now, env);
    }
    let finalTextFile = null;
    try {
      finalTextFile = writeFinalTextArtifact(refreshed, finalText, env);
    } catch {
      finalTextFile = null;
    }
    if (!finalTextFile) {
      return settleQueuedVerdict({
        ...refreshed,
        transportStatus: "incomplete",
        failureKind: "delivery",
        ...peerIdentity,
        finishedAt: refreshed.finishedAt ?? now,
        lastActivityAt: now
      }, now, env);
    }
    const harnessAsyncDelivery = collectedHarnessAsyncDelivery(refreshed, "done");
    return settleQueuedVerdict({
      ...markWorkerCollected(refreshed, WORKER_COLLECTION_METHODS.TASK_NOTIFICATION, now),
      transportStatus: "done",
      failureKind: harnessAsyncDelivery ? null : refreshed.failureKind,
      ...(harnessAsyncDelivery ? { deliveryMode: "harness_async" } : {}),
      outputFile: finalTextFile,
      ...peerIdentity,
      finishedAt: refreshed.finishedAt ?? now,
      lastActivityAt: now
    }, now, env);
  }
  const cancelled = CANCELLED_TASK_NOTIFICATION_STATUSES.has(status);
  const fallbackFailureKind = cancelled ? "cancelled" : "task_failed";
  const terminal = {
    ...markWorkerCollected(refreshed, WORKER_COLLECTION_METHODS.TASK_NOTIFICATION, now),
    transportStatus: cancelled ? "cancelled" : "failed",
    failureKind: refreshed.failureKind && refreshed.failureKind !== "unexpected_async" ? refreshed.failureKind : fallbackFailureKind,
    finishedAt: refreshed.finishedAt ?? now,
    lastActivityAt: now
  };
  return cancelled ? settleQueuedVerdict(terminal, now, env) : settleWrapperApiDeath(terminal, statusEvidence(notification), now, env);
}

function reconcileTaskNotifications(input, env) {
  try {
    const candidates = sessionRecords(input.session_id, env).filter((record) => !isTerminalWorkerStatus(record.transportStatus) && [record.backgroundTaskId, record.agentId].some((taskId) => typeof taskId === "string" && taskId));
    if (candidates.length === 0) {
      return;
    }
    const transcriptPath = parentTranscriptPathForTaskNotifications(candidates, input);
    if (!transcriptPath) {
      return;
    }
    const sessionState = readWorkerSessionState(input.session_id, env);
    const scanOffset = sessionState?.taskNotificationTranscriptPath === transcriptPath
      ? taskNotificationScanOffset(sessionState.taskNotificationScanOffset) ?? initialTaskNotificationScanOffset(candidates)
      : initialTaskNotificationScanOffset(candidates);
    const scanned = scanTaskNotifications(transcriptPath, scanOffset);
    if (!scanned) {
      return;
    }
    const now = new Date().toISOString();
    for (const [taskId, notification] of scanned.notifications) {
      for (const record of candidates.filter((candidate) => [candidate.backgroundTaskId, candidate.agentId].includes(taskId))) {
        const stamped = updateLifecycleWorkerRecord(record.taskId, env, (current) => {
          if (!current || current.sessionId !== input.session_id || isTerminalWorkerStatus(current.transportStatus) || ![current.backgroundTaskId, current.agentId].includes(taskId) || notification.byteOffset <= (current.continuationNotificationFloor ?? 0)) {
            return null;
          }
          const currentTranscriptExists = regularFileExists(current.transcriptPath);
          return {
            ...current,
            ...(notification.outputFile && (!current.transcriptPath || !currentTranscriptExists) ? { transcriptPath: notification.outputFile } : {}),
            ...(notification.notificationSummary ? { notificationSummary: notification.notificationSummary } : {}),
            ...(notification.statusDetail ? { statusDetail: notification.statusDetail } : {})
          };
        });
        if (!stamped || stamped.sessionId !== input.session_id || isTerminalWorkerStatus(stamped.transportStatus) || ![stamped.backgroundTaskId, stamped.agentId].includes(taskId) || notification.byteOffset <= (stamped.continuationNotificationFloor ?? 0)) {
          continue;
        }
        updateLifecycleWorkerRecord(record.taskId, env, (current) => {
          if (!current || current.sessionId !== input.session_id || isTerminalWorkerStatus(current.transportStatus) || ![current.backgroundTaskId, current.agentId].includes(taskId) || notification.byteOffset <= (current.continuationNotificationFloor ?? 0)) {
            return null;
          }
          return taskNotificationTransition(current, notification, now, env);
        });
      }
    }
    updateWorkerSessionState(input.session_id, env, (current) => ({
      ...(current ?? {}),
      taskNotificationTranscriptPath: transcriptPath,
      taskNotificationScanOffset: scanned.offset
    }));
  } catch {
    void 0;
  }
}


export { taskNotificationTextParts, notificationField, taskNotificationsFromTranscriptLine, taskNotificationScanOffset, initialTaskNotificationScanOffset, parentTranscriptPathForTaskNotifications, scanTaskNotifications, transcriptEntryContent, boundedTranscriptTailText, finalAssistantTextFromTranscript, taskNotificationTransition, reconcileTaskNotifications };
