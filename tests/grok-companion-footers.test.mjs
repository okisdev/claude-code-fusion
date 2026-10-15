import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { renderJobDetail, renderTaskResult } from "../plugins/grok/scripts/lib/render.mjs";
import { createJobRecord, createJobRecordFile, finishSuccessfulJobRecordFile, jobFilePath, jobLogPath } from "../plugins/grok/scripts/lib/state.mjs";
import { envFor, makeSandbox, runCompanion } from "./lib/companion-harness.mjs";
import { initCleanRepo } from "./lib/git-fixture.mjs";

function footerLines(value) {
  return value.trimEnd().split("\n").filter((line) => /^(?:structured|grok-session|job|sandbox|delivery|semantic|warning|state|failure):/.test(line));
}

function identityBin(sandbox) {
  const bin = path.join(sandbox.root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ps"), '#!/bin/sh\nprintf "process-%s\\n" "$*"\n');
  fs.writeFileSync(path.join(bin, "sysctl"), '#!/bin/sh\nprintf "{ sec = 1, usec = 0 }\\n"\n');
  fs.chmodSync(path.join(bin, "ps"), 0o755);
  fs.chmodSync(path.join(bin, "sysctl"), 0o755);
  return bin;
}

function withIdentityPath(sandbox, action) {
  const original = process.env.PATH;
  process.env.PATH = `${identityBin(sandbox)}${path.delimiter}${original}`;
  try {
    return action();
  } finally {
    process.env.PATH = original;
  }
}

test("task and job detail footers retain contract order and pair job with sandbox", () => {
  const task = renderTaskResult({ text: "answer", schemaRequested: true, structuredOutput: {}, sessionId: "session-1", jobId: "job-1", cwd: "/work", delivery: "managed", semanticStatus: "accepted" });
  assert.deepEqual(footerLines(task), ["structured: parsed", "grok-session: session-1", "job: job-1", "sandbox: /work", "delivery: managed", "semantic: accepted", "state: done"]);
  const detail = renderJobDetail({ id: "job-2", status: "running", mode: "consult", cwd: "/work", background: true, createdAt: "now" });
  assert.deepEqual(footerLines(detail), ["job: job-2", "sandbox: /work", "delivery: manual", "semantic: unverified", "state: running"]);
  const failed = renderJobDetail({ id: "job-3", status: "error", mode: "write", cwd: "/work", delivery: "foreground", semanticStatus: "rejected", failureKind: "quota", createdAt: "now" });
  assert.deepEqual(footerLines(failed), ["job: job-3", "sandbox: /work", "delivery: foreground", "semantic: rejected", "state: error", "failure: quota"]);
});

test("cancelled success keeps observed turns, cost, usage, and model usage", (t) => {
  const sandbox = makeSandbox(t);
  withIdentityPath(sandbox, () => {
    const file = jobFilePath(sandbox.dataDir, sandbox.workDir, "race");
    const record = createJobRecord({ id: "race", cwd: sandbox.workDir, mode: "write" });
    record.cancelRequestedAt = new Date().toISOString();
    createJobRecordFile(file, record);
    const usage = { inputTokens: 7, outputTokens: 3 };
    const modelUsage = { "grok-test": { inputTokens: 7, outputTokens: 3 } };
    const final = finishSuccessfulJobRecordFile(file, { status: "done", numTurns: 4, totalCostUsd: 0.125, totalCostUsdTicks: 1250000000, costIsPartial: false, usage, modelUsage });
    assert.equal(final.status, "cancelled");
    assert.equal(final.failureKind, "cancelled");
    assert.equal(final.numTurns, 4);
    assert.equal(final.totalCostUsd, 0.125);
    assert.equal(final.totalCostUsdTicks, 1250000000);
    assert.equal(final.costIsPartial, false);
    assert.deepEqual(final.usage, usage);
    assert.deepEqual(final.modelUsage, modelUsage);
  });
});

test("stats classifies generic errors from only the last 64 KiB of the log", (t) => {
  const sandbox = makeSandbox(t);
  withIdentityPath(sandbox, () => {
    const file = jobFilePath(sandbox.dataDir, sandbox.workDir, "legacy");
    createJobRecordFile(file, { ...createJobRecord({ id: "legacy", cwd: sandbox.workDir, mode: "consult" }), status: "error", failureKind: "error", errorMessage: "generic failure", errorTail: "generic failure" });
    const log = jobLogPath(sandbox.dataDir, sandbox.workDir, "legacy");
    const quota = "API error (status 402 Payment Required): usage balance exhausted\n";
    fs.writeFileSync(log, quota + "x".repeat(70 * 1024));
    const env = envFor(sandbox);
    const first = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout).byFailureKind, { error: 1 });
    fs.writeFileSync(log, "x".repeat(70 * 1024) + quota);
    const second = runCompanion(["stats", "--json"], { cwd: sandbox.workDir, env });
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout).byFailureKind, { quota: 1 });
  });
});

