import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "plugins", "fusion", "scripts", "breaker-check.mjs");

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "breaker-check-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    grokData: path.join(root, "grok-data"),
    codexState: path.join(root, "codex-state")
  };
}

function jobFile(root, workspace, id) {
  return path.join(root, workspace, "jobs", `${id}.json`);
}

function writeRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function envFor(sandbox, extra = {}) {
  return {
    ...process.env,
    GROK_COMPANION_DATA: sandbox.grokData,
    FUSION_CODEX_STATE_DIR: sandbox.codexState,
    ...extra
  };
}

function run(sandbox, extraEnv = {}) {
  return spawnSync(process.execPath, [script], {
    env: envFor(sandbox, extraEnv),
    encoding: "utf8"
  });
}

test("an in-window quota failure prints a grok breaker advisory", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(path.join(sandbox.grokData, "state"), "workspace", "quota"), {
    status: "error",
    failureKind: "quota",
    finishedAt: new Date(Date.now() - 30 * 60000).toISOString()
  });

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /treat the grok breaker as open unless verified recovered/);
  assert.match(result.stdout, /last failure quota \d+ minutes? ago/);
  assert.strictEqual(result.stderr, "");
});

test("a codex rate limit failure uses the codex override and prints one line", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(sandbox.codexState, "workspace", "rate-limit"), {
    status: "failed",
    errorMessage: "Rate limit exceeded",
    completedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /^fusion breaker advisory: treat the codex breaker as open unless verified recovered; last failure rate_limited \d+ minutes? ago\.\n$/);
});

test("a failure outside the lookback window is silent", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(path.join(sandbox.grokData, "state"), "workspace", "old"), {
    status: "error",
    failureKind: "quota",
    finishedAt: new Date(Date.now() - 13 * 60 * 60000).toISOString()
  });

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});

test("a clean store is silent", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(path.join(sandbox.grokData, "state"), "workspace", "clean"), {
    status: "done",
    failureKind: null,
    finishedAt: new Date().toISOString()
  });
  writeRecord(jobFile(sandbox.codexState, "workspace", "clean"), {
    status: "completed",
    errorMessage: null,
    completedAt: new Date().toISOString()
  });

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
});

test("malformed records are skipped and the check still exits 0", (t) => {
  const sandbox = makeSandbox(t);
  const file = jobFile(path.join(sandbox.grokData, "state"), "workspace", "broken");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json\n", "utf8");

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});
