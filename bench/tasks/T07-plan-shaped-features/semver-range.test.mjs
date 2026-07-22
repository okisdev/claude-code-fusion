import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVersions, parseVersion, satisfiesRange } from "./semver-range/index.js";

test("parseVersion returns numeric stable version components", () => {
  assert.deepEqual(parseVersion("12.34.56"), { major: 12, minor: 34, patch: 56 });
});

test("parseVersion rejects invalid and unsafe version components", () => {
  assert.throws(() => parseVersion(1), TypeError);
  assert.throws(() => parseVersion("01.2.3"), RangeError);
  assert.throws(() => parseVersion("1.2"), RangeError);
  assert.throws(() => parseVersion("1.2.9007199254740992"), RangeError);
});

test("compareVersions orders every component", () => {
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
});

test("satisfiesRange supports exact versions and comparator intersections", () => {
  assert.equal(satisfiesRange("1.2.3", "1.2.3"), true);
  assert.equal(satisfiesRange("1.2.4", "=1.2.3"), false);
  assert.equal(satisfiesRange("1.5.0", ">=1.2.3 <2.0.0"), true);
  assert.equal(satisfiesRange("2.0.0", ">=1.2.3 <2.0.0"), false);
  assert.equal(satisfiesRange("99.0.0", "*"), true);
});

test("satisfiesRange applies caret and tilde upper bounds", () => {
  assert.equal(satisfiesRange("1.9.9", "^1.2.3"), true);
  assert.equal(satisfiesRange("2.0.0", "^1.2.3"), false);
  assert.equal(satisfiesRange("0.2.9", "^0.2.3"), true);
  assert.equal(satisfiesRange("0.3.0", "^0.2.3"), false);
  assert.equal(satisfiesRange("0.0.3", "^0.0.3"), true);
  assert.equal(satisfiesRange("0.0.4", "^0.0.3"), false);
  assert.equal(satisfiesRange("1.2.99", "~1.2.3"), true);
  assert.equal(satisfiesRange("1.3.0", "~1.2.3"), false);
});

test("satisfiesRange rejects malformed ranges", () => {
  assert.throws(() => satisfiesRange("1.2.3", 1), TypeError);
  assert.throws(() => satisfiesRange("1.2.3", "   "), RangeError);
  assert.throws(() => satisfiesRange("1.2.3", "1.2.x"), RangeError);
  assert.throws(() => satisfiesRange("1.2.3", "^"), RangeError);
  assert.throws(() => satisfiesRange("1.2.3", "* >=1.0.0"), RangeError);
});
