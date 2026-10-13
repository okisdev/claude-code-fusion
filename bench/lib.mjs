import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI_VERSION_TIMEOUT_MS = 5000;
const PLUGIN_VERSION_FILES = [
  { name: "codex", file: path.join(REPO_ROOT, "plugins", "codex", ".claude-plugin", "plugin.json") },
  { name: "fusion", file: path.join(REPO_ROOT, "plugins", "fusion", ".claude-plugin", "plugin.json") },
  { name: "grok", file: path.join(REPO_ROOT, "plugins", "grok", ".claude-plugin", "plugin.json") }
];

export function readJsonFile(file) {
  if (!file || !fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function collectPluginVersions(env = process.env) {
  const versions = {};
  const marketplace = readJsonFile(path.join(REPO_ROOT, ".claude-plugin", "marketplace.json"));
  const marketplaceVersion = marketplace?.version ?? marketplace?.metadata?.version;
  versions["claude-code-fusion"] = typeof marketplaceVersion === "string" ? marketplaceVersion : null;
  for (const source of PLUGIN_VERSION_FILES) {
    const plugin = readJsonFile(source.file);
    versions[source.name] = typeof plugin?.version === "string" ? plugin.version : null;
  }
  return versions;
}

function hasPathSeparator(bin) {
  return bin.includes("/") || (path.sep === "\\" && bin.includes("\\"));
}

function commandOnPath(bin) {
  if (hasPathSeparator(bin)) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathValue = process.env.PATH ?? "";
  return pathValue.split(path.delimiter).some((entry) => {
    if (!entry) {
      return false;
    }
    try {
      fs.accessSync(path.join(entry, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function cliVersion(bin) {
  if (!commandOnPath(bin)) {
    return null;
  }
  const result = spawnSync(bin, ["--version"], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: "utf8",
    timeout: CLI_VERSION_TIMEOUT_MS
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return text ? text.split(/\r?\n/)[0].trim() : null;
}
