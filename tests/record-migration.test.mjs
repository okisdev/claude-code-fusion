import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as codex from "../plugins/codex/scripts/lib/state.mjs";
import * as grok from "../plugins/grok/scripts/lib/state.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "record-migration-"));
const bin = path.join(root, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "ps"), '#!/bin/sh\npid=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-p" ]; then pid="$2"; shift 2; else shift; fi\ndone\nprintf "process-%s\\n" "$pid"\n');
fs.writeFileSync(path.join(bin, "sysctl"), '#!/bin/sh\nprintf "{ sec = 1, usec = 0 }\\n"\n');
fs.chmodSync(path.join(bin, "ps"), 0o755);
fs.chmodSync(path.join(bin, "sysctl"), 0o755);
const originalPath = process.env.PATH;
process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
test.after(() => {
  process.env.PATH = originalPath;
  fs.rmSync(root, { recursive: true, force: true });
});

function checkMigration(name, state, legacy, expected) {
  const file = path.join(root, name, `${legacy.id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  const before = fs.statSync(file).ino;
  const copy = structuredClone(legacy);
  const migrated = state.migrateJobRecord(legacy);
  assert.deepEqual(legacy, copy);
  assert.deepEqual(state.migrateJobRecord(migrated), migrated);
  const read = state.readJobRecordFile(file);
  assert.deepEqual(read, migrated);
  expected(read);
  assert.notEqual(fs.statSync(file).ino, before);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), read);
  const after = fs.statSync(file).ino;
  assert.deepEqual(state.readJobRecordFile(file), read);
  assert.equal(fs.statSync(file).ino, after);
}

test("Codex legacy session and tier fields migrate onto the current schema", () => {
  const current = codex.createJobRecord({ id: "codex-legacy", cwd: root, background: true, request: { serviceTier: "priority" } });
  const legacy = { ...current, sessionId: "old-session", appliedServiceTier: "priority", resumable: true, resumeCommand: "resume" };
  delete legacy.claudeSessionId;
  delete legacy.artifactsPruned;
  delete legacy.fileChangeCount;
  delete legacy.serviceTier;
  checkMigration("codex", codex, legacy, (record) => {
    assert.equal(record.claudeSessionId, "old-session");
    assert.equal(record.serviceTier, "priority");
    assert.equal(record.artifactsPruned, false);
    assert.equal(record.fileChangeCount, null);
    assert.equal(record.resumable, true);
    assert.equal(Object.hasOwn(record, "sessionId"), false);
    assert.equal(Object.hasOwn(record, "appliedServiceTier"), false);
  });
  const versioned = { ...codex.createJobRecord({ id: "codex-plain-legacy", cwd: root }), sessionId: "owner" };
  delete versioned.artifactsPruned;
  checkMigration("codex-plain", codex, versioned, (record) => {
    assert.equal(record.claudeSessionId, "owner");
    assert.equal(record.artifactsPruned, false);
    assert.equal(Object.hasOwn(record, "sessionId"), false);
  });
});

test("Grok 0.0.53 and 0.0.55 records gain the missing version field", () => {
  for (const version of ["0.0.53", "0.0.55"]) {
    const legacy = grok.createJobRecord({ id: `grok-${version}`, mode: "consult", cwd: root, briefFile: null, background: true });
    legacy.companionVersion = version;
    delete legacy.grokVersion;
    checkMigration(`grok-${version}`, grok, legacy, (record) => {
      assert.equal(record.grokVersion, null);
      assert.equal(record.delivery, "manual");
      assert.equal(record.transportStatus, "running");
    });
  }
});

test("Grok pre-versioned records gain structured status and process fields", () => {
  const legacy = {
    background: false, briefFile: null, cancelRequestedAt: null, claudeSessionId: "owner",
    createdAt: "2026-01-01T00:00:00.000Z", cwd: root, errorMessage: null, errorTail: null,
    exitCode: 0, failureKind: null, finishedAt: "2026-01-01T00:01:00.000Z", grokPid: null,
    id: "grok-pre-version", mode: "consult", pid: null, request: {}, resultText: "done",
    sessionId: "grok-session", status: "done"
  };
  checkMigration("grok-pre-version", grok, legacy, (record) => {
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.engine, "grok");
    assert.equal(record.jobClass, "unknown");
    assert.equal(record.deliveryStatus, "delivered");
    assert.equal(record.semanticStatus, "unverified");
    assert.equal(record.cleanupRequired, false);
    assert.equal(record.sessionId, "grok-session");
  });
  const shorter = { ...legacy, id: "grok-pre-version-short" };
  delete shorter.cancelRequestedAt;
  delete shorter.errorMessage;
  checkMigration("grok-pre-version-short", grok, shorter, (record) => {
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.semanticStatus, "unverified");
  });
});

test("Codex retention scan migrates legacy records", () => {
  const dataDir = path.join(root, "retention-data");
  const cwd = path.join(root, "retention-work");
  fs.mkdirSync(cwd);
  const file = codex.jobFilePath(dataDir, cwd, "retained-legacy");
  const legacy = { ...codex.createJobRecord({ id: "retained-legacy", cwd, status: "done" }), sessionId: "owner" };
  delete legacy.artifactsPruned;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  const result = codex.pruneJobState(dataDir, { recordMaxRecords: 10, recordRetentionDays: 90, maxRecords: 10, maxBytes: 1024 * 1024 });
  assert.equal(result.ok, true);
  assert.equal(result.unrecognizedRecords, 0);
  assert.equal(result.afterRecords, 1);
  assert.equal(codex.readJobRecordFile(file).artifactsPruned, false);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, "utf8")), "sessionId"), false);
});

test("irreparable records remain unreadable and unchanged", () => {
  for (const [name, state, record] of [
    ["codex-invalid", codex, { schemaVersion: 1, engine: "codex", id: "broken-codex", status: "mystery" }],
    ["grok-invalid", grok, { schemaVersion: 1, engine: "grok", id: "broken-grok", status: "done" }]
  ]) {
    const file = path.join(root, name, `${record.id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
    const before = fs.readFileSync(file, "utf8");
    assert.equal(state.readJobRecordFile(file), null);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
});
