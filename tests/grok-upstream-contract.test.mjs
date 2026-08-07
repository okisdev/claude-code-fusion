import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getProcessIdentity } from "../plugins/grok/scripts/lib/process-identity.mjs";

import {
  envFor,
  fakeGrok,
  flagValues,
  grokCompanionCapabilities,
  jobRecords,
  makeSandbox,
  readInvocations,
  repoRoot,
  runCompanion,
} from "./lib/companion-harness.mjs";

const { buildGrokArgs, processGroupAlive, resolveGrokCapabilities, runGrok, terminateExitedLeaderProcessGroup } = await import(
  path.join(repoRoot, "plugins", "grok", "scripts", "lib", "grok-exec.mjs")
);

const requiredCapabilityProbes = [
  ["--prompt-file", "--prompt-file=/dev/null"],
  ["--output-format", "--output-format=json"],
  ["--sandbox", "--sandbox=strict"],
  ["--tools", "--tools=read_file"],
  ["--disallowed-tools", "--disallowed-tools=Agent"],
  ["--deny", "--deny=x"],
  ["--max-turns", "--max-turns=1"],
  ["--no-auto-update", "--no-auto-update"],
  ["--permission-mode", "--permission-mode=default"],
  ["--allow", "--allow=x"],
  ["--always-approve", "--always-approve"],
  ["--disable-web-search", "--disable-web-search"],
  ["--json-schema", "--json-schema={}"],
  ["--no-wait-for-background", "--no-wait-for-background"]
];

test("capability probes accept every required flag hidden from help", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox, {
    FAKE_GROK_HIDDEN_CAPABILITIES: requiredCapabilityProbes.map(([flag]) => flag).join(",")
  });
  delete env.GROK_COMPANION_CAPABILITIES;

  const first = resolveGrokCapabilities(env.GROK_BIN, env);
  const second = resolveGrokCapabilities(env.GROK_BIN, env);

  for (const [flag] of requiredCapabilityProbes) {
    assert.equal(first.has(flag), true, flag);
  }
  assert.strictEqual(second, first);
  assert.deepEqual(readInvocations(sandbox.argsFile), [
    ["--help"],
    ...requiredCapabilityProbes.map(([, probeFlag]) => [probeFlag, "--help"])
  ]);
});

test("removed capabilities are rejected by probes and fail managed-run setup", (t) => {
  const sandbox = makeSandbox(t);
  const isolatedBin = path.join(sandbox.root, "fake-grok-removed-capability");
  fs.symlinkSync(fakeGrok, isolatedBin);
  const env = envFor(sandbox, {
    GROK_BIN: isolatedBin,
    FAKE_GROK_REMOVED_CAPABILITIES: "--no-auto-update"
  });
  delete env.GROK_COMPANION_CAPABILITIES;

  const capabilities = resolveGrokCapabilities(isolatedBin, env);
  assert.equal(capabilities.has("--no-auto-update"), false);
  assert.throws(
    () => runGrok(directOptions(sandbox, "ok", { env })),
    (error) => error?.failureKind === "setup" && /--no-auto-update/.test(error.message)
  );
  assert.deepEqual(readInvocations(sandbox.argsFile), [
    ["--help"],
    ["--no-auto-update", "--help"]
  ]);
});

test("fake Grok reports the 1.0.0 version format and supports an output override", () => {
  const defaultVersion = spawnSync(process.execPath, [fakeGrok, "--version"], { encoding: "utf8", env: {} });
  assert.equal(defaultVersion.status, 0, defaultVersion.stderr);
  assert.equal(defaultVersion.stdout, "grok 1.0.0 (0123456789ab)\n");

  const overriddenVersion = spawnSync(process.execPath, [fakeGrok, "--version"], {
    encoding: "utf8",
    env: { FAKE_GROK_VERSION_OUTPUT: "grok 1.0.1 (abcdef012345)" }
  });
  assert.equal(overriddenVersion.status, 0, overriddenVersion.stderr);
  assert.equal(overriddenVersion.stdout, "grok 1.0.1 (abcdef012345)\n");
});

test("exited leader cleanup with no identity signals only the original process group", async () => {
  const calls = [];
  let alive = true;
  const cleaned = await terminateExitedLeaderProcessGroup(424242, null, {
    graceMs: 5,
    pollMs: 1,
    kill(target, signal) {
      calls.push([target, signal]);
      assert.equal(target, -424242);
      if (signal === "SIGTERM") {
        alive = false;
        return;
      }
      if (signal === 0 && alive) {
        return;
      }
      const error = new Error("missing process group");
      error.code = "ESRCH";
      throw error;
    }
  });
  assert.equal(cleaned, true);
  assert.deepEqual(calls, [[-424242, 0], [-424242, "SIGTERM"], [-424242, 0]]);
});

test("exited leader cleanup does not signal a reused pid group", async () => {
  const identity = getProcessIdentity(process.pid);
  assert.ok(identity);
  const calls = [];
  const cleaned = await terminateExitedLeaderProcessGroup(process.pid, { ...identity, commandHash: `${identity.commandHash}replaced` }, {
    graceMs: 5,
    pollMs: 1,
    kill(target, signal) {
      calls.push([target, signal]);
      if (target === -process.pid && signal === 0) {
        return;
      }
      throw new Error("unexpected signal");
    }
  });
  assert.equal(cleaned, false);
  assert.deepEqual(calls, [[-process.pid, 0], [-process.pid, 0]]);
});

