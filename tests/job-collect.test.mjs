import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const collector = path.join(repoRoot, "plugins", "fusion", "scripts", "job-collect.mjs");

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "job-collect-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root };
}

function writeScript(sandbox, name, source) {
  const file = path.join(sandbox.root, name);
  fs.writeFileSync(file, source, "utf8");
  return file;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function nodeCommand(file, ...args) {
  return [process.execPath, file, ...args].map(shellQuote).join(" ");
}

function runCollector(statusCommand, resultCommand, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [collector, "--status-cmd", statusCommand, "--result-cmd", resultCommand, ...extraArgs],
    { encoding: "utf8", timeout: 10_000 }
  );
}

test("collects a terminal state from a state line", (t) => {
  const sandbox = makeSandbox(t);
  const countFile = path.join(sandbox.root, "status-count");
  const resultCountFile = path.join(sandbox.root, "result-count");
  const status = writeScript(
    sandbox,
    "status.mjs",
    'import fs from "node:fs";\nconst file = process.argv[2];\nconst count = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) + 1 : 1;\nfs.writeFileSync(file, String(count));\nprocess.stdout.write(count === 1 ? "state: running\\n" : "state: done\\n");\n'
  );
  const result = writeScript(
    sandbox,
    "result.mjs",
    'import fs from "node:fs";\nfs.writeFileSync(process.argv[2], "1");\nprocess.stdout.write("first line\\nsecond line\\n");\n'
  );
  const output = runCollector(nodeCommand(status, countFile), nodeCommand(result, resultCountFile), [
    "--interval-ms",
    "1",
    "--cap-ms",
    "1000"
  ]);
  assert.strictEqual(output.status, 0, output.stderr);
  assert.match(output.stdout, /^first line\nsecond line\ncollector: state=done elapsed=\d+s\n$/);
  assert.strictEqual(fs.readFileSync(countFile, "utf8"), "2");
  assert.strictEqual(fs.readFileSync(resultCountFile, "utf8"), "1");
});

test("collects terminal output through fallback word detection", (t) => {
  const sandbox = makeSandbox(t);
  const status = writeScript(sandbox, "status.mjs", 'process.stdout.write("Job completed successfully.\\n");\n');
  const result = writeScript(sandbox, "result.mjs", 'process.stdout.write("fallback result\\n");\n');
  const output = runCollector(nodeCommand(status), nodeCommand(result));
  assert.strictEqual(output.status, 0, output.stderr);
  assert.match(output.stdout, /^fallback result\ncollector: state=completed elapsed=\d+s\n$/);
});

test("prints the last status output and exits on timeout", (t) => {
  const sandbox = makeSandbox(t);
  const status = writeScript(sandbox, "status.mjs", 'process.stdout.write("Status: running\\npid: 123 alive\\n");\n');
  const result = writeScript(sandbox, "result.mjs", 'process.stdout.write("must not run\\n");\n');
  const output = runCollector(nodeCommand(status), nodeCommand(result), ["--interval-ms", "2", "--cap-ms", "10"]);
  assert.strictEqual(output.status, 2, output.stderr);
  assert.match(output.stdout, /^Status: running\npid: 123 alive\ncollector: timeout elapsed=\d+s\n$/);
});

test("stops when a running process is flagged as dead", (t) => {
  const sandbox = makeSandbox(t);
  const status = writeScript(
    sandbox,
    "status.mjs",
    'process.stdout.write("Status: running\\npid: 999999 is dead\\nLog: /tmp/job.log\\n");\n'
  );
  const result = writeScript(sandbox, "result.mjs", 'process.stdout.write("must not run\\n");\n');
  const output = runCollector(nodeCommand(status), nodeCommand(result));
  assert.strictEqual(output.status, 3, output.stderr);
  assert.match(output.stdout, /^Status: running\npid: 999999 is dead\nLog: \/tmp\/job\.log\ncollector: dead elapsed=\d+s\n$/);
});

test("treats died failure output as dead instead of collecting a terminal result", (t) => {
  const sandbox = makeSandbox(t);
  const status = writeScript(sandbox, "status.mjs", 'process.stdout.write("state: error\\nfailure: died\\n");\n');
  const result = writeScript(sandbox, "result.mjs", 'process.stdout.write("must not run\\n");\n');
  const output = runCollector(nodeCommand(status), nodeCommand(result));
  assert.strictEqual(output.status, 3, output.stderr);
  assert.match(output.stdout, /^state: error\nfailure: died\ncollector: dead elapsed=\d+s\n$/);
});

test("reruns status once after dead detection when requested", (t) => {
  const sandbox = makeSandbox(t);
  const countFile = path.join(sandbox.root, "status-count");
  const status = writeScript(
    sandbox,
    "status.mjs",
    'import fs from "node:fs";\nconst file = process.argv[2];\nconst count = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) + 1 : 1;\nfs.writeFileSync(file, String(count));\nprocess.stdout.write(count === 1 ? "state: error\\nfailure: died\\n" : "state: error\\nfailure: died\\nLog: /tmp/refreshed.log\\n");\n'
  );
  const result = writeScript(sandbox, "result.mjs", 'process.stdout.write("must not run\\n");\n');
  const output = runCollector(nodeCommand(status, countFile), nodeCommand(result), ["--dead-rerun-status"]);
  assert.strictEqual(output.status, 3, output.stderr);
  assert.match(output.stdout, /^state: error\nfailure: died\nLog: \/tmp\/refreshed\.log\ncollector: dead elapsed=\d+s\n$/);
  assert.strictEqual(fs.readFileSync(countFile, "utf8"), "2");
});

test("aborts after two consecutive status command errors", (t) => {
  const sandbox = makeSandbox(t);
  const countFile = path.join(sandbox.root, "status-count");
  const status = writeScript(
    sandbox,
    "status.mjs",
    'import fs from "node:fs";\nconst file = process.argv[2];\nconst count = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) + 1 : 1;\nfs.writeFileSync(file, String(count));\nprocess.stderr.write(`status failure ${count}\\n`);\nprocess.exit(7);\n'
  );
  const result = writeScript(sandbox, "result.mjs", 'process.stdout.write("must not run\\n");\n');
  const output = runCollector(nodeCommand(status, countFile), nodeCommand(result), [
    "--interval-ms",
    "1",
    "--cap-ms",
    "1000"
  ]);
  assert.strictEqual(output.status, 4, output.stderr);
  assert.match(output.stdout, /^status failure 2\ncollector: status-error elapsed=\d+s\n$/);
  assert.strictEqual(fs.readFileSync(countFile, "utf8"), "2");
});

test("preserves result stdout without a trailing newline before the collector line", (t) => {
  const sandbox = makeSandbox(t);
  const status = writeScript(sandbox, "status.mjs", 'process.stdout.write("state: cancelled\\n");\n');
  const result = writeScript(sandbox, "result.mjs", 'process.stdout.write("verbatim result");\n');
  const output = runCollector(nodeCommand(status), nodeCommand(result));
  assert.strictEqual(output.status, 0, output.stderr);
  assert.match(output.stdout, /^verbatim result\ncollector: state=cancelled elapsed=\d+s\n$/);
});
