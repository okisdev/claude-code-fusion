import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  envFor,
  flagValues,
  hasPair,
  makeSandbox,
  readInvocations as readHarnessInvocations,
  repoRoot,
  runCompanion,
} from "./lib/companion-harness.mjs";

const cliRuntimeSkill = path.join(repoRoot, "plugins", "grok", "skills", "grok-cli-runtime", "SKILL.md");
const { parseArgs } = await import(path.join(repoRoot, "plugins", "grok", "scripts", "lib", "args.mjs"));
const codexHarness = await import("./lib/codex-companion-harness.mjs");
const { parseServiceTier } = await import(path.join(repoRoot, "plugins", "codex", "scripts", "lib", "args.mjs"));
const { buildTaskArgs: buildCodexTaskArgs } = await import(path.join(repoRoot, "plugins", "codex", "scripts", "lib", "codex-exec.mjs"));
const { buildGrokArgs, NESTED_ENGINE_CLI_DENY_NAMES } = await import(
  path.join(repoRoot, "plugins", "grok", "scripts", "lib", "grok-exec.mjs"),
);
const { resolveLastSessionId, validateResumeSessionId } = await import(
  path.join(repoRoot, "plugins", "grok", "scripts", "grok-companion.mjs"),
);
const { createJobRecord, jobFilePath, writeBrief, writeJobRecordFile } = await import(
  path.join(repoRoot, "plugins", "grok", "scripts", "lib", "state.mjs"),
);

const consultAllows = ["Read", "Grep"];
const consultTools = "read_file,grep,list_dir";
const consultWebTools = "read_file,grep,list_dir,web_search,web_fetch";
const writeTools = "read_file,grep,list_dir,search_replace,run_terminal_cmd";
const tournamentTools = `${writeTools},Agent`;
const nonTournamentDisallowedTools = "Agent,search_tool,use_tool,ask_user_question";
const tournamentDisallowedTools = "search_tool,use_tool,ask_user_question";

const consultDenies = ["Edit", "Write", "Bash", "MCPTool(*)"];

const writeDenies = [
  "Bash(sudo*)",
  "Bash(rm -rf*)",
  "Bash(git push*)",
  "Bash(gh*)",
  "MCPTool(*)",
  "Bash(grok*)",
  "Bash(claude*)",
  "Bash(codex*)",
];

function readInvocations(argsFile) {
  return readHarnessInvocations(argsFile, { splitInlineFlags: true });
}

function singleInvocation(sandbox) {
  const invocations = readInvocations(sandbox.argsFile);
  assert.strictEqual(invocations.length, 1);
  return invocations[0];
}

function seedFinishedSessionJob(sandbox, fields) {
  const briefFile = writeBrief(sandbox.dataDir, sandbox.workDir, fields.id, "seeded session job");
  const record = {
    ...createJobRecord({
      id: fields.id,
      pid: null,
      mode: fields.mode ?? "consult",
      cwd: sandbox.workDir,
      briefFile,
      background: false,
      claudeSessionId: fields.claudeSessionId,
      createdAt: fields.createdAt,
      jobClass: "task",
    }),
    status: "done",
    finishedAt: fields.finishedAt,
    sessionId: fields.sessionId,
    resultText: "done",
    request: {
      model: null,
      effort: null,
      web: false,
      resumeSessionId: null,
      sandboxProfile: Object.hasOwn(fields, "sandboxProfile")
        ? fields.sandboxProfile
        : "strict",
    },
  };
  writeJobRecordFile(jobFilePath(sandbox.dataDir, sandbox.workDir, fields.id), record);
}

test("Codex service tiers default to priority, accept an explicit id, and omit none", () => {
  assert.ok(hasPair(buildCodexTaskArgs(), "-c", "service_tier=priority"));
  assert.ok(hasPair(buildCodexTaskArgs({ serviceTier: "flex" }), "-c", "service_tier=flex"));
  assert.ok(!buildCodexTaskArgs({ serviceTier: parseServiceTier("none") }).includes("-c"));
});

