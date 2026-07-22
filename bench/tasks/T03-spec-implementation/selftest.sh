#!/bin/sh
set -eu

task_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
verify=$task_dir/verify.sh

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

tmp_mutant=$(mktemp -d)
tmp_solution=$(mktemp -d)
trap 'rm -rf "$tmp_mutant" "$tmp_solution"' EXIT HUP INT TERM

cp -R "$task_dir"/mutant/. "$tmp_mutant"/
if sh "$verify" "$tmp_mutant"; then
  fail "mutant leg: verify.sh should reject the known bad solution"
fi

cp -R "$task_dir"/solution/. "$tmp_solution"/
if ! sh "$verify" "$tmp_solution"; then
  fail "solution leg: verify.sh should accept the reference implementation"
fi

echo "PASS"
