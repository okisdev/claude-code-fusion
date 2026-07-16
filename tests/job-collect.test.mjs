import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { resolveCompanion, terminalMetadata } from "../plugins/fusion/scripts/job-collect.mjs";

const repoRoot = path.join(import.meta.dirname, "..");
const collector = path.join(repoRoot, "plugins", "fusion", "scripts", "job-collect.mjs");
const jobId = "a".repeat(32);
let sessionSequence = 0;

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "job-collect-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeCompanion(root, { status, result }) {
  const file = path.join(root, "fake-companion.mjs");
  fs.writeFileSync(
    file,
    `import fs from "node:fs";\nconst [command, jobId, ...options] = process.argv.slice(2);\nif (!/^[a-f0-9]{32}$/.test(jobId)) { process.stderr.write("invalid job id\\n"); process.exit(91); }\nif (command === "status") {\n${status}\n} else if (command === "result") {\n${result}\n} else {\n  process.stderr.write("unexpected command\\n");\n  process.exit(92);\n}\n`,
    "utf8"
  );
  return file;
}

function collectorEnvironment(companion, extra = {}) {
  sessionSequence += 1;
  return {
    ...process.env,
    CLAUDE_CODE_SESSION_ID: `job-collector-test-${process.pid}-${sessionSequence}`,
    FUSION_CODEX_COMPANION: companion,
    FUSION_GROK_COMPANION: companion,
    ...extra
  };
}

function stageRequest(t, env, request) {
  const created = spawnSync(process.execPath, [collector, "transport-create"], { encoding: "utf8", env, timeout: 5_000 });
  assert.strictEqual(created.status, 0, created.stderr);
  const transport = JSON.parse(created.stdout);
  t.after(() => fs.rmSync(path.dirname(transport.file), { recursive: true, force: true }));
  fs.writeFileSync(transport.file, typeof request === "string" ? request : JSON.stringify(request), "utf8");
  return transport;
}

function runCollector(t, companion, request = {}, { extraEnv = {}, timeout = 10_000 } = {}) {
  const env = collectorEnvironment(companion, extraEnv);
  const transport = stageRequest(t, env, {
    engine: "codex",
    jobId,
    json: false,
    intervalMs: 1,
    capMs: 5_000,
    deadRerunStatus: false,
    ...request
  });
  return spawnSync(process.execPath, [collector, "--raw-args-token", transport.token], { encoding: "utf8", env, timeout });
}

test("collects through fixed companion status and result argv", (t) => {
  const root = makeSandbox(t);
  const countFile = path.join(root, "status-count");
  const resultArgsFile = path.join(root, "result-args.json");
  const companion = writeCompanion(root, {
    status: '  const file = process.env.STATUS_COUNT_FILE;\n  const count = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) + 1 : 1;\n  fs.writeFileSync(file, String(count));\n  process.stdout.write(count === 1 ? "state: running\\n" : "state: done\\n");',
    result: '  fs.writeFileSync(process.env.RESULT_ARGS_FILE, JSON.stringify(process.argv.slice(2)));\n  process.stdout.write("first line\\nsecond line\\n");'
  });
  const output = runCollector(t, companion, {}, { extraEnv: { STATUS_COUNT_FILE: countFile, RESULT_ARGS_FILE: resultArgsFile } });
  assert.strictEqual(output.status, 0, output.stderr);
  assert.match(output.stdout, /^first line\nsecond line\ncollector: state=done semantic=unverified engine=codex job=[a-f0-9]{32} elapsed=\d+s\n$/);
  assert.strictEqual(fs.readFileSync(countFile, "utf8"), "2");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(resultArgsFile, "utf8")), ["result", jobId, "--wait"]);
});

test("supports Grok and JSON companion output", (t) => {
  const root = makeSandbox(t);
  const companion = writeCompanion(root, {
    status: '  if (!options.includes("--json")) process.exit(93);\n  process.stdout.write(JSON.stringify({ status: "done", failureKind: null }));',
    result: '  if (!options.includes("--json")) process.exit(93);\n  process.stdout.write(JSON.stringify({ status: "done", result: "grok result" }));'
  });
  const output = runCollector(t, companion, { engine: "grok", json: true });
  assert.strictEqual(output.status, 0, output.stderr);
  assert.match(output.stdout, /^\{"status":"done","result":"grok result"\}\ncollector: state=done semantic=unverified engine=grok job=[a-f0-9]{32} elapsed=\d+s\n$/);
});

