import { TRANSCRIPT_TAIL_MAX_BYTES } from "./constants.mjs";
import fs from "node:fs";

function transcriptEntryContent(entry) {
  if (Array.isArray(entry?.message?.content)) {
    return entry.message.content;
  }
  return Array.isArray(entry?.content) ? entry.content : [];
}

function readTranscriptTail(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) {
    return [];
  }
  let descriptor;
  try {
    descriptor = fs.openSync(transcriptPath, "r");
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0) {
      return [];
    }
    const bytesToRead = Math.min(TRANSCRIPT_TAIL_MAX_BYTES, stat.size);
    const start = stat.size - bytesToRead;
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
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
    return entries;
  } catch {
    return [];
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

function normalizeMessageId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

function messageIdForToolUse(transcriptPath, toolUseId) {
  if (!toolUseId) {
    return null;
  }
  for (const entry of readTranscriptTail(transcriptPath).toReversed()) {
    if (entry?.type === "assistant" && transcriptEntryContent(entry).some((block) => block?.type === "tool_use" && block.id === toolUseId)) {
      return normalizeMessageId(entry.message?.id);
    }
  }
  return null;
}

function extractBashCommand(toolInput) {
  if (!toolInput || typeof toolInput !== "object") {
    return null;
  }
  return typeof toolInput.command === "string" ? toolInput.command.trim() : null;
}

export { transcriptEntryContent, readTranscriptTail, normalizeMessageId, messageIdForToolUse, extractBashCommand };
