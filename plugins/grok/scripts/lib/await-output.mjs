import { readFile, stat } from "node:fs/promises";
import path from "node:path";

function parseOptions(argv) {
  let file;
  let sliceMs = 100000;
  let sliceSeen = false;
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === "--file" && file === undefined && value !== undefined) {
      file = value;
    } else if (option === "--slice-ms" && !sliceSeen && value !== undefined) {
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 110000) {
        throw new Error("--slice-ms must be a positive integer up to 110000");
      }
      sliceMs = Number(value);
      sliceSeen = true;
    } else {
      throw new Error(`invalid argument ${String(option ?? "").replace(/[\r\n]/g, " ")}`.trimEnd());
    }
  }
  if (file === undefined) throw new Error("--file is required");
  if (!path.isAbsolute(file)) throw new Error("--file must be an absolute path");
  if (!path.basename(file).endsWith(".output")) throw new Error("--file must end in .output");
  return { file, sliceMs };
}

function lastNonEmptyLine(bytes) {
  let end = bytes.length;
  while (end > 0) {
    const separator = bytes.lastIndexOf(10, end - 1);
    const start = separator + 1;
    const line = bytes.subarray(start, end).toString("utf8").replace(/\r$/, "");
    if (line.trim()) {
      return { line, start, end: end < bytes.length && bytes[end] === 10 ? end + 1 : end };
    }
    if (separator < 0) break;
    end = separator;
  }
  return null;
}

export async function awaitOutput(argv, { now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), stdout = process.stdout, stderr = process.stderr } = {}) {
  let file;
  let sliceMs;
  try {
    ({ file, sliceMs } = parseOptions(argv));
    const info = await stat(file);
    if (!info.isFile()) throw new Error("--file must name a regular file");
  } catch (error) {
    const reason = error.code === "ENOENT" ? "--file does not exist" : error.code ? "cannot access --file" : error.message;
    stderr.write(`await-output: ${reason}\n`);
    return 2;
  }

  const deadline = now() + sliceMs;
  let previous;
  let previousMtime;
  let unchangedSince;
  while (true) {
    let bytes;
    let info;
    try {
      bytes = await readFile(file);
      info = await stat(file);
      if (!info.isFile()) throw new Error("--file must name a regular file");
    } catch (error) {
      const reason = error.code === "ENOENT" ? "--file does not exist" : error.code ? "cannot read --file" : error.message;
      stderr.write(`await-output: ${reason}\n`);
      return 2;
    }
    const time = now();
    if (previous === undefined) unchangedSince = Math.min(time, info.mtimeMs);
    else if (!bytes.equals(previous) || info.mtimeMs !== previousMtime) unchangedSince = time;
    previous = bytes;
    previousMtime = info.mtimeMs;
    const last = lastNonEmptyLine(bytes);
    if (last && /^\[exited with code -?\d+\]$/.test(last.line)) {
      stdout.write(Buffer.concat([bytes.subarray(0, last.start), bytes.subarray(last.end)]));
      return 0;
    }
    if (last && /^state: (done|error|cancelled)$/.test(last.line) && time - unchangedSince >= 10000) {
      stdout.write(bytes);
      return 0;
    }
    if (time >= deadline) {
      stdout.write("await-output: pending\n");
      return 0;
    }
    await sleep(Math.min(500, deadline - time));
  }
}
