import assert from "node:assert/strict";
import { test } from "node:test";

import { renderTerminalResult } from "../plugins/codex/scripts/lib/render.mjs";

function record(overrides = {}) {
  return {
    id: "a".repeat(32),
    status: "done",
    delivery: "foreground",
    semanticStatus: "unverified",
    resultText: "The sandbox blocked the requested work. No files were changed and verification was not run.",
    ...overrides
  };
}

test("an unverified done result is labeled as transport completion rather than acceptance", () => {
  const rendered = renderTerminalResult(record());
  assert.match(rendered, /^Codex transport completed, but semantic acceptance remains unverified\./);
  assert.match(rendered, /Check the result against the requested completion criteria before relying on it\./);
  assert.match(rendered, /The sandbox blocked the requested work\. No files were changed and verification was not run\./);
  assert.match(rendered, /semantic: unverified\nstate: done\n$/);
});

test("an accepted result does not carry the unverified transport warning", () => {
  const rendered = renderTerminalResult(record({ semanticStatus: "accepted", resultText: "Verified result." }));
  assert.doesNotMatch(rendered, /semantic acceptance remains unverified/);
  assert.match(rendered, /^Verified result\./);
  assert.match(rendered, /semantic: accepted\nstate: done\n$/);
});

test("a cancelled result renders salvaged partial Codex output", () => {
  const rendered = renderTerminalResult(record({
    partialResultText: "Recovered partial Codex output.",
    status: "cancelled"
  }));
  assert.match(rendered, /^Codex job was cancelled\./);
  assert.match(rendered, /Partial Codex output:\n\nRecovered partial Codex output\./);
  assert.match(rendered, /state: cancelled\n/);
});

test("a cancelled result without partial output is unchanged", () => {
  const rendered = renderTerminalResult(record({ status: "cancelled" }));
  assert.equal(
    rendered,
    `Codex job was cancelled.\n\njob: ${"a".repeat(32)}\ndelivery: foreground\nsemantic: unverified\nstate: cancelled\nfailure: cancelled\n`
  );
});