const bridgeEnvironmentKeys = [
  "GROK_CLAUDE_SKILLS_ENABLED",
  "GROK_CLAUDE_RULES_ENABLED",
  "GROK_CLAUDE_AGENTS_ENABLED",
  "GROK_CLAUDE_MCPS_ENABLED",
  "GROK_CLAUDE_HOOKS_ENABLED",
  "GROK_CLAUDE_SESSIONS_ENABLED",
  "GROK_CURSOR_SKILLS_ENABLED",
  "GROK_CURSOR_RULES_ENABLED",
  "GROK_CURSOR_AGENTS_ENABLED",
  "GROK_CURSOR_MCPS_ENABLED",
  "GROK_CURSOR_HOOKS_ENABLED",
  "GROK_CURSOR_SESSIONS_ENABLED",
  "GROK_CODEX_SKILLS_ENABLED",
  "GROK_CODEX_RULES_ENABLED",
  "GROK_CODEX_AGENTS_ENABLED",
  "GROK_CODEX_MCPS_ENABLED",
  "GROK_CODEX_HOOKS_ENABLED",
  "GROK_CODEX_SESSIONS_ENABLED",
];

function directOptions(sandbox, mode, extra = {}) {
  const briefFile = path.join(sandbox.root, `${mode}-brief.md`);
  fs.writeFileSync(briefFile, "exercise the upstream contract\n", "utf8");
  return {
    briefFile,
    mode: "consult",
    cwd: sandbox.workDir,
    logFile: path.join(sandbox.root, `${mode}.log`),
    timeoutMs: 10000,
    env: envFor(sandbox, { FAKE_GROK_MODE: mode }),
    ...extra,
  };
}

test("managed runs disable Agent while fixed tool allowlists keep x_search out", () => {
  const env = { GROK_COMPANION_CAPABILITIES: grokCompanionCapabilities };
  const toolSurfaces = {
    consult: "read_file,grep,list_dir",
    write: "read_file,grep,list_dir,search_replace,run_terminal_cmd",
  };
  for (const mode of Object.keys(toolSurfaces)) {
    const argv = buildGrokArgs({ briefFile: "/tmp/grok-brief.md", mode, timeoutMs: 90000, web: false, env });
    assert.ok(argv.includes("--no-subagents"), mode);
    assert.deepEqual(
      flagValues(argv, "--disallowed-tools"),
      ["Agent,search_tool,use_tool,ask_user_question"],
      mode
    );
    assert.equal(flagValues(argv, "--disallowed-tools").join(",").includes("x_search"), false, mode);
    assert.deepEqual(flagValues(argv, "--tools"), [toolSurfaces[mode]], mode);
    assert.ok(argv.includes("--no-wait-for-background"), mode);

    const webArgv = buildGrokArgs({ briefFile: "/tmp/grok-brief.md", mode, timeoutMs: 90000, web: true, env });
    assert.deepEqual(
      flagValues(webArgv, "--disallowed-tools"),
      ["Agent,search_tool,use_tool,ask_user_question"],
      mode
    );
    assert.deepEqual(flagValues(webArgv, "--tools"), [`${toolSurfaces[mode]},web_search,web_fetch`], mode);
    assert.equal(webArgv.includes("--disable-web-search"), false, mode);
  }
});

test("task forwards a requested JSON schema without requiring it for ordinary text", () => {
  const schema = JSON.stringify({ type: "object", required: ["status"] });
  const withSchema = buildGrokArgs({
    briefFile: "/tmp/grok-brief.md",
    mode: "consult",
    timeoutMs: 90000,
    jsonSchema: schema,
    env: { GROK_COMPANION_CAPABILITIES: grokCompanionCapabilities }
  });
  assert.deepEqual(flagValues(withSchema, "--json-schema"), [schema]);

  const capabilities = new Set(grokCompanionCapabilities.split(",").filter((flag) => flag !== "--json-schema"));
  const withoutSchema = buildGrokArgs({
    briefFile: "/tmp/grok-brief.md",
    mode: "consult",
    timeoutMs: 90000,
    capabilities,
    env: { GROK_COMPANION_CAPABILITIES: capabilities }
  });
  assert.doesNotMatch(withoutSchema.join(" "), /--json-schema/);
});

test("task schema requests fail preflight when structured output support is missing", (t) => {
  const sandbox = makeSandbox(t);
  const capabilities = grokCompanionCapabilities
    .split(",")
    .filter((capability) => capability !== "--json-schema")
    .join(",");
  const result = runCompanion(["task", "--json-schema", "{}", "complete the task"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { GROK_COMPANION_CAPABILITIES: capabilities })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--json-schema/);
  assert.deepEqual(readInvocations(sandbox.argsFile), []);
});

