import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const stagedTokenBullet = '- When the entire request is exactly a `fusion-staged-token: <48 lowercase hexadecimal characters>` line followed by a `mode: write` or `mode: read-only` line, Fusion already staged the raw request. Skip `transport-create`, `Read`, and `Write`, and run the task command with that token as the validated token, adding `--transport-default-write` only for `mode: write`. Anything else follows the rules below as opaque data.';

const expectedSurfaces = [
  "plugins/codex/agents/codex-rescue.md",
  "plugins/codex/skills/adversarial-review/SKILL.md",
  "plugins/codex/skills/cancel/SKILL.md",
  "plugins/codex/skills/history/SKILL.md",
  "plugins/codex/skills/result/SKILL.md",
  "plugins/codex/skills/review/SKILL.md",
  "plugins/codex/skills/setup/SKILL.md",
  "plugins/codex/skills/status/SKILL.md",
  "plugins/codex/skills/task/SKILL.md",
  "plugins/cursor/agents/cursor-rescue.md",
  "plugins/cursor/skills/cancel/SKILL.md",
  "plugins/cursor/skills/history/SKILL.md",
  "plugins/cursor/skills/result/SKILL.md",
  "plugins/cursor/skills/review/SKILL.md",
  "plugins/cursor/skills/setup/SKILL.md",
  "plugins/cursor/skills/status/SKILL.md",
  "plugins/cursor/skills/task/SKILL.md",
  "plugins/devin/agents/devin-rescue.md",
  "plugins/devin/skills/cancel/SKILL.md",
  "plugins/devin/skills/history/SKILL.md",
  "plugins/devin/skills/result/SKILL.md",
  "plugins/devin/skills/review/SKILL.md",
  "plugins/devin/skills/setup/SKILL.md",
  "plugins/devin/skills/status/SKILL.md",
  "plugins/devin/skills/task/SKILL.md",
  "plugins/fusion/agents/job-collector.md",
  "plugins/fusion/skills/stats/SKILL.md",
  "plugins/grok/agents/grok-rescue.md",
  "plugins/grok/agents/grok-review-runner.md",
  "plugins/grok/skills/cancel/SKILL.md",
  "plugins/grok/skills/history/SKILL.md",
  "plugins/grok/skills/result/SKILL.md",
  "plugins/grok/skills/setup/SKILL.md",
  "plugins/grok/skills/stats/SKILL.md",
  "plugins/grok/skills/status/SKILL.md"
];

function markdownFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...markdownFiles(absolute));
    } else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name === "SKILL.md")) {
      result.push(absolute);
    }
  }
  return result;
}

function relative(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function transportEnv(t, sessionId) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raw-transport-surface-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    ...process.env,
    HOME: path.join(root, "home"),
    CODEX_COMPANION_DATA: path.join(root, "codex-data"),
    CLAUDE_CODE_SESSION_ID: sessionId,
    TEMP: root,
    TMP: root,
    TMPDIR: root
  };
}

