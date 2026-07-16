import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  envFor,
  makeSandbox,
  repoRoot,
  runCompanion,
  stateModulePath,
} from "./lib/companion-harness.mjs";

const {
  createJobRecord,
  jobFilePath,
  writeBrief,
} = await import(stateModulePath);
const { renderHistoryReport } = await import(
  path.join(repoRoot, "plugins", "grok", "scripts", "lib", "render.mjs")
);

const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);

function seedJob(sandbox, fields) {
  const cwd = fields.cwd ?? sandbox.workDir;
  fs.mkdirSync(cwd, { recursive: true });
  const briefFile = writeBrief(
    sandbox.dataDir,
    cwd,
    fields.id,
    fields.brief ?? `private brief ${fields.id}`
  );
  const status = fields.status ?? "done";
  const record = {
    ...createJobRecord({
      id: fields.id,
      pid: null,
      mode: fields.mode ?? "consult",
      cwd,
      briefFile,
      background: fields.background ?? false,
      delivery: fields.delivery,
      claudeSessionId: fields.claudeSessionId ?? null,
      createdAt: fields.createdAt,
      request: {
        model: null,
        effort: null,
        web: false,
        resumeSessionId: null,
        sandboxProfile: fields.sandboxProfile ?? "strict",
        memory: fields.memoryEnabled ?? false,
        privateRequestField: "must not appear in history"
      }
    }),
    jobClass: fields.jobClass ?? "task",
    status,
    finishedAt:
      fields.finishedAt ??
      (TERMINAL_STATUSES.has(status) ? "2026-07-16T00:10:00.000Z" : null),
    sessionId: fields.sessionId ?? null,
    resolvedModel: fields.resolvedModel ?? "grok-history-model",
    resolvedEffort: fields.resolvedEffort ?? "high",
    resultText: fields.resultText ?? "private stored result",
    errorTail: fields.errorTail ?? "private diagnostic tail",
    failureKind: fields.failureKind ?? null,
    cleanupRequired: fields.cleanupRequired ?? false,
    deliveryCollectedAt: fields.deliveryCollectedAt ?? null
  };
  const file = jobFilePath(sandbox.dataDir, cwd, fields.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

test("history defaults to the current workspace and returns a safe canonical projection", (t) => {
  const sandbox = makeSandbox(t);
  const sibling = path.join(sandbox.root, "sibling");
  const currentId = "11111111111111111111111111111111";
  const siblingId = "22222222222222222222222222222222";
  seedJob(sandbox, {
    id: currentId,
    cwd: sandbox.workDir,
    jobClass: "task",
    sessionId: "11111111-1111-7111-8111-111111111111",
    claudeSessionId: "history-current",
    createdAt: "2026-07-16T00:00:00.000Z"
  });
  seedJob(sandbox, {
    id: siblingId,
    cwd: sibling,
    jobClass: "review",
    sessionId: "22222222-2222-7222-8222-222222222222",
    claudeSessionId: "history-other",
    createdAt: "2026-07-16T00:01:00.000Z"
  });

  const result = runCompanion(["history", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "history-current" })
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.source, "canonical");
  assert.equal(payload.scope, "workspace");
  assert.equal(payload.cwd, sandbox.workDir);
  assert.equal(payload.totalJobs, 1);
  assert.equal(payload.returnedJobs, 1);
  assert.equal(payload.truncated, false);
  assert.equal(payload.jobs.length, 1);

  const [job] = payload.jobs;
  assert.equal(job.jobId, currentId);
  assert.equal(job.jobClass, "task");
  assert.equal(job.cwd, sandbox.workDir);
  assert.equal(job.resumable, true);
  assert.equal(job.resumeMode, "consult");
  assert.equal(job.memoryEnabled, false);
  assert.equal(job.ownedByCurrentSession, true);
  for (const privateField of [
    "briefFile",
    "claudeSessionId",
    "errorMessage",
    "errorTail",
    "request",
    "resultPayload",
    "resultText",
    "usage",
    "modelUsage"
  ]) {
    assert.equal(Object.hasOwn(job, privateField), false, privateField);
  }
  assert.doesNotMatch(result.stdout, /private brief|private stored result|private diagnostic tail|privateRequestField/);
  assert.doesNotMatch(result.stdout, new RegExp(siblingId));
});

test("history --all applies one newest-first limit across workspaces", (t) => {
  const sandbox = makeSandbox(t);
  const sibling = path.join(sandbox.root, "sibling");
  const oldestId = "33333333333333333333333333333333";
  const middleId = "44444444444444444444444444444444";
  const newestId = "55555555555555555555555555555555";
  seedJob(sandbox, {
    id: oldestId,
    cwd: sibling,
    sessionId: "33333333-3333-7333-8333-333333333333",
    createdAt: "2026-07-16T00:00:00.000Z"
  });
  seedJob(sandbox, {
    id: middleId,
    cwd: sandbox.workDir,
    sessionId: "44444444-4444-7444-8444-444444444444",
    claudeSessionId: "history-current",
    createdAt: "2026-07-16T00:01:00.000Z"
  });
  seedJob(sandbox, {
    id: newestId,
    cwd: sibling,
    jobClass: "review",
    sessionId: "55555555-5555-7555-8555-555555555555",
    claudeSessionId: "history-other",
    createdAt: "2026-07-16T00:02:00.000Z"
  });

  const result = runCompanion(["history", "--all", "--limit", "2", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "history-current" })
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.scope, "all");
  assert.equal(payload.cwd, null);
  assert.equal(payload.limit, 2);
  assert.equal(payload.totalJobs, 3);
  assert.equal(payload.returnedJobs, 2);
  assert.equal(payload.truncated, true);
  assert.deepEqual(
    payload.jobs.map((job) => job.jobId),
    [newestId, middleId]
  );
  assert.deepEqual(
    payload.jobs.map((job) => job.cwd),
    [sibling, sandbox.workDir]
  );
  assert.deepEqual(
    payload.jobs.map((job) => job.ownedByCurrentSession),
    [false, true]
  );
});

