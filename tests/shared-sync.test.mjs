import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const script = path.join(repoRoot, "shared", "sync.mjs");

function runSync(scriptPath, root, ...args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd: root, encoding: "utf8" });
}

test("vendored companion files match the shared sources", () => {
  const result = runSync(script, repoRoot, "--check");
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test("check lists every drifted target and sync restores it", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companion-sync-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const shared = path.join(root, "shared");
  const companion = path.join(shared, "companion");
  fs.mkdirSync(companion, { recursive: true });
  const fixtureScript = path.join(shared, "sync.mjs");
  fs.copyFileSync(script, fixtureScript);

  const manifest = {
    "first.mjs": ["plugins/grok/first.mjs", "plugins/cursor/first.mjs"],
    "second.mjs": ["plugins/grok/second.mjs"]
  };
  fs.writeFileSync(path.join(companion, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(companion, "first.mjs"), Buffer.from([0, 255, 10]));
  fs.writeFileSync(path.join(companion, "second.mjs"), "second source\n");

  for (const [source, targets] of Object.entries(manifest)) {
    for (const target of targets) {
      const targetPath = path.join(root, target);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(path.join(companion, source), targetPath);
    }
  }

  assert.equal(runSync(fixtureScript, root, "--check").status, 0);
  fs.writeFileSync(path.join(root, manifest["first.mjs"][0]), Buffer.from([0, 254, 10]));
  fs.writeFileSync(path.join(root, manifest["first.mjs"][1]), "different");
  fs.unlinkSync(path.join(root, manifest["second.mjs"][0]));

  const drift = runSync(fixtureScript, root, "--check");
  assert.equal(drift.status, 1, drift.stderr || drift.error?.message);
  assert.deepEqual(drift.stderr.trim().split("\n"), Object.values(manifest).flat());

  const sync = runSync(fixtureScript, root);
  assert.equal(sync.status, 0, sync.stderr || sync.error?.message);
  for (const [source, targets] of Object.entries(manifest)) {
    for (const target of targets) {
      assert.deepEqual(fs.readFileSync(path.join(root, target)), fs.readFileSync(path.join(companion, source)));
    }
  }
  assert.equal(runSync(fixtureScript, root, "--check").status, 0);
});
