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
    home: path.join(root, "home"),
    workerState: path.join(root, "worker-state"),
    dataDir: path.join(root, "fusion-data"),
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
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== "HOME" && key !== "CLAUDE_CODE_SESSION_ID" && !/^(?:FUSION|GROK|CODEX)_/.test(key)
    )
  );
  return {
    ...inherited,
    HOME: sandbox.home,
    FUSION_DATA_DIR: sandbox.dataDir,
    FUSION_WORKER_STATE_DIR: sandbox.workerState,
    FUSION_CODEX_STATE: sandbox.codexState,
    FUSION_CODEX_STATE_DIR: sandbox.codexState,
    GROK_COMPANION_DATA: sandbox.grokData,
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
    status: "error",
    failureKind: "rate_limited",
    errorMessage: "Rate limit exceeded",
    finishedAt: new Date(Date.now() - 3 * 60000).toISOString()
  });
  writeRecord(jobFile(sandbox.codexState, "workspace", "rate-limit-second"), {
    status: "error",
    failureKind: "rate_limited",
    errorMessage: "Too many requests",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /^fusion breaker advisory: treat the codex breaker as open unless verified recovered; last failure rate_limited \d+ minutes? ago\. Route new work to another eligible healthy lane\.\n$/);
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
  assert.match(result.stdout, /^fusion breaker advisory: treat the grok breaker as open unless verified recovered; last failure rate_limited \d+ minutes? ago\. Route new work to another eligible healthy lane\.\n$/);
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
  assert.match(result.stdout, /^fusion breaker advisory: treat the codex breaker as open unless verified recovered; last failure auth \d+ minutes? ago\. Route new work to another eligible healthy lane\.\n$/);
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
  assert.match(result.stdout, /^fusion breaker advisory: treat the codex breaker as open unless verified recovered; last failure protocol \d+ minutes? ago\. Route new work to another eligible healthy lane\.\n$/);
});

test("a collaboration policy violation is treated as a protocol breaker but an ordinary policy denial is not", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(sandbox.codexState, "workspace", "ordinary-policy"), {
    status: "error",
    failureKind: "policy",
    errorMessage: "tool policy denied this request",
    finishedAt: new Date(Date.now() - 3 * 60000).toISOString()
  });
  assert.strictEqual(run(sandbox).stdout, "");
  writeRecord(jobFile(sandbox.codexState, "workspace", "collaboration-policy"), {
    status: "error",
    failureKind: "policy",
    errorMessage: "collaboration policy violation",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });
  assert.match(run(sandbox).stdout, /last failure protocol/);
});

test("the actual disabled collaboration tool diagnostic opens the Codex breaker", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(sandbox.codexState, "workspace", "disabled-collaboration-tool"), {
    status: "error",
    failureKind: "policy",
    errorMessage: "Delegated Codex execution attempted the disabled spawn_agent tool.",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });
  assert.match(run(sandbox).stdout, /codex breaker.*last failure protocol/);
});

test("sandbox initialization is an immediate hard breaker", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(path.join(sandbox.grokData, "state"), "workspace", "sandbox"), {
    status: "error",
    failureKind: "sandbox",
    errorTail: "sandbox initialization failed",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });
  assert.match(run(sandbox).stdout, /grok breaker.*last failure sandbox/);
});

test("ordinary permission denial stays local while transport permission failure opens immediately", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(sandbox.codexState, "workspace", "tool-denial"), {
    status: "error",
    failureKind: "permission",
    errorMessage: "permission denied for tool invocation",
    finishedAt: new Date(Date.now() - 3 * 60000).toISOString()
  });
  assert.strictEqual(run(sandbox).stdout, "");
  writeRecord(jobFile(sandbox.codexState, "workspace", "transport-denial"), {
    status: "error",
    failureKind: "permission",
    errorMessage: "permission denied while initializing prompt transport",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });
  assert.match(run(sandbox).stdout, /codex breaker.*last failure permission/);
});

test("two consecutive timeouts open the breaker and a later success closes it", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(sandbox.codexState, "workspace", "timeout-one"), {
    status: "error",
    failureKind: "timeout",
    finishedAt: new Date(Date.now() - 4 * 60000).toISOString()
  });
  writeRecord(jobFile(sandbox.codexState, "workspace", "timeout-two"), {
    status: "error",
    failureKind: "timeout",
    finishedAt: new Date(Date.now() - 3 * 60000).toISOString()
  });
  assert.match(run(sandbox).stdout, /codex breaker.*last failure timeout/);
  writeRecord(jobFile(sandbox.codexState, "workspace", "recovered"), {
    status: "done",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });
  assert.strictEqual(run(sandbox).stdout, "");
});

test("a successful terminal job closes a previously hard breaker", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(sandbox.codexState, "workspace", "auth-failure"), {
    status: "error",
    failureKind: "auth",
    finishedAt: new Date(Date.now() - 3 * 60000).toISOString()
  });
  writeRecord(jobFile(sandbox.codexState, "workspace", "auth-recovered"), {
    status: "done",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });
  assert.strictEqual(run(sandbox).stdout, "");
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

test("Codex state resolution uses configured canonical state sources", () => {
  assert.strictEqual(resolveCodexStateDir({ FUSION_CODEX_STATE: "/canonical" }), "/canonical");
  assert.strictEqual(resolveCodexStateDir({ CODEX_COMPANION_DATA: "/adapter-data" }), "/adapter-data/state");
  assert.strictEqual(resolveCodexStateDir({}), path.join(os.homedir(), ".claude", "plugins", "data", "codex-claude-code-fusion", "state"));
  assert.deepStrictEqual(resolveCodexStateRoots({ HOME: "/test-home" }), ["/test-home/.claude/plugins/data/codex-claude-code-fusion/state"]);
  assert.deepStrictEqual(resolveCodexStateRoots({ HOME: "/test-home", FUSION_CODEX_STATE: "/override" }), ["/override"]);
  assert.deepStrictEqual(resolveCodexStateRoots({ HOME: "/test-home", CODEX_COMPANION_DATA: "/adapter" }), ["/adapter/state"]);
  assert.deepStrictEqual(resolveCodexStateRoots({ HOME: "/test-home", FUSION_CODEX_STATE: "relative-override" }), ["/test-home/.claude/plugins/data/codex-claude-code-fusion/state"]);
  assert.deepStrictEqual(resolveCodexStateRoots({ HOME: "/test-home", CODEX_COMPANION_DATA: "relative-adapter" }), ["/test-home/.claude/plugins/data/codex-claude-code-fusion/state"]);
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
