import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitIsolation } from "./git-fixture.mjs";

export const repoRoot = path.join(import.meta.dirname, "..", "..");
export const companion = path.join(repoRoot, "plugins", "grok", "scripts", "grok-companion.mjs");
export const fakeGrok = path.join(repoRoot, "tests", "fake-grok");
export const stateModulePath = path.join(repoRoot, "plugins", "grok", "scripts", "lib", "state.mjs");

export function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-plugin-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const workDir = path.join(root, "work");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workDir);
  return { root, dataDir, workDir, argsFile: path.join(root, "args.jsonl") };
}

export function envFor(sandbox, extra = {}, options = {}) {
  const env = { ...process.env };
  for (const key of [
    "FAKE_GROK_MODE",
    "FAKE_GROK_ARGS_FILE",
    "GROK_COMPANION_TIMEOUT_MS",
    "CLAUDE_CODE_SESSION_ID",
    ...(options.clearEnv ?? []),
  ]) {
    delete env[key];
  }
  return {
    ...env,
    ...(options.git ? gitIsolation : {}),
    GROK_BIN: fakeGrok,
    GROK_COMPANION_DATA: sandbox.dataDir,
    FAKE_GROK_ARGS_FILE: sandbox.argsFile,
    ...extra,
  };
}

export function runCompanion(args, options) {
  return spawnSync(process.execPath, [companion, ...args], {
    cwd: options.cwd,
    env: options.env,
    input: options.input ?? "",
    encoding: "utf8",
    timeout: 60000,
  });
}

export function jobRecords(dataDir) {
  const stateDir = path.join(dataDir, "state");
  if (!fs.existsSync(stateDir)) return [];
  const records = [];
  for (const workspace of fs.readdirSync(stateDir)) {
    const jobsDir = path.join(stateDir, workspace, "jobs");
    if (!fs.existsSync(jobsDir)) continue;
    for (const name of fs.readdirSync(jobsDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        records.push(JSON.parse(fs.readFileSync(path.join(jobsDir, name), "utf8")));
      } catch {}
    }
  }
  return records;
}

export function jobLogFiles(dataDir) {
  const stateDir = path.join(dataDir, "state");
  if (!fs.existsSync(stateDir)) return [];
  const logs = [];
  for (const workspace of fs.readdirSync(stateDir)) {
    const jobsDir = path.join(stateDir, workspace, "jobs");
    if (!fs.existsSync(jobsDir)) continue;
    for (const name of fs.readdirSync(jobsDir)) {
      if (name.endsWith(".log")) logs.push(path.join(jobsDir, name));
    }
  }
  return logs;
}

export async function waitFor(fn, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = fn();
    if (value) return value;
    assert.ok(Date.now() < deadline, "Timed out waiting for the expected state.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function jobFileFor(dataDir, jobId) {
  const stateDir = path.join(dataDir, "state");
  if (!fs.existsSync(stateDir)) return null;
  for (const workspace of fs.readdirSync(stateDir)) {
    const file = path.join(stateDir, workspace, "jobs", `${jobId}.json`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killGroups(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

export function readInvocations(argsFile, options = {}) {
  if (!fs.existsSync(argsFile)) return [];
  const invocations = fs
    .readFileSync(argsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (!options.splitInlineFlags) return invocations;
  return invocations.map((argv) =>
    argv.flatMap((token) => {
      if (token.startsWith("--") && token.includes("=")) {
        const separator = token.indexOf("=");
        return [token.slice(0, separator), token.slice(separator + 1)];
      }
      return [token];
    }),
  );
}

export function flagValues(argv, flag) {
  const values = [];
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === flag) values.push(argv[i + 1]);
  }
  return values;
}

export function hasPair(argv, flag, value) {
  return argv.some((token, i) => token === flag && argv[i + 1] === value);
}
