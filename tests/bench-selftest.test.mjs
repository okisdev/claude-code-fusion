import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const tasksDir = path.join(repoRoot, "bench", "tasks");

function discoverSelftests() {
  if (!fs.existsSync(tasksDir)) {
    return [];
  }
  return fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(tasksDir, entry.name, "selftest.sh"))
    .filter((selftest) => fs.existsSync(selftest));
}

const selftests = discoverSelftests();

test("bench/tasks has at least one mutant self test", () => {
  assert.ok(selftests.length > 0, "expected at least one bench/tasks/*/selftest.sh");
});

for (const selftest of selftests) {
  const taskDir = path.dirname(selftest);
  const taskId = path.basename(taskDir);
  test(`mutant self test passes for ${taskId}`, () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    const result = spawnSync("bash", [selftest], {
      cwd: taskDir,
      env,
      encoding: "utf8",
      timeout: 60000
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS/);
  });
}