test("Codex rejects invalid service tiers as typed input", (t) => {
  const invalidSandbox = codexHarness.makeSandbox(t);
  const invalidResult = codexHarness.runCompanion(["task", "--json", "--service-tier", "Priority", "reject this"], {
    cwd: invalidSandbox.workDir,
    env: codexHarness.envFor(invalidSandbox)
  });
  assert.strictEqual(invalidResult.status, 1);
  const failure = JSON.parse(invalidResult.stderr);
  assert.strictEqual(failure.failureKind, "input");
  assert.match(failure.message, /--service-tier option must be a lowercase id or none/);
});

test("help and runtime skill list history, cancel, and setup flags", (t) => {
  const sandbox = makeSandbox(t);
  const help = runCompanion(["--help"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes("cancel <job-id> [--cwd <dir>] [--json]"));
  assert.ok(help.stdout.includes("history [--all] [--limit <n>] [--cwd <dir>] [--json]"));
  assert.ok(help.stdout.includes("setup [--continuity <manual|claude-session>] [--enable-stop-gate] [--disable-stop-gate] [--json]"));
  const skill = fs.readFileSync(cliRuntimeSkill, "utf8");
  assert.ok(skill.includes("status [job-id] [--cwd <dir>] [--json]"));
  assert.ok(skill.includes("cancel <job-id> [--cwd <dir>] [--json]"));
  assert.ok(skill.includes("history [--all] [--limit <n>] [--cwd <dir>] [--json]"));
  assert.ok(skill.includes("setup [--continuity <manual|claude-session>] [--enable-stop-gate] [--disable-stop-gate] [--json]"));
});

test("consult task argv pins the strict sandbox and hard read-only tool surface", (t) => {
  const sandbox = makeSandbox(t);
  const stdinFile = path.join(sandbox.root, "consult-stdin.txt");
  const result = runCompanion(["task", "hello there"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, { FAKE_GROK_STDIN_FILE: stdinFile }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  const briefFile = flagValues(argv, "--prompt-file")[0];
  assert.strictEqual(briefFile, "/dev/stdin");
  assert.strictEqual(fs.readFileSync(stdinFile, "utf8"), "hello there");
  assert.ok(hasPair(argv, "--output-format", "json"));
  assert.ok(hasPair(argv, "--sandbox", "strict"));
  assert.ok(argv.includes("--no-auto-update"));
  assert.ok(argv.includes("--no-subagents"));
  assert.ok(argv.includes("--disable-web-search"));
  assert.ok(hasPair(argv, "--max-turns", "60"));
  assert.ok(hasPair(argv, "--permission-mode", "default"));
  assert.ok(hasPair(argv, "--tools", consultTools));
  assert.ok(hasPair(argv, "--disallowed-tools", nonTournamentDisallowedTools));
  assert.deepStrictEqual([...flagValues(argv, "--allow")].sort(), [...consultAllows].sort());
  const denyRules = flagValues(argv, "--deny");
  for (const rule of consultDenies) {
    assert.ok(denyRules.includes(rule), rule);
  }
  assert.ok(denyRules.some((rule) => /Read\(.+\/auth\.json\)$/.test(rule)));
  assert.ok(denyRules.includes("Read(**/.grok/sessions/**)"));
  assert.ok(!argv.includes("-m"), "Model must not be passed by default.");
  assert.ok(!argv.includes("--effort"), "Effort must not be passed by default.");
  assert.ok(!argv.includes("--always-approve"));
  assert.ok(!argv.includes("--best-of-n"));
  assert.ok(!argv.includes("-r"));
  assert.ok(!argv.includes("Bash(gh pr view*)"));
  assert.ok(!argv.includes("Bash(git diff*)"));
  assert.ok(!argv.some((entry) => /node --test|npm test/.test(entry)));
});

test("model and effort are forwarded only when explicitly provided", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--model", "grok-4-fast", "--effort", "high", "hello"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(hasPair(argv, "-m", "grok-4-fast"));
  assert.ok(hasPair(argv, "--effort", "high"));
});

test("inline values split at the first equals sign", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--model=grok=custom=latest", "hello"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(hasPair(argv, "-m", "grok=custom=latest"));
});

test("custom Grok homes with glob metacharacters fail before unsafe deny rules are built", () => {
  assert.throws(
    () => buildGrokArgs({ mode: "consult", cwd: "/tmp", env: { GROK_HOME: "/tmp/grok[prod" } }),
    (error) => error?.failureKind === "setup" && /glob metacharacters/.test(error.message)
  );
});

test("custom Grok homes with commas fail before unsafe deny rules are built", () => {
  assert.throws(
    () => buildGrokArgs({ mode: "consult", cwd: "/tmp", env: { GROK_HOME: "/tmp/grok,prod" } }),
    (error) => error?.failureKind === "setup" && /cannot be denied safely/.test(error.message)
  );
});

test("direct Grok argument construction omits unsupported no-auto-update", () => {
  const argv = buildGrokArgs({ mode: "consult", cwd: "/tmp", capabilities: new Set() });
  assert.ok(!argv.includes("--no-auto-update"));
});

test("write task argv includes its explicit tool surface, always-approve, and safety deny rules", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--write", "change the code"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(argv.includes("--always-approve"));
  assert.ok(hasPair(argv, "--sandbox", "strict"));
  assert.ok(hasPair(argv, "--tools", writeTools));
  assert.ok(hasPair(argv, "--disallowed-tools", nonTournamentDisallowedTools));
  const denyRules = flagValues(argv, "--deny");
  for (const rule of writeDenies) {
    assert.ok(denyRules.includes(rule), rule);
  }
  assert.ok(denyRules.some((rule) => /Read\(.+\/auth\.json\)$/.test(rule)));
  assert.ok(denyRules.includes("Read(**/.grok/sessions/**)"));
  assert.ok(hasPair(argv, "--max-turns", "60"));
  assert.ok(argv.includes("--no-subagents"));
  assert.ok(!argv.includes("-m"));
  assert.ok(!argv.includes("--effort"));
});

