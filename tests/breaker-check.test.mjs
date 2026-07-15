import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { codexFailureKind, resolveCodexStateDir, resolveCodexStateRoots } from "../plugins/fusion/scripts/breaker-check.mjs";

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

function runWithHome(sandbox, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: sandbox.root,
    GROK_COMPANION_DATA: sandbox.grokData
  };
  delete env.FUSION_CODEX_STATE;
  delete env.FUSION_CODEX_STATE_DIR;
  delete env.CODEX_COMPANION_DATA;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [script], { env, encoding: "utf8" });
}

function homeCodexState(sandbox, pluginDataName) {
  return path.join(sandbox.root, ".claude", "plugins", "data", pluginDataName, "state");
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

test("a legacy grok 402 stored as a generic error still opens the quota breaker", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(path.join(sandbox.grokData, "state"), "workspace", "legacy-quota"), {
    status: "error",
    failureKind: "error",
    errorTail: "request failed with status code: 402",
    finishedAt: new Date(Date.now() - 30 * 60000).toISOString()
  });

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /treat the grok breaker as open unless verified recovered/);
  assert.match(result.stdout, /last failure quota \d+ minutes? ago/);
  assert.strictEqual(result.stderr, "");
});

test("a legacy grok 402 stored only in the job log still opens the quota breaker", (t) => {
  const sandbox = makeSandbox(t);
  const file = jobFile(path.join(sandbox.grokData, "state"), "workspace", "legacy-log-quota");
  writeRecord(file, {
    status: "error",
    failureKind: "error",
    errorTail: "generic failure",
    finishedAt: new Date(Date.now() - 30 * 60000).toISOString()
  });
  fs.writeFileSync(file.replace(/\.json$/, ".log"), "HTTP/1.1 402\n", "utf8");

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /treat the grok breaker as open unless verified recovered/);
  assert.match(result.stdout, /last failure quota \d+ minutes? ago/);
  assert.strictEqual(result.stderr, "");
});

test("a legacy failed grok job without a failure kind still recovers quota", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(path.join(sandbox.grokData, "state"), "workspace", "legacy-empty-kind"), {
    status: "error",
    errorTail: "exhausted balance",
    finishedAt: new Date(Date.now() - 30 * 60000).toISOString()
  });

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /last failure quota \d+ minutes? ago/);
  assert.strictEqual(result.stderr, "");
});

test("breaker quota recovery matches the companion diagnostic vocabulary", () => {
  for (const diagnostic of [
    "usage limit reached",
    "account balance is exhausted",
    "exhausted balance",
    "insufficient account balance",
    "insufficient account credit",
    "insufficient account credits",
    "insufficient account funds"
  ]) {
    assert.strictEqual(codexFailureKind(diagnostic), "quota", diagnostic);
  }
});

test("typed grok failures are not reclassified from quota summaries or logs", (t) => {
  const sandbox = makeSandbox(t);
  const stateRoot = path.join(sandbox.grokData, "state");
  for (const failureKind of ["timeout", "permission", "died"]) {
    const file = jobFile(stateRoot, "workspace", failureKind);
    writeRecord(file, {
      status: "error",
      failureKind,
      errorTail: "HTTP 402 Payment Required",
      finishedAt: new Date(Date.now() - 30 * 60000).toISOString()
    });
    fs.writeFileSync(file.replace(/\.json$/, ".log"), "usage limit reached because the balance is exhausted\n", "utf8");
  }

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});

test("successful grok jobs never recover breaker failures from summaries or logs", (t) => {
  const sandbox = makeSandbox(t);
  const stateRoot = path.join(sandbox.grokData, "state");
  writeRecord(jobFile(stateRoot, "workspace", "successful-summary"), {
    status: "done",
    failureKind: null,
    errorTail: "transient authentication failed before recovery",
    finishedAt: new Date(Date.now() - 20 * 60000).toISOString()
  });
  const logged = jobFile(stateRoot, "workspace", "successful-log");
  writeRecord(logged, {
    status: "done",
    failureKind: null,
    finishedAt: new Date(Date.now() - 10 * 60000).toISOString()
  });
  fs.writeFileSync(logged.replace(/\.json$/, ".log"), "HTTP 402 followed by successful reauthentication\n", "utf8");

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});

test("one Codex rate limit keeps the breaker closed for its retry", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(sandbox.codexState, "workspace", "rate-limit"), {
    status: "failed",
    errorMessage: "Rate limit exceeded",
    completedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});

