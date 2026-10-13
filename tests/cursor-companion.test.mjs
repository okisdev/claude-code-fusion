import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getProcessIdentity, processIdentityMatches } from "../plugins/cursor/scripts/lib/process-identity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companion = path.join(root, "plugins/cursor/scripts/cursor-companion.mjs");
const fake = path.join(root, "tests/fake-cursor");
const launcher = path.join(root, "tests/fake-cursor-launcher");

function harness(t, extraEnv = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-companion-test-"));
  t.after(() => {
    if (extraEnv.CURSOR_AGENT_BIN === launcher) {
      for (const record of jobs()) {
        if (record.status === "running" && record.cursorPid) {
          try { process.kill(-record.cursorPid, "SIGKILL"); } catch {}
        }
      }
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const home = path.join(temp, "home");
  const cwd = path.join(temp, "workspace");
  const data = path.join(temp, "data");
  const log = path.join(temp, "fake.log");
  const identityBin = path.join(temp, "identity-bin");
  const execMarker = extraEnv.CURSOR_AGENT_BIN === launcher ? path.join(temp, "cursor-exec.pid") : null;
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  fs.mkdirSync(identityBin);
  if (["darwin", "freebsd", "openbsd"].includes(process.platform)) {
    fs.writeFileSync(path.join(identityBin, "ps"), "#!/bin/sh\nif [ -z \"$FAKE_CURSOR_EXEC_MARKER\" ] && /bin/ps -p $$ >/dev/null 2>&1; then exec /bin/ps \"$@\"; fi\npid=\nfield=\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = \"-p\" ]; then pid=\"$2\"; shift 2; elif [ \"$1\" = \"-o\" ]; then field=\"$2\"; shift 2; else shift; fi\ndone\nif [ -n \"$pid\" ] && kill -0 \"$pid\" 2>/dev/null; then\n  if [ \"$field\" = \"command=\" ] && [ -f \"$FAKE_CURSOR_EXEC_MARKER\" ] && [ \"$(cat \"$FAKE_CURSOR_EXEC_MARKER\")\" = \"$pid\" ]; then printf 'node-%s\\n' \"$pid\"; else printf 'process-%s\\n' \"$pid\"; fi\nelse exit 1; fi\n");
    fs.writeFileSync(path.join(identityBin, "sysctl"), "#!/bin/sh\nif /usr/sbin/sysctl -n kern.boottime >/dev/null 2>&1; then exec /usr/sbin/sysctl \"$@\"; fi\nprintf '{ sec = 1, usec = 0 }\\n'\n");
    for (const name of ["ps", "sysctl"]) fs.chmodSync(path.join(identityBin, name), 0o755);
  }
  const env = { ...process.env, HOME: home, PATH: `${identityBin}${path.delimiter}${process.env.PATH}`, CURSOR_AGENT_BIN: fake, CURSOR_COMPANION_DATA: data, FAKE_CURSOR_LOG: log, ...extraEnv, ...(execMarker ? { FAKE_CURSOR_EXEC_MARKER: execMarker } : {}) };
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, "fake-cursor-config.json"), JSON.stringify({ scenario: extraEnv.FAKE_CURSOR_SCENARIO, log, helperPidFile: extraEnv.FAKE_CURSOR_HELPER_PID_FILE, execMarker }));
  const run = (args, input = "") => spawnSync(process.execPath, [companion, ...args], { cwd, env, input, encoding: "utf8", timeout: 30000 });
  const jobs = () => {
    const state = path.join(data, "state");
    if (!fs.existsSync(state)) return [];
    return fs.readdirSync(state).flatMap((workspace) => {
      const dir = path.join(state, workspace, "jobs");
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))) : [];
    });
  };
  const invocations = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  return { temp, home, cwd, data, log, env, run, jobs, invocations };
}

function task(h, args = [], brief = "inspect") {
  return h.run(["task", "--model", "composer-2.5", ...args, "--", brief]);
}

function assertDone(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /state: done\n$/);
}