test("best-of-n argv enables Agent, keeps meta tools disabled, implies write mode, and keeps the denies", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--best-of-n", "2", "compete on this"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(hasPair(argv, "--best-of-n", "2"));
  assert.ok(!argv.includes("--no-subagents"));
  assert.ok(hasPair(argv, "--tools", tournamentTools));
  assert.ok(hasPair(argv, "--disallowed-tools", tournamentDisallowedTools));
  assert.ok(argv.includes("--always-approve"));
  const denyRules = flagValues(argv, "--deny");
  for (const rule of writeDenies) {
    assert.ok(denyRules.includes(rule), rule);
  }
  assert.ok(denyRules.includes("Read(**/.grok/auth.json)"));
});

test("resume maps to -r with the given session uuid", (t) => {
  const sandbox = makeSandbox(t);
  const stdinFile = path.join(sandbox.root, "resume-stdin.txt");
  const uuid = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
  seedFinishedSessionJob(sandbox, {
    id: "explicit-resume",
    claudeSessionId: "claude-current",
    sessionId: uuid,
    createdAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
  });
  const result = runCompanion(["task", "--resume", uuid, "continue with the plan"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, {
      CLAUDE_CODE_SESSION_ID: "claude-current",
      FAKE_GROK_STDIN_FILE: stdinFile,
    }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(hasPair(argv, "-r", uuid));
  assert.strictEqual(flagValues(argv, "--prompt-file")[0], "/dev/stdin");
  assert.strictEqual(fs.readFileSync(stdinFile, "utf8"), "continue with the plan");
});

test("resume without a prompt sends the pinned continuation text", (t) => {
  const sandbox = makeSandbox(t);
  const stdinFile = path.join(sandbox.root, "promptless-resume-stdin.txt");
  const uuid = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
  seedFinishedSessionJob(sandbox, {
    id: "promptless-resume",
    claudeSessionId: "claude-current",
    sessionId: uuid,
    createdAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
  });
  const result = runCompanion(["task", "--resume", uuid], {
    cwd: sandbox.workDir,
    env: envFor(sandbox, {
      CLAUDE_CODE_SESSION_ID: "claude-current",
      FAKE_GROK_STDIN_FILE: stdinFile,
    }),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(hasPair(argv, "-r", uuid));
  assert.strictEqual(flagValues(argv, "--prompt-file")[0], "/dev/stdin");
  assert.strictEqual(
    fs.readFileSync(stdinFile, "utf8"),
    "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.",
  );
});

test("resume last stays within the current Claude session and falls back only without one", (t) => {
  const sandbox = makeSandbox(t);
  seedFinishedSessionJob(sandbox, {
    id: "current-older",
    claudeSessionId: "claude-current",
    sessionId: "11111111-1111-7111-8111-111111111111",
    createdAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
  });
  seedFinishedSessionJob(sandbox, {
    id: "other-newer",
    claudeSessionId: "claude-other",
    sessionId: "22222222-2222-7222-8222-222222222222",
    createdAt: "2026-01-02T00:00:00.000Z",
    finishedAt: "2026-01-02T00:01:00.000Z",
  });

  assert.strictEqual(
    resolveLastSessionId(sandbox.dataDir, sandbox.workDir, "claude-current"),
    "11111111-1111-7111-8111-111111111111",
  );
  assert.throws(
    () => resolveLastSessionId(sandbox.dataDir, sandbox.workDir, "claude-missing"),
    /No finished consult grok task with a compatible sandbox and memory mode was found for Claude session claude-missing/,
  );
  assert.strictEqual(
    resolveLastSessionId(sandbox.dataDir, sandbox.workDir, null),
    "22222222-2222-7222-8222-222222222222",
  );
});

test("resume selection is mode and sandbox compatible", (t) => {
  const sandbox = makeSandbox(t);
  const consultSession = "33333333-3333-7333-8333-333333333333";
  const writeSession = "44444444-4444-7444-8444-444444444444";
  seedFinishedSessionJob(sandbox, {
    id: "compatible-consult",
    claudeSessionId: "claude-current",
    sessionId: consultSession,
    createdAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
  });
  seedFinishedSessionJob(sandbox, {
    id: "compatible-write",
    claudeSessionId: "claude-current",
    sessionId: writeSession,
    mode: "write",
    createdAt: "2026-01-02T00:00:00.000Z",
    finishedAt: "2026-01-02T00:01:00.000Z",
  });

  assert.strictEqual(resolveLastSessionId(sandbox.dataDir, sandbox.workDir, "claude-current", "consult"), consultSession);
  assert.strictEqual(resolveLastSessionId(sandbox.dataDir, sandbox.workDir, "claude-current", "write"), writeSession);
  assert.strictEqual(validateResumeSessionId(sandbox.dataDir, sandbox.workDir, consultSession, "consult"), consultSession);
  assert.throws(
    () => validateResumeSessionId(sandbox.dataDir, sandbox.workDir, consultSession, "write"),
    /recorded sandbox profile is incompatible/,
  );
});

test("legacy sessions without a recorded sandbox profile fail closed", (t) => {
  const sandbox = makeSandbox(t);
  const sessionId = "55555555-5555-7555-8555-555555555555";
  seedFinishedSessionJob(sandbox, {
    id: "legacy-session",
    claudeSessionId: "claude-current",
    sessionId,
    createdAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    sandboxProfile: null,
  });

  assert.throws(
    () => validateResumeSessionId(sandbox.dataDir, sandbox.workDir, sessionId, "consult"),
    /recorded sandbox profile is incompatible/,
  );
  assert.throws(
    () => resolveLastSessionId(sandbox.dataDir, sandbox.workDir, "claude-current", "consult"),
    /compatible sandbox/,
  );
});

test("known option tokens are rejected where a value is expected", (t) => {
  const sandbox = makeSandbox(t);
  assert.throws(
    () =>
      parseArgs(["--resume", "--resume-last"], {
        valueOptions: ["resume"],
        booleanOptions: ["resume-last"],
      }),
    /Missing value for --resume/,
  );
  const result = runCompanion(["task", "--resume", "--resume-last"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /^state: error$/m);
  assert.match(result.stderr, /^failure: input$/m);
  assert.strictEqual(readInvocations(sandbox.argsFile).length, 0);
});

test("normal task arguments reject invalid booleans and unknown leading options", (t) => {
  const invalidBoolean = makeSandbox(t);
  const invalidBooleanResult = runCompanion(["task", "--background=maybe", "hello"], {
    cwd: invalidBoolean.workDir,
    env: envFor(invalidBoolean),
  });
  assert.notStrictEqual(invalidBooleanResult.status, 0);
  assert.match(invalidBooleanResult.stderr, /Invalid boolean value for --background: maybe/);
  assert.match(invalidBooleanResult.stderr, /^failure: input$/m);
  assert.strictEqual(readInvocations(invalidBoolean.argsFile).length, 0);

  const unknownOption = makeSandbox(t);
  const unknownOptionResult = runCompanion(["task", "--backgroun", "hello"], {
    cwd: unknownOption.workDir,
    env: envFor(unknownOption),
  });
  assert.notStrictEqual(unknownOptionResult.status, 0);
  assert.match(unknownOptionResult.stderr, /Unknown option --backgroun/);
  assert.match(unknownOptionResult.stderr, /Use -- before prompt text that begins with a dash/);
  assert.match(unknownOptionResult.stderr, /^failure: input$/m);
  assert.strictEqual(readInvocations(unknownOption.argsFile).length, 0);
});

test("normal task option parsing stops at the prompt or an explicit delimiter", (t) => {
  const suffix = makeSandbox(t);
  const suffixStdin = path.join(suffix.root, "suffix-stdin.txt");
  const suffixResult = runCompanion(["task", "explain", "--background", "without detaching"], {
    cwd: suffix.workDir,
    env: envFor(suffix, { FAKE_GROK_STDIN_FILE: suffixStdin }),
  });
  assert.strictEqual(suffixResult.status, 0, suffixResult.stderr);
  assert.strictEqual(fs.readFileSync(suffixStdin, "utf8"), "explain --background without detaching");
  assert.match(suffixResult.stdout, /^state: done$/m);

  const delimited = makeSandbox(t);
  const delimitedStdin = path.join(delimited.root, "delimited-stdin.txt");
  const delimitedResult = runCompanion(["task", "--", "--background", "is prompt text"], {
    cwd: delimited.workDir,
    env: envFor(delimited, { FAKE_GROK_STDIN_FILE: delimitedStdin }),
  });
  assert.strictEqual(delimitedResult.status, 0, delimitedResult.stderr);
  assert.strictEqual(fs.readFileSync(delimitedStdin, "utf8"), "--background is prompt text");
  assert.match(delimitedResult.stdout, /^state: done$/m);
});

test("max-turns is overridable from the command line", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--max-turns", "7", "hello"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.deepStrictEqual(flagValues(argv, "--max-turns"), ["7"]);
});

test("best-of-n outside 2 to 10 is rejected", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--best-of-n", "11", "hello"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /between 2 and 10/);
  assert.strictEqual(readInvocations(sandbox.argsFile).length, 0);
});

test("write task argv omits the gh read-only allow rules", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--write", "change the code"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.strictEqual(flagValues(argv, "--allow").length, 0);
  assert.ok(!argv.includes("Bash(gh pr view)"));
  assert.ok(!argv.includes("Bash(gh api*)"));
});

test("NESTED_ENGINE_CLI_DENY_NAMES expands into write Bash denies", () => {
  const nestedEngineCliDenyRules = (names) => names.map((name) => `Bash(${name}*)`);
  const hypothetical = "peer-engine";
  const extended = nestedEngineCliDenyRules([...NESTED_ENGINE_CLI_DENY_NAMES, hypothetical]);
  const writeDeny = flagValues(buildArgv({ mode: "write" }), "--deny");
  for (const rule of nestedEngineCliDenyRules(NESTED_ENGINE_CLI_DENY_NAMES)) {
    assert.ok(writeDeny.includes(rule));
  }
  assert.strictEqual(extended.at(-1), `Bash(${hypothetical}*)`);
  assert.deepStrictEqual(
    extended.slice(0, -1),
    nestedEngineCliDenyRules(NESTED_ENGINE_CLI_DENY_NAMES),
  );
});

test("consult denies every shell, MCP, edit, delegation, and meta-tool surface", () => {
  const argv = buildArgv({ mode: "consult" });
  const denies = flagValues(argv, "--deny");
  for (const rule of ["Edit", "Write", "Bash", "MCPTool(*)"]) {
    assert.ok(denies.includes(rule), `Expected ${rule} in consult deny rules.`);
  }
  assert.ok(hasPair(argv, "--disallowed-tools", nonTournamentDisallowedTools));
});

test("web flag drops the web search disable and stays consult", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--web", "research this"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(!argv.includes("--disable-web-search"));
  assert.ok(hasPair(argv, "--permission-mode", "default"));
  assert.ok(hasPair(argv, "--tools", consultWebTools));
  assert.ok(!argv.includes("--always-approve"));
});

const consultWebAllows = ["WebSearch", "WebFetch"];

test("consult with web true appends web tool allow rules", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "--web", "research this"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.deepStrictEqual(flagValues(argv, "--allow"), [...consultAllows, ...consultWebAllows]);
  assert.ok(hasPair(argv, "--tools", consultWebTools));
  assert.ok(!argv.includes("--disable-web-search"));
});

