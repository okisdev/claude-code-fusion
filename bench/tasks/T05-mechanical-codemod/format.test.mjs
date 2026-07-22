import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAlert,
  buildDigest,
  buildGreeting,
  buildInvite,
  buildProfile,
  buildReceipt,
  buildReminder,
  buildStatus,
  buildSummary
} from "./index.js";

test("greeting, status, and reminder preserve normalized text", async () => {
  assert.equal(await buildGreeting("  Ada   Lovelace "), "Hello, Ada Lovelace!");
  assert.equal(await buildStatus("  ready  for review "), "Status: READY FOR REVIEW");
  assert.equal(await buildReminder("  renew   membership "), "Reminder: renew membership");
});

test("summary, receipt, and profile preserve their public output", async () => {
  assert.equal(await buildSummary("  July   report "), "Summary: July report");
  assert.equal(await buildReceipt("  order   104 "), "Receipt: order 104");
  assert.equal(await buildProfile("  Morgan   Lee "), "Profile: Morgan Lee");
});

test("alert, invite, and digest remain asynchronous", async () => {
  const alert = buildAlert("  storage   nearly full ");
  const invite = buildInvite("  Product   review ");
  const digest = buildDigest("  week   28 ");
  assert.ok(alert instanceof Promise);
  assert.ok(invite instanceof Promise);
  assert.ok(digest instanceof Promise);
  assert.deepEqual(await Promise.all([alert, invite, digest]), ["Alert: STORAGE NEARLY FULL", "Invite: Product review", "Digest: week 28"]);
});