for (const requiredCapability of ["--prompt-file", "--output-format", "--sandbox", "--tools", "--disallowed-tools", "--deny", "--max-turns", "--no-auto-update", "--permission-mode", "--allow", "--disable-web-search"]) {
  test(`consult fails closed before launch when Grok lacks ${requiredCapability}`, (t) => {
    const sandbox = makeSandbox(t);
    const capabilities = grokCompanionCapabilities
      .split(",")
      .filter((capability) => capability !== requiredCapability)
      .join(",");
    const result = runCompanion(["task", "inspect the repository"], {
      cwd: sandbox.workDir,
      env: envFor(sandbox, { GROK_COMPANION_CAPABILITIES: capabilities }),
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(requiredCapability));
    assert.deepEqual(readInvocations(sandbox.argsFile), []);
  });
}

test("write mode fails closed before launch without always-approve support", (t) => {
  const sandbox = makeSandbox(t);
  const capabilities = grokCompanionCapabilities
    .split(",")
    .filter((capability) => capability !== "--always-approve")
    .join(",");
  const result = runCompanion(["task", "--write", "implement the bounded change"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { GROK_COMPANION_CAPABILITIES: capabilities })
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--always-approve/);
  assert.deepEqual(readInvocations(sandbox.argsFile), []);
});

test("managed runs fail closed when Grok cannot skip background work", (t) => {
  const sandbox = makeSandbox(t);
  const capabilities = grokCompanionCapabilities
    .split(",")
    .filter((capability) => capability !== "--no-wait-for-background")
    .join(",");
  const result = runCompanion(["task", "inspect the repository"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { GROK_COMPANION_CAPABILITIES: capabilities }),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--no-wait-for-background/);
  assert.deepEqual(readInvocations(sandbox.argsFile), []);
});

test("setup reports the injected capability verdict without an extra help probe", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["setup", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.capabilities.ready, true);
  assert.equal(report.capabilities.flags["--tools"], true);
  assert.equal(report.doctorCommand.available, true);
  assert.equal(report.shellEnvironmentPolicy.available, false);
  assert.equal(report.shellEnvironmentPolicy.present, false);
  assert.deepEqual(readInvocations(sandbox.argsFile), [["--version"], ["doctor", "--help"]]);
});

test("setup reports shell environment policy presence without affecting readiness", (t) => {
  const sandbox = makeSandbox(t);
  const configPath = path.join(sandbox.root, "grok-home", "config.toml");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, "[shell_environment_policy]\nallow = [\"PATH\"]\n", "utf8");

  const present = runCompanion(["setup", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(present.status, 0, present.stderr);
  const presentReport = JSON.parse(present.stdout);
  assert.equal(presentReport.ready, true);
  assert.equal(presentReport.shellEnvironmentPolicy.available, true);
  assert.equal(presentReport.shellEnvironmentPolicy.present, true);
  assert.match(presentReport.shellEnvironmentPolicy.detail, /table is present/i);
  assert.match(presentReport.shellEnvironmentPolicy.detail, /Presence does not prove the policy restricts the write-run shell environment\./);

  fs.writeFileSync(configPath, "[shell_environment_policy\n", "utf8");
  const unparseable = runCompanion(["setup", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox)
  });
  assert.equal(unparseable.status, 0, unparseable.stderr);
  const unparseableReport = JSON.parse(unparseable.stdout);
  assert.equal(unparseableReport.ready, true);
  assert.equal(unparseableReport.shellEnvironmentPolicy.available, false);
  assert.equal(unparseableReport.shellEnvironmentPolicy.present, false);
});

test("setup reports grok doctor as unavailable when the subcommand is missing", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["setup", "--json"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_DOCTOR_UNAVAILABLE: "1" }),
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.doctorCommand.available, false);
  assert.equal(report.ready, true);
  assert.deepEqual(readInvocations(sandbox.argsFile), [["--version"], ["doctor", "--help"]]);

  const rendered = runCompanion(["setup"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_DOCTOR_UNAVAILABLE: "1" }),
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /grok doctor: not available/);
});

