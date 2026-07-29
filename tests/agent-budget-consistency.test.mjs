import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");

function readMaxTurns(agent) {
  const contents = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "agents", `${agent}.md`), "utf8");
  const frontmatter = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(frontmatter, `${agent} must have frontmatter`);
  const maxTurns = frontmatter[1].match(/^maxTurns:\s*(\d+)\s*$/m);
  assert.ok(maxTurns, `${agent} frontmatter must define maxTurns`);
  return Number.parseInt(maxTurns[1], 10);
}

// These must stay at 2x the base workerLimits turn budgets in worker-lifecycle.mjs (claude-worker 60, deep-reasoner 30, trivial-worker 16) so a sizing: large brief cannot be undercut by the harness frontmatter cap.
test("agent frontmatter turn caps accommodate large briefs", () => {
  assert.equal(readMaxTurns("claude-worker"), 120);
  assert.equal(readMaxTurns("deep-reasoner"), 60);
  assert.equal(readMaxTurns("trivial-worker"), 32);
});
