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
const { buildGrokArgs, NESTED_ENGINE_CLI_DENY_NAMES } = await import(
  path.join(repoRoot, "plugins", "grok", "scripts", "lib", "grok-exec.mjs"),
);
const { resolveLastSessionId } = await import(
  path.join(repoRoot, "plugins", "grok", "scripts", "grok-companion.mjs"),
);
const { createJobRecord, jobFilePath, writeBrief, writeJobRecordFile } = await import(
  path.join(repoRoot, "plugins", "grok", "scripts", "lib", "state.mjs"),
);

const consultAllows = [
  "Read",
  "Grep",
  "Bash(git diff)",
  "Bash(git diff *)",
  "Bash(git log)",
  "Bash(git log *)",
  "Bash(git show)",
  "Bash(git show *)",
  "Bash(git status)",
  "Bash(git status *)",
  "Bash(git blame)",
  "Bash(git blame *)",
  "Bash(gh pr view)",
  "Bash(gh pr view *)",
  "Bash(gh pr list)",
  "Bash(gh pr list *)",
  "Bash(gh pr diff)",
  "Bash(gh pr diff *)",
  "Bash(gh pr checks)",
  "Bash(gh pr checks *)",
  "Bash(gh issue view)",
  "Bash(gh issue view *)",
  "Bash(gh issue list)",
  "Bash(gh issue list *)",
  "Bash(gh repo view)",
  "Bash(gh repo view *)",
  "Bash(gh search)",
  "Bash(gh search *)",
  "Bash(gh run view)",
  "Bash(gh run view *)",
  "Bash(gh run list)",
  "Bash(gh run list *)",
  "Bash(gh release view)",
  "Bash(gh release view *)",
  "Bash(gh release list)",
  "Bash(gh release list *)",
  "Bash(node --test)",
  "Bash(node --test *)",
  "Bash(npm test)",
  "Bash(npm test *)",
];

const consultDenies = [
  "Edit",
  "Write",
  "Bash(*;*)",
  "Bash(*&&*)",
  "Bash(*||*)",
  "Bash(*|*)",
  "Bash(*>*)",
  "Bash(*<*)",
  "Bash(*`*)",
  "Bash(*$*)",
  "Bash(grok*)",
  "Bash(claude*)",
  "Bash(codex*)",
  "Bash(node*)",
];

const writeDenies = [
  "Bash(sudo*)",
  "Bash(rm -rf*)",
  "Bash(git push*)",
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
      mode: "consult",
      cwd: sandbox.workDir,
      briefFile,
      background: false,
      claudeSessionId: fields.claudeSessionId,
      createdAt: fields.createdAt,
    }),
    status: "done",
    finishedAt: fields.finishedAt,
    sessionId: fields.sessionId,
    resultText: "done",
  };
  writeJobRecordFile(jobFilePath(sandbox.dataDir, sandbox.workDir, fields.id), record);
}

test("help and runtime skill list cancel and setup flags", (t) => {
  const sandbox = makeSandbox(t);
  const help = runCompanion(["--help"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes("cancel <job-id> [--cwd <dir>] [--json]"));
  assert.ok(help.stdout.includes("setup [--enable-stop-gate] [--disable-stop-gate] [--json]"));
  const skill = fs.readFileSync(cliRuntimeSkill, "utf8");
  assert.ok(skill.includes("status [job-id] [--cwd <dir>] [--json]"));
  assert.ok(skill.includes("cancel <job-id> [--cwd <dir>] [--json]"));
  assert.ok(skill.includes("setup [--enable-stop-gate] [--disable-stop-gate] [--json]"));
});

test("consult task argv carries the pinned base flags and allow and deny set", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "hello there"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  const briefFile = flagValues(argv, "--prompt-file")[0];
  assert.ok(briefFile, "Expected a --prompt-file argument.");
  assert.ok(briefFile.startsWith(sandbox.dataDir), "Expected the brief to live under the data dir.");
  assert.ok(fs.readFileSync(briefFile, "utf8").includes("hello there"));
  assert.ok(hasPair(argv, "--output-format", "json"));
  assert.ok(hasPair(argv, "--sandbox", "workspace"));
  assert.ok(argv.includes("--no-subagents"));
  assert.ok(argv.includes("--disable-web-search"));
  assert.ok(hasPair(argv, "--max-turns", "25"));
  assert.ok(hasPair(argv, "--permission-mode", "dontAsk"));
  assert.deepStrictEqual([...flagValues(argv, "--allow")].sort(), [...consultAllows].sort());
  assert.deepStrictEqual([...flagValues(argv, "--deny")].sort(), [...consultDenies].sort());
  assert.ok(!argv.includes("-m"), "Model must not be passed by default.");
  assert.ok(!argv.includes("--effort"), "Effort must not be passed by default.");
  assert.ok(!argv.includes("--always-approve"));
  assert.ok(!argv.includes("--best-of-n"));
  assert.ok(!argv.includes("-r"));
  assert.ok(!argv.includes("Bash(gh pr view*)"));
  assert.ok(!argv.includes("Bash(git diff*)"));
});

