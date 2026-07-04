import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULT_MODEL_TABLE_PLACEHOLDER, renderModelTableFromContents, renderModelTableFromFile } from "../plugins/fusion/scripts/lib/model-table.mjs";

function sandbox(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fusion-model-table-test-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRouting(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

test("Renders configured model scores", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "model-routing.json");
  writeRouting(file, {
    schemaVersion: 1,
    updatedAt: "2026-07-04T00:00:00.000Z",
    costProfile: "peer subscriptions flat rate",
    models: [
      { id: "codex", lane: "codex", intelligence: 5, taste: 4, cost: 5, notes: "primary implementation lane" },
      { id: "grok-fast", lane: "grok", intelligence: 3, taste: 3, cost: 5 }
    ]
  });

  const table = renderModelTableFromFile(file);
  assert.strictEqual(renderModelTableFromContents(fs.readFileSync(file, "utf8")), table);
  assert.match(table, /^Cost profile: peer subscriptions flat rate$/m);
  assert.match(table, /^\| Engine \| Lane \| Intelligence \| Taste \| Cost \| Notes \|$/m);
  assert.match(table, /^\| codex \| codex \| 5 \| 4 \| 5 \| primary implementation lane \|$/m);
  assert.match(
    table,
    /^Scores feed the routing priorities above: intelligence proxies correctness and safety, taste is user facing quality, cost applies only as the final tie breaker\.$/m
  );
  assert.match(table, /^Scores are user-assigned via \/fusion:config; re-score when the model lineup changes\.$/m);
});

test("Missing model routing file renders the fallback placeholder", (t) => {
  const dir = sandbox(t);
  assert.strictEqual(renderModelTableFromFile(path.join(dir, "missing.json")), DEFAULT_MODEL_TABLE_PLACEHOLDER);
});

test("Invalid model routing file renders the supplied fallback and warns", (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, "model-routing.json");
  fs.writeFileSync(file, "{ not json", "utf8");
  const warnings = [];
  assert.strictEqual(renderModelTableFromFile(file, "existing scored region", { warn: (message) => warnings.push(message) }), "existing scored region");
  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].startsWith(`fusion: model routing file invalid at ${file}:`));
});
