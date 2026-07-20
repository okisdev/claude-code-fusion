import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  envFor,
  flagValues,
  jobRecords,
  makeSandbox,
  readInvocations,
  repoRoot,
  runCompanion,
  stateModulePath,
  waitFor
} from "./lib/companion-harness.mjs";
import { initFixtureRepo } from "./lib/git-fixture.mjs";

const {
  appendJobLog,
  briefPath,
  createJobRecord,
  createJobRecordFile,
  jobFilePath,
  jobLogPath,
  writeBrief
} = await import(stateModulePath);

function permissions(file) {
  return fs.statSync(file).mode & 0o777;
}

function createRawTransport(sandbox, env, request) {
  const created = runCompanion(["transport-create"], { cwd: sandbox.workDir, env });
  assert.equal(created.status, 0, created.stderr);
  const transport = JSON.parse(created.stdout);
  assert.match(transport.token, /^[a-f0-9]{48}$/);
  assert.equal(permissions(path.dirname(transport.file)), 0o700);
  assert.equal(permissions(transport.file), 0o600);
  assert.equal(permissions(path.join(path.dirname(transport.file), "owner.json")), 0o600);
  const identity = fs.statSync(transport.file);
  assert.equal(fs.readFileSync(transport.file, "utf8"), "");
  fs.writeFileSync(transport.file, request);
  const written = fs.statSync(transport.file);
  assert.equal(written.dev, identity.dev);
  assert.equal(written.ino, identity.ino);
  assert.equal(permissions(transport.file), 0o600);
  return transport;
}

function ageRawTransport(transport, ageMs) {
  const ownerFile = path.join(path.dirname(transport.file), "owner.json");
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  fs.writeFileSync(ownerFile, `${JSON.stringify({ ...owner, createdAt: Date.now() - ageMs })}\n`);
  fs.chmodSync(ownerFile, 0o600);
}

