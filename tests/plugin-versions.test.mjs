import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8"));
}

test("marketplace and plugin manifest versions stay synchronized", () => {
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const entries = new Map(marketplace.plugins.map((entry) => [entry.name, entry]));
  assert.deepEqual([...entries.keys()].sort(), ["codex", "cursor", "fusion", "grok"]);
  for (const name of entries.keys()) {
    const manifest = readJson(`plugins/${name}/.claude-plugin/plugin.json`);
    assert.equal(entries.get(name)?.version, marketplace.version);
    assert.equal(manifest.version, marketplace.version);
  }
  const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  assert.match(changelog, new RegExp(`^## ${marketplace.version.replaceAll(".", "\\.")}$`, "m"));
});
