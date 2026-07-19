import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  envFor,
  jobRecords,
  makeSandbox,
  runCompanion,
  stateModulePath
} from "./lib/companion-harness.mjs";

const {
  createJobRecord,
  createJobRecordFile,
  jobFilePath
} = await import(stateModulePath);

function seedTerminalJob(sandbox, { id, status }) {
  const record = createJobRecord({
    id,
    cwd: sandbox.workDir,
    mode: "consult",
    briefFile: path.join(sandbox.dataDir, `${id}.md`),
    background: false,
    status
  });
  createJobRecordFile(jobFilePath(sandbox.dataDir, sandbox.workDir, id), {
    ...record,
    finishedAt: "2026-01-01T00:00:00.000Z",
    request: { effort: "high", model: "grok-test" }
  });
}

test("record-acceptance stores accepted and rejected semantic verdicts", (t) => {
  const sandbox = makeSandbox(t);
  const id = "a".repeat(32);
  seedTerminalJob(sandbox, { id, status: "done" });
  const accepted = runCompanion(["record-acceptance", "--job-id", id, "--acceptance", "accepted"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, `Recorded verdict for Grok job ${id}: accepted.\n`);
  let [record] = jobRecords(sandbox.dataDir);
  assert.equal(record.semanticStatus, "accepted");

  const rejected = runCompanion(["record-acceptance", "--job-id", id, "--acceptance", "rejected", "--reason", "Verification did not pass."], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(rejected.status, 0, rejected.stderr);
  [record] = jobRecords(sandbox.dataDir);
  assert.equal(record.semanticStatus, "rejected");
  assert.equal(record.semanticFailureMessage, "Verification did not pass.");
});

test("record-acceptance blocks accepted verdicts on failed transport by default", (t) => {
  const sandbox = makeSandbox(t);
  const id = "b".repeat(32);
  seedTerminalJob(sandbox, { id, status: "error" });
  const result = runCompanion(["record-acceptance", "--job-id", id, "--acceptance", "accepted"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--accept-failed-transport/);
  assert.equal(jobRecords(sandbox.dataDir)[0].semanticStatus, "unverified");
});

test("record-acceptance permits explicit acceptance of failed transport", (t) => {
  const sandbox = makeSandbox(t);
  const id = "c".repeat(32);
  seedTerminalJob(sandbox, { id, status: "error" });
  const result = runCompanion(["record-acceptance", "--job-id", id, "--acceptance", "accepted", "--accept-failed-transport"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `Recorded verdict for Grok job ${id}: accepted.\n`);
  const [record] = jobRecords(sandbox.dataDir);
  assert.equal(record.status, "error");
  assert.equal(record.semanticStatus, "accepted");
});

test("record-acceptance rejects unknown job ids", (t) => {
  const sandbox = makeSandbox(t);
  const id = "d".repeat(32);
  const result = runCompanion(["record-acceptance", "--job-id", id, "--acceptance", "accepted"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, new RegExp(`No job record found for ${id}`));
});
