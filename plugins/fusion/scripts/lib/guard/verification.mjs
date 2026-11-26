import { TRANSCRIPT_TAIL_MAX_BYTES } from "./constants.mjs";
import { assistantPages, readTranscript } from "./transcript.mjs";

function transcriptEntryContent(entry) {
  if (Array.isArray(entry?.message?.content)) {
    return entry.message.content;
  }
  return Array.isArray(entry?.content) ? entry.content : [];
}

function normalizeMessageId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

function messageIdForToolUse(transcriptPath, toolUseId) {
  if (!toolUseId) {
    return null;
  }
  return readTranscript(transcriptPath, (fd, size) => {
    for (const entries of assistantPages(fd, size, TRANSCRIPT_TAIL_MAX_BYTES, false)) {
      for (const { entry } of entries) {
        if (transcriptEntryContent(entry).some((block) => block?.type === "tool_use" && block.id === toolUseId)) {
          return normalizeMessageId(entry.message?.id);
        }
      }
    }
    return null;
  });
}

function extractBashCommand(toolInput) {
  if (!toolInput || typeof toolInput !== "object") {
    return null;
  }
  return typeof toolInput.command === "string" ? toolInput.command.trim() : null;
}

export { transcriptEntryContent, normalizeMessageId, messageIdForToolUse, extractBashCommand };
