#!/usr/bin/env bash
printf '%s\n' "$1" >> "$FAKE_VERIFY_LOG"
test "$PWD" != "$1" || exit 7
test ! -e "$1/verify.sh" || exit 8
test -f "$1/marker.txt" || exit 9
test "$FAKE_VERIFY_FAIL" != 1 || exit 10
