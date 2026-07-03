import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const redactScript = path.join(repoRoot, "bench", "redact.mjs");

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bench-redact-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runRedact(dir) {
  return spawnSync(process.execPath, [redactScript, dir], { encoding: "utf8" });
}

function parseSummary(stdout) {
  const summary = {};
  for (const line of stdout.trim().split("\n")) {
    const index = line.indexOf(":");
    if (index === -1) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = Number(line.slice(index + 1).trim());
    summary[key] = value;
  }
  return summary;
}

test("redact strips paths and credentials and is idempotent", (t) => {
  const root = makeSandbox(t);
  const home = os.homedir();
  const skToken = `sk-${"a".repeat(20)}`;
  const ghpToken = `ghp_${"b".repeat(20)}`;
  const bearerToken = `Bearer ${"c".repeat(20)}`;
  const apiKeyValue = "d".repeat(16);
  const jsonlPath = path.join(root, "run.jsonl");
  const binaryPath = path.join(root, "noise.bin");
  const embeddedPath = path.join(home, "bench-secret", "log.txt");

  const jsonlBefore = [
    JSON.stringify({ path: embeddedPath, api_key: apiKeyValue }),
    `tokens ${skToken} ${ghpToken}`,
    bearerToken,
    "",
  ].join("\n");
  fs.writeFileSync(jsonlPath, jsonlBefore, "utf8");

  const binaryBefore = Buffer.from([0x41, 0x00, 0x42]);
  fs.writeFileSync(binaryPath, binaryBefore);

  const first = runRedact(root);
  assert.strictEqual(first.status, 0, first.stderr);
  const afterFirst = fs.readFileSync(jsonlPath, "utf8");
  assert.ok(!afterFirst.includes(home), "home path should be redacted");
  assert.ok(!afterFirst.includes(skToken));
  assert.ok(!afterFirst.includes(ghpToken));
  assert.ok(!afterFirst.includes(bearerToken.slice("Bearer ".length)));
  assert.ok(!afterFirst.includes(apiKeyValue));
  assert.match(afterFirst, /\[redacted\]/);
  assert.deepStrictEqual(fs.readFileSync(binaryPath), binaryBefore);

  const summaryFirst = parseSummary(first.stdout);
  assert.strictEqual(summaryFirst["files scanned"], 2);
  assert.strictEqual(summaryFirst["files changed"], 1);
  assert.strictEqual(summaryFirst["binary skipped"], 1);
  assert.ok(summaryFirst.home >= 1);
  assert.strictEqual(summaryFirst.openai_sk, 1);
  assert.strictEqual(summaryFirst.github, 1);
  assert.strictEqual(summaryFirst.bearer, 1);
  assert.strictEqual(summaryFirst.json_secret, 1);

  const second = runRedact(root);
  assert.strictEqual(second.status, 0, second.stderr);
  const afterSecond = fs.readFileSync(jsonlPath, "utf8");
  assert.strictEqual(afterSecond, afterFirst);

  const summarySecond = parseSummary(second.stdout);
  assert.strictEqual(summarySecond["files changed"], 0);
  assert.strictEqual(summarySecond.home, 0);
  assert.strictEqual(summarySecond.openai_sk, 0);
  assert.strictEqual(summarySecond.github, 0);
  assert.strictEqual(summarySecond.bearer, 0);
  assert.strictEqual(summarySecond.json_secret, 0);
});