test("model and effort are forwarded only when explicitly provided", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "hello", "--model", "grok-4-fast", "--effort", "high"], {
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
  const result = runCompanion(["task", "hello", "--model=grok=custom=latest"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(hasPair(argv, "-m", "grok=custom=latest"));
});

test("write task argv includes always-approve and the six deny rules", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "change the code", "--write"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(argv.includes("--always-approve"));
  assert.deepStrictEqual([...flagValues(argv, "--deny")].sort(), [...writeDenies].sort());
  assert.ok(hasPair(argv, "--max-turns", "60"));
  assert.ok(argv.includes("--no-subagents"));
  assert.ok(!argv.includes("-m"));
  assert.ok(!argv.includes("--effort"));
});

test("best-of-n argv drops no-subagents, implies write mode, and keeps the denies", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "compete on this", "--best-of-n", "2"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(hasPair(argv, "--best-of-n", "2"));
  assert.ok(!argv.includes("--no-subagents"));
  assert.ok(argv.includes("--always-approve"));
  assert.deepStrictEqual([...flagValues(argv, "--deny")].sort(), [...writeDenies].sort());
});

test("resume maps to -r with the given session uuid", (t) => {
  const sandbox = makeSandbox(t);
  const uuid = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
  const result = runCompanion(["task", "continue with the plan", "--resume", uuid], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(hasPair(argv, "-r", uuid));
  const briefFile = flagValues(argv, "--prompt-file")[0];
  assert.ok(fs.readFileSync(briefFile, "utf8").includes("continue with the plan"));
});

test("resume without a prompt sends the pinned continuation text", (t) => {
  const sandbox = makeSandbox(t);
  const uuid = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
  const result = runCompanion(["task", "--resume", uuid], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(hasPair(argv, "-r", uuid));
  const briefFile = flagValues(argv, "--prompt-file")[0];
  assert.ok(
    fs
      .readFileSync(briefFile, "utf8")
      .includes(
        "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.",
      ),
  );
});

test("resume last prefers the current Claude session and otherwise falls back to the newest job", (t) => {
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
  assert.strictEqual(
    resolveLastSessionId(sandbox.dataDir, sandbox.workDir, "claude-missing"),
    "22222222-2222-7222-8222-222222222222",
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
  assert.match(result.stderr, /^failure: error$/m);
  assert.strictEqual(readInvocations(sandbox.argsFile).length, 0);
});

test("max-turns is overridable from the command line", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "hello", "--max-turns", "7"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.deepStrictEqual(flagValues(argv, "--max-turns"), ["7"]);
});

test("best-of-n outside 2 to 10 is rejected", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "hello", "--best-of-n", "11"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /between 2 and 10/);
  assert.strictEqual(readInvocations(sandbox.argsFile).length, 0);
});

test("write task argv omits the gh read-only allow rules", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "change the code", "--write"], {
    cwd: sandbox.workDir,
    env: envFor(sandbox),
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.strictEqual(flagValues(argv, "--allow").length, 0);
  assert.ok(!argv.includes("Bash(gh pr view)"));
  assert.ok(!argv.includes("Bash(gh api*)"));
});

test("NESTED_ENGINE_CLI_DENY_NAMES expands into consult and write Bash denies", () => {
  const nestedEngineCliDenyRules = (names) => names.map((name) => `Bash(${name}*)`);
  const hypothetical = "peer-engine";
  const extended = nestedEngineCliDenyRules([...NESTED_ENGINE_CLI_DENY_NAMES, hypothetical]);
  const consultDeny = flagValues(buildArgv({ mode: "consult" }), "--deny");
  const writeDeny = flagValues(buildArgv({ mode: "write" }), "--deny");
  for (const rule of nestedEngineCliDenyRules(NESTED_ENGINE_CLI_DENY_NAMES)) {
    assert.ok(consultDeny.includes(rule));
    assert.ok(writeDeny.includes(rule));
  }
  assert.strictEqual(extended.at(-1), `Bash(${hypothetical}*)`);
  assert.deepStrictEqual(
    extended.slice(0, -1),
    nestedEngineCliDenyRules(NESTED_ENGINE_CLI_DENY_NAMES),
  );
});

