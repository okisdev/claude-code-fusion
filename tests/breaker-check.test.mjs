import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { advisoryLine, codexFailureKind, run as runBreakerCheck } from "../plugins/fusion/scripts/breaker-check.mjs";
import { engineStateRoots } from "../plugins/fusion/scripts/lib/engines.mjs";
import { engineHostBlockers } from "../plugins/fusion/scripts/lib/engine-host-check.mjs";
import { engineHealth, readEngineHealthRecords, withEngineHealthRecords } from "../plugins/fusion/scripts/lib/engine-health.mjs";
import { engineInfraDenial } from "../plugins/fusion/scripts/lib/lifecycle/dispatch.mjs";
import { messageTag } from "../plugins/fusion/scripts/lib/user-messages.mjs";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "plugins", "fusion", "scripts", "breaker-check.mjs");
const verifiedGrokVersion = JSON.parse(fs.readFileSync(new URL("../plugins/fusion/verified-versions.json", import.meta.url), "utf8")).grok;
const fusionVersion = JSON.parse(fs.readFileSync(new URL("../plugins/fusion/.claude-plugin/plugin.json", import.meta.url), "utf8")).version;
const BREAKER_ADVISORY_TAG = messageTag("breaker-check.breaker-advisory");
const ESCAPED_BREAKER_ADVISORY_TAG = BREAKER_ADVISORY_TAG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "breaker-check-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    home: path.join(root, "home"),
    workerState: path.join(root, "worker-state"),
    dataDir: path.join(root, "fusion-data"),
    grokData: path.join(root, "grok-data"),
    cursorData: path.join(root, "cursor-data"),
    devinData: path.join(root, "devin-data"),
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

function writeWorkerRecord(sandbox, id, record) {
  writeRecord(path.join(sandbox.workerState, "jobs", `${id}.json`), record);
}

function writeCompanion(file, source) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source, "utf8");
  return file;
}

function envFor(sandbox, extra = {}) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== "HOME" && key !== "CLAUDE_CODE_SESSION_ID" && !/^(?:FUSION|GROK|CODEX|CURSOR|DEVIN|AGY)_/.test(key)
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
    CURSOR_COMPANION_DATA: sandbox.cursorData,
    DEVIN_COMPANION_DATA: sandbox.devinData,
    ...extra
  };
}

function run(sandbox, extraEnv = {}) {
  return spawnSync(process.execPath, [script], {
    env: envFor(sandbox, extraEnv),
    encoding: "utf8"
  });
}

test("installed engines with missing CLI binaries produce one routing line", (t) => {
  const box = makeSandbox(t);
  const bin = path.join(box.root, "bin");
  fs.mkdirSync(bin);
  for (const engine of ["codex", "grok", "cursor", "devin", "agy"]) {
    fs.mkdirSync(path.join(box.home, ".claude", "plugins", "cache", "claude-code-fusion", engine), { recursive: true });
  }
  for (const binary of ["codex", "cursor-agent"]) {
    const file = path.join(bin, binary);
    fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(file, 0o700);
  }
  const missing = run(box, { PATH: bin });
  assert.strictEqual(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /fusion engines unavailable \(CLI missing\): grok, devin, agy\. Skip these lanes\./);
  assert.strictEqual(missing.stdout.trim().split("\n").length, 1);

  for (const binary of ["grok", "devin", "agy"]) {
    const file = path.join(bin, binary);
    fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(file, 0o700);
  }
  assert.strictEqual(run(box, { PATH: bin }).stdout, "");
});

test("missing CLI binaries are silent for engines without an installed cache", (t) => {
  const box = makeSandbox(t);
  assert.strictEqual(run(box, { PATH: path.join(box.root, "empty-bin") }).stdout, "");
});

test("installed engines honor executable absolute and PATH binary overrides", (t) => {
  const box = makeSandbox(t);
  const bin = path.join(box.root, "bin");
  fs.mkdirSync(bin);
  for (const engine of ["codex", "grok", "cursor", "devin", "agy"]) {
    fs.mkdirSync(path.join(box.home, ".claude", "plugins", "cache", "claude-code-fusion", engine), { recursive: true });
  }
  for (const binary of ["codex", "grok", "cursor-agent", "devin", "agy", "codex-custom", "grok-custom", "cursor-custom", "devin-custom", "agy-custom"]) {
    const file = path.join(bin, binary);
    fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(file, 0o700);
  }
  const overrides = {
    CODEX_BIN: path.join(bin, "codex-custom"),
    GROK_BIN: "grok-custom",
    CURSOR_AGENT_BIN: path.join(bin, "cursor-custom"),
    DEVIN_BIN: "devin-custom",
    AGY_BIN: "agy-custom"
  };
  assert.strictEqual(run(box, { PATH: bin, ...overrides }).stdout, "");
  assert.strictEqual(run(box, { PATH: bin, CODEX_BIN: "codex-custom", GROK_BIN: path.join(bin, "grok-custom"), CURSOR_AGENT_BIN: "cursor-custom", DEVIN_BIN: path.join(bin, "devin-custom"), AGY_BIN: path.join(bin, "agy-custom") }).stdout, "");

  for (const [engine, key] of [["codex", "CODEX_BIN"], ["grok", "GROK_BIN"], ["cursor", "CURSOR_AGENT_BIN"], ["devin", "DEVIN_BIN"], ["agy", "AGY_BIN"]]) {
    for (const invalid of [path.join(box.root, "missing-binary"), "missing-binary"]) {
      const result = run(box, { PATH: bin, ...overrides, [key]: invalid });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`fusion engines unavailable \\(CLI missing\\): ${engine}\\. Skip these lanes\\.`));
    }
  }
  const nonExecutable = path.join(box.root, "non-executable");
  fs.writeFileSync(nonExecutable, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(nonExecutable, 0o600);
  assert.match(run(box, { PATH: bin, ...overrides, CODEX_BIN: nonExecutable }).stdout, /CLI missing\): codex\./);
});

test("text classified Codex connectivity failures map to network after stronger evidence", () => {
  for (const message of [
    "Reconnecting... (workspace routing discovery timed out)",
    "stream disconnected before completion: upstream closed the stream",
    "error sending request: connection refused",
    "connection reset", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "getaddrinfo failed", "network is unreachable"
  ]) {
    assert.strictEqual(codexFailureKind(message), "network", message);
  }
  assert.strictEqual(codexFailureKind("quota exhausted; Reconnecting..."), "quota");
  assert.strictEqual(codexFailureKind("rate limit exceeded; connection reset"), "rate_limited");
  assert.strictEqual(codexFailureKind("stream disconnected before completion: Incomplete response returned, reason: content_filter"), "refused");
  assert.strictEqual(codexFailureKind("authentication failed; error sending request"), "auth");
});