test("history reports resumability, job class, and Claude session ownership without conflating them", (t) => {
  const sandbox = makeSandbox(t);
  const cases = [
    {
      id: "66666666666666666666666666666666",
      jobClass: "task",
      status: "done",
      mode: "consult",
      sessionId: "66666666-6666-7666-8666-666666666666",
      claudeSessionId: "history-current",
      expectedResumable: true,
      expectedResumeMode: "consult",
      expectedMemoryEnabled: false,
      expectedOwned: true
    },
    {
      id: "77777777777777777777777777777777",
      jobClass: "review",
      status: "error",
      mode: "consult",
      sessionId: "77777777-7777-7777-8777-777777777777",
      claudeSessionId: "history-other",
      expectedResumable: false,
      expectedResumeMode: null,
      memoryEnabled: true,
      expectedMemoryEnabled: true,
      expectedOwned: false
    },
    {
      id: "88888888888888888888888888888888",
      jobClass: "best_of_n",
      status: "cancelled",
      mode: "write",
      sessionId: "88888888-8888-7888-8888-888888888888",
      claudeSessionId: "history-current",
      expectedResumable: false,
      expectedResumeMode: null,
      expectedMemoryEnabled: false,
      expectedOwned: true
    },
    {
      id: "99999999999999999999999999999999",
      jobClass: "task",
      status: "running",
      mode: "consult",
      sessionId: "99999999-9999-7999-8999-999999999999",
      claudeSessionId: "history-current",
      createdAt: "2099-07-16T00:03:00.000Z",
      expectedResumable: false,
      expectedResumeMode: null,
      expectedMemoryEnabled: false,
      expectedOwned: true
    },
    {
      id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      jobClass: "task",
      status: "done",
      mode: "consult",
      sessionId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
      sandboxProfile: "workspace",
      claudeSessionId: "history-current",
      expectedResumable: false,
      expectedResumeMode: null,
      expectedMemoryEnabled: false,
      expectedOwned: true
    },
    {
      id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      jobClass: "stop_gate",
      status: "done",
      mode: "consult",
      sessionId: "not-a-session",
      claudeSessionId: "history-current",
      expectedResumable: false,
      expectedResumeMode: null,
      expectedMemoryEnabled: false,
      expectedOwned: true
    },
    {
      id: "cccccccccccccccccccccccccccccccc",
      jobClass: "task",
      status: "error",
      mode: "write",
      sessionId: "cccccccc-cccc-7ccc-8ccc-cccccccccccc",
      claudeSessionId: "history-other",
      memoryEnabled: true,
      expectedResumable: true,
      expectedResumeMode: "write",
      expectedMemoryEnabled: true,
      expectedOwned: false
    }
  ];
  for (const [index, fields] of cases.entries()) {
    seedJob(sandbox, {
      ...fields,
      createdAt: fields.createdAt ?? `2026-07-16T00:0${index}:00.000Z`
    });
  }

  const result = runCompanion(["history", "--limit", "10", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "history-current" })
  });
  assert.equal(result.status, 0, result.stderr);
  const jobs = new Map(JSON.parse(result.stdout).jobs.map((job) => [job.jobId, job]));
  for (const expected of cases) {
    const job = jobs.get(expected.id);
    assert.ok(job, expected.id);
    assert.equal(job.jobClass, expected.jobClass);
    assert.equal(job.resumable, expected.expectedResumable);
    assert.equal(job.resumeMode, expected.expectedResumeMode);
    assert.equal(job.memoryEnabled, expected.expectedMemoryEnabled);
    assert.equal(job.ownedByCurrentSession, expected.expectedOwned);
  }

  const unknownOwnership = runCompanion(["history", "--limit", "1", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(unknownOwnership.status, 0, unknownOwnership.stderr);
  assert.equal(JSON.parse(unknownOwnership.stdout).jobs[0].ownedByCurrentSession, null);
});

