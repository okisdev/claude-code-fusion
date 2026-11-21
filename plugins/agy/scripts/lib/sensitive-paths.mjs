import fs from "node:fs";
import path from "node:path";

export const SENSITIVE_HOME_DIRS = [
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config", ".local/share", ".gemini",
  ".claude", ".codex", ".grok", ".cursor", ".devin", "Library/Keychains", "Library/Application Support"
];
export const SENSITIVE_HOME_FILES = [".netrc", ".npmrc", ".git-credentials"];

function within(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function realpathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function withCanonical(paths) {
  return [...new Set(paths.flatMap((entry) => [entry, realpathOrNull(entry)]).filter(Boolean))];
}

export function isSensitivePath(target, realHome) {
  const homes = withCanonical([path.resolve(realHome)]);
  const directories = withCanonical(homes.flatMap((home) => SENSITIVE_HOME_DIRS.map((directory) => path.join(home, directory))));
  const files = withCanonical(homes.flatMap((home) => SENSITIVE_HOME_FILES.map((file) => path.join(home, file))));
  return directories.some((directory) => within(target, directory)) || files.includes(target);
}

export function isReadablePath(target, realHome) {
  if (typeof target !== "string" || !path.isAbsolute(target)) return false;
  const resolved = realpathOrNull(target);
  return resolved !== null && !isSensitivePath(path.resolve(target), realHome) && !isSensitivePath(resolved, realHome);
}
