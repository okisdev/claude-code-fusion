import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as nodeTest } from "node:test";
import { pathToFileURL } from "node:url";

import {
  createJobRecord,
  jobFilePath,
  jobLogPath,
  resolveDataDir,
  writeJobRecordFile
} from "../plugins/codex/scripts/lib/state.mjs";
import { getProcessIdentity } from "../plugins/codex/scripts/lib/codex-exec.mjs";
import { parseTaskHeader, repairRunningRecordSync, runningRecordNeedsReconciliation } from "../plugins/codex/scripts/codex-companion.mjs";
import {
  companion,
  envFor,
  jobEntries,
  jobRecords,
  makeSandbox,
  readArgs,
  repoRoot,
  runCompanion,
  spawnCompanion,
  waitFor
} from "./lib/codex-companion-harness.mjs";
import { processInspectionAvailable } from "./lib/companion-harness.mjs";
import { gitIsolation } from "./lib/git-fixture.mjs";

const processInspectionTests = new Set([
  "task accepts an explicit cwd below a repository top level",
  "task preflight auto passes the Git bypass for consults and rejects writes outside Git",
  "task accepts an explicit repository top level from a subdirectory",
  "identity-replaced owners are terminalized without signaling the live replacement",
  "task stays foreground by default and persists the complete terminal record",
  "sol foreground write warning is emitted before execution and recorded",
  "sol warning is limited to foreground write tasks",
  "task resolves an output schema, forwards it, and records parsed structured output",
  "task retains a non-JSON agent message and records the structured parsing error",
  "option shaped text after a task prompt cannot enable background or change execution settings",
  "single raw task arguments preserve prompt whitespace byte for byte",
  "structured raw transport preserves shell syntax without evaluating it",
  "a staged Fusion worktree request selects the Codex cwd and workspace root",
  "programmatic stdin ingress preserves opaque raw arguments without a staging file",
  "rescue transport write defaults remain overridable by raw arguments",
  "task forces safe disabled defaults and rejects network access without write mode",
  "task proceeds with tested, alpha hotfix, and newer Codex CLI versions",
  "structured nonzero diagnostics persist typed auth, quota, and rate limit failures",
  "final response prose cannot promote or reject semantic acceptance",
  "job records retain request-seeded model and effort without runtime observations",
  "rollout observations replace request-seeded model and effort",
  "task records and renders model drift from a brief header",
  "an explicit task model suppresses header model drift",
  "a matching task header model does not create model drift",
  "a task without a header does not create model drift",
  "task forwards --skip-git-repo-check to Codex",
  "trusted-directory failures store and render the skip-git remedy",
  "record-acceptance stores accepted and rejected semantic verdicts",
  "record-acceptance requires a reason for rejected verdicts",
  "record-acceptance permits failure kinds only for rejected verdicts",
  "record-acceptance rejects unknown semantic failure kinds",
  "record-acceptance stamps default stats provenance",
  "record-acceptance stamps explicit provenance",
  "record-acceptance blocks accepted verdicts on failed transport by default",
  "record-acceptance permits explicit acceptance of failed transport",
  "foreground timeout persists recovered partial delivery and incomplete cumulative usage",
  "timeout jobs without a thread do not advertise resumability",
  "policy failures with a live thread are resumable while unrelated failures are not",
  "history lists canonical jobs across workspaces with local thread and delivery metadata",
  "explicit background launch returns a durable receipt and result wait collects it",
  "managed background delivery remains pending until result collection",
  "tight history quotas retain a completed background review until result collects it",
  "result wait leaves a live background job running when its bounded wait expires",
  "workspace reservation makes simultaneous task launches single flight",
  "a single-flight bounce retains staged raw arguments for one retry",
  "main workspace and a sibling worktree admit concurrent tasks for the same repository",
  "resume-last uses the current Claude session without claiming an unverifiable usage delta",
  "resume-last inherits model, effort, and service tier from its thread",
  "resume applies explicit routing flags per field while inheriting the remaining fields",
  "fresh tasks do not inherit routing from prior threads",
  "completed tasks enforce configured history quotas without breaking resume-last",
  "resume-last never crosses Claude sessions when a session id is available",
  "resumed usage remains unavailable across workspaces while the thread lease stays reusable",
  "the same Codex thread cannot resume concurrently across workspaces",
  "plain native review uses target flags and focus switches to a read only task prompt",
  "adversarial review is a normal read only task with the explicit review contract",
  "cancel terminates the supervised process group and terminal state cannot be overwritten",
  "SIGHUP stays attached until the foreground Codex group is cancelled",
  "SIGQUIT stays attached until the foreground Codex group is cancelled",
  "a second interrupt cannot bypass foreground cleanup",
  "cancel retains a live PID when its ownership identity is unavailable",
  "an incomplete timeout cleanup retains process evidence for retry",
  "session-end cancels only jobs owned by the ending Claude session",
  "status repairs an ownerless running record as died"
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

function usage(inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens) {
  return JSON.stringify({
    cached_input_tokens: cachedInputTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningOutputTokens
  });
}

function childResult(child) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
}

function createTransport(sandbox, raw, env = envFor(sandbox)) {
  const created = runCompanion(["transport-create"], { cwd: sandbox.workDir, env });
  assert.equal(created.status, 0, created.stderr);
  const transport = JSON.parse(created.stdout);
  assert.match(transport.token, /^[a-f0-9]{48}$/);
  assert.match(transport.file, /^[A-Za-z0-9_./:\\-]+$/);
  fs.writeFileSync(transport.file, raw, "utf8");
  return { ...transport, ownerFile: path.join(path.dirname(transport.file), "owner.json") };
}

function runGit(sandbox, args, options = {}) {
  return execFileSync("git", args, {
    ...options,
    cwd: options.cwd ?? sandbox.workDir,
    env: { ...process.env, ...gitIsolation(sandbox.root), ...options.env }
  });
}

function initializeGitRepository(sandbox, cwd = sandbox.workDir) {
  runGit(sandbox, ["init", "--quiet"], { cwd });
}

test("fake Codex rejects unmodelled top level subcommands", () => {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "tests", "fake-codex"), "doctor"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "error: subcommand not modelled by fake-codex: doctor\n");
});

test("task header parsing captures model and effort only from a pipe-separated header", () => {
  assert.deepEqual(
    parseTaskHeader("\n  lane: codex | MODEL: gpt-5.6-terra | Effort: xhigh | verification: node --test\nImplement the change."),
    { headerModel: "gpt-5.6-terra", headerEffort: "xhigh" }
  );
  assert.deepEqual(parseTaskHeader("Implement the change."), { headerModel: null, headerEffort: null });
  assert.deepEqual(parseTaskHeader("model: gpt-5.6-terra"), { headerModel: null, headerEffort: null });
  assert.deepEqual(parseTaskHeader("lane: codex | model: gpt-5.6-terra"), { headerModel: "gpt-5.6-terra", headerEffort: null });
});

