import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { harness } from "./lib/opencode-harness.mjs";

function report(result) {
  assert.equal(result.error, undefined, result.error?.message);
  const text = result.stdout || result.stderr;
  try { return JSON.parse(text); }
  catch { assert.fail(`Expected JSON: ${text}`); }
}

test("missing key fails as auth before launching Codex or creating a job", (t) => {
  for (const key of [undefined, "", "   "]) {
    const box = harness(t, { OPENCODE_GO_API_KEY: key });
    const result = box.run(["task", "--write", "--json", "--", "opencode-role: bulk\nGenerate files."]);
    assert.equal(result.status, 1);
    assert.equal(report(result).failureKind, "auth");
    assert.equal(box.invocations().length, 0);
    assert.equal(box.requests().length, 0);
    assert.equal(box.jobs().length, 0);
  }
});

test("an opencode auth login key reaches the Codex child when the environment has none", (t) => {
  const box = harness(t, { OPENCODE_GO_API_KEY: undefined, FAKE_OPENCODE_EXPECTED_CREDENTIAL: "stored-test-credential" });
  const store = path.join(box.env.HOME, ".local/share/opencode/auth.json");
  fs.mkdirSync(path.dirname(store), { recursive: true });
  fs.writeFileSync(store, JSON.stringify({ "opencode-go": { type: "api", key: "stored-test-credential" } }));
  const result = box.run(["task", "--json", "--", "opencode-role: blind-check\nAnswer the staged questions."]);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const launch = box.invocations().find((entry) => entry.args[0] === "exec");
  assert.equal(launch.credential, "stored-test-credential");
  assert.equal(launch.args.some((arg) => arg.includes("stored-test-credential")), false);
  assert.equal(JSON.stringify(box.jobs()).includes("stored-test-credential"), false);
});

test("missing bundled gpt-5.5 fails as setup before exec", (t) => {
  const box = harness(t, { FAKE_OPENCODE_BUNDLED: "missing" });
  const result = box.run(["task", "--write", "--json", "--", "opencode-role: bulk\nGenerate files."]);
  assert.equal(result.status, 1);
  assert.equal(report(result).failureKind, "setup");
  assert.equal(box.invocations().some((entry) => entry.args[0] === "exec"), false);
  assert.equal(box.jobs().length, 0);
});

test("missing and unsupported Codex installations have typed preflight failures", (t) => {
  for (const [env, failureKind] of [[{ OPENCODE_CODEX_BIN: "/nonexistent/opencode-test-codex" }, "missing_cli"], [{ FAKE_OPENCODE_VERSION: "0.153.0" }, "setup"]]) {
    const box = harness(t, env);
    const result = box.run(["task", "--json", "--", "opencode-role: bulk\nGenerate files."]);
    assert.equal(result.status, 1);
    assert.equal(report(result).failureKind, failureKind);
    assert.equal(box.jobs().length, 0);
  }
});

