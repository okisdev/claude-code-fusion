import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirectories } from "./private-home.mjs";
import { writePrivateStateFile } from "./state.mjs";

export function prepareGeminiDirectory({ dataDir }) {
  const geminiDir = path.resolve(dataDir, "gemini");
  for (const entry of ["", "agy", "config", "bin", "agy/settings.json", "config/mcp_config.json", "bin/open"]) {
    const destination = path.join(geminiDir, entry);
    if (fs.lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw Object.assign(new Error(`Refusing symbolic link in private Gemini directory: ${destination}`), { failureKind: "setup" });
    }
  }
  ensurePrivateDirectories([geminiDir, path.join(geminiDir, "agy"), path.join(geminiDir, "config")]);
  writePrivateStateFile(path.join(geminiDir, "agy", "settings.json"), "{}\n");
  writePrivateStateFile(path.join(geminiDir, "config", "mcp_config.json"), '{"mcpServers":{}}\n');
  const browserBlocker = path.join(browserBlockerDir(geminiDir), "open");
  ensurePrivateDirectories([path.dirname(browserBlocker)]);
  writePrivateStateFile(browserBlocker, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(browserBlocker, 0o700);
  return { geminiDir };
}

export function browserBlockerDir(geminiDir) {
  return path.join(geminiDir, "bin");
}

export function projectConfigFiles(cwd) {
  return [".gemini", ".agents"].map((directory) => path.resolve(cwd, directory))
    .filter((directory) => fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory());
}
