#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: bash verify.sh <workdir>" >&2
  exit 2
fi

WORKDIR="$1"
TASK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -d "$WORKDIR" ]]; then
  echo "workdir is not a directory: $WORKDIR" >&2
  exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp -R "$WORKDIR"/. "$TMP"/
cp "${TASK_DIR}/query-string.test.mjs" "${TASK_DIR}/semver-range.test.mjs" "${TASK_DIR}/text-table.test.mjs" "$TMP"/

cd "$TMP"
exec node --test query-string.test.mjs semver-range.test.mjs text-table.test.mjs