test("consult with web false omits web tool allow rules", () => {
  const argv = buildArgv({ mode: "consult", web: false });
  assert.deepStrictEqual(flagValues(argv, "--allow"), consultAllows);
  assert.ok(hasPair(argv, "--tools", consultTools));
  assert.ok(!flagValues(argv, "--allow").includes("WebSearch"));
  assert.ok(!flagValues(argv, "--allow").includes("WebFetch"));
  assert.ok(argv.includes("--disable-web-search"));
});

test("write mode never gains web tool allow rules", () => {
  for (const web of [true, false, undefined]) {
    const argv = buildArgv({ mode: "write", web });
    assert.strictEqual(flagValues(argv, "--allow").length, 0);
    assert.ok(hasPair(argv, "--tools", web ? `${writeTools},web_search,web_fetch` : writeTools));
    assert.ok(hasPair(argv, "--disallowed-tools", nonTournamentDisallowedTools));
    assert.ok(!argv.includes("WebSearch"));
    assert.ok(!argv.includes("WebFetch"));
    assert.ok(argv.includes("--always-approve"));
  }
});

const consultAllowEnv = { GROK_CONSULT_ALLOW: "Read(src/**), Bash(jq*), WebFetch(example.com)" };

function buildArgv(overrides = {}) {
  return buildGrokArgs({ briefFile: "/tmp/grok-brief.txt", ...overrides });
}

