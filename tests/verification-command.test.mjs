import assert from "node:assert/strict";
import { test } from "node:test";
import { verificationEvidence } from "../plugins/fusion/scripts/lib/verification-command.mjs";

function summaryEvidence(command, output, toolResponse = {}) {
  return verificationEvidence(command, { is_error: false, output, ...toolResponse });
}

test("credits a piped vitest summary", () => {
  assert.equal(
    summaryEvidence("npx vitest run 2>&1 | tail -20", "Test Files  3 passed (3)\nTests  42 passed (42)"),
    "output-summary"
  );
});

test("rejects a piped vitest summary with failures", () => {
  assert.equal(summaryEvidence("npx vitest run 2>&1 | tail -20", "Test Files  1 failed | 2 passed"), null);
});

test("keeps node:test fail-zero summaries", () => {
  assert.equal(summaryEvidence("npm test | grep -E 'fail|pass'", "ℹ fail 0"), "output-summary");
});

test("credits and rejects piped pytest summaries", () => {
  assert.equal(summaryEvidence("pytest -q 2>&1 | tail -5", "3 passed in 0.12s"), "output-summary");
  assert.equal(summaryEvidence("pytest -q 2>&1 | tail -5", "1 failed, 2 passed in 0.2s"), null);
});

test("does not credit piped go test output fragments", () => {
  assert.equal(summaryEvidence("go test ./... | tail -3", "ok  example.com/pkg 0.5s"), null);
  assert.equal(summaryEvidence("go test ./... | tail -3", "FAIL example.com/pkg [build failed]"), null);
  assert.equal(
    summaryEvidence(
      "go test ./... | tail -3",
      "ok  example.com/first 0.2s\nok  example.com/second 0.3s\nok  example.com/third 0.4s"
    ),
    null
  );
});

test("credits a self-contained piped cargo test summary", () => {
  assert.equal(summaryEvidence("cargo test | tail -4", "test result: ok. 10 passed; 0 failed; 0 ignored"), "output-summary");
  assert.equal(summaryEvidence("cargo test | tail -4", "test result: ok. 10 passed; 0 ignored"), null);
});

test("does not credit a bare piped Playwright pass count", () => {
  assert.equal(summaryEvidence("npx playwright test 2>&1 | tail -20", "5 passed"), null);
});

test("credits and rejects piped jest summaries", () => {
  assert.equal(summaryEvidence("npx jest --ci 2>&1 | tail", "Tests:       12 passed, 12 total"), "output-summary");
  assert.equal(summaryEvidence("npx jest --ci 2>&1 | tail", "Tests:       1 failed, 11 passed, 12 total"), null);
});

test("does not credit summaries for unrecognized commands", () => {
  assert.equal(summaryEvidence("./run-my-checks.sh", "3 passed"), null);
});

test("does not credit failed or interrupted tool responses", () => {
  for (const toolResponse of [{ is_error: true }, { isError: true }, { interrupted: true }]) {
    assert.equal(verificationEvidence("npx vitest run 2>&1 | tail -20", { output: "Test Files  3 passed", ...toolResponse }), null);
  }
});

test("keeps final-segment exit-status evidence and rejects mutating commands", () => {
  assert.equal(verificationEvidence("npm test", { is_error: false, output: "1 failed" }), "exit-status");
  assert.equal(summaryEvidence("npm install | tail -20", "3 passed"), null);
});
