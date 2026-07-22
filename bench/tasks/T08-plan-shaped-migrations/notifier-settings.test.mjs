import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { loadNotifierSettings } from "./notifier-settings/load-notifier-settings.js";

test("notifier settings config drops the deprecated field names", () => {
  const raw = JSON.parse(fs.readFileSync(new URL("./notifier-settings/config.json", import.meta.url), "utf8"));
  assert.equal("retryCount" in raw.notifier, false, "deprecated retryCount key survived migration");
  assert.equal("silentMode" in raw.notifier, false, "deprecated silentMode key survived migration");
  assert.deepEqual(raw.notifier, { channel: "email", maxRetries: 5, muted: false });
});

test("loadNotifierSettings reads the renamed fields", () => {
  assert.deepEqual(loadNotifierSettings(), { channel: "email", maxRetries: 5, muted: false });
});