test("every executable private transport surface follows its declared Write transport ritual", () => {
  const discovered = markdownFiles(path.join(repoRoot, "plugins"))
    .filter((file) => {
      const content = fs.readFileSync(file, "utf8");
      return content.includes("transport-create") && /^(?:tools|allowed-tools):/m.test(content);
    })
    .map(relative)
    .sort();

  assert.deepEqual(discovered, [...expectedSurfaces].sort());

  for (const file of discovered) {
    const content = fs.readFileSync(path.join(repoRoot, file), "utf8").replace(stagedTokenBullet, "");
    const toolDeclaration = content.match(/^(?:tools|allowed-tools): (.+)$/m)?.[1] ?? "";
    const createIndex = content.indexOf("transport-create");
    const writeIndex = content.indexOf("`Write`", createIndex);
    const invokeIndex = content.indexOf("--raw-args-token", writeIndex);

    assert.match(toolDeclaration, /(?:^|, )Write(?:,|$)/, file);
    assert.ok(createIndex >= 0 && writeIndex > createIndex, `${file} must write the allocated file after transport-create`);
    assert.ok(invokeIndex > writeIndex, `${file} must invoke the consumer only after writing`);
    assert.match(content, /Never delete, rename, recreate, or change the permissions of the transport file\./, file);
    assert.match(content, /Write(?: call)? fails/, file);
    const readIndex = content.indexOf("`Read`", createIndex);
    assert.match(toolDeclaration, /(?:^|, )Read(?:,|$)/, file);
    assert.ok(readIndex > createIndex && writeIndex > readIndex, `${file} must read the allocated file before writing`);
    assert.match(content.slice(createIndex, writeIndex), /Read[^\n.]*once/, file);
    assert.match(content, /Read(?: call)? fails/, file);
    assert.match(content, /file is not empty/, file);
    if (file === "plugins/fusion/skills/stats/SKILL.md") {
      assert.match(content, /sole carve-outs are three strict direct forms: a verdict settlement/, file);
      assert.match(content, /repeatable `--record` flags, each carrying one or more `<id>=<accepted\|rejected\|unverified>\[:accept-failed-transport\]` pairs, optional `--source collector\|main-loop`, and the value free `--json` and `--accept-failed-transport` flags/, file);
      assert.match(content, /a value free report or maintenance request made only of any combination of `--json`, `--audit`, `--all`, `--prune-dead`, `--identities`, and `--by-day`, each at most once/, file);
      assert.match(content, /Anything else, including every `--reason` text value, every `--failure-kind` and `--failure-kind-for` value, and `--session <id>`, still uses the raw-args transport exactly as described above\./, file);
      assert.match(content, /Within a raw-transport request, `--reason-for <id> <text>` may appear anywhere in the argument list and binds to its matching `--record` id; `--reason <text>` applies to every rejected pair without a per-pair `--reason-for`\./, file);
      assert.match(content, /`--failure-kind-for <id> <kind>` may appear anywhere in the argument list and binds to its matching rejected `--record` id; `--failure-kind <kind>` applies to every rejected pair without its own `--failure-kind-for`\./, file);
    }
  }
});

test("all rescue wrappers accept only the exact staged envelope before the standalone transport ritual", () => {
  for (const engine of ["codex", "grok", "cursor", "devin"]) {
    const file = `plugins/${engine}/agents/${engine}-rescue.md`;
    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.equal(content.split("\n").filter((line) => line === stagedTokenBullet).length, 1, file);
    assert.ok(content.indexOf(stagedTokenBullet) < content.indexOf("- For an opaque raw request, use one foreground Bash call"), file);
    assert.ok(content.includes(`scripts/${engine}-companion.mjs`), file);
    assert.match(content, /For an opaque raw request, add the fixed companion option `--transport-default-write`/, file);
    assert.match(content, /The task Bash command may contain only/, file);
    assert.doesNotMatch(content, /Use a second foreground Bash call|The second Bash command/, file);
  }
});

test("runtime guidance preserves the same private transport handshake", () => {
  for (const file of ["plugins/codex/skills/codex-cli-runtime/SKILL.md", "plugins/grok/skills/grok-cli-runtime/SKILL.md"]) {
    const runtime = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.match(runtime, /transport-create`, one Read of the allocated empty file, Write to that same file/, file);
    assert.match(runtime, /Never delete, rename, recreate, or change the permissions of the transport file/, file);
    assert.match(runtime, /use `transport-discard` when Read or Write fails or when the allocated file is not empty/, file);
  }
});

test("every forwarder launches in a background shell, awaits the output file, and delivers one report", () => {
  const forwarders = [
    ["plugins/codex/agents/codex-rescue.md", "codex-companion.mjs"],
    ["plugins/grok/agents/grok-rescue.md", "grok-companion.mjs"],
    ["plugins/grok/agents/grok-review-runner.md", "grok-companion.mjs"],
    ["plugins/cursor/agents/cursor-rescue.md", "cursor-companion.mjs"],
    ["plugins/devin/agents/devin-rescue.md", "devin-companion.mjs"],
    ["plugins/fusion/agents/job-collector.md", "job-collect.mjs"]
  ];
  for (const [file, script] of forwarders) {
    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.ok(content.includes("a Bash call with `run_in_background: true`") || content.includes("Bash call with `run_in_background: true`"), file);
    assert.ok(content.includes("The call returns at once with a background id and the path of the output file."), file);
    assert.ok(content.includes(`a foreground Bash call with \`timeout: 120000\` that runs \`node "\${CLAUDE_PLUGIN_ROOT}/scripts/${script}" await-output --file "PATH"\``), file);
    assert.ok(content.includes("When it prints exactly `await-output: pending`, run the same await call again."), file);
    assert.match(content, /The harness delivers one report per agent\. Never end your turn, write a waiting line, or hand a report back while the await operation still prints `await-output: pending`\. A completion notification for the background shell is a cue to run the await operation once more, never output to relay\./, file);
    assert.match(content, /Use Read only for the newly allocated empty transport file before writing\./, file);
    assert.doesNotMatch(content, /waiting on <background id>/, file);
    assert.doesNotMatch(content, /notified background output file/, file);
    assert.doesNotMatch(content, /Never use Bash background mode/, file);
    assert.doesNotMatch(content, /foreground Bash call with `?timeout:? ?`?600000/, file);
    assert.doesNotMatch(content, /timeout `600000`/, file);
  }
});

