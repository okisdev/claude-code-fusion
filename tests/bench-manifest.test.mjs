import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const manifestScript = path.join(repoRoot, "bench", "manifest.mjs");

function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bench-manifest-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeTask(root, id, { brief = "# brief\n", verify = "#!/bin/sh\nexit 0\n", fixture = "fixture\n" } = {}) {
  const taskDir = path.join(root, "bench", "tasks", id);
  fs.mkdirSync(path.join(taskDir, "fixtures"), { recursive: true });
  fs.writeFileSync(path.join(taskDir, "brief.md"), brief, "utf8");
  fs.writeFileSync(path.join(taskDir, "verify.sh"), verify, "utf8");
  fs.writeFileSync(path.join(taskDir, "fixtures", "input.txt"), fixture, "utf8");
}

function runManifest(args, cwd) {
  return spawnSync(process.execPath, [manifestScript, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30000
  });
}

test("manifest generates then --check passes cleanly", (t) => {
  const root = makeSandbox(t);
  writeTask(root, "T01-first");
  writeTask(root, "T02-second");

  const generated = runManifest([], root);
  assert.strictEqual(generated.status, 0, generated.stderr);
  assert.match(generated.stdout, /manifest hash: [0-9a-f]{64}/);

  const manifestPath = path.join(root, "bench", "tasks", "manifest.json");
  assert.ok(fs.existsSync(manifestPath));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.match(manifest.manifestHash, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(
    manifest.tasks.map((task) => task.id),
    ["T01-first", "T02-second"]
  );
  for (const task of manifest.tasks) {
    assert.match(task.taskSha256, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual(
      task.files.map((file) => file.path),
      ["brief.md", "fixtures/input.txt", "verify.sh"]
    );
    for (const file of task.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
    }
  }

  const checked = runManifest(["--check"], root);
  assert.strictEqual(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /up to date/);
});

test("manifest --check detects a modified verify.sh", (t) => {
  const root = makeSandbox(t);
  writeTask(root, "T01-first");

  const generated = runManifest([], root);
  assert.strictEqual(generated.status, 0, generated.stderr);

  fs.writeFileSync(path.join(root, "bench", "tasks", "T01-first", "verify.sh"), "#!/bin/sh\nexit 1\n", "utf8");

  const checked = runManifest(["--check"], root);
  assert.notStrictEqual(checked.status, 0);
  assert.match(checked.stderr, /stale/);
  assert.match(checked.stderr, /T01-first: verify\.sh changed/);
});

test("manifest --check detects a modified fixture file", (t) => {
  const root = makeSandbox(t);
  writeTask(root, "T01-first");

  const generated = runManifest([], root);
  assert.strictEqual(generated.status, 0, generated.stderr);

  fs.writeFileSync(path.join(root, "bench", "tasks", "T01-first", "fixtures", "input.txt"), "changed\n", "utf8");

  const checked = runManifest(["--check"], root);
  assert.notStrictEqual(checked.status, 0);
  assert.match(checked.stderr, /stale/);
  assert.match(checked.stderr, /T01-first: fixtures\/input\.txt changed/);
});

test("manifest --check fails when manifest.json is missing", (t) => {
  const root = makeSandbox(t);
  writeTask(root, "T01-first");

  const checked = runManifest(["--check"], root);
  assert.notStrictEqual(checked.status, 0);
  assert.match(checked.stderr, /missing/);
});

test("manifest writes an empty manifest when bench/tasks is absent", (t) => {
  const root = makeSandbox(t);

  const generated = runManifest([], root);
  assert.strictEqual(generated.status, 0, generated.stderr);
  assert.match(generated.stdout, /empty/);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "bench", "tasks", "manifest.json"), "utf8"));
  assert.deepStrictEqual(manifest.tasks, []);
});