test("every Grok slash command keeps raw arguments out of shell command text", () => {
  for (const name of ["task", "review", "best-of-n", "status", "history", "result", "cancel", "stats", "setup"]) {
    const file = path.join(repoRoot, "plugins", "grok", "skills", name, "SKILL.md");
    const content = fs.readFileSync(file, "utf8");
    assert.equal(content.match(/\$ARGUMENTS/g)?.length, 1, name);
    assert.match(content, /\n\$ARGUMENTS\n?$/, name);
    assert.doesNotMatch(content, /(?:node|bash|sh|zsh)[^\n]*\$ARGUMENTS/i, name);
    assert.doesNotMatch(content, /!`[^\n]*\$ARGUMENTS/, name);
  }
});

test("Grok forwarding agents keep only validated capabilities in Bash argv", () => {
  const rescue = fs.readFileSync(path.join(repoRoot, "plugins", "grok", "agents", "grok-rescue.md"), "utf8");
  const reviewRunner = fs.readFileSync(path.join(repoRoot, "plugins", "grok", "agents", "grok-review-runner.md"), "utf8");
  const runtime = fs.readFileSync(path.join(repoRoot, "plugins", "grok", "skills", "grok-cli-runtime", "SKILL.md"), "utf8");
  assert.match(rescue, /^background: false$/m);
  assert.match(rescue, /48 character lowercase hexadecimal token/);
  assert.doesNotMatch(rescue, /task [^\n]*(?:raw request|brief|\$ARGUMENTS)/i);
  assert.match(reviewRunner, /^background: true$/m);
  assert.match(reviewRunner, /exactly 32 lowercase hexadecimal characters/);
  assert.doesNotMatch(reviewRunner, /`[^`\n]*result[^`\n]*--cwd[^`\n]*`/);
  assert.doesNotMatch(reviewRunner, /review [^\n]*(?:raw review request|\$ARGUMENTS)/i);
  assert.match(runtime, /dedicated review runner is the sole managed worker exception/);
  assert.match(runtime, /omits the raw launch `--cwd`/);
  assert.doesNotMatch(runtime, /Every result call repeats the launch `--cwd`/);
});

test("staged task arguments preserve shell metacharacters and newlines without executing them", (t) => {
  const sandbox = makeSandbox(t);
  const stdinFile = path.join(sandbox.root, "raw-task-stdin.txt");
  const firstSentinel = path.join(sandbox.root, "command-substitution-ran");
  const secondSentinel = path.join(sandbox.root, "backticks-ran");
  const prompt = `  line one "quotes" $(touch ${firstSentinel})\nline two \`touch ${secondSentinel}\` $HOME \\\n`;
  const request = `--json --\n${prompt}`;
  const env = envFor(sandbox, { FAKE_GROK_STDIN_FILE: stdinFile });
  const transport = createRawTransport(sandbox, env, request);
  const directory = path.dirname(transport.file);

  const result = runCompanion([
    "task",
    "--transport-default-write",
    "--raw-args-token",
    transport.token
  ], { cwd: sandbox.workDir, env });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "write");
  assert.equal(fs.readFileSync(stdinFile, "utf8"), prompt);
  assert.equal(fs.existsSync(firstSentinel), false);
  assert.equal(fs.existsSync(secondSentinel), false);
  assert.equal(fs.existsSync(directory), false);
  const [record] = jobRecords(sandbox.dataDir);
  assert.equal(record.request.ingress, "staged_file");
  assert.equal(record.mode, "write");

  const replay = runCompanion(["task", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env
  });
  assert.notEqual(replay.status, 0);
  assert.match(replay.stderr, /^failure: input$/m);
});

test("staged task validation errors honor raw JSON output", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const transport = createRawTransport(sandbox, env, "--json --max-turns nope -- task");
  const result = runCompanion(["task", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.status, "error");
  assert.equal(payload.failureKind, "input");
  assert.match(payload.message, /positive integer.*--max-turns/i);
});

test("task option shaped prompt suffixes cannot enable background, write, cwd, or JSON", (t) => {
  const sandbox = makeSandbox(t);
  const stdinFile = path.join(sandbox.root, "option-shaped-prompt.txt");
  const prompt = "Fix support for --background --write --cwd /tmp --json";
  const env = envFor(sandbox, { FAKE_GROK_STDIN_FILE: stdinFile });
  const transport = createRawTransport(sandbox, env, prompt);
  const result = runCompanion(["task", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^state: done$/m);
  assert.equal(fs.readFileSync(stdinFile, "utf8"), prompt);
  const [record] = jobRecords(sandbox.dataDir);
  assert.equal(record.background, false);
  assert.equal(record.mode, "consult");
  assert.equal(record.cwd, sandbox.workDir);
  assert.equal(record.request.outputJson, false);
  const [argv] = readInvocations(sandbox.argsFile);
  assert.equal(flagValues(argv, "--sandbox")[0], "strict");
});

test("prompt suffix json does not change staged validation error formatting", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const transport = createRawTransport(sandbox, env, "--max-turns nope Fix support for --json");
  const result = runCompanion(["task", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Expected a positive integer for --max-turns/);
  assert.match(result.stderr, /^failure: input$/m);
  assert.throws(() => JSON.parse(result.stderr));
});

test("raw transport rejects widened request permissions and removes the verified transport", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const transport = createRawTransport(sandbox, env, "private request");
  const directory = path.dirname(transport.file);
  fs.chmodSync(transport.file, 0o644);

  const result = runCompanion(["task", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /transport file is not private/i);
  assert.match(result.stderr, /^failure: permission$/m);
  assert.equal(fs.existsSync(directory), false);
});

test("raw transport is bound to the Claude session that created it", (t) => {
  const sandbox = makeSandbox(t);
  const ownerEnv = envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "claude-owner" });
  const otherEnv = envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "claude-other" });
  const transport = createRawTransport(sandbox, ownerEnv, "session bound request");
  const directory = path.dirname(transport.file);

  const rejected = runCompanion(["task", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env: otherEnv
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /belongs to another Claude session/i);
  assert.match(rejected.stderr, /^failure: permission$/m);
  assert.equal(fs.existsSync(directory), true);
  assert.deepEqual(readInvocations(sandbox.argsFile), []);

  const accepted = runCompanion(["task", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env: ownerEnv
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(fs.existsSync(directory), false);
});

test("expired raw transports are rejected and removed", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "claude-owner" });
  const transport = createRawTransport(sandbox, env, "expired request");
  const directory = path.dirname(transport.file);
  ageRawTransport(transport, 60 * 60 * 1000 + 1);

  const result = runCompanion(["task", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /transport has expired/i);
  assert.match(result.stderr, /^failure: input$/m);
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(readInvocations(sandbox.argsFile), []);
});

