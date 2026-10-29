import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companion = path.join(root, "plugins/devin/scripts/devin-companion.mjs");
const fake = path.join(root, "tests/fake-devin");

function harness(t, scenario = "success", extraEnv = {}) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "devin-companion-test-")));
  const home = path.join(temp, "home");
  const cwd = path.join(temp, "workspace");
  const data = path.join(temp, "data");
  const bin = path.join(temp, "devin");
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
  const catalog = { families: [
    { family_label: "SWE-2", family_uid: "swe-2", slug: "swe-2", aliases: ["swe"], variants: [{ model_uid: "swe-2-high", label: "SWE-2 High" }] },
    { family_label: "Kimi K3", family_uid: "kimi-k3", slug: "kimi-k3", aliases: [], variants: [{ model_uid: "kimi-k3-high", label: "Kimi K3" }] },
    { family_label: "Unavailable", family_uid: "unavailable", slug: "unavailable", aliases: [], variants: [{ model_uid: "unavailable-high", label: "Unavailable High" }] },
    { family_label: "Adaptive", family_uid: "Adaptive", slug: "adaptive", aliases: [], variants: [{ model_uid: "adaptive", label: "Adaptive" }] },
    { family_label: "Fusion", family_uid: "fusion", slug: "fusion", aliases: [], variants: [{ model_uid: "fusion-swe-2-medium", label: "Fusion" }] }
  ] };
  const review = { verdict: "request_changes", summary: "Needs a fix.", findings: [{ severity: "high", file: "sample.txt", line: 1, title: "Bad value", body: "Use the expected value." }] };
  const code = `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args.join(" ") === "models list --format json") { process.stdout.write(${JSON.stringify(JSON.stringify(catalog) + "\n")}); process.exit(0); }
if (args.join(" ") === "auth status") { process.stdout.write("Authenticated\\nPlan: Pro\\n"); process.exit(0); }
process.env.FAKE_DEVIN_SCENARIO = ${JSON.stringify(scenario === "review_ok" || scenario === "review_invalid" ? "success" : scenario)};
process.env.FAKE_DEVIN_LOG = ${JSON.stringify(log)};
${extraEnv.FAKE_DEVIN_REJECT_CONFIG ? `process.env.FAKE_DEVIN_REJECT_CONFIG = ${JSON.stringify(extraEnv.FAKE_DEVIN_REJECT_CONFIG)};` : ""}
${extraEnv.FAKE_DEVIN_MISMATCH_CONFIG ? `process.env.FAKE_DEVIN_MISMATCH_CONFIG = ${JSON.stringify(extraEnv.FAKE_DEVIN_MISMATCH_CONFIG)};` : ""}
${extraEnv.FAKE_DEVIN_MODEL_LABEL ? `process.env.FAKE_DEVIN_MODEL_LABEL = ${JSON.stringify(extraEnv.FAKE_DEVIN_MODEL_LABEL)};` : ""}
if (args[0] === "acp") {
  fs.writeFileSync(${JSON.stringify(launch)}, JSON.stringify({ env: process.env, config: JSON.parse(fs.readFileSync(process.env.XDG_CONFIG_HOME + "/devin/config.json", "utf8")) }));
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
await import(${JSON.stringify(fileURLToPath(new URL("./fake-devin", import.meta.url)))});
`;
  fs.writeFileSync(bin, code, { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${identityBin}${path.delimiter}${process.env.PATH}`, DEVIN_BIN: bin, DEVIN_COMPANION_DATA: data,
    DEVIN_COMPANION_WAIT_POLL_MS: "20", ...extraEnv };
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
        for (const pid of [record.devinPid, record.pid]) {
          if (pid) try { process.kill(-pid, "SIGKILL"); } catch {}
        }
      }
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { temp, home, cwd, data, bin, env, run, jobs, messages, launched };
}

function task(h, args = [], brief = "inspect") {
  return h.run(["task", "--model", "swe-2", ...args, "--", brief]);
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

test("consult records ACP fields and a contiguous Devin footer", (t) => {
  const h = harness(t);
  const result = task(h, [], "devin-role: diversity | acceptance: cited lines\ninspect");
  assertDone(result);
  const [record] = h.jobs();
  assert.equal(record.engine, "devin");
  assert.equal(record.mode, "consult");
  assert.equal(record.role, "diversity");
  assert.equal(record.sessionId, "artistic-breeze");
  assert.equal(record.requestId, "8f3a-fake-request");
  assert.equal(record.devinVersion, "3000.11.228");
  assert.equal(record.devinBuildPath, fs.realpathSync(h.bin));
  assert.equal(record.resolvedModel, "swe-2-high");
  assert.equal(record.observedModel, "SWE-2 High");
  assert.equal(record.stopCause, "complete");
  assert.deepEqual(record.usage, { totalTokens: 11914, inputTokens: 11875, outputTokens: 39, cachedReadTokens: 11552 });
  assert.equal(record.billingPool, "first-party");
  assert.equal(record.effortApplied, false);
  assert.equal(fs.existsSync(record.configDir), false);
  assert.match(result.stdout, /devin-session: artistic-breeze\njob: [a-f0-9]{32}\nsandbox: /);
  assert.deepEqual(record.warnings, []);
  assert.match(result.stdout, /delivery: foreground\nsemantic: unverified\nstate: done\n$/);
  assert.deepEqual(h.messages().map((message) => message.method).filter(Boolean), ["initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/set_config_option", "session/prompt"]);
  assert.equal(h.messages().at(-1).params.prompt[0].text, "devin-role: diversity | acceptance: cited lines\ninspect");
});

test("a turn served by another model renders model_mismatch", (t) => {
  const h = harness(t, "success", { FAKE_DEVIN_MODEL_LABEL: "SWE-1.6 Slow" });
  const result = task(h);
  assertDone(result);
  const [record] = h.jobs();
  assert.equal(record.observedModel, "SWE-1.6 Slow");
  assert.deepEqual(record.warnings, ["model_mismatch"]);
  assert.match(result.stdout, /warning: model_mismatch\nstate: done\n$/);
});

test("write mode uses a private home, sandbox and scoped config", (t) => {
  const h = harness(t);
  assertDone(task(h, ["--write", "--effort", "max"], "lane: devin burst\nimplement"));
  const [record] = h.jobs();
  const { env, config } = h.launched();
  assert.equal(record.mode, "write");
  assert.equal(record.role, "burst");
  assert.equal(record.effortApplied, true);
  assert.equal(env.HOME, path.join(h.data, "home"));
  assert.equal(env.XDG_CONFIG_HOME, record.configDir);
  assert.equal(env.DEVIN_SANDBOX, "true");
  assert.equal(env.DEVIN_MODEL, undefined);
  assert.deepEqual(config.permissions.allow, [`Write(${h.cwd}/**)`]);
  assert.equal(config.permissions.deny.includes("exec"), false);
  assert.ok(h.messages().some((message) => message.method === "session/set_config_option" && message.params.configId === "thought_level" && message.params.value === "max"));
});

test("project configuration is reported and a late close keeps the completed result", (t) => {
  const h = harness(t, "late_close", { DEVIN_COMPANION_EXIT_GRACE_MS: "30" });
  fs.mkdirSync(path.join(h.cwd, ".devin"));
  const configFile = path.join(h.cwd, ".devin", "config.json");
  fs.writeFileSync(configFile, "{}");
  const result = task(h);
  assertDone(result);
  const [record] = h.jobs();
  assert.deepEqual(record.warnings, [`project configuration may affect Devin permissions: ${configFile}`, "late_close"]);
  assert.match(result.stdout, /warning: late_close\nstate: done\n$/);
  assert.equal(fs.existsSync(record.configDir), false);
});

test("default model leaves selection unset and rejects nondefault effort", (t) => {
  const h = harness(t);
  assertDone(h.run(["task", "--", "inspect"]));
  assert.equal(h.jobs()[0].requestedModel, null);
  assert.equal(h.jobs()[0].resolvedModel, null);
  assert.equal(h.messages().filter((message) => message.method === "session/set_config_option").length, 1);
  const invalid = h.run(["task", "--effort", "high", "--", "inspect"]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /failure: input/);
  assert.equal(h.jobs().length, 1);
});

test("unknown and adaptive models fail before a job exists", (t) => {
  const h = harness(t);
  for (const model of ["unknown", "adaptive", "fusion-swe"]) {
    const result = h.run(["task", "--model", model, "--", "inspect"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failure: input/);
  }
  assert.deepEqual(h.jobs(), []);
});

test("unavailable account family fails as setup and unsupported effort as input", (t) => {
  const h = harness(t);
  const unavailable = h.run(["task", "--model", "unavailable", "--", "inspect"]);
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stdout, /failure: setup\n$/);
  assert.match(unavailable.stdout, /Account models:/);
  const effort = task(h, ["--effort", "xhigh"]);
  assert.equal(effort.status, 1);
  assert.match(effort.stdout, /failure: input\n$/);
  assert.match(effort.stdout, /Offered values: low, high, max/);
  assert.deepEqual(h.jobs().map((job) => job.status), ["error", "error"]);
});

test("resume loads the parent session and excludes replayed text", (t) => {
  const h = harness(t);
  assertDone(task(h));
  const parent = h.jobs()[0];
  const resumed = h.run(["task", "--resume", parent.sessionId, "--", "continue"]);
  assertDone(resumed);
  assert.doesNotMatch(resumed.stdout, /old conversation/);
  assert.match(resumed.stdout, new RegExp(`resumed-from: ${parent.id}`));
  assert.equal(h.jobs().find((job) => job.id !== parent.id).resumedFromJobId, parent.id);
  assert.ok(h.messages().some((message) => message.method === "session/load" && message.params.sessionId === parent.sessionId));
});

test("review renders a validated verdict and invalid output fails", (t) => {
  const good = harness(t, "review_ok");
  reviewWorkspace(good);
  const result = good.run(["review", "--model", "swe-2", "--focus", "sample path", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review.verdict, "request_changes");
  assert.equal(payload.review.findings[0].severity, "high");
  assert.equal(good.jobs()[0].mode, "review");
  assert.match(good.messages().at(-1).params.prompt[0].text, /User focus: sample path/);
  const bad = harness(t, "review_invalid");
  reviewWorkspace(bad);
  const invalid = bad.run(["review", "--model", "swe-2"]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /No JSON object found in the reply/);
  assert.equal(bad.jobs()[0].parseError, "No JSON object found in the reply.");
});

test("background result wait collects delivery", (t) => {
  const h = harness(t);
  const launch = task(h, ["--background"]);
  assert.equal(launch.status, 0, launch.stdout + launch.stderr);
  assert.match(launch.stdout, /state: running\n$/);
  const id = h.jobs()[0].id;
  assertDone(h.run(["result", id, "--wait"]));
  assert.equal(h.jobs()[0].delivery, "manual");
  assert.ok(h.jobs()[0].deliveryCollectedAt);
});

test("status, history and cancellation track a running job", async (t) => {
  const h = harness(t, "hang");
  const launch = task(h, ["--background"]);
  assert.equal(launch.status, 0, launch.stdout + launch.stderr);
  const id = h.jobs()[0].id;
  const deadline = Date.now() + 10000;
  while (!h.jobs()[0].devinPid && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(h.jobs()[0].devinPid);
  assert.equal(JSON.parse(h.run(["status", id, "--json"]).stdout).status, "running");
  assert.equal(JSON.parse(h.run(["history", "--json"]).stdout).jobs[0].jobId, id);
  const cancelled = h.run(["cancel", id, "--json"]);
  assert.equal(cancelled.status, 0, cancelled.stdout + cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
  assert.equal(h.jobs()[0].status, "cancelled");
  assert.equal(fs.existsSync(h.jobs()[0].configDir), false);
});

test("record acceptance updates semantic status", (t) => {
  const h = harness(t);
  assertDone(task(h));
  const id = h.jobs()[0].id;
  const result = h.run(["record-acceptance", "--job-id", id, "--acceptance", "rejected", "--failure-kind", "wrong_approach", "--reason", "wrong target", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).semanticStatus, "rejected");
  assert.equal(h.jobs()[0].semanticFailureKind, "wrong_approach");
});

test("raw transport consumes the staged request", (t) => {
  const h = harness(t);
  const created = JSON.parse(h.run(["transport-create"]).stdout);
  fs.writeFileSync(created.file, "--model swe-2 -- raw private brief");
  const result = h.run(["task", "--raw-args-token", created.token]);
  assertDone(result);
  assert.equal(fs.existsSync(created.file), false);
  assert.equal(h.messages().at(-1).params.prompt[0].text, "raw private brief");
});

test("auth, quota, policy and permission failures carry typed footers", (t) => {
  for (const [scenario, kind] of [["auth_required", "auth"], ["quota", "quota"], ["forbidden_tool", "policy"], ["tool_rejected", "permission"]]) {
    const h = harness(t, scenario);
    const result = task(h);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`failure: ${kind}\\n$`));
    assert.equal(h.jobs()[0].failureKind, kind);
    if (kind === "quota") assert.equal(h.jobs()[0].billingPool, "first-party");
  }
});

test("models and setup expose the family catalog and account plan", (t) => {
  const h = harness(t);
  const models = h.run(["models", "--json"]);
  assert.equal(models.status, 0, models.stdout + models.stderr);
  assert.deepEqual(JSON.parse(models.stdout), { engine: "devin", models: [
    { id: "swe-2", displayName: "SWE-2" }, { id: "kimi-k3", displayName: "Kimi K3" }, { id: "unavailable", displayName: "Unavailable" }
  ], source: "cli" });
  fs.mkdirSync(path.join(h.cwd, ".devin"));
  fs.writeFileSync(path.join(h.cwd, ".devin", "config.json"), "{}");
  const setup = h.run(["setup", "--json"]);
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  const report = JSON.parse(setup.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.devin.buildPath, fs.realpathSync(h.bin));
  assert.equal(report.devin.version, "3000.11.228");
  assert.equal(report.compatibility, "tested");
  assert.equal(report.auth.authenticated, true);
  assert.equal(report.planTier, "Pro");
  assert.equal(report.catalog.source, "cli");
  assert.deepEqual(report.projectConfigFiles, [path.join(h.cwd, ".devin", "config.json")]);
});

test("old or missing binary fails before job creation", (t) => {
  const old = harness(t, "success", { FAKE_DEVIN_VERSION: "devin 3000.10.9 (old)" });
  const result = task(old);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /failure: setup/);
  assert.deepEqual(old.jobs(), []);
  const missing = harness(t, "success", { DEVIN_BIN: "/absent/devin" });
  const absent = task(missing);
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /failure: missing_cli/);
  assert.deepEqual(missing.jobs(), []);
});