test("Codex policy refusal diagnostics match the companion classification", () => {
  for (const message of [
    "This request violated the safety policy.",
    "This violates our acceptable use policy.",
    "This is a violation of an internal policy.",
    "This violated policy.",
    "This violates the safety policy; stream disconnected before completion"
  ]) {
    assert.strictEqual(codexFailureKind(message), "refused", message);
  }
  assert.strictEqual(codexFailureKind("collaboration policy violation"), "protocol");
});

test("Codex capacity diagnostics are transient rate limits", () => {
  for (const message of ["Flex capacity unavailable.", "Policy-restricted capacity is unavailable."]) {
    assert.strictEqual(codexFailureKind(message), "rate_limited", message);
    assert.strictEqual(codexFailureKind(`${message} connection reset`), "rate_limited", message);
    assert.strictEqual(codexFailureKind(`usage limit reached; ${message}`), "quota", message);
  }
});

test("worker breaker parses recent ledger records once and skips 2,000 old files", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const now = Date.now();
  const jobsDir = path.join(sandbox.workerState, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  const recent = new Set();
  for (const [id, minutesAgo] of [["fusion-recent-one", 4], ["fusion-recent-two", 2]]) {
    const file = path.join(jobsDir, `${id}.json`);
    writeRecord(file, {
      agentType: "fusion:claude-worker", transportStatus: "failed", failureKind: "timeout",
      finishedAt: new Date(now - minutesAgo * 60000).toISOString()
    });
    fs.utimesSync(file, (now - 60000) / 1000, (now - 60000) / 1000);
    recent.add(file);
  }
  const originalWrite = process.stdout.write;
  const capture = () => {
    let output = "";
    process.stdout.write = (chunk) => { output += chunk; return true; };
    try {
      runBreakerCheck(env, now);
    } finally {
      process.stdout.write = originalWrite;
    }
    return output;
  };
  const expected = capture();
  assert.match(expected, /fusion:claude-worker breaker as open.*2 timeout across 2 terminal jobs/);
  const old = new Set();
  for (let index = 0; index < 2000; index += 1) {
    const file = path.join(jobsDir, `fusion-old-${index}.json`);
    writeRecord(file, {
      agentType: "fusion:claude-worker", transportStatus: "failed", failureKind: "timeout",
      finishedAt: new Date(now - 13 * 60 * 60000).toISOString()
    });
    fs.utimesSync(file, (now - 13 * 60 * 60000) / 1000, (now - 13 * 60 * 60000) / 1000);
    old.add(file);
  }
  let oldReads = 0;
  let recentReads = 0;
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (old.has(file)) oldReads += 1;
    if (recent.has(file)) recentReads += 1;
    return originalRead(file, ...args);
  };
  let actual;
  try {
    actual = capture();
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.strictEqual(actual, expected);
  assert.strictEqual(oldReads, 0);
  assert.strictEqual(recentReads, 2);
});

test("engine breaker skips old job files before reading across every engine and workspace", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const now = Date.now();
  const oldFiles = new Set();
  const recentFiles = new Set();
  for (const engine of ["codex", "grok", "cursor", "devin", "agy"]) {
    const stateRoot = engineStateRoots(engine, env)[0];
    for (const workspace of ["one", "two"]) {
      const old = jobFile(stateRoot, workspace, `${engine}-old`);
      writeRecord(old, { status: "error", failureKind: "quota", finishedAt: new Date(now - 13 * 60 * 60 * 1000).toISOString() });
      fs.utimesSync(old, (now - 13 * 60 * 60 * 1000) / 1000, (now - 13 * 60 * 60 * 1000) / 1000);
      oldFiles.add(old);
    }
    const recent = jobFile(stateRoot, "two", `${engine}-recent`);
    writeRecord(recent, { status: "error", failureKind: "auth", finishedAt: new Date(now - 2 * 60000).toISOString() });
    fs.utimesSync(recent, (now - 60000) / 1000, (now - 60000) / 1000);
    recentFiles.add(recent);
  }
  const originalRead = fs.readFileSync;
  const originalWrite = process.stdout.write;
  let oldReads = 0;
  let recentReads = 0;
  let output = "";
  fs.readFileSync = (file, ...args) => {
    if (oldFiles.has(file)) oldReads += 1;
    if (recentFiles.has(file)) recentReads += 1;
    return originalRead(file, ...args);
  };
  process.stdout.write = (chunk) => { output += chunk; return true; };
  try {
    runBreakerCheck(env, now);
  } finally {
    fs.readFileSync = originalRead;
    process.stdout.write = originalWrite;
  }
  assert.strictEqual(oldReads, 0);
  assert.strictEqual(recentReads, 5);
  for (const engine of ["codex", "grok", "cursor", "devin", "agy"]) {
    assert.match(output, new RegExp(`treat the ${engine} breaker as open.*1 auth across 1 terminal jobs`));
  }
  assert.ok(output.endsWith(`${BREAKER_ADVISORY_TAG}\n`));
});

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
  assert.match(result.stdout, /last failure quota \d+ minutes? ago \(1 quota across 1 terminal jobs, 12h window\)/);
  assert.ok(result.stdout.endsWith(`${BREAKER_ADVISORY_TAG}\n`));
  assert.strictEqual(result.stderr, "");
});

test("grok breaker version advice reports only a contract drift", (t) => {
  assert.strictEqual(verifiedGrokVersion, "1.0.89");
  const changed = makeSandbox(t);
  writeRecord(jobFile(path.join(changed.grokData, "state"), "workspace", "changed"), {
    status: "error",
    failureKind: "quota",
    grokVersion: "1.0.99",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });
  assert.ok(run(changed).stdout.includes(`; grok 1.0.99 installed, contract verified on ${verifiedGrokVersion} [fusion:`));

  const pinned = makeSandbox(t);
  writeRecord(jobFile(path.join(pinned.grokData, "state"), "workspace", "pinned"), {
    status: "error",
    failureKind: "quota",
    grokVersion: verifiedGrokVersion,
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });
  assert.doesNotMatch(run(pinned).stdout, /installed, contract verified on/);

  const unknown = makeSandbox(t);
  writeRecord(jobFile(path.join(unknown.grokData, "state"), "workspace", "unknown"), {
    status: "error",
    failureKind: "quota",
    grokVersion: null,
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });
  assert.doesNotMatch(run(unknown).stdout, /installed, contract verified on/);
});

