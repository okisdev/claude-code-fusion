import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { envFor, makeSandbox, readInvocations, runCompanion } from "./lib/companion-harness.mjs";

function socketEnv(sandbox, socket) {
  const preload = path.join(sandbox.root, "socket-lstat.cjs");
  fs.writeFileSync(preload, 'const fs = require("node:fs"); const original = fs.lstatSync; fs.lstatSync = (candidate, ...args) => candidate === process.env.TEST_ENGINE_SOCKET ? { isSocket: () => true, isSymbolicLink: () => false } : original(candidate, ...args);');
  return envFor(sandbox, { GROK_COMPANION_UNDENIED_SOCKET_CANDIDATES: socket, TEST_ENGINE_SOCKET: socket, NODE_OPTIONS: `--require=${preload}` });
}

function check(sandbox, env, json) {
  const result = runCompanion(["host-check", ...(json ? ["--json"] : [])], { cwd: sandbox.workDir, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(readInvocations(sandbox.argsFile), []);
  assert.deepEqual(fs.readdirSync(sandbox.dataDir), []);
  return result.stdout;
}

test("host-check reports the runtime socket symlink for every mode in both forms", (t) => {
  const sandbox = makeSandbox(t);
  const socket = path.join(sandbox.root, "var", "run", "docker.sock");
  fs.mkdirSync(path.dirname(socket), { recursive: true });
  fs.symlinkSync(path.join(sandbox.root, "missing-docker.sock"), socket);
  const env = envFor(sandbox, { GROK_COMPANION_RUNTIME_SOCKET_CANDIDATES: socket });
  const expected = `Grok strict sandbox (runtime-socket deny policy, 1.0.4 through 1.0.77) refuses to start while ${socket} exists as a symlink.`;
  assert.deepEqual(JSON.parse(check(sandbox, env, true)), { blockers: [{ kind: "sandbox", modes: ["consult", "write", "review"], message: expected }] });
  assert.equal(check(sandbox, env, false), `sandbox: ${expected}\n`);
});

test("host-check reports a reachable OrbStack engine socket for write", (t) => {
  const sandbox = makeSandbox(t);
  const socket = path.join(sandbox.root, "orbstack", "docker.sock");
  const env = socketEnv(sandbox, socket);
  const expected = `Grok's strict runtime-socket deny list does not cover ${socket}, so a write shell could drive that container engine and write outside the workspace.`;
  assert.deepEqual(JSON.parse(check(sandbox, env, true)), { blockers: [{ kind: "sandbox", modes: ["write"], message: expected }] });
  assert.equal(check(sandbox, env, false), `sandbox: ${expected}\n`);
});

test("host-check collects both independent blockers", (t) => {
  const sandbox = makeSandbox(t);
  const symlink = path.join(sandbox.root, "var", "run", "docker.sock");
  fs.mkdirSync(path.dirname(symlink), { recursive: true });
  fs.symlinkSync(path.join(sandbox.root, "missing-docker.sock"), symlink);
  const socket = path.join(sandbox.root, "orbstack", "docker.sock");
  const env = { ...socketEnv(sandbox, socket), GROK_COMPANION_RUNTIME_SOCKET_CANDIDATES: symlink };
  const blockers = JSON.parse(check(sandbox, env, true)).blockers;
  assert.deepEqual(blockers.map(({ kind, modes }) => ({ kind, modes })), [
    { kind: "sandbox", modes: ["consult", "write", "review"] },
    { kind: "sandbox", modes: ["write"] }
  ]);
  assert.equal(check(sandbox, env, false).trimEnd().split("\n").length, 2);
});

test("host-check reports clear without creating state or launching Grok", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  assert.equal(check(sandbox, env, true), '{"blockers":[]}\n');
  assert.equal(check(sandbox, env, false), "host-check: clear\n");
});