test("consult deny rules block shell compound command metacharacters", () => {
  const argv = buildArgv({ mode: "consult" });
  const denies = flagValues(argv, "--deny");
  for (const rule of ["Bash(*;*)", "Bash(*&&*)", "Bash(*||*)", "Bash(*|*)", "Bash(*>*)", "Bash(*<*)", "Bash(*`*)", "Bash(*$*)"]) {
    assert.ok(denies.includes(rule), `Expected ${rule} in consult deny rules.`);
  }
});

test("web flag drops the web search disable and stays consult", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "research this", "--web"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.ok(!argv.includes("--disable-web-search"));
  assert.ok(hasPair(argv, "--permission-mode", "dontAsk"));
  assert.ok(!argv.includes("--always-approve"));
});

const consultWebAllows = ["WebSearch", "WebFetch"];

test("consult with web true appends web tool allow rules", (t) => {
  const sandbox = makeSandbox(t);
  const result = runCompanion(["task", "research this", "--web"], { cwd: sandbox.workDir, env: envFor(sandbox) });
  assert.strictEqual(result.status, 0, result.stderr);
  const argv = singleInvocation(sandbox);
  assert.deepStrictEqual(flagValues(argv, "--allow"), [...consultAllows, ...consultWebAllows]);
  assert.ok(!argv.includes("--disable-web-search"));
});

test("consult with web false omits web tool allow rules", () => {
  const argv = buildArgv({ mode: "consult", web: false });
  assert.deepStrictEqual(flagValues(argv, "--allow"), consultAllows);
  assert.ok(!flagValues(argv, "--allow").includes("WebSearch"));
  assert.ok(!flagValues(argv, "--allow").includes("WebFetch"));
  assert.ok(argv.includes("--disable-web-search"));
});

test("write mode never gains web tool allow rules", () => {
  for (const web of [true, false, undefined]) {
    const argv = buildArgv({ mode: "write", web });
    assert.strictEqual(flagValues(argv, "--allow").length, 0);
    assert.ok(!argv.includes("WebSearch"));
    assert.ok(!argv.includes("WebFetch"));
    assert.ok(argv.includes("--always-approve"));
  }
});

const consultAllowEnv = { GROK_CONSULT_ALLOW: "Bash(jq*), Bash(curl -s*)" };

function buildArgv(overrides = {}) {
  return buildGrokArgs({ briefFile: "/tmp/grok-brief.txt", ...overrides });
}

test("GROK_CONSULT_ALLOW appends extra consult allows after the built in list", () => {
  const argv = buildArgv({ mode: "consult", env: consultAllowEnv });
  const allows = flagValues(argv, "--allow");
  assert.deepStrictEqual(allows.slice(0, consultAllows.length), consultAllows);
  assert.deepStrictEqual(allows.slice(consultAllows.length), ["Bash(jq*)", "Bash(curl -s*)"]);
});

test("GROK_CONSULT_ALLOW is ignored in write mode", () => {
  const argv = buildArgv({ mode: "write", env: consultAllowEnv });
  assert.strictEqual(flagValues(argv, "--allow").length, 0);
  assert.ok(!argv.includes("Bash(jq*)"));
  assert.ok(!argv.includes("Bash(curl -s*)"));
});

test("GROK_CONSULT_ALLOW treats unset, empty, and whitespace only entries as no extra allows", () => {
  for (const env of [{}, { GROK_CONSULT_ALLOW: "" }, { GROK_CONSULT_ALLOW: "   " }]) {
    const argv = buildArgv({ mode: "consult", env });
    assert.deepStrictEqual(flagValues(argv, "--allow"), consultAllows);
  }
  const argv = buildArgv({ mode: "consult", env: { GROK_CONSULT_ALLOW: "  ,  , Bash(jq*)  " } });
  assert.deepStrictEqual(flagValues(argv, "--allow"), [...consultAllows, "Bash(jq*)"]);
});
