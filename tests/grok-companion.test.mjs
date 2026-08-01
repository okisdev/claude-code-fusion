import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test as nodeTest } from "node:test";

import {
  envFor,
  flagValues,
  jobRecords,
  makeSandbox,
  processInspectionAvailable,
  readInvocations,
  repoRoot,
  runCompanion
} from "./lib/companion-harness.mjs";
import { gitIsolation, initCleanRepo } from "./lib/git-fixture.mjs";

const grokExecPath = path.join(repoRoot, "plugins", "grok", "scripts", "lib", "grok-exec.mjs");
const { extractDeniedToolFromStderr, formatDeniedToolDetail } = await import(grokExecPath);

const processInspectionTests = new Set([
  "permission death appends denied-tool detail when stderr names a tool",
  "permission death keeps the generic message when stderr omits a tool name",
  "permission-cancelled death without a named tool stays generic",
  "task job records repositoryTopLevel inside a git directory",
  "task accepts an explicit cwd below a repository top level",
  "task accepts an implicit cwd outside a Git repository",
  "task accepts an explicit repository top level from a subdirectory",
  "task job records null repositoryTopLevel outside a git directory",
  "task passes an inline JSON schema and renders structured success",
  "task fails with failure kind error for a structured output error",
  "task fails with failure kind error for a null structured output",
  "task parses text compatibility output only when structuredOutput is absent"
]);

function test(name, callback) {
  return nodeTest(name, (t) => {
    if (processInspectionTests.has(name) && !processInspectionAvailable()) {
      t.skip("process inspection unavailable in this environment");
      return;
    }
    return callback(t);
  });
}

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

function runGit(sandbox, args, options = {}) {
  return execFileSync("git", args, {
    ...options,
    cwd: options.cwd ?? sandbox.workDir,
    env: { ...process.env, ...gitIsolation(sandbox.root), ...options.env }
  });
}

function gitTopLevel(sandbox, cwd) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    env: { ...process.env, ...gitIsolation(sandbox.root) },
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
  const expected = gitTopLevel(sandbox, sandbox.workDir);
  const result = runCompanion(["task", "record the repository root"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 0, result.stderr);
  const record = jobRecords(sandbox.dataDir)[0];
  assert.equal(record.cwd, sandbox.workDir);
  assert.equal(record.repositoryTopLevel, expected);
});