test("a consecutive second Codex rate limit opens the breaker", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(sandbox.codexState, "workspace", "rate-limit-first"), {
    status: "failed",
    errorMessage: "Rate limit exceeded",
    completedAt: new Date(Date.now() - 3 * 60000).toISOString()
  });
  writeRecord(jobFile(sandbox.codexState, "workspace", "rate-limit-second"), {
    status: "error",
    failureKind: "rate_limited",
    errorMessage: "Too many requests",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /^fusion breaker advisory: treat the codex breaker as open unless verified recovered; last failure rate_limited \d+ minutes? ago\.\n$/);
  assert.strictEqual(result.stderr, "");
});

test("a successful Codex job between rate limits preserves the retry", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(sandbox.codexState, "workspace", "rate-limit-first"), {
    status: "error",
    failureKind: "rate_limited",
    finishedAt: new Date(Date.now() - 4 * 60000).toISOString()
  });
  writeRecord(jobFile(sandbox.codexState, "workspace", "recovered"), {
    status: "done",
    finishedAt: new Date(Date.now() - 3 * 60000).toISOString()
  });
  writeRecord(jobFile(sandbox.codexState, "workspace", "rate-limit-second"), {
    status: "error",
    failureKind: "rate_limited",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});

test("a successful Codex job after repeated rate limits closes the breaker", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(sandbox.codexState, "workspace", "rate-limit-first"), {
    status: "error",
    failureKind: "rate_limited",
    finishedAt: new Date(Date.now() - 4 * 60000).toISOString()
  });
  writeRecord(jobFile(sandbox.codexState, "workspace", "rate-limit-second"), {
    status: "error",
    failureKind: "rate_limited",
    finishedAt: new Date(Date.now() - 3 * 60000).toISOString()
  });
  writeRecord(jobFile(sandbox.codexState, "workspace", "recovered"), {
    status: "done",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});

test("rate limits from different providers do not combine", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(path.join(sandbox.grokData, "state"), "workspace", "grok-rate-limit"), {
    status: "error",
    failureKind: "rate_limited",
    finishedAt: new Date(Date.now() - 3 * 60000).toISOString()
  });
  writeRecord(jobFile(sandbox.codexState, "workspace", "codex-rate-limit"), {
    status: "error",
    failureKind: "rate_limited",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});

test("two Grok rate limits inside the configured window open only the Grok breaker", (t) => {
  const sandbox = makeSandbox(t);
  const stateRoot = path.join(sandbox.grokData, "state");
  writeRecord(jobFile(stateRoot, "workspace", "rate-limit-first"), {
    status: "error",
    failureKind: "rate_limited",
    finishedAt: new Date(Date.now() - 3 * 60000).toISOString()
  });
  writeRecord(jobFile(stateRoot, "workspace", "rate-limit-second"), {
    status: "error",
    failureKind: "rate_limited",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /^fusion breaker advisory: treat the grok breaker as open unless verified recovered; last failure rate_limited \d+ minutes? ago\.\n$/);
  assert.strictEqual(result.stderr, "");
});

test("rate limits outside the configured retry window do not combine", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(sandbox.codexState, "workspace", "rate-limit-first"), {
    status: "error",
    failureKind: "rate_limited",
    finishedAt: new Date(Date.now() - 10 * 60000).toISOString()
  });
  writeRecord(jobFile(sandbox.codexState, "workspace", "rate-limit-second"), {
    status: "error",
    failureKind: "rate_limited",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });

  const result = run(sandbox, { FUSION_BREAKER_LOOKBACK_HOURS: "0.1" });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});

test("a typed Codex adapter error uses the canonical status and finished timestamp", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(sandbox.codexState, "workspace", "auth"), {
    status: "error",
    failureKind: "auth",
    errorMessage: "request failed",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /^fusion breaker advisory: treat the codex breaker as open unless verified recovered; last failure auth \d+ minutes? ago\.\n$/);
});

test("a typed Codex protocol failure opens the compatibility breaker", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(sandbox.codexState, "workspace", "protocol"), {
    status: "error",
    failureKind: "protocol",
    errorMessage: "Codex exited without turn.completed.",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /^fusion breaker advisory: treat the codex breaker as open unless verified recovered; last failure protocol \d+ minutes? ago\.\n$/);
});

test("a successful Codex job does not open the breaker from diagnostic text", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(sandbox.codexState, "workspace", "recovered"), {
    status: "done",
    errorMessage: "transient authentication failed before recovery",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
});

