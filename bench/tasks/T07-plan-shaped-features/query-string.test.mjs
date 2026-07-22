import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuery, stringifyQuery } from "./query-string/index.js";

test("parseQuery decodes a leading query marker, fragments, plus signs, and duplicate keys", () => {
  const parsed = parseQuery("?name=Ada+Lovelace&tag=math&tag=logic&=blank#ignored=yes");
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.deepEqual(parsed, Object.assign(Object.create(null), {
    name: "Ada Lovelace",
    tag: ["math", "logic"],
    "": "blank"
  }));
});

test("parseQuery keeps blank values and ignores empty segments", () => {
  assert.deepEqual(parseQuery("&&flag&answer=&"), Object.assign(Object.create(null), {
    flag: "",
    answer: ""
  }));
});

test("parseQuery rejects invalid input and preserves malformed escape errors", () => {
  assert.throws(() => parseQuery(null), TypeError);
  assert.throws(() => parseQuery("broken=%E0%A4"), URIError);
});

test("stringifyQuery serializes scalars, arrays, spaces, and null without mutating input", () => {
  const values = { name: "Ada Lovelace", tag: ["math", null, undefined, "logic"], empty: null, skip: undefined };
  assert.equal(stringifyQuery(values), "name=Ada+Lovelace&tag=math&tag=&tag=logic&empty=");
  assert.deepEqual(values, { name: "Ada Lovelace", tag: ["math", null, undefined, "logic"], empty: null, skip: undefined });
});

test("stringifyQuery rejects null, arrays, and primitives", () => {
  assert.throws(() => stringifyQuery(null), TypeError);
  assert.throws(() => stringifyQuery(["value"]), TypeError);
  assert.throws(() => stringifyQuery("value"), TypeError);
});
