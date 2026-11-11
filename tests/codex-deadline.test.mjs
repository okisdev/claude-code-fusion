import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { envFor, jobRecords, makeSandbox, runCompanion, waitFor } from "./lib/codex-companion-harness.mjs";

function stageRawTask(sandbox, raw, env = envFor(sandbox)) {
  const created = runCompanion(["transport-create"], { cwd: sandbox.workDir, env });
  assert.equal(created.status, 0, created.stderr);
  const transport = JSON.parse(created.stdout);
  fs.writeFileSync(transport.file, raw);
  return transport.token;
}

test("background shell transport gives foreground tasks a 900 second deadline", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const token = stageRawTask(sandbox, "inspect the budget", env);
  const before = Date.now();
  const result = runCompanion(["task", "--transport-background-shell", "--raw-args-token", token, "--json"], {
    cwd: sandbox.workDir, env
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Raw command transport requires exactly one token/);
  assert.equal(jobRecords(sandbox).length, 0);

  const accepted = runCompanion(["task", "--transport-background-shell", "--raw-args-token", token], {
    cwd: sandbox.workDir, env
  });
  const after = Date.now();
  assert.equal(accepted.status, 0, accepted.stderr);
  const [record] = jobRecords(sandbox);
  assert.equal(record.request.backgroundShellBudget, true);
  assert.equal(record.request.ingress, "staged_file");
  assert.equal(record.background, false);
  assert.equal(record.timeoutMs, 900000);
  assert.ok(Date.parse(record.deadlineAt) >= before + 900000);
  assert.ok(Date.parse(record.deadlineAt) <= after + 900000);
});

test("background shell flag leaves background jobs on their own timeout", async (t) => {
  for (const entry of [
    { args: [], timeoutMs: 1800000 },
    { args: ["--transport-background-shell"], timeoutMs: 7200, backgroundTimeout: "7200" }
  ]) {
    const sandbox = makeSandbox(t);
    const env = envFor(sandbox, {
      CODEX_COMPANION_BACKGROUND_SHELL_TIMEOUT_MS: "4300",
      ...(entry.backgroundTimeout ? { CODEX_COMPANION_BACKGROUND_TIMEOUT_MS: entry.backgroundTimeout } : {})
    });
    const token = stageRawTask(sandbox, "--background inspect the budget", env);
    const result = runCompanion(["task", ...entry.args, "--raw-args-token", token], {
      cwd: sandbox.workDir, env
    });
    assert.equal(result.status, 0, result.stderr);
    const record = await waitFor(() => jobRecords(sandbox).find((job) => job.status === "done"));
    assert.equal(record.request.backgroundShellBudget, false);
    assert.equal(record.background, true);
    assert.equal(record.timeoutMs, entry.timeoutMs);
    assert.ok(Date.parse(record.deadlineAt) >= Date.parse(record.startedAt) + entry.timeoutMs);
    assert.ok(Date.parse(record.deadlineAt) <= Date.now() + entry.timeoutMs);
  }
});

test("foreground defaults and shell override resolve independently", (t) => {
  for (const entry of [
    { raw: "inspect default", args: [], timeoutMs: 570000, applied: false },
    { raw: "inspect override", args: [], timeoutMs: 2400, applied: false, env: { CODEX_COMPANION_TIMEOUT_MS: "2400", CODEX_COMPANION_BACKGROUND_SHELL_TIMEOUT_MS: "4300" } },
    { raw: "inspect shell default", args: ["--transport-background-shell"], timeoutMs: 900000, applied: true, env: { CODEX_COMPANION_TIMEOUT_MS: "2400" } },
    { raw: "inspect shell override", args: ["--transport-background-shell"], timeoutMs: 4300, applied: true, env: { CODEX_COMPANION_TIMEOUT_MS: "2400", CODEX_COMPANION_BACKGROUND_SHELL_TIMEOUT_MS: "4300" } },
    { raw: "inspect invalid shell override", args: ["--transport-background-shell"], timeoutMs: 900000, applied: true, env: { CODEX_COMPANION_BACKGROUND_SHELL_TIMEOUT_MS: "invalid" } }
  ]) {
    const sandbox = makeSandbox(t);
    const env = envFor(sandbox, entry.env);
    const token = stageRawTask(sandbox, entry.raw, env);
    const before = Date.now();
    const result = runCompanion(["task", ...entry.args, "--raw-args-token", token], { cwd: sandbox.workDir, env });
    const after = Date.now();
    assert.equal(result.status, 0, result.stderr);
    const [record] = jobRecords(sandbox);
    assert.equal(record.request.backgroundShellBudget, entry.applied);
    assert.equal(record.timeoutMs, entry.timeoutMs);
    assert.ok(Date.parse(record.deadlineAt) >= before + entry.timeoutMs);
    assert.ok(Date.parse(record.deadlineAt) <= after + entry.timeoutMs);
  }
});

