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
cp "${TASK_DIR}/queue-settings.test.mjs" "${TASK_DIR}/mailer-settings.test.mjs" "${TASK_DIR}/notifier-settings.test.mjs" "$TMP"/

cd "$TMP"
exec node --test queue-settings.test.mjs mailer-settings.test.mjs notifier-settings.test.mjs
