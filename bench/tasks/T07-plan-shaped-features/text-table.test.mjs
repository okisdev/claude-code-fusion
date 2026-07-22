import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTable, measureTable } from "./text-table/index.js";

test("measureTable uses the longest header or rendered cell without mutation", () => {
  const headers = ["Name", "Score"];
  const rows = [["Grace Hopper", 1000], ["Bo", null]];
  assert.deepEqual(measureTable(headers, rows), [12, 5]);
  assert.deepEqual(headers, ["Name", "Score"]);
  assert.deepEqual(rows, [["Grace Hopper", 1000], ["Bo", null]]);
});

test("formatTable renders aligned headers and cells with every required separator", () => {
  assert.equal(
    formatTable(["Name", "Score"], [["Grace Hopper", 1000], ["Bo", null]]),
    "+--------------+-------+\n| Name         | Score |\n+--------------+-------+\n| Grace Hopper | 1000  |\n| Bo           |       |\n+--------------+-------+"
  );
});

test("formatTable renders an empty body with a final separator", () => {
  assert.equal(formatTable(["Only"], []), "+------+\n| Only |\n+------+\n+------+");
});

test("table functions reject invalid shapes, cells, and line breaks", () => {
  assert.throws(() => measureTable([], []), TypeError);
  assert.throws(() => measureTable(["A"], [["one", "two"]]), TypeError);
  assert.throws(() => measureTable(["A"], [[{}]]), TypeError);
  assert.throws(() => formatTable(["A\nB"], []), RangeError);
  assert.throws(() => formatTable(["A"], [["B\r"]]), RangeError);
});
