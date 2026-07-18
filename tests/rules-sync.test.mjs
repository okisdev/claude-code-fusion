import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildRulesManifest } from "../plugins/fusion/scripts/generate-rules-manifest.mjs";
import { hashRulesTemplate, renderRulesContent } from "../plugins/fusion/scripts/lib/rules-template.mjs";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "plugins", "fusion", "scripts", "rules-sync.mjs");

const CANONICAL = `# Orchestration policy

canonical rules content

<!-- fusion:model-table:start -->
Engine capability table: run /fusion:config to score your configured engines (intelligence, taste, cost, 1 to 5) and regenerate this block. Until scored, route by the qualitative lane descriptions in this document.
<!-- fusion:model-table:end -->

canonical routing footer
`;
const OLD_VERSION = "# Orchestration policy\n\nold rules content\n";
const UNKNOWN_VERSION = "# Orchestration policy\n\nhand edited by the user\n";

function runCommand(root, command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout;
}

function runGit(root, args) {
  return runCommand(root, "git", args);
}

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-rules-sync-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginRoot = path.join(root, "plugin");
  fs.mkdirSync(path.join(pluginRoot, "rules"), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "rules", "orchestration.md"), CANONICAL, "utf8");
  fs.writeFileSync(
    path.join(pluginRoot, "rules-manifest.json"),
    `${JSON.stringify({ format: 2, hashes: [hashRulesTemplate(CANONICAL), hashRulesTemplate(OLD_VERSION)] }, null, 2)}\n`,
    "utf8"
  );
  const rulesFile = path.join(root, "live", "orchestration.md");
  const modelRoutingFile = path.join(root, "model-routing.json");
  return { root, pluginRoot, rulesFile, modelRoutingFile };
}

function run(sandbox) {
  return spawnSync(process.execPath, [script], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: sandbox.pluginRoot,
      FUSION_RULES_FILE: sandbox.rulesFile,
      FUSION_MODEL_ROUTING: sandbox.modelRoutingFile
    },
    encoding: "utf8"
  });
}

function writeModelRouting(file) {
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        updatedAt: "2026-07-04T00:00:00.000Z",
        costProfile: "peer subscriptions flat rate",
        models: [
          { id: "codex", lane: "codex", intelligence: 5, taste: 4, cost: 5, notes: "primary implementation lane" }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

test("Missing live file installs the canonical rules and prints the installed line", (t) => {
  const sandbox = makeSandbox(t);
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(
    result.stdout,
    "fusion: routing rules installed (run /fusion:setup for the optional permission check)\n"
  );
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), CANONICAL);
});

test("Live file matching the rendered canonical content prints nothing and is left untouched", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, CANONICAL, "utf8");
  const before = fs.statSync(sandbox.rulesFile).mtimeMs;
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), CANONICAL);
  assert.strictEqual(fs.statSync(sandbox.rulesFile).mtimeMs, before);
});

test("Live file matching a manifest hash gets overwritten and prints the updated line", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, OLD_VERSION, "utf8");
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "fusion: routing rules updated to the current plugin version\n");
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), CANONICAL);
});

test("Live file with unknown content is left untouched and prints the local edits line", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, UNKNOWN_VERSION, "utf8");
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(
    result.stdout,
    `fusion: ${sandbox.rulesFile} does not match any shipped rules version (local edits or a stale render), run /fusion:setup to reconcile; the scored model table is preserved\n`
  );
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), UNKNOWN_VERSION);
});

test("Rendered model scores do not look like local edits", (t) => {
  const sandbox = makeSandbox(t);
  writeModelRouting(sandbox.modelRoutingFile);
  const rendered = renderRulesContent(CANONICAL, { routingPath: sandbox.modelRoutingFile });
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, rendered, "utf8");
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), rendered);
});

