import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_MODEL_TABLE_PLACEHOLDER,
  MODEL_TABLE_END,
  MODEL_TABLE_START,
  modelRoutingWarning,
  readModelRoutingFile,
  renderModelTable,
  resolveModelRoutingPath
} from "./model-table.mjs";

const NORMALIZED_MODEL_TABLE_MARKER = "[[fusion:model-table:normalized]]";

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function modelTableRegionRegex() {
  return new RegExp(`(${escapeRegex(MODEL_TABLE_START)}\\r?\\n)([\\s\\S]*?)(\\r?\\n${escapeRegex(MODEL_TABLE_END)})`);
}

function trimBoundaryNewlines(value) {
  return String(value).replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

function extractModelTableRegion(content) {
  const match = modelTableRegionRegex().exec(content);
  return match ? trimBoundaryNewlines(match[2]) : null;
}

function replaceModelTableRegion(content, replacement) {
  const body = trimBoundaryNewlines(replacement);
  return content.replace(modelTableRegionRegex(), (_match, prefix, _current, suffix) => `${prefix}${body}${suffix}`);
}

function normalizeModelTableRegion(content) {
  return replaceModelTableRegion(content, NORMALIZED_MODEL_TABLE_MARKER);
}

export function hashRulesTemplate(content) {
  return sha256(normalizeModelTableRegion(content));
}

export function renderRulesContent(canonical, { routingPath = resolveModelRoutingPath(), invalidFallbackText, warn = console.error } = {}) {
  const fallback = extractModelTableRegion(canonical) ?? DEFAULT_MODEL_TABLE_PLACEHOLDER;
  const result = readModelRoutingFile(routingPath);
  if (result.ok) {
    return replaceModelTableRegion(canonical, renderModelTable(result.data));
  }
  if (result.missing) {
    return replaceModelTableRegion(canonical, fallback);
  }
  if (warn) {
    warn(modelRoutingWarning(routingPath, result.reason));
  }
  return replaceModelTableRegion(canonical, invalidFallbackText ?? fallback);
}

export function readManifestHashes(manifestPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return new Set(Array.isArray(parsed.hashes) ? parsed.hashes : []);
  } catch {
    return new Set();
  }
}

function resolveLiveRulesPath(env = process.env) {
  const override = env.FUSION_RULES_FILE;
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), ".claude", "rules", "orchestration.md");
}

function displayLiveRulesPath(liveFile, env) {
  return env.FUSION_RULES_FILE && env.FUSION_RULES_FILE.trim() ? liveFile : "~/.claude/rules/orchestration.md";
}

function writeAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmpPath = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, target);
}

export function syncRulesToLive({ pluginRoot, env = process.env, liveFile = resolveLiveRulesPath(env), routingPath = resolveModelRoutingPath(env), log = console.log } = {}) {
  if (!pluginRoot) {
    return { status: "skipped", reason: "CLAUDE_PLUGIN_ROOT is not set." };
  }

  const canonicalPath = path.join(pluginRoot, "rules", "orchestration.md");
  let canonical;
  try {
    canonical = fs.readFileSync(canonicalPath, "utf8");
  } catch {
    return { status: "skipped", reason: "Canonical rules file could not be read." };
  }

  const canonicalTemplateHash = hashRulesTemplate(canonical);
  const manifestPath = path.join(pluginRoot, "rules-manifest.json");

  if (!fs.existsSync(liveFile)) {
    const desired = renderRulesContent(canonical, { routingPath });
    writeAtomic(liveFile, desired);
    log("fusion: routing rules installed (run /fusion:setup for the optional permission check)");
    return { status: "installed", liveFile };
  }

  const live = fs.readFileSync(liveFile, "utf8");
  const desired = renderRulesContent(canonical, { routingPath, invalidFallbackText: extractModelTableRegion(live) ?? undefined });
  if (live === desired) {
    return { status: "unchanged", liveFile };
  }

  const liveTemplateHash = hashRulesTemplate(live);
  if (liveTemplateHash === canonicalTemplateHash) {
    writeAtomic(liveFile, desired);
    return { status: "rendered", liveFile };
  }

  if (readManifestHashes(manifestPath).has(liveTemplateHash)) {
    writeAtomic(liveFile, desired);
    log("fusion: routing rules updated to the current plugin version");
    return { status: "updated", liveFile };
  }

  log(
    `fusion: ${displayLiveRulesPath(liveFile, env)} does not match any shipped rules version (local edits or a stale render), run /fusion:setup to reconcile; the scored model table is preserved`
  );
  return { status: "local-edits", liveFile };
}
