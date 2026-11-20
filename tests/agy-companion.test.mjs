import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OPERATING_LIMITS_NOTE } from "../plugins/agy/scripts/lib/agy-exec.mjs";
import { verifyJobWatch } from "./lib/job-watch-harness.mjs";
import { executionTimeoutProbe } from "./lib/execution-budget.mjs";

verifyJobWatch("agy");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companion = path.join(root, "plugins/agy/scripts/agy-companion.mjs");
const fake = path.join(root, "tests/fake-agy");

function harness(t, scenario = "success", extraEnv = {}) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-test-")));
  const home = path.join(temp, "home");
  const cwd = path.join(temp, "workspace");
  const data = path.join(temp, "data");
  const bin = path.join(temp, "agy");
  const log = path.join(temp, "acp.json");
  const launch = path.join(temp, "launch.json");
  const identityBin = path.join(temp, "identity-bin");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  fs.mkdirSync(data);
  fs.mkdirSync(identityBin);
  if (["darwin", "freebsd", "openbsd"].includes(process.platform)) {
    fs.writeFileSync(path.join(identityBin, "ps"), "#!/bin/sh\npid=\nfield=\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = \"-p\" ]; then pid=\"$2\"; shift 2; elif [ \"$1\" = \"-o\" ]; then field=\"$2\"; shift 2; else shift; fi\ndone\nif [ -n \"$pid\" ] && kill -0 \"$pid\" 2>/dev/null; then printf 'process-%s\\n' \"$pid\"; else exit 1; fi\n");
    fs.writeFileSync(path.join(identityBin, "sysctl"), "#!/bin/sh\nprintf '{ sec = 1, usec = 0 }\\n'\n");
    for (const name of ["ps", "sysctl"]) fs.chmodSync(path.join(identityBin, name), 0o755);
  }
  const review = { verdict: "request_changes", summary: "Needs a fix.", findings: [{ severity: "high", file: "sample.txt", line: 1, title: "Bad value", body: "Use the expected value." }] };
  const code = `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
process.env.FAKE_AGY_SCENARIO = ${JSON.stringify(scenario === "review_ok" || scenario === "review_invalid" ? "success" : scenario)};
process.env.FAKE_AGY_LOG = ${JSON.stringify(log)};
${Object.entries(extraEnv).filter(([key]) => key.startsWith("FAKE_AGY_")).map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`).join("\n")}
if (args[0] === "acp") {
  fs.writeFileSync(${JSON.stringify(launch)}, JSON.stringify({ env: process.env, config: JSON.parse(fs.readFileSync(args[args.indexOf("--gemini-dir") + 1] + "/agy/settings.json", "utf8")) }));
  ${scenario === "review_ok" || scenario === "review_invalid" ? `const original = fs.writeSync;
  fs.writeSync = (fd, data, ...rest) => {
    if (fd === 1 && typeof data === "string" && data.includes("agent_message_chunk")) {
      try {
        const event = JSON.parse(data);
        if (event.params?.update?.sessionUpdate === "agent_message_chunk") {
          event.params.update.content.text = event.params.update.content.text === "fake " ? ${JSON.stringify(scenario === "review_ok" ? JSON.stringify(review) : "no verdict")} : "";
          data = JSON.stringify(event) + "\\n";
        }
      } catch {}
    }
    return original(fd, data, ...rest);
  };` : ""}
}
await import(${JSON.stringify(fileURLToPath(new URL("./fake-agy", import.meta.url)))});
`;
  fs.writeFileSync(bin, code, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${identityBin}${path.delimiter}${process.env.PATH}`, AGY_BIN: bin, AGY_COMPANION_DATA: data,
    AGY_COMPANION_WAIT_POLL_MS: "20", ...extraEnv };
  const run = (args, input = "") => spawnSync(process.execPath, [companion, ...args], { cwd, env, input, encoding: "utf8", timeout: 30000 });
  const jobs = () => {
    const state = path.join(data, "state");
    if (!fs.existsSync(state)) return [];
    return fs.readdirSync(state).flatMap((workspace) => {
      const dir = path.join(state, workspace, "jobs");
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))) : [];
    });
  };
  const messages = () => JSON.parse(fs.readFileSync(log, "utf8")).messages;
  const launched = () => JSON.parse(fs.readFileSync(launch, "utf8"));
  t.after(() => {
    for (const record of jobs()) {
      if (record.status === "running") {
        for (const pid of [record.agyPid, record.pid]) {
          if (pid) try { process.kill(-pid, "SIGKILL"); } catch {}
        }
      }
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { temp, home, cwd, data, bin, env, log, run, jobs, messages, launched };
}

function task(h, args = [], brief = "inspect") {
  return h.run(["task", "--model", "gemini-4-neon", ...args, "--", brief]);
}

function assertDone(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /state: done\n$/);
}

function reviewWorkspace(h) {
  const git = (args, input) => {
    const result = spawnSync("git", args, { cwd: h.cwd, encoding: "utf8", input });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q", "--initial-branch=main"]);
  const tree = git(["mktree"]);
  const commit = git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", tree, "-m", "seed"]);
  git(["update-ref", "refs/heads/main", commit]);
  fs.writeFileSync(path.join(h.cwd, "sample.txt"), "sample change\n");
}

test("consult records Antigravity fields, subscription pool, and contiguous footers", (t) => {
  const h = harness(t);
  const result = task(h, [], "agy-role: independence | acceptance: cited lines\ninspect");
  assertDone(result);
  const [record] = h.jobs();
  assert.equal(record.engine, "agy");
  assert.equal(record.mode, "consult");
  assert.equal(record.role, "independence");
  assert.equal(record.agyVersion, "1.5.12");
  assert.equal(record.agyBuildPath, fs.realpathSync(h.bin));
  assert.equal(record.agentVersion, "1.5.12");
  assert.equal(record.resolvedModel, "gemini-4-neon");
  assert.equal(record.resolvedEffort, "high");
  assert.equal(record.stopReason, "end_turn");
  assert.equal(record.billingPool, "subscription");
  assert.equal(record.effortApplied, false);
  assert.equal(record.permissionsAllowed, 0);
  assert.equal(record.permissionsRejected, 0);
  assert.equal(fs.existsSync(record.configDir), false);
  assert.match(result.stdout, /agy-session: [a-f0-9-]{36}\njob: [a-f0-9]{32}\nsandbox: /);
  assert.match(result.stdout, /delivery: foreground\nsemantic: unverified\nstate: done\n$/);
  assert.deepEqual(h.messages().map((message) => message.method), ["initialize", "session/new", "session/set_mode", "session/set_config_option", "session/set_config_option", "session/prompt"]);
});

test("the operating limits note precedes the brief in consult and burst", (t) => {
  const h = harness(t);
  assertDone(task(h, [], "consult brief"));
  assert.equal(h.messages().at(-1).params.prompt[0].text, `${OPERATING_LIMITS_NOTE}\n\nconsult brief`);
  assertDone(task(h, ["--write"], "burst brief"));
  assert.equal(h.messages().at(-1).params.prompt[0].text, `${OPERATING_LIMITS_NOTE}\n\nburst brief`);
});

test("write selects accept-edits, retains HOME, resets settings, and pins effort", (t) => {
  const h = harness(t, "write_tool", { GEMINI_API_KEY: "drop", GOOGLE_API_KEY: "drop", AGY_MODEL: "drop" });
  assertDone(task(h, ["--write", "--effort", "xhigh"], "lane: agy burst\nimplement"));
  const [record] = h.jobs();
  const { env, config } = h.launched();
  assert.equal(record.role, "burst");
  assert.equal(record.effortApplied, true);
  assert.equal(record.resolvedEffort, "xhigh");
  assert.equal(env.HOME, h.home);
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.GOOGLE_API_KEY, undefined);
  assert.equal(env.AGY_MODEL, undefined);
  assert.equal(env.XDG_CONFIG_HOME, undefined);
  assert.deepEqual(config, {});
  assert.equal(h.messages()[2].params.modeId, "accept-edits");
});

test("default model is neon, effort can be requested alone, and suffix effort yields to explicit effort", (t) => {
  const h = harness(t);
  assertDone(h.run(["task", "--effort", "medium", "--", "inspect"]));
  assert.equal(h.jobs()[0].requestedModel, null);
  assert.equal(h.jobs()[0].resolvedModel, "gemini-4-neon");
  assert.equal(h.jobs()[0].resolvedEffort, "medium");
  assertDone(h.run(["task", "--model", "gemini-4-argon-xhigh", "--", "inspect"]));
  let record = h.jobs().find((job) => job.requestedModel === "gemini-4-argon-xhigh");
  assert.equal(record.resolvedModel, "gemini-4-argon");
  assert.equal(record.resolvedEffort, "xhigh");
  assert.equal(record.requestedEffort, "xhigh");
  assert.equal(record.effortApplied, true);
  assertDone(h.run(["task", "--model", "gemini-4-hydrogen-low", "--effort", "default", "--", "inspect"]));
  record = h.jobs().find((job) => job.requestedModel === "gemini-4-hydrogen-low");
  assert.equal(record.resolvedEffort, "high");
  assert.equal(record.effortApplied, false);
});

test("unsupported families fail before job creation, unoffered Google models fail setup", (t) => {
  const h = harness(t);
  for (const model of ["claude-opus-4.8", "gpt-6", "adaptive", "gemini-pro-orchestrator-test"]) {
    const result = h.run(["task", "--model", model, "--", "inspect"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failure: input/);
  }
  assert.deepEqual(h.jobs(), []);
  const unavailable = h.run(["task", "--model", "gemini-missing", "--", "inspect"]);
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stdout, /Account models: gemini-4-neon/);
  assert.match(unavailable.stdout, /failure: setup\n$/);
});

test("workspace directories and late close render warnings with successful outcome", (t) => {
  const h = harness(t, "late_close", { AGY_COMPANION_EXIT_GRACE_MS: "30" });
  fs.mkdirSync(path.join(h.cwd, ".gemini"));
  fs.mkdirSync(path.join(h.cwd, ".agents"));
  const result = task(h);
  assertDone(result);
  assert.deepEqual(h.jobs()[0].warnings, [`workspace instructions may affect Antigravity: ${path.join(h.cwd, ".gemini")}`, `workspace instructions may affect Antigravity: ${path.join(h.cwd, ".agents")}`, "late_close"]);
  assert.match(result.stdout, /warning: late_close\nstate: done\n$/);
});

test("refused permission requests render a warning with the successful outcome", (t) => {
  const h = harness(t, "permission_write");
  const result = task(h);
  assertDone(result);
  assert.equal(h.jobs()[0].permissionsRejected, 1);
  assert.match(result.stdout, /warning: permission_refused: 1 request\(s\) refused \(run_command: touch outside\), which ends the Antigravity turn early\nstate: done\n$/);
});

test("refused permission requests without a result persist and render a permission failure", (t) => {
  for (const [scenario, args] of [["permission_empty", []], ["permission_whitespace", ["--json"]]]) {
    const h = harness(t, scenario);
    const result = task(h, args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const record = h.jobs()[0];
    assert.equal(record.status, "error");
    assert.equal(record.exitCode, 0);
    assert.equal(record.stopReason, "end_turn");
    assert.equal(record.permissionsRejected, 1);
    assert.equal(record.failureKind, "permission");
    assert.equal(record.errorMessage, "Antigravity refused 1 permission request(s) (read_file: git status --short) and returned no result, so the turn ended early.");
    if (args.length) {
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.failureKind, "permission");
      assert.equal(payload.permissionsRejected, 1);
    } else {
      assert.match(result.stdout + result.stderr, /state: error\nfailure: permission\n$/);
      assert.match(result.stdout + result.stderr, /Antigravity refused 1 permission request\(s\) \(read_file: git status --short\) and returned no result/);
    }
  }
});

test("refused permission details redact credential shaped values", (t) => {
  const secret = "s3cr3t-token-value";
  const warned = harness(t, "permission_write", { FAKE_AGY_COMMAND: `curl -H 'Authorization: Bearer ${secret}' --api-key ${secret}`, FAKE_AGY_PERMISSION_TOOL: "run_command" });
  const warnedResult = task(warned);
  assertDone(warnedResult);
  assert.match(warnedResult.stdout, /run_command: curl -H 'Authorization: Bearer \[redacted\]' --api-key \[redacted\]/);
  assert.ok(!warnedResult.stdout.includes(secret));
  const failed = harness(t, "permission_empty", { FAKE_AGY_COMMAND: `env TOKEN=${secret} curl`, FAKE_AGY_PERMISSION_TOOL: "run_command" });
  const failedResult = task(failed);
  assert.equal(failedResult.status, 1, failedResult.stdout + failedResult.stderr);
  const record = failed.jobs()[0];
  assert.equal(record.failureKind, "permission");
  assert.equal(record.errorMessage, "Antigravity refused 1 permission request(s) (run_command: env TOKEN=[redacted] curl) and returned no result, so the turn ended early.");
  assert.ok(!(failedResult.stdout + failedResult.stderr + JSON.stringify(record)).includes(secret));
});

test("resumes only same mode and workspace, checks replay tools, excludes replay text, and fresh ignores continuity", (t) => {
  const h = harness(t, "success", { FAKE_AGY_CURRENT_MODEL: "gemini-4-argon" });
  assertDone(task(h, ["--model", "gemini-4-argon"]));
  const parent = h.jobs()[0];
  const resumed = h.run(["task", "--resume", parent.sessionId, "--", "continue"]);
  assertDone(resumed);
  assert.doesNotMatch(resumed.stdout, /old conversation/);
  assert.match(resumed.stdout, new RegExp(`resumed-from: ${parent.id}`));
  assert.equal(h.jobs().find((job) => job.id !== parent.id).resolvedModel, "gemini-4-argon");
  assert.equal(h.messages()[1].method, "session/load");
  assertDone(h.run(["task", "--resume-last", "--", "continue"]));
  assert.equal(h.messages()[1].method, "session/load");
  assertDone(h.run(["task", "--fresh", "--", "inspect"]));
  assert.equal(h.messages()[1].method, "session/new");
  const mismatch = h.run(["task", "--write", "--resume", parent.sessionId, "--", "continue"]);
  assert.match(mismatch.stderr, /failure: input/);
  const elsewhere = path.join(h.temp, "elsewhere");
  fs.mkdirSync(elsewhere);
  assert.match(h.run(["task", "--cwd", elsewhere, "--resume", parent.sessionId, "--", "continue"]).stderr, /failure: input/);
});

test("resume skips policy failures, refuses explicit policy sessions, and reports them as not resumable", (t) => {
  const h = harness(t);
  assertDone(task(h));
  const parent = h.jobs()[0];
  const forbidden = harness(t, "forbidden_tool", { FAKE_AGY_SESSION_ID: "b0123456-789a-4bcd-8ef0-123456789abc" });
  h.env.AGY_BIN = forbidden.bin;
  const failed = task(h);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  const policy = h.jobs().find((job) => job.id !== parent.id);
  assert.equal(policy.failureKind, "policy");
  assert.notEqual(policy.sessionId, parent.sessionId);
  h.env.AGY_BIN = h.bin;
  const explicit = h.run(["task", "--resume", policy.sessionId, "--", "continue"]);
  assert.equal(explicit.status, 1, explicit.stdout + explicit.stderr);
  assert.match(explicit.stderr, /No finished consult Antigravity task owns session/);
  assert.match(explicit.stderr, /failure: input/);
  assert.equal(h.jobs().length, 2);
  assertDone(h.run(["task", "--resume-last", "--", "continue"]));
  assert.equal(h.jobs().find((job) => job.resumedFromJobId).resumedFromJobId, parent.id);
  assert.equal(JSON.parse(h.run(["history", "--json"]).stdout).jobs.find((job) => job.jobId === policy.id).resumable, false);
});

test("a linked private Gemini root fails setup before launching ACP", (t) => {
  const h = harness(t);
  const outside = path.join(h.home, ".gemini");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "sentinel"), "user original");
  fs.symlinkSync(outside, path.join(h.data, "gemini"));
  const result = task(h);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(h.jobs()[0].failureKind, "setup");
  assert.match(result.stdout, /Refusing symbolic link/);
  assert.equal(fs.existsSync(h.log), false);
  assert.deepEqual(fs.readdirSync(outside), ["sentinel"]);
  assert.equal(fs.readFileSync(path.join(outside, "sentinel"), "utf8"), "user original");
});