test("Grok child environment removes Claude integration state and disables implicit context bridges", async (t) => {
  const sandbox = makeSandbox(t);
  const envFile = path.join(sandbox.root, "child-env.json");
  const enabledBridges = Object.fromEntries(bridgeEnvironmentKeys.map((key) => [key, "true"]));
  const env = envFor(sandbox, {
    ...enabledBridges,
    CLAUDE_CODE_SESSION_ID: "claude-session-secret",
    CLAUDE_CODE_PRIVATE_TOKEN: "claude-code-secret",
    CLAUDE_PLUGIN_ROOT: "/private/plugin/root",
    CLAUDE_PLUGIN_PRIVATE_TOKEN: "claude-plugin-secret",
    ANTHROPIC_API_KEY: "anthropic-secret",
    CODEX_API_KEY: "codex-secret",
    OPENAI_API_KEY: "openai-secret",
    XAI_API_KEY: "xai-test-auth",
    DATABASE_URL: "postgres://user:password@db.example.test/app",
    REDIS_URL: "redis://user:password@redis.example.test/0",
    SENTRY_DSN: "https://public:secret@sentry.example.test/1",
    SSH_AUTH_SOCK: "/private/ssh-agent.sock",
    GROK_CLAUDE_MARKER_OVERRIDE: "marker-secret",
    _GROK_CLAUDE_MARKER_OVERRIDE: "private-marker-secret",
    GROK_MEMORY: "1",
    GROK_SUBAGENTS: "1",
    GROK_MANAGED_MCPS_ENABLED: "true",
    GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: "true",
    GROK_WEB_FETCH: "1",
    GROK_TEST_VERSION: "9.9.9",
    GROK_SANDBOX: "inherited-sandbox",
    GROK_LEADER_SOCKET: "/tmp/inherited-leader.sock",
    GROK_AUTO_WAKE: "1",
    GROK_SUBAGENTS_MAX_DEPTH: "99",
    GROK_WEB_FETCH_PROXY: "http://proxy.example.test",
    GROK_WEB_FETCH_ALLOW_LOCAL: "1",
    GROK_COMPANION_CONTINUITY_POLICY: "claude-session",
    RUST_LOG: "off",
    FAKE_GROK_ENV_FILE: envFile,
    FAKE_GROK_MODE: "ok",
  });
  const result = await runGrok(directOptions(sandbox, "ok", { env }));

  assert.equal(result.exitCode, 0);
  const childEnv = JSON.parse(fs.readFileSync(envFile, "utf8"));
  assert.ok(!Object.keys(childEnv).some((key) => key.startsWith("CLAUDE_CODE_")));
  assert.ok(!Object.keys(childEnv).some((key) => key.startsWith("CLAUDE_PLUGIN_")));
  for (const key of ["ANTHROPIC_API_KEY", "CODEX_API_KEY", "OPENAI_API_KEY", "DATABASE_URL", "REDIS_URL", "SENTRY_DSN", "SSH_AUTH_SOCK", "GROK_CLAUDE_MARKER_OVERRIDE", "_GROK_CLAUDE_MARKER_OVERRIDE"]) {
    assert.equal(childEnv[key], undefined, key);
  }
  assert.equal(childEnv.XAI_API_KEY, "xai-test-auth");
  assert.equal(childEnv.GROK_DISABLE_AUTOUPDATER, "1");
  assert.equal(childEnv.GROK_MANAGED_MCPS_ENABLED, "false");
  assert.equal(childEnv.GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED, "false");
  assert.equal(childEnv.GROK_WEB_FETCH, "0");
  assert.equal(childEnv.GROK_MEMORY, "0");
  assert.equal(childEnv.GROK_SUBAGENTS, "0");
  assert.equal(childEnv.GROK_AUTO_WAKE, "false");
  for (const key of ["GROK_TEST_VERSION", "GROK_SANDBOX", "GROK_LEADER_SOCKET", "GROK_SUBAGENTS_MAX_DEPTH", "GROK_WEB_FETCH_PROXY", "GROK_WEB_FETCH_ALLOW_LOCAL"]) {
    assert.equal(childEnv[key], undefined, key);
  }
  assert.equal(childEnv.GROK_COMPANION_CONTINUITY_POLICY, undefined);
  assert.equal(childEnv.RUST_LOG, "xai_grok_agent::builder=debug,xai_grok_sandbox=warn");
  assert.equal(path.isAbsolute(childEnv.TMPDIR), true);
  assert.equal(path.dirname(childEnv.TMPDIR), fs.realpathSync(os.tmpdir()));
  assert.match(path.basename(childEnv.TMPDIR), /^grok-companion-run-/);
  assert.equal(fs.existsSync(childEnv.TMPDIR), false);
  for (const key of bridgeEnvironmentKeys) {
    assert.equal(childEnv[key], "false", key);
  }
});

test("web-enabled managed runs enable Grok web fetch for the child", async (t) => {
  const sandbox = makeSandbox(t);
  const envFile = path.join(sandbox.root, "web-child-env.json");
  const env = envFor(sandbox, {
    GROK_WEB_FETCH: "0",
    FAKE_GROK_ENV_FILE: envFile,
    FAKE_GROK_MODE: "ok"
  });
  const result = await runGrok(directOptions(sandbox, "ok", { env, web: true }));

  assert.equal(result.exitCode, 0);
  const childEnv = JSON.parse(fs.readFileSync(envFile, "utf8"));
  assert.equal(childEnv.GROK_WEB_FETCH, "1");
});

test("explicit task memory overrides inherited Grok memory only for that child", async (t) => {
  const sandbox = makeSandbox(t);
  const envFile = path.join(sandbox.root, "memory-child-env.json");
  const env = envFor(sandbox, {
    GROK_MEMORY: "0",
    FAKE_GROK_ENV_FILE: envFile,
    FAKE_GROK_MODE: "ok",
  });
  const result = await runGrok(directOptions(sandbox, "ok", { env, memory: true }));

  assert.equal(result.exitCode, 0);
  const childEnv = JSON.parse(fs.readFileSync(envFile, "utf8"));
  assert.equal(childEnv.GROK_MEMORY, "1");
});

