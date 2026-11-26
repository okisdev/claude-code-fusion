import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";

const rootPrefix = "fusion-test-";
const longestSocketPath = `${rootPrefix}XXXXXX/grok-plugin-test-XXXXXX/orbstack/docker.sock`;
const maxSocketPathBytes = process.platform === "linux" ? 107 : 103;
const shellSafePath = /^[A-Za-z0-9_./-]+$/;
let parent;
try {
  parent = realpathSync(tmpdir());
} catch {}
if (!parent || !shellSafePath.test(parent) || Buffer.byteLength(join(parent, longestSocketPath)) > maxSocketPathBytes) {
  parent = realpathSync("/tmp");
}
if (!shellSafePath.test(parent)) {
  throw new Error(`The test temp directory must have a shell-safe path: ${parent}`);
}

const root = mkdtempSync(join(parent, rootPrefix));
try {
  const args = ["--test", "--test-timeout=300000", "tests/*.test.mjs", ...process.argv.slice(2)];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
    stdio: "inherit"
  });
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  const [status, signal] = await once(child, "exit");
  const signalNumber = constants.signals[signal];
  process.exitCode = status ?? (typeof signalNumber === "number" ? 128 + signalNumber : 1);
} finally {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    console.warn(`Could not remove test temp directory ${root}: ${error.message}`);
  }
}
