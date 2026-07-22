import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { consumeRawArgsTransport, createRawArgsTransport, resolveRawArgsTransport, splitRawArgs } from "../plugins/fusion/scripts/lib/raw-args-transport.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "fusion", "scripts", "fusion-stats.mjs");

function sandbox(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-raw-args-test-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("raw argument parsing preserves quoted values without evaluating shell syntax", () => {
  const raw = '--record task-safe=rejected --reason "literal $(touch /tmp/never); `id`; $HOME" --json';
  assert.deepStrictEqual(splitRawArgs(raw), [
    "--record",
    "task-safe=rejected",
    "--reason",
    "literal $(touch /tmp/never); `id`; $HOME",
    "--json"
  ]);
});

test("private argument transports are session bound and consumed once", (t) => {
  const temporaryRoot = sandbox(t);
  const transport = createRawArgsTransport({ sessionId: "session-a", temporaryRoot });
  const directory = path.dirname(transport.file);
  assert.match(transport.token, /^[a-f0-9]{48}$/);
  assert.strictEqual(fs.statSync(directory).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(transport.file).mode & 0o777, 0o600);
  const identity = fs.statSync(transport.file);
  assert.strictEqual(fs.readFileSync(transport.file, "utf8"), "");
  fs.writeFileSync(transport.file, '--audit --days "3" --json');
  const written = fs.statSync(transport.file);
  assert.strictEqual(written.dev, identity.dev);
  assert.strictEqual(written.ino, identity.ino);
  assert.strictEqual(written.mode & 0o777, 0o600);

  const resolved = resolveRawArgsTransport(["--raw-args-token", transport.token], { sessionId: "session-a", temporaryRoot });
  assert.deepStrictEqual(resolved, { argv: ["--audit", "--days", "3", "--json"], ingress: "staged_file" });
  assert.strictEqual(fs.existsSync(directory), false);
  assert.throws(() => consumeRawArgsTransport(transport.token, { sessionId: "session-a", temporaryRoot }), /Could not read Fusion input transport/);
});

test("private argument transport accepts an empty payload as empty argv and removes it", (t) => {
  const temporaryRoot = sandbox(t);
  const transport = createRawArgsTransport({ sessionId: "session-a", temporaryRoot });
  const directory = path.dirname(transport.file);
  assert.strictEqual(fs.readFileSync(transport.file, "utf8"), "");

  assert.strictEqual(consumeRawArgsTransport(transport.token, { sessionId: "session-a", temporaryRoot }), "");
  assert.strictEqual(fs.existsSync(transport.file), false);
  assert.strictEqual(fs.existsSync(path.join(directory, "owner.json")), false);
  assert.strictEqual(fs.existsSync(directory), false);

  const emptyTransport = createRawArgsTransport({ sessionId: "session-a", temporaryRoot });
  const emptyDirectory = path.dirname(emptyTransport.file);
  const resolved = resolveRawArgsTransport(["--raw-args-token", emptyTransport.token], { sessionId: "session-a", temporaryRoot });
  assert.deepStrictEqual(resolved, { argv: [], ingress: "staged_file" });
  assert.strictEqual(fs.existsSync(emptyDirectory), false);
});

test("private argument transport discard removes an unwritten input silently", (t) => {
  const temporaryRoot = sandbox(t);
  const transport = createRawArgsTransport({ sessionId: "session-a", temporaryRoot });
  const directory = path.dirname(transport.file);
  assert.strictEqual(fs.readFileSync(transport.file, "utf8"), "");

  assert.strictEqual(consumeRawArgsTransport(transport.token, { sessionId: "session-a", temporaryRoot }), "");
  assert.strictEqual(fs.existsSync(transport.file), false);
  assert.strictEqual(fs.existsSync(path.join(directory, "owner.json")), false);
  assert.strictEqual(fs.existsSync(directory), false);
});

test("a transport cannot cross Claude sessions", (t) => {
  const temporaryRoot = sandbox(t);
  const transport = createRawArgsTransport({ sessionId: "session-a", temporaryRoot });
  fs.writeFileSync(transport.file, "--json");
  assert.throws(() => consumeRawArgsTransport(transport.token, { sessionId: "session-b", temporaryRoot }), /belongs to another Claude session/);
  assert.strictEqual(fs.existsSync(path.dirname(transport.file)), false);
});

test("an invalid transport symlink is rejected without touching its target", (t) => {
  const temporaryRoot = sandbox(t);
  const target = path.join(temporaryRoot, "target");
  fs.mkdirSync(target, { mode: 0o700 });
  fs.writeFileSync(path.join(target, "request"), "keep", { mode: 0o600 });
  const token = "a".repeat(48);
  fs.symlinkSync(target, path.join(temporaryRoot, `fusion-raw-args-${token}`));

  assert.throws(() => consumeRawArgsTransport(token, { sessionId: null, temporaryRoot }), /directory is invalid/);
  assert.strictEqual(fs.readFileSync(path.join(target, "request"), "utf8"), "keep");
});

test("transport options cannot be mixed with ordinary arguments", () => {
  assert.throws(() => resolveRawArgsTransport(["--json", "--raw-args-token", "a".repeat(48)]), /cannot be combined/);
  assert.throws(() => splitRawArgs('--reason "unterminated'), /unterminated/);
});

test("the stats CLI consumes staged arguments without invoking embedded shell syntax", (t) => {
  const directory = sandbox(t);
  const marker = path.join(directory, "shell-ran");
  const env = {
    ...process.env,
    CLAUDE_CODE_SESSION_ID: "fusion-stats-transport-test",
    FUSION_CODEX_STATE: path.join(directory, "missing-codex"),
    FUSION_GROK_COMPANION: path.join(directory, "missing-grok.mjs"),
    FUSION_WORKER_STATE_DIR: path.join(directory, "missing-workers")
  };
  const created = spawnSync(process.execPath, [SCRIPT, "transport-create"], { cwd: directory, env, encoding: "utf8" });
  assert.strictEqual(created.status, 0, created.stderr);
  const transport = JSON.parse(created.stdout);
  fs.writeFileSync(transport.file, `--json $(touch ${marker})`);

  const result = spawnSync(process.execPath, [SCRIPT, "--raw-args-token", transport.token], { cwd: directory, env, encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  assert.strictEqual(fs.existsSync(marker), false);
  assert.strictEqual(fs.existsSync(path.dirname(transport.file)), false);
});

test("the stats CLI forwards --accept-failed-transport from staged arguments unchanged", (t) => {
  const directory = sandbox(t);
  const companion = path.join(directory, "codex-companion.mjs");
  const argsFile = path.join(directory, "companion-args.json");
  const jobId = "a".repeat(32);
  fs.writeFileSync(companion, 'import fs from "node:fs";\nfs.writeFileSync(process.env.FUSION_TEST_CODEX_COMPANION_ARGS, JSON.stringify(process.argv.slice(2)));\n');
  const env = {
    ...process.env,
    CLAUDE_CODE_SESSION_ID: "fusion-stats-transport-acceptance-test",
    FUSION_CODEX_STATE: path.join(directory, "missing-codex"),
    FUSION_CODEX_COMPANION: companion,
    FUSION_GROK_COMPANION: path.join(directory, "missing-grok.mjs"),
    FUSION_DATA_DIR: path.join(directory, "fusion"),
    FUSION_TEST_CODEX_COMPANION_ARGS: argsFile,
    FUSION_WORKER_STATE_DIR: path.join(directory, "missing-workers")
  };
  const created = spawnSync(process.execPath, [SCRIPT, "transport-create"], { cwd: directory, env, encoding: "utf8" });
  assert.strictEqual(created.status, 0, created.stderr);
  const transport = JSON.parse(created.stdout);
  const jobsDirectory = path.join(env.FUSION_CODEX_STATE, "workspace", "jobs");
  fs.mkdirSync(jobsDirectory, { recursive: true });
  fs.writeFileSync(path.join(jobsDirectory, `${jobId}.json`), JSON.stringify({ id: jobId, workspaceRoot: directory, status: "error" }));
  fs.writeFileSync(transport.file, `--record ${jobId}=accepted --accept-failed-transport`);

  const result = spawnSync(process.execPath, [SCRIPT, "--raw-args-token", transport.token], { cwd: directory, env, encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(argsFile, "utf8")), ["record-acceptance", "--job-id", jobId, "--acceptance", "accepted", "--source", "main-loop", "--accept-failed-transport"]);
});
