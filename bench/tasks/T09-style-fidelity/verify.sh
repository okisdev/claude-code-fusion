#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: bash verify.sh <workdir>" >&2
  exit 2
fi

WORKDIR="$1"
TASK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="${TASK_DIR}/check-style.mjs"
HIDDEN_TEST="${TASK_DIR}/behavior.test.mjs"

if [[ ! -d "$WORKDIR" ]]; then
  echo "workdir is not a directory: $WORKDIR" >&2
  exit 2
fi

if [[ ! -f "$CHECKER" ]]; then
  echo "checker script missing: $CHECKER" >&2
  exit 2
fi

if [[ ! -f "$HIDDEN_TEST" ]]; then
  echo "hidden test missing: $HIDDEN_TEST" >&2
  exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp -R "$WORKDIR"/. "$TMP"/

if ! node "$CHECKER" "$TMP"; then
  exit 1
fi

cp "$HIDDEN_TEST" "$TMP"/

cd "$TMP"
exec node --test
