import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MESSAGE_REGISTRY,
  messageCode,
  messageTag,
  registryEntry,
  tagMessage
} from "../plugins/fusion/scripts/lib/user-messages.mjs";

test("every registry slug derives a unique four digit code", () => {
  const codes = new Map();
  for (const entry of MESSAGE_REGISTRY) {
    const code = messageCode(entry.slug);
    assert.ok(Number.isInteger(code) && code >= 1000 && code <= 9999, `${entry.slug} code ${code} is out of range`);
    assert.ok(!codes.has(code), `${entry.slug} collides with ${codes.get(code)} on ${code}`);
    codes.set(code, entry.slug);
  }
});

test("codes are deterministic across calls", () => {
  for (const entry of MESSAGE_REGISTRY) {
    assert.strictEqual(messageCode(entry.slug), messageCode(entry.slug));
  }
});

test("every registry entry carries a slug and a description", () => {
  for (const entry of MESSAGE_REGISTRY) {
    assert.match(entry.slug, /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/);
    assert.ok(typeof entry.description === "string" && entry.description.length > 0);
  }
});

test("tagMessage appends the bracketed digest after the text", () => {
  const slug = MESSAGE_REGISTRY[0].slug;
  const tagged = tagMessage(slug, "Example message.");
  assert.strictEqual(tagged, `Example message. [fusion:${messageCode(slug)}]`);
  assert.strictEqual(messageTag(slug), `[fusion:${messageCode(slug)}]`);
});

test("an unknown slug throws instead of minting a code", () => {
  assert.throws(() => messageCode("inline-guard.not-a-real-slug"), RangeError);
  assert.throws(() => tagMessage("inline-guard.not-a-real-slug", "text"), RangeError);
});

test("registryEntry resolves a code back to its slug and rejects unknown codes", () => {
  const entry = MESSAGE_REGISTRY.at(-1);
  const resolved = registryEntry(messageCode(entry.slug));
  assert.strictEqual(resolved?.slug, entry.slug);
  assert.strictEqual(resolved?.description, entry.description);
  let unassigned = 1000;
  const taken = new Set(MESSAGE_REGISTRY.map((candidate) => messageCode(candidate.slug)));
  while (taken.has(unassigned)) {
    unassigned += 1;
  }
  assert.strictEqual(registryEntry(unassigned), null);
});
