import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { getProcessIdentity, processIdentityMatches } from "../plugins/codex/scripts/lib/codex-exec.mjs";

import {
  DEFAULT_JOB_HISTORY_MAX_BYTES,
  DEFAULT_JOB_HISTORY_MAX_RECORDS,
  DEFAULT_LOCK_TIMEOUT_MS,
  TERMINAL_STATUSES,
  appendJobEvent,
  appendJobLog,
  briefPath,
  canonicalWorkspaceRoot,
  createJobRecord,
  findJobRecordById,
  finishJobRecordFile,
  generateJobId,
  jobEventsPath,
  jobFilePath,
  jobLogPath,
  listAllJobRecords,
  listJobRecords,
  markJobCollectedFile,
  pruneJobState,
  readJobRecordFile,
  readLogTail,
  repositoryIdentity,
  repositoryKey,
  resolveDataDir,
  resolveJobHistoryLimits,
  resolveLockTimeoutMs,
  updateJobRecordFile,
  updateJobRecordFileWithCurrent,
  withThreadLock,
  withWorkspaceLock,
  workspaceSlug,
  writeBrief,
  writeJobRecordFile
} from "../plugins/codex/scripts/lib/state.mjs";

const stateModuleUrl = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;

const processIdentityBin = fs.mkdtempSync(path.join(os.tmpdir(), "codex-state-identity-"));
fs.writeFileSync(
  path.join(processIdentityBin, "ps"),
  `#!/bin/sh
pid=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-p" ]; then
    pid="$2"
    shift 2
  else
    shift
  fi
done
printf "process-%s\\n" "$pid"
`
);
fs.writeFileSync(path.join(processIdentityBin, "sysctl"), '#!/bin/sh\nprintf "{ sec = 1, usec = 0 }\\n"\n');
fs.chmodSync(path.join(processIdentityBin, "ps"), 0o755);
fs.chmodSync(path.join(processIdentityBin, "sysctl"), 0o755);
test.after(() => fs.rmSync(processIdentityBin, { recursive: true, force: true }));

const serialLockChild = `
import fs from "node:fs";

const [stateUrl, dataDir, threadId, traceFile, name, holdMs] = process.argv.slice(1);
const { withThreadLock } = await import(stateUrl);
withThreadLock(dataDir, threadId, () => {
  const guardFile = \`\${traceFile}.guard\`;
  const descriptor = fs.openSync(guardFile, "wx", 0o600);
  try {
    fs.appendFileSync(traceFile, \`\${name}:enter\\n\`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
    fs.appendFileSync(traceFile, \`\${name}:exit\\n\`);
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(guardFile, { force: true });
  }
});
`;

const heldLockChild = `
import fs from "node:fs";

const [stateUrl, dataDir, threadId, readyFile, releaseFile] = process.argv.slice(1);
const { withThreadLock } = await import(stateUrl);
withThreadLock(dataDir, threadId, () => {
  fs.writeFileSync(readyFile, "ready\\n");
  while (!fs.existsSync(releaseFile)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
});
`;

const lockTimeoutChild = `
import fs from "node:fs";
const [stateUrl, dataDir, threadId, readyFile] = process.argv.slice(1);
const { withThreadLock } = await import(stateUrl);
fs.writeFileSync(readyFile, "ready\\n");
const startedAt = Date.now();
try {
  withThreadLock(dataDir, threadId, () => null);
  process.stdout.write(JSON.stringify({ elapsedMs: Date.now() - startedAt, message: null }));
} catch (error) {
  process.stdout.write(JSON.stringify({ elapsedMs: Date.now() - startedAt, message: error.message }));
}
`;

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-state-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const workDir = path.join(root, "work");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workDir);
  return { root, dataDir, workDir };
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function threadLockDir(dataDir, threadId) {
  const key = createHash("sha256").update(threadId).digest("hex");
  return path.join(dataDir, "locks", "threads", `${key}.lock`);
}

function runLockChild(source, args, env = process.env) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
  return { child, completion };
}

function identityChildEnv(extra = {}) {
  return { ...process.env, PATH: `${processIdentityBin}${path.delimiter}${process.env.PATH}`, ...extra };
}

