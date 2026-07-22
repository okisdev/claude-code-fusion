#!/usr/bin/env bash
set -euo pipefail

TASK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY="${TASK_DIR}/verify.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

TMP_MUTANT="$(mktemp -d)"
TMP_SOLUTION="$(mktemp -d)"
trap 'rm -rf "$TMP_MUTANT" "$TMP_SOLUTION"' EXIT

cp -R "${TASK_DIR}/mutant"/. "$TMP_MUTANT"/
if bash "$VERIFY" "$TMP_MUTANT"; then
  fail "mutant leg: verify.sh should reject the known bad solution"
fi

cp -R "${TASK_DIR}/solution"/. "$TMP_SOLUTION"/
if ! bash "$VERIFY" "$TMP_SOLUTION"; then
  fail "solution leg: verify.sh should accept the reference fix"
fi

echo "PASS"
