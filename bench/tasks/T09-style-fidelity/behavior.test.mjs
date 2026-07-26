import assert from "node:assert/strict";
import test from "node:test";

import { map_concurrent } from "./concurrent.js";
import { app_error } from "./errors.js";
import { retry_with_backoff } from "./retry.js";
import { delay_ms } from "./util.js";

test("retry_with_backoff resolves after two failures", () => {
  let calls = 0;
  return retry_with_backoff(() => {
    calls += 1;
    if (calls < 3) {
      return Promise.reject(app_error("TEMPORARY", "try again"));
    }
    return Promise.resolve("done");
  }, 3, 1).then((result) => {
    assert.equal(result, "done");
    assert.equal(calls, 3);
  });
});

test("retry_with_backoff reports exhaustion after the requested attempts", () => {
  let calls = 0;
  return assert.rejects(retry_with_backoff(() => {
    calls += 1;
    return Promise.reject(app_error("TEMPORARY", "last failure"));
  }, 3, 1), (error) => {
    assert.equal(error.code, "E_RETRY_EXHAUSTED");
    assert.equal(error.message, "last failure");
    return true;
  }).then(() => {
    assert.equal(calls, 3);
  });
});

test("map_concurrent preserves order and honors the worker limit", () => {
  let active = 0;
  let high_water = 0;
  return map_concurrent([1, 2, 3, 4], 2, (value) => {
    active += 1;
    high_water = Math.max(high_water, active);
    return delay_ms(1).then(() => {
      active -= 1;
      return value * 2;
    });
  }).then((results) => {
    assert.deepEqual(results, [2, 4, 6, 8]);
    assert.equal(high_water, 2);
    assert.ok(high_water <= 2);
  });
});

test("map_concurrent resolves an empty input", () => map_concurrent([], 2, () => Promise.resolve("unused")).then((results) => {
  assert.deepEqual(results, []);
}));

test("map_concurrent propagates the worker error", () => assert.rejects(map_concurrent([1, 2], 2, (value) => {
  if (value === 2) {
    return Promise.reject(app_error("WORKER_FAILED", "worker failed"));
  }
  return delay_ms(1).then(() => value);
}), (error) => {
  assert.equal(error.code, "E_WORKER_FAILED");
  return true;
}));
