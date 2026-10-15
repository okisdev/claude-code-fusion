import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { envFor, jobRecords, makeSandbox, runCompanion } from "./lib/codex-companion-harness.mjs";

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
