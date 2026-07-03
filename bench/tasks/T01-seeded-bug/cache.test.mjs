import assert from "node:assert/strict";
import { test } from "node:test";
import { TtlLruCache } from "./index.js";

test("get promotes entry so a later insert evicts the untouched key", () => {
  const cache = new TtlLruCache({ maxSize: 2 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.get("a");
  cache.set("c", 3);
  assert.equal(cache.has("a"), true);
  assert.equal(cache.has("b"), false);
  assert.equal(cache.has("c"), true);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
});

test("repeated touches keep the hot key when capacity is full", () => {
  const cache = new TtlLruCache({ maxSize: 3 });
  cache.set("x", 10);
  cache.set("y", 20);
  cache.set("z", 30);
  cache.get("x");
  cache.get("x");
  cache.set("w", 40);
  assert.equal(cache.get("x"), 10);
  assert.equal(cache.has("y"), false);
  assert.equal(cache.has("z"), true);
  assert.equal(cache.get("w"), 40);
});

test("entries expire after ttl and unrelated keys stay valid", async () => {
  const cache = new TtlLruCache({ maxSize: 4 });
  cache.set("keep", "ok");
  cache.set("fade", "gone", { ttlMs: 15 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(cache.get("keep"), "ok");
  assert.equal(cache.has("fade"), false);
  assert.equal(cache.get("fade"), undefined);
});

test("delete and clear shrink the cache without breaking survivors", () => {
  const cache = new TtlLruCache({ maxSize: 2 });
  cache.set("one", 1);
  cache.set("two", 2);
  assert.equal(cache.delete("one"), true);
  assert.equal(cache.size, 1);
  cache.set("three", 3);
  assert.equal(cache.get("two"), 2);
  assert.equal(cache.get("three"), 3);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get("two"), undefined);
});