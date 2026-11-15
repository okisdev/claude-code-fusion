import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { workerLimits } from "../plugins/fusion/scripts/lib/lifecycle/budget.mjs";

const repoRoot = path.join(import.meta.dirname, "..");

function readMaxTurns(agent) {
  const contents = fs.readFileSync(path.join(repoRoot, "plugins", "fusion", "agents", `${agent}.md`), "utf8");
  const frontmatter = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(frontmatter, `${agent} must have frontmatter`);
  const maxTurns = frontmatter[1].match(/^maxTurns:\s*(\d+)\s*$/m);
  assert.ok(maxTurns, `${agent} frontmatter must define maxTurns`);
  return Number.parseInt(maxTurns[1], 10);
}

test("agent frontmatter turn caps accommodate large briefs", () => {
  for (const agent of ["claude-worker", "deep-reasoner", "trivial-worker"]) {
    const largestBudget = Math.max(...["small", "medium", "large"].map((sizing) => workerLimits(agent, {}, sizing).maxTurns));
    assert.equal(readMaxTurns(agent), largestBudget, agent);
  }
});
