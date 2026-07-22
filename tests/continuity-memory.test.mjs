import assert from "node:assert";
import fs from "node:fs";
import { test } from "node:test";

import {
  envFor,
  hasPair,
  jobRecords,
  makeSandbox,
  readInvocations,
  runCompanion,
  stateModulePath,
  waitFor
} from "./lib/companion-harness.mjs";

const state = await import(stateModulePath);

function grokInvocations(sandbox) {
  return readInvocations(sandbox.argsFile).filter((argv) => argv.includes("--prompt-file"));
}

function newRecord(sandbox, before) {
  return jobRecords(sandbox.dataDir).find((record) => !before.has(record.id));
}

function runTask(sandbox, args, env) {
  return runCompanion(["task", ...args], { cwd: sandbox.workDir, env });
}

function enableClaudeSessionContinuity(sandbox, env) {
  const setup = runCompanion(["setup", "--continuity", "claude-session", "--json"], {
    cwd: sandbox.workDir,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).continuityPolicy, "claude-session");
}

function seedFinishedJob(
  sandbox,
  {
    jobClass,
    mode = "consult",
    sessionId,
    claudeSessionId = "claude-current",
    request = {}
  }
) {
  const id = state.generateJobId();
  const briefFile = state.writeBrief(sandbox.dataDir, sandbox.workDir, id, `${jobClass} seed`);
  const record = {
    ...state.createJobRecord({
      id,
      pid: null,
      mode,
      cwd: sandbox.workDir,
      briefFile,
      background: false,
      claudeSessionId,
      jobClass,
      request: {
        sandboxProfile: "strict",
        memory: false,
        ...request
      }
    }),
    status: "done",
    finishedAt: state.nowIso(),
    exitCode: 0,
    sessionId,
    resultText: `${jobClass} result`
  };
  state.writeJobRecordFile(state.jobFilePath(sandbox.dataDir, sandbox.workDir, id), record);
  return record;
}

function readTrackedEnv(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("manual continuity is the default and keeps consecutive tasks fresh", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "claude-current" });

  const first = runTask(sandbox, ["first task"], env);
  assert.equal(first.status, 0, first.stderr);
  const before = new Set(jobRecords(sandbox.dataDir).map((record) => record.id));

  const second = runTask(sandbox, ["second task"], env);
  assert.equal(second.status, 0, second.stderr);

  const invocations = grokInvocations(sandbox);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[1].includes("-r"), false);
  const record = newRecord(sandbox, before);
  assert.ok(record);
  assert.equal(record.request.continuityPolicy, "manual");
  assert.equal(record.request.resumeSessionId, null);
  assert.equal(record.request.resumeSourceJobId, null);
  assert.equal(record.request.resumeReason, null);
});

test("claude-session continuity resumes the latest compatible task and records its source", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "claude-current" });
  enableClaudeSessionContinuity(sandbox, env);

  const firstResult = runTask(sandbox, ["first task"], env);
  assert.equal(firstResult.status, 0, firstResult.stderr);
  const [source] = jobRecords(sandbox.dataDir);
  const before = new Set([source.id]);

  const secondResult = runTask(sandbox, ["second task"], env);
  assert.equal(secondResult.status, 0, secondResult.stderr);

  const invocations = grokInvocations(sandbox);
  assert.equal(invocations.length, 2);
  assert.equal(hasPair(invocations[1], "-r", source.sessionId), true);
  const resumed = newRecord(sandbox, before);
  assert.ok(resumed);
  assert.equal(resumed.request.continuityPolicy, "claude-session");
  assert.equal(resumed.request.resumeSessionId, source.sessionId);
  assert.equal(resumed.request.resumeSourceJobId, source.id);
  assert.equal(resumed.request.resumeReason, "affinity");
});

test("automatic continuity stays fresh without a Claude session", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  enableClaudeSessionContinuity(sandbox, env);

  assert.equal(runTask(sandbox, ["first task"], env).status, 0);
  const before = new Set(jobRecords(sandbox.dataDir).map((record) => record.id));
  const second = runTask(sandbox, ["second task"], env);
  assert.equal(second.status, 0, second.stderr);

  const invocations = grokInvocations(sandbox);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[1].includes("-r"), false);
  const record = newRecord(sandbox, before);
  assert.equal(record.request.resumeSessionId, null);
  assert.equal(record.request.resumeReason, null);
});

test("--fresh suppresses configured automatic continuity", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "claude-current" });
  enableClaudeSessionContinuity(sandbox, env);

  assert.equal(runTask(sandbox, ["first task"], env).status, 0);
  const before = new Set(jobRecords(sandbox.dataDir).map((record) => record.id));
  const second = runTask(sandbox, ["--fresh", "second task"], env);
  assert.equal(second.status, 0, second.stderr);

  const invocations = grokInvocations(sandbox);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[1].includes("-r"), false);
  const record = newRecord(sandbox, before);
  assert.equal(record.request.resumeSessionId, null);
  assert.equal(record.request.resumeReason, null);
});

test("Fusion routed briefs reject memory and never receive automatic continuity", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "claude-current" });
  enableClaudeSessionContinuity(sandbox, env);

  assert.equal(runTask(sandbox, ["first task"], env).status, 0);
  const before = new Set(jobRecords(sandbox.dataDir).map((record) => record.id));
  const routed = runTask(
    sandbox,
    ["fusion-brief: v1\ngrok-role: burst\nImplement the independent package."],
    env
  );
  assert.equal(routed.status, 0, routed.stderr);

  const invocations = grokInvocations(sandbox);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[1].includes("-r"), false);
  const record = newRecord(sandbox, before);
  assert.equal(record.request.resumeSessionId, null);
  assert.equal(record.request.resumeReason, null);

  const memory = runTask(
    sandbox,
    ["--memory", "fusion-brief: v1\ngrok-role: burst\nDo not import cross-session memory."],
    env
  );
  assert.notEqual(memory.status, 0);
  assert.match(memory.stderr, /memory is available only for direct ordinary tasks/);
  assert.equal(grokInvocations(sandbox).length, 2);
});