test("task rejects an implicit cwd below a repository top level before creating a job", (t) => {
  const sandbox = makeSandbox(t);
  const subdirectory = path.join(sandbox.workDir, "apps", "api");
  fs.mkdirSync(subdirectory, { recursive: true });
  runGit(sandbox, ["init", "--quiet"]);

  const result = runCompanion(["task", "inspect the API"], { cwd: subdirectory, env: envFor(sandbox) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /is inside repository/);
  assert.equal(jobRecords(sandbox).length, 0);
});

test("task accepts an explicit cwd below a repository top level", (t) => {
  const sandbox = makeSandbox(t);
  const subdirectory = path.join(sandbox.workDir, "apps", "api");
  fs.mkdirSync(subdirectory, { recursive: true });
  runGit(sandbox, ["init", "--quiet"]);

  const result = runCompanion(["task", "--cwd", ".", "inspect the API"], { cwd: subdirectory, env: envFor(sandbox) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(jobRecords(sandbox)[0].diagnostics.some((diagnostic) => diagnostic.type === "warning"), false);
});

test("task preflight auto passes the Git bypass for consults and rejects writes outside Git", (t) => {
  const sandbox = makeSandbox(t);
  const subdirectory = path.join(sandbox.workDir, "apps", "api");
  fs.mkdirSync(subdirectory, { recursive: true });

  const consult = runCompanion(["task", "inspect the API"], { cwd: subdirectory, env: envFor(sandbox) });

  assert.equal(consult.status, 0, consult.stderr);
  assert.equal(consult.stderr, "");
  assert.ok(readArgs(sandbox).includes("--skip-git-repo-check"));
  assert.equal(jobRecords(sandbox)[0].request.skipGitRepoCheck, false);
  fs.rmSync(sandbox.argsFile);

  const write = runCompanion(["task", "--write", "implement the API"], { cwd: subdirectory, env: envFor(sandbox) });

  assert.equal(write.status, 1);
  assert.match(write.stderr, /--skip-git-repo-check/);
  assert.match(write.stderr, /failure: input/);
  assert.equal(fs.existsSync(sandbox.argsFile), false);
  assert.equal(jobRecords(sandbox).length, 1);
});

test("task accepts an explicit repository top level from a subdirectory", (t) => {
  const sandbox = makeSandbox(t);
  const subdirectory = path.join(sandbox.workDir, "apps", "api");
  fs.mkdirSync(subdirectory, { recursive: true });
  runGit(sandbox, ["init", "--quiet"]);

  const workspaceRoot = fs.realpathSync(sandbox.workDir);
  const result = runCompanion(["task", "--cwd", workspaceRoot, "inspect the API"], { cwd: subdirectory, env: envFor(sandbox) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(jobRecords(sandbox)[0].cwd, workspaceRoot);
  assert.equal(jobRecords(sandbox)[0].diagnostics.some((diagnostic) => diagnostic.type === "warning"), false);
});

test("review commands reject an implicit cwd below a repository top level before creating a job", (t) => {
  const sandbox = makeSandbox(t);
  const subdirectory = path.join(sandbox.workDir, "apps", "api");
  fs.mkdirSync(subdirectory, { recursive: true });
  runGit(sandbox, ["init", "--quiet"]);

  for (const command of ["review", "adversarial-review"]) {
    const result = runCompanion([command], { cwd: subdirectory, env: envFor(sandbox) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /is inside repository/);
  }
  assert.equal(jobRecords(sandbox).length, 0);
});

test("job records capture the repository top level without requiring a Git repository", (t) => {
  const sandbox = makeSandbox(t);
  const repository = path.join(sandbox.root, "repository");
  const nonRepository = path.join(sandbox.root, "non-repository");
  fs.mkdirSync(repository);
  fs.mkdirSync(nonRepository);
  runGit(sandbox, ["init", "--quiet"], { cwd: repository });

  const repositoryRecord = createJobRecord({ cwd: repository, id: "repository-top-level" });
  const nonRepositoryRecord = createJobRecord({ cwd: nonRepository, id: "non-repository-top-level" });

  assert.equal(repositoryRecord.repositoryTopLevel, runGit(sandbox, ["rev-parse", "--show-toplevel"], { cwd: repository, encoding: "utf8" }).trim());
  assert.equal(nonRepositoryRecord.repositoryTopLevel, null);
});

test("running record reconciliation waits for the pidless grace window", () => {
  const createdAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(runningRecordNeedsReconciliation({ createdAt, pid: null, status: "running" }, { CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS: "0" }), true);
  assert.equal(runningRecordNeedsReconciliation({ createdAt: new Date().toISOString(), pid: null, status: "running" }, { CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS: "60000" }), false);
  assert.equal(runningRecordNeedsReconciliation({ createdAt, pid: 99999999, status: "running" }, { CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS: "0" }), true);
  assert.equal(runningRecordNeedsReconciliation({ createdAt, pid: process.pid, pidIdentity: null, status: "running" }, { CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS: "0" }), false);
});

test("pidless cleanup-required records reconcile only after the grace boundary", () => {
  const originalNow = Date.now;
  const now = Date.parse("2026-07-20T00:00:00.000Z");
  Date.now = () => now;
  try {
    const env = { CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS: "500" };
    const record = (elapsed) => ({
      createdAt: new Date(now - elapsed).toISOString(),
      phase: "cleanup-required",
      pid: null,
      status: "running"
    });
    assert.equal(runningRecordNeedsReconciliation(record(499), env), false);
    assert.equal(runningRecordNeedsReconciliation(record(500), env), false);
    assert.equal(runningRecordNeedsReconciliation(record(501), env), true);
  } finally {
    Date.now = originalNow;
  }
});

test("future createdAt values do not bypass pidless reconciliation grace", () => {
  const originalNow = Date.now;
  const now = Date.parse("2026-07-20T00:00:00.000Z");
  Date.now = () => now;
  try {
    assert.equal(
      runningRecordNeedsReconciliation(
        {
          createdAt: new Date(now + 60_000).toISOString(),
          phase: "cleanup-required",
          pid: null,
          status: "running"
        },
        { CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS: "0" }
      ),
      false
    );
  } finally {
    Date.now = originalNow;
  }
});

test("identity-replaced owners are terminalized without signaling the live replacement", async (t) => {
  const sandbox = makeSandbox(t);
  const signalFile = path.join(sandbox.root, "replacement-signals");
  const readyFile = path.join(sandbox.root, "replacement-ready");
  const replacement = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import fs from "node:fs";
const [signalFile, readyFile] = process.argv.slice(1);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => fs.appendFileSync(signalFile, signal + "\\n"));
}
fs.writeFileSync(readyFile, "ready");
setInterval(() => {}, 1000);`,
      signalFile,
      readyFile
    ],
    { stdio: "ignore" }
  );
  t.after(() => replacement.kill("SIGKILL"));
  await waitFor(() => (fs.existsSync(readyFile) ? true : null));
  const identity = getProcessIdentity(replacement.pid);
  assert.ok(identity, "Process identity probing is unavailable for the tracked replacement.");
  const pidIdentity = {
    ...identity,
    commandHash: identity.commandHash === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64)
  };
  const env = envFor(sandbox, { CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS: "0" });
  const id = "identity-replaced-owner";
  const record = createJobRecord({
    createdAt: new Date(Date.now() - 1000).toISOString(),
    cwd: sandbox.workDir,
    errorMessage: "Unable to verify lock owner process.",
    failureKind: "process",
    id,
    phase: "cleanup-required",
    pid: replacement.pid,
    pidIdentity
  });
  const file = jobFilePath(resolveDataDir(env), sandbox.workDir, id);
  writeJobRecordFile(file, record);

  const repaired = repairRunningRecordSync({ file, record }, env);

  assert.equal(repaired.status, "error");
  assert.equal(repaired.failureKind, "died");
  assert.equal(repaired.phase, null);
  assert.doesNotThrow(() => process.kill(replacement.pid, 0));
  assert.equal(fs.existsSync(signalFile), false);
});

test("task stays foreground by default and persists the complete terminal record", (t) => {
  const sandbox = makeSandbox(t);
  initializeGitRepository(sandbox);
  const env = envFor(sandbox);
  const result = runCompanion(["task", "--write --model gpt-test --effort max --web --network implement this safely"], {
    cwd: sandbox.workDir,
    env
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /state: done\n$/);
  assert.equal(result.stderr, "");
  assert.equal(fs.readFileSync(sandbox.stdinFile, "utf8").trim(), "implement this safely");
  const args = readArgs(sandbox);
  assert.deepEqual(args.slice(0, 13), [
    "exec",
    "--strict-config",
    "--json",
    "--sandbox",
    "workspace-write",
    "--config",
    'approval_policy="never"',
    "--disable",
    "multi_agent",
    "--disable",
    "multi_agent_v2",
    "--model",
    "gpt-test"
  ]);
  assert.ok(args.includes('web_search="live"'));
  assert.ok(args.includes("sandbox_workspace_write.network_access=true"));
  assert.ok(args.includes("gpt-test"));
  assert.ok(args.includes('model_reasoning_effort="max"'));
  assert.ok(!args.includes("implement this safely"));
  const [entry] = jobEntries(sandbox);
  assert.equal(entry.record.background, false);
  assert.equal(entry.record.status, "done");
  assert.equal(entry.record.mode, "write");
  assert.equal(entry.record.resultText, "Codex completed the task.");
  assert.equal(entry.record.resolvedModel, "gpt-test");
  assert.equal(entry.record.resolvedEffort, "max");
  assert.equal(entry.record.tokenUsageAvailability, "available");
  assert.equal(entry.record.codexVersion, "0.147.0");
  assert.equal(fs.statSync(entry.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(entry.file)).mode & 0o777, 0o700);
});

test("sol foreground write warning is emitted before execution and recorded", (t) => {
  const sandbox = makeSandbox(t);
  initializeGitRepository(sandbox);
  const traceCodex = path.join(sandbox.root, "trace-codex");
  fs.writeFileSync(
    traceCodex,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  process.stdout.write('codex-cli 0.147.0\\n');",
      "  require('node:fs').unlinkSync(process.argv[1]);",
      "}"
    ].join("\n"),
    { mode: 0o755 }
  );
  const result = runCompanion(["task", "--write", "--model", "gpt-5.6-sol", "implement the sol-safe change"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, {
      CODEX_BIN: traceCodex
    })
  });
  const warning = "warning: 41% of foreground gpt-5.6-sol write tasks timed out in the last 7 days. Split the package or use gpt-5.6-terra.";

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, `${warning}\n`);
  const [record] = jobRecords(sandbox);
  assert.equal(record.failureKind, "missing_cli");
  assert.equal(record.diagnostics.filter((diagnostic) => diagnostic.type === "warning" && diagnostic.message === warning).length, 1);
});

test("sol warning is limited to foreground write tasks", async (t) => {
  const warning = "warning: 41% of foreground gpt-5.6-sol write tasks timed out in the last 7 days. Split the package or use gpt-5.6-terra.";
  const cases = [
    { args: ["task", "--write", "--model", "gpt-5.6-terra", "use terra"], write: true },
    { args: ["task", "--model", "gpt-5.6-sol", "use sol in consult mode"], write: false }
  ];
  for (const entry of cases) {
    const sandbox = makeSandbox(t);
    if (entry.write) {
      initializeGitRepository(sandbox);
    }
    const result = runCompanion(entry.args, {
      cwd: sandbox.workDir,
      env: envFor(sandbox)
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(jobRecords(sandbox)[0].diagnostics.some((diagnostic) => diagnostic.message === warning), false);
  }

  const background = makeSandbox(t);
  initializeGitRepository(background);
  const env = envFor(background);
  const launched = runCompanion(["task", "--background", "--write", "--model", "gpt-5.6-sol", "use sol in the background"], { cwd: background.workDir, env });
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(launched.stderr, "");
  const completed = await waitFor(() => {
    const [record] = jobRecords(background);
    return record?.status === "done" ? record : null;
  });
  assert.equal(completed.diagnostics.some((diagnostic) => diagnostic.message === warning), false);
});

test("task resolves an output schema, forwards it, and records parsed structured output", (t) => {
  const sandbox = makeSandbox(t);
  const schemaDirectory = path.join(sandbox.workDir, "schemas");
  const schema = path.join(schemaDirectory, "verdict.json");
  fs.mkdirSync(schemaDirectory);
  fs.writeFileSync(schema, JSON.stringify({ type: "object" }));
  const resolvedSchema = fs.realpathSync.native(schema);
  const result = runCompanion(["task", "--json", "--output-schema", "schemas/verdict.json", "return a verdict"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_CODEX_JSON_OBJECT_MESSAGE: "true" })
  });
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.request.outputSchemaFile, resolvedSchema);
  assert.equal(record.resultText, '{"verdict":"pass","findings":[]}');
  assert.deepEqual(record.structuredOutput, { verdict: "pass", findings: [] });
  assert.equal(record.structuredOutputError, null);
  const args = readArgs(sandbox);
  const schemaIndex = args.indexOf("--output-schema");
  assert.equal(args[schemaIndex + 1], resolvedSchema);
  assert.equal(jobRecords(sandbox)[0].request.outputSchemaFile, resolvedSchema);
});

test("task retains a non-JSON agent message and records the structured parsing error", (t) => {
  const sandbox = makeSandbox(t);
  const schema = path.join(sandbox.workDir, "verdict.json");
  fs.writeFileSync(schema, JSON.stringify({ type: "object" }));
  const result = runCompanion(["task", "--json", "--output-schema", schema, "return a verdict"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.resultText, "Codex completed the task.");
  assert.equal(record.structuredOutput, null);
  assert.match(record.structuredOutputError, /^Codex final response is not valid JSON:/);
});

test("task rejects missing, nonregular, oversized, and invalid output schemas before execution", (t) => {
  const sandbox = makeSandbox(t);
  const cases = [
    { path: "missing.json", message: /does not exist/ },
    { path: "schemas", message: /not a regular file/ },
    { path: "oversized.json", message: /exceeds the 256 KiB limit/ },
    { path: "invalid.json", message: /must contain valid JSON/ }
  ];
  fs.mkdirSync(path.join(sandbox.workDir, "schemas"));
  fs.writeFileSync(path.join(sandbox.workDir, "oversized.json"), "x".repeat(256 * 1024 + 1));
  fs.writeFileSync(path.join(sandbox.workDir, "invalid.json"), "{not-json}");
  for (const entry of cases) {
    const result = runCompanion(["task", "--output-schema", entry.path, "return a verdict"], {
      cwd: sandbox.workDir,
      env: envFor(sandbox)
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, entry.message);
  }
  assert.equal(fs.existsSync(sandbox.argsFile), false);
});

test("option shaped text after a task prompt cannot enable background or change execution settings", (t) => {
  const sandbox = makeSandbox(t);
  const prompt = "Fix support for --background --cwd /tmp/other --network";
  const result = runCompanion(["task", prompt], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(sandbox.stdinFile, "utf8"), prompt);
  const [record] = jobRecords(sandbox);
  assert.equal(record.background, false);
  assert.equal(record.cwd, fs.realpathSync(sandbox.workDir));
  assert.equal(record.mode, "consult");
  assert.equal(record.request.network, false);
});

test("single raw task arguments preserve prompt whitespace byte for byte", (t) => {
  const sandbox = makeSandbox(t);
  initializeGitRepository(sandbox);
  const env = envFor(sandbox);
  const prompt = String.raw`preserve  repeated spaces
	indentation, "quotes", and \d+`;
  const result = runCompanion(["task", `--model gpt-test --write ${prompt}`], { cwd: sandbox.workDir, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(sandbox.stdinFile, "utf8"), prompt);
  const [record] = jobRecords(sandbox);
  assert.equal(record.mode, "write");
  assert.equal(record.request.model, "gpt-test");
});

test("structured raw transport preserves shell syntax without evaluating it", (t) => {
  const sandbox = makeSandbox(t);
  initializeGitRepository(sandbox);
  const markerOne = path.join(sandbox.root, "command-substitution-ran");
  const markerTwo = path.join(sandbox.root, "backtick-ran");
  const prompt = `  inspect $(touch ${markerOne}) and !\`touch ${markerTwo}\`\nEOF\n'outer \"inner\nkeep \\\\ exactly  `;
  const transport = createTransport(sandbox, `--write -- ${prompt}`);
  const result = runCompanion(["task", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(sandbox.stdinFile, "utf8"), prompt);
  assert.equal(fs.existsSync(markerOne), false);
  assert.equal(fs.existsSync(markerTwo), false);
  assert.equal(fs.existsSync(transport.file), false);
  assert.equal(fs.existsSync(path.dirname(transport.file)), false);
});

test("raw transport rejects an unwritten input and removes the verified transport", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const created = runCompanion(["transport-create"], { cwd: sandbox.workDir, env });
  assert.equal(created.status, 0, created.stderr);
  const transport = JSON.parse(created.stdout);
  const ownerFile = path.join(path.dirname(transport.file), "owner.json");

  const result = runCompanion(["task", "--raw-args-token", transport.token], { cwd: sandbox.workDir, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /raw command transport is unwritten/);
  assert.equal(jobRecords(sandbox).length, 0);
  assert.equal(fs.existsSync(transport.file), false);
  assert.equal(fs.existsSync(ownerFile), false);
  assert.equal(fs.existsSync(path.dirname(transport.file)), false);
});

test("a staged Fusion worktree request selects the Codex cwd and workspace root", (t) => {
  const sandbox = makeSandbox(t);
  const sibling = path.join(sandbox.root, "sibling worktree");
  runGit(sandbox, ["init", "-q"]);
  runGit(sandbox, ["-c", "user.email=fusion-test@example.com", "-c", "user.name=fusion-test", "commit", "--allow-empty", "-q", "-m", "init"]);
  runGit(sandbox, ["worktree", "add", "-q", "-b", "fusion-sibling", sibling]);
  const prompt = "Implement the isolated package and run its verification.";
  const transport = createTransport(sandbox, `--write --cwd ${JSON.stringify(sibling)} -- ${prompt}`);
  const result = runCompanion(["task", "--transport-default-write", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(sandbox.stdinFile, "utf8"), prompt);
  const [record] = jobRecords(sandbox);
  const canonicalSibling = fs.realpathSync(sibling);
  assert.equal(record.mode, "write");
  assert.equal(record.cwd, canonicalSibling);
  assert.equal(record.workspaceRoot, canonicalSibling);
  assert.equal(fs.existsSync(transport.file), false);
});

test("a staged request rejects cwd outside the opaque raw prompt", (t) => {
  const sandbox = makeSandbox(t);
  const transport = createTransport(sandbox, "--write -- implement the package");
  const result = runCompanion(["task", "--transport-default-write", "--cwd", sandbox.workDir, "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Raw command transport options must not be combined with normal arguments\./);
  assert.equal(jobRecords(sandbox).length, 0);
  const discarded = runCompanion(["transport-discard", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(discarded.status, 0, discarded.stderr);
  assert.equal(fs.existsSync(transport.file), false);
});

test("raw transport discard removes an unused private transport", (t) => {
  const sandbox = makeSandbox(t);
  const transport = createTransport(sandbox, "unused");
  const discarded = runCompanion(["transport-discard", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(discarded.status, 0, discarded.stderr);
  assert.equal(discarded.stdout, "");
  assert.equal(fs.existsSync(transport.file), false);
  assert.equal(fs.existsSync(path.dirname(transport.file)), false);
});

test("raw transport discard removes an unwritten private transport silently", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const created = runCompanion(["transport-create"], { cwd: sandbox.workDir, env });
  assert.equal(created.status, 0, created.stderr);
  const transport = JSON.parse(created.stdout);
  const ownerFile = path.join(path.dirname(transport.file), "owner.json");
  assert.equal(fs.readFileSync(transport.file, "utf8"), "");

  const discarded = runCompanion(["transport-discard", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env
  });
  assert.equal(discarded.status, 0, discarded.stderr);
  assert.equal(discarded.stdout, "");
  assert.equal(discarded.stderr, "");
  assert.equal(fs.existsSync(transport.file), false);
  assert.equal(fs.existsSync(ownerFile), false);
  assert.equal(fs.existsSync(path.dirname(transport.file)), false);
});

test("raw transport rejects another Claude session and removes the verified transport", (t) => {
  const sandbox = makeSandbox(t);
  const transport = createTransport(sandbox, "private request", envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-a" }));
  const result = runCompanion(["task", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-b" })
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /belongs to another Claude session/);
  assert.equal(jobRecords(sandbox).length, 0);
  assert.equal(fs.existsSync(transport.file), false);
  assert.equal(fs.existsSync(transport.ownerFile), false);
  assert.equal(fs.existsSync(path.dirname(transport.file)), false);
});

test("raw transport rejects expired input and removes the verified transport", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const transport = createTransport(sandbox, "expired private request", env);
  const owner = JSON.parse(fs.readFileSync(transport.ownerFile, "utf8"));
  fs.writeFileSync(transport.ownerFile, `${JSON.stringify({ ...owner, createdAt: Date.now() - 2 * 60 * 60 * 1000 })}\n`, { mode: 0o600 });
  const result = runCompanion(["task", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /transport has expired/);
  assert.equal(jobRecords(sandbox).length, 0);
  assert.equal(fs.existsSync(transport.file), false);
  assert.equal(fs.existsSync(transport.ownerFile), false);
  assert.equal(fs.existsSync(path.dirname(transport.file)), false);
});

test("programmatic stdin ingress preserves opaque raw arguments without a staging file", (t) => {
  const sandbox = makeSandbox(t);
  initializeGitRepository(sandbox);
  const marker = path.join(sandbox.root, "stdin-command-substitution-ran");
  const prompt = `  inspect $(touch ${marker})\nkeep quotes ' " and \\ exactly  `;
  const result = runCompanion(["task", "--transport-default-write", "--request-stdin"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
    input: `-- ${prompt}`
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(sandbox.stdinFile, "utf8"), prompt);
  assert.equal(fs.existsSync(marker), false);
  const [record] = jobRecords(sandbox);
  assert.equal(record.mode, "write");
  assert.equal(record.request.ingress, "stdin");
});

test("stdin ingress cannot be mixed with argv request bytes", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--request-stdin", "unexpected"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
    input: "request"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must not be combined/);
  assert.equal(jobRecords(sandbox).length, 0);
});

test("session end removes unused transports owned by that Claude session", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const transport = createTransport(sandbox, "sensitive request", env);
  const result = runCompanion(["session-end"], {
    cwd: sandbox.workDir,
    env,
    input: JSON.stringify({ session_id: "claude-session-1" })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(transport.file), false);
  assert.equal(fs.existsSync(transport.ownerFile), false);
  assert.equal(fs.existsSync(path.dirname(transport.file)), false);
});

test("transport allocation prunes verified inputs older than the retention window", (t) => {
  const sandbox = makeSandbox(t);
  const stale = createTransport(sandbox, "stale sensitive request", envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-a" }));
  const owner = JSON.parse(fs.readFileSync(stale.ownerFile, "utf8"));
  fs.writeFileSync(stale.ownerFile, `${JSON.stringify({ ...owner, createdAt: Date.now() - 2 * 60 * 60 * 1000 })}\n`, { mode: 0o600 });
  const fresh = createTransport(sandbox, "fresh request", envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-b" }));
  assert.equal(fs.existsSync(stale.file), false);
  assert.equal(fs.existsSync(stale.ownerFile), false);
  assert.equal(fs.existsSync(path.dirname(stale.file)), false);
  const discarded = runCompanion(["transport-discard", "--raw-args-token", fresh.token], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-b" })
  });
  assert.equal(discarded.status, 0, discarded.stderr);
});

test("rescue transport write defaults remain overridable by raw arguments", (t) => {
  const sandbox = makeSandbox(t);
  initializeGitRepository(sandbox);
  const defaulted = createTransport(sandbox, "modify the file");
  const writeResult = runCompanion(["task", "--transport-default-write", "--raw-args-token", defaulted.token], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(writeResult.status, 0, writeResult.stderr);
  const overridden = createTransport(sandbox, "--write=false inspect only");
  const consultResult = runCompanion(["task", "--transport-default-write", "--raw-args-token", overridden.token], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(consultResult.status, 0, consultResult.stderr);
  assert.deepEqual(jobRecords(sandbox).map((record) => record.mode), ["write", "consult"]);
});

test("raw transport removes verified oversized input without reading it", (t) => {
  const sandbox = makeSandbox(t);
  const transport = createTransport(sandbox, "");
  fs.truncateSync(transport.file, 5 * 1024 * 1024);
  const result = runCompanion(["task", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Raw command arguments exceeded/);
  assert.equal(fs.existsSync(transport.file), false);
  assert.equal(fs.existsSync(path.dirname(transport.file)), false);
});

test("raw transport removes an owned regular input after rejecting widened permissions", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX mode bits are unavailable on Windows.");
    return;
  }
  const sandbox = makeSandbox(t);
  const transport = createTransport(sandbox, "private request");
  fs.chmodSync(transport.file, 0o644);
  const result = runCompanion(["task", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /transport file is not private/);
  assert.equal(fs.existsSync(transport.file), false);
  assert.equal(fs.existsSync(path.dirname(transport.file)), false);
});

test("raw transport never follows or cleans an unverified directory symlink", (t) => {
  const sandbox = makeSandbox(t);
  const token = randomBytes(24).toString("hex");
  const target = path.join(sandbox.root, "target");
  const targetFile = path.join(target, "request");
  const transportDirectory = path.join(sandbox.tmpDir, `codex-companion-input-${token}`);
  fs.mkdirSync(target);
  fs.writeFileSync(targetFile, "do not delete", "utf8");
  try {
    fs.symlinkSync(target, transportDirectory, "dir");
    const result = runCompanion(["task", "--raw-args-token", token], {
      cwd: sandbox.workDir,
      env: envFor(sandbox)
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /transport directory is invalid/);
    assert.equal(fs.readFileSync(targetFile, "utf8"), "do not delete");
    assert.equal(fs.lstatSync(transportDirectory).isSymbolicLink(), true);
  } finally {
    fs.unlinkSync(transportDirectory);
  }
});

test("Codex slash skills never interpolate raw arguments into shell source", () => {
  const skillNames = ["adversarial-review", "cancel", "history", "rescue", "result", "review", "setup", "status", "task"];
  for (const name of skillNames) {
    const content = fs.readFileSync(path.join(repoRoot, "plugins", "codex", "skills", name, "SKILL.md"), "utf8");
    assert.equal(content.match(/\$ARGUMENTS/g)?.length, 1);
    assert.match(content, /\n\$ARGUMENTS\n?$/);
    assert.doesNotMatch(content, /<<-?\s*['"]?[A-Za-z_]/);
    for (const shellBlock of content.matchAll(/```(?:bash|sh|zsh)\s*\n([\s\S]*?)```/g)) {
      assert.doesNotMatch(shellBlock[1], /\$ARGUMENTS/);
    }
    for (const inlineExecution of content.matchAll(/!`([^`]*)`/g)) {
      assert.doesNotMatch(inlineExecution[1], /\$ARGUMENTS/);
    }
    assert.doesNotMatch(content, /(?:node|bash|sh|zsh)[^\n]*\$ARGUMENTS/);
  }
});

test("task forces safe disabled defaults and rejects network access without write mode", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const completed = runCompanion(["task", "inspect the code"], { cwd: sandbox.workDir, env });
  assert.equal(completed.status, 0, completed.stderr);
  const args = readArgs(sandbox);
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(!args.some((value) => value.startsWith("sandbox_workspace_write.network_access=")));
  const rejected = runCompanion(["task", "--network inspect the code"], { cwd: sandbox.workDir, env });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /--network requires --write/);
  assert.match(rejected.stderr, /failure: input/);
  assert.equal(jobRecords(sandbox).length, 1);
});

test("missing Codex CLI fails before a job is reserved", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { CODEX_BIN: path.join(sandbox.root, "missing-codex") });
  const result = runCompanion(["task", "--json", "do work"], { cwd: sandbox.workDir, env });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.status, "error");
  assert.equal(failure.failureKind, "missing_cli");
  assert.deepEqual(jobRecords(sandbox), []);
});

test("task rejects an outdated Codex CLI before execution", (t) => {
  const outdated = makeSandbox(t);
  const outdatedResult = runCompanion(["task", "--json", "do work"], {
    cwd: outdated.workDir,
    env: envFor(outdated, { FAKE_CODEX_VERSION: "0.146.0" })
  });
  assert.equal(outdatedResult.status, 1);
  assert.equal(outdatedResult.stdout, "");
  const outdatedFailure = JSON.parse(outdatedResult.stderr);
  assert.equal(outdatedFailure.status, "error");
  assert.equal(outdatedFailure.failureKind, "setup");
  assert.match(outdatedFailure.message, /Upgrade the Codex CLI to version 0\.147\.0 or later\./);
  assert.equal(fs.existsSync(outdated.argsFile), false);
  assert.deepEqual(jobRecords(outdated), []);

  const text = makeSandbox(t);
  const textResult = runCompanion(["task", "do work"], {
    cwd: text.workDir,
    env: envFor(text, { FAKE_CODEX_VERSION: "0.146.0" })
  });
  assert.equal(textResult.status, 1);
  assert.equal(textResult.stdout, "");
  assert.match(textResult.stderr, /Upgrade the Codex CLI to version 0\.147\.0 or later\./);
  assert.match(textResult.stderr, /failure: setup/);
  assert.equal(fs.existsSync(text.argsFile), false);
  assert.deepEqual(jobRecords(text), []);
});

test("task proceeds with tested, alpha hotfix, and newer Codex CLI versions", (t) => {
  for (const version of ["0.147.0", "0.147.0-alpha.10", "0.147.0-alpha.10.1", "0.148.0"]) {
    const sandbox = makeSandbox(t);
    const result = runCompanion(["task", "--json", "do work"], {
      cwd: sandbox.workDir,
      env: envFor(sandbox, { FAKE_CODEX_VERSION: version })
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readArgs(sandbox)[0], "exec");
  }
});

test("structured nonzero diagnostics persist typed auth, quota, and rate limit failures", (t) => {
  const sandbox = makeSandbox(t);
  const cases = [
    ["auth", "authentication failed api_key=sk-secretvalue123"],
    ["quota", "account quota exhausted"],
    ["rate_limited", "too many requests status 429"]
  ];
  for (const [failureKind, diagnostic] of cases) {
    const result = runCompanion(["task", "--json", `check ${failureKind}`], {
      cwd: sandbox.workDir,
      env: envFor(sandbox, {
        FAKE_CODEX_DIAGNOSTIC: diagnostic,
        FAKE_CODEX_MODE: "diagnostic-nonzero"
      })
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const record = JSON.parse(result.stdout);
    assert.equal(record.status, "error");
    assert.equal(record.failureKind, failureKind);
    assert.equal(record.diagnostics.length, 1);
    assert.doesNotMatch(JSON.stringify(record), /sk-secretvalue123/);
  }
});

test("final response prose cannot promote or reject semantic acceptance", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--json", "implement the change"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_CODEX_MODE: "transport-failure-completed" })
  });
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.status, "done");
  assert.equal(record.semanticStatus, "unverified");
  assert.equal(record.semanticFailureKind, null);
  assert.equal(record.semanticFailureMessage, null);
});

test("job records retain request-seeded model and effort without runtime observations", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--json", "--model", "requested-model", "--effort", "high", "inspect"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.request.model, "requested-model");
  assert.equal(record.request.effort, "high");
  assert.equal(record.resolvedModel, "requested-model");
  assert.equal(record.resolvedEffort, "high");
});

test("rollout observations replace request-seeded model and effort", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--json", "--model", "requested-model", "--effort", "high", "inspect"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, {
      CODEX_HOME: path.join(sandbox.root, "codex-home"),
      FAKE_CODEX_MODE: "rollout-completed",
      FAKE_CODEX_RESOLVED_EFFORT: "xhigh",
      FAKE_CODEX_RESOLVED_MODEL: "gpt-resolved"
    })
  });
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.request.model, "requested-model");
  assert.equal(record.request.effort, "high");
  assert.equal(record.resolvedModel, "gpt-resolved");
  assert.equal(record.resolvedEffort, "xhigh");
  assert.equal(record.rolloutRecoveryStatus, "recovered");
});

test("task records and renders model drift from a brief header", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "lane: codex | model: gpt-header | effort: xhigh\nImplement the change."], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, {
      CODEX_HOME: path.join(sandbox.root, "codex-home"),
      FAKE_CODEX_MODE: "rollout-completed",
      FAKE_CODEX_RESOLVED_MODEL: "gpt-resolved"
    })
  });
  assert.equal(result.status, 0, result.stderr);
  const warning = "warning: brief header names gpt-header but the job ran gpt-resolved; pass --model to select the model.";
  assert.equal(result.stdout.split(warning).length - 1, 1);
  const [record] = jobRecords(sandbox);
  assert.deepEqual(record.modelDrift, {
    headerModel: "gpt-header",
    headerEffort: "xhigh",
    resolvedModel: "gpt-resolved"
  });
  const rerendered = runCompanion(["result", record.id], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.equal(rerendered.status, 0, rerendered.stderr);
  assert.equal(rerendered.stdout.split(warning).length - 1, 1);
});

test("an explicit task model suppresses header model drift", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--model", "gpt-explicit", "lane: codex | model: gpt-header | effort: xhigh\nImplement the change."], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, {
      CODEX_HOME: path.join(sandbox.root, "codex-home"),
      FAKE_CODEX_MODE: "rollout-completed",
      FAKE_CODEX_RESOLVED_MODEL: "gpt-resolved"
    })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /warning: brief header names/);
  assert.equal(Object.hasOwn(jobRecords(sandbox)[0], "modelDrift"), false);
});

test("a matching task header model does not create model drift", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "lane: codex | model: gpt-resolved\nImplement the change."], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, {
      CODEX_HOME: path.join(sandbox.root, "codex-home"),
      FAKE_CODEX_MODE: "rollout-completed",
      FAKE_CODEX_RESOLVED_MODEL: "gpt-resolved"
    })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /warning: brief header names/);
  assert.equal(Object.hasOwn(jobRecords(sandbox)[0], "modelDrift"), false);
});

test("a task without a header does not create model drift", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "Implement the change."], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, {
      CODEX_HOME: path.join(sandbox.root, "codex-home"),
      FAKE_CODEX_MODE: "rollout-completed",
      FAKE_CODEX_RESOLVED_MODEL: "gpt-resolved"
    })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /warning: brief header names/);
  assert.equal(Object.hasOwn(jobRecords(sandbox)[0], "modelDrift"), false);
});

test("task forwards --skip-git-repo-check to Codex", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--skip-git-repo-check", "inspect this directory"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readArgs(sandbox).includes("--skip-git-repo-check"));
  assert.equal(jobRecords(sandbox)[0].request.skipGitRepoCheck, true);
});

test("trusted-directory failures store and render the skip-git remedy", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "inspect this directory"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, {
      FAKE_CODEX_MODE: "nonzero",
      FAKE_CODEX_STDERR: "Not inside a trusted directory and --skip-git-repo-check was not specified.\n"
    })
  });
  assert.equal(result.status, 1);
  const [record] = jobRecords(sandbox);
  assert.equal(record.status, "error");
  assert.match(record.errorMessage, /--skip-git-repo-check/);
  assert.match(result.stdout, /--skip-git-repo-check/);
});

function seedTerminalJob(sandbox, { id, status, ...fields }) {
  const record = createJobRecord({
    id,
    cwd: sandbox.workDir,
    finishedAt: "2026-01-01T00:00:00.000Z",
    request: { effort: "high", model: "gpt-test" },
    status,
    ...fields
  });
  writeJobRecordFile(jobFilePath(sandbox.dataDir, sandbox.workDir, id), record);
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
  assert.equal(accepted.stdout, `Recorded verdict for Codex job ${id}: accepted.\n`);
  let [record] = jobRecords(sandbox);
  assert.equal(record.semanticStatus, "accepted");

  const rejected = runCompanion(["record-acceptance", "--job-id", id, "--acceptance", "rejected", "--reason", "Verification did not pass.", "--failure-kind", "intent_override"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(rejected.status, 0, rejected.stderr);
  [record] = jobRecords(sandbox);
  assert.equal(record.semanticStatus, "rejected");
  assert.equal(record.semanticFailureKind, "intent_override");
  assert.equal(record.semanticFailureMessage, "Verification did not pass.");
});

test("record-acceptance requires a reason for rejected verdicts", (t) => {
  const sandbox = makeSandbox(t);
  const id = "1".repeat(32);
  seedTerminalJob(sandbox, { id, status: "done" });
  const result = runCompanion(["record-acceptance", "--job-id", id, "--acceptance", "rejected"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "A rejected acceptance requires --reason.\nstate: error\nfailure: input\n");
});

test("record-acceptance permits failure kinds only for rejected verdicts", (t) => {
  const sandbox = makeSandbox(t);
  const id = "2".repeat(32);
  seedTerminalJob(sandbox, { id, status: "done" });
  const result = runCompanion(["record-acceptance", "--job-id", id, "--acceptance", "accepted", "--failure-kind", "intent_override"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--failure-kind option is valid only with --acceptance rejected/);
  assert.match(result.stderr, /failure: input/);
});

test("record-acceptance rejects unknown semantic failure kinds", (t) => {
  const sandbox = makeSandbox(t);
  const id = "3".repeat(32);
  seedTerminalJob(sandbox, { id, status: "done" });
  const result = runCompanion(["record-acceptance", "--job-id", id, "--acceptance", "rejected", "--reason", "Verification did not pass.", "--failure-kind", "unknown"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /intent_override, scope_rewrite, wrong_approach, or style_mismatch/);
  assert.match(result.stderr, /failure: input/);
});

test("record-acceptance stamps default stats provenance", (t) => {
  const sandbox = makeSandbox(t);
  const id = "e".repeat(32);
  seedTerminalJob(sandbox, { id, status: "done" });
  const result = runCompanion(["record-acceptance", "--job-id", id, "--acceptance", "accepted"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 0, result.stderr);
  const [record] = jobRecords(sandbox);
  assert.equal(record.acceptanceSource, "stats");
  assert.match(record.acceptanceRecordedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("record-acceptance stamps explicit provenance", (t) => {
  const sandbox = makeSandbox(t);
  const id = "f".repeat(32);
  seedTerminalJob(sandbox, { id, status: "done" });
  const result = runCompanion(["record-acceptance", "--job-id", id, "--acceptance", "accepted", "--source", "main-loop"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 0, result.stderr);
  const [record] = jobRecords(sandbox);
  assert.equal(record.acceptanceSource, "main-loop");
  assert.match(record.acceptanceRecordedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("record-acceptance blocks accepted verdicts on failed transport by default", (t) => {
  const sandbox = makeSandbox(t);
  const id = "b".repeat(32);
  seedTerminalJob(sandbox, { id, status: "error", exitCode: 1, failureKind: "timeout" });
  const result = runCompanion(["record-acceptance", "--job-id", id, "--acceptance", "accepted"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--accept-failed-transport/);
  assert.equal(jobRecords(sandbox)[0].semanticStatus, "unverified");
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
  assert.equal(result.stdout, `Recorded verdict for Codex job ${id}: accepted.\n`);
  const [record] = jobRecords(sandbox);
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

test("foreground timeout persists recovered partial delivery and incomplete cumulative usage", (t) => {
  const sandbox = makeSandbox(t);
  const expectedCompanionVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "plugins", "codex", ".claude-plugin", "plugin.json"), "utf8")).version;
  const result = runCompanion(["task", "--json", "implement until timeout"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, {
      CODEX_COMPANION_TIMEOUT_MS: "50",
      CODEX_HOME: path.join(sandbox.root, "codex-home"),
      FAKE_CODEX_MODE: "rollout-timeout"
    })
  });
  assert.equal(result.status, 1, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.status, "error");
  assert.equal(record.failureKind, "timeout");
  assert.equal(record.timeoutMs, 50);
  assert.equal(record.companionVersion, expectedCompanionVersion);
  assert.equal(record.resultText, null);
  const resumeCommand = `'${process.execPath}' '${companion}' task --resume 'thread-123' --cwd '${fs.realpathSync(sandbox.workDir)}'`;
  const footer = `Resume Codex job ${record.id}: ${resumeCommand}`;
  assert.equal(record.partialResultText, `Recovered partial Codex output.\n\n${footer}`);
  assert.equal(record.resumable, true);
  assert.equal(record.resumeCommand, resumeCommand);
  assert.equal(record.partialResultText.split(footer).length - 1, 1);
  const rendered = runCompanion(["result", record.id], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.equal(rendered.status, 1);
  assert.equal(rendered.stdout.split(footer).length - 1, 1);
  assert.equal(record.tokenUsageAvailability, "partial");
  assert.equal(record.usageIsIncomplete, true);
  assert.equal(record.resolvedModel, "gpt-resolved");
  assert.equal(record.resolvedEffort, "xhigh");
});

test("timeout jobs without a thread do not advertise resumability", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--json", "timeout before the thread starts"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, {
      CODEX_COMPANION_TIMEOUT_MS: "50",
      FAKE_CODEX_DELAY_MS: "500"
    })
  });

  assert.equal(result.status, 1, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.status, "error");
  assert.equal(record.failureKind, "timeout");
  assert.equal(record.threadId, null);
  assert.equal(Object.hasOwn(record, "resumable"), false);
  assert.equal(Object.hasOwn(record, "resumeCommand"), false);
});

test("policy failures with a live thread are resumable while unrelated failures are not", (t) => {
  const policySandbox = makeSandbox(t);
  const policy = runCompanion(["task", "--json", "stop the collaboration violation"], {
    cwd: policySandbox.workDir,
    env: envFor(policySandbox, { FAKE_CODEX_MODE: "collab-completed" })
  });

  assert.equal(policy.status, 1, policy.stderr);
  const policyRecord = JSON.parse(policy.stdout);
  assert.equal(policyRecord.failureKind, "policy");
  assert.equal(policyRecord.threadId, "thread-123");

  const reconciled = runCompanion(["status", "--json"], { cwd: policySandbox.workDir, env: envFor(policySandbox, {}) });
  assert.equal(reconciled.status, 0, reconciled.stderr);
  const [settledPolicy] = jobRecords(policySandbox);
  assert.equal(settledPolicy.status, "error");
  assert.equal(settledPolicy.failureKind, "policy");
  assert.equal(settledPolicy.resumable, true);
  assert.match(settledPolicy.partialResultText, new RegExp(`Resume Codex job ${settledPolicy.id}:`));

  const errorSandbox = makeSandbox(t);
  const error = runCompanion(["task", "--json", "fail after the thread starts"], {
    cwd: errorSandbox.workDir,
    env: envFor(errorSandbox, { FAKE_CODEX_MODE: "failed" })
  });

  assert.equal(error.status, 1, error.stderr);
  const errorRecord = JSON.parse(error.stdout);
  assert.equal(errorRecord.failureKind, "error");
  assert.equal(errorRecord.threadId, "thread-123");
  assert.equal(Object.hasOwn(errorRecord, "resumable"), false);
  assert.equal(Object.hasOwn(errorRecord, "resumeCommand"), false);
});

test("history lists canonical jobs across workspaces with local thread and delivery metadata", (t) => {
  const sandbox = makeSandbox(t);
  const sibling = path.join(sandbox.root, "sibling");
  fs.mkdirSync(sibling);
  const env = envFor(sandbox);
  assert.equal(runCompanion(["task", "first"], { cwd: sandbox.workDir, env }).status, 0);
  assert.equal(runCompanion(["task", "second"], { cwd: sibling, env }).status, 0);
  const history = runCompanion(["history", "--request-stdin"], { cwd: sandbox.workDir, env, input: "--json" });
  assert.equal(history.status, 0, history.stderr);
  const payload = JSON.parse(history.stdout);
  assert.equal(payload.source, "canonical");
  assert.equal(payload.sidebarVisibility, "not_guaranteed_for_exec_sessions");
  assert.equal(payload.jobs.length, 2);
  assert.ok(payload.jobs.every((record) => record.threadId === "thread-123"));
  assert.ok(payload.jobs.every((record) => record.delivery === "foreground"));
  assert.ok(payload.jobs.every((record) => record.semanticStatus === "unverified"));
});

test("explicit background launch returns a durable receipt and result wait collects it", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_CODEX_DELAY_MS: "250" });
  const launched = runCompanion(["task", "--background do work"], { cwd: sandbox.workDir, env });
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /started in the background/);
  assert.match(launched.stdout, /state: running\n$/);
  const [running] = jobRecords(sandbox);
  assert.equal(running.status, "running");
  assert.equal(running.background, true);
  assert.equal(running.delivery, "manual");
  assert.ok(running.launchApprovedAt);
  assert.equal(running.launchAbortRequestedAt, null);
  assert.ok(Number.isInteger(running.pid));
  const collected = runCompanion(["result", running.id, "--wait", "--wait-timeout-ms", "3000", "--cwd", sandbox.workDir], {
    cwd: sandbox.workDir,
    env,
    timeout: 5000
  });
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.stdout, /Codex completed the task/);
  assert.match(collected.stdout, /state: done\n$/);
  const delivered = await waitFor(() => jobRecords(sandbox)[0]?.status === "done" ? jobRecords(sandbox)[0] : null);
  assert.ok(delivered.deliveryCollectedAt);
});

test("managed background delivery remains pending until result collection", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, {
    CODEX_COMPANION_BACKGROUND_DELIVERY: "managed",
    FAKE_CODEX_DELAY_MS: "100"
  });
  const launched = runCompanion(["task", "--background managed work"], { cwd: sandbox.workDir, env });
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /delivery: managed/);
  const completed = await waitFor(() => {
    const record = jobRecords(sandbox)[0];
    return record?.status === "done" ? record : null;
  });
  assert.equal(completed.delivery, "managed");
  assert.equal(completed.deliveryCollectedAt, null);
  const collected = runCompanion(["result", completed.id, "--cwd", sandbox.workDir], { cwd: sandbox.workDir, env });
  assert.equal(collected.status, 0, collected.stderr);
  assert.ok(jobRecords(sandbox)[0].deliveryCollectedAt);
});

test("tight history quotas retain a completed background review until result collects it", async (t) => {
  for (const maxRecords of [0, 1]) {
    const sandbox = makeSandbox(t);
    const env = envFor(sandbox, {
      CODEX_COMPANION_HISTORY_MAX_BYTES: String(16 * 1024 * 1024),
      CODEX_COMPANION_HISTORY_MAX_RECORDS: String(maxRecords),
      FAKE_CODEX_DELAY_MS: "100"
    });
    if (maxRecords === 1) {
      const seed = runCompanion(["task", "retained resume head"], { cwd: sandbox.workDir, env });
      assert.equal(seed.status, 0, seed.stderr);
    }
    const launchReview = async () => {
      const before = new Set(jobEntries(sandbox).map((entry) => entry.record.id));
      const launched = runCompanion(["review", "--background"], { cwd: sandbox.workDir, env });
      assert.equal(launched.status, 0, launched.stderr);
      const review = jobEntries(sandbox).find((entry) => entry.record.jobClass === "review" && !before.has(entry.record.id));
      assert.ok(review);
      return waitFor(() => {
        const entry = jobEntries(sandbox).find((candidate) => candidate.record.id === review.record.id);
        return entry?.record.status === "done" ? entry : null;
      });
    };
    const first = await launchReview();
    const second = await launchReview();
    assert.strictEqual(fs.existsSync(first.file), true);
    assert.strictEqual(fs.existsSync(second.file), true);

    for (const completed of [first, second]) {
      const collected = runCompanion(["result", completed.record.id], { cwd: sandbox.workDir, env });
      assert.equal(collected.status, 0, collected.stderr);
      assert.match(collected.stdout, /state: done\n$/);
      assert.strictEqual(fs.existsSync(completed.file), false);
    }
  }
});

test("result wait leaves a live background job running when its bounded wait expires", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_CODEX_MODE: "hang" });
  const launched = runCompanion(["task", "--background keep running"], { cwd: sandbox.workDir, env });
  assert.equal(launched.status, 0, launched.stderr);
  const record = await waitFor(() => {
    const candidate = jobRecords(sandbox)[0];
    return candidate?.codexPid ? candidate : null;
  });
  const waiting = runCompanion(["result", record.id, "--wait", "--wait-timeout-ms", "20", "--cwd", sandbox.workDir], {
    cwd: sandbox.workDir,
    env
  });
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.match(waiting.stdout, /state: running\n$/);
  assert.equal(jobRecords(sandbox)[0].status, "running");
  const cancelled = runCompanion(["cancel", record.id, "--cwd", sandbox.workDir], { cwd: sandbox.workDir, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /state: cancelled/);
});

test("workspace reservation makes simultaneous task launches single flight", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_CODEX_DELAY_MS: "250" });
  const first = spawnCompanion(["task", "first task"], { cwd: sandbox.workDir, env });
  const second = spawnCompanion(["task", "second task"], { cwd: sandbox.workDir, env });
  const results = await Promise.all([childResult(first), childResult(second)]);
  assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
  assert.equal(jobRecords(sandbox).length, 1);
  assert.ok(results.some((result) => /already running in this workspace/.test(result.stderr)));
  assert.equal(jobRecords(sandbox)[0].status, "done");
});

test("a single-flight bounce retains staged raw arguments for one retry", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_CODEX_DELAY_MS: "250" });
  const first = spawnCompanion(["task", "first task"], { cwd: sandbox.workDir, env });
  await waitFor(() => jobRecords(sandbox).some((record) => record.status === "running"));
  const transport = createTransport(sandbox, "retry this staged task", env);

  const bounced = runCompanion(["task", "--raw-args-token", transport.token], { cwd: sandbox.workDir, env });

  assert.equal(bounced.status, 1);
  assert.match(bounced.stderr, /already running in this workspace/);
  assert.equal(fs.existsSync(transport.file), true);
  assert.equal(fs.existsSync(transport.ownerFile), true);
  const firstResult = await childResult(first);
  assert.equal(firstResult.code, 0, firstResult.stderr);

  const retried = runCompanion(["task", "--raw-args-token", transport.token], { cwd: sandbox.workDir, env });

  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(fs.readFileSync(sandbox.stdinFile, "utf8"), "retry this staged task");
  assert.equal(fs.existsSync(transport.file), false);
  assert.equal(fs.existsSync(transport.ownerFile), false);
  assert.equal(fs.existsSync(path.dirname(transport.file)), false);
});

test("main workspace and a sibling worktree admit concurrent tasks for the same repository", async (t) => {
  const sandbox = makeSandbox(t);
  const sibling = path.join(sandbox.root, "sibling-worktree");
  runGit(sandbox, ["init", "-q"]);
  runGit(sandbox, ["-c", "user.email=fusion-test@example.com", "-c", "user.name=fusion-test", "commit", "--allow-empty", "-q", "-m", "init"]);
  runGit(sandbox, ["worktree", "add", "-q", "-b", "sibling-worktree", sibling]);
  const env = envFor(sandbox, { FAKE_CODEX_DELAY_MS: "250" });
  const mainTask = spawnCompanion(["task", "main workspace task"], { cwd: sandbox.workDir, env });
  const siblingTask = spawnCompanion(["task", "sibling worktree task"], { cwd: sibling, env });
  const resultsPromise = Promise.all([childResult(mainTask), childResult(siblingTask)]);
  const running = await waitFor(() => {
    const records = jobRecords(sandbox);
    return records.length === 2 && records.every((record) => record.status === "running") ? records : null;
  });
  assert.deepEqual(new Set(running.map((record) => record.workspaceRoot)), new Set([fs.realpathSync(sandbox.workDir), fs.realpathSync(sibling)]));
  assert.equal(new Set(running.map((record) => record.repositoryKey)).size, 1);
  const results = await resultsPromise;
  assert.deepEqual(results.map((result) => result.code), [0, 0]);
  assert.ok(results.every((result) => result.stderr === ""));
  const completed = jobRecords(sandbox);
  assert.equal(completed.length, 2);
  assert.ok(completed.every((record) => record.status === "done"));
});

test("resume-last uses the current Claude session without claiming an unverifiable usage delta", (t) => {
  const sandbox = makeSandbox(t);
  const firstEnv = envFor(sandbox, {
    FAKE_CODEX_THREAD_ID: "thread-resume",
    FAKE_CODEX_USAGE: usage(100, 30, 20, 5)
  });
  const first = runCompanion(["task", "initial task"], { cwd: sandbox.workDir, env: firstEnv });
  assert.equal(first.status, 0, first.stderr);
  const secondEnv = envFor(sandbox, {
    FAKE_CODEX_THREAD_ID: "thread-resume",
    FAKE_CODEX_USAGE: usage(145, 45, 35, 9)
  });
  const second = runCompanion(["task", "--resume-last continue"], { cwd: sandbox.workDir, env: secondEnv });
  assert.equal(second.status, 0, second.stderr);
  const args = readArgs(sandbox);
  assert.deepEqual(args.slice(-2), ["resume", "thread-resume"]);
  const records = jobRecords(sandbox);
  assert.equal(records.length, 2);
  const resumed = records[1];
  assert.equal(resumed.request.resumeSourceJobId, records[0].id);
  assert.equal(resumed.tokenUsage, null);
  assert.equal(resumed.tokenUsageAvailability, "unavailable");
  assert.equal(resumed.tokenUsageUnavailableReason, "resume_continuity_unverifiable");
});

function seedThreadRoutingRecord(sandbox, overrides = {}) {
  const id = randomBytes(16).toString("hex");
  const record = createJobRecord({
    claudeSessionId: "claude-session-1",
    cwd: sandbox.workDir,
    finishedAt: "2026-07-19T07:50:39.000Z",
    id,
    request: {
      effort: "xhigh",
      model: "gpt-5.6-terra",
      serviceTier: "flex"
    },
    serviceTier: "flex",
    status: "done",
    threadId: "thread-routing",
    ...overrides
  });
  writeJobRecordFile(jobFilePath(sandbox.dataDir, sandbox.workDir, id), record);
  return record;
}

test("resume-last inherits model, effort, and service tier from its thread", (t) => {
  const sandbox = makeSandbox(t);
  const source = seedThreadRoutingRecord(sandbox);
  const result = runCompanion(["task", "--resume-last", "continue routing"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_CODEX_THREAD_ID: "thread-routing" })
  });
  assert.equal(result.status, 0, result.stderr);
  const args = readArgs(sandbox);
  assert.deepEqual(args.slice(-2), ["resume", "thread-routing"]);
  assert.ok(args.some((value, index) => value === "--model" && args[index + 1] === "gpt-5.6-terra"));
  assert.ok(args.some((value, index) => value === "--config" && args[index + 1] === 'model_reasoning_effort="xhigh"'));
  assert.ok(args.some((value, index) => value === "-c" && args[index + 1] === "service_tier=flex"));
  const resumed = jobRecords(sandbox).find((record) => record.id !== source.id);
  assert.deepEqual(resumed.request, {
    effort: "xhigh",
    fresh: false,
    inheritedFromThread: true,
    ingress: "argv",
    model: "gpt-5.6-terra",
    network: false,
    outputSchemaFile: null,
    resumeSourceJobId: source.id,
    resumeThreadId: "thread-routing",
    serviceTier: "flex",
    skipGitRepoCheck: false,
    transport: "task",
    web: false,
    write: false
  });
});

test("resume applies explicit routing flags per field while inheriting the remaining fields", (t) => {
  const cases = [
    { expected: { effort: "xhigh", model: "gpt-5.6-sol", serviceTier: "flex" }, flags: ["--model", "gpt-5.6-sol"] },
    { expected: { effort: "high", model: "gpt-5.6-terra", serviceTier: "flex" }, flags: ["--effort", "high"] },
    { expected: { effort: "xhigh", model: "gpt-5.6-terra", serviceTier: "priority" }, flags: ["--service-tier", "priority"] }
  ];
  for (const { expected, flags } of cases) {
    const sandbox = makeSandbox(t);
    const source = seedThreadRoutingRecord(sandbox);
    const result = runCompanion(["task", "--resume", "thread-routing", ...flags, "continue routing"], {
      cwd: sandbox.workDir,
      env: envFor(sandbox, { FAKE_CODEX_THREAD_ID: "thread-routing" })
    });
    assert.equal(result.status, 0, result.stderr);
    const resumed = jobRecords(sandbox).find((record) => record.id !== source.id);
    assert.equal(resumed.request.model, expected.model);
    assert.equal(resumed.request.effort, expected.effort);
    assert.equal(resumed.request.serviceTier, expected.serviceTier);
    assert.equal(resumed.request.inheritedFromThread, true);
  }
});

test("fresh tasks do not inherit routing from prior threads", (t) => {
  const sandbox = makeSandbox(t);
  const source = seedThreadRoutingRecord(sandbox);
  const result = runCompanion(["task", "--fresh", "start fresh"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_CODEX_THREAD_ID: "fresh-thread" })
  });
  assert.equal(result.status, 0, result.stderr);
  const args = readArgs(sandbox);
  assert.ok(!args.includes("gpt-5.6-terra"));
  assert.ok(!args.includes('model_reasoning_effort="xhigh"'));
  const fresh = jobRecords(sandbox).find((record) => record.id !== source.id);
  assert.equal(fresh.request.model, null);
  assert.equal(fresh.request.effort, null);
  assert.equal(fresh.request.serviceTier, "priority");
  assert.equal(Object.hasOwn(fresh.request, "inheritedFromThread"), false);
});

test("completed tasks enforce configured history quotas without breaking resume-last", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, {
    CODEX_COMPANION_HISTORY_MAX_BYTES: String(16 * 1024 * 1024),
    CODEX_COMPANION_HISTORY_MAX_RECORDS: "3",
    FAKE_CODEX_THREAD_ID: "bounded-history-thread"
  });
  for (let index = 0; index < 6; index += 1) {
    const completed = runCompanion(["task", `bounded task ${index}`], { cwd: sandbox.workDir, env });
    assert.equal(completed.status, 0, completed.stderr);
  }
  assert.equal(jobRecords(sandbox).length, 3);

  for (let index = 0; index < 8; index += 1) {
    const before = new Set(jobRecords(sandbox).map((record) => record.id));
    const resumed = runCompanion(["task", `--resume-last continue bounded history ${index}`], { cwd: sandbox.workDir, env });
    assert.equal(resumed.status, 0, resumed.stderr);
    const records = jobRecords(sandbox);
    assert.equal(records.length, 3);
    const head = records.find((record) => !before.has(record.id));
    assert.ok(head?.request?.resumeSourceJobId);
    assert.ok(records.some((record) => record.id === head.request.resumeSourceJobId));
  }
});

test("resume-last never crosses Claude sessions when a session id is available", (t) => {
  const sandbox = makeSandbox(t);
  const first = runCompanion(["task", "initial task"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-a" })
  });
  assert.equal(first.status, 0, first.stderr);
  const resumed = runCompanion(["task", "--resume-last continue"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-b" })
  });
  assert.equal(resumed.status, 1);
  assert.match(resumed.stderr, /No eligible finished Codex task thread/);
  assert.equal(jobRecords(sandbox).length, 1);
});

test("resumed usage remains unavailable across workspaces while the thread lease stays reusable", (t) => {
  const sandbox = makeSandbox(t);
  const otherWorkDir = path.join(sandbox.root, "other-workspace");
  fs.mkdirSync(otherWorkDir);
  const first = runCompanion(["task", "initial"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_CODEX_THREAD_ID: "thread-global", FAKE_CODEX_USAGE: usage(100, 20, 20, 5) })
  });
  assert.equal(first.status, 0, first.stderr);
  const second = runCompanion(["task", "--resume thread-global continue elsewhere"], {
    cwd: otherWorkDir,
    env: envFor(sandbox, { FAKE_CODEX_THREAD_ID: "thread-global", FAKE_CODEX_USAGE: usage(120, 25, 30, 8) })
  });
  assert.equal(second.status, 0, second.stderr);
  const third = runCompanion(["task", "--resume thread-global continue again"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_CODEX_THREAD_ID: "thread-global", FAKE_CODEX_USAGE: usage(160, 35, 40, 10) })
  });
  assert.equal(third.status, 0, third.stderr);
  const records = jobRecords(sandbox);
  assert.equal(records.length, 3);
  assert.equal(records[1].tokenUsage, null);
  assert.equal(records[2].tokenUsage, null);
  assert.equal(records[1].tokenUsageUnavailableReason, "resume_continuity_unverifiable");
  assert.equal(records[2].tokenUsageUnavailableReason, "resume_continuity_unverifiable");
});

test("the same Codex thread cannot resume concurrently across workspaces", async (t) => {
  const sandbox = makeSandbox(t);
  const otherWorkDir = path.join(sandbox.root, "other-workspace");
  fs.mkdirSync(otherWorkDir);
  const seeded = runCompanion(["task", "initial"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_CODEX_THREAD_ID: "thread-lease" })
  });
  assert.equal(seeded.status, 0, seeded.stderr);
  const env = envFor(sandbox, { FAKE_CODEX_DELAY_MS: "300", FAKE_CODEX_THREAD_ID: "thread-lease" });
  const first = spawnCompanion(["task", "--resume", "thread-lease", "first"], { cwd: sandbox.workDir, env });
  const second = spawnCompanion(["task", "--resume", "thread-lease", "second"], { cwd: otherWorkDir, env });
  const results = await Promise.all([childResult(first), childResult(second)]);
  assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
  assert.ok(results.some((result) => /thread thread-lease is already running/.test(result.stderr)));
});

test("plain native review uses target flags and focus switches to a read only task prompt", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const native = runCompanion(["review", "--base main"], { cwd: sandbox.workDir, env });
  assert.equal(native.status, 0, native.stderr);
  const nativeArgs = readArgs(sandbox);
  assert.ok(nativeArgs.includes("review"));
  assert.deepEqual(nativeArgs.slice(-3), ["review", "--base", "main"]);
  assert.equal(fs.readFileSync(sandbox.stdinFile, "utf8"), "");
  const focused = runCompanion(["review", "--base main --focus concurrency safety"], { cwd: sandbox.workDir, env });
  assert.equal(focused.status, 0, focused.stderr);
  const focusedArgs = readArgs(sandbox);
  assert.ok(!focusedArgs.includes("review"));
  assert.ok(!focusedArgs.includes("--base"));
  assert.equal(focusedArgs[focusedArgs.indexOf("--sandbox") + 1], "read-only");
  const prompt = fs.readFileSync(sandbox.stdinFile, "utf8");
  assert.match(prompt, /current branch compared with main/);
  assert.match(prompt, /concurrency safety/);
  assert.equal(jobRecords(sandbox)[1].request.transport, "focused-review");
});

test("review rejects output schemas because tested Codex review versions ignore them", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["review", "--json", "--output-schema", "schemas/verdict.json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr);
  assert.equal(error.failureKind, "input");
  assert.match(error.message, /review ignores --output-schema on tested CLI versions/);
  assert.equal(fs.existsSync(sandbox.argsFile), false);
});

test("adversarial review is a normal read only task with the explicit review contract", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const result = runCompanion(["adversarial-review", "--scope working-tree --focus cancellation races"], {
    cwd: sandbox.workDir,
    env
  });
  assert.equal(result.status, 0, result.stderr);
  const args = readArgs(sandbox);
  assert.ok(!args.includes("review"));
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  const prompt = fs.readFileSync(sandbox.stdinFile, "utf8");
  assert.match(prompt, /strongest evidence that the reviewed change should not ship yet/);
  assert.match(prompt, /cancellation races/);
  const [record] = jobRecords(sandbox);
  assert.equal(record.request.transport, "adversarial-review");
  assert.equal(record.request.outputSchemaFile, path.join(repoRoot, "plugins", "codex", "schemas", "adversarial-review-verdict.schema.json"));
  assert.deepEqual(args.slice(args.indexOf("--output-schema"), args.indexOf("--output-schema") + 2), ["--output-schema", record.request.outputSchemaFile]);
});

test("cancel terminates the supervised process group and terminal state cannot be overwritten", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { FAKE_CODEX_MODE: "hang" });
  const launched = runCompanion(["task", "--background hang"], { cwd: sandbox.workDir, env });
  assert.equal(launched.status, 0, launched.stderr);
  const running = await waitFor(() => {
    const record = jobRecords(sandbox)[0];
    return record?.codexPid ? record : null;
  });
  const cancelled = runCompanion(["cancel", running.id, "--cwd", sandbox.workDir, "--json"], {
    cwd: sandbox.workDir,
    env
  });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const record = JSON.parse(cancelled.stdout);
  assert.equal(record.status, "cancelled");
  assert.equal(record.failureKind, "cancelled");
  assert.equal(record.pid, null);
  assert.equal(record.codexPid, null);
  const collected = runCompanion(["result", running.id, "--cwd", sandbox.workDir], { cwd: sandbox.workDir, env });
  assert.equal(collected.status, 1);
  assert.match(collected.stdout, /state: cancelled/);
  assert.equal(jobRecords(sandbox)[0].status, "cancelled");
});

for (const signal of ["SIGHUP", "SIGQUIT"]) {
  test(`${signal} stays attached until the foreground Codex group is cancelled`, async (t) => {
    if (process.platform === "win32") {
      t.skip(`${signal} is unavailable on Windows.`);
      return;
    }
    const sandbox = makeSandbox(t);
    const env = envFor(sandbox, { FAKE_CODEX_MODE: "hang" });
    const companionProcess = spawnCompanion(["task", `wait for ${signal}`], { cwd: sandbox.workDir, env });
    const running = await waitFor(() => {
      const record = jobRecords(sandbox)[0];
      return record?.codexPid ? record : null;
    });
    process.kill(companionProcess.pid, signal);
    const result = await childResult(companionProcess);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /state: cancelled/);
    const record = jobRecords(sandbox).find((candidate) => candidate.id === running.id);
    assert.equal(record.status, "cancelled");
    assert.equal(record.pid, null);
    assert.equal(record.codexPid, null);
  });
}

test("a second interrupt cannot bypass foreground cleanup", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX signal behavior is unavailable on Windows.");
    return;
  }
  const sandbox = makeSandbox(t);
  const readyFile = path.join(sandbox.root, "codex-ready");
  const env = envFor(sandbox, { FAKE_CODEX_MODE: "ignore-term", FAKE_CODEX_READY_FILE: readyFile });
  const companionProcess = spawnCompanion(["task", "wait for interrupts"], { cwd: sandbox.workDir, env });
  const running = await waitFor(() => {
    const record = jobRecords(sandbox)[0];
    return record?.codexPid ? record : null;
  });
  await waitFor(() => (fs.existsSync(readyFile) ? true : null));
  process.kill(companionProcess.pid, "SIGINT");
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.kill(companionProcess.pid, "SIGINT");
  const result = await childResult(companionProcess);
  assert.equal(result.code, 1, result.stderr);
  const record = jobRecords(sandbox).find((candidate) => candidate.id === running.id);
  assert.equal(record.status, "cancelled");
  assert.equal(record.pid, null);
  assert.equal(record.codexPid, null);
});

test("cancel retains a live PID when its ownership identity is unavailable", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const dataDir = resolveDataDir(env);
  const id = "unverified-owner";
  const record = createJobRecord({ cwd: sandbox.workDir, id, pid: process.pid });
  writeJobRecordFile(jobFilePath(dataDir, sandbox.workDir, id), record);
  const cancelled = runCompanion(["cancel", id, "--cwd", sandbox.workDir, "--json"], { cwd: sandbox.workDir, env });
  assert.equal(cancelled.status, 1);
  const retained = JSON.parse(cancelled.stdout);
  assert.equal(retained.status, "running");
  assert.equal(retained.phase, "cleanup-required");
  assert.equal(retained.pid, process.pid);
  assert.match(retained.errorMessage, /cleanup did not complete/);
});

test("an incomplete timeout cleanup retains process evidence for retry", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--json", "wait for timeout"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { CODEX_COMPANION_TIMEOUT_MS: "50", FAKE_CODEX_MODE: "inherited-pipe" }),
    timeout: 2000
  });
  assert.equal(result.status, 1, result.stderr);
  const record = JSON.parse(result.stdout);
  assert.equal(record.status, "running");
  assert.equal(record.phase, "cleanup-required");
  assert.ok(Number.isInteger(record.pid));
  assert.ok(Number.isInteger(record.codexPid));
  assert.equal(record.failureKind, "timeout");
});

test("session-end cancels only jobs owned by the ending Claude session", async (t) => {
  const sandbox = makeSandbox(t);
  const otherWorkDir = path.join(sandbox.root, "other-workspace");
  fs.mkdirSync(otherWorkDir);
  const firstEnv = envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-a", FAKE_CODEX_MODE: "hang" });
  const secondEnv = envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "session-b", FAKE_CODEX_MODE: "hang" });
  assert.equal(runCompanion(["task", "--background first"], { cwd: sandbox.workDir, env: firstEnv }).status, 0);
  assert.equal(runCompanion(["task", "--background second"], { cwd: otherWorkDir, env: secondEnv }).status, 0);
  await waitFor(() => jobRecords(sandbox).filter((record) => record.codexPid).length === 2);
  const ended = runCompanion(["session-end"], {
    cwd: sandbox.workDir,
    env: firstEnv,
    input: JSON.stringify({ session_id: "session-a" }),
    timeout: 5000
  });
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(ended.stdout, "");
  const records = jobRecords(sandbox);
  assert.equal(records.find((record) => record.claudeSessionId === "session-a").status, "cancelled");
  const other = records.find((record) => record.claudeSessionId === "session-b");
  assert.equal(other.status, "running");
  runCompanion(["cancel", other.id, "--cwd", otherWorkDir], { cwd: otherWorkDir, env: secondEnv });
});

test("status repairs an ownerless running record as died", async (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS: "0" });
  const dataDir = resolveDataDir(env);
  const id = "ownerless-job";
  const record = createJobRecord({
    createdAt: new Date(Date.now() - 1000).toISOString(),
    cwd: sandbox.workDir,
    id,
    pid: 99999999
  });
  writeJobRecordFile(jobFilePath(dataDir, sandbox.workDir, id), record);
  const status = runCompanion(["status", id, "--cwd", sandbox.workDir, "--json"], { cwd: sandbox.workDir, env });
  assert.equal(status.status, 0, status.stderr);
  const repaired = JSON.parse(status.stdout);
  assert.equal(repaired.status, "error");
  assert.equal(repaired.failureKind, "died");
  assert.match(repaired.errorMessage, /exited without recording a terminal outcome/);
});

test("setup verifies authentication and the tested Codex version interval", (t) => {
  const sandbox = makeSandbox(t);
  const ready = runCompanion(["setup", "--json"], { cwd: sandbox.workDir, env: envFor(sandbox, { FAKE_CODEX_VERSION: "0.147.0" }) });
  assert.equal(ready.status, 0, ready.stderr);
  const readyReport = JSON.parse(ready.stdout);
  assert.equal(readyReport.ready, true);
  assert.equal(readyReport.compatibility, "tested");
  assert.equal(readyReport.authenticated, true);
  for (const version of ["0.147.0-alpha.10", "0.147.0-alpha.10.1"]) {
    const alpha = runCompanion(["setup", "--json"], {
      cwd: sandbox.workDir,
      env: envFor(sandbox, { FAKE_CODEX_VERSION: version })
    });
    assert.equal(alpha.status, 0, alpha.stderr);
    const alphaReport = JSON.parse(alpha.stdout);
    assert.equal(alphaReport.ready, true);
    assert.equal(alphaReport.compatibility, "tested");
  }
  const redacted = runCompanion(["setup", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_CODEX_AUTH_DETAIL: "Logged in with api_key=sk-secretvalue123" })
  });
  assert.equal(redacted.status, 0, redacted.stderr);
  assert.doesNotMatch(JSON.stringify(JSON.parse(redacted.stdout)), /sk-secretvalue123/);
  const redactedVersion = runCompanion(["setup", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_CODEX_VERSION_OUTPUT: "codex-cli 0.147.0 access_token=secretversionvalue" })
  });
  assert.equal(redactedVersion.status, 0, redactedVersion.stderr);
  assert.doesNotMatch(JSON.stringify(JSON.parse(redactedVersion.stdout)), /secretversionvalue/);
  const signedOut = runCompanion(["setup", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { CODEX_API_KEY: "", FAKE_CODEX_AUTH: "false" })
  });
  assert.equal(signedOut.status, 1);
  assert.equal(JSON.parse(signedOut.stdout).authenticated, false);
  const apiKey = runCompanion(["setup", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { CODEX_API_KEY: "codex-test-key", FAKE_CODEX_AUTH: "false" })
  });
  assert.equal(apiKey.status, 0, apiKey.stderr);
  const apiKeyReport = JSON.parse(apiKey.stdout);
  assert.equal(apiKeyReport.authenticated, true);
  assert.equal(apiKeyReport.authenticationDetail, "authenticated via CODEX_API_KEY environment variable (login status reports logged out)");
  assert.equal(apiKeyReport.ready, true);
  assert.doesNotMatch(apiKey.stdout, /codex-test-key/);
  const unsupported = runCompanion(["setup", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_CODEX_VERSION: "0.148.0" })
  });
  assert.equal(unsupported.status, 1);
  const unsupportedReport = JSON.parse(unsupported.stdout);
  assert.equal(unsupportedReport.ready, false);
  assert.match(unsupportedReport.compatibility, /newer than the tested interval \(0\.147\.0 to before 0\.148\.0\)/);
  assert.match(unsupportedReport.nextSteps.join("\n"), /A verification pass is advised\./);
});

test("the companion module can be imported without executing its CLI", async () => {
  const module = await import(`${pathToFileURL(companion).href}?test=${Date.now()}`);
  assert.equal(typeof module.repairRunningRecordSync, "function");
  assert.equal(typeof module.refreshRunningJobRecord, "function");
  assert.equal(typeof module.runningRecordNeedsReconciliation, "function");
});
