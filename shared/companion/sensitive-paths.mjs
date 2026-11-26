import fs from "node:fs";
import path from "node:path";

export const SENSITIVE_HOME_DIRS = [
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config", ".local/share", ".gemini",
  ".claude", ".codex", ".grok", ".cursor", ".devin", "Library/Keychains", "Library/Application Support"
];
export const SENSITIVE_HOME_FILES = [".netrc", ".npmrc", ".git-credentials"];

function within(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function realpathOrNull(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

function withCanonical(paths) {
  return [...new Set(paths.flatMap((entry) => [entry, realpathOrNull(entry)]).filter(Boolean))];
}

function sensitiveHomeDirectories(homes) {
  return withCanonical(homes.flatMap((home) => SENSITIVE_HOME_DIRS.map((directory) => path.join(home, directory))));
}

export function isSensitivePath(target, realHome) {
  const homes = withCanonical([path.resolve(realHome)]);
  const directories = sensitiveHomeDirectories(homes);
  const files = withCanonical(homes.flatMap((home) => SENSITIVE_HOME_FILES.map((file) => path.join(home, file))));
  return directories.some((directory) => within(target, directory)) || files.includes(target);
}

export function isAncestorOfSensitiveHomeDirectory(target, realHome) {
  const directories = sensitiveHomeDirectories(withCanonical([path.resolve(realHome)]));
  return withCanonical([target]).some((entry) => directories.some((directory) => within(directory, entry)));
}

export function isReadablePath(target, realHome) {
  if (typeof target !== "string" || !path.isAbsolute(target)) return false;
  const resolved = realpathOrNull(target);
  return resolved !== null && !isSensitivePath(path.resolve(target), realHome) && !isSensitivePath(resolved, realHome);
}
