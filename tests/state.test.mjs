import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const companion = path.join(repoRoot, "plugins", "grok", "scripts", "grok-companion.mjs");
const stateModulePath = path.join(repoRoot, "plugins", "grok", "scripts", "lib", "state.mjs");
const fakeGrok = path.join(import.meta.dirname, "fake-grok");

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-plugin-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const workDir = path.join(root, "work");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workDir);
  return { root, dataDir, workDir, argsFile: path.join(root, "args.jsonl") };
}

function envFor(sandbox, extra = {}) {
  const env = { ...process.env };
  delete env.FAKE_GROK_MODE;
  delete env.FAKE_GROK_ARGS_FILE;
  delete env.GROK_COMPANION_TIMEOUT_MS;
  delete env.CLAUDE_CODE_SESSION_ID;
  return {
    ...env,
    GROK_BIN: fakeGrok,
    GROK_COMPANION_DATA: sandbox.dataDir,
    FAKE_GROK_ARGS_FILE: sandbox.argsFile,
    ...extra,
  };
}

function runCompanion(args, options) {
  return spawnSync(process.execPath, [companion, ...args], {
    cwd: options.cwd,
    env: options.env,
    input: options.input ?? "",
    encoding: "utf8",
    timeout: 60000,
  });
}

function sha256Hex(value) {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const { createHash } = require('node:crypto'); process.stdout.write(createHash('sha256').update(process.argv[1]).digest('hex'));",
      value,
    ],
    { encoding: "utf8" },
  );
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function expectedSlug(cwd) {
  return `${path.basename(cwd)}-${sha256Hex(cwd).slice(0, 16)}`;
}

function workspaceDirs(dataDir) {
  const stateDir = path.join(dataDir, "state");
  if (!fs.existsSync(stateDir)) return [];
  return fs.readdirSync(stateDir).sort();
}

function jobCount(dataDir, slug) {
  const jobsDir = path.join(dataDir, "state", slug, "jobs");
  if (!fs.existsSync(jobsDir)) return 0;
  return fs.readdirSync(jobsDir).filter((name) => name.endsWith(".json")).length;
}

test("workspace slug is deterministic for a given cwd and distinct across cwds", (t) => {
  const sandbox = makeSandbox(t);
  const otherDir = path.join(sandbox.root, "other");
  fs.mkdirSync(otherDir);
  const env = envFor(sandbox);
  const first = runCompanion(["task", "first run"], { cwd: sandbox.workDir, env });
  assert.strictEqual(first.status, 0, first.stderr);
  const workSlug = expectedSlug(sandbox.workDir);
  assert.match(workSlug, /^work-[0-9a-f]{16}$/);
  assert.deepStrictEqual(workspaceDirs(sandbox.dataDir), [workSlug]);
  const second = runCompanion(["task", "second run"], { cwd: sandbox.workDir, env });
  assert.strictEqual(second.status, 0, second.stderr);
  assert.deepStrictEqual(workspaceDirs(sandbox.dataDir), [workSlug]);
  assert.strictEqual(jobCount(sandbox.dataDir, workSlug), 2);
  const third = runCompanion(["task", "third run"], { cwd: otherDir, env });
  assert.strictEqual(third.status, 0, third.stderr);
  const otherSlug = expectedSlug(otherDir);
  assert.deepStrictEqual(workspaceDirs(sandbox.dataDir), [otherSlug, workSlug].sort());
  assert.strictEqual(jobCount(sandbox.dataDir, otherSlug), 1);
});

test("state module exports a slug function implementing the pinned formula", async () => {
  const stateModule = await import(stateModulePath);
  const sample = "/opt/projects/sample-app";
  const expected = expectedSlug(sample);
  const mutatingName = (name) =>
    ["write", "update", "append"].some((prefix) => name.startsWith(prefix));
  const exportedFunctions = [];
  for (const [name, value] of Object.entries(stateModule)) {
    if (mutatingName(name)) continue;
    if (typeof value === "function") exportedFunctions.push(value);
    else if (value && typeof value === "object") {
      for (const [innerName, inner] of Object.entries(value)) {
        if (mutatingName(innerName)) continue;
        if (typeof inner === "function") exportedFunctions.push(inner);
      }
    }
  }
  const slugFn = exportedFunctions.find((candidate) => {
    try {
      return candidate(sample) === expected;
    } catch {
      return false;
    }
  });
  assert.ok(slugFn, "No export of state.mjs computes the pinned workspace slug.");
  assert.strictEqual(slugFn(sample), slugFn(sample));
  assert.strictEqual(slugFn("/opt/projects/other-app"), expectedSlug("/opt/projects/other-app"));
  assert.notStrictEqual(slugFn("/opt/projects/other-app"), slugFn(sample));
});

test("terminal job records do not regress to another terminal state", async (t) => {
  const sandbox = makeSandbox(t);
  const stateModule = await import(stateModulePath);
  const jobFile = stateModule.jobFilePath(sandbox.dataDir, sandbox.workDir, "terminal");
  const record = stateModule.createJobRecord({
    id: "terminal",
    pid: 123,
    mode: "consult",
    cwd: sandbox.workDir,
    briefFile: path.join(sandbox.dataDir, "brief.md"),
    background: false,
  });
  stateModule.writeJobRecordFile(jobFile, {
    ...record,
    status: "cancelled",
    pid: null,
    grokPid: null,
    finishedAt: stateModule.nowIso(),
    failureKind: "cancelled",
  });
  const updated = stateModule.updateJobRecordFile(jobFile, {
    status: "done",
    exitCode: 0,
    resultText: "late success",
    failureKind: null,
  });
  assert.strictEqual(updated.status, "cancelled");
  assert.strictEqual(updated.failureKind, "cancelled");
  assert.strictEqual(stateModule.readJobRecordFile(jobFile).status, "cancelled");
  const pidPatch = stateModule.updateJobRecordFile(jobFile, { pid: 999 });
  assert.strictEqual(pidPatch.pid, null);
});
