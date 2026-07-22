import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  envFor,
  jobRecords,
  makeSandbox,
  repoRoot,
  runCompanion
} from "./lib/companion-harness.mjs";
import { gitIsolation, initCleanRepo } from "./lib/git-fixture.mjs";

const grokExecPath = path.join(repoRoot, "plugins", "grok", "scripts", "lib", "grok-exec.mjs");
const { extractDeniedToolFromStderr, formatDeniedToolDetail } = await import(grokExecPath);

function writePermissionDeathGrok(sandbox, { stderrLine, exitCode = 1 } = {}) {
  const file = path.join(sandbox.root, "permission-death-grok.mjs");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
if (process.env.FAKE_GROK_ARGS_FILE) fs.appendFileSync(process.env.FAKE_GROK_ARGS_FILE, JSON.stringify(process.argv.slice(2)) + "\\n");
const sandboxIndex = process.argv.indexOf("--sandbox");
if (sandboxIndex >= 0) {
  const profile = process.argv[sandboxIndex + 1];
  const grokHome = Object.hasOwn(process.env, "GROK_HOME") ? path.resolve(process.cwd(), process.env.GROK_HOME) : path.join(os.homedir(), ".grok");
  fs.mkdirSync(grokHome, { recursive: true });
  fs.appendFileSync(path.join(grokHome, "sandbox-events.jsonl"), JSON.stringify({ event_type: "ProfileApplied", profile, workspace: fs.realpathSync(process.cwd()), enforced: true, restrict_network: profile !== "workspace", read_write_paths: [fs.realpathSync(process.cwd()), grokHome, process.env.TMPDIR].filter(Boolean) }) + "\\n");
  process.stderr.write("DEBUG xai_grok_agent::builder: tools allowlist applied\\n");
}
for await (const chunk of process.stdin) void chunk;
process.stderr.write(${JSON.stringify(`${stderrLine}\n`)});
process.exit(${exitCode});
`,
    "utf8"
  );
  fs.chmodSync(file, 0o755);
  return file;
}

function gitTopLevel(cwd) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    env: { ...process.env, ...gitIsolation },
    stdio: ["ignore", "pipe", "ignore"]
  });
  assert.equal(result.status, 0, result.stderr);
  return String(result.stdout ?? "").trim();
}

test("extractDeniedToolFromStderr names a denied tool when stderr reports it", () => {
  assert.equal(
    extractDeniedToolFromStderr("Error: permission denied for tool run_terminal_cmd\n"),
    "run_terminal_cmd"
  );
  assert.equal(
    extractDeniedToolFromStderr("Error: tool Bash was denied by the permission gate\n"),
    "Bash"
  );
  assert.equal(formatDeniedToolDetail("run_terminal_cmd"), "; denied tool: run_terminal_cmd");
});

test("extractDeniedToolFromStderr returns null when stderr has no tool name", () => {
  assert.equal(extractDeniedToolFromStderr("Error:\nOperation not permitted (os error 1)\n"), null);
  assert.equal(formatDeniedToolDetail(null), "");
});

test("permission death appends denied-tool detail when stderr names a tool", (t) => {
  const sandbox = makeSandbox(t);
  const grokBin = writePermissionDeathGrok(sandbox, {
    stderrLine: "Error: permission denied for tool run_terminal_cmd"
  });
  const result = runCompanion(["task", "attempt a blocked shell command"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { GROK_BIN: grokBin })
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^failure: permission$/m);
  assert.match(result.stderr, /denied tool: run_terminal_cmd/);
  assert.doesNotMatch(result.stderr, /blocked call not reported by the CLI/);
  const record = jobRecords(sandbox.dataDir)[0];
  assert.equal(record.failureKind, "permission");
  assert.match(record.errorMessage, /denied tool: run_terminal_cmd/);
  assert.doesNotMatch(record.errorMessage, /blocked call not reported by the CLI/);
});

test("permission death keeps the generic message when stderr omits a tool name", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "read a protected input"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "operation-not-permitted" })
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^failure: permission$/m);
  assert.match(result.stderr, /blocked call not reported by the CLI/);
  assert.doesNotMatch(result.stderr, /denied tool:/);
  const record = jobRecords(sandbox.dataDir)[0];
  assert.equal(record.failureKind, "permission");
  assert.match(record.errorMessage, /blocked call not reported by the CLI/);
  assert.doesNotMatch(record.errorMessage, /denied tool:/);
});

test("permission-cancelled death without a named tool stays generic", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "doomed"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "permission-cancelled" })
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^failure: permission$/m);
  assert.match(result.stderr, /blocked call not reported by the CLI/);
  assert.doesNotMatch(result.stderr, /denied tool:/);
  const record = jobRecords(sandbox.dataDir)[0];
  assert.equal(record.failureKind, "permission");
  assert.match(record.errorMessage, /blocked call not reported by the CLI/);
});

test("task job records repositoryTopLevel inside a git directory", (t) => {
  const sandbox = makeSandbox(t);
  initCleanRepo(sandbox.workDir);
  const expected = gitTopLevel(sandbox.workDir);
  const result = runCompanion(["task", "record the repository root"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 0, result.stderr);
  const record = jobRecords(sandbox.dataDir)[0];
  assert.equal(record.cwd, sandbox.workDir);
  assert.equal(record.repositoryTopLevel, expected);
});

test("task job records null repositoryTopLevel outside a git directory", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "record a missing repository root"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 0, result.stderr);
  const record = jobRecords(sandbox.dataDir)[0];
  assert.equal(record.cwd, sandbox.workDir);
  assert.equal(record.repositoryTopLevel, null);
});