test("GROK_CONSULT_ALLOW retains only complete read and web permissions and cannot add shell capability", () => {
  const argv = buildArgv({
    mode: "consult",
    env: { GROK_CONSULT_ALLOW: `${consultAllowEnv.GROK_CONSULT_ALLOW}, Read(src/**) Bash(*)` },
  });
  const allows = flagValues(argv, "--allow");
  assert.deepStrictEqual(allows.slice(0, consultAllows.length), consultAllows);
  assert.deepStrictEqual(allows.slice(consultAllows.length), ["Read(src/**)", "WebFetch(example.com)"]);
  assert.ok(!allows.includes("Bash(jq*)"));
  assert.ok(!allows.includes("Read(src/**) Bash(*)"));
  assert.ok(hasPair(argv, "--tools", consultTools));
});

test("GROK_CONSULT_ALLOW is ignored in write mode", () => {
  const argv = buildArgv({ mode: "write", env: consultAllowEnv });
  assert.strictEqual(flagValues(argv, "--allow").length, 0);
  assert.ok(!argv.includes("Read(src/**)"));
  assert.ok(!argv.includes("WebFetch(example.com)"));
});

test("GROK_CONSULT_ALLOW treats unset, empty, and whitespace only entries as no extra allows", () => {
  for (const env of [{}, { GROK_CONSULT_ALLOW: "" }, { GROK_CONSULT_ALLOW: "   " }]) {
    const argv = buildArgv({ mode: "consult", env });
    assert.deepStrictEqual(flagValues(argv, "--allow"), consultAllows);
  }
  const argv = buildArgv({ mode: "consult", env: { GROK_CONSULT_ALLOW: "  ,  , Read(src/**), Bash(jq*)  " } });
  assert.deepStrictEqual(flagValues(argv, "--allow"), [...consultAllows, "Read(src/**)"]);
});
