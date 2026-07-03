#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function readManifestHashes(manifestPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return new Set(Array.isArray(parsed.hashes) ? parsed.hashes : []);
  } catch {
    return new Set();
  }
}

function writeAtomic(target, content) {
  const tmpPath = target + ".tmp-" + process.pid;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, target);
}

function main() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) {
    return;
  }

  const canonicalPath = path.join(pluginRoot, "rules", "orchestration.md");
  let canonical;
  try {
    canonical = fs.readFileSync(canonicalPath, "utf8");
  } catch {
    return;
  }
  const canonicalHash = sha256(canonical);

  const manifestPath = path.join(pluginRoot, "rules-manifest.json");
  const liveFile =
    process.env.FUSION_RULES_FILE || path.join(os.homedir(), ".claude", "rules", "orchestration.md");

  if (!fs.existsSync(liveFile)) {
    fs.mkdirSync(path.dirname(liveFile), { recursive: true });
    writeAtomic(liveFile, canonical);
    console.log("fusion: routing rules installed (run /fusion:setup for the optional permission check)");
    return;
  }

  const liveHash = sha256(fs.readFileSync(liveFile, "utf8"));
  if (liveHash === canonicalHash) {
    return;
  }

  if (readManifestHashes(manifestPath).has(liveHash)) {
    writeAtomic(liveFile, canonical);
    console.log("fusion: routing rules updated to the current plugin version");
    return;
  }

  console.log(
    "fusion: local edits detected in ~/.claude/rules/orchestration.md, run /fusion:setup to reconcile with the plugin's newer rules"
  );
}

try {
  main();
} catch {
  process.exit(0);
}

process.exit(0);