for (const [mode, warning] of [
  ["sandbox-unsupported-warning", "Sandbox not supported on this platform, continuing without sandbox"],
  ["sandbox-built-without-enforce-warning", "Sandbox enforcement unavailable (built without 'enforce' feature)"],
  ["tool-allowlist-warning", "tools allowlist had unmappable entries; keeping full grok toolset"],
  ["tool-disallowed-warning", "disallowedTools entry matched nothing"],
]) {
  test(`the ${mode} warning terminates Grok before unsafe activity`, async (t) => {
    const sandbox = makeSandbox(t);
    const sentinel = path.join(sandbox.root, `${mode}.sentinel`);
    const result = await runGrok(directOptions(sandbox, mode, {
      env: envFor(sandbox, {
        FAKE_GROK_MODE: mode,
        FAKE_GROK_SANDBOX_SENTINEL: sentinel,
      }),
    }));

    assert.notEqual(result.exitCode, 0);
    assert.match(result.errorMessage, new RegExp(warning.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    assert.equal(fs.existsSync(sentinel), false);
  });
}

test("companion persistence classifies tool policy enforcement failures", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "inspect the repository"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_MODE: "tool-allowlist-warning" })
  });

  assert.notEqual(result.status, 0);
  const [record] = jobRecords(sandbox.dataDir);
  assert.equal(record.failureKind, "policy");
  assert.match(record.errorMessage, /tool policy enforcement failed/i);
});