test("consult records stream fields and renders a contiguous footer", (t) => {
  const h = harness(t);
  const result = task(h, [], "cursor-role: diversity | acceptance: cited lines\ninspect");
  assertDone(result);
  const [record] = h.jobs();
  assert.equal(record.engine, "cursor");
  assert.equal(record.mode, "consult");
  assert.equal(record.role, "diversity");
  assert.equal(record.status, "done");
  assert.equal(record.sessionId, "11111111-2222-4333-8444-555555555555");
  assert.equal(record.requestId, "fake-request-1");
  assert.deepEqual(record.usage, { inputTokens: 12, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 });
  assert.equal(record.observedModel, "Composer 2.5");
  assert.equal(record.cursorVersion, "2026.10.01-e373342");
  assert.equal(record.cursorBuildPath, fs.realpathSync(fake));
  assert.match(result.stdout, /cursor-session: 11111111-2222-4333-8444-555555555555\njob: [a-f0-9]{32}\nsandbox: /);
  assert.match(result.stdout, /delivery: foreground\nsemantic: unverified\nstate: done\n$/);
  const [call] = h.invocations();
  assert.equal(call.stdin, "cursor-role: diversity | acceptance: cited lines\ninspect");
  assert.equal(call.HOME, record.homeDir);
  assert.ok(call.argv.includes("ask"));
  assert.ok(call.argv.includes("--disable-auto-update"));
});

test("write uses write tools without ask mode", (t) => {
  const h = harness(t);
  assertDone(task(h, ["--write", "--effort", "high"], "lane: cursor burst\nimplement"));
  const [record] = h.jobs();
  const [call] = h.invocations();
  assert.equal(record.mode, "write");
  assert.equal(record.role, "burst");
  assert.equal(record.effortApplied, false);
  assert.equal(call.argv.includes("--mode"), false);
  assert.match(call.argv[call.argv.indexOf("--allowed-tools") + 1], /edit_tool_call/);
  assert.match(call.argv[call.argv.indexOf("--allowed-tools") + 1], /shell_tool_call/);
});

test("auth, quota and forbidden tools fail with typed records", (t) => {
  for (const [scenario, kind] of [["auth", "auth"], ["quota", "quota"], ["forbidden_tool", "policy"]]) {
    const h = harness(t, { FAKE_CURSOR_SCENARIO: scenario });
    const result = task(h);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`failure: ${kind}\\n$`));
    const [record] = h.jobs();
    assert.equal(record.failureKind, kind);
    assert.equal(record.status, "error");
    if (kind === "quota") assert.equal(record.billingPool, "first-party");
  }
});

test("late result close keeps a done outcome with a warning", (t) => {
  const h = harness(t, { FAKE_CURSOR_SCENARIO: "late_close", CURSOR_COMPANION_EXIT_GRACE_MS: "30" });
  const result = task(h);
  assertDone(result);
  assert.match(result.stdout, /warning: late_close\nstate: done\n$/);
  assert.deepEqual(h.jobs()[0].warnings, ["late_close"]);
});

test("unknown model and auto fail before job creation", (t) => {
  const h = harness(t);
  for (const model of ["unknown", "auto"]) {
    const result = h.run(["task", "--model", model, "--", "inspect"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failure: input/);
    assert.doesNotMatch(result.stderr, /job:/);
  }
  assert.deepEqual(h.jobs(), []);
});

test("missing and old CLI builds fail before job creation", (t) => {
  const missing = harness(t, { CURSOR_AGENT_BIN: path.join(os.tmpdir(), "absent-cursor-agent") });
  const missingResult = task(missing);
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /failure: missing_cli/);
  assert.deepEqual(missing.jobs(), []);
  const old = harness(t, { FAKE_CURSOR_VERSION: "2026.09.30-aaaa" });
  const oldResult = task(old);
  assert.equal(oldResult.status, 1);
  assert.match(oldResult.stderr, /failure: setup/);
  assert.deepEqual(old.jobs(), []);
});

test("selected model comes from the real home", (t) => {
  const h = harness(t);
  fs.mkdirSync(path.join(h.home, ".cursor"));
  fs.writeFileSync(path.join(h.home, ".cursor", "cli-config.json"), JSON.stringify({ selectedModel: { modelId: "muse-spark-1.3-high" } }));
  assertDone(h.run(["task", "--", "inspect"]));
  const [record] = h.jobs();
  assert.equal(record.requestedModel, "muse-spark-1.3-high");
  assert.equal(record.resolvedModel, "muse-spark-1.3-high");
  assert.equal(record.billingPool, "api");
});