test("a typed non-breaker Codex error is not reclassified from diagnostic text", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(sandbox.codexState, "workspace", "timeout"), {
    status: "error",
    failureKind: "timeout",
    errorMessage: "transient authentication failed before timeout",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
});

test("Codex state resolution prefers the canonical override and keeps the legacy override compatible", () => {
  assert.strictEqual(resolveCodexStateDir({ FUSION_CODEX_STATE: "/canonical", FUSION_CODEX_STATE_DIR: "/legacy" }), "/canonical");
  assert.strictEqual(resolveCodexStateDir({ FUSION_CODEX_STATE_DIR: "/legacy" }), "/legacy");
  assert.strictEqual(resolveCodexStateDir({ CODEX_COMPANION_DATA: "/adapter-data" }), "/adapter-data/state");
  assert.strictEqual(resolveCodexStateDir({}), path.join(os.homedir(), ".claude", "plugins", "data", "codex-claude-code-fusion", "state"));
});

test("default Codex state resolution reads canonical and legacy roots in priority order", () => {
  assert.deepStrictEqual(resolveCodexStateRoots({ HOME: "/test-home" }), [
    "/test-home/.claude/plugins/data/codex-claude-code-fusion/state",
    "/test-home/.claude/plugins/data/codex-openai-codex/state"
  ]);
  assert.deepStrictEqual(resolveCodexStateRoots({ HOME: "/test-home", FUSION_CODEX_STATE: "/override" }), ["/override"]);
  assert.deepStrictEqual(resolveCodexStateRoots({ HOME: "/test-home", CODEX_COMPANION_DATA: "/adapter" }), ["/adapter/state"]);
  assert.deepStrictEqual(resolveCodexStateRoots({ HOME: "/test-home", FUSION_CODEX_STATE: "relative-override" }), [
    "/test-home/.claude/plugins/data/codex-claude-code-fusion/state",
    "/test-home/.claude/plugins/data/codex-openai-codex/state"
  ]);
  assert.deepStrictEqual(resolveCodexStateRoots({ HOME: "/test-home", CODEX_COMPANION_DATA: "relative-adapter" }), [
    "/test-home/.claude/plugins/data/codex-claude-code-fusion/state",
    "/test-home/.claude/plugins/data/codex-openai-codex/state"
  ]);
});

test("the breaker reads legacy Codex state when the canonical root is absent", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(homeCodexState(sandbox, "codex-openai-codex"), "workspace", "legacy-auth"), {
    id: "legacy-auth",
    status: "failed",
    errorMessage: "Authentication failed",
    completedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });
  const result = runWithHome(sandbox);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /codex breaker as open.*last failure auth/);
});

test("a mirrored Codex rate limit is deduplicated across canonical and legacy roots", (t) => {
  const sandbox = makeSandbox(t);
  const record = {
    id: "mirrored-rate-limit",
    status: "failed",
    errorMessage: "Rate limit exceeded",
    completedAt: new Date(Date.now() - 2 * 60000).toISOString()
  };
  writeRecord(jobFile(homeCodexState(sandbox, "codex-claude-code-fusion"), "workspace", record.id), record);
  writeRecord(jobFile(homeCodexState(sandbox, "codex-openai-codex"), "workspace", record.id), record);
  const result = runWithHome(sandbox);
  assert.strictEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /codex breaker/);
});

test("a terminal Codex copy supersedes a stale running mirror with the same id", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(homeCodexState(sandbox, "codex-claude-code-fusion"), "workspace-a", "mirrored-job"), {
    id: "mirrored-job",
    status: "running",
    errorMessage: "Authentication failed",
    updatedAt: new Date(Date.now() - 1 * 60000).toISOString()
  });
  writeRecord(jobFile(homeCodexState(sandbox, "codex-openai-codex"), "workspace-b", "mirrored-job"), {
    id: "mirrored-job",
    status: "completed",
    errorMessage: "Authentication failed before recovery",
    completedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });
  const result = runWithHome(sandbox);
  assert.strictEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /codex breaker/);
});

test("an explicit Codex state override excludes legacy home state", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(homeCodexState(sandbox, "codex-openai-codex"), "workspace", "legacy-auth"), {
    id: "legacy-auth",
    status: "failed",
    errorMessage: "Authentication failed",
    completedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });
  const result = runWithHome(sandbox, { FUSION_CODEX_STATE: path.join(sandbox.root, "isolated-state") });
  assert.strictEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /codex breaker/);
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
