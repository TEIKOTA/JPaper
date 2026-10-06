#!/usr/bin/env bash
# 各 AGENTS.md を Claude Code でも同じ scope で読むため、同じ directory の
# CLAUDE.md -> AGENTS.md symlink を検査する。
set -u

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  printf 'Usage: scripts/check-agent-instruction-links.sh [<root>]\nAGENTS.md と sibling CLAUDE.md symlink を検査する。\n'
  exit 0
fi

root="${1:-$(cd "$(dirname "$0")/.." && pwd)}"

if [ ! -d "$root" ]; then
  echo "ERROR: 検査 root が directory ではありません: $root" >&2
  exit 1
fi

fail=0
count=0
while IFS= read -r agents_file; do
  count=$((count + 1))
  directory="$(dirname "$agents_file")"
  claude_file="$directory/CLAUDE.md"

  if [ ! -L "$claude_file" ]; then
    echo "ERROR: $agents_file の sibling CLAUDE.md symlink がありません" >&2
    fail=1
    continue
  fi

  target="$(readlink "$claude_file")"
  if [ "$target" != "AGENTS.md" ]; then
    echo "ERROR: $claude_file は sibling AGENTS.md を指していません (target=$target)" >&2
    fail=1
  fi
done < <(find "$root" -type d -name .git -prune -o -type f -name AGENTS.md -print)

if [ "$count" -eq 0 ]; then
  echo "ERROR: AGENTS.md が見つかりません: $root" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "OK: AGENTS.md / CLAUDE.md sibling symlink $count 件"