test("resume copies the parent chat and passes its session", (t) => {
  const h = harness(t, { CLAUDE_CODE_SESSION_ID: "test-session" });
  assertDone(task(h));
  const [parent] = h.jobs();
  const chatHash = createHash("md5").update(parent.cwd).digest("hex");
  const chat = path.join(parent.homeDir, ".cursor", "chats", chatHash, parent.sessionId);
  fs.mkdirSync(chat, { recursive: true });
  fs.writeFileSync(path.join(chat, "chat.json"), "parent");
  const result = task(h, ["--resume-last"], "continue");
  assertDone(result);
  const child = h.jobs().find((job) => job.id !== parent.id);
  assert.equal(child.resumedFromJobId, parent.id);
  assert.equal(fs.readFileSync(path.join(child.homeDir, ".cursor", "chats", chatHash, parent.sessionId, "chat.json"), "utf8"), "parent");
  assert.deepEqual(h.invocations().at(-1).argv.slice(-2), ["--resume", parent.sessionId]);
  assert.match(result.stdout, new RegExp(`resumed-from: ${parent.id}`));
});

test("resume rejects traversal ids before creating a job", (t) => {
  const h = harness(t);
  for (const sessionId of ["../..", "a/../../b"]) {
    const result = task(h, ["--resume", sessionId]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failure: input/);
    assert.doesNotMatch(result.stderr, /job:/);
  }
  assert.deepEqual(h.jobs(), []);
  assertDone(task(h));
  const job = h.jobs()[0];
  const state = path.join(h.data, "state", fs.readdirSync(path.join(h.data, "state"))[0], "jobs", `${job.id}.json`);
  fs.writeFileSync(state, JSON.stringify({ ...job, sessionId: "a/../../b" }));
  const result = task(h, ["--resume-last"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /failure: input/);
  assert.equal(h.jobs().length, 1);
});

test("project hook advisory is recorded and rendered", (t) => {
  const h = harness(t);
  fs.mkdirSync(path.join(h.cwd, ".cursor"));
  fs.writeFileSync(path.join(h.cwd, ".cursor", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ command: "echo unsafe" }] } }));
  const result = task(h);
  assertDone(result);
  assert.match(result.stdout, /warning: project hooks run outside the Cursor sandbox: \.cursor\/hooks\.json/);
  assert.deepEqual(h.jobs()[0].warnings, ["project hooks run outside the Cursor sandbox: .cursor/hooks.json"]);
});

test("status, result, history and acceptance expose lifecycle state", (t) => {
  const h = harness(t);
  assertDone(task(h));
  const [record] = h.jobs();
  assert.equal(JSON.parse(h.run(["status", record.id, "--json"]).stdout).id, record.id);
  assert.equal(JSON.parse(h.run(["result", record.id, "--wait", "--json"]).stdout).status, "done");
  const history = JSON.parse(h.run(["history", "--json"]).stdout);
  assert.equal(history.jobs[0].jobId, record.id);
  assert.equal(history.jobs[0].resumable, true);
  const accept = h.run(["record-acceptance", "--job-id", record.id, "--acceptance", "accepted", "--source", "main-loop", "--json"]);
  assert.equal(accept.status, 0, accept.stderr);
  assert.equal(JSON.parse(accept.stdout).semanticStatus, "accepted");
  assert.equal(h.jobs()[0].acceptanceSource, "main-loop");
});

