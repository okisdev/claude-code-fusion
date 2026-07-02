import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const companion = path.join(repoRoot, "plugins", "grok", "scripts", "grok-companion.mjs");
const fakeGrok = path.join(import.meta.dirname, "fake-grok");

const consultAllows = [
  "Read",
  "Grep",
  "Bash(git diff*)",
  "Bash(git log*)",
  "Bash(git show*)",
  "Bash(git status*)",
  "Bash(git blame*)",
];

const consultDenies = [
  "Edit",
  "Write",
  "Bash(grok*)",
  "Bash(claude*)",
  "Bash(codex*)",
  "Bash(node*)",
];

const writeDenies = [
  "Bash(sudo*)",
  "Bash(rm -rf*)",
  "Bash(git push*)",
  "Bash(grok*)",
  "Bash(claude*)",
  "Bash(codex*)",
];

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-plugin-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const workDir = path.join(root, "work");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workDir);
  return { root, dataDir, workDir, argsFile: path.join(root, "args.jsonl") };
}

function envFor(sandbox, extra = {}) {
  const env = { ...process.env };
  delete env.FAKE_GROK_MODE;
  delete env.FAKE_GROK_ARGS_FILE;
  delete env.GROK_COMPANION_TIMEOUT_MS;
  delete env.CLAUDE_CODE_SESSION_ID;
  return {
    ...env,
    GROK_BIN: fakeGrok,
    GROK_COMPANION_DATA: sandbox.dataDir,
    FAKE_GROK_ARGS_FILE: sandbox.argsFile,
    ...extra,
  };
}

function runCompanion(args, options) {
  return spawnSync(process.execPath, [companion, ...args], {
    cwd: options.cwd,
    env: options.env,
    input: options.input ?? "",
    encoding: "utf8",
    timeout: 60000,
  });
}

function readInvocations(argsFile) {
  if (!fs.existsSync(argsFile)) return [];
  return fs
    .readFileSync(argsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((argv) =>
      argv.flatMap((token) => {
        if (token.startsWith("--") && token.includes("=")) {
          const separator = token.indexOf("=");
          return [token.slice(0, separator), token.slice(separator + 1)];
        }
        return [token];
      }),
    );
}

function flagValues(argv, flag) {
  const values = [];
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === flag) values.push(argv[i + 1]);
  }
  return values;
}

function hasPair(argv, flag, value) {
  return argv.some((token, i) => token === flag && argv[i + 1] === value);
}

function singleInvocation(sandbox) {
  const invocations = readInvocations(sandbox.argsFile);
  assert.strictEqual(invocations.length, 1);
  return invocations[0];
}

test("consult task argv carries the pinned base flags and allow and deny set", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "hello there"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  const briefFile = flagValues(argv, "--prompt-file")[0];
  assert.ok(briefFile, "Expected a --prompt-file argument.");
  assert.ok(briefFile.startsWith(sandbox.dataDir), "Expected the brief to live under the data dir.");
  assert.ok(fs.readFileSync(briefFile, "utf8").includes("hello there"));
  assert.ok(hasPair(argv, "--output-format", "json"));
  assert.ok(hasPair(argv, "--sandbox", "workspace"));
  assert.ok(argv.includes("--no-subagents"));
  assert.ok(argv.includes("--disable-web-search"));
  assert.ok(hasPair(argv, "--max-turns", "25"));
  assert.ok(hasPair(argv, "--permission-mode", "dontAsk"));
  assert.deepStrictEqual([...flagValues(argv, "--allow")].sort(), [...consultAllows].sort());
  assert.deepStrictEqual([...flagValues(argv, "--deny")].sort(), [...consultDenies].sort());
  assert.ok(!argv.includes("-m"), "Model must not be passed by default.");
  assert.ok(!argv.includes("--effort"), "Effort must not be passed by default.");
  assert.ok(!argv.includes("--always-approve"));
  assert.ok(!argv.includes("--best-of-n"));
  assert.ok(!argv.includes("-r"));
});

test("model and effort are forwarded only when explicitly provided", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "hello", "--model", "grok-4-fast", "--effort", "high"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(hasPair(argv, "-m", "grok-4-fast"));
  assert.ok(hasPair(argv, "--effort", "high"));
});

test("write task argv includes always-approve and the six deny rules", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "change the code", "--write"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(argv.includes("--always-approve"));
  assert.deepStrictEqual([...flagValues(argv, "--deny")].sort(), [...writeDenies].sort());
  assert.ok(hasPair(argv, "--max-turns", "60"));
  assert.ok(argv.includes("--no-subagents"));
  assert.ok(!argv.includes("-m"));
  assert.ok(!argv.includes("--effort"));
});

test("best-of-n argv drops no-subagents, implies write mode, and keeps the denies", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "compete on this", "--best-of-n", "2"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(hasPair(argv, "--best-of-n", "2"));
  assert.ok(!argv.includes("--no-subagents"));
  assert.ok(argv.includes("--always-approve"));
  assert.deepStrictEqual([...flagValues(argv, "--deny")].sort(), [...writeDenies].sort());
});

test("resume maps to -r with the given session uuid", (t) => {
  const sandbox = makeSandbox(t);
  const uuid = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
  const result = runCompanion(["task", "continue with the plan", "--resume", uuid], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(hasPair(argv, "-r", uuid));
  const briefFile = flagValues(argv, "--prompt-file")[0];
  assert.ok(fs.readFileSync(briefFile, "utf8").includes("continue with the plan"));
});

test("resume without a prompt sends the pinned continuation text", (t) => {
  const sandbox = makeSandbox(t);
  const uuid = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
  const result = runCompanion(["task", "--resume", uuid], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(hasPair(argv, "-r", uuid));
  const briefFile = flagValues(argv, "--prompt-file")[0];
  assert.ok(
    fs
      .readFileSync(briefFile, "utf8")
      .includes(
        "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.",
      ),
  );
});

test("max-turns is overridable from the command line", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "hello", "--max-turns", "7"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.deepStrictEqual(flagValues(argv, "--max-turns"), ["7"]);
});

test("best-of-n outside 2 to 10 is rejected", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "hello", "--best-of-n", "11"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /between 2 and 10/);
  assert.strictEqual(readInvocations(sandbox.argsFile).length, 0);
});

test("web flag drops the web search disable and stays consult", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "research this", "--web"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(!argv.includes("--disable-web-search"));
  assert.ok(hasPair(argv, "--permission-mode", "dontAsk"));
  assert.ok(!argv.includes("--always-approve"));
});