test("Invalid model routing leaves the existing live table intact and warns", (t) => {
  const sandbox = makeSandbox(t);
  writeModelRouting(sandbox.modelRoutingFile);
  const rendered = renderRulesContent(CANONICAL, { routingPath: sandbox.modelRoutingFile });
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, rendered, "utf8");
  fs.writeFileSync(sandbox.modelRoutingFile, "{ not json", "utf8");
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.match(result.stderr, new RegExp(`^fusion: model routing file invalid at ${sandbox.modelRoutingFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`));
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), rendered);
});

test("Missing model routing replaces a scored live table with the placeholder", (t) => {
  const sandbox = makeSandbox(t);
  writeModelRouting(sandbox.modelRoutingFile);
  const rendered = renderRulesContent(CANONICAL, { routingPath: sandbox.modelRoutingFile });
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, rendered, "utf8");
  fs.rmSync(sandbox.modelRoutingFile, { force: true });
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), CANONICAL);
});

test("Hand edited template content still looks like local edits", (t) => {
  const sandbox = makeSandbox(t);
  const handEdited = CANONICAL.replace("canonical routing footer", "hand edited routing footer");
  fs.mkdirSync(path.dirname(sandbox.rulesFile), { recursive: true });
  fs.writeFileSync(sandbox.rulesFile, handEdited, "utf8");
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(
    result.stdout,
    `fusion: ${sandbox.rulesFile} does not match any shipped rules version (local edits or a stale render), run /fusion:setup to reconcile; the scored model table is preserved\n`
  );
  assert.strictEqual(fs.readFileSync(sandbox.rulesFile, "utf8"), handEdited);
});

test("Rules sync logs unexpected failures without blocking the session", (t) => {
  const sandbox = makeSandbox(t);
  fs.mkdirSync(sandbox.rulesFile, { recursive: true });
  const result = run(sandbox);
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
  assert.match(result.stderr, /^fusion: rules sync failed: /);
});

test("Doctor and setup describe template hash comparison for live rules", () => {
  const doctor = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "skills", "doctor", "SKILL.md"), "utf8");
  const setup = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "skills", "setup", "SKILL.md"), "utf8");
  assert.match(doctor, /hashRulesTemplate/);
  assert.match(doctor, /A user selected live model table may differ from the scored canonical table/);
  assert.match(setup, /hashRulesTemplate/);
  assert.match(setup, /do not compare raw bytes/);
  assert.match(setup, /A live table may differ from the scored canonical table/);
  assert.doesNotMatch(setup, /is identical/);
  assert.doesNotMatch(setup, /write the canonical content/);
});

test("background collection distinguishes explicit Fusion receipts from foreground peer delivery", () => {
  const rules = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "orchestration.md"), "utf8");
  const task = fs.readFileSync(path.join(repoRoot, "plugins", "codex", "skills", "task", "SKILL.md"), "utf8");
  const rescue = fs.readFileSync(path.join(repoRoot, "plugins", "codex", "skills", "rescue", "SKILL.md"), "utf8");
  assert.match(rules, /this obligation applies to a manual receipt that crosses into the main session from a detached job launched by Fusion orchestration/);
  assert.match(rules, /closed direct prompt containing exactly one standalone `engine: codex\|grok` line and one standalone `job: <32 lowercase hexadecimal characters>` line/);
  assert.match(rules, /The lifecycle binds the collected marker to this dispatch identity\./);
  assert.match(rules, /Grok companion calls also remain foreground inside their owning Agent; expected duration does not authorize managed detachment/);
  assert.doesNotMatch(rules, /Managed Grok detachment is different/);
  assert.match(rules, /Direct Codex and Grok slash commands with explicit `--background` return manual receipts for the user to inspect and collect through their status and result commands/);
  assert.match(task, /Direct users inspect progress through `\/codex:status` and collect the deliverable through `\/codex:result`; when Fusion is installed, its monitor can notify them of completion/);
  assert.match(rescue, /Direct users inspect progress through `\/codex:status` and collect the deliverable through `\/codex:result`; when Fusion is installed, its monitor can notify them of completion/);
});