test("transport allocation removes verified expired transports left by crashed sessions globally", (t) => {
  const sandbox = makeSandbox(t);
  const first = createRawTransport(
    sandbox,
    envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "crashed-session-a" }),
    "abandoned request a"
  );
  const second = createRawTransport(
    sandbox,
    envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "crashed-session-b" }),
    "abandoned request b"
  );
  const fresh = createRawTransport(
    sandbox,
    envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "active-session" }),
    "fresh request"
  );
  const directories = [first, second, fresh].map((transport) => path.dirname(transport.file));
  t.after(() => {
    for (const directory of directories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  ageRawTransport(first, 60 * 60 * 1000 + 1);
  ageRawTransport(second, 60 * 60 * 1000 + 1);

  const allocated = runCompanion(["transport-create"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "cleanup-session" })
  });
  assert.equal(allocated.status, 0, allocated.stderr);
  const replacement = JSON.parse(allocated.stdout);
  const replacementDirectory = path.dirname(replacement.file);
  t.after(() => fs.rmSync(replacementDirectory, { recursive: true, force: true }));

  assert.equal(fs.existsSync(directories[0]), false);
  assert.equal(fs.existsSync(directories[1]), false);
  assert.equal(fs.existsSync(directories[2]), true);
  assert.equal(fs.existsSync(replacementDirectory), true);
});

test("global transport cleanup leaves widened and symlink staging paths untouched", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, { CLAUDE_CODE_SESSION_ID: "unverified-session" });
  const widened = createRawTransport(sandbox, env, "widened request");
  const widenedDirectory = path.dirname(widened.file);
  t.after(() => fs.rmSync(widenedDirectory, { recursive: true, force: true }));
  ageRawTransport(widened, 60 * 60 * 1000 + 1);
  fs.chmodSync(widened.file, 0o644);

  const symlinkTarget = path.join(sandbox.root, "symlink-target");
  fs.mkdirSync(symlinkTarget);
  const sentinel = path.join(symlinkTarget, "sentinel");
  fs.writeFileSync(sentinel, "keep");
  const transportRoot = path.dirname(widenedDirectory);
  const symlinkPath = path.join(transportRoot, `grok-companion-input-${randomBytes(24).toString("hex")}`);
  fs.symlinkSync(symlinkTarget, symlinkPath, "dir");
  t.after(() => fs.rmSync(symlinkPath, { force: true }));

  const allocated = runCompanion(["transport-create"], { cwd: sandbox.workDir, env });
  assert.equal(allocated.status, 0, allocated.stderr);
  const replacementDirectory = path.dirname(JSON.parse(allocated.stdout).file);
  t.after(() => fs.rmSync(replacementDirectory, { recursive: true, force: true }));

  assert.equal(fs.existsSync(widenedDirectory), true);
  assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
});

test("transport discard consumes an unused request without invoking Grok", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const transport = createRawTransport(sandbox, env, "unused request");
  const directory = path.dirname(transport.file);
  const discarded = runCompanion(["transport-discard", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env
  });

  assert.equal(discarded.status, 0, discarded.stderr);
  assert.equal(fs.existsSync(directory), false);
  assert.deepEqual(readInvocations(sandbox.argsFile), []);
});