test("shell timeout and flagship warning name the applied override", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, {
    CODEX_COMPANION_TIMEOUT_MS: "2300",
    CODEX_COMPANION_BACKGROUND_SHELL_TIMEOUT_MS: "1500",
    FAKE_CODEX_MODE: "hang"
  });
  const token = stageRawTask(sandbox, "--write --skip-git-repo-check --model gpt-6-astra wait for timeout", env);
  const result = runCompanion(["task", "--transport-default-write", "--transport-background-shell", "--raw-args-token", token], {
    cwd: sandbox.workDir, env, timeout: 15000
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /1\.5s flight budget/);
  const [record] = jobRecords(sandbox);
  assert.equal(record.timeoutMs, 1500);
  assert.equal(record.request.backgroundShellBudget, true);
  assert.equal(record.failureKind, "timeout");
  assert.equal(record.errorMessage, "Codex timed out after 1500ms.");
  assert.ok(record.diagnostics.some((diagnostic) => diagnostic.message.includes("1.5s flight budget")));
});

test("foreground task deadline starts before the Codex version probe", (t) => {
  const sandbox = makeSandbox(t);
  const bin = path.join(sandbox.root, "slow-version-codex.mjs");
  fs.writeFileSync(bin, `#!/usr/bin/env node
import fs from "node:fs";
if (process.argv.includes("--version")) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  process.stdout.write("codex-cli 0.162.1\\n");
} else {
  fs.writeFileSync(process.env.FAKE_CODEX_ARGS_FILE, "spawned");
}
`, { mode: 0o700 });
  const result = runCompanion(["task", "--json", "check the deadline"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, {
      CODEX_BIN: bin,
      CODEX_COMPANION_TIMEOUT_MS: "1000"
    }),
    timeout: 15000
  });

  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stdout, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.failureKind, "timeout");
  assert.equal(record.status, "error");
  assert.equal(Object.hasOwn(record.request, "deadlineMs"), false);
  assert.equal(fs.existsSync(sandbox.argsFile), false);
  assert.equal(jobRecords(sandbox).length, 1);
});

for (const command of ["review", "adversarial-review"]) {
  test(`foreground ${command} deadline starts before the Codex version probe`, (t) => {
    const sandbox = makeSandbox(t);
    const bin = path.join(sandbox.root, "slow-version-codex.mjs");
    fs.writeFileSync(bin, `#!/usr/bin/env node
import fs from "node:fs";
if (process.argv.includes("--version")) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  process.stdout.write("codex-cli 0.162.1\\n");
} else {
  fs.writeFileSync(process.env.FAKE_CODEX_ARGS_FILE, "spawned");
}
`, { mode: 0o700 });
    const result = runCompanion([command, "--json"], {
      cwd: sandbox.workDir,
      env: envFor(sandbox, {
        CODEX_BIN: bin,
        CODEX_COMPANION_TIMEOUT_MS: "1000"
      }),
      timeout: 15000
    });

    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.equal(record.failureKind, "timeout");
    assert.equal(record.status, "error");
    assert.equal(Object.hasOwn(record.request, "deadlineMs"), false);
    assert.equal(fs.existsSync(sandbox.argsFile), false);
    assert.equal(jobRecords(sandbox).length, 1);
  });
}