test("review renders a valid verdict and invalid output fails", (t) => {
  const good = harness(t, "review_ok");
  reviewWorkspace(good);
  const result = good.run(["review", "--focus", "sample path", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review.verdict, "request_changes");
  assert.equal(good.jobs()[0].mode, "review");
  assert.equal(good.messages()[2].params.modeId, "default");
  assert.match(good.messages().at(-1).params.prompt[0].text, /User focus: sample path/);
  const bad = harness(t, "review_invalid");
  reviewWorkspace(bad);
  const invalid = bad.run(["review"]);
  assert.equal(invalid.status, 1);
  assert.equal(bad.jobs()[0].parseError, "No JSON object found in the reply.");
});

test("background collection, history, status, and semantic acceptance preserve dimensions", (t) => {
  const h = harness(t);
  const launch = task(h, ["--background", "--json"]);
  assert.equal(launch.status, 0, launch.stdout + launch.stderr);
  const receipt = JSON.parse(launch.stdout);
  assert.equal(receipt.status, "running");
  const id = h.jobs()[0].id;
  assert.ok(launch.stdout.includes(`watch --job ${id}`));
  assertDone(h.run(["result", id, "--wait"]));
  assert.equal(h.jobs()[0].delivery, "manual");
  assert.ok(h.jobs()[0].deliveryCollectedAt);
  assert.equal(JSON.parse(h.run(["status", id, "--json"]).stdout).status, "done");
  assert.equal(JSON.parse(h.run(["history", "--json"]).stdout).jobs[0].jobId, id);
  const acceptance = h.run(["record-acceptance", "--job-id", id, "--acceptance", "accepted", "--json"]);
  assert.equal(acceptance.status, 0, acceptance.stdout + acceptance.stderr);
  assert.equal(JSON.parse(acceptance.stdout).semanticStatus, "accepted");
});

test("cancellation terminates an owned background process", async (t) => {
  const h = harness(t, "hang");
  const launch = task(h, ["--background"]);
  assert.equal(launch.status, 0, launch.stdout + launch.stderr);
  const id = h.jobs()[0].id;
  const deadline = Date.now() + 10000;
  while (!h.jobs()[0].agyPid && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(h.jobs()[0].agyPid);
  const cancelled = h.run(["cancel", id, "--json"]);
  assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
  assert.equal(h.jobs()[0].status, "cancelled");
});

test("raw transport consumes staged input without interpreting shell syntax", (t) => {
  const h = harness(t);
  const created = JSON.parse(h.run(["transport-create"]).stdout);
  const brief = "raw private `pwd` $(touch nope)\nbrief";
  fs.writeFileSync(created.file, `--model gemini-4-neon -- ${brief}`);
  assertDone(h.run(["task", "--raw-args-token", created.token]));
  assert.equal(fs.existsSync(created.file), false);
  assert.equal(h.messages().at(-1).params.prompt[0].text, `${OPERATING_LIMITS_NOTE}\n\n${brief}`);
  assert.equal(fs.existsSync(path.join(h.cwd, "nope")), false);
});

test("a timed out Antigravity task resumes its session for wind down", (t) => {
  const h = harness(t, "wind_down", { AGY_COMPANION_TIMEOUT_MS: "1500", AGY_COMPANION_EXIT_GRACE_MS: "100" });
  const probe = executionTimeoutProbe(h.temp, 1500);
  Object.assign(h.env, probe.env);
  const result = task(h);
  assertDone(result);
  assert.deepEqual(probe.timeouts(), [1500, 240000]);
  assert.equal(h.jobs().length, 1);
  const [record] = h.jobs();
  assert.deepEqual(record.salvage, { attempted: true, outcome: "done", originalPid: record.salvage.originalPid,
    resumePid: record.salvage.resumePid, resumePidIdentity: record.salvage.resumePidIdentity });
  assert.ok(Number.isInteger(record.salvage.originalPid) && record.salvage.originalPid > 1);
  assert.ok(Number.isInteger(record.salvage.resumePid) && record.salvage.resumePid > 1);
  assert.notEqual(record.salvage.resumePid, record.salvage.originalPid);
  assert.ok(Object.hasOwn(record.salvage, "resumePidIdentity"));
  assert.equal(record.semanticFailureKind, "timeout_salvaged");
  assert.ok(h.messages().some((message) => message.method === "session/load" && message.params.sessionId === record.sessionId));
  assert.match(h.messages().find((message) => message.method === "session/prompt").params.prompt[0].text, /\n\nYour time budget is exhausted\. Stop exploring\./);
  assert.match(result.stdout, /warning: timeout_salvaged\nstate: done\n$/);
});

test("execution budgets follow launch transport without relying on process enumeration", async (t) => {
  for (const [shell, manual, override, expected] of [[false, false, "", 540000], [true, false, "", 900000], [true, true, "", 540000], [true, false, "2400", 2400], [true, false, "invalid", 900000]]) {
    const h = harness(t, "success", { AGY_COMPANION_TIMEOUT_MS: override });
    const timeouts = path.join(h.temp, "timeouts");
    const preload = path.join(h.temp, "timers.cjs");
    fs.writeFileSync(timeouts, "");
    fs.writeFileSync(preload, `const fs = require("node:fs"); const original = globalThis.setTimeout; globalThis.setTimeout = (callback, delay, ...args) => { if (String(callback).includes("() => handleRunTimeout(run)")) fs.appendFileSync(${JSON.stringify(timeouts)}, String(delay) + "\\n"); return original(callback, delay, ...args); };`);
    h.env.NODE_OPTIONS = `--require=${preload}`;
    const staged = JSON.parse(h.run(["transport-create"]).stdout);
    fs.writeFileSync(staged.file, `${manual ? "--background " : ""}--model gemini-4-neon -- inspect`);
    const launched = h.run(["task", ...(shell ? ["--transport-background-shell"] : []), "--raw-args-token", staged.token]);
    assert.equal(launched.status, 0, launched.stdout + launched.stderr);
    if (manual) assertDone(h.run(["result", h.jobs()[0].id, "--wait"]));
    assert.deepEqual(fs.readFileSync(timeouts, "utf8").trim().split("\n").filter(Boolean).map(Number), [expected]);
    assert.equal(h.jobs()[0].request.backgroundShellBudget, shell && !manual);
  }
});

for (const [scenario, kind] of [["auth_required", "auth"], ["quota", "quota"], ["capacity", "rate_limited"], ["forbidden_tool", "policy"], ["bypass_update", "policy"]]) {
  test(`${scenario} persists ${kind} and the subscription pool`, (t) => {
    const h = harness(t, scenario);
    const result = task(h);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`failure: ${kind}\\n$`));
    assert.equal(h.jobs()[0].failureKind, kind);
    assert.equal(h.jobs()[0].billingPool, "subscription");
  });
}
for (const [scenario, allowed, rejected] of [["permission", 1, 0], ["permission_read", 0, 1], ["permission_write", 0, 1]]) {
  test(`${scenario} persists permission counts in the job and JSON`, (t) => {
    const h = harness(t, scenario);
    const result = task(h, ["--json"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(h.jobs()[0].permissionsAllowed, allowed);
    assert.equal(h.jobs()[0].permissionsRejected, rejected);
    assert.equal(JSON.parse(result.stdout).permissionsAllowed, allowed);
    assert.equal(JSON.parse(result.stdout).permissionsRejected, rejected);
  });
}

test("models uses session discovery and one hour cache; setup checks fresh authentication and overage", (t) => {
  const h = harness(t);
  const first = h.run(["models", "--json"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const report = JSON.parse(first.stdout);
  assert.equal(report.engine, "agy");
  assert.equal(report.source, "cli");
  assert.deepEqual(report.models.map((model) => model.id), ["gemini-4-neon", "gemini-4-argon", "gemini-4-hydrogen", "gemini-3.8-flash"]);
  assert.deepEqual(h.messages().map((message) => message.method), ["initialize", "session/new"]);
  assert.equal(JSON.parse(h.run(["models", "--json"]).stdout).source, "cache");
  assert.equal(JSON.parse(h.run(["models", "--refresh", "--json"]).stdout).source, "cli");
  fs.mkdirSync(path.join(h.cwd, ".gemini"));
  const setup = h.run(["setup", "--json"]);
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  const health = JSON.parse(setup.stdout);
  assert.equal(health.ready, true);
  assert.equal(health.agy.buildPath, fs.realpathSync(h.bin));
  assert.equal(health.agy.version, "1.5.12");
  assert.equal(health.auth.authenticated, true);
  assert.equal(health.compatibility, "tested");
  assert.deepEqual(health.projectConfigFiles, [path.join(h.cwd, ".gemini")]);
  assert.match(health.nextSteps.join(" "), /overage to never/);
  const text = h.run(["setup"]).stdout;
  assert.match(text, /warning: workspace instructions/);
  assert.match(text, /Google models: gemini-4-neon, gemini-4-argon/);
  assert.match(text, /1.5 to before 1.6/);
});

test("setup reports auth failures, and models produces a typed failure", (t) => {
  const h = harness(t, "session_auth");
  const report = JSON.parse(h.run(["setup", "--json"]).stdout);
  assert.equal(report.ready, false);
  assert.equal(report.auth.authenticated, false);
  assert.ok(report.nextSteps.some((step) => /cannot unlock the login keychain/.test(step)));
  const models = h.run(["models", "--json"]);
  assert.equal(models.status, 1, models.stdout + models.stderr);
  assert.equal(JSON.parse(models.stdout).failureKind, "auth");
});

test("version interval rejects older builds and runs newer builds", (t) => {
  for (const [version, expected] of [["1.4.99", "older than the tested interval"], ["1.6.0", "newer than the tested interval"]]) {
    const h = harness(t, "success", { FAKE_AGY_VERSION: version });
    const report = JSON.parse(h.run(["setup", "--json"]).stdout);
    assert.equal(report.compatibility, expected);
    const result = task(h);
    if (version === "1.4.99") {
      assert.match(result.stderr, /failure: setup/);
      assert.deepEqual(h.jobs(), []);
    } else assertDone(result);
  }
});

test("SessionEnd cleans only its session's jobs and staged transports", async (t) => {
  const h = harness(t, "hang", { CLAUDE_CODE_SESSION_ID: "agy-owner" });
  assert.equal(task(h, ["--background"]).status, 0);
  const owner = h.jobs()[0];
  const deadline = Date.now() + 10000;
  while (!h.jobs()[0].agyPid && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(h.jobs()[0].agyPid);
  const staged = JSON.parse(h.run(["transport-create"]).stdout);
  h.env.CLAUDE_CODE_SESSION_ID = "agy-other";
  const otherTransport = JSON.parse(h.run(["transport-create"]).stdout);
  const ended = spawnSync(process.execPath, [path.join(root, "plugins/agy/scripts/session-end-hook.mjs")], {
    cwd: h.cwd, env: h.env, input: JSON.stringify({ session_id: "agy-owner" }), encoding: "utf8", timeout: 15000
  });
  assert.equal(ended.status, 0, ended.stdout + ended.stderr);
  assert.equal(h.jobs().find((job) => job.id === owner.id).status, "cancelled");
  assert.equal(fs.existsSync(staged.file), false);
  assert.equal(fs.existsSync(otherTransport.file), true);
  assert.equal(h.run(["transport-discard", "--raw-args-token", otherTransport.token]).status, 0);
});
