import assert from "node:assert/strict";
import { test } from "node:test";
import { clamp, normalize, lerp } from "./range.js";

test("clamp pins a low value to min and a high value to max", () => {
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(15, 0, 10), 10);
  assert.equal(clamp(4, 0, 10), 4);
});

test("clamp leaves boundary values unchanged", () => {
  assert.equal(clamp(0, 0, 10), 0);
  assert.equal(clamp(10, 0, 10), 10);
});

test("clamp rejects a range where min exceeds max", () => {
  assert.throws(() => clamp(5, 10, 0), RangeError);
});

test("normalize maps a bounded value onto zero through one", () => {
  assert.equal(normalize(0, 0, 10), 0);
  assert.equal(normalize(10, 0, 10), 1);
  assert.equal(normalize(5, 0, 10), 0.5);
  assert.equal(normalize(-5, 0, 10), 0);
  assert.equal(normalize(15, 0, 10), 1);
});

test("lerp is unaffected by the clamp fix", () => {
  assert.equal(lerp(0, 0, 10), 0);
  assert.equal(lerp(1, 0, 10), 10);
  assert.equal(lerp(0.5, 0, 10), 5);
});