test("accepts engine metadata in the terminal footer", (t) => {
  const root = makeSandbox(t);
  const companion = writeCompanion(root, {
    status: '  process.stdout.write("grok-session: session-1\\njob: task-1\\nstate: done\\n");',
    result: '  process.stdout.write("grok result\\n");'
  });
  const output = runCollector(t, companion, { engine: "grok" });
  assert.strictEqual(output.status, 0, output.stderr);
  assert.match(output.stdout, /^grok result\ncollector: state=done semantic=unverified engine=grok job=[a-f0-9]{32} elapsed=\d+s\n$/);
});

test("terminal metadata carries only structured semantic state from the final footer", () => {
  assert.deepStrictEqual(
    terminalMetadata("semantic: accepted\nstate: done\nresult body\n\njob: abc\nsemantic: rejected\nstate: done\n"),
    { state: "done", semantic: "rejected" }
  );
  assert.deepStrictEqual(terminalMetadata(JSON.stringify({ status: "done", semanticStatus: "accepted" }), true), { state: "done", semantic: "accepted" });
  assert.deepStrictEqual(terminalMetadata(JSON.stringify({ status: "done", semanticStatus: "invented" }), true), { state: "done", semantic: "unverified" });
});

test("does not infer terminal state from prose", (t) => {
  const root = makeSandbox(t);
  const companion = writeCompanion(root, {
    status: '  process.stdout.write("Job completed successfully.\\n");',
    result: '  process.stdout.write("must not run\\n");'
  });
  const output = runCollector(t, companion, { capMs: 100 });
  assert.strictEqual(output.status, 2, output.stderr);
  assert.match(output.stdout, /^Job completed successfully\.\ncollector: timeout engine=codex job=[a-f0-9]{32} elapsed=\d+s\n$/);
});

test("prints the last status output on timeout", (t) => {
  const root = makeSandbox(t);
  const companion = writeCompanion(root, {
    status: '  process.stdout.write("Status: running\\npid: 123 alive\\n");',
    result: '  process.stdout.write("must not run\\n");'
  });
  const output = runCollector(t, companion, { intervalMs: 2, capMs: 100 });
  assert.strictEqual(output.status, 2, output.stderr);
  assert.match(output.stdout, /^Status: running\npid: 123 alive\ncollector: timeout engine=codex job=[a-f0-9]{32} elapsed=\d+s\n$/);
});

test("rejects a collection cap above the foreground tool window", (t) => {
  const root = makeSandbox(t);
  const companion = writeCompanion(root, { status: "", result: "" });
  const output = runCollector(t, companion, { capMs: 540_001 });
  assert.strictEqual(output.status, 1);
  assert.match(output.stderr, /capMs cannot exceed 540000/);
});

test("the wall clock cap terminates a stuck status process", (t) => {
  const root = makeSandbox(t);
  const companion = writeCompanion(root, {
    status: '  setTimeout(() => process.stdout.write("state: running\\n"), 5_000);',
    result: '  process.stdout.write("must not run\\n");'
  });
  const startedAt = Date.now();
  const output = runCollector(t, companion, { capMs: 100 });
  assert.strictEqual(output.status, 2, output.stderr);
  assert.ok(Date.now() - startedAt < 2_000);
  assert.match(output.stdout, /collector: timeout engine=codex job=[a-f0-9]{32} elapsed=0s/);
});

test("the wall clock cap terminates a stuck result process", (t) => {
  const root = makeSandbox(t);
  const companion = writeCompanion(root, {
    status: '  process.stdout.write("job: test\\nstate: done\\n");',
    result: '  setTimeout(() => process.stdout.write("too late\\n"), 5_000);'
  });
  const startedAt = Date.now();
  const output = runCollector(t, companion, { capMs: 150 });
  assert.strictEqual(output.status, 2, output.stderr);
  assert.ok(Date.now() - startedAt < 2_000);
  assert.match(output.stdout, /^job: test\nstate: done\ncollector: timeout engine=codex job=[a-f0-9]{32} elapsed=0s\n$/);
});

