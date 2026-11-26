import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { test } from "node:test";

const runner = import.meta.resolve("./run.mjs");
const longDirectoryName = "a".repeat(100);
const spacedDirectoryName = "a b";

function runRunner(t, action, { tempPath = "alias", cleanupFailure = false } = {}) {
  const fallback = fs.realpathSync("/tmp");
  const parent = fs.mkdtempSync(path.join(fallback, "runner-test-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  fs.symlinkSync(parent, path.join(parent, "alias"));
  fs.mkdirSync(path.join(parent, longDirectoryName));
  fs.mkdirSync(path.join(parent, spacedDirectoryName));

  const source = `
    import childProcess from "node:child_process";
    import { EventEmitter } from "node:events";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";

    const { spawn } = childProcess;
    childProcess.spawn = (bin, args, options) => {
      const { TMPDIR, TMP, TEMP } = options.env;
      console.log(JSON.stringify([TMPDIR, TMP, TEMP]));
      const action = ${JSON.stringify(action)};
      if (action === null) {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("exit", null, "SIGUNKNOWN"));
        return child;
      }
      return spawn(bin, ["--eval", action], options);
    };
    if (${cleanupFailure}) {
      fs.rmSync = () => { throw new Error("simulated cleanup failure"); };
    }
    syncBuiltinESMExports();
    await import(${JSON.stringify(runner)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    env: { ...process.env, TMPDIR: path.join(parent, tempPath) },
    encoding: "utf8",
    timeout: 10_000
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.ok(result.stdout, result.stderr);
  const [root, tmp, temp] = JSON.parse(result.stdout);
  assert.match(path.basename(root), /^fusion-test-[A-Za-z0-9]{6}$/);
  if (path.dirname(root) === fallback) {
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  }
  assert.equal(tmp, root);
  assert.equal(temp, root);
  return { status: result.status, stderr: result.stderr, root, parent, fallback };
}

for (const [description, action, expectedStatus] of [
  ["successful child", "process.exit(0)", 0],
  ["failing child", "process.exit(1)", 1],
  ["child terminated by SIGTERM", 'process.kill(process.pid, "SIGTERM")', 128 + constants.signals.SIGTERM],
  ["child terminated by an unknown signal", null, 1]
]) {
  test(`runner preserves the result of a ${description} and removes its temp root`, (t) => {
    const { status, stderr, root, parent } = runRunner(t, action);
    assert.equal(status, expectedStatus, stderr);
    assert.equal(stderr, "");
    assert.equal(path.dirname(root), parent);
    assert.equal(fs.existsSync(root), false);
  });
}

test("runner warns on stderr when cleanup fails and preserves a successful exit", (t) => {
  const { status, stderr, root } = runRunner(t, "process.exit(0)", { cleanupFailure: true });
  assert.equal(status, 0, stderr);
  assert.ok(stderr.includes(`Could not remove test temp directory ${root}`), stderr);
  assert.match(stderr, /simulated cleanup failure/);
  assert.equal(fs.existsSync(root), true);
});

for (const [description, tempPath] of [
  ["cannot resolve", "missing"],
  ["is too long for Unix sockets", longDirectoryName],
  ["contains a space", spacedDirectoryName]
]) {
  test(`runner falls back to /tmp when the configured temp directory ${description}`, (t) => {
    const { status, stderr, root, fallback } = runRunner(t, "process.exit(0)", { tempPath });
    assert.equal(status, 0, stderr);
    assert.equal(path.dirname(root), fallback);
    assert.equal(fs.existsSync(root), false);
  });
}
