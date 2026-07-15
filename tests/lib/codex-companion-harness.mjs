import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const companion = path.join(repoRoot, "plugins", "codex", "scripts", "codex-companion.mjs");
export const fakeCodex = path.join(repoRoot, "tests", "fake-codex");

export function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-codex-companion-"));
  const workDir = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(workDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    argsFile: path.join(root, "args.json"),
    dataDir,
    root,
    stdinFile: path.join(root, "stdin.txt"),
    workDir
  };
}

export function envFor(sandbox, extra = {}) {
  return {
    ...process.env,
    CLAUDE_CODE_SESSION_ID: "claude-session-1",
    CODEX_BIN: fakeCodex,
    CODEX_COMPANION_DATA: sandbox.dataDir,
    CODEX_COMPANION_PIDLESS_RUNNING_GRACE_MS: "50",
    CODEX_COMPANION_WAIT_POLL_MS: "10",
    FAKE_CODEX_ARGS_FILE: sandbox.argsFile,
    FAKE_CODEX_STDIN_FILE: sandbox.stdinFile,
    ...extra
  };
}

export function runCompanion(args, { cwd, env, input, timeout = 5000 } = {}) {
  return spawnSync(process.execPath, [companion, ...args], {
    cwd,
    encoding: "utf8",
    env,
    input,
    timeout
  });
}

export function spawnCompanion(args, { cwd, env } = {}) {
  return spawn(process.execPath, [companion, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

export function jobEntries(sandbox) {
  const stateRoot = path.join(sandbox.dataDir, "state");
  if (!fs.existsSync(stateRoot)) {
    return [];
  }
  const entries = [];
  for (const workspace of fs.readdirSync(stateRoot)) {
    const dir = path.join(stateRoot, workspace, "jobs");
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const file = path.join(dir, name);
      entries.push({ file, record: JSON.parse(fs.readFileSync(file, "utf8")) });
    }
  }
  return entries.sort((left, right) => String(left.record.createdAt).localeCompare(String(right.record.createdAt)));
}

export function jobRecords(sandbox) {
  return jobEntries(sandbox).map((entry) => entry.record);
}

export async function waitFor(predicate, { timeout = 3000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export function readArgs(sandbox) {
  return JSON.parse(fs.readFileSync(sandbox.argsFile, "utf8"));
}
