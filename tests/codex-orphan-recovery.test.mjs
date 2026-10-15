import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { repairRunningRecordSync } from "../plugins/codex/scripts/codex-companion.mjs";
import { renderJobDetail, renderTerminalResult } from "../plugins/codex/scripts/lib/render.mjs";
import { createJobRecord, jobFilePath, readJobRecordFile, writeJobRecordFile } from "../plugins/codex/scripts/lib/state.mjs";
import { envFor, jobRecords, makeSandbox, runCompanion, waitFor } from "./lib/codex-companion-harness.mjs";
import { processInspectionAvailable } from "./lib/companion-harness.mjs";

test("the same orphan guidance appears in status and one result footer warning", () => {
  const orphanCleanupWarning = "stale Codex job abc left unverified process group 123; inspect the group manually and terminate it only after verifying ownership. No signal was sent.";
  const record = { id: "def", cwd: "/workspace", status: "done", resultText: "complete", orphanCleanupWarning };
  const warning = `warning: ${orphanCleanupWarning}`;
  assert.equal(renderTerminalResult(record).split("\n").filter((line) => line.startsWith("warning:")).length, 1);
  assert.ok(renderTerminalResult(record).includes(warning));
  assert.ok(renderJobDetail(record).includes(warning));
});

test("an unverified process group blocks for ten minutes, then permits reservation with manual cleanup guidance and no signal", async (t) => {
  if (process.platform === "win32" || !processInspectionAvailable()) {
    t.skip("process groups or process inspection unavailable in this environment");
    return;
  }
  const sandbox = makeSandbox(t);
  const readyFile = path.join(sandbox.root, "group-ready");
  const signalFile = path.join(sandbox.root, "group-signals");
  const pidFile = path.join(sandbox.root, "descendant-pid");
  const descendantCode = `
    import fs from "node:fs";
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      process.on(signal, () => fs.appendFileSync(process.argv[2], signal + "\\n"));
    }
    fs.writeFileSync(process.argv[1], "ready");
    setInterval(() => {}, 1000);
  `;
  const group = spawn(process.execPath, ["--input-type=module", "--eval", `
    import fs from "node:fs";
    import { spawn } from "node:child_process";
    const child = spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(descendantCode)}, process.argv[1], process.argv[2]], { stdio: "ignore" });
    fs.writeFileSync(process.argv[3], String(child.pid));
    child.unref();
  `, readyFile, signalFile, pidFile], { detached: true, stdio: "ignore" });
  const leaderExited = new Promise((resolve) => group.once("exit", resolve));
  t.after(() => {
    if (group.pid) {
      try { process.kill(-group.pid, "SIGKILL"); } catch { /* already exited */ }
    }
  });
  await leaderExited;
  await waitFor(() => fs.existsSync(readyFile));
  const descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.doesNotThrow(() => process.kill(descendantPid, 0));

  const started = Date.now();
  const at = (offset) => envFor(sandbox, {
    CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS: "0",
    CODEX_COMPANION_TEST_NOW_MS: String(started + offset)
  });
  const id = "a".repeat(32);
  const record = createJobRecord({
    id,
    cwd: sandbox.workDir,
    createdAt: new Date(started - 1000).toISOString(),
    pid: 99999999,
    codexPid: group.pid,
    codexPidIdentity: null,
    codexPidIdentitySettled: true,
    codexPidOwnsProcessGroup: true
  });
  const file = jobFilePath(sandbox.dataDir, sandbox.workDir, id);
  writeJobRecordFile(file, record);

  const first = repairRunningRecordSync({ record, file }, at(0));
  assert.equal(first.phase, "cleanup-required");
  assert.equal(first.cleanupRequiredAt, new Date(started).toISOString());
  assert.equal(first.orphanCleanupWarning, undefined);

  const before = runCompanion(["task", "another job"], { cwd: sandbox.workDir, env: at(599_999) });
  assert.equal(before.status, 1, before.stderr);
  assert.match(before.stderr, new RegExp(`Codex job ${id} is already running`));
  assert.equal(readJobRecordFile(file).cleanupRequiredAt, first.cleanupRequiredAt);
  assert.equal(jobRecords(sandbox).length, 1);
  const earlyStatus = runCompanion(["status", id], { cwd: sandbox.workDir, env: at(599_999) });
  assert.equal(earlyStatus.status, 0, earlyStatus.stderr);
  assert.doesNotMatch(earlyStatus.stdout, /warning: stale Codex job/);

  const after = runCompanion(["task", "another job"], { cwd: sandbox.workDir, env: at(600_000) });
  assert.equal(after.status, 0, after.stderr);
  const warnings = after.stdout.split("\n").filter((line) => line.startsWith("warning:"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], new RegExp(`stale Codex job ${id} left unverified process group ${group.pid}`));
  assert.match(warnings[0], /inspect the group manually and terminate it only after verifying ownership/);
  assert.equal(readJobRecordFile(file).status, "running");
  assert.equal(jobRecords(sandbox).length, 2);

  const detail = runCompanion(["status", id], { cwd: sandbox.workDir, env: at(600_000) });
  assert.equal(detail.status, 0, detail.stderr);
  assert.ok(detail.stdout.includes(warnings[0]));
  const listing = runCompanion(["status"], { cwd: sandbox.workDir, env: at(600_000) });
  assert.equal(listing.status, 0, listing.stderr);
  assert.ok(listing.stdout.includes(warnings[0]));
  assert.equal(fs.existsSync(signalFile), false, "the unverified group must receive no signal");
  assert.doesNotThrow(() => process.kill(descendantPid, 0));
});
