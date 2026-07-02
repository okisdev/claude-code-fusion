#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")" && pwd)"
claude_dir="${CLAUDE_DIR:-$HOME/.claude}"

files=(
  "agents/deep-reasoner.md"
  "agents/fast-worker.md"
  "agents/trivial-worker.md"
  "rules/orchestration.md"
)

mode="${1:-}"

case "$mode" in
  install)
    for f in "${files[@]}"; do
      mkdir -p "$claude_dir/$(dirname "$f")"
      if [ -f "$claude_dir/$f" ] && ! cmp -s "$repo_dir/$f" "$claude_dir/$f"; then
        backup="$claude_dir/$f.bak.$(date +%Y%m%d%H%M%S)"
        cp "$claude_dir/$f" "$backup"
        echo "Backed up: $f -> $backup"
      fi
      cp "$repo_dir/$f" "$claude_dir/$f"
      echo "Installed: $f"
    done
    echo "Done. Merge settings/permissions.snippet.json into $claude_dir/settings.json if not already present."
    ;;
  diff)
    status=0
    for f in "${files[@]}"; do
      if [ ! -f "$claude_dir/$f" ]; then
        echo "Missing: $claude_dir/$f"
        status=1
      elif ! cmp -s "$repo_dir/$f" "$claude_dir/$f"; then
        echo "Drift: $f"
        diff -u "$repo_dir/$f" "$claude_dir/$f" || true
        status=1
      fi
    done
    exit "$status"
    ;;
  *)
    echo "Usage: install.sh install|diff" >&2
    exit 2
    ;;
esac