test("stops when a running process is flagged as dead", (t) => {
  const root = makeSandbox(t);
  const companion = writeCompanion(root, {
    status: '  process.stdout.write("Status: running\\npid: 999999 is dead\\nLog: /tmp/job.log\\n");',
    result: '  process.stdout.write("must not run\\n");'
  });
  const output = runCollector(t, companion);
  assert.strictEqual(output.status, 3, output.stderr);
  assert.match(output.stdout, /^Status: running\npid: 999999 is dead\nLog: \/tmp\/job\.log\ncollector: dead engine=codex job=[a-f0-9]{32} elapsed=\d+s\n$/);
});

test("treats JSON failureKind died as dead", (t) => {
  const root = makeSandbox(t);
  const companion = writeCompanion(root, {
    status: '  process.stdout.write(JSON.stringify({ status: "error", failureKind: "died" }));',
    result: '  process.stdout.write("must not run\\n");'
  });
  const output = runCollector(t, companion, { json: true });
  assert.strictEqual(output.status, 3, output.stderr);
  assert.match(output.stdout, /^\{"status":"error","failureKind":"died"\}\ncollector: dead engine=codex job=[a-f0-9]{32} elapsed=\d+s\n$/);
});

test("reruns status once after dead detection when requested", (t) => {
  const root = makeSandbox(t);
  const countFile = path.join(root, "status-count");
  const companion = writeCompanion(root, {
    status: '  const file = process.env.STATUS_COUNT_FILE;\n  const count = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) + 1 : 1;\n  fs.writeFileSync(file, String(count));\n  process.stdout.write(count === 1 ? "state: error\\nfailure: died\\n" : "state: error\\nfailure: died\\nLog: /tmp/refreshed.log\\n");',
    result: '  process.stdout.write("must not run\\n");'
  });
  const output = runCollector(t, companion, { deadRerunStatus: true }, { extraEnv: { STATUS_COUNT_FILE: countFile } });
  assert.strictEqual(output.status, 3, output.stderr);
  assert.match(output.stdout, /^state: error\nfailure: died\nLog: \/tmp\/refreshed\.log\ncollector: dead engine=codex job=[a-f0-9]{32} elapsed=\d+s\n$/);
  assert.strictEqual(fs.readFileSync(countFile, "utf8"), "2");
});

test("aborts after two consecutive companion status errors", (t) => {
  const root = makeSandbox(t);
  const countFile = path.join(root, "status-count");
  const companion = writeCompanion(root, {
    status: '  const file = process.env.STATUS_COUNT_FILE;\n  const count = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) + 1 : 1;\n  fs.writeFileSync(file, String(count));\n  process.stderr.write(`status failure ${count}\\n`);\n  process.exit(7);',
    result: '  process.stdout.write("must not run\\n");'
  });
  const output = runCollector(t, companion, {}, { extraEnv: { STATUS_COUNT_FILE: countFile } });
  assert.strictEqual(output.status, 4, output.stderr);
  assert.match(output.stdout, /^status failure 2\ncollector: status-error engine=codex job=[a-f0-9]{32} elapsed=\d+s\n$/);
  assert.strictEqual(fs.readFileSync(countFile, "utf8"), "2");
});

test("preserves result stdout without a trailing newline", (t) => {
  const root = makeSandbox(t);
  const companion = writeCompanion(root, {
    status: '  process.stdout.write("state: cancelled\\n");',
    result: '  process.stdout.write("verbatim result");'
  });
  const output = runCollector(t, companion);
  assert.strictEqual(output.status, 0, output.stderr);
  assert.match(output.stdout, /^verbatim result\ncollector: state=cancelled semantic=unverified engine=codex job=[a-f0-9]{32} elapsed=\d+s\n$/);
});

test("propagates a nonzero companion result exit code", (t) => {
  const root = makeSandbox(t);
  const companion = writeCompanion(root, {
    status: '  process.stdout.write("job: test\\nstate: error\\nfailure: quota\\n");',
    result: '  process.stdout.write("quota exhausted\\n");\n  process.exit(7);'
  });
  const output = runCollector(t, companion);
  assert.strictEqual(output.status, 7, output.stderr);
  assert.match(output.stdout, /^quota exhausted\ncollector: state=error semantic=unverified engine=codex job=[a-f0-9]{32} elapsed=\d+s\n$/);
});

