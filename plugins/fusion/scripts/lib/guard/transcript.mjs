import fs from "node:fs";
import { TRANSCRIPT_TAIL_MAX_BYTES } from "./constants.mjs";

const CONTEXT_SCAN_BYTES = 4 * 1024 * 1024;

function readChunk(fd, buffer, length, position) {
  if (fs.readSync(fd, buffer, 0, length, position) !== length) throw new Error("Transcript changed while reading.");
  return buffer.subarray(0, length);
}

function* recordChunks(fd, first, offset, length) {
  const chunkBytes = 4096;
  for (let pos = 0; pos < first.length; pos += chunkBytes) {
    yield first.toString("latin1", pos, pos + chunkBytes);
  }
  if (first.length === length) return;
  const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, length - first.length));
  for (let pos = first.length; pos < length; pos += buffer.length) {
    yield readChunk(fd, buffer, Math.min(buffer.length, length - pos), offset + pos).toString("latin1");
  }
}

function hasAssistantType(fd, first, offset, length) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let token = "";
  let field = null;
  const maxTokenLength = "assistant".length * 6;
  for (const chunk of recordChunks(fd, first, offset, length)) {
    for (const char of chunk) {
      if (quoted) {
        if (char === '"' && !escaped) {
          quoted = false;
          if (depth === 1) {
            if (token.includes("\\") && token.length <= maxTokenLength) token = JSON.parse(`"${token}"`);
            if (field === null) field = token;
            else if (field === "type") return token === "assistant";
          }
        } else {
          if (depth === 1 && token.length <= maxTokenLength) token += char;
          escaped = char === "\\" && !escaped;
        }
      } else if (char === '"') {
        quoted = true;
        token = "";
      } else if (char === "{" || char === "[") {
        depth++;
      } else if (char === "}" || char === "]") {
        depth--;
      } else if (char === "," && depth === 1) {
        field = null;
      }
    }
  }
  return false;
}

function assistantEntry(fd, first, offset, length, mainOnly) {
  try {
    if (!length || !hasAssistantType(fd, first, offset, length)) return null;
    const line = first.length === length ? first : readChunk(fd, Buffer.allocUnsafe(length), length, offset);
    const entry = JSON.parse(line.toString("utf8"));
    return entry?.type === "assistant" && (!mainOnly || (entry.isSidechain !== true && entry.isMeta !== true)) ? entry : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function readTranscript(transcriptPath, read) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const stat = fs.fstatSync(fd);
    return stat.isFile() ? read(fd, stat.size) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function* assistantPages(fd, end, maxBytes = CONTEXT_SCAN_BYTES, mainOnly = true) {
  const floor = Math.max(0, end - maxBytes);
  const page = Buffer.allocUnsafe(Math.min(end - floor, TRANSCRIPT_TAIL_MAX_BYTES));
  let lineEnd = end;
  while (end > floor) {
    const start = Math.max(floor, end - page.length);
    const buffer = readChunk(fd, page, end - start, start);
    const entries = [];
    let right = buffer.length;
    while (right > 0) {
      const newline = buffer.lastIndexOf(10, right - 1);
      if (newline < 0 && start > 0) break;
      const offset = start + newline + 1;
      const entry = assistantEntry(fd, buffer.subarray(newline + 1, right), offset, lineEnd - offset, mainOnly);
      if (entry) entries.push({ entry, offset });
      lineEnd = offset - 1;
      right = newline;
    }
    yield entries;
    end = start;
  }
}

function usageContextTokens(usage) {
  const counts = [usage?.input_tokens, usage?.cache_read_input_tokens ?? 0, usage?.cache_creation_input_tokens ?? 0];
  if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const tokens = counts.reduce((total, value) => total + value, 0);
  return Number.isSafeInteger(tokens) ? tokens : null;
}

function latestContextTokens(transcriptPath) {
  return readTranscript(transcriptPath, (fd, size) => {
    for (const entries of assistantPages(fd, size)) {
      for (const { entry } of entries) {
        const tokens = usageContextTokens(entry.message?.usage);
        if (tokens !== null) return tokens;
      }
    }
    return null;
  });
}

export { CONTEXT_SCAN_BYTES, assistantPages, latestContextTokens, readTranscript, usageContextTokens };