test("task rejects an implicit cwd below a repository top level before creating a job", (t) => {
  const sandbox = makeSandbox(t);
  const repositoryTopLevel = fs.realpathSync(sandbox.workDir);
  const subdirectory = path.join(repositoryTopLevel, "apps", "api");
  fs.mkdirSync(subdirectory, { recursive: true });
  const canonicalSubdirectory = fs.realpathSync(subdirectory);
  runGit(sandbox, ["init", "--quiet"], { cwd: repositoryTopLevel });

  const result = runCompanion(["task", "inspect the API"], { cwd: canonicalSubdirectory, env: envFor(sandbox) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is inside repository/);
  assert.match(result.stderr, /state: error\nfailure: input\n$/);
  assert.deepEqual(jobRecords(sandbox.dataDir), []);
});

test("task accepts an explicit cwd below a repository top level", (t) => {
  const sandbox = makeSandbox(t);
  const repositoryTopLevel = fs.realpathSync(sandbox.workDir);
  const subdirectory = path.join(repositoryTopLevel, "apps", "api");
  fs.mkdirSync(subdirectory, { recursive: true });
  const canonicalSubdirectory = fs.realpathSync(subdirectory);
  runGit(sandbox, ["init", "--quiet"], { cwd: repositoryTopLevel });

  const result = runCompanion(["task", "--cwd", ".", "inspect the API"], { cwd: canonicalSubdirectory, env: envFor(sandbox) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /job: [a-f0-9]{32}\nsandbox: [^\n]+\nstate: done\n$/);
  assert.ok(result.stdout.includes(`sandbox: ${canonicalSubdirectory}\n`));
  assert.equal(jobRecords(sandbox.dataDir)[0].cwd, canonicalSubdirectory);
});

test("task accepts an implicit cwd outside a Git repository", (t) => {
  const sandbox = makeSandbox(t);
  const subdirectory = path.join(fs.realpathSync(sandbox.workDir), "apps", "api");
  fs.mkdirSync(subdirectory, { recursive: true });
  const canonicalSubdirectory = fs.realpathSync(subdirectory);

  const result = runCompanion(["task", "inspect the API"], { cwd: canonicalSubdirectory, env: envFor(sandbox) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(jobRecords(sandbox.dataDir)[0].cwd, canonicalSubdirectory);
});

test("task accepts an explicit repository top level from a subdirectory", (t) => {
  const sandbox = makeSandbox(t);
  const repositoryTopLevel = fs.realpathSync(sandbox.workDir);
  const subdirectory = path.join(repositoryTopLevel, "apps", "api");
  fs.mkdirSync(subdirectory, { recursive: true });
  const canonicalSubdirectory = fs.realpathSync(subdirectory);
  runGit(sandbox, ["init", "--quiet"], { cwd: repositoryTopLevel });

  const result = runCompanion(["task", "--cwd", repositoryTopLevel, "inspect the API"], { cwd: canonicalSubdirectory, env: envFor(sandbox) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(jobRecords(sandbox.dataDir)[0].cwd, repositoryTopLevel);
});

test("review rejects an implicit cwd below a repository top level before creating a job", (t) => {
  const sandbox = makeSandbox(t);
  const repositoryTopLevel = fs.realpathSync(sandbox.workDir);
  const subdirectory = path.join(repositoryTopLevel, "apps", "api");
  fs.mkdirSync(subdirectory, { recursive: true });
  const canonicalSubdirectory = fs.realpathSync(subdirectory);
  runGit(sandbox, ["init", "--quiet"], { cwd: repositoryTopLevel });

  const result = runCompanion(["review"], { cwd: canonicalSubdirectory, env: envFor(sandbox) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is inside repository/);
  assert.match(result.stderr, /state: error\nfailure: input\n$/);
  assert.deepEqual(jobRecords(sandbox.dataDir), []);
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

const taskSchema = JSON.stringify({
  type: "object",
  required: ["status", "summary", "files"],
  properties: {
    status: { type: "string" },
    summary: { type: "string" },
    files: { type: "array", items: { type: "string" } }
  }
});

test("task passes an inline JSON schema and renders structured success", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--json-schema", taskSchema, "--json", "complete the task"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "task-structured-success" })
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(flagValues(readInvocations(sandbox.argsFile)[0], "--json-schema"), [taskSchema]);
  assert.deepEqual(payload.structuredOutput, {
    status: "completed",
    summary: "The requested task completed.",
    files: ["src/app.mjs"]
  });
  assert.equal(payload.structuredOutputError, null);
  const [record] = jobRecords(sandbox.dataDir);
  assert.equal(record.request.jsonSchema, taskSchema);
  assert.deepEqual(record.structuredOutput, payload.structuredOutput);

  const human = runCompanion(["task", "--json-schema", taskSchema, "complete the task"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "task-structured-success" })
  });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /structured: parsed/);
});

for (const [mode, description] of [
  ["task-structured-error", "a structured output error"],
  ["task-structured-null", "a null structured output"]
]) {
  test(`task fails with failure kind error for ${description}`, (t) => {
    const sandbox = makeSandbox(t);
    const result = runCompanion(["task", "--json-schema", taskSchema, "complete the task"], {
      cwd: sandbox.workDir,
      env: envFor(sandbox, { FAKE_GROK_MODE: mode })
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /failed validation/);
    assert.match(result.stderr, /state: error\nfailure: error/);
    const [record] = jobRecords(sandbox.dataDir);
    assert.equal(record.status, "error");
    assert.equal(record.failureKind, "error");
    assert.equal(record.structuredOutput, null);
  });
}

test("task parses text compatibility output only when structuredOutput is absent", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--json-schema", taskSchema, "--json", "complete the task"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "task-structured-absent" })
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.structuredOutput, {
    status: "completed",
    summary: "The requested task completed.",
    files: ["src/app.mjs"]
  });
  assert.equal(payload.structuredOutputError, null);
  assert.match(payload.text, /Here is the result/);
});

test("task rejects invalid and oversized inline schemas before launch", (t) => {
  const cases = [
    { schema: "not-json", viaTransport: false },
    { schema: JSON.stringify("x".repeat(256 * 1024)), viaTransport: true }
  ];
  for (const { schema, viaTransport } of cases) {
    const sandbox = makeSandbox(t);
    let result;
    if (viaTransport) {
      const created = runCompanion(["transport-create"], { cwd: sandbox.workDir, env: envFor(sandbox) });
      assert.equal(created.status, 0, created.stderr);
      const transport = JSON.parse(created.stdout);
      fs.writeFileSync(transport.file, `--json-schema ${schema} -- complete the task`);
      result = runCompanion(["task", "--raw-args-token", transport.token], {
        cwd: sandbox.workDir,
        env: envFor(sandbox)
      });
    } else {
      result = runCompanion(["task", "--json-schema", schema, "complete the task"], {
        cwd: sandbox.workDir,
        env: envFor(sandbox)
      });
    }

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /failure: input/);
    assert.deepEqual(readInvocations(sandbox.argsFile), []);
    assert.deepEqual(jobRecords(sandbox.dataDir), []);
  }
});
