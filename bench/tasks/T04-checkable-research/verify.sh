#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: bash verify.sh <workdir>" >&2
  exit 2
fi

WORKDIR="$1"
TASK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="${TASK_DIR}/check-answer.mjs"

if [[ ! -d "$WORKDIR" ]]; then
  echo "workdir is not a directory: $WORKDIR" >&2
  exit 2
fi

if [[ ! -f "$CHECKER" ]]; then
  echo "checker script missing: $CHECKER" >&2
  exit 2
fi

exec node "$CHECKER" "${WORKDIR}/answer.json"
