import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createHeartbeatTick } from "../plugins/codex/scripts/codex-companion.mjs";
import { getProcessIdentity, runCodex } from "../plugins/codex/scripts/lib/codex-exec.mjs";

function requireProcessInspection(t) {
  if (!getProcessIdentity(process.pid)) {
    t.skip("process inspection unavailable in this environment");
    return false;
  }
  return true;
}

function sandbox(t, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-codex-batching-"));
  const bin = path.join(dir, "fake-codex.mjs");
  fs.writeFileSync(bin, `#!/usr/bin/env node\n${script}\n`, { mode: 0o700 });
  const files = { bin, dir, eventsFile: path.join(dir, "events.jsonl"), logFile: path.join(dir, "stderr.log"), runs: [], pids: new Set() };
  t.after(async () => {
    try {
      for (const { cancellation } of files.runs) cancellation.abort();
      for (const pid of files.pids) {
        const listed = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
        if (listed.error) throw listed.error;
        if (listed.stdout.includes(bin)) {
          try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
      }
      await Promise.allSettled(files.runs.map(({ pending }) => pending));
      for (const pid of files.pids) {
        const listed = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
        if (listed.error) throw listed.error;
        assert.doesNotMatch(listed.stdout, /fake-codex\.mjs/, `fake Codex child ${pid} is still running`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  return files;
}

function run(files, options = {}) {
  const cancellation = new AbortController();
  const pending = runCodex({
    bin: files.bin,
    args: [],
    cwd: files.dir,
    eventsFile: files.eventsFile,
    logFile: files.logFile,
    prompt: "",
    timeoutMs: 10000,
    ...options,
    signal: options.signal ? AbortSignal.any([cancellation.signal, options.signal]) : cancellation.signal,
    onSpawnAttempt: (pid) => {
      if (Number.isInteger(pid)) files.pids.add(pid);
      options.onSpawnAttempt?.(pid);
    }
  });
  files.runs.push({ cancellation, pending });
  return pending;
}

test("heartbeat checks every five seconds but persists at thirty-second intervals", () => {
  let timeMs = 0;
  const writes = [];
  const cancellation = new AbortController();
  const record = { status: "running", cancelRequestedAt: null };
  let reads = 0;
  const tick = createHeartbeatTick("job.json", cancellation, {
    now: () => timeMs,
    read: () => { reads += 1; return record; },
    update: (_file, patch) => writes.push(patch)
  });
  for (let i = 1; i <= 60; i += 1) {
    timeMs = i * 5000;
    if (i === 13) record.cancelRequestedAt = "cancelled";
    tick();
  }
  assert.equal(reads, 60);
  assert.equal(cancellation.signal.aborted, true);
  assert.equal(writes.length, 10);
  assert.deepEqual(writes.map(({ heartbeatAt }) => Date.parse(heartbeatAt)),
    Array.from({ length: 10 }, (_, index) => (index + 1) * 30000));
  record.status = "done";
  timeMs += 30000;
  tick();
  assert.equal(writes.length, 10);
});

test("event and stderr bursts use bounded writes and retain all output at close", async (t) => {
  if (!requireProcessInspection(t)) return;
  const payload = "x".repeat(400);
  const event = JSON.stringify({ type: "future.event", payload });
  const events = [
    JSON.stringify({ type: "thread.started", thread_id: "batch-thread" }),
    JSON.stringify({ type: "turn.started" }),
    ...Array(200).fill(event),
    JSON.stringify({ type: "turn.completed", usage: {
      input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0
    } })
  ];
  const stderrChunks = Array.from({ length: 40 }, (_, index) => `stderr-${index}\n`);
  const files = sandbox(t, `
const events = ${JSON.stringify(events)};
for (const event of events) process.stdout.write(event + "\\n");
for (const chunk of ${JSON.stringify(stderrChunks)}) {
  process.stderr.write(chunk);
  await new Promise((resolve) => setTimeout(resolve, 5));
}
`);
  const originalOpen = fs.openSync;
  const originalWrite = fs.writeSync;
  const originalWriteFile = fs.writeFileSync;
  let eventsFd;
  let eventWrites = 0;
  let stderrWrites = 0;
  fs.openSync = function (file, ...args) {
    const fd = originalOpen.call(this, file, ...args);
    if (file === files.eventsFile) eventsFd = fd;
    return fd;
  };
  fs.writeSync = function (fd, ...args) {
    if (fd === eventsFd) eventWrites += 1;
    return originalWrite.call(this, fd, ...args);
  };
  fs.writeFileSync = function (file, ...args) {
    if (file === files.logFile) stderrWrites += 1;
    return originalWriteFile.call(this, file, ...args);
  };
  let outcome;
  try {
    outcome = await run(files);
  } finally {
    fs.openSync = originalOpen;
    fs.writeSync = originalWrite;
    fs.writeFileSync = originalWriteFile;
  }
  assert.equal(outcome.status, "done", outcome.errorMessage);
  assert.equal(outcome.eventCount, events.length);
  assert.ok(eventWrites >= 2 && eventWrites <= 3, `event writes: ${eventWrites}`);
  assert.ok(stderrWrites <= 2, `stderr writes: ${stderrWrites}`);
  assert.equal(fs.readFileSync(files.eventsFile, "utf8"), `${events.join("\n")}\n`);
  assert.equal(fs.readFileSync(files.logFile, "utf8"), stderrChunks.join(""));
});

test("pending output flushes within a second and on cancellation", async (t) => {
  if (!requireProcessInspection(t)) return;
  const files = sandbox(t, `
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "periodic-thread" }) + "\\n");
process.stderr.write("first stderr\\n");
setInterval(() => {}, 100);
`);
  const cancellation = new AbortController();
  let firstEvent;
  const firstEventSeen = new Promise((resolve) => { firstEvent = resolve; });
  const pending = run(files, {
    signal: cancellation.signal,
    onCheckpoint: ({ event }) => { if (event?.type === "thread.started") firstEvent(); }
  });
  await Promise.race([firstEventSeen, pending.then((outcome) => assert.fail(`Codex ended before its first event: ${outcome.status}`))]);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.match(fs.readFileSync(files.eventsFile, "utf8"), /thread.started/);
  assert.equal(fs.readFileSync(files.logFile, "utf8"), "first stderr\n");
  cancellation.abort();
  const outcome = await pending;
  assert.equal(outcome.status, "cancelled");
  assert.match(fs.readFileSync(files.eventsFile, "utf8"), /thread.started/);
});