test("history fails closed when one session has mixed recorded memory modes", (t) => {
  const sandbox = makeSandbox(t);
  const sessionId = "dededede-dede-7ded-8ded-dededededede";
  const disabledId = "dededededededededededededededede0";
  const enabledId = "dededededededededededededededede1";
  seedJob(sandbox, {
    id: disabledId,
    sessionId,
    memoryEnabled: false,
    createdAt: "2026-07-16T00:00:00.000Z"
  });
  seedJob(sandbox, {
    id: enabledId,
    sessionId,
    memoryEnabled: true,
    createdAt: "2026-07-16T00:01:00.000Z"
  });

  const result = runCompanion(["history", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 0, result.stderr);
  const jobs = JSON.parse(result.stdout).jobs;
  assert.equal(jobs.length, 2);
  assert.equal(jobs.every((job) => job.resumable === false), true);
  assert.equal(jobs.every((job) => job.resumeMode === null), true);
});

test("history limit validation fails closed with structured input errors", (t) => {
  const sandbox = makeSandbox(t);
  for (const args of [
    ["history", "--limit", "0", "--json"],
    ["history", "--limit", "1.5", "--json"],
    ["history", "--limit", "501", "--json"],
    ["history", "--limit", "garbage", "--json"],
    ["history", "unexpected", "--json"]
  ]) {
    const result = runCompanion(args, {
      cwd: sandbox.workDir,
      env: envFor(sandbox)
    });
    assert.notEqual(result.status, 0, args.join(" "));
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.failureKind, "input", args.join(" "));
  }
});

