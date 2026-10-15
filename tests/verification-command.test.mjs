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

for (const command of [
  "npm test", "npm run build", "npm run lint", "npm run typecheck", "npm run check",
  "pnpm test", "pnpm build", "pnpm lint", "pnpm typecheck", "pnpm check",
  "yarn test", "yarn build", "yarn lint", "yarn typecheck", "yarn check",
  "bun test", "bun run build", "bun run lint", "bun run typecheck", "bun run check",
  "tsc --noEmit", "npx tsc --noEmit", "git diff --check",
  "pytest", "python -m pytest", "uv run pytest",
  "cargo test", "cargo check", "cargo clippy",
  "go test ./...", "go vet ./...", "swift test", "swift build", "make test", "make check"
]) {
  test(`recognizes ${command} as verification`, () => {
    assert.equal(verificationEvidence(command, { exitCode: 0 }), "exit-status");
  });
}

test("numeric failure codes reject observable and summary verification evidence", () => {
  for (const key of ["exitCode", "exit_code", "code", "returnCode"]) {
    for (const value of [1, -1]) {
      assert.equal(verificationEvidence("npm test", { [key]: value }), null, `${key}=${value}`);
      assert.equal(summaryEvidence("npm test | tail -5", "ℹ fail 0", { [key]: value }), null, `${key}=${value}`);
    }
    assert.equal(verificationEvidence("npm test", { [key]: 0 }), "exit-status", `${key}=0`);
  }
});