test("cancel terminates a running fake Cursor job", async (t) => {
  const h = harness(t, { FAKE_CURSOR_SCENARIO: "hang" });
  const child = spawn(process.execPath, [companion, "task", "--model", "composer-2.5", "--", "wait"], { cwd: h.cwd, env: h.env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const deadline = Date.now() + 10000;
  let record;
  while (Date.now() < deadline) {
    record = h.jobs()[0];
    if (record?.cursorPid) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(record?.cursorPid, "Cursor child did not start");
  const cancelled = await new Promise((resolve) => {
    const canceller = spawn(process.execPath, [companion, "cancel", record.id, "--json"], { cwd: h.cwd, env: h.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    canceller.stdout.on("data", (chunk) => { stdout += chunk; });
    canceller.stderr.on("data", (chunk) => { stderr += chunk; });
    canceller.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => child.once("exit", resolve));
  }
  assert.equal(h.jobs()[0].status, "cancelled");
});

async function waitForLaunchedCursor(h) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const record = h.jobs()[0];
    const identityMatches = ["darwin", "freebsd", "openbsd"].includes(process.platform)
      ? record?.cursorPidIdentity?.commandHash === createHash("sha256").update(`node-${record?.cursorPid}`).digest("hex")
      : processIdentityMatches(record?.cursorPid, record?.cursorPidIdentity);
    if (record?.cursorPid && h.invocations().length && identityMatches) return record;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const record = h.jobs()[0];
  assert.fail(`Launched Cursor did not reach init with a matching identity: ${JSON.stringify({ status: record?.status, pid: record?.cursorPid, identity: record?.cursorPidIdentity, liveIdentity: getProcessIdentity(record?.cursorPid), invocations: h.invocations().length, errorMessage: record?.errorMessage })}`);
}

test("cross process cancel owns the exec launcher after init", async (t) => {
  const h = harness(t, { CURSOR_AGENT_BIN: launcher, FAKE_CURSOR_SCENARIO: "hang" });
  const launched = task(h, ["--background"]);
  assert.equal(launched.status, 0, launched.stdout + launched.stderr);
  const record = await waitForLaunchedCursor(h);
  const cancelled = h.run(["cancel", record.id, "--json"]);
  assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
  assert.equal(h.jobs()[0].status, "cancelled");
  assert.equal(h.jobs()[0].failureKind, "cancelled");
  assert.throws(() => process.kill(-record.cursorPid, 0), (error) => error.code === "ESRCH");
});

test("cross process cancel before init stops the job through its owned driver", async (t) => {
  const h = harness(t, { CURSOR_AGENT_BIN: launcher, FAKE_CURSOR_SCENARIO: "slow_init" });
  const launched = task(h, ["--background"]);
  assert.equal(launched.status, 0, launched.stdout + launched.stderr);
  const deadline = Date.now() + 15000;
  while (!h.jobs()[0]?.cursorPid && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  const record = h.jobs()[0];
  assert.ok(record?.cursorPid, "Cursor child did not start");
  const cancelled = h.run(["cancel", record.id, "--json"]);
  assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
  assert.equal(h.jobs()[0].status, "cancelled");
  assert.throws(() => process.kill(-record.cursorPid, 0), (error) => error.code === "ESRCH");
});

for (const [signal, exitCode] of [["SIGTERM", 143], ["SIGINT", 130]]) {
  test(`${signal} cancels a foreground exec launcher`, async (t) => {
    const h = harness(t, { CURSOR_AGENT_BIN: launcher, FAKE_CURSOR_SCENARIO: "hang" });
    const child = spawn(process.execPath, [companion, "task", "--model", "composer-2.5", "--", "wait"], { cwd: h.cwd, env: h.env, stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    const record = await waitForLaunchedCursor(h);
    child.kill(signal);
    const code = await new Promise((resolve) => child.once("close", resolve));
    assert.equal(code, exitCode);
    assert.equal(h.jobs()[0].status, "cancelled");
    assert.equal(h.jobs()[0].failureKind, "cancelled");
    assert.throws(() => process.kill(-record.cursorPid, 0), (error) => error.code === "ESRCH");
  });
}

test("models and setup report the fake CLI", (t) => {
  const h = harness(t);
  const models = JSON.parse(h.run(["models", "--json"]).stdout);
  assert.equal(models.engine, "cursor");
  assert.equal(models.source, "cli");
  assert.ok(models.models.some((model) => model.id === "composer-2.5"));
  const setup = JSON.parse(h.run(["setup", "--json"]).stdout);
  assert.equal(setup.cursor.version, "2026.10.01-e373342");
  assert.equal(setup.auth.authenticated, true);
  assert.ok(setup.catalogSize > 0);
  assert.equal(setup.sandboxHelper.present, false);
});

test("raw argument transport preserves brief and consumes its token", (t) => {
  const h = harness(t);
  const created = h.run(["transport-create"]);
  assert.equal(created.status, 0, created.stderr);
  const { file, token } = JSON.parse(created.stdout);
  fs.writeFileSync(file, "--model composer-2.5 -- cursor-role: diversity\nraw brief");
  const result = h.run(["task", "--raw-args-token", token]);
  assertDone(result);
  assert.equal(h.invocations()[0].stdin, "cursor-role: diversity\nraw brief");
  assert.equal(fs.existsSync(file), false);
});

function reviewWorkspace(h) {
  const git = (args, input = "") => {
    const result = spawnSync("git", args, { cwd: h.cwd, env: h.env, input, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q"]);
  const tree = git(["mktree"]);
  const commit = git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", tree, "-m", "seed"]);
  git(["update-ref", "refs/heads/main", commit]);
  fs.writeFileSync(path.join(h.cwd, "sample.txt"), "sample change\n");
  return { git, commit };
}

test("background task launches, reports running, and collects a result", async (t) => {
  const h = harness(t);
  const launched = task(h, ["--background"]);
  assert.equal(launched.status, 0, launched.stdout + launched.stderr);
  assert.match(launched.stdout, /state: running\n$/);
  const id = h.jobs()[0].id;
  const result = h.run(["result", id, "--wait"]);
  assertDone(result);
  assert.equal(h.jobs()[0].status, "done");
  assert.equal(h.jobs()[0].delivery, "manual");
  assert.ok(h.jobs()[0].deliveryCollectedAt);
});

test("background status and cancel terminate a hanging worker and Cursor group", async (t) => {
  const h = harness(t, { FAKE_CURSOR_SCENARIO: "hang" });
  const launched = task(h, ["--background"]);
  assert.equal(launched.status, 0, launched.stdout + launched.stderr);
  const id = h.jobs()[0].id;
  const deadline = Date.now() + 10000;
  while (!h.jobs()[0].cursorPid && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(h.jobs()[0].cursorPid);
  const status = h.run(["status", id, "--json"]);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.equal(JSON.parse(status.stdout).status, "running");
  const cancelled = h.run(["cancel", id, "--json"]);
  assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
  assert.equal(h.jobs()[0].status, "cancelled");
});

test("cancel waits for a process group member that ignores SIGTERM", async (t) => {
  const helperPidFile = path.join(os.tmpdir(), `cursor-resist-${process.pid}-${Date.now()}.pid`);
  t.after(() => { try { process.kill(Number(fs.readFileSync(helperPidFile, "utf8")), "SIGKILL"); } catch {} fs.rmSync(helperPidFile, { force: true }); });
  const h = harness(t, { FAKE_CURSOR_SCENARIO: "resistant_group", FAKE_CURSOR_HELPER_PID_FILE: helperPidFile });
  const launch = task(h, ["--background"]);
  assert.equal(launch.status, 0, launch.stdout + launch.stderr);
  const deadline = Date.now() + 10000;
  while ((!h.jobs()[0]?.cursorPid || !fs.existsSync(helperPidFile)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  const record = h.jobs()[0];
  assert.ok(record.cursorPid && fs.existsSync(helperPidFile));
  const cancelled = h.run(["cancel", record.id, "--json"]);
  assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
  assert.throws(() => process.kill(-record.cursorPid, 0), (error) => error.code === "ESRCH");
});

test("died detection cleans a surviving Cursor process group", async (t) => {
  const helperPidFile = path.join(os.tmpdir(), `cursor-died-${process.pid}-${Date.now()}.pid`);
  t.after(() => { try { process.kill(Number(fs.readFileSync(helperPidFile, "utf8")), "SIGKILL"); } catch {} fs.rmSync(helperPidFile, { force: true }); });
  const h = harness(t, { FAKE_CURSOR_SCENARIO: "resistant_group", FAKE_CURSOR_HELPER_PID_FILE: helperPidFile });
  const launch = task(h, ["--background"]);
  assert.equal(launch.status, 0, launch.stdout + launch.stderr);
  const deadline = Date.now() + 10000;
  while ((!h.jobs()[0]?.cursorPid || !fs.existsSync(helperPidFile)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  const record = h.jobs()[0];
  assert.ok(record.cursorPid && fs.existsSync(helperPidFile));
  t.after(() => { try { process.kill(-record.cursorPid, "SIGKILL"); } catch {} });
  process.kill(record.pid, "SIGKILL");
  const status = h.run(["status", record.id, "--json"]);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.equal(JSON.parse(status.stdout).status, "error");
  assert.equal(h.jobs()[0].failureKind, "died");
  assert.throws(() => process.kill(-record.cursorPid, 0), (error) => error.code === "ESRCH");
});

test("SIGTERM forwards cancellation from a foreground companion", async (t) => {
  const h = harness(t, { FAKE_CURSOR_SCENARIO: "hang" });
  const child = spawn(process.execPath, [companion, "task", "--model", "composer-2.5", "--", "wait"], { cwd: h.cwd, env: h.env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const deadline = Date.now() + 10000;
  while (!h.jobs()[0]?.cursorPid && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  const record = h.jobs()[0];
  assert.ok(record?.cursorPid);
  child.kill("SIGTERM");
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 143);
  assert.equal(h.jobs()[0].status, "cancelled");
  assert.equal(h.jobs()[0].failureKind, "cancelled");
  assert.throws(() => process.kill(-record.cursorPid, 0), (error) => error.code === "ESRCH");
});

test("failed result stdout write leaves background delivery uncollected", (t) => {
  const h = harness(t);
  const launched = task(h, ["--background"]);
  assert.equal(launched.status, 0, launched.stdout + launched.stderr);
  const id = h.jobs()[0].id;
  const script = "process.stdout.write = (_text, callback) => { callback(new Error('injected stdout failure')); return false; }; import(process.argv[1]);";
  const failed = spawnSync(process.execPath, ["-e", script, companion, "result", id, "--wait"], { cwd: h.cwd, env: h.env, encoding: "utf8", timeout: 30000 });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /injected stdout failure/);
  assert.equal(h.jobs()[0].deliveryCollectedAt, null);
});

test("review validates the first verdict object and uses consult tools", (t) => {
  const h = harness(t, { FAKE_CURSOR_SCENARIO: "review_ok" });
  reviewWorkspace(h);
  const result = h.run(["review", "--model", "composer-2.5", "--focus", "sample path", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review.verdict, "request_changes");
  assert.equal(payload.review.findings[0].severity, "high");
  assert.equal(h.jobs()[0].mode, "review");
  assert.match(h.invocations()[0].stdin, /User focus: sample path/);
  assert.match(h.invocations()[0].stdin, /Untracked files:\n- sample.txt/);
  assert.ok(h.invocations()[0].argv.includes("ask"));
  assert.doesNotMatch(h.invocations()[0].argv[h.invocations()[0].argv.indexOf("--allowed-tools") + 1], /edit_tool_call/);
});

test("review without a JSON verdict fails the job with its validation reason", (t) => {
  const h = harness(t, { FAKE_CURSOR_SCENARIO: "review_invalid" });
  reviewWorkspace(h);
  const result = h.run(["review", "--model", "composer-2.5"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /No JSON object found in the reply/);
  assert.match(result.stdout, /state: error\nfailure: error\n$/);
  assert.equal(h.jobs()[0].status, "error");
  assert.equal(h.jobs()[0].parseError, "No JSON object found in the reply.");
});

test("branch review includes the base range and local tracked changes", (t) => {
  const h = harness(t, { FAKE_CURSOR_SCENARIO: "review_ok" });
  const { git, commit } = reviewWorkspace(h);
  const blob = git(["hash-object", "-w", "--stdin"], "committed value\n");
  const tree = git(["mktree"], `100644 blob ${blob}\tsample.txt\n`);
  const head = git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", tree, "-p", commit, "-m", "change"]);
  git(["update-ref", "refs/heads/main", head]);
  git(["update-index", "--index-info"], `100644 ${blob}\tsample.txt\n`);
  const result = h.run(["review", "--scope", "branch", "--base", commit, "--model", "composer-2.5"]);
  assertDone(result);
  const prompt = h.invocations()[0].stdin;
  assert.match(prompt, new RegExp(`Target: changes since ${commit}`));
  assert.match(prompt, /\+committed value/);
  assert.match(prompt, /\+sample change/);
});

test("review consumes raw arguments and collects a background verdict", (t) => {
  const h = harness(t, { FAKE_CURSOR_SCENARIO: "review_ok" });
  reviewWorkspace(h);
  const created = JSON.parse(h.run(["transport-create"]).stdout);
  fs.writeFileSync(created.file, "--model composer-2.5 --focus 'raw focus' --background");
  const launched = h.run(["review", "--raw-args-token", created.token]);
  assert.equal(launched.status, 0, launched.stdout + launched.stderr);
  assert.equal(fs.existsSync(created.file), false);
  const id = h.jobs()[0].id;
  const collected = h.run(["result", id, "--wait"]);
  assertDone(collected);
  assert.match(collected.stdout, /Verdict: request_changes/);
  assert.match(h.invocations()[0].stdin, /User focus: raw focus/);
});
