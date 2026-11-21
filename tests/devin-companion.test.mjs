import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executionTimeoutProbe, verifyExecutionBudgets } from "./lib/execution-budget.mjs";
import { verifyJobWatch } from "./lib/job-watch-harness.mjs";
import { quota } from "../plugins/devin/scripts/devin-companion.mjs";

verifyJobWatch("devin");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companion = path.join(root, "plugins/devin/scripts/devin-companion.mjs");
const fake = path.join(root, "tests/fake-devin");

function harness(t, scenario = "success", extraEnv = {}, variants = null) {
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
    { family_label: "SWE-2", family_uid: "swe-2", slug: "swe-2", aliases: ["swe"], variants: variants ?? [{ model_uid: "swe-2-high", label: "SWE-2 High", cost_tier: "free" }] },
    { family_label: "Kimi K3", family_uid: "kimi-k3", slug: "kimi-k3", aliases: [], variants: [{ model_uid: "kimi-k3-high", label: "Kimi K3", cost_tier: "premium" }] },
    { family_label: "Unavailable", family_uid: "unavailable", slug: "unavailable", aliases: [], variants: [{ model_uid: "unavailable-high", label: "Unavailable High", cost_tier: "premium" }] },
    { family_label: "Adaptive", family_uid: "Adaptive", slug: "adaptive", aliases: [], variants: [{ model_uid: "adaptive", label: "Adaptive" }] },
    { family_label: "Fusion", family_uid: "fusion", slug: "fusion", aliases: [], variants: [
      { model_uid: "fusion-swe-2-medium", label: "Fusion", cost_tier: "free" },
      { model_uid: "fusion-gpt-6-sol-sidekick-swe-2-high", label: "GPT-6 Sol + SWE-2 High", cost_tier: "free" },
      { model_uid: "fusion-claude-opus-5-sidekick-swe-2-high", label: "Claude Opus 5 + SWE-2 High", cost_tier: "free" },
      { model_uid: "kimi-k3-high", label: "Kimi K3" }
    ] },
    ...(scenario === "thought_variant" ? [{ family_label: "Muse Wonder", family_uid: "muse-wonder", slug: "muse-wonder", aliases: [], variants: [
      { model_uid: "muse-wonder-1-0-high", label: "Muse Wonder High", cost_tier: "free" },
      { model_uid: "muse-wonder-1-0-xhigh", label: "Muse Wonder XHigh", cost_tier: "free" }
    ] }] : [])
  ] };
  const review = { verdict: "request_changes", summary: "Needs a fix.", findings: [{ severity: "high", file: "sample.txt", line: 1, title: "Bad value", body: "Use the expected value." }] };
  const code = `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args.join(" ") === "models list --format json") { process.stdout.write(${JSON.stringify(JSON.stringify(catalog) + "\n")}); process.exit(0); }
if (args.join(" ") === "auth status") { process.stdout.write("Authenticated\\nPlan: Pro\\n"); process.exit(0); }
process.env.FAKE_DEVIN_SCENARIO = ${JSON.stringify(["review_ok", "review_invalid", "thought_variant"].includes(scenario) ? "success" : scenario)};
process.env.FAKE_DEVIN_LOG = ${JSON.stringify(log)};
${extraEnv.FAKE_DEVIN_SESSION_ID ? `process.env.FAKE_DEVIN_SESSION_ID = ${JSON.stringify(extraEnv.FAKE_DEVIN_SESSION_ID)};` : ""}
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
  ${scenario === "thought_variant" ? `let liveModel = "muse-wonder-1-0-high";
  let liveOptions = null;
  const museOptions = [{ value: "muse-wonder-1-0-high", name: "Muse Wonder" }];
  const realWriteSync = fs.writeSync;
  fs.writeSync = (fd, data, ...rest) => {
    if (fd === 1 && typeof data === "string") {
      try {
        const event = JSON.parse(data);
        if (Array.isArray(event.result?.configOptions)) {
          liveOptions = event.result.configOptions.map((option) => option.id === "model" ? { ...option, currentValue: liveModel, options: museOptions } : option);
          data = JSON.stringify({ ...event, result: { ...event.result, configOptions: liveOptions } }) + "\\n";
        } else if (event.error && liveOptions) {
          const invalid = /^Invalid value '([^']+)' for config option '([^']+)'$/.exec(String(event.error.data));
          if (invalid && (invalid[2] === "model" && invalid[1] === liveModel || invalid[2] === "thought_level" && invalid[1] === "xhigh")) {
            if (invalid[2] === "model") {
              liveOptions = [...liveOptions.filter((option) => option.id !== "thought_level"), { id: "thought_level", type: "select", currentValue: "high", options: ["minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value })) }];
            } else {
              liveOptions = liveOptions.map((option) => option.id === "thought_level" ? { ...option, currentValue: "xhigh" } : option);
            }
            data = JSON.stringify({ jsonrpc: "2.0", id: event.id, result: { configOptions: liveOptions } }) + "\\n";
          }
        }
      } catch {}
    }
    return realWriteSync(fd, data, ...rest);
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
  return { temp, home, cwd, data, bin, env, log, run, jobs, messages, launched };
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
  assert.equal(record.resolvedEffort, "high");
  assert.equal(record.observedModel, "SWE-2 High");
  assert.equal(record.stopCause, "complete");
  assert.deepEqual(record.usage, { totalTokens: 11914, inputTokens: 11875, outputTokens: 39, cachedReadTokens: 11552 });
  assert.equal(record.billingPool, "free");
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

test("the thought level picks the served variant while the model option keeps the family default", (t) => {
  const h = harness(t, "thought_variant", { FAKE_DEVIN_MODEL_LABEL: "Muse Wonder XHigh" });
  const result = h.run(["task", "--model", "muse-wonder", "--effort", "xhigh", "--", "inspect"]);
  assertDone(result);
  const [record] = h.jobs();
  assert.equal(record.resolvedModel, "muse-wonder-1-0-xhigh");
  assert.equal(record.resolvedEffort, "xhigh");
  assert.equal(record.effortApplied, true);
  assert.equal(record.observedModel, "Muse Wonder XHigh");
  assert.equal(record.modelDrift, null);
  assert.deepEqual(record.warnings, []);
  const drifted = harness(t, "thought_variant", { FAKE_DEVIN_MODEL_LABEL: "SWE-2 High" });
  assertDone(drifted.run(["task", "--model", "muse-wonder", "--effort", "xhigh", "--", "inspect"]));
  const [drift] = drifted.jobs();
  assert.equal(drift.resolvedModel, "muse-wonder-1-0-xhigh");
  assert.deepEqual(drift.modelDrift, { requested: "muse-wonder-1-0-xhigh", observed: "SWE-2 High" });
  assert.deepEqual(drift.warnings, ["model_mismatch"]);
});

for (const model of ["swe-2", "swe"]) {
  for (const [uid, pool, label] of [["swe-2-high", "free", "SWE-2 High"], ["kimi-k3-high", "credits", "Kimi K3"]]) {
    test(`${model} records the ${pool} pool of the offered variant`, (t) => {
      const h = harness(t, "success", { FAKE_DEVIN_MODEL_LABEL: label }, [
        { model_uid: "unavailable-high", label: "Unavailable", cost_tier: pool === "free" ? "premium" : "free" },
        { model_uid: uid, label, cost_tier: pool === "free" ? "free" : "premium" }
      ]);
      const result = h.run(["task", "--model", model, "--json", "--", "inspect"]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(h.jobs()[0].resolvedModel, uid);
      assert.equal(h.jobs()[0].billingPool, pool);
      assert.equal(JSON.parse(result.stdout).billingPool, pool);
    });
  }
}

test("write mode uses a private home, sandbox and scoped config", (t) => {
  const h = harness(t);
  assertDone(task(h, ["--write", "--effort", "max"], "lane: devin burst\nimplement"));
  const [record] = h.jobs();
  const { env, config } = h.launched();
  assert.equal(record.mode, "write");
  assert.equal(record.role, "burst");
  assert.equal(record.effortApplied, true);
  assert.equal(record.resolvedEffort, "max");
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

test("default effort records Devin's current thought level", (t) => {
  const h = harness(t);
  assertDone(task(h, ["--effort", "default"]));
  const [record] = h.jobs();
  assert.equal(record.requestedEffort, "default");
  assert.equal(record.resolvedEffort, "high");
  assert.equal(record.effortApplied, false);
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

test("write tasks pin fusion pairings and record the planner and sidekick", (t) => {
  const h = harness(t);
  const result = h.run(["task", "--write", "--model", "fusion-gpt-6-sol-sidekick-swe-2-high", "--", "lane: devin burst\nimplement"]);
  assertDone(result);
  const [record] = h.jobs();
  assert.equal(record.mode, "write");
  assert.equal(record.role, "burst");
  assert.equal(record.requestedModel, "fusion-gpt-6-sol-sidekick-swe-2-high");
  assert.equal(record.resolvedModel, "kimi-k3-high");
  assert.equal(record.observedModel, "SWE-2 High");
  assert.equal(record.billingPool, "free");
  assert.deepEqual(record.request.pairing, { planner: "gpt-6-sol", sidekick: "swe-2-high" });
  assert.equal(record.modelDrift, null);
  assert.deepEqual(record.warnings, []);
});

test("fusion pairings refuse read only jobs, claude planners, and unpinned names", (t) => {
  const h = harness(t);
  for (const args of [
    ["task", "--model", "fusion-gpt-6-sol-sidekick-swe-2-high", "--", "inspect"],
    ["task", "--write", "--model", "fusion-claude-opus-5-sidekick-swe-2-high", "--", "implement"],
    ["task", "--write", "--model", "fusion", "--", "implement"],
    ["task", "--write", "--model", "adaptive", "--", "implement"],
    ["task", "--write", "--model", "fusion-gpt-9-sol-sidekick-swe-2-high", "--", "implement"]
  ]) {
    const result = h.run(args);
    assert.equal(result.status, 1, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /failure: input/);
  }
  const review = harness(t);
  reviewWorkspace(review);
  const refused = review.run(["review", "--model", "fusion-gpt-6-sol-sidekick-swe-2-high"]);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /failure: input/);
  assert.deepEqual(h.jobs(), []);
  assert.deepEqual(review.jobs(), []);
});

test("the write transport default enables pairings for staged tasks", (t) => {
  const h = harness(t);
  const created = JSON.parse(h.run(["transport-create"]).stdout);
  fs.writeFileSync(created.file, "--model fusion-gpt-6-sol-sidekick-swe-2-high -- implement");
  const result = h.run(["task", "--transport-default-write", "--raw-args-token", created.token]);
  assertDone(result);
  const [record] = h.jobs();
  assert.equal(record.mode, "write");
  assert.deepEqual(record.request.pairing, { planner: "gpt-6-sol", sidekick: "swe-2-high" });
});

test("a pairing turn served by its planner or sidekick is not model drift", (t) => {
  const planned = harness(t, "success", { FAKE_DEVIN_MODEL_LABEL: "GPT-6 Sol" });
  assertDone(planned.run(["task", "--write", "--model", "fusion-gpt-6-sol-sidekick-swe-2-high", "--", "implement"]));
  assert.equal(planned.jobs()[0].observedModel, "GPT-6 Sol");
  assert.equal(planned.jobs()[0].modelDrift, null);
  assert.deepEqual(planned.jobs()[0].warnings, []);
  const other = harness(t, "success", { FAKE_DEVIN_MODEL_LABEL: "Gemini 9 Pro" });
  assertDone(other.run(["task", "--write", "--model", "fusion-gpt-6-sol-sidekick-swe-2-high", "--", "implement"]));
  assert.deepEqual(other.jobs()[0].warnings, ["model_mismatch"]);
});

for (const observed of ["swe-2-high-pro", "GPT-6 Sol Pro"]) {
  test(`a pairing warns when ${observed} only shares a label prefix`, (t) => {
    const h = harness(t, "success", { FAKE_DEVIN_MODEL_LABEL: observed });
    const result = h.run(["task", "--write", "--model", "fusion-gpt-6-sol-sidekick-swe-2-high", "--", "implement"]);
    assertDone(result);
    const [record] = h.jobs();
    assert.equal(record.observedModel, observed);
    assert.deepEqual(record.modelDrift, { requested: "kimi-k3-high", observed });
    assert.deepEqual(record.warnings, ["model_mismatch"]);
    assert.match(result.stdout, /warning: model_mismatch\nstate: done\n$/);
  });
}

test("the quota adapter reports a free pool and a metered credits pool", () => {
  const report = quota({ env: {}, dataDir: "/tmp/devin-data" });
  assert.equal(report.engine, "devin");
  assert.equal(report.available, true);
  assert.ok(Date.parse(report.observedAt));
  assert.deepEqual(report.pools, [
    { pool: "free", costClass: "free", usedPercent: null, windowMinutes: null, resetsAt: null, pacing: null },
    { pool: "credits", costClass: "metered", usedPercent: null, windowMinutes: null, resetsAt: null, pacing: null }
  ]);
  assert.equal(report.note, "Devin exposes no usage meter; credits bill per token, so routing treats them as metered.");
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

test("resume loads the parent session, checks replay tools, and excludes replayed text", (t) => {
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

test("resume skips policy failures, refuses explicit policy sessions, and reports them as not resumable", (t) => {
  const h = harness(t);
  assertDone(task(h));
  const parent = h.jobs()[0];
  const forbidden = harness(t, "forbidden_tool", { FAKE_DEVIN_SESSION_ID: "policy-session" });
  h.env.DEVIN_BIN = forbidden.bin;
  const failed = task(h);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  const policy = h.jobs().find((job) => job.id !== parent.id);
  assert.equal(policy.failureKind, "policy");
  assert.notEqual(policy.sessionId, parent.sessionId);
  h.env.DEVIN_BIN = h.bin;
  const explicit = h.run(["task", "--resume", policy.sessionId, "--", "continue"]);
  assert.equal(explicit.status, 1, explicit.stdout + explicit.stderr);
  assert.match(explicit.stderr, /No finished consult Devin task owns session/);
  assert.match(explicit.stderr, /failure: input/);
  assert.equal(h.jobs().length, 2);
  assertDone(h.run(["task", "--resume-last", "--", "continue"]));
  assert.equal(h.jobs().find((job) => job.resumedFromJobId).resumedFromJobId, parent.id);
  assert.equal(JSON.parse(h.run(["history", "--json"]).stdout).jobs.find((job) => job.jobId === policy.id).resumable, false);
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
  assert.ok(launch.stdout.includes(`node "${companion}" watch --job ${id}`));
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

test("Devin execution budgets follow the launch transport", async (t) => {
  await verifyExecutionBudgets(t, {
    engine: "devin", model: "swe-2", foregroundTimeoutMs: 540000,
    createHarness: (t, env) => harness(t, "success", env)
  });
});

test("auth, quota, policy and permission failures carry typed footers", (t) => {
  for (const [scenario, kind] of [["auth_required", "auth"], ["quota", "quota"], ["forbidden_tool", "policy"], ["tool_rejected", "permission"]]) {
    const h = harness(t, scenario);
    const result = task(h);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`failure: ${kind}\\n$`));
    assert.equal(h.jobs()[0].failureKind, kind);
    if (kind === "quota") assert.equal(h.jobs()[0].billingPool, "free");
  }
});

test("a timed out Devin job records its timeout duration", (t) => {
  const timeoutMs = 250;
  const h = harness(t, "hang", { DEVIN_COMPANION_TIMEOUT_MS: String(timeoutMs), DEVIN_COMPANION_EXIT_GRACE_MS: "100" });
  const probe = executionTimeoutProbe(h.temp, timeoutMs);
  Object.assign(h.env, probe.env);
  const result = task(h, ["--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const record = h.jobs()[0];
  const message = "Devin timed out after 240000ms and was terminated.";
  assert.deepEqual(probe.timeouts(), [timeoutMs, 240000]);
  assert.deepEqual(record.salvage, { attempted: true, outcome: "timeout", originalPid: record.salvage.originalPid,
    resumePid: record.salvage.resumePid, resumePidIdentity: record.salvage.resumePidIdentity });
  assert.ok(Number.isInteger(record.salvage.originalPid) && record.salvage.originalPid > 1);
  assert.ok(Number.isInteger(record.salvage.resumePid) && record.salvage.resumePid > 1);
  assert.notEqual(record.salvage.resumePid, record.salvage.originalPid);
  assert.ok(Object.hasOwn(record.salvage, "resumePidIdentity"));
  assert.equal(record.failureKind, "timeout");
  assert.equal(record.errorMessage, message);
  assert.equal(JSON.parse(result.stdout).message, message);
});

test("a timed out Devin task resumes its session once and delivers the wind down report", (t) => {
  const h = harness(t, "wind_down", { DEVIN_COMPANION_TIMEOUT_MS: "1500", DEVIN_COMPANION_EXIT_GRACE_MS: "100" });
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
  assert.equal(record.resultText, "fake result");
  assert.ok(h.messages().some((message) => message.method === "session/load" && message.params.sessionId === record.sessionId));
  assert.match(h.messages().find((message) => message.method === "session/prompt").params.prompt[0].text, /^Your time budget is exhausted\. Stop exploring\./);
  assert.match(result.stdout, /warning: timeout_salvaged\nstate: done\n$/);
});

test("an empty Devin turn resumes its session once with a continue prompt and delivers the answer", (t) => {
  const h = harness(t, "empty_response");
  const result = task(h);
  assertDone(result);
  assert.equal(h.jobs().length, 1);
  const [record] = h.jobs();
  assert.equal(record.salvage.attempted, true);
  assert.equal(record.salvage.reason, "empty_turn");
  assert.equal(record.salvage.outcome, "done");
  assert.equal(record.semanticFailureKind ?? null, null);
  assert.equal(record.resultText, "fake result");
  assert.ok(h.messages().some((message) => message.method === "session/load" && message.params.sessionId === record.sessionId));
  assert.match(h.messages().find((message) => message.method === "session/prompt").params.prompt[0].text, /^Your last turn ended without a response\./);
  assert.match(result.stdout, /warning: empty_turn_continued\nstate: done\n$/);
});

test("an empty Devin turn that also broke tool policy fails as policy without a resume", (t) => {
  const h = harness(t, "empty_response_policy");
  task(h);
  const [record] = h.jobs();
  assert.equal(record.failureKind, "policy");
  assert.equal(record.salvage ?? null, null);
  assert.equal(h.messages().some((message) => message.method === "session/load"), false);
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

test("newer Devin builds receive verification advice and use the in-process ACP model", (t) => {
  const h = harness(t, "success", { FAKE_DEVIN_VERSION: "devin 3000.15.0 (new)" });
  const report = JSON.parse(h.run(["setup", "--json"]).stdout);
  assert.equal(report.compatibility, "newer than the tested interval");
  assert.deepEqual(report.nextSteps, ["Devin CLI version 3000.15.0 is newer than the tested interval (3000.11 to before 3000.15); run a verification pass."]);
  assertDone(task(h));
  assert.deepEqual(JSON.parse(fs.readFileSync(h.log, "utf8")).argv, ["acp", "--process-model", "in-process"]);
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