test("history ignores mismatched filenames and native Grok sessions while narrowing malformed fields", (t) => {
  const sandbox = makeSandbox(t);
  const validId = "dddddddddddddddddddddddddddddddd";
  seedJob(sandbox, {
    id: validId,
    sessionId: "dddddddd-dddd-7ddd-8ddd-dddddddddddd",
    createdAt: "2026-07-16T00:00:00.000Z"
  });

  const jobsDirectory = path.dirname(jobFilePath(sandbox.dataDir, sandbox.workDir, validId));
  const mismatchedFileId = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  fs.writeFileSync(
    path.join(jobsDirectory, `${mismatchedFileId}.json`),
    `${JSON.stringify({ id: "ffffffffffffffffffffffffffffffff", status: "done" })}\n`
  );
  const malformedId = "abababababababababababababababab";
  fs.writeFileSync(
    path.join(jobsDirectory, `${malformedId}.json`),
    `${JSON.stringify({
      id: malformedId,
      cwd: 42,
      status: { unsafe: true },
      jobClass: "attacker",
      mode: ["consult"],
      background: "yes",
      delivery: 7,
      deliveryStatus: {},
      semanticStatus: [],
      cleanupRequired: "yes",
      failureKind: "private diagnostic tail",
      resolvedModel: ["bad"],
      resolvedEffort: 99,
      createdAt: "not-a-date",
      finishedAt: 123,
      sessionId: "../../attacker",
      request: {}
    })}\n`
  );

  const nativeSession = path.join(
    sandbox.root,
    "grok-home",
    "sessions",
    encodeURIComponent(sandbox.workDir),
    "12121212-1212-7212-8212-121212121212"
  );
  fs.mkdirSync(nativeSession, { recursive: true });
  fs.writeFileSync(path.join(nativeSession, "summary.json"), "{}\n");

  const result = runCompanion(["history", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.totalJobs, 2);
  assert.equal(payload.jobs.some((job) => job.jobId === mismatchedFileId), false);
  assert.equal(payload.jobs.some((job) => job.sessionId === "12121212-1212-7212-8212-121212121212"), false);

  const malformed = payload.jobs.find((job) => job.jobId === malformedId);
  assert.ok(malformed);
  assert.equal(malformed.cwd, null);
  assert.equal(malformed.status, "unknown");
  assert.equal(malformed.jobClass, "unknown");
  assert.equal(malformed.mode, "unknown");
  assert.equal(malformed.background, false);
  assert.equal(malformed.cleanupRequired, false);
  assert.equal(malformed.failureKind, null);
  assert.equal(malformed.resolvedModel, null);
  assert.equal(malformed.resolvedEffort, null);
  assert.equal(malformed.createdAt, null);
  assert.equal(malformed.finishedAt, null);
  assert.equal(malformed.sessionId, null);
  assert.equal(malformed.resumable, false);
});

test("history text rendering escapes every dynamic markdown table cell", () => {
  const output = renderHistoryReport(
    {
      source: "canonical",
      scope: "all",
      cwd: null,
      limit: 1,
      totalJobs: 1,
      returnedJobs: 1,
      truncated: false,
      jobs: [
        {
          jobId: "job|cell\nnext",
          jobClass: "review<script>",
          status: "running|unsafe",
          mode: "consult\nmode",
          delivery: "manual|pending",
          deliveryStatus: "pending",
          resolvedModel: "grok|evil<script>",
          resolvedEffort: "high\ninjected",
          memoryEnabled: true,
          sessionId: "session|identifier",
          cwd: "/tmp/work|tree\n<script>",
          createdAt: "2026-07-16T00:00:00.000Z",
          resumable: false,
          ownedByCurrentSession: null,
          cleanupRequired: true
        }
      ]
    },
    Date.parse("2026-07-16T00:01:00.000Z")
  );

  assert.match(output, /job&#124;cell next/);
  assert.match(output, /review&lt;script&gt;/);
  assert.match(output, /running&#124;unsafe \(cleanup required\)/);
  assert.match(output, /grok&#124;evil&lt;script&gt; \(high injected\)/);
  assert.match(output, /\| yes \| session&#124;identifier \| no \| unknown \|/);
  assert.match(output, /\/tmp\/work&#124;tree &lt;script&gt;/);
  assert.doesNotMatch(output, /<script>/);
  assert.doesNotMatch(output, /job\|cell\nnext/);
});