test("legacy review and stop gate jobs mislabeled as tasks are never resume-last candidates", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "claude-current" });
  seedFinishedJob(sandbox, {
    jobClass: "task",
    sessionId: "22222222-2222-7222-8222-222222222222",
    request: { reviewTargetLabel: "working tree changes" }
  });
  seedFinishedJob(sandbox, {
    jobClass: "task",
    sessionId: "33333333-3333-7333-8333-333333333333",
    request: { maxTurns: 15 }
  });
  const consult = runTask(sandbox, ["--resume-last", "continue consult"], env);
  assert.notEqual(consult.status, 0);
  assert.match(consult.stderr, /No finished consult grok task/);
  const write = runTask(sandbox, ["--write", "--resume-last", "continue write"], env);
  assert.notEqual(write.status, 0);
  assert.match(write.stderr, /No finished write grok task/);
  assert.equal(grokInvocations(sandbox).length, 0);
  assert.equal(jobRecords(sandbox.dataDir).length, 2);
});

test("memory is disabled by default and explicit --memory enables it in the Grok child", (t) => {
  const sandbox = makeSandbox(t);
  const defaultEnvFile = `${sandbox.root}/default-env.json`;
  const memoryEnvFile = `${sandbox.root}/memory-env.json`;

  const defaultRun = runTask(
    sandbox,
    ["default memory boundary"],
    envFor(sandbox, { FAKE_GROK_ENV_FILE: defaultEnvFile })
  );
  assert.equal(defaultRun.status, 0, defaultRun.stderr);
  assert.equal(readTrackedEnv(defaultEnvFile).GROK_MEMORY, "0");

  const memoryRun = runTask(
    sandbox,
    ["--memory", "enabled memory boundary"],
    envFor(sandbox, { FAKE_GROK_ENV_FILE: memoryEnvFile })
  );
  assert.equal(memoryRun.status, 0, memoryRun.stderr);
  assert.equal(readTrackedEnv(memoryEnvFile).GROK_MEMORY, "1");
  const memoryRecord = jobRecords(sandbox.dataDir).find((record) => record.request?.memory === true);
  assert.ok(memoryRecord);
});

test("background task workers preserve the requested memory boundary", async (t) => {
  const sandbox = makeSandbox(t);
  const envFile = `${sandbox.root}/background-env.json`;
  const launched = runTask(
    sandbox,
    ["--memory", "--background", "--json", "background memory task"],
    envFor(sandbox, { FAKE_GROK_ENV_FILE: envFile })
  );
  assert.equal(launched.status, 0, launched.stderr);
  const receipt = JSON.parse(launched.stdout);
  assert.equal(receipt.memoryEnabled, true);

  const status = runCompanion(["status", receipt.jobId, "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).memoryEnabled, true);

  const tracked = await waitFor(() => {
    if (!fs.existsSync(envFile)) {
      return null;
    }
    const value = readTrackedEnv(envFile);
    return value.GROK_MEMORY === "1" ? value : null;
  });
  assert.equal(tracked.GROK_MEMORY, "1");
  const completed = await waitFor(() => {
    const record = jobRecords(sandbox.dataDir).find((candidate) => candidate.id === receipt.jobId);
    return record?.status === "done" ? record : null;
  });
  assert.equal(completed.request.memory, true);

  const result = runCompanion(["result", receipt.jobId, "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).memoryEnabled, true);
});

test("resume rejects both directions of a recorded memory mismatch before launch", (t) => {
  const memorySandbox = makeSandbox(t);
  const memoryEnv = envFor(memorySandbox, { CLAUDE_CODE_SESSION_ID: "claude-current" });
  assert.equal(runTask(memorySandbox, ["--memory", "memory source"], memoryEnv).status, 0);
  const [memorySource] = jobRecords(memorySandbox.dataDir);
  const memoryInvocationCount = grokInvocations(memorySandbox).length;
  const withoutMemory = runTask(
    memorySandbox,
    ["--resume", memorySource.sessionId, "resume without memory"],
    memoryEnv
  );
  assert.notEqual(withoutMemory.status, 0);
  assert.match(withoutMemory.stderr, /must be resumed with --memory/);
  assert.equal(grokInvocations(memorySandbox).length, memoryInvocationCount);
  assert.equal(jobRecords(memorySandbox.dataDir).length, 1);

  const defaultSandbox = makeSandbox(t);
  const defaultEnv = envFor(defaultSandbox, { CLAUDE_CODE_SESSION_ID: "claude-current" });
  assert.equal(runTask(defaultSandbox, ["default source"], defaultEnv).status, 0);
  const [defaultSource] = jobRecords(defaultSandbox.dataDir);
  const defaultInvocationCount = grokInvocations(defaultSandbox).length;
  const withMemory = runTask(
    defaultSandbox,
    ["--memory", "--resume", defaultSource.sessionId, "resume with memory"],
    defaultEnv
  );
  assert.notEqual(withMemory.status, 0);
  assert.match(withMemory.stderr, /must be resumed without --memory/);
  assert.equal(grokInvocations(defaultSandbox).length, defaultInvocationCount);
  assert.equal(jobRecords(defaultSandbox.dataDir).length, 1);
});