test("status, history, result, cancel, stats, and setup parse staged raw arguments", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const task = runCompanion(["task", "--json", "seed a completed job"], {
    cwd: sandbox.workDir,
    env
  });
  assert.equal(task.status, 0, task.stderr);
  const jobId = JSON.parse(task.stdout).jobId;

  const requests = [
    ["status", `${jobId} --json`],
    ["history", "--limit 1 --json"],
    ["result", `${jobId} --json`],
    ["cancel", `${jobId} --json`],
    ["stats", "--json"],
    ["setup", "--json"]
  ];
  for (const [command, request] of requests) {
    const transport = createRawTransport(sandbox, env, request);
    const directory = path.dirname(transport.file);
    const result = runCompanion([command, "--raw-args-token", transport.token], {
      cwd: sandbox.workDir,
      env
    });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.doesNotThrow(() => JSON.parse(result.stdout), command);
    assert.equal(fs.existsSync(directory), false, command);
  }
});

test("task records valid Fusion roles and rejects invalid role values", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const valid = runCompanion(["task", "--json", "fusion-brief: v1\ngrok-role: live-web\nResearch the current API."], {
    cwd: sandbox.workDir,
    env
  });
  const invalid = runCompanion(["task", "--json", "fusion-brief: v1\ngrok-role: unsupported\nResearch the current API."], {
    cwd: sandbox.workDir,
    env
  });

  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(invalid.status, 0, invalid.stderr);
  const recordsById = new Map(jobRecords(sandbox.dataDir).map((record) => [record.id, record]));
  const validRecord = recordsById.get(JSON.parse(valid.stdout).jobId);
  const invalidRecord = recordsById.get(JSON.parse(invalid.stdout).jobId);
  assert.equal(validRecord.role, "live-web");
  assert.equal(validRecord.request.role, "live-web");
  assert.equal(invalidRecord.role, null);
  assert.equal(invalidRecord.request.role, null);
});

