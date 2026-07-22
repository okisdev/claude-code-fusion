import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration } from "../duration-formatter/index.js";

test("formats a duration with completed minutes and remaining seconds", () => {
  assert.equal(formatDuration(90), "1m 30s");
  assert.equal(formatDuration(120), "2m 0s");
});

test("formats durations shorter than a minute", () => {
  assert.equal(formatDuration(59), "59s");
  assert.equal(formatDuration(-8), "0s");
});