test("ignores a state line outside the final metadata footer", (t) => {
  const root = makeSandbox(t);
  const companion = writeCompanion(root, {
    status: '  process.stdout.write("state: done\\nstill running\\n");',
    result: '  process.stdout.write("must not run\\n");'
  });
  const output = runCollector(t, companion, { capMs: 100 });
  assert.strictEqual(output.status, 2, output.stderr);
  assert.match(output.stdout, /^state: done\nstill running\ncollector: timeout engine=codex job=[a-f0-9]{32} elapsed=\d+s\n$/);
});

test("request transport is strict and consumed once", (t) => {
  const root = makeSandbox(t);
  const companion = writeCompanion(root, { status: "", result: "" });
  const env = collectorEnvironment(companion);
  const transport = stageRequest(t, env, { engine: "codex", jobId, unexpected: true });
  const first = spawnSync(process.execPath, [collector, "--raw-args-token", transport.token], { encoding: "utf8", env });
  assert.strictEqual(first.status, 1);
  assert.match(first.stderr, /Unknown collection request field unexpected/);
  const second = spawnSync(process.execPath, [collector, "--raw-args-token", transport.token], { encoding: "utf8", env });
  assert.strictEqual(second.status, 1);
  assert.match(second.stderr, /Could not read Fusion input transport/);
});

test("rejects noncanonical job ids before invoking a companion", (t) => {
  const root = makeSandbox(t);
  const companion = writeCompanion(root, { status: '  fs.writeFileSync(process.env.CALLED_FILE, "yes");', result: "" });
  const calledFile = path.join(root, "called");
  const output = runCollector(t, companion, { jobId: "ABC" }, { extraEnv: { CALLED_FILE: calledFile } });
  assert.strictEqual(output.status, 1);
  assert.match(output.stderr, /exactly 32 lowercase hexadecimal characters/);
  assert.strictEqual(fs.existsSync(calledFile), false);
});

test("transport-discard removes an unused staged request", (t) => {
  const root = makeSandbox(t);
  const companion = writeCompanion(root, { status: "", result: "" });
  const env = collectorEnvironment(companion);
  const transport = stageRequest(t, env, "");
  const discarded = spawnSync(process.execPath, [collector, "transport-discard", "--raw-args-token", transport.token], { encoding: "utf8", env });
  assert.strictEqual(discarded.status, 0, discarded.stderr);
  assert.strictEqual(fs.existsSync(path.dirname(transport.file)), false);
});

test("companion resolution prefers an override and then newest cache mtime", (t) => {
  const root = makeSandbox(t);
  const override = path.join(root, "override.mjs");
  fs.writeFileSync(override, "", "utf8");
  assert.strictEqual(resolveCompanion("codex", { env: { HOME: root, FUSION_CODEX_COMPANION: override } }), override);

  const oldCompanion = path.join(root, ".claude", "plugins", "cache", "claude-code-fusion", "grok", "1", "scripts", "grok-companion.mjs");
  const newCompanion = path.join(root, ".claude", "plugins", "cache", "claude-code-fusion", "grok", "2", "scripts", "grok-companion.mjs");
  fs.mkdirSync(path.dirname(oldCompanion), { recursive: true });
  fs.mkdirSync(path.dirname(newCompanion), { recursive: true });
  fs.writeFileSync(oldCompanion, "", "utf8");
  fs.writeFileSync(newCompanion, "", "utf8");
  fs.utimesSync(oldCompanion, new Date(1_000), new Date(1_000));
  fs.utimesSync(newCompanion, new Date(2_000), new Date(2_000));
  assert.strictEqual(resolveCompanion("grok", { env: { HOME: root }, selfPath: path.join(root, "fusion", "scripts", "job-collect.mjs") }), newCompanion);
});

test("collector has no command string compatibility path", () => {
  const source = fs.readFileSync(collector, "utf8");
  const agent = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "agents", "job-collector.md"), "utf8");
  const executableCommandFields = new RegExp(["status", "result"].map((prefix) => `${prefix}-${["c", "m", "d"].join("")}`).join("|"));
  const ambientDirectoryField = new RegExp(`\\b${["c", "w", "d"].join("")}\\b`);
  assert.doesNotMatch(source, new RegExp(`shell:\\s*${["t", "r", "u", "e"].join("")}`));
  assert.match(source, /spawn\(process\.execPath, args, \{[^}]*shell: false/);
  assert.doesNotMatch(source, executableCommandFields);
  assert.doesNotMatch(source, ambientDirectoryField);
  assert.doesNotMatch(agent, executableCommandFields);
  assert.doesNotMatch(agent, ambientDirectoryField);
});
