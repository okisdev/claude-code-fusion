import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { awaitOutput } from "../shared/companion/await-output.mjs";

const repoRoot = path.join(import.meta.dirname, "..");

function fixture(t, bytes = Buffer.alloc(0)) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "await-output-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "job.output");
  fs.writeFileSync(file, bytes);
  return file;
}

async function run(argv, { onSleep, initialTime = 0 } = {}) {
  let time = initialTime;
  const sleeps = [];
  const output = [];
  const errors = [];
  const code = await awaitOutput(argv, {
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
      await onSleep?.(time);
    },
    stdout: { write: (value) => output.push(Buffer.from(value)) },
    stderr: { write: (value) => errors.push(String(value)) }
  });
  return { code, output: Buffer.concat(output), error: errors.join(""), sleeps };
}

test("exit line completes immediately and removes only that line", async (t) => {
  const file = fixture(t, "first\nsecond\n[exited with code -2]\n");
  const result = await run(["--file", file]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.output, Buffer.from("first\nsecond\n"));
  assert.equal(result.error, "");
  assert.deepEqual(result.sleeps, []);
  assert.equal(fs.readFileSync(file, "utf8"), "first\nsecond\n[exited with code -2]\n");
});

test("footer completes after ten seconds without a change", async (t) => {
  for (const state of ["done", "error", "cancelled"]) {
    const file = fixture(t, `body\nstate: ${state}\n`);
    const result = await run(["--file", file, "--slice-ms", "10000"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.output, Buffer.from(`body\nstate: ${state}\n`));
    assert.deepEqual(result.sleeps, Array(20).fill(500));
  }
});

test("an already quiet footer completes immediately", async (t) => {
  const file = fixture(t, "body\nstate: done\n");
  const time = Date.now();
  fs.utimesSync(file, new Date(time - 11000), new Date(time - 11000));
  const result = await run(["--file", file], { initialTime: time });
  assert.deepEqual(result.output, Buffer.from("body\nstate: done\n"));
  assert.deepEqual(result.sleeps, []);
});

test("a file change restarts the footer quiet period", async (t) => {
  const file = fixture(t, "body\nstate: done\n");
  const result = await run(["--file", file, "--slice-ms", "12000"], {
    onSleep: (time) => {
      if (time === 1000) fs.writeFileSync(file, "revised\nstate: done\n");
    }
  });
  assert.equal(result.code, 0);
  assert.deepEqual(result.output, Buffer.from("revised\nstate: done\n"));
  assert.equal(result.sleeps.length, 22);
});

test("slice expiry prints only pending", async (t) => {
  const file = fixture(t, "body\nstate: done\n");
  const result = await run(["--file", file, "--slice-ms", "1200"]);
  assert.equal(result.code, 0);
  assert.equal(result.output.toString(), "await-output: pending\n");
  assert.equal(result.error, "");
  assert.deepEqual(result.sleeps, [500, 500, 200]);
  const pendingFile = fixture(t, "body\n");
  const defaultSlice = await run(["--file", pendingFile]);
  assert.equal(defaultSlice.output.toString(), "await-output: pending\n");
  assert.equal(defaultSlice.sleeps.length, 200);
  assert.equal(defaultSlice.sleeps.reduce((total, duration) => total + duration, 0), 100000);
});

test("completed output preserves non text bytes and line endings", async (t) => {
  const content = Buffer.from([0, 255, 13, 10, 65, 13, 10]);
  const marker = Buffer.from("[exited with code 0]\r\n");
  const file = fixture(t, Buffer.concat([content, marker]));
  const result = await run(["--file", file]);
  assert.deepEqual(result.output, content);
  assert.deepEqual(fs.readFileSync(file), Buffer.concat([content, marker]));
});

test("invalid files and options produce one error line and exit 2", async (t) => {
  const file = fixture(t, "body");
  const directory = path.join(path.dirname(file), "directory.output");
  fs.mkdirSync(directory);
  const cases = [
    [[], "--file is required"],
    [["--file", "relative.output"], "--file must be an absolute path"],
    [["--file", path.join(path.dirname(file), "job.txt")], "--file must end in .output"],
    [["--file", path.join(path.dirname(file), "missing.output")], "--file does not exist"],
    [["--file", directory], "--file must name a regular file"],
    [["--file", file, "--slice-ms", "0"], "--slice-ms must be a positive integer up to 110000"],
    [["--file", file, "--slice-ms", "110001"], "--slice-ms must be a positive integer up to 110000"],
    [["--file", file, "--slice-ms", "1.5"], "--slice-ms must be a positive integer up to 110000"],
    [["--file", file, "--slice-ms"], "invalid argument --slice-ms"],
    [["--file", file, "--unknown", "x"], "invalid argument --unknown"],
    [["--file", file, "--bad\noption", "x"], "invalid argument --bad option"],
    [["--file", file, "--file", file], "invalid argument --file"]
  ];
  for (const [argv, reason] of cases) {
    const result = await run(argv);
    assert.equal(result.code, 2, JSON.stringify(argv));
    assert.deepEqual(result.output, Buffer.alloc(0), JSON.stringify(argv));
    assert.equal(result.error, `await-output: ${reason}\n`, JSON.stringify(argv));
  }
});

test("each companion entry script routes await-output to the shared handler", (t) => {
  const content = Buffer.from("companion result\n");
  const file = fixture(t, Buffer.concat([content, Buffer.from("[exited with code 0]\n")]));
  for (const engine of ["codex", "grok", "cursor", "devin"]) {
    const script = path.join(repoRoot, "plugins", engine, "scripts", `${engine}-companion.mjs`);
    const result = spawnSync(process.execPath, [script, "await-output", "--file", file], { cwd: repoRoot });
    assert.equal(result.status, 0, `${engine}: ${result.stderr}`);
    assert.deepEqual(result.stdout, content, engine);
    assert.deepEqual(result.stderr, Buffer.alloc(0), engine);
  }
});

test("Fusion job collector routes await-output to the shared handler", (t) => {
  const script = path.join(repoRoot, "plugins", "fusion", "scripts", "job-collect.mjs");
  const content = Buffer.from([0, 255, 13, 10, 65, 13, 10]);
  const file = fixture(t, Buffer.concat([content, Buffer.from("[exited with code 0]\r\n")]));
  const completed = spawnSync(process.execPath, [script, "await-output", "--file", file], { cwd: repoRoot });
  assert.equal(completed.status, 0, completed.stderr.toString());
  assert.deepEqual(completed.stdout, content);
  assert.deepEqual(completed.stderr, Buffer.alloc(0));

  fs.writeFileSync(file, "still running\n");
  const pending = spawnSync(process.execPath, [script, "await-output", "--file", file, "--slice-ms", "1"], { cwd: repoRoot });
  assert.equal(pending.status, 0, pending.stderr.toString());
  assert.equal(pending.stdout.toString(), "await-output: pending\n");
  assert.deepEqual(pending.stderr, Buffer.alloc(0));

  const invalid = spawnSync(process.execPath, [script, "await-output", "--file", "relative.output"], { cwd: repoRoot });
  assert.equal(invalid.status, 2);
  assert.deepEqual(invalid.stdout, Buffer.alloc(0));
  assert.equal(invalid.stderr.toString(), "await-output: --file must be an absolute path\n");
});