test("Grok rules document source verified headless boundaries", () => {
  const rules = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "orchestration.md"), "utf8");
  const troubleshooting = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "rules", "troubleshooting.md"), "utf8");
  const runtime = fs.readFileSync(path.join(repoRoot, "plugins", "grok", "skills", "grok-cli-runtime", "SKILL.md"), "utf8");
  const doctor = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "skills", "doctor", "SKILL.md"), "utf8");
  const setup = fs.readFileSync(path.join(repoRoot, "plugins", "grok", "skills", "setup", "SKILL.md"), "utf8");
  const stats = fs.readFileSync(path.join(repoRoot, "plugins", "grok", "skills", "stats", "SKILL.md"), "utf8");
  const bestOfN = fs.readFileSync(path.join(repoRoot, "plugins", "grok", "skills", "best-of-n", "SKILL.md"), "utf8");
  const review = fs.readFileSync(path.join(repoRoot, "plugins", "grok", "skills", "review", "SKILL.md"), "utf8");
  const contract = fs.readFileSync(path.join(repoRoot, "docs", "grok-contract.md"), "utf8");
  const codexContract = fs.readFileSync(path.join(repoRoot, "docs", "codex-contract.md"), "utf8");
  const sharedContract = fs.readFileSync(path.join(repoRoot, "docs", "companion-contract.md"), "utf8");
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const security = fs.readFileSync(path.join(repoRoot, "SECURITY.md"), "utf8");
  const bridgeSentence = "The child sets all eighteen `GROK_CLAUDE_*_ENABLED`, `GROK_CURSOR_*_ENABLED`, and `GROK_CODEX_*_ENABLED` bridge variables to false; upstream currently consumes the six Claude and six Cursor cells plus the Codex sessions cell and reserves the other five Codex cells, and the child also pins `GROK_MANAGED_MCPS_ENABLED=false` because that variable has highest precedence over `[managed_mcps]` in `~/.grok/config.toml` and remote settings.";
  const subagentSentence = "Upstream parses `--no-subagents`, but the single-turn and agent resolvers do not forward it, while the interactive TUI does apply it; the hard Agent tool deny and `GROK_SUBAGENTS=0` are the effective headless controls.";
  const rustLogSentence = "Every run forces `RUST_LOG=xai_grok_agent::builder=debug,xai_grok_sandbox=warn`.";
  const bubblewrapSentence = "On Linux, a strict profile with deny paths re-executes under bubblewrap and refuses to start when `bwrap` is missing or unusable; macOS has no equivalent hard enforcement and relies on Seatbelt application plus best-effort tool denies.";

  for (const text of [rules, troubleshooting, runtime, contract, readme, security, doctor]) {
    assert.ok(text.includes(bridgeSentence), "Grok bridge isolation wording must stay synchronized");
  }

  for (const text of [rules, troubleshooting, runtime, contract, readme, security]) {
    assert.ok(text.includes(subagentSentence), "Grok headless subagent wording must stay synchronized");
  }

  for (const text of [contract, troubleshooting]) {
    assert.ok(text.includes(rustLogSentence), "Grok builder tracing filter wording must stay synchronized");
  }

  for (const text of [contract, security]) {
    assert.ok(text.includes(bubblewrapSentence), "Grok platform sandbox wording must stay synchronized");
  }

  for (const text of [rules, troubleshooting, runtime, contract]) {
    assert.match(text, /--no-subagents/);
    assert.match(text, /--disallowed-tools Agent/);
    assert.match(text, /--no-wait-for-background/);
    assert.match(text, /--background-wait-timeout/);
    assert.match(text, /--prompt-file \/dev\/stdin/);
    assert.match(text, /search_tool/);
    assert.match(text, /use_tool/);
    assert.match(text, /ask_user_question/);
  }

  for (const text of [rules, troubleshooting, runtime, contract, readme, security, bestOfN]) {
    assert.match(text, /--sandbox strict/);
    assert.doesNotMatch(text, /--sandbox workspace/);
    assert.match(text, /(?:never|no silent)[^\n.]*downgrade[^\n.]*workspace/i);
  }

  for (const text of [rules, troubleshooting, runtime, contract, readme, security]) {
    assert.match(text, /ProfileApplied/);
    assert.match(text, /ApplyFailed/);
    assert.match(text, /sandbox-events\.jsonl/);
    assert.match(text, /unique private `TMPDIR`/);
    assert.match(text, /no run id or pid/);
    assert.match(text, /unrelated `ProfileApplied` and `ApplyFailed`[^\n.]*(?:not attributed|not attributable)/);
    assert.match(text, /failure (?:events|records)[^\n.]*auxiliary/i);
    assert.match(text, /(?:(?:owned-stderr|owned stderr stream)[^\n.]*warning|warning[^\n.]*(?:owned-stderr|owned stderr stream))/i);
    assert.match(text, /handshake timeout/);
    assert.match(text, /restrict_network: true/);
    assert.match(text, /macOS[^\n.]*no-op/);
    assert.match(text, /(?:Linux[^\n.]*seccomp|seccomp[^\n.]*Linux)/);
    assert.match(text, /builder tracing/);
    assert.match(text, /(?:after[^\n.]*stdin|stdin[^\n.]*after)/);
    assert.match(text, /tools allowlist applied|allowlist applied evidence|tool allowlist evidence/);
    assert.match(text, /fallback[^\n.]*unmatched|unmatched[^\n.]*fallback/i);
    assert.match(text, /--no-auto-update/);
    assert.match(text, /_GROK_CLAUDE_MARKER_OVERRIDE/);
    assert.match(text, /absolute (?:executable )?paths/);
    assert.match(text, /aliases or functions/);
    assert.match(text, /indirect scripts/);
    assert.match(text, /not (?:a )?hard[^\n.]*(?:boundary|confinement)|hard[^\n.]*boundary requires/);
    assert.match(text, /removing `run_terminal_cmd`|removing (?:that|the terminal) tool/);
    assert.match(text, /OS-level executable or network policy/);
    assert.match(text, /system_read/);
    assert.match(text, /(?:Linux[^\n.]*`\/var`[^\n.]*`\/tmp`|`\/var`[^\n.]*`\/tmp`[^\n.]*Linux)/);
    assert.match(text, /(?:macOS[^\n.]*`\/private`[^\n.]*`~\/Library`|`\/private`[^\n.]*`~\/Library`[^\n.]*macOS)/);
    assert.match(text, /shared temporary content and substantial user application configuration and caches may (?:therefore )?be readable/i);
    assert.match(text, /best-effort Read denies/);
    assert.match(text, /mcp_credentials\.json/);
    assert.match(text, /`\*\*\/\.grok`/);
    assert.match(text, /raw path variants/i);
    assert.match(text, /symbolic links/);
    assert.match(text, /shell or indirect scripts/);
    assert.match(text, /Narrower exposure (?:requires|needs) a dedicated sandbox profile, an isolated Grok home, an authentication broker, or upstream path-level authorization/);
  }

  assert.match(rules, /Strict requests child process network restriction/);
  assert.match(rules, /event proves profile and configuration application, not actual platform network isolation/);
  assert.match(rules, /GROK_CODEX_\*_ENABLED/);
  assert.match(rules, /`search_replace` creates new files/);
  assert.match(rules, /Grok has no `write` tool id/);
  assert.match(rules, /`usage_is_incomplete` means the usage ledger may have missed open subagents/);
  assert.match(rules, /present values are observed lower bounds/);
  assert.match(rules, /10000000000 ticks per USD/);
  assert.match(rules, /always (?:permits|include) `\/tmp` and `\/var\/tmp`/);
  assert.match(rules, /all of `\/private\/var\/folders`/);
  assert.match(rules, /not the only writable temporary surface/);
  assert.match(rules, /sandbox still permits consult `read_file` to reach `~\/\.grok\/auth\.json`/i);
  assert.match(rules, /native MCP servers, plugins, or hooks/);
  assert.match(rules, /bridge variables disable compatibility imports, not native Grok configuration/);
  assert.match(rules, /--record-worker-acceptance <fusion-task-id>/);
  assert.match(rules, /literal state `uncollected`/);
  assert.match(rules, /one process pool per canonical cwd and sandbox profile/);
  assert.match(rules, /agent --no-leader stdio/);
  assert.match(troubleshooting, /shared-log disappearance or rotation/);
  assert.match(troubleshooting, /sole candidate from another cwd as a fallback/);
  assert.match(troubleshooting, /Do not rely on headless `--worktree` or `--worktree-ref`/);
  assert.match(runtime, /0600 file that is unlinked immediately after a successful open/);
  assert.match(runtime, /sole candidate from another cwd/);
  assert.match(runtime, /Upstream `model_usage` rows contain only `input`, `output`, `cacheRead`, and `modelCalls`/);
  assert.match(runtime, /observed lower bounds/);
  assert.match(review, /completely omits the structured output field/);
  for (const flag of [
    "--prompt-file",
    "--output-format",
    "--sandbox",
    "--tools",
    "--disallowed-tools",
    "--deny",
    "--max-turns",
    "--no-auto-update",
    "--permission-mode",
    "--allow",
    "--disable-web-search",
    "--always-approve",
    "--json-schema",
    "--best-of-n",
    "--no-wait-for-background",
    "--background-wait-timeout"
  ]) {
    assert.match(setup, new RegExp(flag.replaceAll("-", "\\-")));
  }
  assert.match(setup, /every per-flag verdict across the plugin surface/);
  assert.match(stats, /observed input, output, cache-read, reasoning, and total token totals/);
  assert.match(stats, /`usage_is_incomplete` means the usage ledger may have missed open subagents/);
  assert.match(stats, /job-total token and cost coverage both become incomplete/);
  assert.match(contract, /`--no-leader` is mandatory because a `\[cli\] use_leader` configuration or remote setting can silently route sessions to a shared global leader process/);
  assert.match(contract, /single session-id candidate from another cwd is never a fallback/i);
  assert.match(contract, /10000000000 ticks per USD/);
  assert.match(contract, /top-level usage, cost, and flag fields are snake_case/);
  assert.match(contract, /The only incompleteness flags are `usage_is_incomplete` and `cost_is_partial`/);
  assert.match(contract, /no `cancellation-category` field or `model_usage_is_incomplete` field/);
  assert.match(contract, /Upstream appends to `~\/\.grok\/sandbox-events\.jsonl` with no rotation or size cap/);
  assert.match(contract, /The open-source snapshot is per-crate versioned, unversioned as a release train with no tags/);
  assert.match(contract, /Upstream wires only `bypassPermissions` at spawn/);
  assert.match(contract, /Upstream ships ACP today/);
  assert.match(contract, /The companion has not adopted ACP yet and continues per-call invocation/);
  assert.match(codexContract, /failureKind: "setup".*below the tested minimum 0\.144\.0/);
  assert.match(codexContract, /Versions above the tested 0\.144\.x window remain allowed with the setup compatibility advisory/);
  assert.match(codexContract, /Codex configuration parse failures under `--strict-config`.*failureKind: "process"/);
  assert.match(sharedContract, /The Grok instance adds `sandbox`[^\n]*`transport`[^\n]*and `policy`/);
  assert.match(sharedContract, /`setup`: The installed CLI version or installation lacks a required adapter capability and fails capability preflight/);
  assert.doesNotMatch(sharedContract, /structured output that remains invalid after its corrective retry/);
  assert.match(troubleshooting, /\| setup \| Do not retry the same task against the incompatible CLI surface/);
  assert.match(rules, /`failure: setup`[^\n]*Do not retry the same task/);
  assert.match(contract, /required capability preflight failures use `setup`/);
  assert.match(runtime, /missing applicable capability fails before launch with failure kind `setup`/i);
  assert.match(setup, /failure kind `setup`/);
  assert.match(doctor, /native MCP servers, plugins, or hooks under `~\/\.grok`/);
  assert.match(doctor, /The entire Grok home is read-write under strict/);
  assert.match(doctor, /entire `~\/Library` on macOS/);
  assert.match(doctor, /best-effort Read denies cover `auth\.json`, `mcp_credentials\.json`/);
  assert.match(doctor, /raw path variants, symbolic links, and shell or indirect scripts can bypass/i);
  assert.match(doctor, /Bash\(grok inspect:\*\)/);
  assert.match(doctor, /Run `grok inspect --json` and review the reported `permissions`, `hooks`, `plugins`, `agents`, `mcpServers`, and `externalCompat` surfaces/);
  assert.match(doctor, /successful Grok collection remains unverified until `\/fusion:stats --record-worker-acceptance/i);
  for (const text of [readme, security]) {
    assert.match(text, /minimum-version enforcement can still force an update/);
    assert.match(text, /file that is unlinked (?:immediately after open|as soon as it is opened)/);
    assert.match(text, /all of `\/private\/var\/folders`/);
    assert.match(text, /native MCP servers, plugins, or hooks/);
    assert.match(text, /Narrower exposure requires a dedicated sandbox profile, an isolated Grok home, an authentication broker, or upstream path-level authorization/);
    assert.doesNotMatch(text, /Native Grok hooks have no single headless disable flag/);
  }
});

test("The shipped rules manifest contains the current rules file template hash", () => {
  const rulesPath = path.join(repoRoot, "plugins", "fusion", "rules", "orchestration.md");
  const manifestPath = path.join(repoRoot, "plugins", "fusion", "rules-manifest.json");
  const currentHash = hashRulesTemplate(fs.readFileSync(rulesPath, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.strictEqual(manifest.format, 2);
  assert.ok(
    manifest.hashes.includes(currentHash),
    "plugins/fusion/rules-manifest.json is stale, run node plugins/fusion/scripts/generate-rules-manifest.mjs"
  );
});

test("Rules manifest generator hashes only HEAD history and working tree content", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-rules-manifest-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relativeRulesPath = path.join("plugins", "fusion", "rules", "orchestration.md");
  const rulesPath = path.join(root, relativeRulesPath);
  const mainContent = "# Orchestration policy\n\nmain branch release\n";
  const branchOnlyContent = "# Orchestration policy\n\nnon-main branch only\n";
  const workingTreeContent = "# Orchestration policy\n\ncurrent working tree\n";
  const signingKey = path.join(root, "fixture-signing-key");

  fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
  runCommand(root, "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", signingKey]);
  runGit(root, ["init", "--initial-branch=main"]);
  runGit(root, ["config", "user.name", "Fusion Test"]);
  runGit(root, ["config", "user.email", "fusion-test@example.com"]);
  runGit(root, ["config", "gpg.format", "ssh"]);
  runGit(root, ["config", "gpg.ssh.program", "ssh-keygen"]);
  runGit(root, ["config", "user.signingkey", signingKey]);
  runGit(root, ["config", "commit.gpgsign", "true"]);
  fs.writeFileSync(rulesPath, mainContent, "utf8");
  runGit(root, ["add", relativeRulesPath]);
  runGit(root, ["commit", "-m", "main release"]);
  runGit(root, ["switch", "-c", "unreleased-side-branch"]);
  fs.writeFileSync(rulesPath, branchOnlyContent, "utf8");
  runGit(root, ["add", relativeRulesPath]);
  runGit(root, ["commit", "-m", "unreleased side branch"]);
  runGit(root, ["switch", "main"]);
  fs.writeFileSync(rulesPath, workingTreeContent, "utf8");

  const manifest = buildRulesManifest({ root, relativeRulesPath });

  assert.deepStrictEqual(manifest, {
    format: 2,
    hashes: [hashRulesTemplate(mainContent), hashRulesTemplate(workingTreeContent)].sort()
  });
  assert.ok(!manifest.hashes.includes(hashRulesTemplate(branchOnlyContent)));
});
