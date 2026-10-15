import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI_VERSION_TIMEOUT_MS = 5000;
const CAPTURE_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 1000;
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

export function assertManifestPins(env, records, resultsDir) {
  const values = [
    ["env.json manifestHash", env?.manifestHash],
    ["env.json taskManifestHash", env?.taskManifestHash],
    ...records.map((record, index) => [`runs.jsonl:${index + 1} taskManifestHash`, record?.taskManifestHash])
  ];
  const [firstLabel, firstValue] = values[0];
  if (typeof firstValue !== "string" || !firstValue) {
    throw new Error(`${resultsDir}: ${firstLabel} is missing`);
  }
  for (const [label, value] of values.slice(1)) {
    if (value !== firstValue) {
      throw new Error(`${resultsDir}: conflicting manifest pins: ${firstLabel}=${JSON.stringify(firstValue)} vs ${label}=${JSON.stringify(value)}`);
    }
  }
}

export function assertEnvironmentPins(existing, current, resultsDir) {
  for (const key of ["nodeVersion", "os", "pluginVersions", "engineCliVersions", "peerDefaults", "taskTags"]) {
    if (JSON.stringify(existing[key]) !== JSON.stringify(current[key])) {
      throw new Error(`${resultsDir}: conflicting environment pin ${key}: existing=${JSON.stringify(existing[key])} vs current=${JSON.stringify(current[key])}`);
    }
  }
}

export function killSpawnGroup(pid) {
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch {}
}

export function runBounded(bin, args, { cwd, env, timeoutMs, label }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new Error(`${label} failed to start: ${error.message}`));
      return;
    }
    const started = process.hrtime.bigint();
    const capture = () => {
      const buffer = Buffer.allocUnsafe(CAPTURE_BYTES);
      let bytes = 0;
      let truncated = false;
      return {
        add(chunk) {
          const remaining = CAPTURE_BYTES - bytes;
          if (chunk.length > remaining) truncated = true;
          if (remaining > 0) {
            const copied = Math.min(chunk.length, remaining);
            chunk.copy(buffer, bytes, 0, copied);
            bytes += copied;
          }
        },
        text() {
          const marker = `\n[output truncated after ${CAPTURE_BYTES} bytes]\n`;
          return truncated ? Buffer.concat([buffer.subarray(0, CAPTURE_BYTES - Buffer.byteLength(marker)), Buffer.from(marker)]).toString("utf8") : buffer.subarray(0, bytes).toString("utf8");
        }
      };
    };
    const stdout = capture();
    const stderr = capture();
    child.stdout.on("data", (chunk) => stdout.add(chunk));
    child.stderr.on("data", (chunk) => stderr.add(chunk));
    const signalGroup = (signal) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch { try { child.kill(signal); } catch {} }
    };
    let timedOut = false;
    let startError = null;
    child.on("error", (error) => { startError = error; });
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) signalGroup("SIGKILL");
      clearTimeout(killTimer);
      if (startError) {
        reject(new Error(startError.code === "ENOENT" ? `${label} binary not found: ${bin}` : `${label} failed to start: ${startError.message}`));
        return;
      }
      resolve({ stdout: stdout.text(), stderr: stderr.text(), exitCode: code ?? (signal === "SIGTERM" ? 143 : signal === "SIGINT" ? 130 : 1), signal, timedOut, seconds: Number(process.hrtime.bigint() - started) / 1e9 });
    });
  });
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
    timeout: CLI_VERSION_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    detached: true
  });
  killSpawnGroup(result.pid);
  if (result.error || result.status !== 0) {
    return null;
  }
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return text ? text.split(/\r?\n/)[0].trim() : null;
}
