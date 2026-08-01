import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitIsolation } from "./git-fixture.mjs";
import { getProcessIdentity, processIdentitiesMatch } from "../../plugins/grok/scripts/lib/process-identity.mjs";

export const repoRoot = path.join(import.meta.dirname, "..", "..");
export const companion = path.join(repoRoot, "plugins", "grok", "scripts", "grok-companion.mjs");
export const fakeGrok = path.join(repoRoot, "tests", "fake-grok");
export const stateModulePath = path.join(repoRoot, "plugins", "grok", "scripts", "lib", "state.mjs");
export const jobsMonitor = path.join(repoRoot, "plugins", "grok", "scripts", "jobs-monitor.mjs");
export const grokCompanionCapabilities = [
  "--prompt-file",
  "--output-format",
  "--sandbox",
  "--tools",
  "--disallowed-tools",
  "--deny",
  "--max-turns",
  "--no-auto-update",
  "--permission-mode",
  "--allow",
  "--disable-web-search",
  "--always-approve",
  "--no-subagents",
  "--no-wait-for-background",
  "--json-schema",
].join(",");

let cachedProcessInspectionAvailability;

export function processInspectionAvailable() {
  if (process.env.COMPANION_TEST_NO_PROCESS_INSPECTION === "1") {
    return false;
  }
  if (cachedProcessInspectionAvailability === undefined) {
    cachedProcessInspectionAvailability = getProcessIdentity(process.pid) !== null;
  }
  return cachedProcessInspectionAvailability;
}

export function makeSandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-plugin-test-")));
  const cleanups = [];
  t.after(async () => {
    try {
      for (const cleanup of cleanups.reverse()) {
        await cleanup();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  const dataDir = path.join(root, "data");
  const workDir = path.join(root, "work");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workDir);
  return {
    root,
    dataDir,
    workDir,
    argsFile: path.join(root, "args.jsonl"),
    registerCleanup(cleanup) {
      cleanups.push(cleanup);
    },
  };
}

export function envFor(sandbox, extra = {}, options = {}) {
  const homeDir = path.join(sandbox.root, "home");
  const tempDir = path.join(sandbox.root, "tmpdir");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
  const env = Object.fromEntries(
    [
      "PATH",
      ...(process.platform === "win32" ? ["ComSpec", "PATHEXT", "SystemRoot", "SYSTEMROOT"] : []),
    ]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  for (const key of [
    "FAKE_GROK_MODE",
    "FAKE_GROK_ARGS_FILE",
    "FAKE_GROK_REJECT_EXTERNAL_PROMPT",
    "FAKE_GROK_RESOLVED_EFFORT",
    "FAKE_GROK_RESOLVED_MODEL",
    "FAKE_GROK_ENV_FILE",
    "FAKE_GROK_DESCENDANT_PID_FILE",
    "FAKE_GROK_SANDBOX_SENTINEL",
    "FAKE_GROK_SANDBOX_EVENT_DELAY_MS",
    "FAKE_GROK_STDERR_GATE_FILE",
    "FAKE_GROK_STDIN_FILE",
    "FAKE_GROK_STDIN_LOG",
    "GROK_COMPANION_CAPABILITIES",
    "GROK_COMPANION_SANDBOX_HANDSHAKE_MS",
    "GROK_COMPANION_TIMEOUT_MS",
    "GROK_COMPANION_BACKGROUND_DELIVERY",
    "GROK_COMPANION_CONTINUITY_POLICY",
    "GROK_COMPANION_PIDLESS_RUNNING_GRACE_MS",
    "GROK_COMPANION_WAIT_POLL_MS",
    "GROK_COMPANION_WAIT_TIMEOUT_MS",
    "GROK_CONSULT_ALLOW",
    "GROK_JOBS_MONITOR_INTERVAL_MS",
    "GROK_JOBS_MONITOR_MANAGED_GRACE_MS",
    "GROK_MEMORY",
    "GROK_SUBAGENTS",
    "GROK_CLAUDE_SKILLS_ENABLED",
    "GROK_CLAUDE_RULES_ENABLED",
    "GROK_CLAUDE_AGENTS_ENABLED",
    "GROK_CLAUDE_MCPS_ENABLED",
    "GROK_CLAUDE_HOOKS_ENABLED",
    "GROK_CLAUDE_SESSIONS_ENABLED",
    "GROK_CURSOR_SKILLS_ENABLED",
    "GROK_CURSOR_RULES_ENABLED",
    "GROK_CURSOR_AGENTS_ENABLED",
    "GROK_CURSOR_MCPS_ENABLED",
    "GROK_CURSOR_HOOKS_ENABLED",
    "GROK_CURSOR_SESSIONS_ENABLED",
    "GROK_HOME",
    "RUST_LOG",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_PLUGIN_OPTION_STOP_GATE",
    ...(options.clearEnv ?? []),
  ]) {
    delete env[key];
  }
  return {
    ...env,
    ...(options.git ? gitIsolation(sandbox.root) : {}),
    HOME: homeDir,
    TMPDIR: tempDir,
    GROK_BIN: fakeGrok,
    GROK_COMPANION_DATA: sandbox.dataDir,
    GROK_COMPANION_CAPABILITIES: grokCompanionCapabilities,
    GROK_HOME: path.join(sandbox.root, "grok-home"),
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

function linuxProcessIsZombie(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) {
      return false;
    }
    return stat.slice(commandEnd + 2).trim().split(/\s+/)[0] === "Z";
  } catch {
    return false;
  }
}

export function pidAlive(pid, expectedIdentity = null) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (expectedIdentity) {
    return processIdentitiesMatch(getProcessIdentity(pid), expectedIdentity);
  }
  return process.platform !== "linux" || !linuxProcessIsZombie(pid);
}

export function killGroups(pid, expectedIdentity = null) {
  if (!pid || (expectedIdentity && !pidAlive(pid, expectedIdentity))) return;
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
