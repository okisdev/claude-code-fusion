import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { once } from "node:events";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { envFor as companionEnvFor, jobsMonitor, makeSandbox, stateModulePath } from "./lib/companion-harness.mjs";

const { createJobRecord, generateJobId, jobFilePath, writeBrief, writeJobRecordFile } = await import(
  pathToFileURL(stateModulePath).href
);

function envFor(sandbox, extra = {}) {
  return companionEnvFor(sandbox, { GROK_JOBS_MONITOR_INTERVAL_MS: "200", ...extra });
}

function seedJob(sandbox, fields = {}) {
  const id = fields.id ?? generateJobId();
  const briefFile = writeBrief(sandbox.dataDir, sandbox.workDir, id, "seeded job");
  const file = jobFilePath(sandbox.dataDir, sandbox.workDir, id);
  const record = {
    ...createJobRecord({
      id,
      pid: null,
      mode: "consult",
      cwd: sandbox.workDir,
      briefFile,
      background: true,
    }),
    ...fields,
    id,
    cwd: sandbox.workDir,
    briefFile,
  };
  writeJobRecordFile(file, record);
  return { file, record };
}

function startMonitor(sandbox, env) {
  const child = spawn(process.execPath, [jobsMonitor], {
    cwd: sandbox.workDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  return {
    child,
    lines: () => stdout.split("\n").filter(Boolean),
    stderr: () => stderr,
  };
}

async function waitUntil(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test("a pre-existing terminal job emits nothing on startup", async (t) => {
  const sandbox = makeSandbox(t);
  seedJob(sandbox, { status: "done", finishedAt: new Date().toISOString() });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepStrictEqual(monitor.lines(), []);
});

test("a job transitioning to done emits exactly one correctly shaped line", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running" });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepStrictEqual(monitor.lines(), []);

  writeJobRecordFile(file, {
    ...record,
    status: "done",
    finishedAt: new Date().toISOString(),
    resultText: "ALLOW",
  });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0], `grok job ${record.id} done. run /grok:result ${record.id} for the full output`);

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(monitor.lines().length, 1);
});

test("a job transitioning to error reports the failure kind", async (t) => {
  const sandbox = makeSandbox(t);
  const { file, record } = seedJob(sandbox, { status: "running" });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeJobRecordFile(file, {
    ...record,
    status: "error",
    finishedAt: new Date().toISOString(),
    failureKind: "died",
  });

  const lines = await waitUntil(() => (monitor.lines().length > 0 ? monitor.lines() : null));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(
    lines[0],
    `grok job ${record.id} error (died). run /grok:result ${record.id} for the full output`
  );
});

test("exits 0 on SIGTERM", async (t) => {
  const sandbox = makeSandbox(t);
  const monitor = startMonitor(sandbox, envFor(sandbox));
  await new Promise((resolve) => setTimeout(resolve, 200));
  monitor.child.kill("SIGTERM");
  const [code] = await once(monitor.child, "close");
  assert.strictEqual(code, 0);
});

test("skips silently when the jobs directory does not exist", async (t) => {
  const sandbox = makeSandbox(t);
  fs.rmSync(sandbox.dataDir, { recursive: true, force: true });
  const monitor = startMonitor(sandbox, envFor(sandbox));
  t.after(() => monitor.child.kill("SIGKILL"));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepStrictEqual(monitor.lines(), []);
  assert.strictEqual(monitor.stderr(), "");
});
