import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsvLine } from "../csv-parser/index.js";

test("parses quoted commas and escaped quotes", () => {
  assert.deepEqual(parseCsvLine('team,"Park, Mina","said ""hello"""'), [
    "team",
    "Park, Mina",
    'said "hello"'
  ]);
});

test("preserves ordinary trimmed fields", () => {
  assert.deepEqual(parseCsvLine(" alpha, beta ,gamma "), ["alpha", "beta", "gamma"]);
});