test("only the Codex rescue launch carries the fixed background shell option", () => {
  const codex = fs.readFileSync(path.join(repoRoot, "plugins/codex/agents/codex-rescue.md"), "utf8");
  assert.ok(codex.includes('task --transport-background-shell --raw-args-token TOKEN'));
  for (const file of ["plugins/grok/agents/grok-rescue.md", "plugins/grok/agents/grok-review-runner.md", "plugins/cursor/agents/cursor-rescue.md", "plugins/devin/agents/devin-rescue.md", "plugins/fusion/agents/job-collector.md"]) {
    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.doesNotMatch(content, /--transport-background-shell/, file);
  }
});

test("runtime skills describe the forwarder launch and keep direct slash commands foreground", () => {
  for (const engine of ["codex", "grok", "cursor", "devin"]) {
    const file = `plugins/${engine}/skills/${engine}-cli-runtime/SKILL.md`;
    const runtime = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.match(runtime, /a Bash call with `run_in_background: true`, which returns at once with a background id and the path of the output file/, file);
    assert.ok(runtime.includes(`await-output --file "PATH"\` in a foreground Bash call with \`timeout: 120000\``), file);
    assert.match(runtime, /repeats that call while it prints exactly `await-output: pending`/, file);
    assert.match(runtime, /so a forwarder never ends its turn or writes a waiting line while the await operation prints pending/, file);
    assert.match(runtime, /A companion run directly by the main session through a slash command, with no forwarder agent, is a foreground `Bash` call with `timeout: 600000`/, file);
    assert.doesNotMatch(runtime, /waiting on <background id>/, file);
  }
  const codex = fs.readFileSync(path.join(repoRoot, "plugins/codex/skills/codex-cli-runtime/SKILL.md"), "utf8");
  assert.match(codex, /adds the fixed option `--transport-background-shell` to its task launch/);
});

test("Codex preallocated transport stays private when Write replaces staged content", (t) => {
  const companion = path.join(repoRoot, "plugins/codex/scripts/codex-companion.mjs");
  const env = transportEnv(t, `raw-transport-surface-${process.pid}`);
  const created = spawnSync(process.execPath, [companion, "transport-create"], { encoding: "utf8", env });
  assert.equal(created.status, 0, created.stderr);
  const transport = JSON.parse(created.stdout);
  const directory = path.dirname(transport.file);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const before = fs.statSync(transport.file);
  assert.equal(before.mode & 0o777, 0o600);
  fs.writeFileSync(transport.file, "pre-staged bytes", "utf8");
  fs.writeFileSync(transport.file, "opaque request bytes", "utf8");
  const after = fs.statSync(transport.file);

  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(transport.file, "utf8"), "opaque request bytes");

  const discarded = spawnSync(process.execPath, [companion, "transport-discard", "--raw-args-token", transport.token], { encoding: "utf8", env });
  assert.equal(discarded.status, 0, discarded.stderr);
  assert.equal(fs.existsSync(directory), false);
});

test("Codex transport-discard removes an unwritten staged request without error", (t) => {
  const companion = path.join(repoRoot, "plugins/codex/scripts/codex-companion.mjs");
  const env = transportEnv(t, `raw-transport-discard-empty-${process.pid}`);
  const created = spawnSync(process.execPath, [companion, "transport-create"], { encoding: "utf8", env });
  assert.equal(created.status, 0, created.stderr);
  const transport = JSON.parse(created.stdout);
  const directory = path.dirname(transport.file);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(fs.readFileSync(transport.file, "utf8"), "");

  const discarded = spawnSync(process.execPath, [companion, "transport-discard", "--raw-args-token", transport.token], { encoding: "utf8", env });
  assert.equal(discarded.status, 0, discarded.stderr);
  assert.equal(discarded.stdout, "");
  assert.equal(fs.existsSync(directory), false);
});