function localGrok(sandbox) {
  const file = path.join(sandbox.root, "local-grok.mjs");
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
if (process.argv.includes("--version")) { process.stdout.write("grok 1.0.41 (0123456789ab)\\n"); process.exit(0); }
const profile = process.argv[process.argv.indexOf("--sandbox") + 1];
const home = process.env.GROK_HOME;
fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
fs.appendFileSync(path.join(home, "sessions", "sandbox-events.jsonl"), JSON.stringify({ event_type: "ProfileApplied", profile, workspace: fs.realpathSync(process.cwd()), enforced: true, restrict_network: true, read_write_paths: [fs.realpathSync(process.cwd()), path.join(home, "sessions"), process.env.TMPDIR] }) + "\\n");
process.stderr.write("DEBUG xai_grok_agent::builder: tools allowlist applied\\n");
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
fs.writeFileSync(process.env.LOCAL_PROMPT_FILE, prompt);
process.stdout.write(JSON.stringify({ text: "ALLOW\\nReviewed.", stopReason: "end_turn", sessionId: "55555555-5555-7555-8555-555555555555", requestId: "req-local" }) + "\\n");
`);
  fs.chmodSync(file, 0o755);
  return file;
}

test("stop gate includes bounded untracked text and notes omitted content", (t) => {
  const sandbox = makeSandbox(t);
  initCleanRepo(sandbox.workDir);
  fs.writeFileSync(path.join(sandbox.dataDir, "config.json"), JSON.stringify({ stopGate: true }));
  fs.writeFileSync(path.join(sandbox.workDir, "defect.txt"), "UNTRACKED_DEFECT_VISIBLE\n");
  fs.writeFileSync(path.join(sandbox.workDir, "lines.txt"), Array.from({ length: 220 }, (_, i) => `LINE_${String(i).padStart(3, "0")}`).join("\n"));
  fs.writeFileSync(path.join(sandbox.workDir, "bytes.txt"), "B".repeat(20 * 1024));
  fs.writeFileSync(path.join(sandbox.workDir, "binary.dat"), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(sandbox.workDir, "late-binary.dat"), Buffer.concat([Buffer.alloc(18 * 1024, 65), Buffer.from([0])]));
  fs.writeFileSync(path.join(sandbox.workDir, "huge.txt"), "H".repeat(1024 * 1024 + 1));
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(sandbox.workDir, `total-${i}.txt`), String(i).repeat(16 * 1024));
  const promptFile = path.join(sandbox.root, "prompt.txt");
  const env = envFor(sandbox, { GROK_BIN: localGrok(sandbox), LOCAL_PROMPT_FILE: promptFile, PATH: `${identityBin(sandbox)}${path.delimiter}${process.env.PATH}` }, { git: true });
  const result = runCompanion(["stop-gate"], { cwd: sandbox.workDir, env, input: JSON.stringify({ session_id: "stop-test", cwd: sandbox.workDir, stop_hook_active: false }) });
  assert.equal(result.status, 0, result.stderr);
  const prompt = fs.readFileSync(promptFile, "utf8");
  assert.match(prompt, /UNTRACKED_DEFECT_VISIBLE/);
  assert.match(prompt, /LINE_199/);
  assert.doesNotMatch(prompt, /LINE_200/);
  for (const name of ["defect.txt", "lines.txt", "bytes.txt", "binary.dat", "late-binary.dat", "huge.txt", "total-4.txt"]) assert.ok(prompt.includes(name), name);
  assert.equal((prompt.match(/omitted: binary file/g) ?? []).length, 2);
  assert.match(prompt, /omitted: file exceeds 1 MiB/);
  assert.match(prompt, /omitted: content truncated/);
  assert.match(prompt, /omitted: 64 KiB total content limit reached/);
  assert.ok((prompt.match(/B/g) ?? []).length < 17 * 1024);
  assert.ok(!prompt.includes("H".repeat(100)));
});
