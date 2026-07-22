#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  exit 2
fi

WORKDIR="$1"
TASK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HIDDEN_DIR="${TASK_DIR}/hidden"

if [[ ! -d "$WORKDIR" || ! -d "$HIDDEN_DIR" ]]; then
  exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp -R "$WORKDIR"/. "$TMP"/
mkdir -p "$TMP/tests"
cp -R "$HIDDEN_DIR"/. "$TMP/tests"/

cd "$TMP"
exec node --test tests/csv-parser.test.mjs tests/duration-formatter.test.mjs tests/path-matcher.test.mjs
