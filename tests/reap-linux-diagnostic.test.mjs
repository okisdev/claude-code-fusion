import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getProcessIdentity,
  isProcessAlive,
  runCodex
} from "../plugins/codex/scripts/lib/codex-exec.mjs";

const TIMEOUT_MS = 100;
const GRACE_MS = 8000;
const POLL_MS = 25;

const rolloutTimeoutChildSource = `
import fs from "node:fs";
import path from "node:path";

const diagnosticFile = process.env.REAP_DIAGNOSTIC_FILE;
const codexHome = process.env.CODEX_HOME;
const threadId = "reap-linux-diagnostic-thread";

function record(event) {
  fs.appendFileSync(diagnosticFile, JSON.stringify({ atMs: Date.now(), event }) + "\\n");
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}

function writeRollout() {
  const now = new Date();
  const directory = path.join(
    codexHome,
    "sessions",
    String(now.getFullYear()).padStart(4, "0"),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  );
  fs.mkdirSync(directory, { recursive: true });
  const entries = [
    {
      timestamp: now.toISOString(),
      type: "turn_context",
      payload: {
        model: "gpt-reap-diagnostic",
        collaboration_mode: { settings: { reasoning_effort: "xhigh" } }
      }
    },
    {
      timestamp: now.toISOString(),
      type: "event_msg",
      payload: { type: "agent_message", message: "Recovered diagnostic rollout output." }
    }
  ];
  fs.writeFileSync(path.join(directory, ["rollout-", threadId, ".jsonl"].join("")), entries.map((entry) => JSON.stringify(entry)).join("\\n") + "\\n");
  record("rollout-written");
}

record("child-started");
emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });
process.on("SIGINT", () => {
  record("received-SIGINT");
  writeRollout();
  process.exit(0);
});
process.on("exit", () => record("child-exit"));
setInterval(() => {}, 1000);
`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs, intervalMs = POLL_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms.`);
    }
    await delay(intervalMs);
  }
}

function processSnapshot(pid, kill) {
  let state = "absent";
  let pgrp = null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    state = fields[0] ?? "unknown";
    pgrp = Number(fields[2]) || null;
  } catch {}

  const signalable = (target) => {
    try {
      kill(target, 0);
      return "yes";
    } catch (error) {
      return error?.code ?? "error";
    }
  };

  return {
    directSignalable: signalable(pid),
    groupSignalable: signalable(-pid),
    pgrp,
    state
  };
}

function appendDiagnostic(t, startedAt, timeline, diagnosticFile) {
  let childTimeline = [];
  try {
    childTimeline = fs.readFileSync(diagnosticFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .map((entry) => ({ ...entry, atMs: entry.atMs - startedAt, source: "child" }));
  } catch {}
  const lines = [...timeline, ...childTimeline]
    .sort((left, right) => left.atMs - right.atMs)
    .map(({ atMs, event, source = "parent", ...details }) => `${Math.max(0, atMs).toFixed(1)}ms ${source} ${event}${Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : ""}`);
  t.diagnostic(["linux reap diagnostic", ...lines].join("\n"));
}

function sameIdentity(left, right) {
  return Boolean(
    left &&
      right &&
      left.version === right.version &&
      left.platform === right.platform &&
      left.bootMarker === right.bootMarker &&
      left.startMarker === right.startMarker &&
      left.commandHash === right.commandHash
  );
}

test("Linux rollout timeout reaps its detached process group within the grace window", async (t) => {
  if (process.platform === "darwin") {
    t.skip("Linux-only reap diagnostic: macOS does not expose Linux /proc process state.");
    return;
  }
  if (process.platform !== "linux") {
    t.skip(`Linux-only reap diagnostic: unsupported platform ${process.platform}.`);
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-reap-linux-diagnostic-"));
  const diagnosticFile = path.join(dir, "child-events.jsonl");
  const startedAt = Date.now();
  const timeline = [];
  const record = (event, details = {}) => timeline.push({ atMs: Date.now() - startedAt, event, ...details });
  const originalKill = process.kill;
  let childIdentity = null;
  let childPid = null;
  let observer = null;
  let previousSnapshot = null;
  let firstSignalAt = null;
  const signals = [];

  t.after(() => {
    if (observer) {
      clearInterval(observer);
    }
    if (Number.isInteger(childPid) && sameIdentity(getProcessIdentity(childPid), childIdentity)) {
      try {
        originalKill(-childPid, "SIGKILL");
      } catch {
        try {
          originalKill(childPid, "SIGKILL");
        } catch {}
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  process.kill = function tracedKill(target, signal) {
    if (Number.isInteger(childPid) && (target === childPid || target === -childPid) && signal && signal !== 0) {
      firstSignalAt ??= Date.now();
      signals.push({ signal, target });
      record("parent-signal", { signal, target });
    }
    return originalKill(target, signal);
  };

  try {
    let releaseCheckpoint;
    let enterCheckpoint;
    const checkpointEntered = new Promise((resolve) => {
      enterCheckpoint = resolve;
    });
    const execution = runCodex({
      args: ["--input-type=module", "--eval", rolloutTimeoutChildSource],
      bin: process.execPath,
      cwd: dir,
      env: {
        ...process.env,
        CODEX_HOME: path.join(dir, "codex-home"),
        REAP_DIAGNOSTIC_FILE: diagnosticFile
      },
      onCheckpoint: async ({ event }) => {
        if (event?.type !== "thread.started" || releaseCheckpoint) {
          return;
        }
        record("thread-started-checkpoint-entered");
        enterCheckpoint();
        await new Promise((resolve) => {
          releaseCheckpoint = resolve;
        });
        record("thread-started-checkpoint-released");
      },
      onSpawn: (pid, identity) => {
        childPid = pid;
        childIdentity = identity;
        record("child-spawned", { pid });
        observer = setInterval(() => {
          const snapshot = processSnapshot(pid, originalKill);
          const serialized = JSON.stringify(snapshot);
          if (serialized !== previousSnapshot) {
            previousSnapshot = serialized;
            record("process-state", snapshot);
          }
        }, POLL_MS);
      },
      terminationGraceMs: GRACE_MS,
      terminationPollMs: POLL_MS,
      timeoutMs: TIMEOUT_MS
    });

    await checkpointEntered;
    await delay(TIMEOUT_MS + POLL_MS);
    record("timeout-window-elapsed");
    releaseCheckpoint();
    const outcome = await execution;
    record("runCodex-settled", {
      cleanupComplete: outcome.cleanupComplete,
      signal: outcome.signal,
      status: outcome.status
    });

    assert.ok(Number.isInteger(childPid) && childPid > 1, "Expected a detached child pid.");
    assert.ok(firstSignalAt != null, "Expected the timeout path to signal the child process group.");
    assert.deepEqual(signals[0], { signal: "SIGINT", target: -childPid });
    assert.equal(outcome.status, "error", JSON.stringify(outcome));
    assert.equal(outcome.cleanupComplete, true, JSON.stringify(outcome));
    assert.equal(outcome.resultSource, "rollout_partial", JSON.stringify(outcome));
    await waitUntil(() => !isProcessAlive(childPid, null, true), GRACE_MS + POLL_MS * 2);
    const reapElapsedMs = Date.now() - firstSignalAt;
    record("source-reap-confirmed", { reapElapsedMs });
    assert.ok(reapElapsedMs <= GRACE_MS + POLL_MS * 2, `Expected process-group reap within ${GRACE_MS}ms, took ${reapElapsedMs}ms.`);
  } finally {
    process.kill = originalKill;
    if (observer) {
      clearInterval(observer);
    }
    appendDiagnostic(t, startedAt, timeline, diagnosticFile);
  }
});
