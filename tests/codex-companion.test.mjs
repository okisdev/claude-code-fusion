import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  createJobRecord,
  jobFilePath,
  resolveDataDir,
  writeJobRecordFile
} from "../plugins/codex/scripts/lib/state.mjs";
import {
  companion,
  envFor,
  jobEntries,
  jobRecords,
  makeSandbox,
  readArgs,
  runCompanion,
  spawnCompanion,
  waitFor
} from "./lib/codex-companion-harness.mjs";

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

test("task stays foreground by default and persists the complete terminal record", (t) => {
  const sandbox = makeSandbox(t);
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
  assert.equal(entry.record.resolvedModel, null);
  assert.equal(entry.record.resolvedEffort, null);
  assert.equal(entry.record.tokenUsageAvailability, "available");
  assert.equal(entry.record.codexVersion, "0.144.4");
  assert.equal(fs.statSync(entry.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(entry.file)).mode & 0o777, 0o700);
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

test("a staged Fusion worktree request selects the Codex cwd and workspace root", (t) => {
  const sandbox = makeSandbox(t);
  const sibling = path.join(sandbox.root, "sibling worktree");
  execFileSync("git", ["init", "-q"], { cwd: sandbox.workDir });
  execFileSync(
    "git",
    ["-c", "user.email=fusion-test@example.com", "-c", "user.name=fusion-test", "commit", "--allow-empty", "-q", "-m", "init"],
    { cwd: sandbox.workDir }
  );
  execFileSync("git", ["worktree", "add", "-q", "-b", "fusion-sibling", sibling], { cwd: sandbox.workDir });
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
  const transportDirectory = path.join(os.tmpdir(), `codex-companion-input-${token}`);
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

test("Codex slash commands never interpolate raw arguments into shell source", () => {
  const commandsDirectory = path.join(path.dirname(companion), "..", "commands");
  for (const name of fs.readdirSync(commandsDirectory)) {
    if (!name.endsWith(".md")) {
      continue;
    }
    const content = fs.readFileSync(path.join(commandsDirectory, name), "utf8");
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
    env: envFor(outdated, { FAKE_CODEX_VERSION: "0.143.9" })
  });
  assert.equal(outdatedResult.status, 1);
  assert.equal(outdatedResult.stdout, "");
  const outdatedFailure = JSON.parse(outdatedResult.stderr);
  assert.equal(outdatedFailure.status, "error");
  assert.equal(outdatedFailure.failureKind, "setup");
  assert.match(outdatedFailure.message, /Upgrade the Codex CLI to version 0\.144\.0 or later\./);
  assert.equal(fs.existsSync(outdated.argsFile), false);
  assert.deepEqual(jobRecords(outdated), []);

  const text = makeSandbox(t);
  const textResult = runCompanion(["task", "do work"], {
    cwd: text.workDir,
    env: envFor(text, { FAKE_CODEX_VERSION: "0.143.9" })
  });
  assert.equal(textResult.status, 1);
  assert.equal(textResult.stdout, "");
  assert.match(textResult.stderr, /Upgrade the Codex CLI to version 0\.144\.0 or later\./);
  assert.match(textResult.stderr, /failure: setup/);
  assert.equal(fs.existsSync(text.argsFile), false);
  assert.deepEqual(jobRecords(text), []);
});

test("task proceeds with tested and newer Codex CLI versions", (t) => {
  for (const version of ["0.144.0", "0.145.0"]) {
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

test("job records persist only rollout-observed model and effort as resolved fields", (t) => {
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

test("foreground timeout persists recovered partial delivery and incomplete cumulative usage", (t) => {
  const sandbox = makeSandbox(t);
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
  assert.equal(record.resultText, null);
  assert.equal(record.partialResultText, "Recovered partial Codex output.");
  assert.equal(record.tokenUsageAvailability, "partial");
  assert.equal(record.usageIsIncomplete, true);
  assert.equal(record.resolvedModel, "gpt-resolved");
  assert.equal(record.resolvedEffort, "xhigh");
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

test("main workspace and a sibling worktree admit concurrent tasks for the same repository", async (t) => {
  const sandbox = makeSandbox(t);
  const sibling = path.join(sandbox.root, "sibling-worktree");
  execFileSync("git", ["init", "-q"], { cwd: sandbox.workDir });
  execFileSync(
    "git",
    ["-c", "user.email=fusion-test@example.com", "-c", "user.name=fusion-test", "commit", "--allow-empty", "-q", "-m", "init"],
    { cwd: sandbox.workDir }
  );
  execFileSync("git", ["worktree", "add", "-q", "-b", "sibling-worktree", sibling], { cwd: sandbox.workDir });
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
  assert.equal(jobRecords(sandbox)[0].request.transport, "adversarial-review");
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
  const ready = runCompanion(["setup", "--json"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.equal(ready.status, 0, ready.stderr);
  const readyReport = JSON.parse(ready.stdout);
  assert.equal(readyReport.ready, true);
  assert.equal(readyReport.compatibility, "tested");
  assert.equal(readyReport.authenticated, true);
  const redacted = runCompanion(["setup", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_CODEX_AUTH_DETAIL: "Logged in with api_key=sk-secretvalue123" })
  });
  assert.equal(redacted.status, 0, redacted.stderr);
  assert.doesNotMatch(JSON.stringify(JSON.parse(redacted.stdout)), /sk-secretvalue123/);
  const redactedVersion = runCompanion(["setup", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_CODEX_VERSION_OUTPUT: "codex-cli 0.144.4 access_token=secretversionvalue" })
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
    env: envFor(sandbox, { FAKE_CODEX_VERSION: "0.145.0" })
  });
  assert.equal(unsupported.status, 1);
  const unsupportedReport = JSON.parse(unsupported.stdout);
  assert.equal(unsupportedReport.ready, false);
  assert.match(unsupportedReport.compatibility, /outside the tested/);
});

test("the companion module can be imported without executing its CLI", async () => {
  const module = await import(`${pathToFileURL(companion).href}?test=${Date.now()}`);
  assert.equal(typeof module.refreshRunningJobRecord, "function");
});
