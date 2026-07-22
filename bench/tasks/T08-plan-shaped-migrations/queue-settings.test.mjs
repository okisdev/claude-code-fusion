import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { loadQueueSettings } from "./queue-settings/load-queue-settings.js";

test("queue settings config drops the dotted flat keys for a nested queue object", () => {
  const raw = JSON.parse(fs.readFileSync(new URL("./queue-settings/config.json", import.meta.url), "utf8"));
  for (const key of Object.keys(raw)) {
    assert.equal(key.includes("."), false, `legacy dotted key survived migration: ${key}`);
  }
  assert.deepEqual(raw.queue, { concurrency: 4, retryDelayMs: 250, maxAttempts: 3 });
});

test("loadQueueSettings reads the migrated nested shape", () => {
  assert.deepEqual(loadQueueSettings(), { concurrency: 4, retryDelayMs: 250, maxAttempts: 3 });
});
