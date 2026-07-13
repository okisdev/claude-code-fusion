#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hashRulesTemplate } from "./lib/rules-template.mjs";

const repoRoot = path.join(import.meta.dirname, "..", "..", "..");
const rulesPath = path.join("plugins", "fusion", "rules", "orchestration.md");

function git(args, cwd = repoRoot) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function buildRulesManifest({ root = repoRoot, relativeRulesPath = rulesPath } = {}) {
  const commits = git(["log", "HEAD", "--format=%H", "--", relativeRulesPath], root).split("\n").filter(Boolean);
  const hashes = new Set();

  for (const commit of commits) {
    let content;
    try {
      content = git(["show", `${commit}:${relativeRulesPath}`], root);
    } catch {
      continue;
    }
    hashes.add(hashRulesTemplate(content));
  }

  hashes.add(hashRulesTemplate(fs.readFileSync(path.join(root, relativeRulesPath), "utf8")));

  return { format: 2, hashes: [...hashes].sort() };
}

export function main({ root = repoRoot, relativeRulesPath = rulesPath, stdout = console.log } = {}) {
  const manifest = buildRulesManifest({ root, relativeRulesPath });
  const manifestPath = path.join(root, "plugins", "fusion", "rules-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  stdout(`fusion: wrote ${manifest.hashes.length} unique rules template version(s) to ${manifestPath}`);
  return manifest;
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  main();
}