test("an unmatched disallowed tool warning fails a managed run closed", async (t) => {
  const sandbox = makeSandbox(t);
  const grokBin = path.join(sandbox.root, "fake-grok-with-unmatched-disallow.cjs");
  fs.writeFileSync(
    grokBin,
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const result = spawnSync(process.execPath, [${JSON.stringify(fakeGrok)}, "--disallowed-tools", "unmodeled_tool", ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`,
    { mode: 0o755 }
  );

  const result = await runGrok(directOptions(sandbox, "ok", {
    env: envFor(sandbox, {
      GROK_BIN: grokBin,
      FAKE_GROK_MODE: "ok"
    })
  }));

  assert.equal(result.securityFailureKind, "policy");
  assert.match(result.stderrTail, /WARN disallowedTools entry matched nothing agent=grok-test tool=unmodeled_tool/);
  assert.match(result.stderrTail, /tools allowlist applied/);
  assert.match(result.errorMessage, /tool policy enforcement failed/i);
});

test("sandbox startup failure never receives the managed prompt", async (t) => {
  const sandbox = makeSandbox(t);
  const stdinFile = path.join(sandbox.root, "sandbox-failure-stdin.txt");
  const result = await runGrok(directOptions(sandbox, "sandbox-warning", {
    env: envFor(sandbox, {
      FAKE_GROK_MODE: "sandbox-warning",
      FAKE_GROK_STDIN_FILE: stdinFile,
    }),
  }));

  assert.equal(result.securityFailureKind, "sandbox");
  assert.match(result.errorMessage, /sandbox enforcement failed/i);
  assert.equal(fs.existsSync(stdinFile), false);
});

for (const mode of [
  "sandbox-event-wrong-profile",
  "sandbox-event-wrong-workspace",
  "sandbox-event-unenforced",
  "sandbox-event-wrong-network",
  "sandbox-event-missing-tmpdir",
  "sandbox-no-event",
]) {
  test(`${mode} fails closed before prompt delivery`, async (t) => {
    const sandbox = makeSandbox(t);
    const stdinFile = path.join(sandbox.root, `${mode}-stdin.txt`);
    const result = await runGrok(directOptions(sandbox, mode, {
      env: envFor(sandbox, {
        FAKE_GROK_MODE: mode,
        FAKE_GROK_STDIN_FILE: stdinFile,
        GROK_COMPANION_SANDBOX_HANDSHAKE_MS: "100",
      }),
    }));

    assert.equal(result.securityFailureKind, "sandbox");
    assert.match(result.errorMessage, /sandbox enforcement failed/i);
    assert.equal(fs.existsSync(stdinFile), false);
  });
}

test("sandbox event log rotation fails closed before prompt delivery", async (t) => {
  const sandbox = makeSandbox(t);
  const grokHome = path.join(sandbox.root, "grok-home");
  const eventFile = path.join(grokHome, "sandbox-events.jsonl");
  const stdinFile = path.join(sandbox.root, "sandbox-rotation-stdin.txt");
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(eventFile, `${JSON.stringify({ event_type: "ProfileApplied" })}\n`, "utf8");

  const result = await runGrok(directOptions(sandbox, "sandbox-log-rotate", {
    env: envFor(sandbox, {
      FAKE_GROK_MODE: "sandbox-log-rotate",
      FAKE_GROK_STDIN_FILE: stdinFile,
      GROK_HOME: grokHome,
    }),
  }));

  assert.equal(result.securityFailureKind, "sandbox");
  assert.match(result.errorMessage, /rotated during startup/i);
  assert.equal(fs.existsSync(stdinFile), false);
});

test("sandbox event log truncation fails closed before prompt delivery", async (t) => {
  const sandbox = makeSandbox(t);
  const grokHome = path.join(sandbox.root, "grok-home");
  const eventFile = path.join(grokHome, "sandbox-events.jsonl");
  const stdinFile = path.join(sandbox.root, "sandbox-truncation-stdin.txt");
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(eventFile, `${JSON.stringify({ event_type: "ProfileApplied", padding: "x".repeat(1024) })}\n`, "utf8");

  const result = await runGrok(directOptions(sandbox, "sandbox-log-truncate", {
    env: envFor(sandbox, {
      FAKE_GROK_MODE: "sandbox-log-truncate",
      FAKE_GROK_STDIN_FILE: stdinFile,
      GROK_HOME: grokHome,
    }),
  }));

  assert.equal(result.securityFailureKind, "sandbox");
  assert.match(result.errorMessage, /truncated(?: or rewritten)? during startup/i);
  assert.equal(fs.existsSync(stdinFile), false);
});

test("parallel runs in one workspace bind sandbox evidence to their private TMPDIR", async (t) => {
  const sandbox = makeSandbox(t);
  const grokHome = path.join(sandbox.root, "shared-grok-home");
  const sharedEnv = {
    GROK_HOME: grokHome,
    FAKE_GROK_SANDBOX_EVENT_DELAY_MS: "75"
  };
  const [first, second] = await Promise.all([
    runGrok(directOptions(sandbox, "parallel-first", {
      env: envFor(sandbox, { ...sharedEnv, FAKE_GROK_MODE: "ok" }),
      logFile: path.join(sandbox.root, "parallel-first.log")
    })),
    runGrok(directOptions(sandbox, "parallel-second", {
      env: envFor(sandbox, { ...sharedEnv, FAKE_GROK_MODE: "ok" }),
      logFile: path.join(sandbox.root, "parallel-second.log")
    }))
  ]);

  for (const result of [first, second]) {
    assert.equal(result.exitCode, 0);
    assert.equal(result.securityFailureKind, null);
    assert.equal(result.parseError, null);
  }
});

test("another parallel run's sandbox failure cannot poison valid startup evidence", async (t) => {
  const sandbox = makeSandbox(t);
  const grokHome = path.join(sandbox.root, "shared-failure-grok-home");
  const sharedEnv = {
    GROK_HOME: grokHome,
    FAKE_GROK_SANDBOX_EVENT_DELAY_MS: "75"
  };
  const [failed, valid] = await Promise.all([
    runGrok(directOptions(sandbox, "parallel-failed", {
      env: envFor(sandbox, { ...sharedEnv, FAKE_GROK_MODE: "sandbox-warning" }),
      logFile: path.join(sandbox.root, "parallel-failed.log")
    })),
    runGrok(directOptions(sandbox, "parallel-valid", {
      env: envFor(sandbox, { ...sharedEnv, FAKE_GROK_MODE: "ok" }),
      logFile: path.join(sandbox.root, "parallel-valid.log")
    }))
  ]);

  assert.equal(failed.securityFailureKind, "sandbox");
  assert.equal(valid.exitCode, 0);
  assert.equal(valid.securityFailureKind, null);
});

test("a managed run fails when Grok does not confirm the tool allowlist", async (t) => {
  const sandbox = makeSandbox(t);
  const stdinFile = path.join(sandbox.root, "unverified-policy-stdin.txt");
  const options = directOptions(sandbox, "tool-policy-no-evidence", {
    env: envFor(sandbox, {
      FAKE_GROK_MODE: "tool-policy-no-evidence",
      FAKE_GROK_STDIN_FILE: stdinFile,
    }),
  });
  const expectedPrompt = fs.readFileSync(options.briefFile, "utf8");
  const result = await runGrok(options);

  assert.equal(fs.readFileSync(stdinFile, "utf8"), expectedPrompt);
  assert.equal(result.securityFailureKind, "policy");
  assert.match(result.errorMessage, /without confirming that the requested tool allowlist was applied/i);
});

test("a JSON envelope larger than the in-memory stdout window remains parseable", async (t) => {
  const sandbox = makeSandbox(t);
  const result = await runGrok(directOptions(sandbox, "large-stdout-json"));

  assert.equal(result.exitCode, 0);
  assert.equal(result.parseError, null);
  assert.equal(result.requestId, "req-large-stdout");
  assert.ok(result.text.length > 1024 * 1024);
  assert.ok(result.text.startsWith("large-output-begins:"));
  assert.ok(result.text.endsWith(":large-output-ends"));
});

test("a successful Grok exit cleans residual processes from its owned process group", async (t) => {
  const sandbox = makeSandbox(t);
  const pidFile = path.join(sandbox.root, "residual-process-group.json");
  const result = await runGrok(directOptions(sandbox, "residual-process-group", {
    env: envFor(sandbox, {
      FAKE_GROK_MODE: "residual-process-group",
      FAKE_GROK_DESCENDANT_PID_FILE: pidFile
    })
  }));

  assert.equal(result.exitCode, 0);
  const { leader, descendant } = JSON.parse(fs.readFileSync(pidFile, "utf8"));
  assert.equal(processGroupAlive(leader), false);
  assert.throws(() => process.kill(descendant, 0));
});

test("complete headless metrics survive execution, JSON delivery, and job persistence", async (t) => {
  const directSandbox = makeSandbox(t);
  const direct = await runGrok(directOptions(directSandbox, "metrics-complete"));
  assert.equal(direct.requestId, "req-metrics-complete");
  assert.equal(direct.numTurns, 3);
  assert.equal(direct.totalCostUsd, 0.012);
  assert.equal(direct.totalCostUsdTicks, 120000000);
  assert.equal(direct.costIsPartial, false);
  assert.equal(direct.usageIsIncomplete, false);
  assert.equal(Object.hasOwn(direct, "modelUsageIsIncomplete"), false);
  assert.equal(direct.structuredOutput.status, "completed");
  assert.equal(direct.structuredOutputError, null);

  const companionSandbox = makeSandbox(t);
  const companionResult = runCompanion(["task", "--json", "record complete metrics"], {
    cwd: companionSandbox.workDir,
    env: envFor(companionSandbox, { FAKE_GROK_MODE: "metrics-complete" }),
  });
  assert.equal(companionResult.status, 0, companionResult.stderr);
  const payload = JSON.parse(companionResult.stdout);
  const [record] = jobRecords(companionSandbox.dataDir);
  for (const result of [payload, record]) {
    assert.equal(result.requestId, "req-metrics-complete");
    assert.equal(result.numTurns, 3);
    assert.equal(result.totalCostUsd, 0.012);
    assert.equal(result.totalCostUsdTicks, 120000000);
    assert.equal(result.costIsPartial, false);
    assert.equal(result.modelUsageIsIncomplete, false);
    assert.equal(result.structuredOutput.status, "completed");
    assert.equal(result.structuredOutputError, null);
  }

  const statsJson = runCompanion(["stats", "--json"], {
    cwd: companionSandbox.workDir,
    env: envFor(companionSandbox),
  });
  assert.equal(statsJson.status, 0, statsJson.stderr);
  assert.deepEqual(JSON.parse(statsJson.stdout).headlessMetrics, {
    turnsReportedJobs: 1,
    totalTurns: 3,
    exactCostJobs: 1,
    partialCostJobs: 0,
    unreportedCostJobs: 0,
    totalCostUsd: 0.012,
    totalCostUsdTicks: 120000000,
  });

  const statsMarkdown = runCompanion(["stats"], {
    cwd: companionSandbox.workDir,
    env: envFor(companionSandbox),
  });
  assert.equal(statsMarkdown.status, 0, statsMarkdown.stderr);
  assert.match(statsMarkdown.stdout, /Turn count coverage: 1\/1 jobs/);
  assert.match(statsMarkdown.stdout, /Observed turns: 3/);
  assert.match(statsMarkdown.stdout, /Exact cost coverage: 1 exact, 0 partial, 0 unreported/);
  assert.match(statsMarkdown.stdout, /Observed exact cost: \$0\.012/);
  assert.match(statsMarkdown.stdout, /Observed exact cost ticks: 120000000/);
});

test("cache creation input tokens are accepted and retained from an envelope", async (t) => {
  const directSandbox = makeSandbox(t);
  const direct = await runGrok(directOptions(directSandbox, "usage-cache-creation"));
  assert.equal(direct.exitCode, 0);
  assert.equal(direct.parseError, null);
  assert.deepEqual(direct.usage, {
    input_tokens: 120,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 10,
    output_tokens: 20,
    reasoning_tokens: 5,
    total_tokens: 180
  });

  const companionSandbox = makeSandbox(t);
  const result = runCompanion(["task", "--json", "retain cache creation usage"], {
    cwd: companionSandbox.workDir,
    env: envFor(companionSandbox, { FAKE_GROK_MODE: "usage-cache-creation" })
  });
  assert.equal(result.status, 0, result.stderr);
  const [record] = jobRecords(companionSandbox.dataDir);
  assert.equal(record.usage.cache_creation_input_tokens, 10);
});

for (const [mode, message] of [
  ["metrics-fractional-turns", "invalid num_turns"],
  ["metrics-lone-cost", "only one member"],
  ["metrics-inconsistent-cost", "inconsistent USD and tick"],
  ["metrics-incomplete-cost", "exact total cost pair for incomplete usage"]
]) {
  test(`${mode} is rejected as malformed transport metrics`, async (t) => {
    const sandbox = makeSandbox(t);
    const result = await runGrok(directOptions(sandbox, mode));
    assert.equal(result.exitCode, 0);
    assert.match(result.parseError, new RegExp(message, "i"));
    assert.equal(result.totalCostUsd, null);
    assert.equal(result.totalCostUsdTicks, null);
  });
}

for (const [mode, message] of [
  ["metrics-usage-array", "invalid usage object"],
  ["metrics-negative-token", "invalid usage.output_tokens"],
  ["metrics-fractional-token", "invalid usage.output_tokens"],
  ["metrics-unsafe-token", "invalid usage.input_tokens"],
  ["metrics-conflicting-flags", "conflicting aliases for usage_is_incomplete"],
  ["metrics-conflicting-token-aliases", "invalid usage.output_tokens"],
  ["metrics-reasoning-exceeds-output", "reasoning_tokens greater than usage.output_tokens"],
  ["metrics-malformed-model", "invalid counters for modelUsage"]
]) {
  test(`${mode} cannot retain an exact cost from malformed spend evidence`, async (t) => {
    const sandbox = makeSandbox(t);
    const result = await runGrok(directOptions(sandbox, mode));
    assert.equal(result.exitCode, 0);
    assert.match(result.parseError, new RegExp(message, "i"));
    assert.equal(result.totalCostUsd, null);
    assert.equal(result.totalCostUsdTicks, null);
  });
}

test("long cwd session metadata resolves through the upstream .cwd layout", (t) => {
  const sandbox = makeSandbox(t);
  const availableDirectoryBytes = 254 - Buffer.byteLength(sandbox.workDir) - Buffer.byteLength(path.sep);
  assert.ok(availableDirectoryBytes > 0);
  let longCwd = path.join(sandbox.workDir, "!".repeat(Math.min(100, availableDirectoryBytes)));
  fs.mkdirSync(longCwd, { recursive: true });
  longCwd = fs.realpathSync(longCwd);
  const encodedLongCwd = encodeURIComponent(longCwd).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  assert.ok(Buffer.byteLength(longCwd) < 255);
  assert.ok(Buffer.byteLength(encodedLongCwd) > 255);

  const grokHome = path.join(sandbox.root, "grok-home");
  const result = runCompanion(["task", "--json", "resolve long cwd metadata"], {
    cwd: longCwd,
    env: envFor(sandbox, {
      GROK_HOME: grokHome,
      FAKE_GROK_RESOLVED_MODEL: "grok-long-cwd",
      FAKE_GROK_RESOLVED_EFFORT: "high",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.resolvedModel, "grok-long-cwd");
  assert.equal(payload.resolvedEffort, "high");
  const cwdDirectories = fs.readdirSync(path.join(grokHome, "sessions"));
  const metadataDirectory = cwdDirectories.find((entry) => fs.existsSync(path.join(grokHome, "sessions", entry, ".cwd")));
  assert.ok(metadataDirectory);
  assert.equal(fs.readFileSync(path.join(grokHome, "sessions", metadataDirectory, ".cwd"), "utf8"), longCwd);
  const [record] = jobRecords(sandbox.dataDir);
  assert.equal(record.resolvedModel, "grok-long-cwd");
  assert.equal(record.resolvedEffort, "high");
});

test("short cwd session metadata uses the upstream URL encoding safe set", (t) => {
  const sandbox = makeSandbox(t);
  const specialCwdPath = path.join(sandbox.workDir, "special !'()*");
  fs.mkdirSync(specialCwdPath, { recursive: true });
  const specialCwd = fs.realpathSync(specialCwdPath);
  const grokHome = path.join(sandbox.root, "special-session-home");
  const result = runCompanion(["task", "--json", "resolve special cwd metadata"], {
    cwd: specialCwd,
    env: envFor(sandbox, {
      GROK_HOME: grokHome,
      FAKE_GROK_RESOLVED_MODEL: "grok-special-cwd",
      FAKE_GROK_RESOLVED_EFFORT: "high",
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.resolvedModel, "grok-special-cwd");
  assert.equal(payload.resolvedEffort, "high");
  const encodedCwd = encodeURIComponent(specialCwd).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  assert.ok(fs.existsSync(path.join(grokHome, "sessions", encodedCwd)));
});

test("session metadata never falls back to a unique record from the wrong cwd", (t) => {
  const sandbox = makeSandbox(t);
  let longCwd = sandbox.workDir;
  for (let index = 0; index < 5; index += 1) {
    longCwd = path.join(longCwd, `${index}-${"wrong-cwd-check".repeat(6)}`);
  }
  fs.mkdirSync(longCwd, { recursive: true });
  longCwd = fs.realpathSync(longCwd);
  const grokHome = path.join(sandbox.root, "wrong-session-home");
  const sessionId = "11111111-1111-7111-8111-111111111111";
  const wrongDirectory = path.join(grokHome, "sessions", "one-unrelated-candidate");
  fs.mkdirSync(path.join(wrongDirectory, sessionId), { recursive: true });
  fs.writeFileSync(path.join(wrongDirectory, ".cwd"), path.join(sandbox.root, "another-workspace"), "utf8");
  fs.writeFileSync(path.join(wrongDirectory, sessionId, "summary.json"), JSON.stringify({
    current_model_id: "wrong-model",
    reasoning_effort: "wrong-effort"
  }), "utf8");

  const result = runCompanion(["task", "--json", "do not use wrong cwd metadata"], {
    cwd: longCwd,
    env: envFor(sandbox, { GROK_HOME: grokHome })
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.resolvedModel, null);
  assert.equal(payload.resolvedEffort, null);
});

test("short cwd session lookup does not scan unrelated workspace directories", (t) => {
  const sandbox = makeSandbox(t);
  const grokHome = path.join(sandbox.root, "short-session-home");
  const sessionId = "11111111-1111-7111-8111-111111111111";
  const unrelatedDirectory = path.join(grokHome, "sessions", "unrelated-candidate");
  fs.mkdirSync(path.join(unrelatedDirectory, sessionId), { recursive: true });
  fs.writeFileSync(path.join(unrelatedDirectory, ".cwd"), fs.realpathSync(sandbox.workDir), "utf8");
  fs.writeFileSync(path.join(unrelatedDirectory, sessionId, "summary.json"), JSON.stringify({
    current_model_id: "scanned-model",
    reasoning_effort: "scanned-effort"
  }), "utf8");

  const result = runCompanion(["task", "--json", "use only the exact session directory"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { GROK_HOME: grokHome })
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.resolvedModel, null);
  assert.equal(payload.resolvedEffort, null);
});
