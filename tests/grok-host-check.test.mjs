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
  const invocations = readInvocations(sandbox.argsFile);
  assert.ok(invocations.length > 0);
  for (const invocation of invocations) assert.deepEqual(invocation, ["--version"]);
  assert.deepEqual(fs.readdirSync(sandbox.dataDir), []);
  return result.stdout;
}

test("host-check reports the runtime socket symlink for every mode in both forms", (t) => {
  const sandbox = makeSandbox(t);
  const socket = path.join(sandbox.root, "var", "run", "docker.sock");
  fs.mkdirSync(path.dirname(socket), { recursive: true });
  fs.symlinkSync(path.join(sandbox.root, "missing-docker.sock"), socket);
  const env = envFor(sandbox, { GROK_COMPANION_RUNTIME_SOCKET_CANDIDATES: socket });
  const expected = `Grok strict sandbox refuses runtime-socket symlink ${socket} because this Grok version requires non-symlink endpoints.`;
  assert.deepEqual(JSON.parse(check(sandbox, env, true)), { blockers: [{ kind: "sandbox", modes: ["consult", "write", "review"], message: expected }] });
  assert.equal(check(sandbox, env, false), `sandbox: ${expected}\n`);
});

test("host-check reports a reachable OrbStack engine socket for write", (t) => {
  const sandbox = makeSandbox(t);
  const socket = path.join(sandbox.root, "orbstack", "docker.sock");
  const env = socketEnv(sandbox, socket);
  const expected = `Runtime socket ${socket} may remain reachable from Grok's macOS strict sandbox even when listed in deny_paths, so a write shell could drive that container engine and write outside the workspace.`;
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

test("host-check reports clear with only a version probe and no state", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  assert.equal(check(sandbox, env, true), '{"blockers":[]}\n');
  assert.equal(check(sandbox, env, false), "host-check: clear\n");
});

test("host-check and setup accept a denied-target symlink on 1.0.88 while refusing writes", (t) => {
  const sandbox = makeSandbox(t);
  const env = envFor(sandbox);
  const socket = path.join(env.HOME, ".orbstack", "run", "docker.sock");
  fs.mkdirSync(path.dirname(socket), { recursive: true });
  fs.writeFileSync(socket, "socket fixture");
  const endpoint = path.join(sandbox.root, "docker.sock");
  fs.symlinkSync(socket, endpoint);
  const currentEnv = {
    ...socketEnv(sandbox, socket),
    FAKE_GROK_VERSION_OUTPUT: "grok 1.0.88 (abcdef012345)",
    GROK_COMPANION_RUNTIME_SOCKET_CANDIDATES: endpoint
  };
  const blockers = JSON.parse(check(sandbox, currentEnv, true)).blockers;
  assert.equal(blockers.length, 1);
  assert.deepEqual(blockers[0].modes, ["write"]);
  assert.match(blockers[0].message, /even when listed in deny_paths/);

  const olderEnv = { ...currentEnv, FAKE_GROK_VERSION_OUTPUT: "grok 1.0.77 (abcdef012345)" };
  assert.deepEqual(JSON.parse(check(sandbox, olderEnv, true)).blockers.map(({ modes }) => modes), [
    ["consult", "write", "review"], ["write"]
  ]);
  const unknownEnv = { ...currentEnv, FAKE_GROK_MODE: "unparseable-version" };
  assert.deepEqual(JSON.parse(check(sandbox, unknownEnv, true)).blockers[0].modes, ["consult", "write", "review"]);

  for (const [versionEnv, ready] of [[olderEnv, false], [currentEnv, true]]) {
    const setup = runCompanion(["setup", "--json"], { cwd: sandbox.workDir, env: versionEnv });
    assert.equal(setup.status, 0, setup.stderr);
    const report = JSON.parse(setup.stdout);
    assert.equal(report.ready, ready);
    assert.equal(report.writeReady, false);
    assert.equal(report.hostEnvironment.ready, ready);
    assert.equal(report.hostEnvironment.writeReady, false);
    assert.deepEqual(report.hostEnvironment.runtimeSocketSymlinks, ready ? [] : [endpoint]);
    assert.match(report.hostEnvironment.remedy, /Stop the container engine/);
    if (ready) assert.doesNotMatch(report.hostEnvironment.remedy, /orb stop/);
    else assert.match(report.hostEnvironment.remedy, /orb stop/);
    assert.doesNotMatch(report.hostEnvironment.remedy, /sudo rm|setup\.use_admin/);
    if (ready) {
      assert.equal(report.compatibility, "tested");
      assert.match(report.hostEnvironment.detail, /even when listed in deny_paths/);
    }
    const rendered = runCompanion(["setup"], { cwd: sandbox.workDir, env: versionEnv });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.ok(rendered.stdout.includes(report.hostEnvironment.remedy));
  }
});

test("host-check and setup preserve prereleases below the runtime-socket exemption", (t) => {
  for (const version of ["1.0.88-rc.1", "1.0.88-rc.1+build.2", "1.0.88", "1.0.88+build.2"]) {
    const sandbox = makeSandbox(t);
    const env = envFor(sandbox);
    const target = path.join(env.HOME, ".docker", "desktop", "docker.sock");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "socket fixture");
    const endpoint = path.join(sandbox.root, "docker.sock");
    fs.symlinkSync(target, endpoint);
    const currentEnv = { ...env, FAKE_GROK_VERSION_OUTPUT: `grok ${version} (abcdef012345)`, GROK_COMPANION_RUNTIME_SOCKET_CANDIDATES: endpoint };
    const blockers = JSON.parse(check(sandbox, currentEnv, true)).blockers;
    const prerelease = version.includes("-rc");
    assert.deepEqual(blockers.map(({ modes }) => modes), prerelease ? [["consult", "write", "review"]] : [], version);
    const setup = runCompanion(["setup", "--json"], { cwd: sandbox.workDir, env: currentEnv });
    assert.equal(setup.status, 0, setup.stderr);
    const report = JSON.parse(setup.stdout);
    assert.equal(report.grok.detail, `grok ${version} (abcdef012345)`);
    assert.equal(report.ready, !prerelease, version);
  }
});
