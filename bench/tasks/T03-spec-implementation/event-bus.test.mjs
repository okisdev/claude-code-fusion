import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBus, matchesPattern } from "./index.js";

test("the package exports the public event bus API", () => {
  assert.equal(typeof EventBus, "function");
  assert.equal(typeof matchesPattern, "function");
});

test("patterns match exact topics and one wildcard segment", () => {
  assert.equal(matchesPattern("orders.created", "orders.created"), true);
  assert.equal(matchesPattern("orders.*", "orders.created"), true);
  assert.equal(matchesPattern("*", "ready"), true);
  assert.equal(matchesPattern("orders.*", "orders.created.audit"), false);
  assert.equal(matchesPattern("*", "system.ready"), false);
  assert.equal(matchesPattern("orders.*", "payments.created"), false);
});

test("topics and patterns reject invalid names", () => {
  const invalidTopics = ["", ".ready", "ready.", "system..ready", "system.*", 3];
  const invalidPatterns = ["", ".ready", "ready.", "system..*", "*.ready", "ready*", 3];

  for (const topic of invalidTopics) {
    assert.throws(() => matchesPattern("*", topic), TypeError);
  }
  for (const pattern of invalidPatterns) {
    assert.throws(() => matchesPattern(pattern, "ready"), TypeError);
  }
});

test("publish delivers matching listeners in registration order and preserves payload identity", () => {
  const bus = new EventBus();
  const payload = { id: 42 };
  const received = [];

  bus.subscribe("orders.*", (value, topic) => received.push(["wildcard", value, topic]));
  bus.subscribe("orders.created", (value, topic) => received.push(["exact", value, topic]));
  bus.subscribe("orders.*", (value, topic) => received.push(["second wildcard", value, topic]));

  assert.equal(bus.publish("orders.created", payload), 3);
  assert.deepEqual(received, [
    ["wildcard", payload, "orders.created"],
    ["exact", payload, "orders.created"],
    ["second wildcard", payload, "orders.created"],
  ]);
});

test("separate subscriptions and unsubscription have independent idempotent results", () => {
  const bus = new EventBus();
  let calls = 0;
  const listener = () => {
    calls += 1;
  };
  const removeFirst = bus.subscribe("ready", listener);
  const removeSecond = bus.subscribe("ready", listener);

  assert.equal(removeFirst(), true);
  assert.equal(removeFirst(), false);
  assert.equal(bus.publish("ready"), 1);
  assert.equal(calls, 1);
  assert.equal(removeSecond(), true);
  assert.equal(bus.publish("ready"), 0);
});

test("once removes its listener before a recursive publish", () => {
  const bus = new EventBus();
  let calls = 0;
  const removeUncalled = bus.once("later", () => {
    calls += 1;
  });
  const remove = bus.once("tick", () => {
    calls += 1;
    assert.equal(bus.publish("tick"), 0);
  });

  assert.equal(removeUncalled(), true);
  assert.equal(removeUncalled(), false);
  assert.equal(bus.publish("later"), 0);
  assert.equal(bus.publish("tick"), 1);
  assert.equal(calls, 1);
  assert.equal(remove(), false);
  assert.equal(bus.publish("tick"), 0);
});

test("subscriptions changed during publish affect only later publishes", () => {
  const bus = new EventBus();
  const received = [];
  let removeThird;

  bus.subscribe("sync", () => {
    received.push("first");
    removeThird();
    bus.subscribe("sync", () => received.push("later"));
  });
  bus.subscribe("sync", () => received.push("second"));
  removeThird = bus.subscribe("sync", () => received.push("third"));

  assert.equal(bus.publish("sync"), 3);
  assert.deepEqual(received, ["first", "second", "third"]);
  received.length = 0;
  assert.equal(bus.publish("sync"), 3);
  assert.deepEqual(received, ["first", "second", "later"]);
});

test("validation failures and listener errors stop publishing", () => {
  const bus = new EventBus();
  assert.throws(() => bus.subscribe("ready", null), TypeError);
  assert.throws(() => bus.once("ready", null), TypeError);
  assert.throws(() => bus.subscribe("*.ready", () => {}), TypeError);
  assert.throws(() => bus.publish("ready.*"), TypeError);

  const failure = new Error("listener failure");
  let afterFailure = false;
  bus.subscribe("fail", () => {
    throw failure;
  });
  bus.subscribe("fail", () => {
    afterFailure = true;
  });

  assert.throws(() => bus.publish("fail"), failure);
  assert.equal(afterFailure, false);
});
