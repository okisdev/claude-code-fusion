import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");

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

test("every executable private transport surface performs the Read before Write handshake", () => {
  const discovered = markdownFiles(path.join(repoRoot, "plugins"))
    .filter((file) => {
      const content = fs.readFileSync(file, "utf8");
      return content.includes("transport-create") && /^(?:tools|allowed-tools):/m.test(content);
    })
    .map(relative)
    .sort();

  assert.deepEqual(discovered, [...expectedSurfaces].sort());

  for (const file of discovered) {
    const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const toolDeclaration = content.match(/^(?:tools|allowed-tools): (.+)$/m)?.[1] ?? "";
    const createIndex = content.indexOf("transport-create");
    const readIndex = content.indexOf("`Read`", createIndex);
    const writeIndex = content.indexOf("`Write`", readIndex);
    const invokeIndex = content.indexOf("--raw-args-token", writeIndex);

    assert.match(toolDeclaration, /(?:^|, )Read(?:,|$)/, file);
    assert.match(toolDeclaration, /(?:^|, )Write(?:,|$)/, file);
    assert.ok(createIndex >= 0 && readIndex > createIndex, `${file} must read the allocated file after transport-create`);
    assert.ok(writeIndex > readIndex, `${file} must write only after the preflight read`);
    assert.ok(invokeIndex > writeIndex, `${file} must invoke the consumer only after writing`);
    assert.match(content.slice(createIndex, writeIndex), /Read[^\n.]*once/, file);
    assert.match(content, /Never delete, rename, recreate, or change the permissions of the transport file\./, file);
    assert.match(content, /Read(?: call)? fails/, file);
    assert.match(content, /file is not empty/, file);
    assert.match(content, /Write(?: call)? fails/, file);
    if (file === "plugins/fusion/skills/stats/SKILL.md") {
      assert.match(content, /sole carve-out is a strict verdict settlement/, file);
      assert.match(content, /repeatable `--record <id>=<accepted\|rejected\|unverified>` pairs, optional `--source collector\|main-loop`, and optional `--json`/, file);
      assert.match(content, /Anything else, including every `--reason` text value, still uses the raw-args transport exactly as described above\./, file);
    }
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

test("Codex preallocated transport stays private across the Read before Write handshake", (t) => {
  const companion = path.join(repoRoot, "plugins/codex/scripts/codex-companion.mjs");
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: `raw-transport-surface-${process.pid}` };
  const created = spawnSync(process.execPath, [companion, "transport-create"], { encoding: "utf8", env });
  assert.equal(created.status, 0, created.stderr);
  const transport = JSON.parse(created.stdout);
  const directory = path.dirname(transport.file);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const before = fs.statSync(transport.file);
  assert.equal(before.mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(transport.file, "utf8"), "");
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