test("fixed best-of-n transport defaults preserve opaque prompts and accept the slash command n alias", (t) => {
  const sandbox = makeSandbox(t);
  const stdinLog = path.join(sandbox.root, "best-of-n-stdin.jsonl");
  const env = envFor(sandbox, { FAKE_GROK_STDIN_LOG: stdinLog });
  const requests = [
    { raw: "--json -- tournament default", expected: "2", prompt: "tournament default" },
    { raw: "--json --n 4 -- tournament explicit", expected: "4", prompt: "tournament explicit" }
  ];

  for (const request of requests) {
    const transport = createRawTransport(sandbox, env, request.raw);
    const result = runCompanion([
      "task",
      "--transport-default-best-of-n",
      "--raw-args-token",
      transport.token
    ], { cwd: sandbox.workDir, env });
    assert.equal(result.status, 0, result.stderr);
  }

  const invocations = readInvocations(sandbox.argsFile);
  assert.deepEqual(invocations.map((argv) => flagValues(argv, "--best-of-n")[0]), ["2", "4"]);
  const prompts = fs.readFileSync(stdinLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(prompts, requests.map((request) => request.prompt));
});

test("invalid Grok session identifiers fail as transport errors and cannot reach summary paths or resume", (t) => {
  const sandbox = makeSandbox(t);
  const grokHome = path.join(sandbox.root, "grok-home");
  const escapedSummary = path.join(grokHome, "attacker", "summary.json");
  fs.mkdirSync(path.dirname(escapedSummary), { recursive: true });
  fs.writeFileSync(escapedSummary, JSON.stringify({
    current_model_id: "should-not-be-observed",
    reasoning_effort: "should-not-be-observed"
  }));
  const env = envFor(sandbox, {
    GROK_HOME: grokHome,
    FAKE_GROK_MODE: "malicious-session-id"
  });
  const result = runCompanion(["task", "--json", "inspect session metadata"], {
    cwd: sandbox.workDir,
    env
  });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.failureKind, "transport");
  assert.match(payload.message, /invalid session identifier/i);
  const [record] = jobRecords(sandbox.dataDir);
  assert.equal(record.sessionId, null);
  assert.equal(record.resolvedModel, null);
  assert.equal(record.resolvedEffort, null);
  assert.equal(record.numTurns, 2);
  assert.equal(record.usageIsIncomplete, true);
  assert.equal(record.modelUsageIsIncomplete, false);

  const stats = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.equal(stats.status, 0, stats.stderr);
  assert.deepEqual(JSON.parse(stats.stdout).usageCoverage, {
    availability: "unavailable",
    completeJobs: 0,
    incompleteJobs: 1,
    unreportedJobs: 0,
  });

  const resume = runCompanion(["task", "--resume", "../../attacker", "continue"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.notEqual(resume.status, 0);
  assert.match(resume.stderr, /^failure: input$/m);
  assert.equal(readInvocations(sandbox.argsFile).length, 1);
});

test("staged review focus stays data while managed delivery is collected", async (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const sentinel = path.join(sandbox.root, "review-substitution-ran");
  const stdinFile = path.join(sandbox.root, "raw-review-stdin.txt");
  const focus = `inspect quoted paths and $(touch ${sentinel})\nthen inspect backticks \`touch ${sentinel}\``;
  const request = `--json --background=false --\n${focus}`;
  const env = envFor(sandbox, {
    FAKE_GROK_MODE: "review-ok",
    FAKE_GROK_STDIN_FILE: stdinFile,
    GROK_COMPANION_BACKGROUND_DELIVERY: "managed",
    GROK_COMPANION_WAIT_POLL_MS: "10"
  }, { git: true });
  const transport = createRawTransport(sandbox, env, request);
  const launch = runCompanion([
    "review",
    "--transport-default-background",
    "--raw-args-token",
    transport.token
  ], { cwd: sandbox.workDir, env });

  assert.equal(launch.status, 0, launch.stderr);
  const receipt = JSON.parse(launch.stdout);
  assert.equal(receipt.delivery, "managed");
  assert.equal(receipt.deliveryStatus, "pending");
  await waitFor(() => jobRecords(sandbox.dataDir).find((record) => record.id === receipt.jobId && record.status === "done"));
  const result = runCompanion(["result", receipt.jobId, "--wait", "--json"], {
    cwd: sandbox.workDir,
    env
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).deliveryStatus, "collected");
  assert.ok(fs.readFileSync(stdinFile, "utf8").includes(focus));
  assert.equal(fs.existsSync(sentinel), false);
  const record = jobRecords(sandbox.dataDir).find((candidate) => candidate.id === receipt.jobId);
  assert.equal(record.request.ingress, "staged_file");
});

for (const scenario of [
  { name: "strict consult", args: ["task", "inspect the repository safely"] },
  { name: "strict consult with web", args: ["task", "--web", "research the current behavior"] }
]) {
  test(`${scenario.name} sends the prompt through stdin instead of the external history brief`, (t) => {
    const sandbox = makeSandbox(t);
    const stdinFile = path.join(sandbox.root, "stdin.txt");
    const prompt = scenario.args.at(-1);
    const result = runCompanion(scenario.args, {
      cwd: sandbox.workDir,
      env: envFor(sandbox, {
        FAKE_GROK_REJECT_EXTERNAL_PROMPT: "1",
        FAKE_GROK_STDIN_FILE: stdinFile
      })
    });

    assert.equal(result.status, 0, result.stderr);
    const [argv] = readInvocations(sandbox.argsFile);
    assert.deepEqual(flagValues(argv, "--prompt-file"), ["/dev/stdin"]);
    assert.equal(argv.includes(prompt), false);
    assert.equal(fs.readFileSync(stdinFile, "utf8"), prompt);
    const [record] = jobRecords(sandbox.dataDir);
    assert.equal(fs.readFileSync(record.briefFile, "utf8"), prompt);
    assert.equal(permissions(record.briefFile), 0o600);
    assert.equal(record.request.sandboxProfile, "strict");
  });
}

test("resume and write runs retain stdin prompt transport and the requested sandbox", (t) => {
  const sandbox = makeSandbox(t);
  const stdinLog = path.join(sandbox.root, "stdin.jsonl");
  const env = envFor(sandbox, {
    FAKE_GROK_REJECT_EXTERNAL_PROMPT: "1",
    FAKE_GROK_STDIN_LOG: stdinLog,
    CLAUDE_CODE_SESSION_ID: "claude-current"
  });

  const first = runCompanion(["task", "first consult"], { cwd: sandbox.workDir, env });
  assert.equal(first.status, 0, first.stderr);
  const source = jobRecords(sandbox.dataDir).find((record) => record.request?.resumeSessionId == null);
  const resumed = runCompanion(["task", "--resume", source.sessionId, "resume consult"], {
    cwd: sandbox.workDir,
    env
  });
  assert.equal(resumed.status, 0, resumed.stderr);
  const write = runCompanion(["task", "--write", "change the repository"], {
    cwd: sandbox.workDir,
    env
  });
  assert.equal(write.status, 0, write.stderr);

  const invocations = readInvocations(sandbox.argsFile);
  assert.equal(invocations.length, 3);
  assert.ok(invocations.every((argv) => flagValues(argv, "--prompt-file")[0] === "/dev/stdin"));
  assert.ok(invocations[1].includes("-r"));
  assert.deepEqual(invocations.map((argv) => flagValues(argv, "--sandbox")[0]), ["strict", "strict", "strict"]);
  const prompts = fs.readFileSync(stdinLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(prompts, ["first consult", "resume consult", "change the repository"]);
});

test("job outcomes record observed model, effort, transport, delivery, and semantic state", (t) => {
  const sandbox = makeSandbox(t);
  const grokHome = path.join(sandbox.root, "grok-home");
  const env = envFor(sandbox, {
    GROK_HOME: grokHome,
    FAKE_GROK_RESOLVED_MODEL: "grok-observed",
    FAKE_GROK_RESOLVED_EFFORT: "xhigh"
  });
  const result = runCompanion(["task", "--model", "grok-requested", "--effort", "low", "--json", "observe metadata"], {
    cwd: sandbox.workDir,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "done");
  assert.equal(payload.transportStatus, payload.status);
  assert.equal(payload.semanticStatus, "unverified");
  assert.equal(payload.delivery, "foreground");
  assert.equal(payload.deliveryStatus, "delivered");
  assert.equal(payload.resolvedModel, "grok-observed");
  assert.equal(payload.resolvedEffort, "xhigh");
  const [record] = jobRecords(sandbox.dataDir);
  assert.equal(record.transportStatus, record.status);
  assert.equal(record.semanticStatus, "unverified");
  assert.equal(record.deliveryStatus, "delivered");
  assert.equal(record.resolvedModel, "grok-observed");
  assert.equal(record.resolvedEffort, "xhigh");

  const statsResult = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
  assert.equal(statsResult.status, 0, statsResult.stderr);
  const stats = JSON.parse(statsResult.stdout);
  assert.deepEqual(stats.byResolvedModel, { "grok-observed": 1 });
  assert.deepEqual(stats.byResolvedEffort, { xhigh: 1 });
});

test("manual background delivery stays pending until its owner collects the terminal result", async (t) => {
  const sandbox = makeSandbox(t);
  const stdinFile = path.join(sandbox.root, "background-stdin.txt");
  const prompt = "  background work\nwith exact trailing space ";
  const env = envFor(sandbox, {
    FAKE_GROK_STDIN_FILE: stdinFile,
    GROK_COMPANION_WAIT_POLL_MS: "10"
  });
  const transport = createRawTransport(sandbox, env, `--background --json --\n${prompt}`);
  const launch = runCompanion(["task", "--raw-args-token", transport.token], {
    cwd: sandbox.workDir,
    env
  });
  assert.equal(launch.status, 0, launch.stderr);
  const receipt = JSON.parse(launch.stdout);
  assert.equal(receipt.status, "running");
  assert.equal(receipt.transportStatus, receipt.status);
  assert.equal(receipt.delivery, "manual");
  assert.equal(receipt.deliveryStatus, "pending");
  assert.equal(receipt.semanticStatus, "unverified");

  const done = await waitFor(() => {
    const record = jobRecords(sandbox.dataDir).find((candidate) => candidate.id === receipt.jobId);
    return record?.status === "done" ? record : null;
  });
  assert.equal(done.deliveryStatus, "pending");
  assert.equal(fs.readFileSync(stdinFile, "utf8"), prompt);
  const result = runCompanion(["result", receipt.jobId, "--wait", "--json"], {
    cwd: sandbox.workDir,
    env
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.transportStatus, "done");
  assert.equal(payload.delivery, "manual");
  assert.equal(payload.deliveryStatus, "collected");
  const collected = jobRecords(sandbox.dataDir).find((candidate) => candidate.id === receipt.jobId);
  assert.equal(collected.deliveryStatus, "collected");
  assert.ok(collected.deliveryCollectedAt);
});

test("permission and malformed envelope failures retain distinct classifications", (t) => {
  const sandbox = makeSandbox(t);
  const permission = runCompanion(["task", "read a protected input"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "operation-not-permitted" })
  });
  assert.notEqual(permission.status, 0);
  assert.match(permission.stderr, /^failure: permission$/m);

  const transport = runCompanion(["task", "return a malformed envelope"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "invalid-json" })
  });
  assert.notEqual(transport.status, 0);
  assert.match(transport.stderr, /^failure: transport$/m);
  const records = jobRecords(sandbox.dataDir);
  assert.equal(records.find((record) => record.failureKind === "permission")?.transportStatus, "error");
  assert.equal(records.find((record) => record.failureKind === "transport")?.transportStatus, "error");
});

test("state, history, log, temporary lock owner, and lock metadata permissions stay private under umask zero", async (t) => {
  const sandbox = makeSandbox(t);
  fs.chmodSync(sandbox.dataDir, 0o777);
  const jobId = "private-state";
  const jobFile = jobFilePath(sandbox.dataDir, sandbox.workDir, jobId);
  const logFile = jobLogPath(sandbox.dataDir, sandbox.workDir, jobId);
  const briefFile = briefPath(sandbox.dataDir, sandbox.workDir, jobId);
  const previousUmask = process.umask(0);
  try {
    createJobRecordFile(jobFile, createJobRecord({
      id: jobId,
      cwd: sandbox.workDir,
      mode: "consult",
      briefFile,
      background: false
    }));
    writeBrief(sandbox.dataDir, sandbox.workDir, jobId, "private prompt");
    appendJobLog(logFile, "private log");
  } finally {
    process.umask(previousUmask);
  }

  const workspaceDir = path.dirname(path.dirname(jobFile));
  for (const dir of [
    sandbox.dataDir,
    path.join(sandbox.dataDir, "state"),
    workspaceDir,
    path.dirname(jobFile),
    path.dirname(briefFile)
  ]) {
    assert.equal(permissions(dir), 0o700, dir);
  }
  for (const file of [jobFile, briefFile, logFile]) {
    assert.equal(permissions(file), 0o600, file);
  }

  const readyFile = path.join(sandbox.root, "lock-ready");
  const releaseFile = path.join(sandbox.root, "lock-release");
  const source = `
import fs from "node:fs";
const [stateUrl, file, ready, release] = process.argv.slice(1);
const state = await import(stateUrl);
state.updateJobRecordFileWithCurrent(file, (current) => {
  fs.writeFileSync(ready, "ready");
  while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  return current;
});
`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source, stateModulePath, jobFile, readyFile, releaseFile], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGKILL"));
  await waitFor(() => fs.existsSync(readyFile));
  const lockPath = `${jobFile}.lock`;
  const ownerDir = fs.realpathSync(lockPath);
  assert.equal(permissions(ownerDir), 0o700);
  assert.equal(permissions(path.join(ownerDir, "owner.json")), 0o600);
  fs.writeFileSync(releaseFile, "release");
  const [code] = await new Promise((resolve) => child.once("close", (...args) => resolve(args)));
  assert.equal(code, 0);
  assert.equal(fs.existsSync(lockPath), false);
});
