#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.join(import.meta.dirname, "..", "..", "..");
const rulesPath = path.join("plugins", "fusion", "rules", "orchestration.md");

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

const commits = git(["log", "--all", "--format=%H", "--", rulesPath]).split("\n").filter(Boolean);

const hashes = new Set();

for (const commit of commits) {
  let content;
  try {
    content = git(["show", `${commit}:${rulesPath}`]);
  } catch {
    continue;
  }
  hashes.add(sha256(content));
}

hashes.add(sha256(fs.readFileSync(path.join(repoRoot, rulesPath), "utf8")));

const sorted = [...hashes].sort();

const manifestPath = path.join(repoRoot, "plugins", "fusion", "rules-manifest.json");
fs.writeFileSync(manifestPath, `${JSON.stringify({ hashes: sorted }, null, 2)}\n`, "utf8");

console.log(`fusion: wrote ${sorted.length} unique rules version(s) to ${manifestPath}`);
