import fs from "node:fs";
import { TRANSCRIPT_TAIL_MAX_BYTES } from "./constants.mjs";

const CONTEXT_SCAN_BYTES = 4 * 1024 * 1024;

function isRequestBlob(line) {
  if (!line.includes('"api-request-blob"')) return false;
  let depth = 0;
  for (const token of line.matchAll(/"[^"\\]*(?:\\.[^"\\]*)*"|[[\]{}]/g)) {
    if (token[0] === "{" || token[0] === "[") depth += 1;
    else if (token[0] === "}" || token[0] === "]") depth -= 1;
    else if (depth === 1 && token[0] === '"type"') {
      const value = /^\s*:\s*"([^"]*)"/.exec(line.slice(token.index + 6));
      if (value) return value[1] === "api-request-blob";
    }
  }
  return false;
}

function assistantEntry(first, rest, mainOnly) {
  if (!first.length && !rest.length) return null;
  if (/^\s*\{\s*"type"\s*:\s*"api-request-blob"/.test(first.toString("utf8", 0, 128))) return null;
  const line = (rest.length ? Buffer.concat([first, ...rest.toReversed()]) : first).toString("utf8");
  if (!line.includes('"assistant"') || isRequestBlob(line)) return null;
  try {
    const entry = JSON.parse(line);
    return entry?.type === "assistant" && (!mainOnly || (entry.isSidechain !== true && entry.isMeta !== true)) ? entry : null;
  } catch {
    return null;
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
  let rest = [];
  while (end > floor) {
    const start = Math.max(floor, end - TRANSCRIPT_TAIL_MAX_BYTES);
    const buffer = Buffer.allocUnsafe(end - start);
    if (fs.readSync(fd, buffer, 0, buffer.length, start) !== buffer.length) throw new Error("Transcript changed while reading.");
    const entries = [];
    let right = buffer.length;
    while (right > 0) {
      const newline = buffer.lastIndexOf(10, right - 1);
      const first = buffer.subarray(newline + 1, right);
      if (newline < 0 && start > 0) {
        rest.push(first);
        break;
      }
      const entry = assistantEntry(first, rest, mainOnly);
      if (entry) entries.push({ entry, offset: start + newline + 1 });
      rest = [];
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
