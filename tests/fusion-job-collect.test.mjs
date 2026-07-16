import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const collector = path.join(repoRoot, "plugins", "fusion", "scripts", "job-collect.mjs");
const canonicalJobId = "b".repeat(32);

test("delivery and semantic metadata remain inside the collected terminal footer", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-job-collect-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const companion = path.join(root, "codex-companion.mjs");
  fs.writeFileSync(
    companion,
    `const [command, jobId] = process.argv.slice(2);\nif (jobId !== "${canonicalJobId}") process.exit(90);\nif (command === "status") process.stdout.write("job: ${canonicalJobId}\\ndelivery: background\\nsemantic: unverified\\nstate: done\\n");\nelse if (command === "result") process.stdout.write("collected result\\n");\nelse process.exit(91);\n`,
    "utf8"
  );
  const env = {
    ...process.env,
    CLAUDE_CODE_SESSION_ID: `fusion-job-collect-${process.pid}`,
    FUSION_CODEX_COMPANION: companion
  };
  const created = spawnSync(process.execPath, [collector, "transport-create"], { encoding: "utf8", env, timeout: 5_000 });
  assert.strictEqual(created.status, 0, created.stderr);
  const transport = JSON.parse(created.stdout);
  t.after(() => fs.rmSync(path.dirname(transport.file), { recursive: true, force: true }));
  fs.writeFileSync(
    transport.file,
    JSON.stringify({ engine: "codex", jobId: canonicalJobId, json: false, intervalMs: 1, capMs: 1_000, deadRerunStatus: false }),
    "utf8"
  );
  const output = spawnSync(process.execPath, [collector, "--raw-args-token", transport.token], { encoding: "utf8", env, timeout: 10_000 });
  assert.strictEqual(output.status, 0, output.stderr);
  assert.match(output.stdout, /^collected result\ncollector: state=done semantic=unverified engine=codex job=[a-f0-9]{32} elapsed=\d+s\n$/);
});

test("collector agent stages a closed request schema instead of executable text", () => {
  const agent = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "agents", "job-collector.md"), "utf8");
  assert.match(agent, /tools: Bash, Read, Write/);
  assert.match(agent, /exactly one standalone `engine: codex\|grok` line/);
  assert.match(agent, /exactly one standalone `job: <32 lowercase hexadecimal characters>` line/);
  assert.match(agent, /exactly one JSON object containing only `engine`, `jobId`, `json`, `intervalMs`, `capMs`, and `deadRerunStatus`/);
  assert.match(agent, /transport-discard --raw-args-token TOKEN/);
  assert.doesNotMatch(agent, /shell fragment.*from the prompt.*invoke/i);
});
