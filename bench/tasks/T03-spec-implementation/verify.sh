#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: sh verify.sh <workdir>" >&2
  exit 2
fi

workdir=$1
task_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
hidden_test=$task_dir/event-bus.test.mjs

if [ ! -d "$workdir" ]; then
  echo "workdir is not a directory: $workdir" >&2
  exit 2
fi

if [ ! -f "$hidden_test" ]; then
  echo "hidden test missing: $hidden_test" >&2
  exit 2
fi

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

cp -R "$workdir"/. "$tmp_dir"/
cp "$hidden_test" "$tmp_dir"/

cd "$tmp_dir"
exec node --test
