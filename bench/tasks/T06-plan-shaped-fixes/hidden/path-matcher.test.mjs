import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesPath } from "../path-matcher/index.js";

test("matches a wildcard inside one path segment", () => {
  assert.equal(matchesPath("src/*.js", "src/main.js"), true);
  assert.equal(matchesPath("src/*.js", "src/main.ts"), false);
});

test("does not let a wildcard cross a path separator", () => {
  assert.equal(matchesPath("src/*.js", "src/nested/main.js"), false);
});