test("advisoryLine renders kind and terminal proportions with singular and plural counts", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  const lookbackMs = 12 * 60 * 60 * 1000;
  assert.strictEqual(
    advisoryLine("grok", { failureKind: "quota", timestamp: now - 30 * 60000, kindCount: 1, terminalCount: 1 }, now, lookbackMs),
    "fusion breaker advisory: treat the grok breaker as open unless verified recovered; last failure quota 30 minutes ago (1 quota across 1 terminal jobs, 12h window). Route new work to another eligible healthy lane."
  );
  assert.strictEqual(
    advisoryLine("codex", { failureKind: "rate_limited", timestamp: now - 2 * 60000, kindCount: 2, terminalCount: 3 }, now, lookbackMs),
    "fusion breaker advisory: treat the codex breaker as open unless verified recovered; last failure rate_limited 2 minutes ago (2 rate_limited across 3 terminal jobs, 12h window). Route new work to another eligible healthy lane."
  );
  assert.strictEqual(
    advisoryLine("grok", { failureKind: "auth", timestamp: now - 90 * 60000, kindCount: 1, terminalCount: 2 }, now, 0.1 * 60 * 60 * 1000),
    "fusion breaker advisory: treat the grok breaker as open unless verified recovered; last failure auth 1 hour ago (1 auth across 2 terminal jobs, 0.1h window). Route new work to another eligible healthy lane."
  );
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

test("unsupported Codex model errors are not network failures", () => {
  assert.strictEqual(codexFailureKind("Error sending request: model gpt-5 is not supported"), null);
  assert.strictEqual(codexFailureKind("error sending request for url (https://example.test): connection failed"), "network");
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
  assert.match(result.stdout, new RegExp(`^fusion breaker advisory: treat the codex breaker as open unless verified recovered; last failure rate_limited \\d+ minutes? ago \\(2 rate_limited across 2 terminal jobs, 12h window\\)\\. Route new work to another eligible healthy lane\\. ${ESCAPED_BREAKER_ADVISORY_TAG}\\n$`));
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

test("Grok and Codex advisories retain their existing order", (t) => {
  const sandbox = makeSandbox(t);
  const finishedAt = new Date(Date.now() - 2 * 60000).toISOString();
  writeRecord(jobFile(path.join(sandbox.grokData, "state"), "workspace", "grok-auth"), {
    status: "error",
    failureKind: "auth",
    finishedAt
  });
  writeRecord(jobFile(sandbox.codexState, "workspace", "codex-auth"), {
    status: "error",
    failureKind: "auth",
    finishedAt
  });
  assert.match(run(sandbox).stdout, /^fusion breaker advisory: treat the grok breaker.*\nfusion breaker advisory: treat the codex breaker/);
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
  assert.match(result.stdout, new RegExp(`^fusion breaker advisory: treat the grok breaker as open unless verified recovered; last failure rate_limited \\d+ minutes? ago \\(2 rate_limited across 2 terminal jobs, 12h window\\)\\. Route new work to another eligible healthy lane\\. ${ESCAPED_BREAKER_ADVISORY_TAG}\\n$`));
  assert.strictEqual(result.stderr, "");
});

test("Grok network failures open only after a consecutive retry and success resets them", (t) => {
  const sandbox = makeSandbox(t);
  const stateRoot = path.join(sandbox.grokData, "state");
  writeRecord(jobFile(stateRoot, "workspace", "network-first"), {
    status: "error",
    mode: "consult",
    failureKind: "network",
    finishedAt: new Date(Date.now() - 4 * 60000).toISOString()
  });
  assert.strictEqual(run(sandbox).stdout, "");

  writeRecord(jobFile(stateRoot, "workspace", "network-second"), {
    status: "error",
    mode: "consult",
    failureKind: "network",
    finishedAt: new Date(Date.now() - 3 * 60000).toISOString()
  });
  const opened = run(sandbox);
  assert.strictEqual(opened.status, 0);
  assert.match(opened.stdout, new RegExp(`^fusion breaker advisory: treat the grok breaker as open unless verified recovered; last failure network \\d+ minutes? ago \\(2 network across 2 terminal jobs, 12h window, consult mode\\)\\. Route new work to another eligible healthy lane\\. ${ESCAPED_BREAKER_ADVISORY_TAG}\\n$`));
  assert.strictEqual(opened.stderr, "");

  writeRecord(jobFile(stateRoot, "workspace", "network-recovered"), {
    status: "done",
    mode: "consult",
    failureKind: null,
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });
  const recovered = run(sandbox);
  assert.strictEqual(recovered.status, 0);
  assert.strictEqual(recovered.stdout, "");
  assert.strictEqual(recovered.stderr, "");
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
  assert.match(result.stdout, new RegExp(`^fusion breaker advisory: treat the codex breaker as open unless verified recovered; last failure auth \\d+ minutes? ago \\(1 auth across 1 terminal jobs, 12h window\\)\\. Route new work to another eligible healthy lane\\. ${ESCAPED_BREAKER_ADVISORY_TAG}\\n$`));
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
  assert.match(result.stdout, new RegExp(`^fusion breaker advisory: treat the codex breaker as open unless verified recovered; last failure protocol \\d+ minutes? ago \\(1 protocol across 1 terminal jobs, 12h window\\)\\. Route new work to another eligible healthy lane\\. ${ESCAPED_BREAKER_ADVISORY_TAG}\\n$`));
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

test("a Codex refusal neither opens nor counts toward the breaker", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(sandbox.codexState, "workspace", "refused"), {
    status: "error",
    failureKind: "refused",
    errorMessage: "This request violated the misalignment policy.",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });

  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
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

for (const failureKind of ["patch_thrash", "exec_lost"]) {
  test(`one ${failureKind} keeps the Codex breaker closed, while a consecutive second occurrence opens it`, (t) => {
    const sandbox = makeSandbox(t);
    writeRecord(jobFile(sandbox.codexState, "workspace", `${failureKind}-first`), {
      status: "error",
      failureKind,
      finishedAt: new Date(Date.now() - 3 * 60000).toISOString()
    });
    assert.strictEqual(run(sandbox).stdout, "");
    writeRecord(jobFile(sandbox.codexState, "workspace", `${failureKind}-second`), {
      status: "error",
      failureKind,
      finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
    });
    assert.match(run(sandbox).stdout, new RegExp(`codex breaker.*last failure ${failureKind}`));
  });
}

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
  assert.strictEqual(engineStateRoots("codex", { FUSION_CODEX_STATE: "/canonical" })[0], "/canonical");
  assert.strictEqual(engineStateRoots("codex", { CODEX_COMPANION_DATA: "/adapter-data" })[0], "/adapter-data/state");
  assert.strictEqual(engineStateRoots("codex", {})[0], path.join(os.homedir(), ".claude", "plugins", "data", "codex-claude-code-fusion", "state"));
  assert.deepStrictEqual(engineStateRoots("codex", { HOME: "/test-home" }), ["/test-home/.claude/plugins/data/codex-claude-code-fusion/state"]);
  assert.deepStrictEqual(engineStateRoots("codex", { HOME: "/test-home", FUSION_CODEX_STATE: "/override" }), ["/override"]);
  assert.deepStrictEqual(engineStateRoots("codex", { HOME: "/test-home", CODEX_COMPANION_DATA: "/adapter" }), ["/adapter/state"]);
  assert.deepStrictEqual(engineStateRoots("codex", { HOME: "/test-home", FUSION_CODEX_STATE: "relative-override" }), ["/test-home/.claude/plugins/data/codex-claude-code-fusion/state"]);
  assert.deepStrictEqual(engineStateRoots("codex", { HOME: "/test-home", CODEX_COMPANION_DATA: "relative-adapter" }), ["/test-home/.claude/plugins/data/codex-claude-code-fusion/state"]);
});

test("Cursor quota opens only its billing pool until that pool succeeds", (t) => {
  const sandbox = makeSandbox(t);
  const root = engineStateRoots("cursor", envFor(sandbox))[0];
  writeRecord(jobFile(root, "workspace", "api-quota"), {
    id: "api-quota",
    status: "error",
    failureKind: "quota",
    billingPool: "api",
    finishedAt: new Date(Date.now() - 4 * 60000).toISOString()
  });
  const opened = run(sandbox);
  assert.strictEqual(opened.status, 0);
  assert.match(opened.stdout, /treat the cursor api pool breaker as open.*last failure quota.*1 quota across 1 terminal jobs/);
  assert.doesNotMatch(opened.stdout, /treat the cursor breaker as open|first-party pool breaker/);

  writeRecord(jobFile(root, "workspace", "first-party-success"), {
    id: "first-party-success",
    status: "done",
    billingPool: "first-party",
    finishedAt: new Date(Date.now() - 3 * 60000).toISOString()
  });
  assert.match(run(sandbox).stdout, /treat the cursor api pool breaker as open.*1 quota across 1 terminal jobs/);

  writeRecord(jobFile(root, "workspace", "api-success"), {
    id: "api-success",
    status: "done",
    billingPool: "api",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });
  assert.strictEqual(run(sandbox).stdout, "");
});

test("Cursor rate limits require two failures in one pool", (t) => {
  const sandbox = makeSandbox(t);
  const root = engineStateRoots("cursor", envFor(sandbox))[0];
  for (const [id, billingPool, minutesAgo] of [["api-first", "api", 4], ["first-party", "first-party", 3], ["api-second", "api", 2]]) {
    writeRecord(jobFile(root, "workspace", id), {
      status: "error",
      failureKind: "rate_limited",
      billingPool,
      finishedAt: new Date(Date.now() - minutesAgo * 60000).toISOString()
    });
    if (id !== "api-second") {
      assert.strictEqual(run(sandbox).stdout, "");
    }
  }
  const result = run(sandbox);
  assert.match(result.stdout, /treat the cursor api pool breaker as open.*2 rate_limited across 2 terminal jobs/);
  assert.doesNotMatch(result.stdout, /first-party pool breaker|treat the cursor breaker as open/);
});

test("An engine failure does not interrupt a pool's rate limit sequence", (t) => {
  const sandbox = makeSandbox(t);
  const root = engineStateRoots("cursor", envFor(sandbox))[0];
  for (const [id, failureKind, minutesAgo] of [["rate-first", "rate_limited", 4], ["auth", "auth", 3], ["rate-second", "rate_limited", 2]]) {
    writeRecord(jobFile(root, "workspace", id), {
      status: "error",
      failureKind,
      billingPool: "api",
      finishedAt: new Date(Date.now() - minutesAgo * 60000).toISOString()
    });
  }
  const result = run(sandbox);
  assert.match(result.stdout, /treat the cursor breaker as open.*last failure auth/);
  assert.match(result.stdout, /treat the cursor api pool breaker as open.*2 rate_limited across 3 terminal jobs/);
});

test("Cursor authentication failure opens the engine breaker across pools", (t) => {
  const sandbox = makeSandbox(t);
  const root = engineStateRoots("cursor", envFor(sandbox))[0];
  writeRecord(jobFile(root, "workspace", "auth"), {
    status: "error",
    failureKind: "auth",
    billingPool: "api",
    finishedAt: new Date(Date.now() - 3 * 60000).toISOString()
  });
  assert.match(run(sandbox).stdout, /treat the cursor breaker as open.*last failure auth/);
  writeRecord(jobFile(root, "workspace", "recovered"), {
    status: "done",
    billingPool: "first-party",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });
  assert.strictEqual(run(sandbox).stdout, "");
});

test("Cursor setup failure opens immediately and version drift is reported", (t) => {
  const sandbox = makeSandbox(t);
  const root = engineStateRoots("cursor", envFor(sandbox))[0];
  writeRecord(jobFile(root, "workspace", "setup"), {
    status: "error",
    failureKind: "setup",
    billingPool: "api",
    cursorVersion: "2026.10.02-abcdef0",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /treat the cursor breaker as open.*last failure setup.*1 setup across 1 terminal jobs/);
  assert.match(result.stdout, /; cursor 2026\.10\.02-abcdef0 installed, contract verified on 2026\.11\.17-f532c45/);
  assert.doesNotMatch(result.stdout, /cursor api pool breaker/);
});

test("Devin breaker uses its billing pool and verified version", (t) => {
  const sandbox = makeSandbox(t);
  const root = engineStateRoots("devin", envFor(sandbox))[0];
  writeRecord(jobFile(root, "workspace", "quota"), {
    id: "quota", engine: "devin", status: "error", failureKind: "quota", billingPool: "api",
    devinVersion: "3000.14.30822", finishedAt: new Date(Date.now() - 60_000).toISOString()
  });
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /treat the devin credits pool breaker as open.*last failure quota/);
  assert.match(result.stdout, /devin 3000\.14\.30822 installed, contract verified on 3000\.14\.30821/);
  writeRecord(jobFile(root, "workspace", "recovered"), {
    id: "recovered", status: "done", billingPool: "api", finishedAt: new Date().toISOString()
  });
  assert.strictEqual(run(sandbox).stdout, "");
});

test("Codex version drift uses the registry verified version key", (t) => {
  const sandbox = makeSandbox(t);
  writeRecord(jobFile(sandbox.codexState, "workspace", "auth"), {
    status: "error",
    failureKind: "auth",
    codexVersion: "0.173.0",
    finishedAt: new Date(Date.now() - 2 * 60000).toISOString()
  });
  assert.match(run(sandbox).stdout, /; codex 0\.173\.0 installed, contract verified on 0\.172\.0/);
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

test("wrapper delivery advisory requires 20 current-version peer rescue runs and 25 percent delivery failures", (t) => {
  const sandbox = makeSandbox(t);
  const now = Date.now();
  for (let index = 0; index < 19; index += 1) {
    writeWorkerRecord(sandbox, `peer-${index}`, {
      agentType: index % 2 ? "grok-rescue" : "codex:codex-rescue",
      companionVersion: fusionVersion,
      transportStatus: index < 5 ? "failed" : "done",
      failureKind: index < 5 ? "delivery" : null,
      finishedAt: new Date(now - 2 * 60000).toISOString()
    });
  }
  assert.strictEqual(run(sandbox).stdout, "");
  writeWorkerRecord(sandbox, "peer-19", {
    agentType: "cursor:cursor-rescue", companionVersion: fusionVersion, transportStatus: "done", failureKind: null,
    finishedAt: new Date(now - 60000).toISOString()
  });
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, `wrapper delivery: 5 of 20 peer wrapper runs on fusion ${fusionVersion} in the last 12 hours ended without a delivered report; run /fusion:smoke before more delegated work. ${BREAKER_ADVISORY_TAG}\n`);
  assert.strictEqual(result.stderr, "");

  for (let index = 20; index < 36; index += 1) {
    writeWorkerRecord(sandbox, `peer-${index}`, {
      agentType: "devin:devin-rescue", companionVersion: fusionVersion, transportStatus: "done", failureKind: null,
      finishedAt: new Date(now - 60000).toISOString()
    });
  }
  assert.strictEqual(run(sandbox).stdout, "");
});

test("wrapper delivery counts only in-window rescue records for the running plugin version", (t) => {
  const sandbox = makeSandbox(t);
  const now = Date.now();
  for (let index = 0; index < 19; index += 1) {
    writeWorkerRecord(sandbox, `peer-${index}`, {
      agentType: "grok:grok-rescue", companionVersion: fusionVersion, transportStatus: index < 5 ? "failed" : "done", failureKind: index < 5 ? "delivery" : null,
      finishedAt: new Date(now - 60000).toISOString()
    });
  }
  for (const [id, agentType, version, finishedAt] of [
    ["managed", "grok:grok-review-runner", fusionVersion, now - 60000],
    ["fusion-worker", "fusion:claude-worker", fusionVersion, now - 60000],
    ["old-version", "grok:grok-rescue", "0.0.0", now - 60000],
    ["old-time", "grok:grok-rescue", fusionVersion, now - 13 * 60 * 60 * 1000]
  ]) {
    writeWorkerRecord(sandbox, id, {
      agentType, companionVersion: version, transportStatus: "done", failureKind: null,
      finishedAt: new Date(finishedAt).toISOString()
    });
  }
  assert.strictEqual(run(sandbox).stdout, "");
  writeWorkerRecord(sandbox, "twentieth", {
    agentType: "devin-rescue", companionVersion: fusionVersion, transportStatus: "done", failureKind: null,
    finishedAt: new Date(now - 60000).toISOString()
  });
  assert.strictEqual(run(sandbox).stdout, `wrapper delivery: 5 of 20 peer wrapper runs on fusion ${fusionVersion} in the last 12 hours ended without a delivered report; run /fusion:smoke before more delegated work. ${BREAKER_ADVISORY_TAG}\n`);
});

test("host check reports every blocker from an installed Grok companion in the existing digest", (t) => {
  const sandbox = makeSandbox(t);
  const companion = path.join(sandbox.home, ".claude", "plugins", "cache", "claude-code-fusion", "grok", fusionVersion, "scripts", "grok-companion.mjs");
  writeCompanion(companion, `if (process.argv.slice(2).join(" ") !== "host-check --json") process.exit(2); process.stdout.write(JSON.stringify({blockers:[{kind:"sandbox",modes:["consult","write","review"],message:"Sandbox setup failed."},{kind:"auth",modes:["consult"],message:"Sign in first."}]}));`);
  writeRecord(jobFile(path.join(sandbox.grokData, "state"), "workspace", "quota"), {
    status: "error", failureKind: "quota", finishedAt: new Date(Date.now() - 60000).toISOString()
  });
  const result = run(sandbox, { GROK_BIN: process.execPath });
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /^fusion breaker advisory: treat the grok breaker.*\nGrok consult, write, review runs are blocked on this host \(sandbox\): Sandbox setup failed\.\nGrok consult runs are blocked on this host \(auth\): Sign in first\. \[fusion:/);
  assert.ok(result.stdout.endsWith(`${BREAKER_ADVISORY_TAG}\n`));
  assert.strictEqual(result.stderr, "");
});

test("missing, failing, timed out, and invalid host checks stay silent", (t) => {
  const sandbox = makeSandbox(t);
  assert.strictEqual(run(sandbox).stdout, "");
  assert.strictEqual(run(sandbox, { FUSION_GROK_COMPANION: path.join(sandbox.root, "missing.mjs") }).stdout, "");
  for (const [name, source] of [
    ["nonzero", "process.stdout.write('{\"blockers\":[{\"kind\":\"auth\",\"modes\":[\"write\"],\"message\":\"Blocked.\"}]}'); process.exit(1);"],
    ["timeout", "setInterval(() => {}, 10000);"],
    ["invalid-json", "process.stdout.write('{bad json');"],
    ["invalid-shape", "process.stdout.write(JSON.stringify({blockers:[{kind:'auth',modes:'write',message:'Blocked.'}]}));"]
  ]) {
    const companion = writeCompanion(path.join(sandbox.root, `${name}.mjs`), source);
    const result = run(sandbox, { FUSION_GROK_COMPANION: companion });
    assert.strictEqual(result.status, 0, name);
    assert.strictEqual(result.stdout, "", name);
    assert.strictEqual(result.stderr, "", name);
  }
});

test("host checks cache validated blockers across hook processes and expire after 60 seconds", (t) => {
  const box = makeSandbox(t);
  const companion = writeCompanion(path.join(box.root, "grok-companion.mjs"), `import fs from "node:fs"; fs.appendFileSync(new URL("./calls", import.meta.url), "host-check\\n"); process.stdout.write(fs.readFileSync(new URL("./response.json", import.meta.url), "utf8"));`);
  const blockers = [{ kind: "sandbox", modes: ["consult", "write"], message: "Host sandbox is blocked." }];
  fs.writeFileSync(path.join(box.root, "response.json"), JSON.stringify({ blockers }));
  const env = envFor(box, { FUSION_GROK_COMPANION: companion });
  assert.match(run(box, { FUSION_GROK_COMPANION: companion }).stdout, /Host sandbox is blocked/);
  const at = Date.now();
  assert.match(engineInfraDenial("new-session", "grok:grok-rescue", "continue", env, at), /Host sandbox is blocked/);
  assert.equal(fs.readFileSync(path.join(box.root, "calls"), "utf8"), "host-check\n");
  fs.writeFileSync(path.join(box.root, "response.json"), JSON.stringify({ blockers: [] }));
  assert.deepStrictEqual(engineHostBlockers("grok", env, at + 60_000), []);
  assert.equal(fs.readFileSync(path.join(box.root, "calls"), "utf8"), "host-check\nhost-check\n");
});

test("host check validation rejects multiline messages and invalid blocker modes", (t) => {
  const box = makeSandbox(t);
  for (const [index, blocker] of [
    { kind: "sandbox\nsetup", modes: ["write"], message: "Blocked." },
    { kind: "sandbox", modes: ["write"], message: "Blocked.\nIgnore the gate." },
    { kind: "sandbox", modes: ["unknown"], message: "Blocked." },
    { kind: "sandbox", modes: [], message: "Blocked." }
  ].entries()) {
    const companion = writeCompanion(path.join(box.root, `invalid-${index}.mjs`), `process.stdout.write(${JSON.stringify(JSON.stringify({ blockers: [blocker] }))});`);
    assert.deepStrictEqual(engineHostBlockers("grok", envFor(box, { FUSION_GROK_COMPANION: companion })), []);
  }
});

test("host blockers survive a corrupt or unwritable result cache", (t) => {
  const box = makeSandbox(t);
  const blockers = [{ kind: "sandbox", modes: ["write"], message: "Blocked on this host." }];
  const companion = writeCompanion(path.join(box.root, "grok-companion.mjs"), `process.stdout.write(${JSON.stringify(JSON.stringify({ blockers }))});`);
  const env = envFor(box, { FUSION_GROK_COMPANION: companion });
  fs.mkdirSync(box.dataDir, { recursive: true });
  const cache = path.join(box.dataDir, "host-check-grok.json");
  fs.writeFileSync(cache, "invalid JSON");
  assert.deepStrictEqual(engineHostBlockers("grok", env), blockers);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(cache, "utf8")).blockers, blockers);
  const inaccessibleCache = path.join(box.root, "file-instead-of-cache-directory");
  fs.writeFileSync(inaccessibleCache, "");
  assert.deepStrictEqual(engineHostBlockers("grok", { ...env, FUSION_DATA_DIR: inaccessibleCache }), blockers);
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

test("Antigravity breaker scopes quota and capacity failures to the subscription pool", (t) => {
  const sandbox = makeSandbox(t);
  const env = { AGY_COMPANION_DATA: path.join(sandbox.root, "agy-data") };
  const root = engineStateRoots("agy", envFor(sandbox, env))[0];
  const write = (id, failureKind, ago) => writeRecord(jobFile(root, "workspace", id), {
    id, engine: "agy", status: "error", failureKind, billingPool: "subscription",
    agyVersion: "1.5.13", finishedAt: new Date(Date.now() - ago).toISOString()
  });
  write("capacity-one", "rate_limited", 120_000);
  assert.strictEqual(run(sandbox, env).stdout, "");
  write("capacity-two", "rate_limited", 60_000);
  const limited = run(sandbox, env);
  assert.strictEqual(limited.status, 0, limited.stderr);
  assert.match(limited.stdout, /agy subscription pool breaker as open.*last failure rate_limited/);
  assert.match(limited.stdout, /agy 1\.5\.13 installed, contract verified on 1\.5\.12/);
  writeRecord(jobFile(root, "workspace", "recovered"), { id: "recovered", status: "done", billingPool: "subscription", finishedAt: new Date().toISOString() });
  assert.strictEqual(run(sandbox, env).stdout, "");
  fs.rmSync(jobFile(root, "workspace", "recovered"));
  write("quota", "quota", 1000);
  assert.match(run(sandbox, env).stdout, /agy subscription pool breaker as open.*last failure quota/);
});

test("Antigravity policy failures open only their mode and refusals stay local", (t) => {
  const sandbox = makeSandbox(t);
  const env = { AGY_COMPANION_DATA: path.join(sandbox.root, "agy-data") };
  const root = engineStateRoots("agy", envFor(sandbox, env))[0];
  const file = jobFile(root, "workspace", "failed");
  writeRecord(file, { id: "failed", status: "error", failureKind: "refused", finishedAt: new Date().toISOString() });
  assert.strictEqual(run(sandbox, env).stdout, "");
  writeRecord(file, { id: "failed", status: "error", mode: "consult", failureKind: "policy", billingPool: "subscription", finishedAt: new Date().toISOString() });
  assert.match(run(sandbox, env).stdout, /agy breaker as open.*last failure policy/);
  assert.doesNotMatch(run(sandbox, env).stdout, /agy subscription pool breaker/);
  assert.equal(engineHealth("agy", "write", "subscription", { env: envFor(sandbox, env) }).healthy, true);
  assert.equal(engineHealth("agy", "consult", "subscription", { env: envFor(sandbox, env) }).scope, "mode");
});

for (const failureKind of ["timeout", "stall", "died", "policy", "permission", "turn_limit", "network", "process", "patch_thrash", "exec_lost"]) {
  test(`repeated Devin write ${failureKind} failures preserve package and mode scopes`, (t) => {
    const box = makeSandbox(t);
    const env = envFor(box);
    const now = Date.now();
    const root = engineStateRoots("devin", env)[0];
    for (const [index, minutes] of [[1, 4], [2, 2]]) {
      writeRecord(jobFile(root, "workspace", `write-${index}`), {
        id: `write-${index}`, status: "error", mode: "write", failureKind,
        billingPool: "first-party", finishedAt: new Date(now - minutes * 60_000).toISOString()
      });
    }
    const write = engineHealth("devin", "write", "api", { env, now });
    if (["policy", "permission", "turn_limit"].includes(failureKind)) {
      assert.equal(write.healthy, true);
      assert.equal(write.reason, null);
      assert.equal(run(box).stdout, "");
    } else {
      assert.equal(write.healthy, false);
      assert.equal(write.reason, failureKind);
      assert.equal(write.scope, "mode");
      assert.equal(write.until, now - 2 * 60_000 + 12 * 60 * 60_000);
      assert.match(run(box).stdout, new RegExp(`devin breaker.*${failureKind}.*write mode`));
    }
    assert.equal(engineHealth("devin", "consult", "first-party", { env, now }).healthy, true);
    assert.equal(engineHealth("devin", "review", "api", { env, now }).healthy, true);
  });
}

for (const engine of ["codex", "grok", "cursor", "devin", "agy"]) {
  for (const failureKind of ["policy", "permission", "turn_limit"]) {
    test(`${engine} repeated ${failureKind} keeps package failures local`, (t) => {
      const box = makeSandbox(t);
      const env = envFor(box);
      const now = Date.now();
      for (const index of [1, 2]) writeRecord(jobFile(engineStateRoots(engine, env)[0], "workspace", `local-${index}`), {
        id: `local-${index}`, status: "error", mode: "write", failureKind,
        errorMessage: "permission denied for tool invocation", finishedAt: new Date(now - index * 60_000).toISOString()
      });
      const health = engineHealth(engine, "write", null, { env, now });
      assert.equal(health.healthy, engine !== "agy" || failureKind !== "policy");
      assert.equal(engineHealth(engine, "consult", null, { env, now }).healthy, true);
    });
  }
}

test("transport permission failures still open immediately while cancelled outcomes never feed streaks", (t) => {
  const box = makeSandbox(t);
  const env = envFor(box);
  const now = Date.now();
  const root = engineStateRoots("devin", env)[0];
  const file = jobFile(root, "workspace", "failure");
  writeRecord(file, { id: "failure", status: "failed", mode: "write", failureKind: "permission", errorMessage: "permission denied initializing prompt transport", finishedAt: new Date(now - 60_000).toISOString() });
  assert.equal(engineHealth("devin", "write", null, { env, now }).reason, "permission");
  for (const failureKind of ["auth", "quota", "timeout", "policy", "permission", "turn_limit"]) {
    writeRecord(file, { id: "failure", status: "cancelled", mode: "write", failureKind, errorMessage: "permission denied initializing prompt transport", finishedAt: new Date(now - 60_000).toISOString() });
    assert.equal(engineHealth("devin", "write", null, { env, now }).healthy, true, failureKind);
  }
  writeRecord(file, { id: "failure", status: "error", mode: "write", failureKind: "timeout", finishedAt: new Date(now - 3 * 60_000).toISOString() });
  writeRecord(jobFile(root, "workspace", "cancelled"), { id: "cancelled", status: "cancelled", mode: "write", failureKind: "timeout", finishedAt: new Date(now - 2 * 60_000).toISOString() });
  assert.equal(engineHealth("devin", "write", null, { env, now }).healthy, true);
  writeRecord(jobFile(root, "workspace", "second"), { id: "second", status: "failed", mode: "write", failureKind: "timeout", finishedAt: new Date(now - 60_000).toISOString() });
  const health = engineHealth("devin", "write", null, { env, now });
  assert.equal(health.healthy, false);
  assert.equal(health.failures[0].kindCount, 2);
  assert.equal(health.failures[0].terminalCount, 2);
});

for (const [legacy, current] of [["first-party", "free"], ["api", "credits"]]) {
  test(`Devin compares legacy ${legacy} with ${current} for failure and recovery`, (t) => {
    const box = makeSandbox(t);
    const env = envFor(box);
    const now = Date.now();
    const root = engineStateRoots("devin", env)[0];
    writeRecord(jobFile(root, "workspace", "quota"), { id: "quota", status: "error", failureKind: "quota", billingPool: legacy, finishedAt: new Date(now - 2 * 60_000).toISOString() });
    for (const pool of [legacy, current, null]) assert.equal(engineHealth("devin", "write", pool, { env, now }).healthy, false);
    writeRecord(jobFile(root, "workspace", "recovery"), { id: "recovery", status: "done", billingPool: current, finishedAt: new Date(now - 60_000).toISOString() });
    for (const pool of [legacy, current, null]) assert.equal(engineHealth("devin", "write", pool, { env, now }).healthy, true);
  });
}

test("mode-less historical failures apply to both modes while package types retain their scope", (t) => {
  const box = makeSandbox(t);
  const env = envFor(box);
  const now = Date.now();
  const root = engineStateRoots("devin", env)[0];
  for (const index of [1, 2]) writeRecord(jobFile(root, "workspace", `legacy-${index}`), { id: `legacy-${index}`, status: "error", failureKind: "timeout", finishedAt: new Date(now - index * 60_000).toISOString() });
  for (const mode of ["write", "consult", "review"]) assert.equal(engineHealth("devin", mode, null, { env, now }).healthy, false);
  writeRecord(jobFile(root, "workspace", "recovery"), { id: "recovery", status: "done", finishedAt: new Date(now).toISOString() });
  for (const mode of ["write", "consult"]) assert.equal(engineHealth("devin", mode, null, { env, now }).healthy, true);
  for (const index of [1, 2]) writeRecord(jobFile(root, "workspace", `legacy-${index}`), { id: `legacy-${index}`, status: "error", packageType: "implementation", failureKind: "timeout", finishedAt: new Date(now + index * 1000).toISOString() });
  assert.equal(engineHealth("devin", "write", null, { env, now: now + 3000 }).healthy, false);
  assert.equal(engineHealth("devin", "consult", null, { env, now: now + 3000 }).healthy, true);
});

test("unknown pools count any exhausted pool without combining streaks or cross-pool recoveries", (t) => {
  const box = makeSandbox(t);
  const env = envFor(box);
  const now = Date.now();
  const root = engineStateRoots("devin", env)[0];
  const write = (id, billingPool, status, failureKind, age) => writeRecord(jobFile(root, "workspace", id), { id, billingPool, status, failureKind, finishedAt: new Date(now - age).toISOString() });
  write("free-rate", "free", "error", "rate_limited", 4_000);
  write("credits-rate", "credits", "error", "rate_limited", 3_000);
  assert.equal(engineHealth("devin", "write", null, { env, now }).healthy, true);
  write("free-quota", "free", "failed", "quota", 2_000);
  write("credits-success", "credits", "done", null, 1_000);
  const health = engineHealth("devin", "write", null, { env, now });
  assert.equal(health.healthy, false);
  assert.equal(health.reason, "quota");
  assert.equal(health.failures[0].pool, "free");
  assert.equal(engineHealth("devin", "write", "credits", { env, now }).healthy, true);
});

test("one hook snapshot memoizes disk reads and later hooks observe new outcomes", (t) => {
  const box = makeSandbox(t);
  const env = envFor(box);
  const now = Date.now();
  const root = engineStateRoots("devin", env)[0];
  let scans = 0;
  const readdir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (directory, ...args) => {
    if (directory === root) scans += 1;
    return readdir(directory, ...args);
  });
  withEngineHealthRecords(() => {
    const records = readEngineHealthRecords(env, now);
    assert.strictEqual(readEngineHealthRecords(env, now + 1), records);
    writeRecord(jobFile(root, "workspace", "failure"), { id: "failure", status: "error", failureKind: "auth", finishedAt: new Date(now).toISOString() });
    assert.equal(engineHealth("devin", "write", null, { env, now, records }).healthy, true);
    assert.equal(engineHealth("devin", "consult", null, { env, now }).healthy, true);
    assert.equal(scans, 1);
  });
  withEngineHealthRecords(() => {
    assert.equal(engineHealth("devin", "write", null, { env, now }).healthy, false);
    assert.equal(scans, 2);
  });
});

test("breaker advisory dedup retains different failure kinds for ambiguous pool labels", (t) => {
  const box = makeSandbox(t);
  const env = envFor(box);
  const root = engineStateRoots("devin", env)[0];
  const now = Date.now();
  for (const [id, billingPool, failureKind, age] of [["quota", null, "quota", 3_000], ["rate-one", "null", "rate_limited", 2_000], ["rate-two", "null", "rate_limited", 1_000]]) {
    writeRecord(jobFile(root, "workspace", id), { id, billingPool, status: "error", failureKind, finishedAt: new Date(now - age).toISOString() });
  }
  let output = "";
  runBreakerCheck(env, now, (text) => { output += text; });
  assert.match(output, /last failure quota/);
  assert.match(output, /last failure rate_limited/);
  assert.equal(output.split("last failure quota").length - 1, 1);
  assert.equal(output.split("last failure rate_limited").length - 1, 1);
});

test("quota and rate limits share a billing pool across modes without poisoning another pool", (t) => {
  const box = makeSandbox(t);
  const env = envFor(box);
  const now = Date.now();
  const root = engineStateRoots("devin", env)[0];
  for (const failureKind of ["quota", "rate_limited"]) {
    fs.rmSync(root, { recursive: true, force: true });
    for (const [index, mode] of [[1, "write"], [2, "consult"]]) {
      writeRecord(jobFile(root, "workspace", `failure-${index}`), {
        id: `failure-${index}`, status: "error", mode, failureKind,
        billingPool: "first-party", finishedAt: new Date(now - (3 - index) * 60_000).toISOString()
      });
    }
    for (const mode of ["write", "consult", "review"]) {
      const health = engineHealth("devin", mode, "first-party", { env, now });
      assert.equal(health.healthy, false);
      assert.equal(health.scope, "pool");
      assert.equal(engineHealth("devin", mode, "api", { env, now }).healthy, true);
    }
  }
});

for (const failureKind of ["auth", "missing_cli", "setup", "protocol", "transport", "sandbox"]) {
  test(`${failureKind} remains engine wide across modes and pools`, (t) => {
    const box = makeSandbox(t);
    const env = envFor(box);
    const now = Date.now();
    writeRecord(jobFile(engineStateRoots("devin", env)[0], "workspace", "failure"), {
      id: "failure", status: "error", mode: "write", failureKind,
      billingPool: "first-party", finishedAt: new Date(now - 60_000).toISOString()
    });
    for (const mode of ["write", "consult", "review"]) {
      for (const pool of [null, "api", "first-party"]) {
        const health = engineHealth("devin", mode, pool, { env, now });
        assert.equal(health.healthy, false);
        assert.equal(health.scope, "engine");
      }
    }
  });
}

test("host blockers preserve write and consult scopes in unified health", (t) => {
  const box = makeSandbox(t);
  const companion = writeCompanion(path.join(box.root, "grok-companion.mjs"), `process.stdout.write(JSON.stringify({blockers:[{kind:"sandbox",modes:["write"],message:"Writes blocked."}]}));`);
  const env = envFor(box, { FUSION_GROK_COMPANION: companion });
  assert.equal(engineHealth("grok", "write", null, { env }).healthy, false);
  assert.equal(engineHealth("grok", "consult", null, { env }).healthy, true);
  assert.equal(engineHealth("grok", "review", null, { env }).healthy, true);
});

test("a consult success cannot recover write timeouts and a wrapper cannot double count its peer", (t) => {
  const box = makeSandbox(t);
  const env = envFor(box);
  const now = Date.now();
  const root = engineStateRoots("devin", env)[0];
  writeRecord(jobFile(root, "workspace", "write-1"), { id: "write-1", status: "error", mode: "write", failureKind: "timeout", finishedAt: new Date(now - 4 * 60_000).toISOString() });
  writeWorkerRecord(box, "wrapper", { taskId: "wrapper", agentType: "devin:devin-rescue", peerEngine: "devin", peerJobId: "write-1", packageType: "implementation", transportStatus: "failed", peerFailureKind: "timeout", finishedAt: new Date(now - 3 * 60_000).toISOString() });
  assert.equal(engineHealth("devin", "write", null, { env, now }).healthy, true);
  writeRecord(jobFile(root, "workspace", "write-2"), { id: "write-2", status: "error", mode: "write", failureKind: "timeout", finishedAt: new Date(now - 2 * 60_000).toISOString() });
  writeRecord(jobFile(root, "workspace", "consult-ok"), { id: "consult-ok", status: "done", mode: "consult", finishedAt: new Date(now - 60_000).toISOString() });
  assert.equal(engineHealth("devin", "write", null, { env, now }).healthy, false);
  assert.equal(engineHealth("devin", "consult", null, { env, now }).healthy, true);
});