for (const [role, writeFlag, expectedSandbox, expectedModel] of [
  ["bulk", true, "workspace-write", "deepseek-v4.1-flash"],
  ["bulk", false, "workspace-write", "deepseek-v4.1-flash"],
  ["blind-check", false, "read-only", "glm-5.3-flash"],
  ["blind-check", true, "read-only", "glm-5.3-flash"]
]) {
  test(`${role} selects ${expectedSandbox} by role with --write ${writeFlag}`, (t) => {
    const box = harness(t);
    const brief = `opencode-role: ${role}\nGenerate and verify the staged artifact.`;
    const result = box.run(["task", ...(writeFlag ? ["--write"] : []), "--json", "--", brief]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = report(result);
    assert.equal(output.status, "done");
    assert.equal(output.semanticStatus, "unverified");
    assert.equal(output.role, role);
    assert.equal(output.requestedModel, expectedModel);
    assert.equal(output.billingPool, "opencode");
    assert.equal(output.codexVersion, "0.171.0");
    assert.equal(output.usage.totalTokens, 140);
    const record = box.jobs()[0];
    assert.equal(record.codexVersion, "0.171.0");
    assert.equal(record.mode, role === "bulk" ? "write" : "consult");
    assert.equal(record.opencodePid, null);
    assert.equal(record.opencodePidIdentity, null);
    const launch = box.invocations().find((entry) => entry.args[0] === "exec");
    assert.equal(launch.codexHome, path.join(box.dataDir, "codex-home"));
    assert.equal(launch.args[launch.args.indexOf("--sandbox") + 1], expectedSandbox);
    assert.equal(launch.args[launch.args.indexOf("--model") + 1], expectedModel);
    assert.equal(launch.args[launch.args.indexOf("--cd") + 1], box.cwd);
    assert.ok(launch.args.includes("--skip-git-repo-check"));
    assert.ok(launch.args.includes('model_reasoning_effort="high"'));
    assert.ok(launch.args.includes(`model_providers.opencode.http_headers={"x-opencode-session"="${output.jobId}"}`));
    assert.equal(launch.args.at(-1), brief);
    assert.equal(launch.stdin, "");
    assert.equal(launch.args.some((arg) => arg.includes("opencode-test-credential")), false);
    assert.match(fs.readFileSync(path.join(launch.codexHome, "config.toml"), "utf8"), /exclude = \["OPENCODE_\*"\]/);
    assert.equal(box.run(["status", output.jobId, "--json"]).status, 0);
    const collected = report(box.run(["result", output.jobId, "--wait", "--json"]));
    assert.equal(collected.status, "done");
    assert.equal(collected.text, output.text);
    const accepted = box.run(["record-acceptance", "--job-id", output.jobId, "--acceptance", "accepted", "--source", "collector", "--json"]);
    assert.equal(report(accepted).semanticStatus, "accepted");
  });
}

test("explicit supported model and effort are forwarded without a Codex service tier", (t) => {
  const box = harness(t);
  const result = box.run(["task", "--model", "glm-5.3-flash", "--effort", "medium", "--json", "--", "opencode-role: bulk\nGenerate files."]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const launch = box.invocations().find((entry) => entry.args[0] === "exec");
  assert.ok(launch.args.includes('model_reasoning_effort="medium"'));
  assert.equal(launch.args[launch.args.indexOf("--model") + 1], "glm-5.3-flash");
  assert.equal(launch.args.some((arg) => arg.startsWith("service_tier=")), false);
});

test("unknown roles, models, and efforts reject the request before exec", (t) => {
  for (const args of [
    ["--", "ordinary implementation"],
    ["--", "opencode-role: review\nReview files."],
    ["--", "opencode-role: bulk; opencode-role: blind-check\nGenerate files."],
    ["--model", "missing-model", "--", "opencode-role: bulk\nGenerate files."],
    ["--effort", "persistent", "--", "opencode-role: bulk\nGenerate files."]
  ]) {
    const box = harness(t);
    const result = box.run(["task", "--json", ...args]);
    assert.equal(result.status, 1);
    assert.equal(report(result).failureKind, "input");
    assert.equal(box.invocations().some((entry) => entry.args[0] === "exec"), false);
  }
});

test("models and quota use stubbed Go requests and their disk caches", (t) => {
  const box = harness(t);
  const models = report(box.run(["models", "--json"]));
  assert.equal(models.engine, "opencode");
  assert.deepEqual(models.models.map((model) => model.id), ["deepseek-v4.1-flash", "glm-5.3-flash"]);
  assert.equal(models.source, "api");
  assert.equal(report(box.run(["models", "--json"])).source, "cache");
  assert.equal(box.requests().length, 1);
  const usage = report(box.run(["quota", "--json"]));
  assert.equal(usage.available, true);
  assert.equal(usage.pools.length, 3);
  assert.equal(usage.pools[0].pacing, null);
  box.run(["quota", "--json"]);
  assert.equal(box.requests().length, 2);
  assert.ok(box.requests().every((request) => typeof request.sessionId === "string" && request.sessionId));
});

test("staged raw requests retain their role and consume the transport", (t) => {
  const box = harness(t);
  const transport = report(box.run(["transport-create"]));
  fs.writeFileSync(transport.file, "--json -- opencode-role: blind-check | acceptance: matching answers\nCheck the staged answers.");
  const output = report(box.run(["task", "--transport-default-write", "--transport-background-shell", "--raw-args-token", transport.token]));
  assert.equal(output.status, "done");
  assert.equal(output.role, "blind-check");
  assert.equal(fs.existsSync(transport.file), false);
  const launch = box.invocations().find((entry) => entry.args[0] === "exec");
  assert.equal(launch.args[launch.args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(box.jobs()[0].request.backgroundShellBudget, true);
});

test("manual background jobs return a watch instruction and collect through result", (t) => {
  const box = harness(t, { OPENCODE_COMPANION_WATCH_POLL_MS: "10" });
  const launch = report(box.run(["task", "--background", "--write", "--json", "--", "opencode-role: bulk\nGenerate files."]));
  assert.equal(launch.delivery, "manual");
  assert.match(launch.watchCommand, /opencode-companion\.mjs" watch --job [a-f0-9]{32}$/);
  const result = box.run(["result", launch.jobId, "--wait", "--json"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(report(result).status, "done");
  const job = box.jobs()[0];
  assert.equal(job.deliveryStatus, "collected");
  assert.ok(job.deliveryCollectedAt);
  const watch = box.run(["watch", "--job", launch.jobId]);
  assert.equal(watch.status, 0, watch.stderr);
  assert.match(watch.stdout, /opencode job [a-f0-9]{32} done/);
});

test("resume retains its role and model and refuses a role change", (t) => {
  const box = harness(t);
  const original = report(box.run(["task", "--write", "--json", "--", "opencode-role: bulk\nGenerate files."]));
  assert.equal(original.status, "done");
  const resumed = report(box.run(["task", "--write", "--resume-last", "--json", "--", "Continue the same work."]));
  assert.equal(resumed.status, "done");
  assert.equal(resumed.resumedFromJobId, original.jobId);
  assert.equal(resumed.role, "bulk");
  assert.equal(resumed.requestedModel, original.requestedModel);
  assert.equal(resumed.usageIsIncomplete, true);
  const changed = report(box.run(["task", "--write", "--resume-last", "--json", "--", "opencode-role: blind-check\nCheck answers."]));
  assert.equal(changed.failureKind, "input");
  assert.equal(box.invocations().filter((entry) => entry.args[0] === "exec").length, 2);
});

test("session end removes only its own staged raw transport", (t) => {
  const box = harness(t, { CLAUDE_CODE_SESSION_ID: "opencode-session-end-test" });
  const transport = report(box.run(["transport-create"]));
  assert.equal(fs.existsSync(transport.file), true);
  const hook = spawnSync(process.execPath, [path.join(box.plugin, "scripts/session-end-hook.mjs")], {
    env: box.env, cwd: box.cwd, input: JSON.stringify({ session_id: "opencode-session-end-test" }), encoding: "utf8", timeout: 30000
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(fs.existsSync(transport.file), false);
});

test("setup reports the Codex version and advises disabling Extra Usage", (t) => {
  const box = harness(t);
  const setup = report(box.run(["setup", "--json"]));
  assert.equal(setup.ready, true);
  assert.equal(setup.codexVersion, "0.171.0");
  assert.ok(setup.nextSteps.some((step) => /Turn off Extra Usage/.test(step)));
});

for (const [scenario, kind] of [["auth401", "auth"], ["auth403", "auth"], ["quota", "quota"], ["rate", "rate_limited"], ["permission", "permission"], ["refused", "refused"], ["network", "network"], ["malformed", "protocol"], ["empty", "error"]]) {
  test(`Codex ${scenario} failure is scoped to OpenCode as ${kind}`, (t) => {
    const box = harness(t, { FAKE_OPENCODE_SCENARIO: scenario });
    const result = box.run(["task", "--write", "--json", "--", "opencode-role: bulk\nGenerate files."]);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(report(result).failureKind, kind);
    assert.equal(box.jobs()[0].engine, "opencode");
    assert.equal(box.jobs()[0].billingPool, "opencode");
  });
}

test("terminal text ends with the shared outcome footer", (t) => {
  const box = harness(t);
  const result = box.run(["task", "--write", "--", "opencode-role: bulk\nGenerate files."]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /opencode-session: [^\n]+\njob: [a-f0-9]{32}\nsandbox: [^\n]+\ndelivery: foreground\nsemantic: unverified\n(?:warning: [^\n]+\n)*state: done\n$/);
});