async function waitForPath(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${file}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForCompletion(completion, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      completion,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Lock waiter exceeded ${timeoutMs}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function makeRecord(sandbox, fields = {}) {
  const id = fields.id ?? generateJobId();
  const briefFile = writeBrief(sandbox.dataDir, sandbox.workDir, id, "test brief");
  const record = createJobRecord({
    id,
    cwd: sandbox.workDir,
    briefFile,
    logFile: jobLogPath(sandbox.dataDir, sandbox.workDir, id),
    eventsFile: jobEventsPath(sandbox.dataDir, sandbox.workDir, id),
    mode: "consult",
    sessionId: "session-one",
    pid: process.pid,
    request: { model: "gpt-test", effort: "high" },
    ...fields
  });
  const file = jobFilePath(sandbox.dataDir, sandbox.workDir, id);
  writeJobRecordFile(file, record);
  return { file, record: readJobRecordFile(file) };
}

test("job ids contain 128 bits and records expose the canonical Codex fields", (t) => {
  const sandbox = makeSandbox(t);
  const firstId = generateJobId();
  const secondId = generateJobId();
  assert.match(firstId, /^[a-f0-9]{32}$/);
  assert.notStrictEqual(firstId, secondId);

  const pidIdentity = { version: 1, platform: "test", startMarker: "owner" };
  const codexPidIdentity = { version: 1, platform: "test", startMarker: "codex" };
  const { record } = makeRecord(sandbox, { id: firstId, pidIdentity, codexPid: 123, codexPidIdentity, threadId: "thread-1", turnId: "turn-1", tokenUsage: { totalTokens: 10 } });
  assert.strictEqual(record.schemaVersion, 1);
  assert.strictEqual(record.engine, "codex");
  assert.strictEqual(record.status, "running");
  assert.strictEqual(record.delivery, "foreground");
  assert.strictEqual(record.deliveryCollectedAt, null);
  assert.strictEqual(record.acceptanceSource, null);
  assert.strictEqual(record.acceptanceRecordedAt, null);
  assert.strictEqual(record.semanticStatus, "unverified");
  assert.strictEqual(record.serviceTier, null);
  assert.strictEqual(record.appliedServiceTier, null);
  assert.strictEqual(record.resolvedModel, "gpt-test");
  assert.strictEqual(record.resolvedEffort, "high");
  assert.strictEqual(record.collectedAt, null);
  assert.strictEqual(record.sessionId, "session-one");
  assert.strictEqual(record.claudeSessionId, "session-one");
  assert.strictEqual(record.pid, process.pid);
  assert.deepStrictEqual(record.pidIdentity, pidIdentity);
  assert.strictEqual(record.codexPid, 123);
  assert.deepStrictEqual(record.codexPidIdentity, codexPidIdentity);
  assert.strictEqual(record.launchApprovedAt, null);
  assert.strictEqual(record.launchAbortRequestedAt, null);
  assert.strictEqual(record.threadId, "thread-1");
  assert.strictEqual(record.turnId, "turn-1");
  assert.deepStrictEqual(record.tokenUsage, { totalTokens: 10 });
  assert.deepStrictEqual(record.request, { model: "gpt-test", effort: "high" });
  assert.match(record.repositoryKey, /^[a-f0-9]{16}$/);
  assert.deepStrictEqual([...TERMINAL_STATUSES].sort(), ["cancelled", "done", "error"]);
});

test("model drift round-trips as optional job record metadata", (t) => {
  const sandbox = makeSandbox(t);
  const modelDrift = {
    headerModel: "gpt-header",
    headerEffort: "xhigh",
    resolvedModel: "gpt-resolved"
  };
  const { file, record } = makeRecord(sandbox, { modelDrift });
  assert.deepStrictEqual(record.modelDrift, modelDrift);
  assert.deepStrictEqual(readJobRecordFile(file).modelDrift, modelDrift);
  const { record: withoutDrift } = makeRecord(sandbox);
  assert.strictEqual(Object.hasOwn(withoutDrift, "modelDrift"), false);
});

test("the data directory override and all artifact paths are deterministic", (t) => {
  const sandbox = makeSandbox(t);
  const dataDir = resolveDataDir({ CODEX_COMPANION_DATA: path.join(sandbox.root, "override") });
  assert.strictEqual(dataDir, path.join(sandbox.root, "override"));
  const id = "artifact-id";
  assert.match(jobFilePath(dataDir, sandbox.workDir, id), /artifact-id\.json$/);
  assert.match(jobLogPath(dataDir, sandbox.workDir, id), /artifact-id\.log$/);
  assert.match(jobEventsPath(dataDir, sandbox.workDir, id), /artifact-id\.events\.jsonl$/);
  assert.match(briefPath(dataDir, sandbox.workDir, id), /artifact-id\.md$/);
  assert.throws(() => jobFilePath(dataDir, sandbox.workDir, "../escape"), /Job id is invalid/);
});

test("a relative CODEX_COMPANION_DATA override fails closed with an input error naming the variable", () => {
  assert.throws(
    () => resolveDataDir({ CODEX_COMPANION_DATA: "relative/data" }),
    (error) => {
      assert.strictEqual(error.failureKind, "input");
      assert.match(error.message, /CODEX_COMPANION_DATA/);
      assert.match(error.message, /absolute/);
      return true;
    }
  );
});

test("atomic brief writes recover when history collection removes the empty parent directory", (t) => {
  const sandbox = makeSandbox(t);
  const id = "brief-directory-race";
  const file = briefPath(sandbox.dataDir, sandbox.workDir, id);
  const dir = path.dirname(file);
  const originalOpenSync = fs.openSync;
  let removed = false;
  fs.openSync = function openSyncWithDirectoryRemoval(target, ...args) {
    if (!removed && typeof target === "string" && path.dirname(target) === dir && target.endsWith(".tmp")) {
      removed = true;
      fs.rmdirSync(dir);
    }
    return originalOpenSync.call(this, target, ...args);
  };
  t.after(() => {
    fs.openSync = originalOpenSync;
  });

  assert.strictEqual(writeBrief(sandbox.dataDir, sandbox.workDir, id, "race-safe brief"), file);
  assert.strictEqual(removed, true);
  assert.strictEqual(fs.readFileSync(file, "utf8"), "race-safe brief");
  assert.strictEqual(mode(file), 0o600);
});

test("workspace and repository identity use the Git root and common directory", (t) => {
  const sandbox = makeSandbox(t);
  const repository = path.join(sandbox.root, "repository");
  const nested = path.join(repository, "src", "nested");
  fs.mkdirSync(nested, { recursive: true });
  const initialized = spawnSync("git", ["init", "--quiet", repository], { encoding: "utf8" });
  assert.strictEqual(initialized.status, 0, initialized.stderr);

  const expectedRoot = fs.realpathSync(repository);
  const expectedCommonDir = fs.realpathSync(path.join(repository, ".git"));
  assert.strictEqual(canonicalWorkspaceRoot(nested), expectedRoot);
  assert.strictEqual(repositoryIdentity(nested), expectedCommonDir);
  assert.strictEqual(repositoryKey(nested), repositoryKey(repository));
  assert.strictEqual(workspaceSlug(nested), workspaceSlug(repository));
});

test("state artifacts are private and append-only ledgers retain bounded tails", (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = makeRecord(sandbox);
  appendJobLog(record.logFile, "first line");
  appendJobLog(record.logFile, "second line");
  appendJobEvent(record.eventsFile, { type: "thread.started", thread_id: "thread-1" });
  appendJobEvent(record.eventsFile, { type: "turn.completed" });

  assert.strictEqual(mode(path.dirname(file)), 0o700);
  assert.strictEqual(mode(file), 0o600);
  assert.strictEqual(mode(record.briefFile), 0o600);
  assert.strictEqual(mode(record.logFile), 0o600);
  assert.strictEqual(mode(record.eventsFile), 0o600);
  assert.strictEqual(readLogTail(record.logFile, 1), "second line");
  const events = fs.readFileSync(record.eventsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepStrictEqual(events.map((event) => event.type), ["thread.started", "turn.completed"]);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter((entry) => entry.endsWith(".tmp")), []);
});

test("terminal records never regress or accept later enrichment", (t) => {
  const sandbox = makeSandbox(t);
  const { file } = makeRecord(sandbox);
  const finished = finishJobRecordFile(file, {
    status: "done",
    resultText: "finished",
    threadId: "thread-final",
    turnId: "turn-final",
    tokenUsage: { totalTokens: 20 }
  });
  assert.strictEqual(finished.status, "done");
  assert.strictEqual(finished.pid, null);
  assert.strictEqual(finished.pidIdentity, null);
  assert.strictEqual(finished.codexPid, null);
  assert.strictEqual(finished.codexPidIdentity, null);
  assert.ok(finished.finishedAt);

  const updated = updateJobRecordFile(file, { status: "error", failureKind: "protocol", resultText: "late failure", pid: 999 });
  assert.deepStrictEqual(updated, finished);
  writeJobRecordFile(file, { ...finished, status: "cancelled", resultText: "late cancel" });
  assert.deepStrictEqual(readJobRecordFile(file), finished);
  assert.deepStrictEqual(finishJobRecordFile(file, { status: "error", failureKind: "error" }), finished);
});

test("terminal finalization preserves the first finished timestamp", (t) => {
  const sandbox = makeSandbox(t);
  const { file } = makeRecord(sandbox);
  const firstFinishedAt = "2026-07-19T07:50:39.000Z";
  const laterFinishedAt = "2026-07-19T08:11:28.000Z";
  const first = finishJobRecordFile(file, { finishedAt: firstFinishedAt, status: "done" });
  const second = updateJobRecordFileWithCurrent(file, () => ({ finishedAt: laterFinishedAt, status: "done" }), { allowTerminal: true });

  assert.equal(first.finishedAt, firstFinishedAt);
  assert.equal(second.finishedAt, firstFinishedAt);
});

test("terminal finalization preserves acceptance provenance", (t) => {
  const sandbox = makeSandbox(t);
  const acceptanceRecordedAt = "2026-07-19T07:50:39.000Z";
  const { file } = makeRecord(sandbox, { acceptanceRecordedAt, acceptanceSource: "collector" });
  const finished = finishJobRecordFile(file, { status: "done" });

  assert.equal(finished.acceptanceSource, "collector");
  assert.equal(finished.acceptanceRecordedAt, acceptanceRecordedAt);
});

test("terminal collection is an atomic idempotent lifecycle transition", (t) => {
  const sandbox = makeSandbox(t);
  const running = makeRecord(sandbox, { id: "running-collection" });
  assert.strictEqual(markJobCollectedFile(running.file, "2025-01-01T00:00:00.000Z").collectedAt, null);

  const terminal = makeRecord(sandbox, { id: "terminal-collection" });
  finishJobRecordFile(terminal.file, { status: "done", resultText: "finished" });
  const collected = markJobCollectedFile(terminal.file, "2025-01-01T00:00:00.000Z");
  assert.strictEqual(collected.collectedAt, "2025-01-01T00:00:00.000Z");
  assert.deepStrictEqual(markJobCollectedFile(terminal.file, "2025-01-02T00:00:00.000Z"), collected);

  const managed = makeRecord(sandbox, { background: true, delivery: "managed", id: "managed-collection" });
  finishJobRecordFile(managed.file, { status: "done", resultText: "finished" });
  const managedCollected = markJobCollectedFile(managed.file, "2025-01-01T00:00:00.000Z");
  assert.strictEqual(managedCollected.deliveryCollectedAt, "2025-01-01T00:00:00.000Z");
});

test("a cancellation request wins a racing successful completion", (t) => {
  const sandbox = makeSandbox(t);
  const { file } = makeRecord(sandbox);
  updateJobRecordFile(file, { cancelRequestedAt: new Date().toISOString(), phase: "cancelling" });
  const final = finishJobRecordFile(file, { status: "done", resultText: "late success" });
  assert.strictEqual(final.status, "cancelled");
  assert.strictEqual(final.failureKind, "cancelled");
  assert.strictEqual(final.cancelRequestedAt, null);
});

test("lock-scoped updates see the current record and session aliases stay aligned", (t) => {
  const sandbox = makeSandbox(t);
  const { file } = makeRecord(sandbox);
  const legacyUpdated = updateJobRecordFile(file, { sessionId: "session-legacy" });
  assert.strictEqual(legacyUpdated.sessionId, "session-legacy");
  assert.strictEqual(legacyUpdated.claudeSessionId, "session-legacy");
  const updated = updateJobRecordFileWithCurrent(file, (current) => ({
    ...current,
    phase: "executing",
    codexPid: 456,
    threadId: "thread-current",
    claudeSessionId: "session-two"
  }));
  assert.strictEqual(updated.phase, "executing");
  assert.strictEqual(updated.codexPid, 456);
  assert.strictEqual(updated.threadId, "thread-current");
  assert.strictEqual(updated.sessionId, "session-two");
  assert.strictEqual(updated.claudeSessionId, "session-two");
});

test("workspace launch reservations serialize", (t) => {
  const sandbox = makeSandbox(t);
  const result = withWorkspaceLock(sandbox.dataDir, sandbox.workDir, () => "reserved");
  assert.strictEqual(result, "reserved");
});

test("thread reservations use a data-root-wide lock", (t) => {
  const sandbox = makeSandbox(t);
  assert.strictEqual(withThreadLock(sandbox.dataDir, "thread-1", () => "reserved"), "reserved");
  assert.throws(() => withThreadLock(sandbox.dataDir, "../escape", () => null), /Thread id is invalid/);
});

test("three processes serialize on the same thread lock", async (t) => {
  const sandbox = makeSandbox(t);
  const traceFile = path.join(sandbox.root, "lock-trace.log");
  const children = ["one", "two", "three"].map((name) => runLockChild(serialLockChild, [stateModuleUrl, sandbox.dataDir, "shared-thread", traceFile, name, "100"]));
  t.after(() => {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  const results = await Promise.all(children.map(({ completion }) => completion));
  for (const result of results) {
    assert.strictEqual(result.exitCode, 0, result.stderr);
  }
  const lines = fs.readFileSync(traceFile, "utf8").trim().split("\n");
  assert.strictEqual(lines.length, 6);
  const entrants = new Set();
  for (let index = 0; index < lines.length; index += 2) {
    const match = lines[index].match(/^(one|two|three):enter$/);
    assert.ok(match, lines.join("\n"));
    assert.strictEqual(lines[index + 1], `${match[1]}:exit`);
    entrants.add(match[1]);
  }
  assert.deepStrictEqual([...entrants].sort(), ["one", "three", "two"]);
  assert.strictEqual(fs.existsSync(`${traceFile}.guard`), false);
});

test("a held thread lock times out a second acquirer within the configured ceiling", async (t) => {
  const sandbox = makeSandbox(t);
  const threadId = "contended-thread";
  const readyFile = path.join(sandbox.root, "contention-ready");
  const releaseFile = path.join(sandbox.root, "contention-release");
  const waiterReadyFile = path.join(sandbox.root, "contention-waiter-ready");
  const timeoutMs = 150;
  const holder = runLockChild(heldLockChild, [stateModuleUrl, sandbox.dataDir, threadId, readyFile, releaseFile], identityChildEnv());
  t.after(() => {
    if (holder.child.exitCode === null && holder.child.signalCode === null) {
      holder.child.kill("SIGKILL");
    }
  });

  await waitForPath(readyFile);
  const waiter = runLockChild(lockTimeoutChild, [stateModuleUrl, sandbox.dataDir, threadId, waiterReadyFile], identityChildEnv({
    CODEX_COMPANION_LOCK_TIMEOUT_MS: String(timeoutMs)
  }));
  await waitForPath(waiterReadyFile);
  const result = await waitForCompletion(waiter.completion, timeoutMs + 500);
  assert.strictEqual(result.exitCode, 0, result.stderr);
  const outcome = JSON.parse(result.stdout);
  assert.match(outcome.message, /Timed out waiting for the job record lock at/);
  assert.ok(outcome.elapsedMs >= timeoutMs, `Expected the waiter to wait for at least ${timeoutMs}ms, took ${outcome.elapsedMs}ms.`);
  assert.ok(outcome.elapsedMs <= timeoutMs + 500, `Expected the waiter to finish near ${timeoutMs}ms, took ${outcome.elapsedMs}ms.`);

  fs.writeFileSync(releaseFile, "release\n");
  const holderResult = await holder.completion;
  assert.strictEqual(holderResult.exitCode, 0, holderResult.stderr);
});

test("a lock owned by a dead process is reclaimed without an age heuristic", async (t) => {
  const sandbox = makeSandbox(t);
  const threadId = "abandoned-thread";
  const readyFile = path.join(sandbox.root, "holder-ready");
  const releaseFile = path.join(sandbox.root, "holder-release");
  const holder = runLockChild(heldLockChild, [stateModuleUrl, sandbox.dataDir, threadId, readyFile, releaseFile]);
  t.after(() => {
    if (holder.child.exitCode === null && holder.child.signalCode === null) {
      holder.child.kill("SIGKILL");
    }
  });

  await waitForPath(readyFile);
  const lockDir = threadLockDir(sandbox.dataDir, threadId);
  const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
  assert.match(owner.token, /^[a-f0-9]{32}$/);
  assert.strictEqual(owner.ownerPid, holder.child.pid);
  assert.strictEqual(processIdentityMatches(owner.ownerPid, owner.ownerIdentity), true);

  holder.child.kill("SIGKILL");
  const holderResult = await holder.completion;
  assert.strictEqual(holderResult.signal, "SIGKILL", holderResult.stderr);
  assert.strictEqual(withThreadLock(sandbox.dataDir, threadId, () => "recovered"), "recovered");
  assert.strictEqual(fs.existsSync(lockDir), false);
});

test("a dead reaper claim is succeeded without wedging stale lock recovery", async (t) => {
  const sandbox = makeSandbox(t);
  const threadId = "dead-reaper-thread";
  const readyFile = path.join(sandbox.root, "dead-reaper-holder-ready");
  const releaseFile = path.join(sandbox.root, "dead-reaper-holder-release");
  const holder = runLockChild(heldLockChild, [stateModuleUrl, sandbox.dataDir, threadId, readyFile, releaseFile]);
  t.after(() => {
    if (holder.child.exitCode === null && holder.child.signalCode === null) {
      holder.child.kill("SIGKILL");
    }
  });

  await waitForPath(readyFile);
  const lockDir = threadLockDir(sandbox.dataDir, threadId);
  const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
  const ownerDir = path.resolve(path.dirname(lockDir), fs.readlinkSync(lockDir));
  holder.child.kill("SIGKILL");
  const holderResult = await holder.completion;
  assert.strictEqual(holderResult.signal, "SIGKILL", holderResult.stderr);

  const claimSlot = path.join(ownerDir, ".reap");
  const claimToken = "c".repeat(32);
  const claimOwnerDir = `${claimSlot}.owner.${claimToken}`;
  fs.mkdirSync(claimOwnerDir, { mode: 0o700 });
  fs.writeFileSync(path.join(claimOwnerDir, "owner.json"), `${JSON.stringify({ version: 1, token: claimToken, ownerPid: owner.ownerPid, ownerIdentity: owner.ownerIdentity })}\n`, { mode: 0o600 });
  fs.symlinkSync(path.basename(claimOwnerDir), claimSlot, "dir");

  assert.strictEqual(withThreadLock(sandbox.dataDir, threadId, () => "recovered"), "recovered");
  assert.strictEqual(fs.existsSync(lockDir), false);
  assert.strictEqual(fs.existsSync(ownerDir), false);
});

test("a live PID with a replaced process identity does not retain a lock", (t) => {
  const sandbox = makeSandbox(t);
  const threadId = "replaced-owner-thread";
  const lockDir = threadLockDir(sandbox.dataDir, threadId);
  const token = "a".repeat(32);
  const ownerDir = `${lockDir}.owner.${token}`;
  const ownerIdentity = getProcessIdentity(process.pid);
  const replacedIdentity = { ...ownerIdentity, commandHash: "0".repeat(64) };
  fs.mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(ownerDir, "owner.json"), `${JSON.stringify({ version: 1, token, ownerPid: process.pid, ownerIdentity: replacedIdentity })}\n`, { mode: 0o600 });
  fs.symlinkSync(path.basename(ownerDir), lockDir, "dir");

  assert.strictEqual(processIdentityMatches(process.pid, replacedIdentity), false);
  assert.strictEqual(withThreadLock(sandbox.dataDir, threadId, () => "recovered"), "recovered");
  assert.strictEqual(fs.existsSync(lockDir), false);
  assert.strictEqual(fs.existsSync(ownerDir), false);
});

test("an old holder cannot release a successor lock with a different token", async (t) => {
  const sandbox = makeSandbox(t);
  const threadId = "successor-thread";
  const readyFile = path.join(sandbox.root, "old-holder-ready");
  const releaseFile = path.join(sandbox.root, "old-holder-release");
  const holder = runLockChild(heldLockChild, [stateModuleUrl, sandbox.dataDir, threadId, readyFile, releaseFile]);
  t.after(() => {
    if (holder.child.exitCode === null && holder.child.signalCode === null) {
      holder.child.kill("SIGKILL");
    }
  });

  await waitForPath(readyFile);
  const lockDir = threadLockDir(sandbox.dataDir, threadId);
  fs.rmSync(lockDir, { recursive: true, force: true });
  fs.mkdirSync(lockDir, { mode: 0o700 });
  const successor = {
    version: 1,
    token: "b".repeat(32),
    ownerPid: process.pid,
    ownerIdentity: getProcessIdentity(process.pid)
  };
  fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify(successor)}\n`, { mode: 0o600 });
  fs.writeFileSync(releaseFile, "release\n");

  const holderResult = await holder.completion;
  assert.strictEqual(holderResult.exitCode, 0, holderResult.stderr);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")), successor);
  fs.rmSync(lockDir, { recursive: true, force: true });
});

test("corrupt JSON records are quarantined without hiding healthy jobs", (t) => {
  const sandbox = makeSandbox(t);
  const healthy = makeRecord(sandbox, { id: "healthy-job" });
  const corruptFile = jobFilePath(sandbox.dataDir, sandbox.workDir, "corrupt-job");
  fs.writeFileSync(corruptFile, "{not-json\n", { mode: 0o600 });

  assert.strictEqual(readJobRecordFile(corruptFile), null);
  assert.strictEqual(fs.existsSync(corruptFile), false);
  const quarantined = fs.readdirSync(path.dirname(corruptFile)).filter((entry) => entry.startsWith("corrupt-job.json.corrupt."));
  assert.strictEqual(quarantined.length, 1);
  assert.deepStrictEqual(listJobRecords(sandbox.dataDir, sandbox.workDir).map((record) => record.id), [healthy.record.id]);
});

test("structurally invalid records are preserved for forward compatibility and filename identity is enforced", (t) => {
  const sandbox = makeSandbox(t);
  const invalidFile = jobFilePath(sandbox.dataDir, sandbox.workDir, "invalid-job");
  fs.mkdirSync(path.dirname(invalidFile), { recursive: true });
  fs.writeFileSync(invalidFile, `${JSON.stringify({ id: "invalid-job", status: "mystery" })}\n`, { mode: 0o600 });
  assert.strictEqual(readJobRecordFile(invalidFile), null);
  assert.strictEqual(fs.existsSync(invalidFile), true);

  const mismatchedFile = jobFilePath(sandbox.dataDir, sandbox.workDir, "expected-job");
  const mismatched = createJobRecord({ cwd: sandbox.workDir, id: "different-job" });
  fs.writeFileSync(mismatchedFile, `${JSON.stringify(mismatched)}\n`, { mode: 0o600 });
  assert.deepStrictEqual(listJobRecords(sandbox.dataDir, sandbox.workDir), []);
});

test("semantic failure kinds accept legacy policy records and reject unknown values", (t) => {
  const sandbox = makeSandbox(t);
  const legacy = makeRecord(sandbox, { id: "legacy-policy", semanticFailureKind: "policy" });
  assert.equal(legacy.record.semanticFailureKind, "policy");

  const invalidFile = jobFilePath(sandbox.dataDir, sandbox.workDir, "invalid-semantic-failure-kind");
  const invalid = { ...createJobRecord({ cwd: sandbox.workDir, id: "invalid-semantic-failure-kind" }), semanticFailureKind: "arbitrary" };
  fs.writeFileSync(invalidFile, `${JSON.stringify(invalid)}\n`, { mode: 0o600 });
  assert.equal(readJobRecordFile(invalidFile), null);
});

test("global lookup rejects an id that is ambiguous across workspaces", (t) => {
  const sandbox = makeSandbox(t);
  const otherWorkDir = path.join(sandbox.root, "other-work");
  fs.mkdirSync(otherWorkDir);
  const id = "shared-job-id";
  makeRecord(sandbox, { id });
  const otherSandbox = { ...sandbox, workDir: otherWorkDir };
  makeRecord(otherSandbox, { id });

  assert.strictEqual(listAllJobRecords(sandbox.dataDir).length, 2);
  assert.throws(() => findJobRecordById(sandbox.dataDir, id), /Job id shared-job-id is ambiguous across workspaces/);
  assert.strictEqual(listJobRecords(sandbox.dataDir, sandbox.workDir)[0].id, id);
  assert.strictEqual(listJobRecords(sandbox.dataDir, otherWorkDir)[0].id, id);
});

test("job history limits have bounded defaults and accept explicit quotas", () => {
  assert.deepStrictEqual(resolveJobHistoryLimits({}), {
    maxBytes: DEFAULT_JOB_HISTORY_MAX_BYTES,
    maxRecords: DEFAULT_JOB_HISTORY_MAX_RECORDS
  });
  assert.deepStrictEqual(resolveJobHistoryLimits({ CODEX_COMPANION_HISTORY_MAX_BYTES: "4096", CODEX_COMPANION_HISTORY_MAX_RECORDS: "7" }), {
    maxBytes: 4096,
    maxRecords: 7
  });
  assert.deepStrictEqual(resolveJobHistoryLimits({ CODEX_COMPANION_HISTORY_MAX_BYTES: "invalid", CODEX_COMPANION_HISTORY_MAX_RECORDS: "-1" }), {
    maxBytes: DEFAULT_JOB_HISTORY_MAX_BYTES,
    maxRecords: DEFAULT_JOB_HISTORY_MAX_RECORDS
  });
});

test("CODEX_COMPANION_LOCK_TIMEOUT_MS overrides the default lock timeout", () => {
  assert.strictEqual(resolveLockTimeoutMs({ CODEX_COMPANION_LOCK_TIMEOUT_MS: "1" }), 1);
  assert.strictEqual(resolveLockTimeoutMs({ CODEX_COMPANION_LOCK_TIMEOUT_MS: "7500" }), 7500);
});

test("an invalid CODEX_COMPANION_LOCK_TIMEOUT_MS falls back to the default", () => {
  assert.strictEqual(resolveLockTimeoutMs({}), DEFAULT_LOCK_TIMEOUT_MS);
  assert.strictEqual(resolveLockTimeoutMs({ CODEX_COMPANION_LOCK_TIMEOUT_MS: "invalid" }), DEFAULT_LOCK_TIMEOUT_MS);
  assert.strictEqual(resolveLockTimeoutMs({ CODEX_COMPANION_LOCK_TIMEOUT_MS: "0" }), DEFAULT_LOCK_TIMEOUT_MS);
  assert.strictEqual(resolveLockTimeoutMs({ CODEX_COMPANION_LOCK_TIMEOUT_MS: "-5" }), DEFAULT_LOCK_TIMEOUT_MS);
  assert.strictEqual(resolveLockTimeoutMs({ CODEX_COMPANION_LOCK_TIMEOUT_MS: "1.5" }), DEFAULT_LOCK_TIMEOUT_MS);
});

test("job history collection removes oldest records while preserving running jobs, the current resume head, and its predecessor", (t) => {
  const sandbox = makeSandbox(t);
  const oldIds = [];
  for (let index = 0; index < 8; index += 1) {
    const id = `old-job-${String(index).padStart(2, "0")}`;
    oldIds.push(id);
    const createdAt = new Date(Date.UTC(2024, 0, index + 1)).toISOString();
    makeRecord(sandbox, { createdAt, finishedAt: createdAt, id, pid: null, status: "done", threadId: `old-thread-${index}` });
  }
  const source = makeRecord(sandbox, {
    createdAt: "2025-01-01T00:00:00.000Z",
    finishedAt: "2025-01-01T00:00:00.000Z",
    id: "resume-source",
    pid: null,
    request: { effort: "high" },
    sessionId: "current-session",
    status: "done",
    threadId: "current-thread"
  });
  const head = makeRecord(sandbox, {
    createdAt: "2025-01-02T00:00:00.000Z",
    finishedAt: "2025-01-02T00:00:00.000Z",
    id: "resume-head",
    pid: null,
    request: { resumeSourceJobId: source.record.id, resumeThreadId: "current-thread" },
    sessionId: "current-session",
    status: "done",
    threadId: "current-thread"
  });
  const running = makeRecord(sandbox, { createdAt: "2023-01-01T00:00:00.000Z", id: "running-job", sessionId: "other-session", status: "running" });
  const jobs = path.dirname(running.file);
  const unsafeRecord = path.join(jobs, "future-job.json");
  const unknownFile = path.join(jobs, "manual-state.bin");
  fs.writeFileSync(unsafeRecord, `${JSON.stringify({ engine: "codex", id: "future-job", schemaVersion: 2, status: "done" })}\n`, { mode: 0o600 });
  fs.writeFileSync(unknownFile, "keep\n", { mode: 0o600 });

  const result = pruneJobState(sandbox.dataDir, { claudeSessionId: "current-session", maxBytes: 1024 * 1024, maxRecords: 3 });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.quotaSatisfied, true);
  assert.strictEqual(result.deletedRecords, oldIds.length);
  assert.strictEqual(result.afterRecords, 3);
  assert.strictEqual(result.unrecognizedRecords, 1);
  assert.strictEqual(fs.existsSync(source.file), true);
  assert.strictEqual(fs.existsSync(head.file), true);
  assert.strictEqual(fs.existsSync(running.file), true);
  assert.strictEqual(fs.existsSync(unsafeRecord), true);
  assert.strictEqual(fs.existsSync(unknownFile), true);
  for (const id of oldIds) {
    assert.strictEqual(fs.existsSync(jobFilePath(sandbox.dataDir, sandbox.workDir, id)), false);
    assert.strictEqual(fs.existsSync(briefPath(sandbox.dataDir, sandbox.workDir, id)), false);
  }
});

test("job history collection enforces its managed byte quota and reports protected quota excess", (t) => {
  const sandbox = makeSandbox(t);
  const oldRecords = [];
  for (let index = 0; index < 3; index += 1) {
    const createdAt = new Date(Date.UTC(2024, 0, index + 1)).toISOString();
    const entry = makeRecord(sandbox, { createdAt, finishedAt: createdAt, id: `large-old-${index}`, pid: null, sessionId: "old-session", status: "done", threadId: `large-thread-${index}` });
    fs.writeFileSync(entry.record.logFile, "x".repeat(32 * 1024), { mode: 0o600 });
    oldRecords.push(entry);
  }
  const retained = makeRecord(sandbox, {
    createdAt: "2025-01-01T00:00:00.000Z",
    finishedAt: "2025-01-01T00:00:00.000Z",
    id: "large-current",
    pid: null,
    sessionId: "current-session",
    status: "done",
    threadId: "large-current-thread"
  });
  fs.writeFileSync(retained.record.logFile, "y".repeat(32 * 1024), { mode: 0o600 });

  const bounded = pruneJobState(sandbox.dataDir, { claudeSessionId: "current-session", maxBytes: 48 * 1024, maxRecords: 100 });
  assert.strictEqual(bounded.ok, true);
  assert.strictEqual(bounded.quotaSatisfied, true);
  assert.ok(bounded.afterBytes <= 48 * 1024);
  assert.strictEqual(fs.existsSync(retained.file), true);
  assert.ok(oldRecords.every((entry) => !fs.existsSync(entry.file)));

  const protectedRunning = makeRecord(sandbox, { id: "oversized-running", sessionId: "current-session", status: "running" });
  fs.writeFileSync(protectedRunning.record.logFile, "z".repeat(64 * 1024), { mode: 0o600 });
  const exceeded = pruneJobState(sandbox.dataDir, { claudeSessionId: "current-session", maxBytes: 1, maxRecords: 0 });
  assert.strictEqual(exceeded.ok, true);
  assert.strictEqual(exceeded.quotaSatisfied, false);
  assert.strictEqual(fs.existsSync(protectedRunning.file), true);
});

test("job history collection removes empty managed directories across many disposable workspaces", (t) => {
  const sandbox = makeSandbox(t);
  for (let index = 0; index < 20; index += 1) {
    const workDir = path.join(sandbox.root, `disposable-workspace-${index}`);
    fs.mkdirSync(workDir);
    const createdAt = new Date(Date.UTC(2024, 0, index + 1)).toISOString();
    makeRecord({ ...sandbox, workDir }, { createdAt, finishedAt: createdAt, id: `disposable-job-${index}`, pid: null, sessionId: "expired-session", status: "done", threadId: `disposable-thread-${index}` });
  }
  const emptyWorkDir = path.join(sandbox.root, "empty-disposable-workspace");
  fs.mkdirSync(emptyWorkDir);
  const emptyStateDir = path.join(sandbox.dataDir, "state", workspaceSlug(emptyWorkDir));
  fs.mkdirSync(path.join(emptyStateDir, "briefs"), { recursive: true });
  fs.mkdirSync(path.join(emptyStateDir, "jobs"));

  const result = pruneJobState(sandbox.dataDir, { claudeSessionId: "current-session", maxBytes: 0, maxRecords: 0 });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.quotaSatisfied, true);
  assert.strictEqual(result.deletedRecords, 20);
  assert.strictEqual(fs.existsSync(path.join(sandbox.dataDir, "state")), false);

  const unmanagedWorkspace = path.join(sandbox.dataDir, "state", "unmanaged-workspace");
  const marker = path.join(unmanagedWorkspace, "keep.txt");
  fs.mkdirSync(unmanagedWorkspace, { recursive: true });
  fs.writeFileSync(marker, "keep\n", { mode: 0o600 });
  pruneJobState(sandbox.dataDir, { claudeSessionId: "current-session", maxBytes: 0, maxRecords: 0 });
  assert.strictEqual(fs.readFileSync(marker, "utf8"), "keep\n");
});

test("job history collection fails closed without interrupting the caller", (t) => {
  const sandbox = makeSandbox(t);
  const invalidDataDir = path.join(sandbox.root, "not-a-directory");
  fs.writeFileSync(invalidDataDir, "occupied\n");
  const result = pruneJobState(invalidDataDir, { maxBytes: 1, maxRecords: 1 });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.deletedRecords, 0);
  assert.match(result.errorMessage, /directory|ENOTDIR|not a directory/i);
});
