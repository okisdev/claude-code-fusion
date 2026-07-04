import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const companion = path.join(repoRoot, "plugins", "grok", "scripts", "grok-companion.mjs");
const fakeGrok = path.join(import.meta.dirname, "fake-grok");

const gitIsolation = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

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
    ...gitIsolation,
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
    .map((line) => JSON.parse(line));
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

function git(dir, args) {
  const result = spawnSync("git", args, {
    cwd: dir,
    env: { ...process.env, ...gitIsolation },
    encoding: "utf8",
  });
  assert.strictEqual(result.status, 0, result.stderr);
}

function initFixtureRepo(dir) {
  git(dir, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "app.mjs"), "export const value = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init fixture"]);
  fs.appendFileSync(path.join(dir, "app.mjs"), "export const other = 2;\n");
  fs.writeFileSync(path.join(dir, "untracked.txt"), "new file\n");
}

test("review builds a prompt from the working tree and renders the extracted JSON", (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const result = runCompanion(["review", "--focus", "check the error handling"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "review-ok" }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const invocations = readInvocations(sandbox.argsFile);
  assert.strictEqual(invocations.length, 1);
  const briefFile = flagValues(invocations[0], "--prompt-file")[0];
  assert.ok(briefFile, "Expected a --prompt-file argument.");
  const brief = fs.readFileSync(briefFile, "utf8");
  assert.ok(brief.includes("export const other = 2;"));
  assert.ok(brief.includes("untracked.txt"));
  assert.ok(brief.includes("check the error handling"));
  assert.ok(result.stdout.includes("needs-attention"));
  assert.ok(result.stdout.includes("Example finding"));
  assert.ok(result.stdout.includes("src/app.mjs"));
  assert.ok(result.stdout.includes("Run the tests."));
});

test("review retries once by resuming the session when the output is not valid JSON", (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const result = runCompanion(["review"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "badjson-then-ok" }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const invocations = readInvocations(sandbox.argsFile);
  assert.strictEqual(invocations.length, 2);
  assert.ok(!invocations[0].includes("-r"));
  assert.ok(hasPair(invocations[1], "-r", "22222222-2222-7222-8222-222222222222"));
  assert.ok(result.stdout.includes("needs-attention"));
  assert.ok(result.stdout.includes("Example finding"));
});

test("review gives up after one failed retry and renders the raw text with a parse warning", (t) => {
  const sandbox = makeSandbox(t);
  initFixtureRepo(sandbox.workDir);
  const result = runCompanion(["review"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "badjson" }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const invocations = readInvocations(sandbox.argsFile);
  assert.strictEqual(invocations.length, 2);
  assert.ok(hasPair(invocations[1], "-r", "44444444-4444-7444-8444-444444444444"));
  assert.ok(result.stdout.includes("did not return a valid review JSON object"));
  assert.ok(result.stdout.includes("I still cannot produce the requested object."));
  const jsonRun = runCompanion(["review", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "badjson" }),
  });
  assert.strictEqual(jsonRun.status, 0, jsonRun.stderr);
  const payload = JSON.parse(jsonRun.stdout);
  assert.strictEqual(payload.valid, false);
  assert.ok(payload.parseError, "Expected a parse error in the JSON payload.");
  assert.strictEqual(payload.review, null);
  assert.ok(payload.rawText.includes("I still cannot produce the requested object."));
});

test("review output contract is enforced by validateReviewOutput instead of a schema file", () => {
  assert.ok(!fs.existsSync(path.join(repoRoot, "plugins", "grok", "schemas", "review-output.schema.json")));
});
