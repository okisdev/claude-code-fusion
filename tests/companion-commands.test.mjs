import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const prompt = "Your time budget is exhausted. Stop exploring. Within a few minutes, finish or revert any half applied edit so the workspace is consistent, then reply with a final report: what is done, what is not done, files changed, and how to verify.";

function harness(t, scenario = "done", supportsWindDown = true) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shared-companion-test-")));
  t.after(() => {
    for (const entry of entries()) {
      if (entry.childPid) try { process.kill(-entry.childPid, "SIGKILL"); } catch {}
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  for (const dir of ["scripts", ".claude-plugin", "workspace", "identity-bin", "prompts"]) fs.mkdirSync(path.join(temp, dir));
  fs.writeFileSync(path.join(temp, ".claude-plugin/plugin.json"), '{"version":"1.0.0"}');
  fs.writeFileSync(path.join(temp, "prompts/review.md"), "Review {{DIFF}}");
  const script = path.join(temp, "scripts/companion.mjs");
  const log = path.join(temp, "calls.jsonl");
  const data = path.join(temp, "data");
  const cwd = path.join(temp, "workspace");
  const env = { ...process.env, TMPDIR: temp, DEVIN_COMPANION_DATA: data, DEVIN_COMPANION_TIMEOUT_MS: "77" };
  if (["darwin", "freebsd", "openbsd"].includes(process.platform)) {
    const bin = path.join(temp, "identity-bin");
    fs.writeFileSync(path.join(bin, "ps"), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-p" ]; then pid="$2"; shift 2; else shift; fi; done\nif kill -0 "$pid" 2>/dev/null; then printf "process-%s\\n" "$pid"; else exit 1; fi\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "sysctl"), "#!/bin/sh\nprintf '{ sec = 1, usec = 0 }\\n'\n", { mode: 0o755 });
    env.PATH = `${bin}${path.delimiter}${env.PATH}`;
  }
  fs.writeFileSync(script, `import fs from "node:fs";
import { spawn } from "node:child_process";
import { createCompanionCommands } from ${JSON.stringify(path.join(root, "shared/companion/companion-commands.mjs"))};
import { processGroupAlive } from ${JSON.stringify(path.join(root, "shared/companion/process-identity.mjs"))};
import * as state from ${JSON.stringify(path.join(root, "plugins/devin/scripts/lib/state.mjs"))};
import * as render from ${JSON.stringify(path.join(root, "plugins/devin/scripts/lib/render.mjs"))};
const scenario = ${JSON.stringify(scenario)};
let calls = 0;
const log = (value) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(value) + "\\n");
const commands = createCompanionCommands({
  engine: "devin", engineName: "Devin", entryUrl: import.meta.url, state, render,
  supportsWindDown: ${supportsWindDown === null ? "undefined" : JSON.stringify(supportsWindDown)}, sessionIdPattern: state.DEVIN_SESSION_ID_PATTERN,
  sweep() {}, jobDirectory: () => ({}), resumeEligible: () => scenario !== "ineligible", validateResumeSource() {},
  resolvedEffort: () => null, payloadFields: () => ({}), outcomeFields: () => ({}), cancelledFields: () => ({}),
  modelDrift: () => null, failureMessage: (outcome) => outcome.spawnError?.message,
  classifyFailure: (outcome) => outcome.cancelled ? "cancelled" : outcome.timedOut ? "timeout" : outcome.exitCode === 0 ? null : "error",
  prepareJob(options, dataDir, cwd, context) { log({ prepare: context }); return { fields: { warnings: [] }, request: {} }; },
  async runJob({ record, source, brief, timeoutMs, signal, launchProcess, onProcess }) {
    calls += 1;
    log({ id: record.id, source, brief, timeoutMs, deadlineAt: record.deadlineAt, request: record.request, aborted: signal.aborted });
    const file = state.jobFilePath(state.resolveDataDir(), record.cwd, record.id);
    if (scenario.startsWith("group_")) {
      if (calls === 2) log({ originalAlive: processGroupAlive(record.devinPid) });
      const childCode = calls === 1
        ? 'const { spawn } = require("node:child_process"); const helper = spawn(process.execPath, ["-e", ' + JSON.stringify('process.send("ready"); setTimeout(() => process.exit(0), ' + (scenario === "group_stays" ? 20000 : 500) + ');') + '], { stdio: ["ignore", "ignore", "ignore", "ipc"] }); helper.once("message", () => process.exit(0));'
        : 'setTimeout(() => process.exit(0), 50);';
      const child = launchProcess(() => spawn(process.execPath, ["-e", childCode], { detached: true, stdio: "ignore" }));
      log({ childPid: child.pid, call: calls });
      onProcess(child.pid);
      const running = state.readJobRecordFile(file);
      log({ originalPid: running.devinPid, resumePid: running.salvage?.resumePid, call: calls });
      await new Promise((resolve) => child.once("exit", resolve));
    }
    if (calls === 1 && scenario === "cancelled") state.updateJobRecordFile(file, { cancelRequestedAt: state.nowIso() });
    if (calls === 1 && scenario === "cancelled_outcome") return { cancelled: true, timedOut: true, exitCode: null, sessionId: "test-session" };
    if (calls === 1 && scenario === "signal" || calls === 2 && scenario === "salvage_signal") process.emit("SIGTERM");
    if (calls === 2 && scenario === "throws") throw new Error("resume failed");
    if (record.jobClass === "review" && scenario === "review_done") return { exitCode: 0, resultText: JSON.stringify({ verdict: "approve", summary: "Checked", findings: [] }) };
    if (calls === 1) return { timedOut: true, exitCode: null, sessionId: scenario === "invalid_session" ? "../invalid" : "test-session", resultText: "first partial result", stderrTail: "first attempt", usage: { inputTokens: 10 } };
    return { timedOut: scenario === "timeout", exitCode: scenario === "error" ? 1 : 0, resultText: "finished workspace report", stderrTail: "resume stderr", sessionId: "test-session", usage: { inputTokens: 2, outputTokens: 3 } };
  }
});
commands.run();
`);
  const run = (args) => spawnSync(process.execPath, [script, ...args], { cwd, env, input: "", encoding: "utf8", timeout: 10000 });
  const entries = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  const jobs = () => fs.readdirSync(path.join(data, "state")).flatMap((workspace) => {
    const dir = path.join(data, "state", workspace, "jobs");
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
  });
  const staged = (raw) => {
    const created = run(["transport-create"]);
    assert.equal(created.status, 0, created.stderr);
    const transport = JSON.parse(created.stdout);
    fs.writeFileSync(transport.file, raw);
    return transport;
  };
  return { cwd, env, run, jobs, staged, entries, calls: () => entries().filter((entry) => entry.id) };
}

test("timeout salvage resumes once in the same job with the fixed prompt and budget", (t) => {
  const h = harness(t);
  const result = h.run(["task", "--json", "--", "original brief"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [record] = h.jobs();
  const payload = JSON.parse(result.stdout);
  assert.equal(h.jobs().length, 1);
  assert.equal(record.status, "done");
  assert.equal(record.transportStatus, "done");
  assert.equal(record.semanticStatus, "unverified");
  assert.equal(record.failureKind, null);
  assert.equal(record.semanticFailureKind, "timeout_salvaged");
  assert.deepEqual(record.salvage, { attempted: true, originalPid: null, outcome: "done" });
  assert.equal(record.resultText, "finished workspace report");
  assert.equal(payload.text, record.resultText);
  assert.deepEqual(payload.salvage, record.salvage);
  assert.equal(payload.semanticFailureKind, "timeout_salvaged");
  assert.equal(record.usageIsIncomplete, true);
  const [initial, resumed] = h.calls();
  assert.equal(h.calls().length, 2);
  assert.equal(initial.timeoutMs, 77);
  assert.equal(resumed.timeoutMs, 240000);
  assert.ok(Date.parse(resumed.deadlineAt) > Date.now() + 230000);
  assert.equal(resumed.id, initial.id);
  assert.equal(resumed.source.id, initial.id);
  assert.equal(resumed.source.sessionId, "test-session");
  assert.equal(resumed.request.resumeSessionId, "test-session");
  assert.equal(resumed.brief, prompt);
  assert.equal(resumed.aborted, false);
  const collected = h.run(["result", record.id]);
  assert.equal(collected.status, 0, collected.stdout + collected.stderr);
  assert.match(collected.stdout, /finished workspace report/);
  assert.match(collected.stdout, /semantic: unverified\nwarning: timeout_salvaged\nstate: done\n$/);
});

for (const scenario of ["timeout", "error", "throws"]) {
  test(`salvage ${scenario} terminalizes without another resume`, (t) => {
    const h = harness(t, scenario);
    const result = h.run(["task", "--", "inspect"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const [record] = h.jobs();
    const kind = scenario === "timeout" ? "timeout" : "error";
    assert.equal(record.status, "error");
    assert.equal(record.failureKind, kind);
    assert.deepEqual(record.salvage, { attempted: true, originalPid: null, outcome: kind });
    assert.equal(record.resultText, "first partial result");
    assert.equal(record.errorTail, "first attempt");
    assert.equal(record.sessionId, "test-session");
    assert.equal(h.calls().length, 2);
    assert.match(result.stdout, new RegExp(`state: error\\nfailure: ${kind}\\n$`));
    if (scenario === "timeout") assert.match(record.errorMessage, /240000ms/);
  });
}

test("salvage waits for a leaderless process group and records both process ids", (t) => {
  const h = harness(t, "group_exits");
  const result = h.run(["task", "--", "inspect"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(h.calls().length, 2);
  const [original, resumed] = h.entries().filter((entry) => entry.childPid);
  const running = h.entries().find((entry) => entry.call === 2 && entry.originalPid);
  const [record] = h.jobs();
  assert.equal(h.entries().find((entry) => Object.hasOwn(entry, "originalAlive")).originalAlive, false);
  assert.equal(running.originalPid, original.childPid);
  assert.equal(running.resumePid, resumed.childPid);
  assert.equal(record.salvage.originalPid, original.childPid);
  assert.equal(record.salvage.resumePid, resumed.childPid);
  assert.ok(Object.hasOwn(record.salvage, "resumePidIdentity"));
});

test("a leaderless process group that outlives cleanup leaves a plain timeout", (t) => {
  const h = harness(t, "group_stays");
  const startedAt = Date.now();
  const result = h.run(["task", "--", "inspect"]);
  const elapsed = Date.now() - startedAt;
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(h.calls().length, 1);
  const [record] = h.jobs();
  assert.equal(record.salvage, undefined);
  assert.equal(record.failureKind, "timeout");
  assert.equal(record.resultText, "first partial result");
  assert.equal(record.errorTail, "first attempt");
  assert.match(record.errorMessage, /77ms/);
  assert.ok(elapsed >= 3000 && elapsed < 8000, `elapsed: ${elapsed}ms`);
});

for (const scenario of ["cancelled", "cancelled_outcome", "signal", "invalid_session", "ineligible"]) {
  test(`${scenario} run does not start timeout salvage`, (t) => {
    const h = harness(t, scenario);
    const result = h.run(["task", "--", "inspect"]);
    assert.equal(result.status, scenario === "signal" ? 143 : 1, result.stdout + result.stderr);
    assert.equal(h.calls().length, 1);
    const [record] = h.jobs();
    assert.equal(record.salvage, undefined);
    assert.equal(record.failureKind, scenario.startsWith("cancelled") || scenario === "signal" ? "cancelled" : "timeout");
  });
}

test("cancellation during salvage retains the cancelled terminal state", (t) => {
  const h = harness(t, "salvage_signal");
  const result = h.run(["task", "--", "inspect"]);
  assert.equal(result.status, 143, result.stdout + result.stderr);
  const [record] = h.jobs();
  assert.equal(record.status, "cancelled");
  assert.equal(record.failureKind, "cancelled");
  assert.deepEqual(record.salvage, { attempted: true, originalPid: null, outcome: "error" });
  assert.equal(h.calls().length, 2);
});

for (const supportsWindDown of [false, null]) {
  test(`adapter support ${supportsWindDown === null ? "missing" : supportsWindDown} does not salvage a timeout`, (t) => {
    const h = harness(t, "done", supportsWindDown);
    const result = h.run(["task", "--", "inspect"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(h.calls().length, 1);
    assert.equal(h.jobs()[0].salvage, undefined);
    assert.equal(h.jobs()[0].failureKind, "timeout");
  });
}

for (const [raw, defaults, write] of [
  ["-- inspect", ["--transport-default-write"], true],
  ["--write=false -- inspect", ["--transport-default-write"], false],
  ["--write -- inspect", [], true],
  ["-- inspect", [], false]
]) {
  test(`preparation receives effective write ${write} for ${raw} with ${defaults.join(" ")}`, (t) => {
    const h = harness(t);
    const transport = h.staged(raw);
    const result = h.run(["task", ...defaults, "--raw-args-token", transport.token]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(h.entries()[0], { prepare: { write } });
    assert.equal(h.jobs()[0].mode, write ? "write" : "consult");
  });
}

for (const scenario of ["review_done", "timeout"]) {
  test(`background shell review ${scenario} receives 900000ms without task salvage`, (t) => {
    const h = harness(t, scenario);
    delete h.env.DEVIN_COMPANION_TIMEOUT_MS;
    const git = (args, input = "") => {
      const result = spawnSync("git", args, { cwd: h.cwd, input, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(["init", "-q", "--initial-branch=main"]);
    const tree = git(["mktree"]);
    const commit = git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", tree, "-m", "seed"]);
    git(["update-ref", "refs/heads/main", commit]);
    fs.writeFileSync(path.join(h.cwd, "change.txt"), "change\n");
    const transport = h.staged("--json");
    const result = h.run(["review", "--transport-background-shell", "--raw-args-token", transport.token]);
    assert.equal(result.status, scenario === "review_done" ? 0 : 1, result.stdout + result.stderr);
    assert.equal(h.calls().length, 1);
    assert.equal(h.calls()[0].timeoutMs, 900000);
    const [record] = h.jobs();
    assert.equal(record.request.backgroundShellBudget, true);
    assert.equal(record.background, false);
    assert.equal(record.salvage, undefined);
    assert.deepEqual(h.entries()[0], { prepare: { write: false } });
    assert.equal(fs.existsSync(transport.file), false);
  });
}
