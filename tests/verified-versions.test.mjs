import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.join(import.meta.dirname, "..");
const verifiedVersionsPath = path.join(repoRoot, "plugins/fusion/verified-versions.json");

function readVerifiedVersions() {
  return JSON.parse(fs.readFileSync(verifiedVersionsPath, "utf8"));
}

test("verified peer CLI versions are complete and well formed", () => {
  let verifiedVersions;
  assert.doesNotThrow(() => {
    verifiedVersions = readVerifiedVersions();
  });
  assert.deepEqual(Object.keys(verifiedVersions).sort(), ["codex-cli", "grok", "verifiedAt"]);
  assert.match(verifiedVersions["codex-cli"], /^\d+\.\d+\.\d+$/);
  assert.match(verifiedVersions.grok, /^\d+\.\d+\.\d+$/);
  assert.match(verifiedVersions.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
});

test("README records the verified peer CLI versions", () => {
  const verifiedVersions = readVerifiedVersions();
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.ok(readme.includes(`codex-cli ${verifiedVersions["codex-cli"]}`));
  assert.ok(readme.includes(`grok ${verifiedVersions.grok}`));
});

test("doctor checks the verified versions source", () => {
  const doctorSkill = fs.readFileSync(path.join(repoRoot, "plugins/fusion/skills/doctor/SKILL.md"), "utf8");
  assert.ok(doctorSkill.includes("verified-versions.json"));
});
