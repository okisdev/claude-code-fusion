import fs from "node:fs";
import path from "node:path";

export function ensurePrivateDirectories(directories, mode = 0o700) {
  for (const directory of directories) {
    fs.mkdirSync(directory, { recursive: true, mode });
    fs.chmodSync(directory, mode);
  }
}

export function ensureHomeLink(target, link, type) {
  const stats = fs.lstatSync(link, { throwIfNoEntry: false });
  if (stats && (!stats.isSymbolicLink() || fs.readlinkSync(link) !== target)) removePrivateHome(link);
  if (!fs.lstatSync(link, { throwIfNoEntry: false })) fs.symlinkSync(target, link, type);
}

export function removePrivateHome(homeDir) {
  let stats;
  try { stats = fs.lstatSync(homeDir); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (stats.isDirectory()) {
    fs.chmodSync(homeDir, stats.mode | 0o700);
    for (const name of fs.readdirSync(homeDir)) removePrivateHome(path.join(homeDir, name));
  }
  fs.rmSync(homeDir, { recursive: true, force: true });
}
